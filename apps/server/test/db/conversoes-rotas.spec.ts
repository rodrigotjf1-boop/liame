import { createHash, randomInt, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { GoogleConversionActionsResponse, type GoogleConversionAccount, GoogleConversionsResponse } from '@liame/contracts';
import { createDatabase, type Database, runMigrations, withTenant } from '@liame/database';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { atribuirPedidos } from '../../src/attribution/motor.js';
import { gravarToques } from '../../src/attribution/toque-store.js';
import { ESCOPO_DATA_MANAGER } from '../../src/connectors/google-ads/data-manager.js';
import { ESPERA_ANTES_DE_INFORMAR_MIN, FLAG_CONVERSOES_GOOGLE } from '../../src/conversoes/conversoes-google.js';
import { FlagService } from '../../src/flags/flag.service.js';
import { centavosParaMicros, gravarPedidos } from '../../src/orders/order-store.js';
import { VaultService } from '../../src/vault/vault.service.js';
import { enableMfa, ownerQuery, PASSWORD, resetIpRateLimits, signupAndLogin, startApi, TERMOS, type TestApi, tokenFrom, uniqueEmail } from '../helpers/api.js';
import { APP_URL, hasDb, OWNER_URL } from './env.js';

// A5 · Y1 pelas rotas (o que a tela do protótipo P14 vai ler), contra um "Google" local: o OAuth e a Google Ads API
// (`searchStream`). `GET /v1/conversions/google` diz a situação de cada conta do Google Ads da marca;
// `GET …/actions` lê no Google as conversões da conta; `PUT …/destination` escolhe, troca ou retoma;
// `POST …/destination/stop` para. Nada aqui informa venda: quem envia é a rotina do worker (`conversoes-google.spec.ts`).

const FUSO = 'America/Sao_Paulo';
const ACESSO = 'acesso-de-teste-google';
const LEITURA = ['https://www.googleapis.com/auth/adwords', 'https://www.googleapis.com/auth/analytics.readonly'];
const PRINCIPAL = { id: '987654321', name: 'Pedido confirmado no caixa' };
const ANTIGA = { id: '912345678', name: 'Vendas importadas (antiga)' };
const MIN = 60_000;

type Consulta = { cliente: string; query: string; autorizacao: string | undefined; gerente: string | undefined };
type Modo = 'normal' | 'vazia' | 'fora_do_ar' | 'negada';

/** O que o Google devolve à consulta de conversões: duas que valem e duas que a consulta já devia ter deixado de fora. */
const DO_GOOGLE = [
  { conversionAction: { resourceName: 'customers/1/conversionActions/912345678', id: ANTIGA.id, name: ANTIGA.name, status: 'ENABLED', type: 'UPLOAD_CLICKS', category: 'PURCHASE', primaryForGoal: false } },
  { conversionAction: { resourceName: 'customers/1/conversionActions/987654321', id: PRINCIPAL.id, name: PRINCIPAL.name, status: 'ENABLED', type: 'UPLOAD_CLICKS', category: 'PURCHASE', primaryForGoal: true } },
  { conversionAction: { resourceName: 'customers/1/conversionActions/555000111', id: '555000111', name: 'Compra no site', status: 'ENABLED', type: 'WEBPAGE', category: 'PURCHASE', primaryForGoal: true } },
  { conversionAction: { resourceName: 'customers/1/conversionActions/555000222', id: '555000222', name: 'A que foi removida', status: 'REMOVED', type: 'UPLOAD_CLICKS', category: 'PURCHASE', primaryForGoal: false } },
];

describe.skipIf(!hasDb)('conversões para o Google pelas rotas: ver, escolher e parar (A5, Y1)', () => {
  let api: TestApi;
  let database: Database;
  let google: Server;
  let base = '';
  let flags: FlagService;
  const anterior: Record<string, string | undefined> = {};
  const consultas: Consulta[] = [];
  const modos = new Map<string, Modo>();
  let renovacoes = 0;

  function responder(req: IncomingMessage, texto: string): { status: number; corpo: unknown } {
    const url = new URL(req.url ?? '/', base);
    if (url.pathname === '/oauth/token') {
      renovacoes += 1;
      return { status: 200, corpo: { access_token: ACESSO, expires_in: 3599, token_type: 'Bearer' } };
    }
    const m = url.pathname.match(/^\/ads\/v25\/customers\/(\d+)\/googleAds:searchStream$/);
    if (!m || req.method !== 'POST') return { status: 404, corpo: { error: { code: 404, status: 'NOT_FOUND', message: url.pathname } } };
    const cliente = m[1]!;
    const gerente = req.headers['login-customer-id'];
    consultas.push({ cliente, query: (JSON.parse(texto) as { query: string }).query, autorizacao: req.headers.authorization, gerente: Array.isArray(gerente) ? gerente[0] : gerente });
    if (req.headers.authorization !== `Bearer ${ACESSO}`) return { status: 401, corpo: { error: { code: 401, status: 'UNAUTHENTICATED', message: 'Request had invalid authentication credentials.' } } };
    const modo = modos.get(cliente) ?? 'normal';
    if (modo === 'fora_do_ar') return { status: 503, corpo: { error: { code: 503, status: 'UNAVAILABLE', message: 'The service is currently unavailable.' } } };
    if (modo === 'negada') return { status: 403, corpo: { error: { code: 403, status: 'PERMISSION_DENIED', message: 'The caller does not have permission' } } };
    return { status: 200, corpo: modo === 'vazia' ? [] : [{ results: DO_GOOGLE, fieldMask: 'conversionAction.id,conversionAction.name', requestId: 'req-lista' }] };
  }

  type Empresa = { cookie: string; tenantId: string; userId: string; brandId: string; conta: string; cliente: string; gerente: string; unitId: string; loja: string; campanhaExterna: string };

  /** Uma empresa com uma conta do Google Ads ligada por uma autorização do Google. `escopo: false`: a autorização só lê. */
  async function empresa(opcoes: { flag?: boolean; escopo?: boolean } = {}): Promise<Empresa> {
    await resetIpRateLimits();
    const s = await signupAndLogin(api, undefined, 'Hamburgueria das Rotas');
    await enableMfa(api, s.cookie);
    const tenantId = s.me.active_organization_id as string;
    const userId = s.me.user.id as string;
    const brandId = (await ownerQuery<{ id: string }>(`select id from liame.brand where tenant_id = $1 limit 1`, [tenantId]))[0]!.id;
    const [conta, conexao, unitId, loja, campanha] = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    const cliente = String(randomInt(1_000_000_000, 9_999_999_999));
    const gerente = String(randomInt(1_000_000_000, 9_999_999_999));
    const campanhaExterna = String(randomInt(10_000_000, 99_999_999));
    const escopos = [...LEITURA, ...(opcoes.escopo === false ? [] : [ESCOPO_DATA_MANAGER])];
    const segredo = await withTenant(database.db, tenantId, (tx) =>
      api.app.get(VaultService).putSecret(tx, {
        tenantId,
        purpose: 'oauth_google',
        plaintext: JSON.stringify({ tipo: 'google', refresh_token: 'refresh-de-teste', escopos, obtido_em: new Date().toISOString(), refresh_expira_em: null }),
      }),
    );
    await ownerQuery(
      `insert into liame.oauth_connection (id, tenant_id, brand_id, provider, status, state_hash, redirect_uri, expires_at, completed_at, credential_secret_id, scopes)
       values ($1, $2, $3, 'google', 'ativa', $4, 'https://api.example/v1/oauth/callback', now() + interval '10 minutes', now(), $5, $6::text[])`,
      [conexao, tenantId, brandId, createHash('sha256').update(conexao).digest('hex'), segredo, escopos],
    );
    await ownerQuery(
      `insert into liame.connected_account (id, tenant_id, brand_id, provider, external_id, name, currency, timezone, credential_secret_id, connection_id, provider_attributes)
       values ($1, $2, $3, 'google_ads', $4, 'Hamburgueria Ads', 'BRL', $5, $6, $7, $8::jsonb)`,
      [conta, tenantId, brandId, cliente, FUSO, segredo, conexao, JSON.stringify({ login_customer_id: gerente })],
    );
    // A loja do Regem (de onde vêm os pedidos) e uma campanha da conta do Google, para as vendas atribuídas.
    await ownerQuery(`insert into liame.unit (id, tenant_id, brand_id, name, timezone) values ($1, $2, $3, 'Loja Centro', $4)`, [unitId, tenantId, brandId, FUSO]);
    await ownerQuery(
      `insert into liame.connected_account (id, tenant_id, brand_id, unit_id, provider, external_id, name, currency, timezone) values ($1, $2, $3, $4, 'regem', $5, 'Loja Centro (Regem)', 'BRL', $6)`,
      [loja, tenantId, brandId, unitId, randomUUID(), FUSO],
    );
    await ownerQuery(`insert into liame.campaign (id, tenant_id, connected_account_id, provider, external_id, name, status) values ($1, $2, $3, 'google_ads', $4, 'Busca hambúrguer perto', 'ativa')`, [
      campanha,
      tenantId,
      conta,
      campanhaExterna,
    ]);
    if (opcoes.flag !== false) await ligar(tenantId);
    return { cookie: s.cookie, tenantId, userId, brandId, conta, cliente, gerente, unitId, loja, campanhaExterna };
  }

  async function ligar(tenantId: string): Promise<void> {
    await ownerQuery(`insert into liame.feature_flag_rule (id, flag_key, scope_type, scope_id, value, created_by) values (gen_random_uuid(), $1, 'tenant', $2, 'true'::jsonb, 'testes')`, [FLAG_CONVERSOES_GOOGLE, tenantId]);
    flags.invalidate();
  }

  async function membro(e: Empresa, role: string): Promise<{ cookie: string }> {
    const email = uniqueEmail(role);
    expect((await api.call('POST', '/v1/invitations', { cookie: e.cookie, body: { email, role } })).status).toBe(201);
    const s = await api.call('POST', '/v1/invitations/signup', { body: { token: tokenFrom(api.mailer, email), name: `Pessoa ${role}`, password: PASSWORD, terms_version: TERMOS } });
    if (!s.cookie) throw new Error(`convite não aceito: ${s.status} ${JSON.stringify(s.body)}`);
    await enableMfa(api, s.cookie);
    return { cookie: s.cookie };
  }

  /** Um pedido confirmado há `haMin` minutos. `clique`: de um anúncio da conta do Google (com o id do clique) ou nenhum. */
  async function vender(e: Empresa, haMin: number, clique: 'google' | 'nenhum' = 'nenhum'): Promise<string> {
    const externo = `p-${randomUUID().slice(0, 12)}`;
    const confirmadoEm = new Date(Date.now() - haMin * MIN).toISOString();
    return withTenant(database.db, e.tenantId, async (tx) => {
      if (clique === 'google') {
        await gravarToques(tx, { tenantId: e.tenantId, brandId: e.brandId, connectedAccountId: e.loja }, [
          {
            externalId: `t-${externo}`,
            kind: 'clique',
            occurredAt: new Date(Date.now() - (haMin + 60) * MIN).toISOString(),
            orderExternalId: externo,
            gclid: `Cj0KCQjw${randomUUID().replaceAll('-', '')}AbCdEfGh`,
            provider: 'google_ads',
            campaignExternalId: e.campanhaExterna,
          },
        ]);
      }
      await gravarPedidos(tx, { tenantId: e.tenantId, brandId: e.brandId, unitId: e.unitId, connectedAccountId: e.loja, provider: 'regem' }, [
        {
          externalId: externo,
          channel: 'cardapio',
          channelGroup: 'cardapio',
          status: 'confirmado',
          currency: 'BRL',
          timezone: FUSO,
          revenueMicros: centavosParaMicros(3490),
          discountMicros: 0n,
          refundedMicros: 0n,
          couponCode: null,
          customer: null,
          isNewCustomer: null,
          placedAt: null,
          confirmedAt: confirmadoEm,
          cancelledAt: null,
          version: 1n,
          sourceUpdatedAt: confirmadoEm,
          items: [{ externalId: 'i1', name: 'Combo', quantity: '1', revenueMicros: centavosParaMicros(3490), costMicros: centavosParaMicros(1500) }],
        },
      ]);
      const achado = await tx.execute<{ id: string }>(sql`select id from liame.order_fact where connected_account_id = ${e.loja} and external_id = ${externo}`);
      const id = achado.rows[0]!.id;
      await atribuirPedidos(tx, { tenantId: e.tenantId, orderIds: [id], gatilho: 'pedidos' });
      return id;
    });
  }

  /** Uma linha de envio como a rotina a deixaria, na situação dada. */
  async function envio(e: Empresa, status: string, extra: { motivo?: string; correcoes?: number; acao?: string } = {}): Promise<string> {
    const pedido = await vender(e, 300);
    await ownerQuery(
      `insert into liame.conversion_upload (id, tenant_id, brand_id, order_id, connected_account_id, conversion_action_id, touchpoint_id, click_kind, status, value_micros, currency, event_at, last_error, corrections)
       values (gen_random_uuid(), $1, $2, $3, $4, $5, gen_random_uuid(), 'gclid', $6, 34900000, 'BRL', now() - interval '5 hours', $7, $8)`,
      [e.tenantId, e.brandId, pedido, e.conta, extra.acao ?? PRINCIPAL.id, status, extra.motivo ?? null, extra.correcoes ?? 0],
    );
    return pedido;
  }

  const ver = (e: Empresa, cookie = e.cookie) => api.call('GET', `/v1/conversions/google?brand_id=${e.brandId}`, { cookie });
  const conta = async (e: Empresa, cookie = e.cookie): Promise<GoogleConversionAccount> => {
    const r = await ver(e, cookie);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const lida = GoogleConversionsResponse.parse(r.body);
    expect(lida.accounts).toHaveLength(1);
    return lida.accounts[0]!;
  };
  const acoes = (e: Empresa, contaId = e.conta, cookie = e.cookie) => api.call('GET', `/v1/conversions/google/actions?connected_account_id=${contaId}`, { cookie });
  const escolher = (e: Empresa, acao: string, contaId = e.conta, cookie = e.cookie) =>
    api.call('PUT', '/v1/conversions/google/destination', { cookie, body: { connected_account_id: contaId, conversion_action_id: acao } });
  const parar = (e: Empresa, contaId = e.conta, cookie = e.cookie) => api.call('POST', '/v1/conversions/google/destination/stop', { cookie, body: { connected_account_id: contaId } });
  const destino = async (e: Empresa) =>
    (
      await ownerQuery<{ conversion_action_id: string; conversion_action_name: string; starts_at: Date; stopped_at: Date | null; set_by: string | null; stopped_by: string | null; next_run_at: Date; failures: number }>(
        `select conversion_action_id, conversion_action_name, starts_at, stopped_at, set_by, stopped_by, next_run_at, failures from liame.conversion_destination where connected_account_id = $1`,
        [e.conta],
      )
    )[0];
  const auditoria = (e: Empresa, acao: string) =>
    ownerQuery<{ resource_id: string; actor_id: string; before: unknown; after: unknown }>(
      `select resource_id, actor_id, before, after from liame.audit_event where tenant_id = $1 and action = $2 order by chain_seq`,
      [e.tenantId, acao],
    );
  const situacoes = (e: Empresa) => ownerQuery<{ status: string; last_error: string | null }>(`select status, last_error from liame.conversion_upload where connected_account_id = $1 order by status`, [e.conta]);
  const doCliente = (e: Empresa) => consultas.filter((c) => c.cliente === e.cliente);

  beforeAll(async () => {
    await runMigrations({ connectionString: OWNER_URL, dir: resolve(process.cwd(), '../../packages/database/migrations') });
    google = createServer((req, res) => {
      let texto = '';
      req.on('data', (d: Buffer) => (texto += d.toString('utf8')));
      req.on('end', () => {
        const r = responder(req, texto);
        res.writeHead(r.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(r.corpo));
      });
    });
    await new Promise<void>((ok) => google.listen(0, '127.0.0.1', ok));
    base = `http://127.0.0.1:${(google.address() as AddressInfo).port}`;
    const ambiente = {
      GOOGLE_OAUTH_CLIENT_ID: 'cliente-de-teste.apps.googleusercontent.com',
      GOOGLE_OAUTH_CLIENT_SECRET: 'segredo-do-cliente-de-teste',
      GOOGLE_AUTH_URL: `${base}/google`,
      GOOGLE_TOKEN_URL: `${base}/oauth`,
      GOOGLE_ADS_URL: `${base}/ads`,
    };
    for (const k of Object.keys(ambiente)) anterior[k] = process.env[k];
    Object.assign(process.env, ambiente);
    api = await startApi();
    database = createDatabase({ connectionString: APP_URL, max: 4, applicationName: 'liame-test' });
    flags = api.app.get(FlagService);
  }, 120_000);
  beforeEach(() => {
    consultas.length = 0;
    renovacoes = 0;
  });
  afterAll(async () => {
    await api?.close();
    await database?.close();
    await new Promise((ok) => google?.close(ok));
    for (const [k, v] of Object.entries(anterior)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('com a função desligada, a tela é a de sempre: nenhuma conta, e ler ou escolher é recusado sem falar com o Google', async () => {
    const e = await empresa({ flag: false });
    const r = await ver(e);
    expect(r.status).toBe(200);
    expect(GoogleConversionsResponse.parse(r.body)).toEqual({ brand_id: e.brandId, enabled: false, can_manage: true, wait_minutes: ESPERA_ANTES_DE_INFORMAR_MIN, window_days: 30, accounts: [] });

    const lista = await acoes(e);
    expect(lista.status).toBe(409);
    expect(lista.body.code).toBe('conversoes-desligadas');
    const escolha = await escolher(e, PRINCIPAL.id);
    expect(escolha.status).toBe(409);
    expect(escolha.body.code).toBe('conversoes-desligadas');
    expect(doCliente(e)).toHaveLength(0);
    expect(renovacoes).toBe(0);
    expect(await destino(e)).toBeUndefined();

    // Sem a função, a autorização do Google pede só a leitura, como antes.
    const inicio = await api.call('POST', '/v1/connections', { cookie: e.cookie, body: { provider: 'google', brand_id: e.brandId } });
    expect(inicio.status, JSON.stringify(inicio.body)).toBe(201);
    expect(new URL(inicio.body.authorize_url).searchParams.get('scope')).toBe(LEITURA.join(' '));
  });

  it('sem a permissão de informar vendas, a conta pede para autorizar o Google de novo, e a autorização nova pede a permissão', async () => {
    const e = await empresa({ escopo: false });
    const c = await conta(e);
    expect(c).toMatchObject({ connected_account_id: e.conta, name: 'Hamburgueria Ads', external_id: e.cliente, authorized: false, destination: null, status: 'sem_permissao', next_run_at: null, last_failure: null });
    expect(c.counts).toEqual({ informed: 0, waiting: 0, corrected: 0, refused: 0 });

    const lista = await acoes(e);
    expect(lista.status).toBe(409);
    expect(lista.body.code).toBe('google-sem-permissao');
    expect((await escolher(e, PRINCIPAL.id)).body.code).toBe('google-sem-permissao');
    expect(doCliente(e)).toHaveLength(0);
    expect(await destino(e)).toBeUndefined();

    // Com a função ligada, autorizar o Google de novo pede a leitura E a permissão de informar vendas.
    const inicio = await api.call('POST', '/v1/connections', { cookie: e.cookie, body: { provider: 'google', brand_id: e.brandId } });
    expect(inicio.status, JSON.stringify(inicio.body)).toBe(201);
    expect(new URL(inicio.body.authorize_url).searchParams.get('scope')).toBe([...LEITURA, ESCOPO_DATA_MANAGER].join(' '));
    const [evento] = await ownerQuery<{ after: Record<string, unknown> }>(`select after from liame.audit_event where tenant_id = $1 and resource_id = $2`, [e.tenantId, inicio.body.id]);
    expect(evento!.after).toMatchObject({ provider: 'google', informar_vendas: true });
  });

  it('a lista de conversões vem do Google na hora: só as ativas que recebem venda por clique, por nome, pela conta gerente', async () => {
    const e = await empresa();
    expect(await conta(e)).toMatchObject({ authorized: true, destination: null, status: 'sem_destino' });

    const r = await acoes(e);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(GoogleConversionActionsResponse.parse(r.body)).toEqual({
      connected_account_id: e.conta,
      items: [
        { id: PRINCIPAL.id, name: PRINCIPAL.name, category: 'PURCHASE', primary: true },
        { id: ANTIGA.id, name: ANTIGA.name, category: 'PURCHASE', primary: false },
      ],
    });
    // Uma consulta, com o token curto, pela conta gerente, pedindo só o tipo e a situação que servem.
    expect(renovacoes).toBe(1);
    const feitas = doCliente(e);
    expect(feitas).toHaveLength(1);
    expect(feitas[0]).toMatchObject({ autorizacao: `Bearer ${ACESSO}`, gerente: e.gerente });
    expect(feitas[0]!.query).toMatch(/FROM conversion_action WHERE conversion_action\.type = 'UPLOAD_CLICKS' AND conversion_action\.status = 'ENABLED'/);
    // Ler a lista não escolhe nada.
    expect(await destino(e)).toBeUndefined();

    // A conta sem nenhuma conversão desse tipo: a lista vem vazia (cria-se no Google Ads).
    modos.set(e.cliente, 'vazia');
    expect((await acoes(e)).body).toEqual({ connected_account_id: e.conta, items: [] });
    modos.delete(e.cliente);
  });

  it('escolher a conversão: conferida no Google, começa de agora, com quem escolheu e o evento de auditoria', async () => {
    const e = await empresa();
    // O id que o Google não lista (de outro tipo, removido ou inventado) não é aceito de olhos fechados.
    for (const errado of ['555000111', '555000222', '123']) {
      const recusa = await escolher(e, errado);
      expect(recusa.status, errado).toBe(422);
      expect(recusa.body.code).toBe('conversao-nao-encontrada');
      expect(recusa.body.errors).toEqual([{ path: 'conversion_action_id', message: 'Conversão não encontrada nesta conta.' }]);
    }
    expect(await destino(e)).toBeUndefined();
    expect(await auditoria(e, 'conversao.destino_definir')).toHaveLength(0);

    const antes = Date.now();
    const r = await escolher(e, PRINCIPAL.id);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const c = GoogleConversionsResponse.parse(r.body).accounts[0]!;
    // O nome é o que o Google tem, e não o que o cliente mandaria.
    expect(c).toMatchObject({ status: 'informando', authorized: true, team_stopped_at: null, last_failure: null, last_refusal: null });
    expect(c.destination).toMatchObject({ conversion_action_id: PRINCIPAL.id, conversion_action_name: PRINCIPAL.name, stopped_at: null, stopped_by: null, set_by: { id: e.userId, name: 'Pessoa de Teste' } });
    expect(new Date(c.destination!.starts_at).getTime()).toBeGreaterThanOrEqual(antes - 5_000);
    expect(c.counts).toEqual({ informed: 0, waiting: 0, corrected: 0, refused: 0 });
    // A conta entra na fila da rotina já.
    const gravado = (await destino(e))!;
    expect(gravado).toMatchObject({ conversion_action_id: PRINCIPAL.id, conversion_action_name: PRINCIPAL.name, set_by: e.userId, stopped_at: null, failures: 0 });
    expect(gravado.next_run_at.getTime()).toBeLessThanOrEqual(Date.now() + 5_000);
    expect(c.next_run_at).toBe(gravado.next_run_at.toISOString());
    expect(await auditoria(e, 'conversao.destino_definir')).toEqual([
      { resource_id: e.conta, actor_id: e.userId, before: null, after: { conversion_action_id: PRINCIPAL.id, conversion_action_name: PRINCIPAL.name } },
    ]);

    // Confirmar a mesma conversão, com ela informando, não muda o começo.
    expect((await escolher(e, PRINCIPAL.id)).status).toBe(200);
    expect((await destino(e))!.starts_at.getTime()).toBe(gravado.starts_at.getTime());
  });

  it('os números dos últimos 30 dias: informadas, esperando, corrigidas e recusadas, com o motivo da última recusa', async () => {
    const e = await empresa();
    expect((await escolher(e, PRINCIPAL.id)).status).toBe(200);
    // O destino começou há uma semana (o teste não espera duas horas).
    await ownerQuery(`update liame.conversion_destination set starts_at = now() - interval '7 days' where connected_account_id = $1`, [e.conta]);
    await envio(e, 'aceito');
    await envio(e, 'aceito', { correcoes: 1 });
    await envio(e, 'enviado');
    await envio(e, 'pendente');
    await envio(e, 'recusado', { motivo: 'PROCESSING_ERROR_REASON_INVALID_GCLID' });
    await envio(e, 'desistiu', { motivo: 'cancelado antes do envio' });
    // Dois pedidos que ainda não completaram as duas horas: o de um anúncio da conta espera; o sem clique não é do Google.
    await vender(e, 30, 'google');
    await vender(e, 30);

    const c = await conta(e);
    expect(c.status).toBe('informando');
    // Informadas: as duas aceitas e a que espera o resultado. Esperando: a da fila e a que ainda não completou o prazo.
    expect(c.counts).toEqual({ informed: 3, waiting: 2, corrected: 1, refused: 1 });
    expect(c.last_refusal).toMatchObject({ reason: 'PROCESSING_ERROR_REASON_INVALID_GCLID' });
  });

  it('parar e voltar: quem parou fica registrado, o que esperava a vez não sai, e voltar recomeça de agora', async () => {
    const e = await empresa();
    expect((await escolher(e, PRINCIPAL.id)).status).toBe(200);
    await ownerQuery(`update liame.conversion_destination set starts_at = now() - interval '7 days' where connected_account_id = $1`, [e.conta]);
    await envio(e, 'aceito');
    await envio(e, 'pendente');
    await vender(e, 30, 'google');
    expect((await conta(e)).counts).toMatchObject({ informed: 1, waiting: 2 });

    const r = await parar(e);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const parado = GoogleConversionsResponse.parse(r.body).accounts[0]!;
    expect(parado).toMatchObject({ status: 'parado', next_run_at: null });
    // Quem escolheu continua lá; quem parou aparece ao lado.
    expect(parado.destination).toMatchObject({ conversion_action_id: PRINCIPAL.id, set_by: { id: e.userId }, stopped_by: { id: e.userId, name: 'Pessoa de Teste' } });
    expect(parado.destination!.stopped_at).not.toBeNull();
    // O que já foi informado continua contado; nada espera a vez.
    expect(parado.counts).toMatchObject({ informed: 1, waiting: 0 });
    expect(await situacoes(e)).toEqual([
      { status: 'aceito', last_error: null },
      { status: 'desistiu', last_error: 'parado por uma pessoa antes do envio' },
    ]);
    expect(await auditoria(e, 'conversao.destino_parar')).toEqual([{ resource_id: e.conta, actor_id: e.userId, before: { parado: false }, after: { parado: true } }]);

    // Parar o que já está parado não muda a hora da parada.
    const quando = (await destino(e))!.stopped_at!.getTime();
    expect((await parar(e)).status).toBe(200);
    expect((await destino(e))!.stopped_at!.getTime()).toBe(quando);

    // Voltar é escolher de novo: recomeça de agora (o pedido de meia hora atrás não entra), sem parada.
    const antes = Date.now();
    const volta = await escolher(e, PRINCIPAL.id);
    expect(volta.status, JSON.stringify(volta.body)).toBe(200);
    const c = GoogleConversionsResponse.parse(volta.body).accounts[0]!;
    expect(c).toMatchObject({ status: 'informando' });
    expect(c.destination).toMatchObject({ stopped_at: null, stopped_by: null });
    expect(new Date(c.destination!.starts_at).getTime()).toBeGreaterThanOrEqual(antes - 5_000);
    expect(c.counts).toMatchObject({ informed: 1, waiting: 0 });
    expect((await auditoria(e, 'conversao.destino_definir')).at(-1)).toMatchObject({ before: { conversion_action_id: PRINCIPAL.id, parado: true } });
  });

  it('trocar a conversão: o que esperava a vez para a antiga não vai para a nova, e o que já saiu continua contado', async () => {
    const e = await empresa();
    expect((await escolher(e, ANTIGA.id)).status).toBe(200);
    await envio(e, 'enviado', { acao: ANTIGA.id });
    await envio(e, 'pendente', { acao: ANTIGA.id });
    const comeco = (await destino(e))!.starts_at.getTime();

    const r = await escolher(e, PRINCIPAL.id);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const c = GoogleConversionsResponse.parse(r.body).accounts[0]!;
    expect(c.destination).toMatchObject({ conversion_action_id: PRINCIPAL.id, conversion_action_name: PRINCIPAL.name });
    expect(c.counts).toMatchObject({ informed: 1, waiting: 0 });
    expect(await situacoes(e)).toEqual([
      { status: 'desistiu', last_error: 'a conversão da conta foi trocada' },
      { status: 'enviado', last_error: null },
    ]);
    expect((await destino(e))!.starts_at.getTime()).toBeGreaterThanOrEqual(comeco);
    expect((await auditoria(e, 'conversao.destino_definir')).at(-1)).toMatchObject({
      before: { conversion_action_id: ANTIGA.id, parado: false },
      after: { conversion_action_id: PRINCIPAL.id, conversion_action_name: PRINCIPAL.name },
    });
  });

  it('a parada da empresa aparece na conta; a falha da passagem separa "esperar" de "falta a permissão"', async () => {
    const e = await empresa();
    expect((await escolher(e, PRINCIPAL.id)).status).toBe(200);
    const marcar = (tipo: string | null, texto: string | null, falhas: number) =>
      ownerQuery(`update liame.conversion_destination set last_error = $2, last_error_kind = $3, failures = $4, last_run_at = now(), next_run_at = now() + interval '25 minutes' where connected_account_id = $1`, [e.conta, texto, tipo, falhas]);

    // O Google pediu para esperar: a conta volta sozinha, e a tela sabe quando.
    await marcar('esperar', '429: Quota exceeded for quota metric', 1);
    let c = await conta(e);
    expect(c).toMatchObject({ status: 'esperando_a_plataforma', last_failure: { reason: '429: Quota exceeded for quota metric' } });
    expect(new Date(c.next_run_at!).getTime()).toBeGreaterThan(Date.now() + 20 * MIN);

    // O Google recusou a autorização: é autorizar de novo, mesmo com a permissão no papel.
    await marcar('permissao', 'invalid_grant: OAuth recusado (invalid_grant)', 1);
    c = await conta(e);
    expect(c).toMatchObject({ status: 'sem_permissao', authorized: true, last_failure: { reason: 'invalid_grant: OAuth recusado (invalid_grant)' } });

    // A parada da empresa pesa mais que tudo, e a tela sabe desde quando.
    await marcar(null, null, 0);
    await ownerQuery(`insert into liame.kill_switch (id, level, tenant_id, reason) values (gen_random_uuid(), 'tenant', $1, 'teste: equipe parada')`, [e.tenantId]);
    c = await conta(e);
    expect(c).toMatchObject({ status: 'equipe_parada', last_failure: null });
    expect(new Date(c.team_stopped_at!).getTime()).toBeGreaterThan(Date.now() - 60_000);
    // Com a parada, a passagem deixa o registro dela; ao retomar, a conta volta a "informando" sem esperar a rotina.
    await marcar('parada', 'parada: a empresa ou a Liame parou as ações desta conta', 0);
    await ownerQuery(`update liame.kill_switch set deactivated_at = now() where tenant_id = $1`, [e.tenantId]);
    expect(await conta(e)).toMatchObject({ status: 'informando', team_stopped_at: null, last_failure: null });
  });

  it('se o Google não responde ou recusa, nada muda e a pessoa sabe o que fazer', async () => {
    const e = await empresa();
    modos.set(e.cliente, 'fora_do_ar');
    const fora = await acoes(e);
    expect(fora.status).toBe(502);
    expect(fora.body.code).toBe('plataforma-indisponivel');
    const escolha = await escolher(e, PRINCIPAL.id);
    expect(escolha.status).toBe(502);
    expect(await destino(e)).toBeUndefined();

    modos.set(e.cliente, 'negada');
    const negada = await acoes(e);
    expect(negada.status).toBe(409);
    expect(negada.body.code).toBe('google-sem-permissao');
    expect(negada.body.detail).toContain('Autorize o Google de novo');
    expect(await destino(e)).toBeUndefined();
    expect(await auditoria(e, 'conversao.destino_definir')).toHaveLength(0);
    modos.delete(e.cliente);
  });

  it('quem só vê não escolhe nem para; a conta de outra empresa não existe', async () => {
    const e = await empresa();
    expect((await escolher(e, PRINCIPAL.id)).status).toBe(200);
    consultas.length = 0;

    const leitor = await membro(e, 'somente_leitura');
    const visto = await ver(e, leitor.cookie);
    expect(visto.status, JSON.stringify(visto.body)).toBe(200);
    expect(GoogleConversionsResponse.parse(visto.body)).toMatchObject({ enabled: true, can_manage: false, accounts: [{ status: 'informando' }] });
    expect((await acoes(e, e.conta, leitor.cookie)).status).toBe(403);
    expect((await escolher(e, ANTIGA.id, e.conta, leitor.cookie)).status).toBe(403);
    expect((await parar(e, e.conta, leitor.cookie)).status).toBe(403);
    expect((await destino(e))!).toMatchObject({ conversion_action_id: PRINCIPAL.id, stopped_at: null });

    const outra = await empresa();
    expect((await acoes(outra, e.conta)).status).toBe(404);
    expect((await escolher(outra, ANTIGA.id, e.conta)).status).toBe(404);
    expect((await parar(outra, e.conta)).status).toBe(404);
    expect((await api.call('GET', `/v1/conversions/google?brand_id=${e.brandId}`, { cookie: outra.cookie })).status).toBe(404);
    expect((await destino(e))!).toMatchObject({ conversion_action_id: PRINCIPAL.id, stopped_at: null });
    // Nenhuma dessas recusas chegou ao Google.
    expect(doCliente(e)).toHaveLength(0);
  });
});
