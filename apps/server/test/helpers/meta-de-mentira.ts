import { randomInt, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { type Database, withTenant } from '@liame/database';
import type { ReadResult } from '../../src/actions/connectors.js';
import { metaAnunciosConnector } from '../../src/actions/meta-anuncios.js';
import { ClienteConector } from '../../src/connectors/cliente-http.js';
import { versaoRegistrada } from '../../src/connectors/tipos.js';
import { DATABASE } from '../../src/database/database.module.js';
import { FlagService } from '../../src/flags/flag.service.js';
import { VaultService } from '../../src/vault/vault.service.js';
import { enableMfa, ownerQuery, signupAndLogin, type TestApi } from './api.js';

// Uma Graph API local para os testes de escrita na Meta (A4). Segue a referência conferida em 04/10/2026 (base de
// conhecimento §2.1): `GET /{id}?fields=…` devolve o objeto; `POST /{id}` muda `status` e `daily_budget` (na menor
// unidade da moeda); com `execution_options=["validate_only"]` valida sem mudar; a resposta é `{"success": true}`;
// os erros trazem `code`, `error_subcode` e `error_user_msg`; o uso da conta vem no cabeçalho.

export type ObjetoNaMeta = { id: string; name: string; status: string; effective_status: string; daily_budget?: string; lifetime_budget?: string; account_id: string };
export type ChamadaNaMeta = { metodo: string; id: string; params: Record<string, string>; validar: boolean };
export type FalhaDaMeta = { status: number; corpo: unknown; cabecalhos?: Record<string, string>; aplicaAntes?: boolean };
export type TipoDeObjeto = 'campanha' | 'conjunto' | 'anuncio';

export const TOKEN_DA_META = 'token-de-sistema-da-meta-para-o-teste';
export const SEGREDO_DO_APP_DA_META = 'segredo-do-app-da-meta-de-teste';

export class MetaDeMentira {
  // Uma conta de anúncios por execução do arquivo: o balde e o disjuntor do cliente ficam no banco, por conta.
  readonly conta = String(randomInt(1_000_000_000, 9_999_999_999));
  readonly outraConta = String(randomInt(1_000_000_000, 9_999_999_999));
  readonly objetos = new Map<string, ObjetoNaMeta>();
  readonly chamadas: ChamadaNaMeta[] = [];
  /** O que apareceu de errado no pedido (token na URL, sem a prova do segredo do app). */
  readonly defeitos: string[] = [];
  /** O que a Meta responde às próximas escritas (na ordem), antes de voltar ao normal. */
  falhasDaEscrita: FalhaDaMeta[] = [];
  /** O mesmo, para as próximas leituras. */
  falhasDaLeitura: FalhaDaMeta[] = [];
  /** Cabeçalho de uso devolvido em toda resposta enquanto estiver definido. */
  uso: string | null = null;
  /** Quanto a Meta demora para responder à próxima chamada (uma vez só). */
  atrasoDaProximaRespostaMs = 0;
  base = '';
  private servidor: Server | null = null;
  private seq = 0;

  async ligar(): Promise<void> {
    const servidor = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        const r = this.responder(req);
        const atraso = this.atrasoDaProximaRespostaMs;
        this.atrasoDaProximaRespostaMs = 0;
        const enviar = () => {
          // Quem pediu pode ter desistido de esperar: aí não há mais a quem responder.
          if (res.destroyed) return;
          res.writeHead(r.status, { 'content-type': 'application/json', ...(this.uso ? { 'x-business-use-case-usage': this.uso } : {}), ...r.cabecalhos });
          res.end(JSON.stringify(r.corpo));
        };
        // O temporizador não segura o processo do teste: quem pediu pode ter desistido bem antes.
        if (atraso > 0) setTimeout(enviar, atraso).unref();
        else enviar();
      });
    });
    await new Promise<void>((ok) => servidor.listen(0, '127.0.0.1', ok));
    this.servidor = servidor;
    this.base = `http://127.0.0.1:${(servidor.address() as AddressInfo).port}`;
  }

  async desligar(): Promise<void> {
    const servidor = this.servidor;
    if (servidor) await new Promise((ok) => servidor.close(ok));
  }

  /** Volta ao normal: sem falha combinada e sem cabeçalho de uso. */
  normalizar(): void {
    this.falhasDaEscrita = [];
    this.falhasDaLeitura = [];
    this.uso = null;
    this.atrasoDaProximaRespostaMs = 0;
  }

  erro(code: number, message: string, extra: Record<string, unknown> = {}): unknown {
    return { error: { message, type: 'OAuthException', code, fbtrace_id: 'AbCdEf', ...extra } };
  }

  /** Um objeto novo na Meta (ativo; campanha e conjunto com R$ 30,00 por dia). */
  novo(tipo: TipoDeObjeto, extra: Partial<ObjetoNaMeta> = {}): ObjetoNaMeta {
    this.seq += 1;
    const id = `12021${String(Date.now()).slice(-8)}${String(this.seq).padStart(4, '0')}`;
    const o: ObjetoNaMeta = { id, name: `${tipo} ${this.seq}`, status: 'ACTIVE', effective_status: 'ACTIVE', account_id: this.conta, ...(tipo === 'anuncio' ? {} : { daily_budget: '3000' }), ...extra };
    this.objetos.set(id, o);
    return o;
  }

  chamadasDe(id: string): ChamadaNaMeta[] {
    return this.chamadas.filter((c) => c.id === id);
  }

  escritasDe(id: string): ChamadaNaMeta[] {
    return this.chamadasDe(id).filter((c) => c.metodo === 'POST');
  }

  resumo(id: string): string[] {
    return this.chamadasDe(id).map((c) => (c.metodo === 'GET' ? 'ler' : c.validar ? 'validar' : 'escrever'));
  }

  private responder(req: IncomingMessage): { status: number; corpo: unknown; cabecalhos?: Record<string, string> } {
    const url = new URL(req.url ?? '/', this.base);
    const token = (req.headers.authorization ?? '').replace('Bearer ', '');
    if (url.searchParams.has('access_token') || (req.url ?? '').includes(TOKEN_DA_META)) this.defeitos.push('token na URL');
    if (!url.searchParams.get('appsecret_proof')) this.defeitos.push('sem appsecret_proof');
    const id = /^\/graph\/v26\.0\/(\d+)$/.exec(url.pathname)?.[1];
    if (!id) return { status: 404, corpo: this.erro(100, 'Unknown path') };
    const params = Object.fromEntries([...url.searchParams].filter(([k]) => k !== 'appsecret_proof'));
    const validar = (params.execution_options ?? '') === '["validate_only"]';
    this.chamadas.push({ metodo: req.method ?? 'GET', id, params, validar });
    if (token !== TOKEN_DA_META) return { status: 400, corpo: this.erro(190, 'Error validating access token: Session has expired') };
    const o = this.objetos.get(id);
    if (!o) {
      return {
        status: 400,
        corpo: this.erro(100, `Unsupported get request. Object with ID '${id}' does not exist, cannot be loaded due to missing permissions, or does not support this operation`, { error_subcode: 33 }),
      };
    }
    if (req.method === 'GET') return this.falhasDaLeitura.shift() ?? { status: 200, corpo: o };

    const aplicar = () => {
      if (params.status) o.status = o.effective_status = params.status;
      if (params.daily_budget) o.daily_budget = params.daily_budget;
    };
    const falha = this.falhasDaEscrita.shift();
    if (falha) {
      // "A Meta aceitou, mas a resposta se perdeu": a mudança acontece e quem pediu não fica sabendo.
      if (falha.aplicaAntes && !validar) aplicar();
      return falha;
    }
    // As regras da própria Meta, que a validação aplica sem mudar nada.
    if (params.daily_budget !== undefined && Number(params.daily_budget) < 600) {
      return {
        status: 400,
        corpo: this.erro(100, 'Invalid parameter', { error_subcode: 1885272, error_user_title: 'Orçamento baixo demais', error_user_msg: 'O orçamento diário precisa ser de pelo menos R$ 6,00.' }),
      };
    }
    if (params.daily_budget !== undefined && o.daily_budget === undefined) {
      return { status: 400, corpo: this.erro(100, 'Invalid parameter', { error_user_msg: 'O orçamento fica na campanha: não dá para definir no conjunto.' }) };
    }
    if (!validar) aplicar();
    return { status: 200, corpo: { success: true } };
  }
}

