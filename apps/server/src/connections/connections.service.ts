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
} from '@liame/contracts';
import { uuidv7 } from '@liame/database';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { type AuthContext, afterCommit, auditDetail, currentTx } from '../context/request-context.js';
import { AppProblem } from '../errors/problems.js';
import { VaultService } from '../vault/vault.service.js';
import { type CredencialGuardada, enderecoDeVolta, hashEstado, novoEstado, novoVerificador, type ProvedorOAuth, revogarGoogle, urlDeAutorizacao } from './oauth.js';

// Conectar contas (A2, G3), lado da API: tudo na transação curta da requisição. A troca do código e a
// descoberta das contas (chamadas externas) ficam com o worker (ConexaoProcessor), nunca aqui.

/** A volta da plataforma precisa chegar em até 10 minutos. */
const VALIDADE_MIN = 10;

type LinhaConexao = {
  id: string;
  brand_id: string;
  provider: string;
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
};

/** Conta descoberta, como o worker guarda em `oauth_connection.discovered`. */
export type DescobertaGuardada = {
  provider: 'meta_ads' | 'google_ads' | 'ga4';
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
  connected_at: Date | string;
  disconnected_at: Date | string | null;
};

const iso = (v: Date | string) => new Date(v).toISOString();
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
    connected_at: iso(l.connected_at),
    disconnected_at: isoOuNulo(l.disconnected_at),
  };
}

