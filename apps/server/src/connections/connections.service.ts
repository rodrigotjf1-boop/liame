import type {
  ConnectedAccountResponse,
  ConnectionListResponse,
  ConnectionResponse,
  DiscoveredAccount,
  LinkAccountsRequest,
  LinkAccountsResponse,
  OAuthCallbackQuery,
  ProfileSearch,
  SiteSearch,
  StartConnectionRequest,
  StartConnectionResponse,
  UnitListResponse,
} from '@liame/contracts';
import { type Database, uuidv7 } from '@liame/database';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { type SQL, sql } from 'drizzle-orm';
import { naTransacaoDaEmpresa } from '../ai/na-empresa.js';
import { activeTraceId, writeAudit } from '../audit/audit.js';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { type AuthContext, afterCommit, auditDetail, currentTx } from '../context/request-context.js';
import { actorLabel } from '../context/unit-of-work.interceptor.js';
import { AppProblem } from '../errors/problems.js';
import { FlagService } from '../flags/flag.service.js';
import { VaultService } from '../vault/vault.service.js';
import { ClienteConector, ErroConector } from '../connectors/cliente-http.js';
import { clienteDoDmsId, comTokenDoDmsId, recursoDoRegemcast } from '../connectors/dms/dms-id.js';
import type { ClienteDmsId } from '../connectors/dms/integracao-dms.js';
import { enderecosDasPlataformas } from '../connectors/enderecos.js';
import { FLAG_PERFIL_GOOGLE, PROVEDOR_PERFIL_GOOGLE, procuraGuardada } from '../connectors/google-business/perfil-google.js';
import { FLAG_SEARCH_CONSOLE, PROVEDOR_SEARCH_CONSOLE, procuraDosSitesGuardada } from '../connectors/search-console/search-console.js';
import { revogarNoRegem } from '../connectors/regem/conector-regem.js';
import { type ContaQuePede, PERMISSOES_DO_CLIQUE, pedirAutorizacao, revogarNoRegemcast } from '../connectors/regemcast/conector-regemcast.js';
import { comAcessoDaConta, type CredencialDaConta, credenciaisDaConexao, credencialDaConta } from '../connectors/regemcast/credencial-da-conta.js';
import { FLAG_CONVERSOES_GOOGLE } from '../conversoes/conversoes-google.js';
import { DATABASE } from '../database/database.module.js';
import {
  configuracaoDaMeta,
  type CredencialGuardada,
  type CredencialRegem,
  desafioPkce,
  enderecoDeVolta,
  escoposDoGoogle,
  FLAG_REGEMCAST_POR_CLIQUE,
  hashEstado,
  novoEstado,
  novoVerificador,
  type ProvedorOAuth,
  revogarGoogle,
  urlDeAutorizacao,
} from './oauth.js';

// Conectar contas (A2, G3), lado da API: transações curtas. A troca do código e a descoberta das contas (chamadas
// externas) ficam com o worker (ConexaoProcessor), nunca aqui. A exceção é o pedido empurrado do RegemCast (Hub DMS,
// B1), que precisa existir antes de a pessoa ir: ele sai entre duas transações curtas, nunca com uma aberta.

/** A volta da plataforma precisa chegar em até 10 minutos. */
const VALIDADE_MIN = 10;

/** O evento de auditoria do começo da conexão (a rota declara `@Auditar` com ele, gravado à mão pelo serviço). */
export const ACAO_INICIAR = 'conexao.iniciar';

/** O que o começo da conexão leu do banco e gerou, antes de gravar (e, no RegemCast, antes do pedido empurrado). */
type Inicio = {
  id: string;
  provedor: ProvedorOAuth;
  brandId: string;
  estado: string;
  verificador: string | null;
  versaoMeta: string;
  redirectUri: string;
  meta: ReturnType<typeof configuracaoDaMeta> | null;
  conversoes: boolean;
  perfil: boolean;
  searchConsole: boolean;
  contaQuePede: ContaQuePede | null;
};

function quemPede(auth: AuthContext): { tenantId: string; userId: string } {
  if (!auth.tenantId) throw new AppProblem(403, 'sem-empresa-ativa', 'Escolha uma empresa', 'Selecione uma empresa com acesso ativo.');
  return { tenantId: auth.tenantId, userId: auth.userId };
}

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
  /** Meta: `leitura` ou `escrita`, a configuração do login por que a pessoa autorizou; só a lista e o detalhe leem. */
  requested_access?: string | null;
  /** Como terminou a procura das lojas do Perfil (`oauth_connection.discovery_notes`); só a lista e o detalhe leem. */
  discovery_notes?: unknown;
};