/**
 * O conector de escrita apontado para a Meta de mentira, com a conferência sem espera e um balde folgado (o teste
 * escreve muito). `tempoDaLeituraDoPedidoMs`: quanto a leitura da hora do pedido espera (o padrão do conector é 10 s).
 */
export function ligarConectorNaMetaDeMentira(api: TestApi, meta: MetaDeMentira, opcoes: { tempoDaLeituraDoPedidoMs?: number } = {}): void {
  const database: Database = api.app.get(DATABASE);
  const vault = api.app.get(VaultService);
  metaAnunciosConnector.ligar({
    lerSegredo: (tx, secretId) => vault.readSecret(tx, secretId),
    cliente: () => new ClienteConector(database.db, { enderecos: { meta_ads: [`${meta.base}/graph`] }, tentativas: 1, balde: { capacidade: 10_000, porSegundo: 1_000 } }),
    graphUrl: `${meta.base}/graph`,
    appSecret: SEGREDO_DO_APP_DA_META,
    versao: (capacidade) => versaoRegistrada(database.db, 'meta_ads', capacidade),
    esperaDaConferenciaMs: 0,
    ...opcoes,
  });
}

export type EmpresaComMeta = {
  cookie: string;
  userId: string;
  /** O segredo do app autenticador de quem aprova. */
  secret: string;
  tenantId: string;
  brandId: string;
  /** A conta conectada da Meta, com a autorização guardada no cofre. */
  conta: string;
  /** Outra conta da Meta, sem a autorização guardada (revogada). */
  contaSemToken: string;
};

