import { randomInt, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { type Database, withTenant } from '@liame/database';
import { VaultService } from '../../src/vault/vault.service.js';
import { enableMfa, ownerQuery, resetIpRateLimits, signupAndLogin, type TestApi } from './api.js';

// Um "Google" local para os testes da escrita no Google Ads (A5, Y2): o OAuth (a troca do refresh token) e a Google
// Ads API v25 por REST, no que o conector usa e como a referência conferida em 08/10/2026 descreve (base §3.1):
// `googleAds:searchStream` com a campanha e o orçamento dela, e com as outras campanhas de um orçamento dividido; `campaigns:mutate` e `campaignBudgets:mutate` com
// `operations[].updateMask` em snake_case, o corpo em camelCase e `validateOnly` (não muda nada e só devolve erros);
// erros com o `GoogleAdsFailure` dentro de `error.details`.

export const ACESSO_DO_GOOGLE = 'acesso-de-teste-google';
export const REFRESH_DO_GOOGLE = 'refresh-de-teste-google';
/** O refresh token que o Google de mentira recusa (autorização revogada). */
export const REFRESH_REVOGADO = 'refresh-revogado';
const FUSO = 'America/Sao_Paulo';

export type CampanhaNoGoogle = { cliente: string; id: string; name: string; status: 'ENABLED' | 'PAUSED' | 'REMOVED'; primaryStatus: string; orcamento: string | null };
export type OrcamentoNoGoogle = { cliente: string; id: string; amountMicros: number | null; totalAmountMicros: number | null; explicitlyShared: boolean; period: 'DAILY' | 'CUSTOM_PERIOD' };
export type ChamadaAoGoogle = {
  tipo: 'leitura' | 'validacao' | 'escrita';
  cliente: string;
  /** `searchStream`, `campaigns` ou `campaignBudgets`. */
  recurso: string;
  corpo: Record<string, unknown>;
  autorizacao: string | undefined;
  gerente: string | undefined;
};
type Resposta = { status: number; corpo: unknown };

const numero = () => String(randomInt(1_000_000_000, 9_999_999_999));

export class GoogleDeMentira {
  base = '';
  readonly campanhas = new Map<string, CampanhaNoGoogle>();
  readonly orcamentos = new Map<string, OrcamentoNoGoogle>();
  readonly chamadas: ChamadaAoGoogle[] = [];
  /** Por conta (id do cliente): o que responder no lugar do normal. Devolver nulo segue o normal. */
  readonly defeitos = new Map<string, (c: ChamadaAoGoogle) => Resposta | null>();
  renovacoes = 0;
  private servidor: Server | null = null;

  async subir(): Promise<void> {
    this.servidor = createServer((req, res) => {
      let texto = '';
      req.on('data', (d: Buffer) => (texto += d.toString('utf8')));
      req.on('end', () => {
        const r = this.responder(req, texto);
        res.writeHead(r.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(r.corpo));
      });
    });
    await new Promise<void>((ok) => this.servidor!.listen(0, '127.0.0.1', ok));
    this.base = `http://127.0.0.1:${(this.servidor.address() as AddressInfo).port}`;
  }

  async fechar(): Promise<void> {
    await new Promise((ok) => (this.servidor ? this.servidor.close(ok) : ok(undefined)));
  }

  /** As variáveis de ambiente que apontam o app para este Google (antes de subir a API). */
  ambiente(): Record<string, string> {
    return {
      GOOGLE_OAUTH_CLIENT_ID: 'cliente-de-teste.apps.googleusercontent.com',
      GOOGLE_OAUTH_CLIENT_SECRET: 'segredo-do-cliente-de-teste',
      GOOGLE_AUTH_URL: `${this.base}/google`,
      GOOGLE_TOKEN_URL: `${this.base}/oauth`,
      GOOGLE_ADS_URL: `${this.base}/ads`,
    };
  }

  /** O erro como a Google Ads API responde: o geral por fora e o específico no `GoogleAdsFailure`. */
  erro(status: number, nome: string, mensagem: string, especifico?: { codigo: Record<string, string>; texto: string; esperar?: string }): Resposta {
    return {
      status,
      corpo: {
        error: {
          code: status,
          message: mensagem,
          status: nome,
          ...(especifico
            ? {
                details: [
                  {
                    '@type': 'type.googleapis.com/google.ads.googleads.v25.errors.GoogleAdsFailure',
                    errors: [
                      {
                        errorCode: especifico.codigo,
                        message: especifico.texto,
                        ...(especifico.esperar ? { details: { quotaErrorDetails: { rateScope: 'DEVELOPER', rateName: 'Number of operations for explorer access', retryDelay: especifico.esperar } } } : {}),
                      },
                    ],
                    requestId: 'pedido-de-teste',
                  },
                ],
              }
            : {}),
        },
      },
    };
  }

  /** Um orçamento novo na conta: por padrão diário, de R$ 30,00, de uma campanha só. */
  novoOrcamento(cliente: string, extra: Partial<Omit<OrcamentoNoGoogle, 'cliente' | 'id'>> = {}): OrcamentoNoGoogle {
    const o: OrcamentoNoGoogle = { cliente, id: numero(), amountMicros: 30_000_000, totalAmountMicros: null, explicitlyShared: false, period: 'DAILY', ...extra };
    this.orcamentos.set(o.id, o);
    return o;
  }

  /** Uma campanha nova na conta, com o orçamento dado (ou um novo, só dela). */
  novaCampanha(cliente: string, extra: Partial<Omit<CampanhaNoGoogle, 'cliente' | 'id'>> = {}): CampanhaNoGoogle {
    const orcamento = extra.orcamento === undefined ? this.novoOrcamento(cliente).id : extra.orcamento;
    const c: CampanhaNoGoogle = { cliente, id: numero(), name: 'Busca hambúrguer perto', status: 'ENABLED', primaryStatus: 'ELIGIBLE', ...extra, orcamento };
    this.campanhas.set(c.id, c);
    return c;
  }

  chamadasDe(cliente: string): ChamadaAoGoogle[] {
    return this.chamadas.filter((c) => c.cliente === cliente);
  }
  /** O resumo das chamadas de uma conta, na ordem: `leitura`, `validacao:campaigns`, `escrita:campaignBudgets`… */
  resumo(cliente: string): string[] {
    return this.chamadasDe(cliente).map((c) => (c.tipo === 'leitura' ? 'leitura' : `${c.tipo}:${c.recurso}`));
  }
  /** As escritas de verdade (sem as validações) que chegaram para a conta. */
  escritasDe(cliente: string): ChamadaAoGoogle[] {
    return this.chamadasDe(cliente).filter((c) => c.tipo === 'escrita');
  }

  private linha(c: CampanhaNoGoogle): Record<string, unknown> {
    const o = c.orcamento ? this.orcamentos.get(c.orcamento) : undefined;
    const usando = o ? [...this.campanhas.values()].filter((x) => x.orcamento === o.id && x.status !== 'REMOVED').length : 0;
    return {
      campaign: {
        resourceName: `customers/${c.cliente}/campaigns/${c.id}`,
        id: c.id,
        name: c.name,
        status: c.status,
        primaryStatus: c.primaryStatus,
        ...(o ? { campaignBudget: `customers/${c.cliente}/campaignBudgets/${o.id}` } : {}),
      },
      ...(o
        ? {
            campaignBudget: {
              resourceName: `customers/${c.cliente}/campaignBudgets/${o.id}`,
              id: o.id,
              // O JSON do protobuf manda int64 como texto e omite o que não foi definido.
              ...(o.amountMicros !== null ? { amountMicros: String(o.amountMicros) } : {}),
              ...(o.totalAmountMicros !== null ? { totalAmountMicros: String(o.totalAmountMicros) } : {}),
              explicitlyShared: o.explicitlyShared,
              referenceCount: String(usando),
              period: o.period,
            },
          }
        : {}),
    };
  }

  private responder(req: IncomingMessage, texto: string): Resposta {
    const url = new URL(req.url ?? '/', this.base);
    if (url.pathname === '/oauth/token') {
      this.renovacoes += 1;
      const pedido = new URLSearchParams(texto);
      if (pedido.get('refresh_token') === REFRESH_REVOGADO) return { status: 400, corpo: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' } };
      return { status: 200, corpo: { access_token: ACESSO_DO_GOOGLE, expires_in: 3599, token_type: 'Bearer' } };
    }
    const m = url.pathname.match(/^\/ads\/v25\/customers\/(\d+)\/(googleAds:searchStream|campaigns:mutate|campaignBudgets:mutate)$/);
    if (!m || req.method !== 'POST') return this.erro(404, 'NOT_FOUND', url.pathname);
    const cliente = m[1]!;
    const recurso = m[2]!.replace(/^googleAds:/, '').replace(/:mutate$/, '');
    const corpo = texto ? (JSON.parse(texto) as Record<string, unknown>) : {};
    const gerente = req.headers['login-customer-id'];
    const chamada: ChamadaAoGoogle = {
      tipo: recurso === 'searchStream' ? 'leitura' : corpo.validateOnly === true ? 'validacao' : 'escrita',
      cliente,
      recurso,
      corpo,
      autorizacao: req.headers.authorization,
      gerente: Array.isArray(gerente) ? gerente[0] : gerente,
    };
    this.chamadas.push(chamada);
    if (req.headers.authorization !== `Bearer ${ACESSO_DO_GOOGLE}`) return this.erro(401, 'UNAUTHENTICATED', 'Request had invalid authentication credentials.');
    const defeito = this.defeitos.get(cliente)?.(chamada);
    if (defeito) return defeito;

    if (recurso === 'searchStream') {
      const consulta = String(corpo.query ?? '');
      // Com quem a verba é dividida: as campanhas do orçamento, menos a que perguntou e as removidas, pelo nome.
      const dividida = /^SELECT campaign\.id, campaign\.name FROM campaign WHERE campaign\.campaign_budget = 'customers\/(\d+)\/campaignBudgets\/(\d+)' AND campaign\.status != 'REMOVED' AND campaign\.id != (\d+) ORDER BY campaign\.name LIMIT (\d+)$/.exec(consulta);
      if (dividida) {
        const [, daConta, orcamento, menos, limite] = dividida;
        const outras = [...this.campanhas.values()]
          .filter((x) => daConta === cliente && x.cliente === cliente && x.orcamento === orcamento && x.status !== 'REMOVED' && x.id !== menos)
          .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'))
          .slice(0, Number(limite));
        return { status: 200, corpo: outras.length ? [{ results: outras.map((x) => ({ campaign: { resourceName: `customers/${cliente}/campaigns/${x.id}`, id: x.id, name: x.name } })), fieldMask: 'campaign.id,campaign.name', requestId: 'leitura-de-teste' }] : [] };
      }
      const id = /FROM campaign WHERE campaign\.id = (\d+)$/.exec(consulta)?.[1];
      if (!id) return this.erro(400, 'INVALID_ARGUMENT', 'Request contains an invalid argument.', { codigo: { queryError: 'UNRECOGNIZED_FIELD' }, texto: 'Error in query: unexpected input.' });
      const c = this.campanhas.get(id);
      // Sem linha, o searchStream devolve a lista de lotes vazia.
      return { status: 200, corpo: c && c.cliente === cliente ? [{ results: [this.linha(c)], fieldMask: 'campaign.id,campaign.name', requestId: 'leitura-de-teste' }] : [] };
    }

    const operacoes = corpo.operations as Array<{ updateMask?: string; update?: Record<string, unknown> }> | undefined;
    const op = operacoes?.[0];
    if (!Array.isArray(operacoes) || operacoes.length !== 1 || !op?.update || typeof op.update.resourceName !== 'string') {
      return this.erro(400, 'INVALID_ARGUMENT', 'Request contains an invalid argument.', { codigo: { requestError: 'REQUIRED_FIELD_MISSING' }, texto: 'The required field was not present.' });
    }
    const nome = op.update.resourceName;
    if (recurso === 'campaigns') {
      const c = this.campanhas.get(nome.match(new RegExp(`^customers/${cliente}/campaigns/(\\d+)$`))?.[1] ?? '');
      if (!c || c.cliente !== cliente) return this.erro(400, 'INVALID_ARGUMENT', 'Request contains an invalid argument.', { codigo: { mutateError: 'RESOURCE_NOT_FOUND' }, texto: 'Resource was not found.' });
      if (op.updateMask !== 'status' || (op.update.status !== 'ENABLED' && op.update.status !== 'PAUSED')) {
        return this.erro(400, 'INVALID_ARGUMENT', 'Request contains an invalid argument.', { codigo: { fieldMaskError: 'FIELD_NOT_FOUND' }, texto: 'The field mask contained an invalid field.' });
      }
      if (c.status === 'REMOVED') return this.erro(400, 'INVALID_ARGUMENT', 'Request contains an invalid argument.', { codigo: { campaignError: 'CANNOT_MODIFY_REMOVED_CAMPAIGN' }, texto: 'Cannot modify a removed campaign.' });
      if (chamada.tipo === 'validacao') return { status: 200, corpo: {} };
      c.status = op.update.status;
      c.primaryStatus = c.status === 'PAUSED' ? 'PAUSED' : 'ELIGIBLE';
      return { status: 200, corpo: { results: [{ resourceName: nome }] } };
    }
    const o = this.orcamentos.get(nome.match(new RegExp(`^customers/${cliente}/campaignBudgets/(\\d+)$`))?.[1] ?? '');
    if (!o || o.cliente !== cliente) return this.erro(400, 'INVALID_ARGUMENT', 'Request contains an invalid argument.', { codigo: { mutateError: 'RESOURCE_NOT_FOUND' }, texto: 'Resource was not found.' });
    // A máscara vai em snake_case; o campo, em camelCase.
    if (op.updateMask !== 'amount_micros' || !/^\d+$/.test(String(op.update.amountMicros ?? ''))) {
      return this.erro(400, 'INVALID_ARGUMENT', 'Request contains an invalid argument.', { codigo: { fieldMaskError: 'FIELD_NOT_FOUND' }, texto: 'The field mask contained an invalid field.' });
    }
    const valor = Number(op.update.amountMicros);
    if (valor > 5_000_000_000) return this.erro(400, 'INVALID_ARGUMENT', 'Request contains an invalid argument.', { codigo: { campaignBudgetError: 'MONEY_AMOUNT_TOO_LARGE' }, texto: 'A money amount was greater than the maximum allowed.' });
    if (chamada.tipo === 'validacao') return { status: 200, corpo: {} };
    o.amountMicros = valor;
    return { status: 200, corpo: { results: [{ resourceName: nome }] } };
  }
}

export type EmpresaComGoogle = { cookie: string; tenantId: string; userId: string; brandId: string; conta: string; cliente: string; gerente: string; /** O segredo do app autenticador do dono, para aprovar com o código. */ secret: string };

/** Uma empresa nova com uma conta do Google Ads conectada (em reais), com a autorização no cofre e o dono com o app autenticador. */
export async function empresaComGoogle(api: TestApi, database: Database, opcoes: { refresh?: string; nome?: string } = {}): Promise<EmpresaComGoogle> {
  await resetIpRateLimits();
  const s = await signupAndLogin(api, undefined, opcoes.nome ?? 'Hamburgueria do Google');
  const { secret } = await enableMfa(api, s.cookie);
  const tenantId = s.me.active_organization_id as string;
  const brandId = (await ownerQuery<{ id: string }>(`select id from liame.brand where tenant_id = $1 limit 1`, [tenantId]))[0]!.id;
  const conta = randomUUID();
  const [cliente, gerente] = [numero(), numero()];
  const segredo = await withTenant(database.db, tenantId, (tx) =>
    api.app.get(VaultService).putSecret(tx, {
      tenantId,
      purpose: 'oauth_google',
      plaintext: JSON.stringify({
        tipo: 'google',
        refresh_token: opcoes.refresh ?? REFRESH_DO_GOOGLE,
        escopos: ['https://www.googleapis.com/auth/adwords', 'https://www.googleapis.com/auth/analytics.readonly'],
        obtido_em: new Date().toISOString(),
        refresh_expira_em: null,
      }),
    }),
  );
  await ownerQuery(
    `insert into liame.connected_account (id, tenant_id, brand_id, provider, external_id, name, currency, timezone, credential_secret_id, provider_attributes)
     values ($1, $2, $3, 'google_ads', $4, 'Hamburgueria Ads', 'BRL', $5, $6, $7::jsonb)`,
    [conta, tenantId, brandId, cliente, FUSO, segredo, JSON.stringify({ login_customer_id: gerente })],
  );
  return { cookie: s.cookie, tenantId, userId: s.me.user.id as string, brandId, conta, cliente, gerente, secret };
}

/** Põe a campanha na lista que o Liame leu da conta (sem isso, o conector não a reconhece). */
export async function campanhaLida(e: EmpresaComGoogle, c: CampanhaNoGoogle, conta = e.conta): Promise<string> {
  const id = randomUUID();
  await ownerQuery(
    `insert into liame.campaign (id, tenant_id, connected_account_id, provider, external_id, name, status, last_seen_at)
     values ($1, $2, $3, 'google_ads', $4, $5, 'ativa', now() - interval '6 hours')`,
    [id, e.tenantId, conta, c.id, c.name],
  );
  return id;
}
