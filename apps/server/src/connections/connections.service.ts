import type {
  ConnectedAccountResponse,
  ConnectionListResponse,
  ConnectionResponse,
  DiscoveredAccount,
  LinkAccountsRequest,
  LinkAccountsResponse,
  OAuthCallbackQuery,
  StartConnectionRequest,
  StartConnectionResponse,
  UnitListResponse,
} from '@liame/contracts';
import { type Database, uuidv7 } from '@liame/database';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { type SQL, sql } from 'drizzle-orm';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { type AuthContext, afterCommit, auditDetail, currentTx } from '../context/request-context.js';
import { AppProblem } from '../errors/problems.js';
import { VaultService } from '../vault/vault.service.js';
import { ClienteConector } from '../connectors/cliente-http.js';
import { enderecosDasPlataformas } from '../connectors/enderecos.js';
import { revogarNoRegem } from '../connectors/regem/conector-regem.js';
import { DATABASE } from '../database/database.module.js';
import { type CredencialGuardada, type CredencialRegem, enderecoDeVolta, hashEstado, novoEstado, novoVerificador, type ProvedorOAuth, revogarGoogle, urlDeAutorizacao } from './oauth.js';

// Conectar contas (A2, G3), lado da API: tudo na transação curta da requisição. A troca do código e a
// descoberta das contas (chamadas externas) ficam com o worker (ConexaoProcessor), nunca aqui.

/** A volta da plataforma precisa chegar em até 10 minutos. */
const VALIDADE_MIN = 10;

type LinhaConexao = {
  id: string;
  brand_id: string;
  provider: string;
  origin: string;
  status: string;
  requested_by: string | null;
  requested_by_name?: string | null;
  error_code: string | null;
  created_at: Date | string;
  completed_at: Date | string | null;
  refresh_expires_at: Date | string | null;
  expires_at: Date | string;
  discovered: DescobertaGuardada[];
  credential_secret_id: string | null;
  scopes?: string[] | null;
};

/** Conta descoberta, como o worker guarda em `oauth_connection.discovered`. */
export type DescobertaGuardada = {
  provider: 'meta_ads' | 'google_ads' | 'ga4' | 'regem' | 'regemcast';
  external_id: string;
  name: string;
  currency: string | null;
  timezone: string | null;
  provider_attributes: Record<string, unknown>;
};

type LinhaConta = {
  id: string;
  brand_id: string;
  connection_id: string | null;
  provider: string;
  external_id: string;
  name: string;
  currency: string | null;
  timezone: string | null;
  status: string;
  status_reason: string | null;
  unit_id: string | null;
  unit_name?: string | null;
  escopos?: string[] | null;
  connected_at: Date | string;
  disconnected_at: Date | string | null;
};

const iso = (v: Date | string) => new Date(v).toISOString();

/** A loja do Liame da conta e o que a loja do Regem libera (os escopos do token dela), para a tela de Contas (P2). */
const lojaEEscopos = (tabela: SQL) => sql`
  (select u.name from liame.unit u where u.id = ${tabela}.unit_id) as unit_name,
  array(select jsonb_array_elements_text(case when jsonb_typeof(${tabela}.provider_attributes -> 'escopos') = 'array'
                                              then ${tabela}.provider_attributes -> 'escopos' else '[]'::jsonb end)) as escopos`;
const isoOuNulo = (v: Date | string | null) => (v ? iso(v) : null);

const naoEncontrada = () => new AppProblem(404, 'nao-encontrado', 'Não encontramos', 'Conexão não encontrada nesta empresa.');

function conta(l: LinhaConta): ConnectedAccountResponse {
  return {
    id: l.id,
    brand_id: l.brand_id,
    connection_id: l.connection_id,
    provider: l.provider,
    external_id: l.external_id,
    name: l.name,
    currency: l.currency,
    timezone: l.timezone,
    status: l.status,
    status_reason: l.status_reason,
    unit_id: l.unit_id,
    unit_name: l.unit_name ?? null,
    scopes: l.escopos ?? [],
    connected_at: iso(l.connected_at),
    disconnected_at: isoOuNulo(l.disconnected_at),
  };
}