/**
 * Conta descoberta, como o worker guarda em `oauth_connection.discovered`. `google_business`: a loja do Perfil da Empresa
 * no Google; `search_console`: um site do Search Console.
 */
export type DescobertaGuardada = {
  provider: 'meta_ads' | 'google_ads' | 'ga4' | 'regem' | 'regemcast' | 'google_business' | 'search_console';
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

/** A última procura das lojas do Perfil, como a tela lê (A6, P17 parte B); nulo = o Liame não procurou. */
export function procuraDoPerfil(notas: unknown): ProfileSearch | null {
  const p = procuraGuardada(notas);
  return p ? { result: p.resultado, searched_at: iso(p.em), stores: p.lojas } : null;
}

/** A última procura dos sites do Search Console, como a tela lê (A6, P18 parte B); nulo = o Liame não procurou. */
export function procuraDosSites(notas: unknown): SiteSearch | null {
  const p = procuraDosSitesGuardada(notas);
  return p ? { result: p.resultado, searched_at: iso(p.em), sites: p.sites } : null;
}

/** O acesso da conta do Google ao site do Search Console (guardado pela procura em `provider_attributes.permissao`); nulo sem ele. */
function acessoAoSite(atributos: Record<string, unknown> | undefined): string | null {
  const p = atributos?.permissao;
  return typeof p === 'string' && /^[a-z_]{1,40}$/.test(p) ? p : null;
}

/** O site que o perfil da loja informa (guardado pela procura em `provider_attributes.site`); nulo sem site. */
function siteDaLoja(atributos: Record<string, unknown> | undefined): string | null {
  const s = atributos?.site;
  return typeof s === 'string' && s.trim() ? s.trim() : null;
}

const naoEncontrada =() => new AppProblem(404, 'nao-encontrado', 'Não encontramos', 'Conexão não encontrada nesta empresa.');

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
  private clienteDmsId: ClienteDmsId | null = null;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(DATABASE) private readonly database: Database | null,
    private readonly vault: VaultService,
    private readonly flags: FlagService,
  ) {}

  /**
   * Autorizações que dá para começar agora. A Meta, o Google e o Regem quando o app ou o cliente da distribuição está
   * configurado (o Regem: `REGEM_CLIENT_ID` e `REGEM_CLIENT_SECRET`); o RegemCast por clique (Hub DMS, B1) quando a
   * página, a API e o aplicativo do Liame no DMS ID estão configurados E a flag `regemcast_por_clique` está ligada
   * para a empresa (ou a marca).
   */
  private async disponiveis(auth: Pick<AuthContext, 'tenantId' | 'userId'>, brandId: string | null): Promise<ProvedorOAuth[]> {
    const lista: ProvedorOAuth[] = (['meta', 'google', 'regem'] as const).filter((p) => Boolean(this.config.oauth[p]));
    const ctx = this.flags.context({ tenantId: auth.tenantId, userId: auth.userId, brandId });
    if (this.config.oauth.regemcast && (await this.flags.isEnabled(FLAG_REGEMCAST_POR_CLIQUE, ctx))) lista.push('regemcast');
    return lista;
  }

  private banco(): Database {
    if (!this.database) throw new Error('conexões: sem banco');
    return this.database;
  }

  /** O cliente do DMS ID da API, um por processo (o worker tem o dele): guarda o token e junta os pedidos ao mesmo tempo. */
  private dmsId(): ClienteDmsId {
    if (!this.config.dmsId) throw new ErroConector('definitivo', 'regemcast', 'sem o aplicativo do Liame no DMS ID');
    this.clienteDmsId ??= clienteDoDmsId(this.config.dmsId);
    return this.clienteDmsId;
  }

  /** Lojas do Liame da marca, por nome: a escolha de "Loja no Liame" ao ligar as lojas do Regem. */
  async lojasDaMarca(brandId: string): Promise<UnitListResponse> {
    const r = await currentTx().execute<{ id: string; brand_id: string; name: string }>(sql`
      select id, brand_id, name from liame.unit where brand_id = ${brandId} order by lower(name), id limit 500`);
    return { items: r.rows.map((u) => ({ id: u.id, brand_id: u.brand_id, name: u.name })) };
  }

  /**
   * Cria o estado do OAuth e devolve para onde mandar a pessoa autorizar. Fora da transação da requisição (a rota é
   * `@SemTransacao`): o RegemCast pede o pedido empurrado (RFC 9126) ao servidor de lá ANTES de a pessoa ir, e chamada
   * externa não acontece com transação aberta. O banco lê numa transação curta, o pedido sai depois, e a conexão entra
   * junto com o evento de auditoria noutra transação curta. Nas outras plataformas, nada sai entre as duas.
   */
  async iniciar(auth: AuthContext, body: StartConnectionRequest): Promise<StartConnectionResponse> {
    const quem = quemPede(auth);
    const database = this.banco();
    const inicio = await naTransacaoDaEmpresa(database, quem, () => this.prepararInicio(auth, body));
    const pedido = inicio.provedor === 'regemcast' ? await this.pedirAoRegemcast(quem.tenantId, inicio) : null;
    return naTransacaoDaEmpresa(database, quem, () => this.gravarInicio(auth, inicio, pedido));
  }

  /** O que o começo precisa do banco: se dá para conectar, a marca, o que cada plataforma pede e o estado novo. */
  private async prepararInicio(auth: AuthContext, body: StartConnectionRequest): Promise<Inicio> {
    const tenantId = auth.tenantId!;
    const provedor: ProvedorOAuth = body.provider;
    if (!(await this.disponiveis(auth, body.brand_id)).includes(provedor)) {
      const nome = { meta: 'a Meta', google: 'o Google', regem: 'o Regem', regemcast: 'o RegemCast' }[provedor];
      throw new AppProblem(503, 'integracao-indisponivel', 'Conexão ainda indisponível', `A conexão com ${nome} ainda não está disponível. Tente de novo mais tarde.`);
    }
    const tx = currentTx();
    const marca = await tx.execute<{ id: string; name: string }>(sql`select id, name from liame.brand where id = ${body.brand_id} and archived_at is null`);
    const daMarca = marca.rows[0];
    if (!daMarca) throw new AppProblem(404, 'nao-encontrado', 'Não encontramos', 'Marca não encontrada nesta empresa.');

    // Meta: a empresa com a escrita ligada (a mesma flag que o Action Service confere) autoriza pela configuração que
    // também pede para gerenciar anúncios; as outras seguem na de leitura. Quem já estava conectado só passa a
    // escrever depois de conectar de novo: a autorização nova assume as contas (`ligarContas`).
    const metaDaDistribuicao = provedor === 'meta' ? this.config.oauth.meta! : null;
    const meta = metaDaDistribuicao
      ? configuracaoDaMeta(
          metaDaDistribuicao,
          metaDaDistribuicao.writeConfigId !== null &&
            (await this.flags.isEnabled('meta_write', this.flags.context({ tenantId, userId: auth.userId, brandId: body.brand_id }))),
        )
      : null;
    // Google: a empresa com as conversões ligadas (a mesma flag que a rotina de envio confere) autoriza também a
    // permissão de informar vendas; as outras seguem só com a leitura.
    const conversoes =
      provedor === 'google' && (await this.flags.isEnabled(FLAG_CONVERSOES_GOOGLE, this.flags.context({ tenantId, userId: auth.userId, brandId: body.brand_id })));
    // E a empresa com o Perfil ligado autoriza também a permissão do Perfil da Empresa (D-A6-17): é por ela que o Liame
    // alcança as lojas, as avaliações e os números do perfil. A mesma flag que a procura das lojas confere, no worker.
    const perfil =
      provedor === 'google' && (await this.flags.isEnabled(FLAG_PERFIL_GOOGLE, this.flags.context({ tenantId, userId: auth.userId, brandId: body.brand_id })));
    // E a empresa com o Search Console ligado autoriza também a leitura dele (A6, Z3): os sites e as buscas no Google
    // que levaram a eles. A mesma flag que a procura dos sites confere, no worker.
    const searchConsole =
      provedor === 'google' && (await this.flags.isEnabled(FLAG_SEARCH_CONSOLE, this.flags.context({ tenantId, userId: auth.userId, brandId: body.brand_id })));
    // RegemCast: a conta que pede, no Liame, que a página de lá mostra ao dono antes de ele decidir (decisão B1-6: outra
    // empresa pode, com a confirmação explícita dele). O CNPJ da empresa é guardado só com os 14 dígitos (check da
    // 0002); sem ele, o RegemCast trata como outra empresa e pede a confirmação.
    let contaQuePede: ContaQuePede | null = null;
    if (provedor === 'regemcast') {
      const org = await tx.execute<{ name: string; cnpj: string | null }>(sql`select name, cnpj from liame.organization where id = ${tenantId}`);
      contaQuePede = { nome: org.rows[0]?.name ?? daMarca.name, cnpj: org.rows[0]?.cnpj ?? null, email: auth.email, marca: daMarca.name };
    }
    return {
      id: uuidv7(),
      provedor,
      brandId: daMarca.id,
      estado: novoEstado(),
      verificador: provedor === 'google' || provedor === 'regem' || provedor === 'regemcast' ? novoVerificador() : null,
      versaoMeta: await this.versaoMeta(),
      redirectUri: enderecoDeVolta(this.config),
      meta,
      conversoes,
      perfil,
      searchConsole,
      contaQuePede,
    };
  }

  /**
   * O pedido empurrado do RegemCast (RFC 9126), sem transação aberta: o endereço de volta, as permissões, o `state`, o
   * desafio e a conta que pede ficam lá, e a página recebe só o número do pedido. O token do DMS ID recusado (vencido,
   * trocado) é pedido de novo, uma vez. A recusa vira um problema que a tela explica, e o motivo vai para o log.
   */
  private async pedirAoRegemcast(tenantId: string, inicio: Inicio): Promise<string> {
    const regemcast = this.config.oauth.regemcast!;
    const clientId = this.config.dmsId!.aplicativo;
    const cliente = new ClienteConector(this.banco().db, { enderecos: enderecosDasPlataformas(this.config.plataformas, this.config.produtos), tentativas: 1, tempoLimiteMs: 10_000 });
    const ctx = { cliente, apiUrl: regemcast.apiUrl };
    try {
      const r = await comTokenDoDmsId(this.dmsId(), recursoDoRegemcast(regemcast.apiUrl), PERMISSOES_DO_CLIQUE, (tokenDmsId) =>
        pedirAutorizacao(ctx, {
          tokenDmsId,
          contaChave: `autorizacao:${tenantId}`,
          clientId,
          redirectUri: inicio.redirectUri,
          estado: inicio.estado,
          desafio: desafioPkce(inicio.verificador!),
          conta: inicio.contaQuePede!,
        }),
      );
      return r.request_uri;
    } catch (err) {
      const e = err instanceof ErroConector ? err : null;
      const motivo = e ? `${e.tipo}${e.codigoProvider ? `:${e.codigoProvider}` : ''}: ${e.message}` : err instanceof Error ? err.message : String(err);
      this.logger.warn(`pedido de autorização ao RegemCast recusado (empresa ${tenantId}): ${motivo}`);
      if (e && ['transitorio', 'limite', 'circuito_aberto'].includes(e.tipo)) {
        throw new AppProblem(502, 'plataforma-indisponivel', 'O RegemCast não respondeu', 'O RegemCast não respondeu agora. Tente de novo em alguns minutos.');
      }
      if (e?.codigoProvider === 'integracao-parada') {
        throw new AppProblem(503, 'integracao-indisponivel', 'Conexão pausada no RegemCast', 'A conexão do Liame com o RegemCast está pausada agora. Tente de novo mais tarde.');
      }
      throw new AppProblem(
        503,
        'integracao-indisponivel',
        'Conexão ainda indisponível',
        'Não deu para começar a conexão com o RegemCast agora. Tente de novo mais tarde; se continuar, fale com o suporte.',
      );
    }
  }

  /** A conexão nasce junto com o evento de auditoria, numa transação curta (a rota audita à mão: fora da transação dela). */
  private async gravarInicio(auth: AuthContext, inicio: Inicio, pedidoRegemcast: string | null): Promise<StartConnectionResponse> {
    const tenantId = auth.tenantId!;
    const tx = currentTx();
    const verificadorCifrado = inicio.verificador ? await this.vault.encryptForTenant(tx, tenantId, `oauth_pkce:${inicio.id}`, inicio.verificador) : null;
    const r = await tx.execute<{ expires_at: Date | string }>(sql`
      insert into liame.oauth_connection (id, tenant_id, brand_id, provider, requested_by, state_hash, redirect_uri, pkce_verifier_enc, expires_at,
                                          requested_access)
      values (${inicio.id}, ${tenantId}, ${inicio.brandId}, ${inicio.provedor}, ${auth.userId}, ${hashEstado(inicio.estado)}, ${inicio.redirectUri}, ${verificadorCifrado},
              now() + make_interval(mins => ${VALIDADE_MIN}), ${inicio.meta?.acesso ?? null})
      returning expires_at`);
    await writeAudit(tx, {
      tenantId,
      actorType: 'human',
      actorId: auth.userId,
      actorLabel: actorLabel(auth),
      actorRole: auth.roleKey,
      action: ACAO_INICIAR,
      resourceType: 'oauth_connection',
      resourceId: inicio.id,
      before: null,
      after: {
        provider: inicio.provedor,
        brand_id: inicio.brandId,
        ...(inicio.meta ? { acesso: inicio.meta.acesso } : {}),
        ...(inicio.conversoes ? { informar_vendas: true } : {}),
        ...(inicio.perfil ? { perfil_no_google: true } : {}),
        ...(inicio.searchConsole ? { search_console: true } : {}),
        ...(inicio.provedor === 'regemcast' ? { permissoes: [...PERMISSOES_DO_CLIQUE] } : {}),
      },
      traceId: activeTraceId(),
      origin: 'api',
    });
    return {
      id: inicio.id,
      authorize_url: urlDeAutorizacao(inicio.provedor, this.config, {
        estado: inicio.estado,
        redirectUri: inicio.redirectUri,
        verificador: inicio.verificador ?? undefined,
        versaoMeta: inicio.versaoMeta,
        configMeta: inicio.meta?.configId,
        ...(inicio.provedor === 'google' ? { escoposGoogle: escoposDoGoogle(inicio.conversoes, inicio.perfil, inicio.searchConsole) } : {}),
        ...(pedidoRegemcast ? { pedidoRegemcast } : {}),
      }),
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
    const r = await tx.execute<{ id: string; tenant_id: string; provider: string; requested_by: string | null; status: string; vencido: boolean }>(sql`
      select id, tenant_id, provider, requested_by, status, expires_at < now() as vencido
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
    // RFC 9207: a volta da autorização por clique traz o `iss`, e ele tem de ser o do RegemCast. Uma volta com o
    // `state` desta conexão vinda de outro servidor de autorização (mistura de servidores) para aqui, antes da troca.
    if (linha.provider === 'regemcast' && q.iss !== this.config.oauth.regemcast?.emissor) {
      await tx.execute(sql`
        update liame.oauth_connection set status = 'erro', error_code = 'emissor_invalido', pkce_verifier_enc = null, updated_at = now()
         where id = ${linha.id}`);
      auditDetail({ reason: 'a volta do RegemCast não trouxe o emissor esperado (iss)' });
      return tela({ conexao: linha.id, erro: 'autorizacao_invalida' });
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

  async listar(auth: AuthContext, brandId?: string): Promise<ConnectionListResponse> {
    const tx = currentTx();
    const conexoes = await tx.execute<LinhaConexao>(sql`
      select c.id, c.brand_id, c.provider, c.origin, c.status, c.requested_by, u.name as requested_by_name, c.error_code, c.created_at, c.completed_at,
             c.refresh_expires_at, c.expires_at, c.discovered, c.credential_secret_id, c.scopes, c.requested_access, c.discovery_notes
        from liame.oauth_connection c left join liame.app_user u on u.id = c.requested_by
       where c.status not in ('aguardando_autorizacao', 'expirada') ${brandId ? sql`and c.brand_id = ${brandId}` : sql``}
       order by c.created_at desc limit 200`);
    const ctx = this.flags.context({ tenantId: auth.tenantId, userId: auth.userId, brandId: brandId ?? null });
    return {
      items: await this.montar(conexoes.rows),
      available: await this.disponiveis(auth, brandId ?? null),
      // A mesma flag que o Action Service confere ao pedir e ao executar a criação do cupom.
      regem_write: await this.flags.isEnabled('regem_write', ctx),
      ads_write: await this.anunciosComEscrita(auth, brandId ?? null),
      // A mesma flag que o começo da conexão do Google e a procura das lojas conferem.
      business_profile: await this.flags.isEnabled(FLAG_PERFIL_GOOGLE, ctx),
      // A mesma flag que o começo da conexão do Google e a procura dos sites conferem.
      search_console: await this.flags.isEnabled(FLAG_SEARCH_CONSOLE, ctx),
    };
  }

  /**
   * As plataformas de anúncio em que mudar campanhas está ligado para a empresa: as mesmas flags do pedido. Na Meta,
   * só quando existe a configuração de login que pede para gerenciar anúncios (sem ela, a autorização nova continua
   * só de leitura, como em `iniciar`). No Google, a autorização é a mesma para ler e mudar: o que muda é o que o Liame faz.
   */
  private async anunciosComEscrita(auth: AuthContext, brandId: string | null): Promise<string[]> {
    const ctx = this.flags.context({ tenantId: auth.tenantId, userId: auth.userId, brandId });
    const ligadas: string[] = [];
    if (this.config.oauth.meta?.writeConfigId && (await this.flags.isEnabled('meta_write', ctx))) ligadas.push('meta_ads');
    if (await this.flags.isEnabled('google_write', ctx)) ligadas.push('google_ads');
    return ligadas;
  }

  async detalhe(id: string): Promise<ConnectionResponse> {
    const r = await currentTx().execute<LinhaConexao>(sql`
      select c.id, c.brand_id, c.provider, c.origin, c.status, c.requested_by, u.name as requested_by_name, c.error_code, c.created_at, c.completed_at,
             c.refresh_expires_at, c.expires_at, c.discovered, c.credential_secret_id, c.scopes, c.requested_access, c.discovery_notes
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
      requested_access: l.requested_access ?? null,
      discovered: (l.discovered ?? []).map(
        (d): DiscoveredAccount => ({
          provider: d.provider,
          external_id: d.external_id,
          name: d.name,
          currency: d.currency,
          timezone: d.timezone,
          linked: ligadas.has(`${d.provider}:${d.external_id}`),
          via: typeof d.provider_attributes?.via === 'string' ? d.provider_attributes.via : null,
          ...(d.provider === PROVEDOR_PERFIL_GOOGLE ? { site: siteDaLoja(d.provider_attributes) } : {}),
          ...(d.provider === PROVEDOR_SEARCH_CONSOLE ? { site_access: acessoAoSite(d.provider_attributes) } : {}),
        }),
      ),
      accounts: contas.rows.filter((c) => c.connection_id === l.id).map(conta),
      ...(l.provider === 'google' ? { profile_search: procuraDoPerfil(l.discovery_notes), site_search: procuraDosSites(l.discovery_notes) } : {}),
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
    // Contas que hoje estão ligadas por OUTRA autorização da mesma marca: esta assume. No Regem, o token antigo
    // deixa de valer quando o novo nasce; no Google em fase de teste, é assim que "conectar de novo antes" renova
    // a leitura (ERR-052). A autorização que ficar sem conta nenhuma é encerrada no fim.
    const antigas = escolhidas.length
      ? (
          await tx.execute<{ connection_id: string; provider: string }>(sql`
            select distinct a.connection_id, o.provider
              from liame.connected_account a
              join liame.oauth_connection o on o.id = a.connection_id
              join jsonb_to_recordset(${JSON.stringify(escolhidas.map((d) => ({ provider: d.provider, external_id: d.external_id })))}::jsonb)
                   as x (provider text, external_id text) on x.provider = a.provider and x.external_id = a.external_id
             where a.brand_id = ${c.brand_id} and a.disconnected_at is null
               and a.connection_id is not null and a.connection_id <> ${c.id}`)
        ).rows
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
    // A autorização antiga que perdeu todas as contas para esta: a credencial sai do cofre e ela deixa de aparecer
    // como se ainda valesse (ficava na tela com "0 contas"). No Regem, o token dela já não vale lá. Nas outras
    // plataformas ela é encerrada SÓ AQUI, sem revogar na origem, por precaução: no Google a revogação vale para
    // o acesso do app à conta da pessoa, e pode levar junto a autorização nova que acabou de assumir as contas
    // (não confirmado na documentação). O token antigo deixa de ser nosso (fora do cofre) e vence sozinho.
    const encerradas: string[] = [];
    for (const antiga of antigas) {
      const resta = await tx.execute(sql`select 1 from liame.connected_account where connection_id = ${antiga.connection_id} and disconnected_at is null limit 1`);
      if (resta.rows.length) continue;
      if (await this.encerrar(antiga.connection_id, { revogarNaOrigem: antiga.provider === 'regem' || antiga.provider === 'regemcast' })) encerradas.push(antiga.connection_id);
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
    const r = await tx.execute<{ provider: string; external_id: string; credential_secret_id: string | null; connection_id: string | null; ligacao_secret_id: string | null }>(sql`
      update liame.connected_account set status = 'desconectada', status_reason = 'desligada por pessoa', disconnected_at = now(), updated_at = now()
       where id = ${id} and disconnected_at is null
       returning provider, external_id, credential_secret_id, connection_id, ligacao_secret_id`);
    const conta = r.rows[0];
    if (!conta) throw new AppProblem(404, 'nao-encontrado', 'Não encontramos', 'Conta conectada não encontrada nesta empresa.');
    // O segredo da ligação do Hub DMS (RegemCast e Regem) sai do cofre junto: nos dois, revogar o token revoga a ligação.
    if (conta.ligacao_secret_id) await this.vault.revokeSecret(tx, conta.ligacao_secret_id);
    let tokenDaLoja: string | null = null;
    // No RegemCast, o `rct_it_` da conta ou a ligação da autorização por clique (Hub DMS, B1): as duas são desligadas lá.
    let doRegemcast: CredencialDaConta | null = null;
    if ((conta.provider === 'regem' || conta.provider === 'regemcast') && conta.credential_secret_id) {
      const guardada = await this.vault.readSecret(tx, conta.credential_secret_id);
      const lida = guardada ? (JSON.parse(guardada) as CredencialGuardada) : null;
      if (conta.provider === 'regemcast') doRegemcast = credencialDaConta(lida, conta.external_id);
      else tokenDaLoja = ((lida as CredencialRegem | null)?.lojas ?? []).find((l) => l.loja_id === conta.external_id)?.token ?? null;
    }
    const revogada = conta.provider === 'regemcast' ? { revogada_no_regemcast: true } : { revogada_no_regem: true };
    auditDetail({
      resourceId: id,
      before: { status: 'ativa' },
      after: { status: 'desconectada', provider: conta.provider, external_id: conta.external_id, ...(tokenDaLoja || doRegemcast ? revogada : {}) },
    });
    if ((tokenDaLoja || doRegemcast) && this.database) {
      const cliente = new ClienteConector(this.database.db, { enderecos: enderecosDasPlataformas(this.config.plataformas, this.config.produtos), tentativas: 2 });
      const produto = conta.provider === 'regemcast' ? 'RegemCast' : 'Regem';
      const apiUrlRegemcast = this.config.produtos.regemcastApiUrl;
      const token = tokenDaLoja;
      const credencial = doRegemcast;
      afterCommit(async () => {
        try {
          if (credencial) {
            // Sem o endereço, a credencial já saiu do cofre e só não é desligada lá (o dono desliga em "Aplicativos conectados").
            if (apiUrlRegemcast) {
              await comAcessoDaConta(credencial, this.config, conta.external_id, (a) => revogarNoRegemcast({ cliente, apiUrl: apiUrlRegemcast }, a.token, a.contaChave, a.ligacao));
            }
          } else if (token) {
            // Pelo `rgm_it_` (`acesso-da-loja.ts`): no Regem, revogar o token revoga também a ligação do Hub DMS.
            await revogarNoRegem({ cliente, apiUrl: this.config.produtos.regemApiUrl }, { token, lojaChave: conta.external_id });
          }
        } catch (err) {
          this.logger.warn(`revogação no ${produto} falhou (conta ${id}, ${conta.external_id}): ${err instanceof Error ? err.message : String(err)}`);
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
   * `revogarNaOrigem: false` = a autorização foi substituída por outra da mesma pessoa, que assumiu as
   * contas: sai do cofre e da tela, mas a plataforma não é chamada (por precaução: no Google, revogar um
   * token pode levar junto o consentimento da autorização nova).
   */
  private async encerrar(id: string, { revogarNaOrigem = true }: { revogarNaOrigem?: boolean } = {}): Promise<{ antes: string; contas: number } | null> {
    const tx = currentTx();
    const r = await tx.execute<{ provider: string; credential_secret_id: string | null; inbox_secret_id: string | null; status: string }>(sql`
      select provider, credential_secret_id, inbox_secret_id, status from liame.oauth_connection where id = ${id} for update`);
    const c = r.rows[0];
    if (!c) throw naoEncontrada();
    if (c.status === 'revogada') return null;
    // O segredo dos avisos (webhook) da conexão sai do cofre junto: depois disto nenhuma assinatura confere.
    if (c.inbox_secret_id) await this.vault.revokeSecret(tx, c.inbox_secret_id);
    let refreshGoogle: string | null = null;
    let tokensRegem: { loja_id: string; token: string }[] = [];
    // No RegemCast: os `rct_it_` das contas (distribuição) ou a ligação da autorização por clique (Hub DMS, B1).
    let doRegemcast: { contaId: string; credencial: CredencialDaConta }[] = [];
    if (c.credential_secret_id) {
      const guardada = await this.vault.readSecret(tx, c.credential_secret_id);
      if (guardada && c.provider === 'google') refreshGoogle = (JSON.parse(guardada) as CredencialGuardada & { tipo: 'google' }).refresh_token;
      if (guardada && c.provider === 'regem') tokensRegem = ((JSON.parse(guardada) as CredencialRegem).lojas ?? []).map((l) => ({ loja_id: l.loja_id, token: l.token }));
      if (guardada && c.provider === 'regemcast') doRegemcast = credenciaisDaConexao(JSON.parse(guardada) as CredencialGuardada);
      await this.vault.revokeSecret(tx, c.credential_secret_id);
    }
    const contas = await tx.execute<{ id: string; ligacao_secret_id: string | null }>(sql`
      update liame.connected_account set status = 'desconectada', status_reason = 'autorização revogada', disconnected_at = now(), updated_at = now()
       where connection_id = ${id} and disconnected_at is null returning id, ligacao_secret_id`);
    // Os segredos das ligações do Hub DMS das contas da autorização saem do cofre junto.
    for (const conta of contas.rows) if (conta.ligacao_secret_id) await this.vault.revokeSecret(tx, conta.ligacao_secret_id);
    await tx.execute(sql`
      update liame.oauth_connection set status = 'revogada', revoked_at = now(), code_enc = null, pkce_verifier_enc = null, updated_at = now() where id = ${id}`);
    // Substituída por outra autorização que assumiu as contas: encerra só aqui (ver `ligarContas`).
    if (!revogarNaOrigem) return { antes: c.status, contas: contas.rows.length };
    if (tokensRegem.length && this.database) {
      // Revoga cada token da loja no Regem depois do commit (o token já saiu do cofre do Liame).
      const cliente = new ClienteConector(this.database.db, { enderecos: enderecosDasPlataformas(this.config.plataformas, this.config.produtos), tentativas: 2 });
      const ctx = { cliente, apiUrl: this.config.produtos.regemApiUrl };
      afterCommit(async () => {
        for (const t of tokensRegem) {
          try {
            await revogarNoRegem(ctx, { token: t.token, lojaChave: t.loja_id });
          } catch (err) {
            this.logger.warn(`revogação no Regem falhou (conexão ${id}, loja ${t.loja_id}): ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      });
    }
    const apiUrlRegemcast = this.config.produtos.regemcastApiUrl;
    if (doRegemcast.length && this.database && apiUrlRegemcast) {
      // O RegemCast desliga a credencial pela própria porta (`integracao_revogar`), depois do commit: o token da conta, ou
      // a ligação (com o token do DMS ID do aplicativo do Liame).
      const cliente = new ClienteConector(this.database.db, { enderecos: enderecosDasPlataformas(this.config.plataformas, this.config.produtos), tentativas: 2 });
      const ctx = { cliente, apiUrl: apiUrlRegemcast };
      afterCommit(async () => {
        for (const t of doRegemcast) {
          try {
            await comAcessoDaConta(t.credencial, this.config, t.contaId, (a) => revogarNoRegemcast(ctx, a.token, a.contaChave, a.ligacao));
          } catch (err) {
            this.logger.warn(`revogação no RegemCast falhou (conexão ${id}, conta ${t.contaId}): ${err instanceof Error ? err.message : String(err)}`);
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