@Injectable()
export class ConnectionsService {
  private readonly logger = new Logger('conexoes');

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly vault: VaultService,
  ) {}

  /** Cria o estado do OAuth e devolve para onde mandar a pessoa autorizar. */
  async iniciar(auth: AuthContext, body: StartConnectionRequest): Promise<StartConnectionResponse> {
    const tenantId = auth.tenantId!;
    const provedor: ProvedorOAuth = body.provider;
    if (!this.config.oauth[provedor]) {
      throw new AppProblem(
        503,
        'integracao-indisponivel',
        'Conexão ainda indisponível',
        provedor === 'meta' ? 'A conexão com a Meta ainda não está disponível. Tente de novo mais tarde.' : 'A conexão com o Google ainda não está disponível. Tente de novo mais tarde.',
      );
    }
    const tx = currentTx();
    const marca = await tx.execute<{ id: string }>(sql`select id from liame.brand where id = ${body.brand_id} and archived_at is null`);
    if (!marca.rows[0]) throw new AppProblem(404, 'nao-encontrado', 'Não encontramos', 'Marca não encontrada nesta empresa.');

    const id = uuidv7();
    const estado = novoEstado();
    const verificador = provedor === 'google' ? novoVerificador() : null;
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
      select c.id, c.brand_id, c.provider, c.status, c.requested_by, u.name as requested_by_name, c.error_code, c.created_at, c.completed_at,
             c.refresh_expires_at, c.expires_at, c.discovered, c.credential_secret_id
        from liame.oauth_connection c left join liame.app_user u on u.id = c.requested_by
       where c.status not in ('aguardando_autorizacao', 'expirada') ${brandId ? sql`and c.brand_id = ${brandId}` : sql``}
       order by c.created_at desc limit 200`);
    return { items: await this.montar(conexoes.rows) };
  }

  async detalhe(id: string): Promise<ConnectionResponse> {
    const r = await currentTx().execute<LinhaConexao>(sql`
      select c.id, c.brand_id, c.provider, c.status, c.requested_by, u.name as requested_by_name, c.error_code, c.created_at, c.completed_at,
             c.refresh_expires_at, c.expires_at, c.discovered, c.credential_secret_id
        from liame.oauth_connection c left join liame.app_user u on u.id = c.requested_by
       where c.id = ${id}`);
    if (!r.rows[0]) throw naoEncontrada();
    return (await this.montar(r.rows))[0]!;
  }

  /** Conexões com as contas ligadas e a marcação "já ligada" nas descobertas (uma consulta para todas). */
  private async montar(linhas: LinhaConexao[]): Promise<ConnectionResponse[]> {
    if (!linhas.length) return [];
    const contas = await currentTx().execute<LinhaConta>(sql`
      select id, brand_id, connection_id, provider, external_id, name, currency, timezone, status, status_reason, connected_at, disconnected_at
        from liame.connected_account
       where connection_id in ${linhas.map((l) => l.id)} or disconnected_at is null
       order by connected_at`);
    const ligadas = new Set(contas.rows.filter((c) => !c.disconnected_at).map((c) => `${c.provider}:${c.external_id}`));
    return linhas.map((l) => ({
      id: l.id,
      brand_id: l.brand_id,
      provider: l.provider,
      status: l.status,
      error_code: l.error_code,
      authorized_by: l.requested_by_name ?? null,
      created_at: iso(l.created_at),
      completed_at: isoOuNulo(l.completed_at),
      refresh_expires_at: isoOuNulo(l.refresh_expires_at),
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
      select id, tenant_id, brand_id, provider, status, discovered, credential_secret_id, requested_by, error_code, created_at, completed_at, refresh_expires_at, expires_at
        from liame.oauth_connection where id = ${id} for update`);
    const c = r.rows[0];
    if (!c) throw naoEncontrada();
    if (!['aguardando_escolha', 'ativa'].includes(c.status) || !c.credential_secret_id) {
      throw new AppProblem(409, 'conexao-sem-contas', 'Conexão ainda não está pronta', 'Esta conexão ainda não tem contas para escolher (ou foi revogada).');
    }
    const descobertas = new Map((c.discovered ?? []).map((d) => [`${d.provider}:${d.external_id}`, d]));
    const escolhidas: DescobertaGuardada[] = [];
    const faltando: string[] = [];
    for (const a of body.accounts) {
      const d = descobertas.get(`${a.provider}:${a.external_id}`);
      if (d) escolhidas.push(d);
      else faltando.push(`${a.provider}:${a.external_id}`);
    }
    if (faltando.length) {
      throw new AppProblem(422, 'conta-nao-descoberta', 'Conta fora desta autorização', 'Só dá para ligar contas que esta autorização alcança.', {}, faltando.map((f) => ({ path: 'accounts', message: f })));
    }
    const linhas = escolhidas.map((d) => ({
      id: uuidv7(),
      provider: d.provider,
      external_id: d.external_id,
      name: d.name.slice(0, 300),
      currency: d.currency,
      timezone: d.timezone,
      provider_attributes: d.provider_attributes ?? {},
    }));
    const inseridas = await tx.execute<LinhaConta>(sql`
      insert into liame.connected_account (id, tenant_id, brand_id, provider, external_id, name, currency, timezone, credential_secret_id,
                                           connection_id, provider_attributes, connected_by)
      select x.id, ${c.tenant_id}, ${c.brand_id}, x.provider, x.external_id, x.name, x.currency, x.timezone, ${c.credential_secret_id},
             ${c.id}, coalesce(x.provider_attributes, '{}'::jsonb), ${auth.userId}
        from jsonb_to_recordset(${JSON.stringify(linhas)}::jsonb)
             as x (id uuid, provider text, external_id text, name text, currency text, timezone text, provider_attributes jsonb)
      -- Mesma marca, outra autorização (reconectar depois de token recusado): a nova credencial assume a conta.
      -- Outra marca ou a mesma autorização: fica como está (volta em already_linked).
      on conflict (tenant_id, provider, external_id) where disconnected_at is null
      do update set credential_secret_id = excluded.credential_secret_id, connection_id = excluded.connection_id,
                    provider_attributes = excluded.provider_attributes, status = 'ativa', status_reason = null, updated_at = now()
       where liame.connected_account.brand_id = excluded.brand_id
         and liame.connected_account.connection_id is distinct from excluded.connection_id
      returning id, brand_id, connection_id, provider, external_id, name, currency, timezone, status, status_reason, connected_at, disconnected_at`);
    const novas = new Set(inseridas.rows.map((l) => `${l.provider}:${l.external_id}`));
    if (inseridas.rows.length) {
      await tx.execute(sql`update liame.oauth_connection set status = 'ativa', completed_at = coalesce(completed_at, now()), updated_at = now() where id = ${c.id}`);
    }
    auditDetail({ resourceId: c.id, after: { contas: inseridas.rows.map((l) => `${l.provider}:${l.external_id}`) } });
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
  async desligarConta(id: string): Promise<void> {
    const r = await currentTx().execute<{ provider: string; external_id: string }>(sql`
      update liame.connected_account set status = 'desconectada', status_reason = 'desligada por pessoa', disconnected_at = now(), updated_at = now()
       where id = ${id} and disconnected_at is null
       returning provider, external_id`);
    if (!r.rows[0]) throw new AppProblem(404, 'nao-encontrado', 'Não encontramos', 'Conta conectada não encontrada nesta empresa.');
    auditDetail({ resourceId: id, before: { status: 'ativa' }, after: { status: 'desconectada', provider: r.rows[0].provider, external_id: r.rows[0].external_id } });
  }

  /**
   * Revoga a autorização: o token sai do cofre, as contas dela param e, no Google, o token é revogado lá
   * também (depois do commit). Na Meta, a empresa remove o app nas Configurações do negócio.
   */
  async revogar(id: string): Promise<void> {
    const tx = currentTx();
    const r = await tx.execute<{ provider: string; credential_secret_id: string | null; status: string }>(sql`
      select provider, credential_secret_id, status from liame.oauth_connection where id = ${id} for update`);
    const c = r.rows[0];
    if (!c) throw naoEncontrada();
    if (c.status === 'revogada') return;
    let refreshGoogle: string | null = null;
    if (c.credential_secret_id) {
      const guardada = await this.vault.readSecret(tx, c.credential_secret_id);
      if (guardada && c.provider === 'google') refreshGoogle = (JSON.parse(guardada) as CredencialGuardada & { tipo: 'google' }).refresh_token;
      await this.vault.revokeSecret(tx, c.credential_secret_id);
    }
    const contas = await tx.execute<{ id: string }>(sql`
      update liame.connected_account set status = 'desconectada', status_reason = 'autorização revogada', disconnected_at = now(), updated_at = now()
       where connection_id = ${id} and disconnected_at is null returning id`);
    await tx.execute(sql`
      update liame.oauth_connection set status = 'revogada', revoked_at = now(), code_enc = null, pkce_verifier_enc = null, updated_at = now() where id = ${id}`);
    auditDetail({ resourceId: id, before: { status: c.status }, after: { status: 'revogada', contas_desligadas: contas.rows.length } });
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
  }

  private async versaoMeta(): Promise<string> {
    const r = await currentTx().execute<{ api_version: string }>(sql`
      select api_version from liame.connector_capability where provider = 'meta_ads' and capability = 'accounts'`);
    const v = r.rows[0]?.api_version;
    if (!v) throw new Error('capacidade meta_ads/accounts fora do registro');
    return v;
  }
}