@Injectable()
export class ConnectionsService {
  private readonly logger = new Logger('conexoes');

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(DATABASE) private readonly database: Database | null,
    private readonly vault: VaultService,
  ) {}

  /**
   * Autorizações que dá para começar agora. RegemCast ainda sem autorização própria (C2b); o Regem, só
   * quando o cliente dele está configurado (`REGEM_CLIENT_ID` e `REGEM_CLIENT_SECRET`, da distribuição).
   */
  private disponiveis(): ProvedorOAuth[] {
    return (['meta', 'google', 'regem'] as const).filter((p) => Boolean(this.config.oauth[p]));
  }

  /** Lojas do Liame da marca, por nome: a escolha de "Loja no Liame" ao ligar as lojas do Regem. */
  async lojasDaMarca(brandId: string): Promise<UnitListResponse> {
    const r = await currentTx().execute<{ id: string; brand_id: string; name: string }>(sql`
      select id, brand_id, name from liame.unit where brand_id = ${brandId} order by lower(name), id limit 500`);
    return { items: r.rows.map((u) => ({ id: u.id, brand_id: u.brand_id, name: u.name })) };
  }

  /** Cria o estado do OAuth e devolve para onde mandar a pessoa autorizar. */
  async iniciar(auth: AuthContext, body: StartConnectionRequest): Promise<StartConnectionResponse> {
    const tenantId = auth.tenantId!;
    const provedor: ProvedorOAuth = body.provider;
    if (!this.disponiveis().includes(provedor)) {
      const nome = { meta: 'a Meta', google: 'o Google', regem: 'o Regem', regemcast: 'o RegemCast' }[provedor];
      throw new AppProblem(503, 'integracao-indisponivel', 'Conexão ainda indisponível', `A conexão com ${nome} ainda não está disponível. Tente de novo mais tarde.`);
    }
    const tx = currentTx();
    const marca = await tx.execute<{ id: string }>(sql`select id from liame.brand where id = ${body.brand_id} and archived_at is null`);
    if (!marca.rows[0]) throw new AppProblem(404, 'nao-encontrado', 'Não encontramos', 'Marca não encontrada nesta empresa.');

    const id = uuidv7();
    const estado = novoEstado();
    const verificador = provedor === 'google' || provedor === 'regem' ? novoVerificador() : null;
    const versaoMeta = await this.versaoMeta();
    const redirectUri = enderecoDeVolta(this.config);
    const verificadorCifrado = verificador ? await this.vault.encryptForTenant(tx, tenantId, `oauth_pkce:${id}`, verificador) : null;
    const r = await tx.execute<{ expires_at: Date | string }>(sql`
      insert into liame.oauth_connection (id, tenant_id, brand_id, provider, requested_by, state_hash, redirect_uri, pkce_verifier_enc, expires_at)
      values (${id}, ${tenantId}, ${body.brand_id}, ${provedor}, ${auth.userId}, ${hashEstado(estado)}, ${redirectUri}, ${verificadorCifrado},
              now() + make_interval(mins => ${VALIDADE_MIN}))
      returning expires_at`);
    auditDetail({ resourceId: id, after: { provider: provedor, brand_id: body.brand_id } });
    return {
      id,
      authorize_url: urlDeAutorizacao(provedor, this.config, { estado, redirectUri, verificador: verificador ?? undefined, versaoMeta }),
      expires_at: iso(r.rows[0]!.expires_at),
    };
  }

  /**
   * Volta da plataforma (navegação do próprio navegador, com a sessão). Só guarda o código cifrado e
   * devolve para onde levar a pessoa; o worker troca o código. Estado de outra pessoa, vencido, já usado
   * ou desconhecido não revela nada: volta para a tela com o motivo genérico.
   */
  async receber(auth: AuthContext, q: OAuthCallbackQuery): Promise<string> {
    const tx = currentTx();
    const tela = (params: Record<string, string>) => `${this.config.appUrl}/contas?${new URLSearchParams(params).toString()}`;
    const r = await tx.execute<{ id: string; tenant_id: string; requested_by: string | null; status: string; vencido: boolean }>(sql`
      select id, tenant_id, requested_by, status, expires_at < now() as vencido
        from liame.oauth_connection where state_hash = ${hashEstado(q.state)}
       for update`);
    const linha = r.rows[0];
    if (!linha || linha.requested_by !== auth.userId || linha.status !== 'aguardando_autorizacao') {
      auditDetail({ reason: 'estado desconhecido, de outra pessoa ou já usado' });
      return tela({ erro: 'autorizacao_invalida' });
    }
    auditDetail({ resourceId: linha.id });
    if (linha.vencido) {
      await tx.execute(sql`update liame.oauth_connection set status = 'expirada', pkce_verifier_enc = null, updated_at = now() where id = ${linha.id}`);
      auditDetail({ reason: 'autorização voltou depois do prazo' });
      return tela({ conexao: linha.id, erro: 'autorizacao_expirada' });
    }
    if (q.error || !q.code) {
      await tx.execute(sql`
        update liame.oauth_connection set status = 'erro', error_code = 'recusada_na_plataforma', pkce_verifier_enc = null, updated_at = now()
         where id = ${linha.id}`);
      auditDetail({ reason: 'a pessoa recusou ou a plataforma devolveu erro' });
      return tela({ conexao: linha.id, erro: 'recusada_na_plataforma' });
    }
    const codigo = await this.vault.encryptForTenant(tx, linha.tenant_id, `oauth_code:${linha.id}`, q.code);
    await tx.execute(sql`update liame.oauth_connection set status = 'recebida', code_enc = ${codigo}, updated_at = now() where id = ${linha.id}`);
    auditDetail({ after: { status: 'recebida' } });
    return tela({ conexao: linha.id });
  }

  async listar(brandId?: string): Promise<ConnectionListResponse> {
    const tx = currentTx();
    const conexoes = await tx.execute<LinhaConexao>(sql`
      select c.id, c.brand_id, c.provider, c.origin, c.status, c.requested_by, u.name as requested_by_name, c.error_code, c.created_at, c.completed_at,
             c.refresh_expires_at, c.expires_at, c.discovered, c.credential_secret_id, c.scopes
        from liame.oauth_connection c left join liame.app_user u on u.id = c.requested_by
       where c.status not in ('aguardando_autorizacao', 'expirada') ${brandId ? sql`and c.brand_id = ${brandId}` : sql``}
       order by c.created_at desc limit 200`);
    return { items: await this.montar(conexoes.rows), available: this.disponiveis() };
  }

  async detalhe(id: string): Promise<ConnectionResponse> {
    const r = await currentTx().execute<LinhaConexao>(sql`
      select c.id, c.brand_id, c.provider, c.origin, c.status, c.requested_by, u.name as requested_by_name, c.error_code, c.created_at, c.completed_at,
             c.refresh_expires_at, c.expires_at, c.discovered, c.credential_secret_id, c.scopes
        from liame.oauth_connection c left join liame.app_user u on u.id = c.requested_by
       where c.id = ${id}`);
    if (!r.rows[0]) throw naoEncontrada();
    return (await this.montar(r.rows))[0]!;
  }

  /** Conexões com as contas ligadas e a marcação "já ligada" nas descobertas (uma consulta para todas). */
  private async montar(linhas: LinhaConexao[]): Promise<ConnectionResponse[]> {
    if (!linhas.length) return [];
    const contas = await currentTx().execute<LinhaConta>(sql`
      select a.id, a.brand_id, a.connection_id, a.provider, a.external_id, a.name, a.currency, a.timezone, a.status, a.status_reason, a.unit_id,
             ${lojaEEscopos(sql`a`)}, a.connected_at, a.disconnected_at
        from liame.connected_account a
       where a.connection_id in ${linhas.map((l) => l.id)} or a.disconnected_at is null
       order by a.connected_at`);
    const ligadas = new Set(contas.rows.filter((c) => !c.disconnected_at).map((c) => `${c.provider}:${c.external_id}`));
    return linhas.map((l) => ({
      id: l.id,
      brand_id: l.brand_id,
      provider: l.provider,
      origin: l.origin,
      status: l.status,
      error_code: l.error_code,
      authorized_by: l.requested_by_name ?? null,
      created_at: iso(l.created_at),
      completed_at: isoOuNulo(l.completed_at),
      refresh_expires_at: isoOuNulo(l.refresh_expires_at),
      scopes: l.scopes ?? [],
      discovered: (l.discovered ?? []).map(
        (d): DiscoveredAccount => ({
          provider: d.provider,
          external_id: d.external_id,
          name: d.name,
          currency: d.currency,
          timezone: d.timezone,
          linked: ligadas.has(`${d.provider}:${d.external_id}`),
          via: typeof d.provider_attributes?.via === 'string' ? d.provider_attributes.via : null,
        }),
      ),
      accounts: contas.rows.filter((c) => c.connection_id === l.id).map(conta),
    }));
  }

  /** Liga à marca da conexão as contas escolhidas entre as descobertas (uma instrução para todas). */
  async ligarContas(auth: AuthContext, id: string, body: LinkAccountsRequest): Promise<LinkAccountsResponse> {
    const tx = currentTx();
    const r = await tx.execute<LinhaConexao & { tenant_id: string }>(sql`
      select id, tenant_id, brand_id, provider, origin, status, discovered, credential_secret_id, requested_by, error_code, created_at, completed_at, refresh_expires_at, expires_at
        from liame.oauth_connection where id = ${id} for update`);
    const c = r.rows[0];
    if (!c) throw naoEncontrada();
    if (!['aguardando_escolha', 'ativa'].includes(c.status) || !c.credential_secret_id) {
      throw new AppProblem(409, 'conexao-sem-contas', 'Conexão ainda não está pronta', 'Esta conexão ainda não tem contas para escolher (ou foi revogada).');
    }
    const descobertas = new Map((c.discovered ?? []).map((d) => [`${d.provider}:${d.external_id}`, d]));
    const escolhidas: DescobertaGuardada[] = [];
    const faltando: string[] = [];
    const lojaDe = new Map<string, string>();
    for (const a of body.accounts) {
      const d = descobertas.get(`${a.provider}:${a.external_id}`);
      if (d) escolhidas.push(d);
      else faltando.push(`${a.provider}:${a.external_id}`);
      if (a.unit_id) lojaDe.set(`${a.provider}:${a.external_id}`, a.unit_id);
    }
    if (faltando.length) {
      throw new AppProblem(422, 'conta-nao-descoberta', 'Conta fora desta autorização', 'Só dá para ligar contas que esta autorização alcança.', {}, faltando.map((f) => ({ path: 'accounts', message: f })));
    }
    // A loja do Liame precisa ser da marca da conexão (a RLS já garante a empresa).
    const lojas = [...new Set(lojaDe.values())];
    if (lojas.length) {
      const ok = await tx.execute<{ id: string }>(sql`select id from liame.unit where brand_id = ${c.brand_id} and id in ${lojas}`);
      const validas = new Set(ok.rows.map((u) => u.id));
      const erradas = lojas.filter((u) => !validas.has(u));
      if (erradas.length) {
        throw new AppProblem(422, 'loja-fora-da-marca', 'Loja fora desta marca', 'Escolha uma loja da marca desta conexão.', {}, erradas.map((u) => ({ path: 'accounts.unit_id', message: u })));
      }
    }
    // A loja do Regem é uma loja do Liame (o link, o cupom e a plataforma de pedidos são por loja): sem loja
    // escolhida, ela fica com a que a conta já tinha, com a loja da marca de mesmo nome ou com uma loja nova,
    // com o nome e o fuso dela. Sem isso, a conta nascia sem loja e não havia onde criar uma (ERR-047).
    const lojasCriadas: { id: string; name: string }[] = [];
    const semLoja = escolhidas.filter((d) => d.provider === 'regem' && !lojaDe.has(`${d.provider}:${d.external_id}`));
    if (semLoja.length) {
      const daConta = await tx.execute<{ external_id: string; unit_id: string }>(sql`
        select external_id, unit_id from liame.connected_account
         where provider = 'regem' and brand_id = ${c.brand_id} and disconnected_at is null and unit_id is not null
           and external_id in ${semLoja.map((d) => d.external_id)}`);
      const jaTem = new Map(daConta.rows.map((l) => [l.external_id, l.unit_id]));
      const daMarca = await tx.execute<{ id: string; chave: string }>(sql`
        select id, lower(btrim(name)) as chave from liame.unit where brand_id = ${c.brand_id} order by created_at, id`);
      const porNome = new Map<string, string>();
      for (const u of daMarca.rows) if (!porNome.has(u.chave)) porNome.set(u.chave, u.id);
      for (const d of semLoja) {
        const chave = `${d.provider}:${d.external_id}`;
        const nome = d.name.trim().slice(0, 200) || 'Loja';
        let unitId = jaTem.get(d.external_id) ?? porNome.get(nome.toLowerCase());
        if (!unitId) {
          unitId = uuidv7();
          lojasCriadas.push({ id: unitId, name: nome });
          porNome.set(nome.toLowerCase(), unitId);
          await tx.execute(sql`
            insert into liame.unit (id, tenant_id, brand_id, name, timezone)
            values (${unitId}, ${c.tenant_id}, ${c.brand_id}, ${nome}, ${d.timezone || 'America/Sao_Paulo'})`);
        }
        lojaDe.set(chave, unitId);
      }
    }
    // Lojas do Regem que hoje estão ligadas por OUTRA autorização: esta troca o token delas (o Regem revoga o
    // antigo quando o novo nasce). A autorização que ficar sem loja nenhuma é encerrada no fim.
    const lojasTrocadas = escolhidas.filter((d) => d.provider === 'regem').map((d) => d.external_id);
    const antigas = lojasTrocadas.length
      ? (
          await tx.execute<{ connection_id: string }>(sql`
            select distinct connection_id from liame.connected_account
             where provider = 'regem' and brand_id = ${c.brand_id} and disconnected_at is null
               and connection_id is not null and connection_id <> ${c.id} and external_id in ${lojasTrocadas}`)
        ).rows.map((l) => l.connection_id)
      : [];
    const linhas = escolhidas.map((d) => ({
      id: uuidv7(),
      unit_id: lojaDe.get(`${d.provider}:${d.external_id}`) ?? null,
      provider: d.provider,
      external_id: d.external_id,
      name: d.name.slice(0, 300),
      currency: d.currency,
      timezone: d.timezone,
      provider_attributes: d.provider_attributes ?? {},
    }));
    const inseridas = await tx.execute<LinhaConta>(sql`
      insert into liame.connected_account (id, tenant_id, brand_id, unit_id, provider, external_id, name, currency, timezone, credential_secret_id,
                                           connection_id, provider_attributes, connected_by)
      select x.id, ${c.tenant_id}, ${c.brand_id}, x.unit_id, x.provider, x.external_id, x.name, x.currency, x.timezone, ${c.credential_secret_id},
             ${c.id}, coalesce(x.provider_attributes, '{}'::jsonb), ${auth.userId}
        from jsonb_to_recordset(${JSON.stringify(linhas)}::jsonb)
             as x (id uuid, unit_id uuid, provider text, external_id text, name text, currency text, timezone text, provider_attributes jsonb)
      -- Mesma marca, outra autorização (reconectar depois de token recusado): a nova credencial assume a conta.
      -- Outra marca ou a mesma autorização: fica como está (volta em already_linked).
      on conflict (tenant_id, provider, external_id) where disconnected_at is null
      do update set credential_secret_id = excluded.credential_secret_id, connection_id = excluded.connection_id,
                    unit_id = coalesce(excluded.unit_id, liame.connected_account.unit_id),
                    provider_attributes = excluded.provider_attributes, status = 'ativa', status_reason = null, updated_at = now()
       where liame.connected_account.brand_id = excluded.brand_id
         and liame.connected_account.connection_id is distinct from excluded.connection_id
      returning id, brand_id, connection_id, provider, external_id, name, currency, timezone, status, status_reason, unit_id,
                ${lojaEEscopos(sql`liame.connected_account`)}, connected_at, disconnected_at`);
    const novas = new Set(inseridas.rows.map((l) => `${l.provider}:${l.external_id}`));
    if (inseridas.rows.length) {
      await tx.execute(sql`update liame.oauth_connection set status = 'ativa', completed_at = coalesce(completed_at, now()), updated_at = now() where id = ${c.id}`);
    }
    // A autorização antiga do Regem que perdeu todas as lojas para esta: o token dela já não vale lá; aqui a
    // credencial sai do cofre e ela deixa de aparecer como se ainda valesse (ficava na tela com "0 lojas").
    const encerradas: string[] = [];
    for (const antiga of antigas) {
      const resta = await tx.execute(sql`select 1 from liame.connected_account where connection_id = ${antiga} and disconnected_at is null limit 1`);
      if (resta.rows.length) continue;
      if (await this.encerrar(antiga)) encerradas.push(antiga);
    }
    auditDetail({
      resourceId: c.id,
      after: {
        contas: inseridas.rows.map((l) => `${l.provider}:${l.external_id}`),
        ...(lojasCriadas.length ? { lojas_criadas: lojasCriadas } : {}),
        ...(encerradas.length ? { autorizacoes_encerradas: encerradas } : {}),
      },
    });
    return {
      linked: inseridas.rows.map(conta),
      already_linked: escolhidas.filter((d) => !novas.has(`${d.provider}:${d.external_id}`)).map((d) => ({ provider: d.provider, external_id: d.external_id })),
    };
  }

  /** Procura de novo as contas que a autorização alcança (conta nova na plataforma, descoberta que falhou). */
  async redescobrir(id: string): Promise<ConnectionResponse> {
    const tx = currentTx();
    const r = await tx.execute<{ status: string; credential_secret_id: string | null }>(sql`
      select status, credential_secret_id from liame.oauth_connection where id = ${id} for update`);
    const c = r.rows[0];
    if (!c) throw naoEncontrada();
    if (!c.credential_secret_id || !['aguardando_escolha', 'ativa', 'erro'].includes(c.status)) {
      throw new AppProblem(409, 'conexao-sem-credencial', 'Conexão sem autorização válida', 'Conecte de novo para procurar as contas.');
    }
    await tx.execute(sql`
      update liame.oauth_connection set status = 'recebida', attempts = 0, error_code = null, updated_at = now() where id = ${id}`);
    auditDetail({ resourceId: id, before: { status: c.status }, after: { status: 'recebida' } });
    return this.detalhe(id);
  }

  /** Tira uma conta da marca: a leitura para; o histórico fica. */
  /**
   * Desliga uma conta: ela para de ser lida para a marca. Na loja do Regem, o token DELA é revogado lá
   * também (depois do commit) — cada loja tem o próprio token, então as outras lojas da autorização seguem.
   */
  async desligarConta(id: string): Promise<void> {
    const tx = currentTx();
    const r = await tx.execute<{ provider: string; external_id: string; credential_secret_id: string | null; connection_id: string | null }>(sql`
      update liame.connected_account set status = 'desconectada', status_reason = 'desligada por pessoa', disconnected_at = now(), updated_at = now()
       where id = ${id} and disconnected_at is null
       returning provider, external_id, credential_secret_id, connection_id`);
    const conta = r.rows[0];
    if (!conta) throw new AppProblem(404, 'nao-encontrado', 'Não encontramos', 'Conta conectada não encontrada nesta empresa.');
    let tokenDaLoja: string | null = null;
    if (conta.provider === 'regem' && conta.credential_secret_id) {
      const guardada = await this.vault.readSecret(tx, conta.credential_secret_id);
      const lojas = guardada ? ((JSON.parse(guardada) as CredencialRegem).lojas ?? []) : [];
      tokenDaLoja = lojas.find((l) => l.loja_id === conta.external_id)?.token ?? null;
    }
    auditDetail({
      resourceId: id,
      before: { status: 'ativa' },
      after: { status: 'desconectada', provider: conta.provider, external_id: conta.external_id, ...(tokenDaLoja ? { revogada_no_regem: true } : {}) },
    });
    if (tokenDaLoja && this.database) {
      const token = tokenDaLoja;
      const cliente = new ClienteConector(this.database.db, { enderecos: enderecosDasPlataformas(this.config.plataformas, this.config.produtos), tentativas: 2 });
      const ctx = { cliente, apiUrl: this.config.produtos.regemApiUrl };
      afterCommit(async () => {
        try {
          await revogarNoRegem(ctx, token, conta.external_id);
        } catch (err) {
          this.logger.warn(`revogação no Regem falhou (conta ${id}, loja ${conta.external_id}): ${err instanceof Error ? err.message : String(err)}`);
        }
      });
    }
  }

  /**
   * Revoga a autorização: o token sai do cofre, as contas dela param e, no Google, o token é revogado lá
   * também (depois do commit). Na Meta, a empresa remove o app nas Configurações do negócio.
   */
  async revogar(id: string): Promise<void> {
    const r = await this.encerrar(id);
    if (r) auditDetail({ resourceId: id, before: { status: r.antes }, after: { status: 'revogada', contas_desligadas: r.contas } });
  }

  /**
   * O miolo da revogação (sem a auditoria, que é de quem chama): a credencial sai do cofre, as contas da
   * autorização param e o token é revogado na origem depois do commit. `null` = já estava revogada.
   */
  private async encerrar(id: string): Promise<{ antes: string; contas: number } | null> {
    const tx = currentTx();
    const r = await tx.execute<{ provider: string; credential_secret_id: string | null; status: string }>(sql`
      select provider, credential_secret_id, status from liame.oauth_connection where id = ${id} for update`);
    const c = r.rows[0];
    if (!c) throw naoEncontrada();
    if (c.status === 'revogada') return null;
    let refreshGoogle: string | null = null;
    let tokensRegem: { loja_id: string; token: string }[] = [];
    if (c.credential_secret_id) {
      const guardada = await this.vault.readSecret(tx, c.credential_secret_id);
      if (guardada && c.provider === 'google') refreshGoogle = (JSON.parse(guardada) as CredencialGuardada & { tipo: 'google' }).refresh_token;
      if (guardada && c.provider === 'regem') tokensRegem = (JSON.parse(guardada) as CredencialRegem).lojas.map((l) => ({ loja_id: l.loja_id, token: l.token }));
      await this.vault.revokeSecret(tx, c.credential_secret_id);
    }
    const contas = await tx.execute<{ id: string }>(sql`
      update liame.connected_account set status = 'desconectada', status_reason = 'autorização revogada', disconnected_at = now(), updated_at = now()
       where connection_id = ${id} and disconnected_at is null returning id`);
    await tx.execute(sql`
      update liame.oauth_connection set status = 'revogada', revoked_at = now(), code_enc = null, pkce_verifier_enc = null, updated_at = now() where id = ${id}`);
    if (tokensRegem.length && this.database) {
      // Revoga cada token da loja no Regem depois do commit (o token já saiu do cofre do Liame).
      const cliente = new ClienteConector(this.database.db, { enderecos: enderecosDasPlataformas(this.config.plataformas, this.config.produtos), tentativas: 2 });
      const ctx = { cliente, apiUrl: this.config.produtos.regemApiUrl };
      afterCommit(async () => {
        for (const t of tokensRegem) {
          try {
            await revogarNoRegem(ctx, t.token, t.loja_id);
          } catch (err) {
            this.logger.warn(`revogação no Regem falhou (conexão ${id}, loja ${t.loja_id}): ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      });
    }
    const tokenUrl = this.config.oauth.google?.tokenUrl;
    if (refreshGoogle && tokenUrl) {
      const token = refreshGoogle;
      afterCommit(async () => {
        try {
          await revogarGoogle(tokenUrl, token);
        } catch (err) {
          // O token já saiu do cofre; a revogação lá é a segunda camada. Registra o motivo e segue (LIC-001).
          this.logger.warn(`revogação no Google falhou (conexão ${id}): ${err instanceof Error ? err.message : String(err)}`);
        }
      });
    }
    return { antes: c.status, contas: contas.rows.length };
  }

  private async versaoMeta(): Promise<string> {
    const r = await currentTx().execute<{ api_version: string }>(sql`
      select api_version from liame.connector_capability where provider = 'meta_ads' and capability = 'accounts'`);
    const v = r.rows[0]?.api_version;
    if (!v) throw new Error('capacidade meta_ads/accounts fora do registro');
    return v;
  }
}