/** Uma empresa com o app autenticador ativo e duas contas da Meta conectadas (uma com a autorização, outra sem). */
export async function empresaComMeta(api: TestApi, meta: MetaDeMentira, nome: string, contas: { conta?: string; outra?: string } = {}): Promise<EmpresaComMeta> {
  const database: Database = api.app.get(DATABASE);
  const vault = api.app.get(VaultService);
  const s = await signupAndLogin(api, undefined, nome);
  const { secret } = await enableMfa(api, s.cookie);
  const tenantId = s.me.active_organization_id as string;
  const brandId = (await ownerQuery<{ id: string }>(`select id from liame.brand where tenant_id = $1 limit 1`, [tenantId]))[0]!.id;
  const segredo = await withTenant(database.db, tenantId, (tx) =>
    vault.putSecret(tx, { tenantId, purpose: 'oauth_meta', plaintext: JSON.stringify({ tipo: 'meta', access_token: TOKEN_DA_META, obtido_em: new Date().toISOString(), expira_em: null }) }),
  );
  const [conta, contaSemToken] = [randomUUID(), randomUUID()];
  await ownerQuery(
    `insert into liame.connected_account (id, tenant_id, brand_id, provider, external_id, name, currency, timezone, credential_secret_id)
     values ($1, $3, $4, 'meta_ads', $5, 'CA - Mister Burgers', 'BRL', 'America/Sao_Paulo', $7),
            ($2, $3, $4, 'meta_ads', $6, 'CA - sem autorização', 'BRL', 'America/Sao_Paulo', null)`,
    [conta, contaSemToken, tenantId, brandId, `act_${contas.conta ?? meta.conta}`, `act_${contas.outra ?? meta.outraConta}`, segredo],
  );
  return { cookie: s.cookie, userId: s.me.user.id as string, secret, tenantId, brandId, conta, contaSemToken };
}

/** Liga ou desliga a flag `meta_write` para a empresa. */
export async function ligarEscritaNaMeta(api: TestApi, tenantId: string, valor: boolean): Promise<void> {
  await ownerQuery(`delete from liame.feature_flag_rule where flag_key = 'meta_write' and scope_type = 'tenant' and scope_id = $1`, [tenantId]);
  if (valor) {
    await ownerQuery(
      `insert into liame.feature_flag_rule (id, flag_key, scope_type, scope_id, value, rollout_percent, created_by)
       values (gen_random_uuid(), 'meta_write', 'tenant', $1, 'true'::jsonb, null, 'testes')`,
      [tenantId],
    );
  }
  api.app.get(FlagService).invalidate();
}

/**
 * Um objeto novo na Meta e na lista que o Liame leu da conta. `semLinha`: o Liame não leu o objeto (não o conhece).
 * `conta`: a conta conectada do Liame em que ele entra (por padrão, a da empresa com a autorização).
 */
export async function objetoLido(
  meta: MetaDeMentira,
  e: Pick<EmpresaComMeta, 'tenantId' | 'conta'>,
  tipo: TipoDeObjeto,
  extra: Partial<ObjetoNaMeta> = {},
  opcoes: { conta?: string; semLinha?: boolean } = {},
): Promise<{ id: string; recurso: string }> {
  const o = meta.novo(tipo, extra);
  if (!opcoes.semLinha) {
    const tabela = { campanha: 'campaign', conjunto: 'ad_group', anuncio: 'ad' }[tipo];
    await ownerQuery(`insert into liame.${tabela} (id, tenant_id, connected_account_id, provider, external_id, name, status) values ($1, $2, $3, 'meta_ads', $4, $5, 'ativa')`, [
      randomUUID(),
      e.tenantId,
      opcoes.conta ?? e.conta,
      o.id,
      o.name,
    ]);
  }
  return { id: o.id, recurso: `${tipo}:${o.id}` };
}

/** O estado do objeto como o conector o lê (na Meta de mentira), sob a RLS da empresa. */
export function lerNaMetaDeMentira(api: TestApi, tenantId: string, conta: string, recurso: string): Promise<ReadResult | null> {
  const database: Database = api.app.get(DATABASE);
  return withTenant(database.db, tenantId, (tx) => metaAnunciosConnector.read(tx, { tenantId, accountId: conta, resourceId: recurso }));
}
