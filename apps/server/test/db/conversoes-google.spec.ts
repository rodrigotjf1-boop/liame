import { randomInt, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { createDatabase, type Database, runMigrations, withTenant } from '@liame/database';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { atribuirPedidos } from '../../src/attribution/motor.js';
import { gravarToques } from '../../src/attribution/toque-store.js';
import { type AppConfig, loadConfig } from '../../src/config.js';
import { ESCOPO_DATA_MANAGER } from '../../src/connectors/google-ads/data-manager.js';
import { ConversoesGoogle, ESPERA_ANTES_DE_INFORMAR_MIN, FLAG_CONVERSOES_GOOGLE, INTERVALO_CONVERSOES_MIN } from '../../src/conversoes/conversoes-google.js';
import { FlagService } from '../../src/flags/flag.service.js';
import { KillSwitchService } from '../../src/kill-switch/kill-switch.service.js';
import { centavosParaMicros, gravarPedidos, type PedidoLido } from '../../src/orders/order-store.js';
import { VaultService } from '../../src/vault/vault.service.js';
import { ConversoesLoop } from '../../src/worker/conversoes-loop.js';
import { ownerQuery, resetIpRateLimits, signupAndLogin, startApi, type TestApi } from '../helpers/api.js';
import { APP_URL, hasDb, OWNER_URL } from './env.js';

// A5 · Y1: as vendas confirmadas no caixa voltam para o Google, contra uma "Data Manager API" local. Vai o pedido que
// o Liame atribui ao Google, duas horas depois de confirmado; cada um é validado e só então enviado, uma vez; o
// resultado é lido depois; o cancelado antes de sair nunca sai, e o cancelado depois tem o valor corrigido para zero
// (a API não retira conversão). Sem a flag, sem a permissão, com a parada ou sem o destino, nada sai.

const FUSO = 'America/Sao_Paulo';
const ACAO = '987654321';
const MIN = 60_000;
const ACESSO = 'acesso-de-teste-google';

type Pedido = { metodo: string; caminho: string; autorizacao: string | undefined; corpo: Record<string, unknown> | null; requestId: string | null };
type Envio = { destinations: Array<{ operatingAccount: { accountId: string }; productDestinationId: string }>; events: Array<Record<string, unknown>>; validateOnly: boolean };

describe.skipIf(!hasDb)('conversões para o Google: a venda confirmada volta para a plataforma (A5, Y1)', () => {
  let api: TestApi;
  let database: Database;
  let plataforma: Server;
  let base = '';
  let config: AppConfig;
  let flags: FlagService;
  let passagem: ConversoesGoogle;
  let loop: ConversoesLoop;
  const pedidos: Pedido[] = [];
  /** O que a plataforma responde a cada conta (pelo id do cliente): limite de uso, ou o resultado de um envio. */
  const emLimite = new Set<string>();
  const resultados = new Map<string, Record<string, unknown>>();
  let seq = 0;

  function responder(req: IncomingMessage, texto: string): { status: number; corpo: unknown } {
    const url = new URL(req.url ?? '/', base);
    const corpo = texto && req.headers['content-type']?.includes('json') ? (JSON.parse(texto) as Record<string, unknown>) : null;
    if (url.pathname === '/oauth/token') return { status: 200, corpo: { access_token: ACESSO, expires_in: 3600, token_type: 'Bearer' } };
    const registro: Pedido = { metodo: req.method ?? 'GET', caminho: url.pathname, autorizacao: req.headers.authorization, corpo, requestId: url.searchParams.get('requestId') };
    pedidos.push(registro);
    if (req.headers.authorization !== `Bearer ${ACESSO}`) return { status: 401, corpo: { error: { code: 401, status: 'UNAUTHENTICATED', message: 'Request had invalid authentication credentials.' } } };
    if (url.pathname === '/dm/v1/events:ingest' && req.method === 'POST') {
      const envio = corpo as unknown as Envio;
      const conta = envio.destinations[0]!.operatingAccount.accountId;
      if (emLimite.has(conta)) return { status: 429, corpo: { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded for quota metric' } } };
      const gclid = String((envio.events[0]!.adIdentifiers as Record<string, string>).gclid ?? '');
      if (gclid.startsWith('RECUSAR')) return { status: 400, corpo: { error: { code: 400, status: 'INVALID_ARGUMENT', message: `Invalid value for ad_identifiers.gclid: ${gclid}` } } };
      // A validação não devolve um pedido de envio para acompanhar; o envio de verdade devolve.
      if (envio.validateOnly) return { status: 200, corpo: {} };
      const requestId = `req-${++seq}`;
      registro.requestId = requestId;
      return { status: 200, corpo: { requestId } };
    }
    if (url.pathname === '/dm/v1/requestStatus:retrieve' && req.method === 'GET') {
      const id = url.searchParams.get('requestId') ?? '';
      return { status: 200, corpo: { requestStatusPerDestination: [resultados.get(id) ?? { requestStatus: 'SUCCESS', eventsIngestionStatus: { recordCount: '1' } }] } };
    }
    return { status: 404, corpo: { error: { code: 404, status: 'NOT_FOUND', message: 'not found' } } };
  }

  type Empresa = { tenantId: string; brandId: string; unitId: string; loja: string; google: string; cliente: string; campanha: string; campanhaExterna: string };

  async function empresa(opcoes: { flag?: boolean; escopo?: boolean; destino?: boolean } = {}): Promise<Empresa> {
    await resetIpRateLimits();
    const s = await signupAndLogin(api, undefined, 'Hamburgueria das Conversões');
    const tenantId = s.me.active_organization_id as string;
    const brandId = (await ownerQuery<{ id: string }>(`select id from liame.brand where tenant_id = $1 limit 1`, [tenantId]))[0]!.id;
    const [unitId, loja, google, campanha] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    const cliente = String(randomInt(1_000_000_000, 9_999_999_999));
    const campanhaExterna = String(randomInt(10_000_000, 99_999_999));
    await ownerQuery(`insert into liame.unit (id, tenant_id, brand_id, name, timezone) values ($1, $2, $3, 'Loja Centro', $4)`, [unitId, tenantId, brandId, FUSO]);
    await ownerQuery(
      `insert into liame.connected_account (id, tenant_id, brand_id, unit_id, provider, external_id, name, currency, timezone) values ($1, $2, $3, $4, 'regem', $5, 'Loja Centro (Regem)', 'BRL', $6)`,
      [loja, tenantId, brandId, unitId, randomUUID(), FUSO],
    );
    const escopos = ['https://www.googleapis.com/auth/adwords', ...(opcoes.escopo === false ? [] : [ESCOPO_DATA_MANAGER])];
    const vault = api.app.get(VaultService);
    const segredo = await withTenant(database.db, tenantId, (tx) =>
      vault.putSecret(tx, {
        tenantId,
        purpose: 'oauth_google',
        plaintext: JSON.stringify({ tipo: 'google', refresh_token: 'refresh-de-teste', escopos, obtido_em: new Date().toISOString(), refresh_expira_em: null }),
      }),
    );
    await ownerQuery(
      `insert into liame.connected_account (id, tenant_id, brand_id, provider, external_id, name, currency, timezone, credential_secret_id)
       values ($1, $2, $3, 'google_ads', $4, 'Hamburgueria Ads', 'BRL', $5, $6)`,
      [google, tenantId, brandId, cliente, FUSO, segredo],
    );
    await ownerQuery(`insert into liame.campaign (id, tenant_id, connected_account_id, provider, external_id, name, status) values ($1, $2, $3, 'google_ads', $4, 'Busca hambúrguer perto', 'ativa')`, [
      campanha,
      tenantId,
      google,
      campanhaExterna,
    ]);
    if (opcoes.destino !== false) {
      await ownerQuery(
        `insert into liame.conversion_destination (connected_account_id, tenant_id, brand_id, conversion_action_id, conversion_action_name, starts_at)
         values ($1, $2, $3, $4, 'Pedido confirmado no caixa', now() - interval '7 days')`,
        [google, tenantId, brandId, ACAO],
      );
    }
    if (opcoes.flag !== false) {
      await ownerQuery(`insert into liame.feature_flag_rule (id, flag_key, scope_type, scope_id, value, created_by) values (gen_random_uuid(), $1, 'tenant', $2, 'true'::jsonb, 'testes')`, [FLAG_CONVERSOES_GOOGLE, tenantId]);
      flags.invalidate();
    }
    return { tenantId, brandId, unitId, loja, google, cliente, campanha, campanhaExterna };
  }

  type Venda = { id: string; externo: string; gclid: string | null };
  const agoraMenos = (min: number, ref = new Date()) => new Date(ref.getTime() - min * MIN).toISOString();

  function pedidoLido(externo: string, confirmadoEm: string, over: Partial<PedidoLido> = {}): PedidoLido {
    return {
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
      ...over,
    };
  }

  async function gravar(e: Empresa, p: PedidoLido): Promise<string> {
    return withTenant(database.db, e.tenantId, async (tx) => {
      await gravarPedidos(tx, { tenantId: e.tenantId, brandId: e.brandId, unitId: e.unitId, connectedAccountId: e.loja, provider: 'regem' }, [p]);
      // O id do pedido no Liame, pela chave da origem.
      const achado = await tx.execute<{ id: string }>(sql`select id from liame.order_fact where connected_account_id = ${e.loja} and external_id = ${p.externalId}`);
      const id = achado.rows[0]!.id;
      await atribuirPedidos(tx, { tenantId: e.tenantId, orderIds: [id], gatilho: 'pedidos' });
      return id;
    });
  }

  /** Um pedido confirmado há `haMin` minutos, com o clique de uma hora antes. `clique`: do Google (padrão), da Meta, só da plataforma ou nenhum. */
  async function vender(e: Empresa, haMin: number, opcoes: { clique?: 'google' | 'meta' | 'so_plataforma' | 'nenhum'; gclid?: string; ref?: Date } = {}): Promise<Venda> {
    const externo = `p-${randomUUID().slice(0, 12)}`;
    const confirmadoEm = agoraMenos(haMin, opcoes.ref);
    const tipo = opcoes.clique ?? 'google';
    const gclid = tipo === 'google' || tipo === 'so_plataforma' ? (opcoes.gclid ?? `Cj0KCQjw${randomUUID().replaceAll('-', '')}AbCdEfGh`) : null;
    if (tipo !== 'nenhum') {
      await withTenant(database.db, e.tenantId, (tx) =>
        gravarToques(tx, { tenantId: e.tenantId, brandId: e.brandId, connectedAccountId: e.loja }, [
          {
            externalId: `t-${externo}`,
            kind: 'clique',
            occurredAt: agoraMenos(haMin + 60, opcoes.ref),
            orderExternalId: externo,
            ...(tipo === 'meta' ? { fbclid: `IwAR-${externo}`, provider: 'meta_ads' } : { gclid, provider: 'google_ads' }),
            ...(tipo === 'google' ? { campaignExternalId: e.campanhaExterna } : {}),
          },
        ]),
      );
    }
    const id = await gravar(e, pedidoLido(externo, confirmadoEm));
    return { id, externo, gclid };
  }

  const cancelar = (e: Empresa, v: Venda, confirmadoEm: string) => gravar(e, pedidoLido(v.externo, confirmadoEm, { status: 'cancelado', cancelledAt: new Date().toISOString(), version: 2n, sourceUpdatedAt: new Date().toISOString() }));
  const devolver = (e: Empresa, v: Venda, confirmadoEm: string, centavos: number) =>
    gravar(e, pedidoLido(v.externo, confirmadoEm, { refundedMicros: centavosParaMicros(centavos), version: 3n, sourceUpdatedAt: new Date().toISOString() }));

  type Linha = { status: string; value_micros: string; request_id: string | null; attempts: number; last_error: string | null; correction_status: string | null; correction_value_micros: string | null; corrections: number; click_kind: string };
  const linha = async (e: Empresa, v: Venda): Promise<Linha | undefined> =>
    (await ownerQuery<Linha>(`select status, value_micros::text, request_id, attempts, last_error, correction_status, correction_value_micros::text, corrections, click_kind from liame.conversion_upload where order_id = $1 and connected_account_id = $2`, [v.id, e.google]))[0];
  const destinoDe = async (e: Empresa) =>
    (await ownerQuery<{ last_error: string | null; failures: number; last_ok_at: Date | null; next_run_at: Date }>(`select last_error, failures, last_ok_at, next_run_at from liame.conversion_destination where connected_account_id = $1`, [e.google]))[0]!;
  /** Os envios (validação e de verdade) que a plataforma recebeu para a conta da empresa. */
  const envios = (e: Empresa) => pedidos.filter((p) => p.caminho === '/dm/v1/events:ingest' && (p.corpo as unknown as Envio).destinations[0]!.operatingAccount.accountId === e.cliente).map((p) => p.corpo as unknown as Envio);
  const doPedido = (e: Empresa, v: Venda) => envios(e).filter((x) => x.events[0]!.transactionId === v.id);
  const passar = (e: Empresa, agora = new Date()) => passagem.executar(e.google, e.tenantId, agora);

  beforeAll(async () => {
    await runMigrations({ connectionString: OWNER_URL, dir: resolve(process.cwd(), '../../packages/database/migrations') });
    plataforma = createServer((req, res) => {
      let texto = '';
      req.on('data', (d) => (texto += d));
      req.on('end', () => {
        const r = responder(req, texto);
        res.writeHead(r.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(r.corpo));
      });
    });
    await new Promise<void>((ok) => plataforma.listen(0, '127.0.0.1', ok));
    base = `http://127.0.0.1:${(plataforma.address() as AddressInfo).port}`;
    api = await startApi();
    database = createDatabase({ connectionString: APP_URL, max: 4, applicationName: 'liame-test' });
    config = loadConfig({
      ...process.env,
      NODE_ENV: 'test',
      GOOGLE_DATA_MANAGER_URL: `${base}/dm`,
      GOOGLE_TOKEN_URL: `${base}/oauth`,
      GOOGLE_OAUTH_CLIENT_ID: 'cliente-de-teste.apps.googleusercontent.com',
      GOOGLE_OAUTH_CLIENT_SECRET: 'segredo-do-cliente-de-teste',
    });
    flags = api.app.get(FlagService);
    passagem = new ConversoesGoogle(database.db, api.app.get(VaultService), config, flags, api.app.get(KillSwitchService));
    loop = new ConversoesLoop(database, config, api.app.get(VaultService), flags, api.app.get(KillSwitchService));
  }, 120_000);
  beforeEach(() => {
    pedidos.length = 0;
  });
  afterAll(async () => {
    await api?.close();
    await database?.close();
    await new Promise((ok) => plataforma?.close(ok));
  });

  it('o pedido confirmado há duas horas é validado e enviado uma vez, só com o clique, o instante, o valor e o id; o resultado é lido depois', async () => {
    const e = await empresa();
    const agora = new Date();
    const antigo = await vender(e, ESPERA_ANTES_DE_INFORMAR_MIN + 60, { ref: agora });
    const recente = await vender(e, 30, { ref: agora });

    const primeira = await passar(e, agora);
    expect(primeira).toMatchObject({ status: 'ok', novos: 1, enviados: 1, aceitos: 0, recusados: 0, desistiu: 0 });
    // Primeiro a validação, depois o envio de verdade: o mesmo corpo, só o `validateOnly` muda.
    const mandados = doPedido(e, antigo);
    expect(mandados.map((x) => x.validateOnly)).toEqual([true, false]);
    expect(mandados[1]).toEqual({
      destinations: [{ operatingAccount: { accountType: 'GOOGLE_ADS', accountId: e.cliente }, productDestinationId: ACAO }],
      events: [
        {
          transactionId: antigo.id,
          eventTimestamp: agoraMenos(ESPERA_ANTES_DE_INFORMAR_MIN + 60, agora),
          eventSource: 'WEB',
          adIdentifiers: { gclid: antigo.gclid },
          conversionValue: 34.9,
          currency: 'BRL',
        },
      ],
      validateOnly: false,
    });
    expect(pedidos.every((p) => p.autorizacao === `Bearer ${ACESSO}`)).toBe(true);
    expect(await linha(e, antigo)).toMatchObject({ status: 'enviado', value_micros: '34900000', attempts: 1, last_error: null, click_kind: 'gclid', request_id: expect.stringMatching(/^req-\d+$/) });
    // O pedido de meia hora atrás ainda espera: nem entrou na fila.
    expect(await linha(e, recente)).toBeUndefined();
    expect(doPedido(e, recente)).toHaveLength(0);

    // A passagem seguinte lê o resultado e não manda nada de novo.
    pedidos.length = 0;
    const segunda = await passar(e, agora);
    expect(segunda).toMatchObject({ status: 'ok', novos: 0, enviados: 0, aceitos: 1 });
    expect(envios(e)).toHaveLength(0);
    expect(pedidos.filter((p) => p.caminho === '/dm/v1/requestStatus:retrieve').map((p) => p.requestId)).toEqual([(await linha(e, antigo))!.request_id]);
    expect(await linha(e, antigo)).toMatchObject({ status: 'aceito' });
    const d = await destinoDe(e);
    expect(d).toMatchObject({ last_error: null, failures: 0 });
    expect(d.last_ok_at).not.toBeNull();
    expect(Math.round((new Date(d.next_run_at).getTime() - agora.getTime()) / MIN)).toBe(INTERVALO_CONVERSOES_MIN);

    // Duas horas depois, o outro pedido sai; o primeiro não sai de novo.
    pedidos.length = 0;
    const depois = new Date(agora.getTime() + ESPERA_ANTES_DE_INFORMAR_MIN * MIN);
    expect(await passar(e, depois)).toMatchObject({ novos: 1, enviados: 1 });
    expect(doPedido(e, recente).map((x) => x.validateOnly)).toEqual([true, false]);
    expect(doPedido(e, antigo)).toHaveLength(0);
    expect(await passar(e, depois)).toMatchObject({ novos: 0, enviados: 0, aceitos: 1 });
  });

  it('só vai o que o Liame atribui ao Google: pedido da Meta, sem clique e de antes do começo ficam fora; o clique só com a plataforma vai para a única conta com destino', async () => {
    const e = await empresa();
    const agora = new Date();
    const daMeta = await vender(e, 200, { clique: 'meta', ref: agora });
    const semClique = await vender(e, 200, { clique: 'nenhum', ref: agora });
    const soPlataforma = await vender(e, 200, { clique: 'so_plataforma', ref: agora });
    // O destino passou a valer há 230 minutos: o pedido confirmado antes disso não entra (não há carga do passado).
    await ownerQuery(`update liame.conversion_destination set starts_at = $2 where connected_account_id = $1`, [e.google, agoraMenos(230, agora)]);
    const deAntes = await vender(e, 240, { ref: agora });

    const r = await passar(e, agora);
    expect(r).toMatchObject({ status: 'ok', novos: 1, enviados: 1 });
    expect(await linha(e, soPlataforma)).toMatchObject({ status: 'enviado' });
    for (const v of [daMeta, semClique, deAntes]) expect(await linha(e, v)).toBeUndefined();
    expect(envios(e).filter((x) => !x.validateOnly).map((x) => x.events[0]!.transactionId)).toEqual([soPlataforma.id]);
  });

  it('cancelado antes de sair nunca é informado; cancelado depois de aceito tem o valor zerado; a devolução corrige o valor', async () => {
    const e = await empresa();
    const agora = new Date();
    const confirmadoEm = agoraMenos(200, agora);
    const antes = await vender(e, 200, { ref: agora });
    // A plataforma no limite: o pedido entra na fila e não sai.
    emLimite.add(e.cliente);
    expect(await passar(e, agora)).toMatchObject({ status: 'falhou', novos: 1, enviados: 0 });
    emLimite.delete(e.cliente);
    expect(await linha(e, antes)).toMatchObject({ status: 'pendente', attempts: 1 });
    await cancelar(e, antes, confirmadoEm);
    pedidos.length = 0;
    expect(await passar(e, agora)).toMatchObject({ status: 'ok', desistiu: 1, enviados: 0 });
    expect(await linha(e, antes)).toMatchObject({ status: 'desistiu', last_error: 'cancelado antes do envio' });
    expect(doPedido(e, antes)).toHaveLength(0);

    // Aceito e depois cancelado: o mesmo id de transação, com o valor zero.
    const cancelado = await vender(e, 200, { ref: agora });
    const devolvido = await vender(e, 200, { ref: agora });
    expect(await passar(e, agora)).toMatchObject({ enviados: 2 });
    expect(await passar(e, agora)).toMatchObject({ aceitos: 2 });
    await cancelar(e, cancelado, confirmadoEm);
    await devolver(e, devolvido, confirmadoEm, 1000);
    pedidos.length = 0;
    await passar(e, agora);
    expect(await linha(e, cancelado)).toMatchObject({ status: 'aceito', value_micros: '34900000', correction_status: 'enviado', correction_value_micros: '0' });
    expect(await linha(e, devolvido)).toMatchObject({ status: 'aceito', correction_status: 'enviado', correction_value_micros: '24900000' });
    const correcao = doPedido(e, cancelado);
    expect(correcao.map((x) => x.validateOnly)).toEqual([true, false]);
    expect(correcao[1]!.events[0]).toMatchObject({ transactionId: cancelado.id, conversionValue: 0, currency: 'BRL', adIdentifiers: { gclid: cancelado.gclid }, eventTimestamp: confirmadoEm });
    expect(doPedido(e, devolvido)[1]!.events[0]).toMatchObject({ transactionId: devolvido.id, conversionValue: 24.9 });

    // Com o aceite da correção, o valor informado passa a ser o novo; e ela não sai de novo.
    pedidos.length = 0;
    expect(await passar(e, agora)).toMatchObject({ corrigidos: 2 });
    expect(await linha(e, cancelado)).toMatchObject({ status: 'aceito', value_micros: '0', correction_status: null, correction_value_micros: null, corrections: 1 });
    expect(await linha(e, devolvido)).toMatchObject({ value_micros: '24900000', corrections: 1 });
    await passar(e, agora);
    expect(envios(e)).toHaveLength(0);
  });

  it('o Google recusa: na validação, o pedido fecha como recusado e nada é enviado; no resultado, fica o motivo; processando, espera', async () => {
    const e = await empresa();
    const agora = new Date();
    const ruim = await vender(e, 200, { gclid: 'RECUSAR-id-de-clique-que-o-google-nao-conhece-AbCd', ref: agora });
    const recusadoDepois = await vender(e, 199, { ref: agora });
    const demorado = await vender(e, 198, { ref: agora });

    expect(await passar(e, agora)).toMatchObject({ status: 'ok', novos: 3, enviados: 2, recusados: 1 });
    const l = (await linha(e, ruim))!;
    expect(l).toMatchObject({ status: 'recusado', attempts: 1, request_id: null });
    // O motivo fica guardado sem o id do clique que o Google repetiu na mensagem.
    expect(l.last_error).toBe('400: Invalid value for ad_identifiers.gclid: …');
    expect(l.last_error).not.toContain('RECUSAR');
    expect(doPedido(e, ruim).map((x) => x.validateOnly)).toEqual([true]);

    resultados.set((await linha(e, recusadoDepois))!.request_id!, { requestStatus: 'FAILED', errorInfo: { errorCounts: [{ recordCount: '1', reason: 'PROCESSING_ERROR_REASON_INVALID_GCLID' }] } });
    resultados.set((await linha(e, demorado))!.request_id!, { requestStatus: 'PROCESSING' });
    expect(await passar(e, agora)).toMatchObject({ aceitos: 0, recusados: 1 });
    expect(await linha(e, recusadoDepois)).toMatchObject({ status: 'recusado', last_error: 'PROCESSING_ERROR_REASON_INVALID_GCLID' });
    expect(await linha(e, demorado)).toMatchObject({ status: 'enviado' });
    // O recusado não é tentado de novo sozinho.
    pedidos.length = 0;
    await passar(e, agora);
    expect(envios(e)).toHaveLength(0);
  });

  it('o limite do Google adia a passagem, sem perder nem repetir pedido', async () => {
    const e = await empresa();
    const agora = new Date();
    const v = await vender(e, 200, { ref: agora });
    emLimite.add(e.cliente);
    const r = await passar(e, agora);
    emLimite.delete(e.cliente);
    expect(r).toMatchObject({ status: 'falhou', novos: 1, enviados: 0 });
    expect(r.erro).toBe('429: Quota exceeded for quota metric');
    expect(await linha(e, v)).toMatchObject({ status: 'pendente', attempts: 1 });
    const d = await destinoDe(e);
    expect(d).toMatchObject({ failures: 1, last_error: '429: Quota exceeded for quota metric' });
    // A conta volta logo (o que a plataforma pediu), e não na hora cheia.
    expect(new Date(d.next_run_at).getTime() - agora.getTime()).toBeLessThanOrEqual(2 * MIN);

    pedidos.length = 0;
    expect(await passar(e, agora)).toMatchObject({ status: 'ok', novos: 0, enviados: 1 });
    expect(doPedido(e, v).filter((x) => !x.validateOnly)).toHaveLength(1);
    expect(await destinoDe(e)).toMatchObject({ failures: 0, last_error: null });
  });

  it('sem a flag, sem a permissão, com a parada ou com o destino parado, nada sai', async () => {
    const agora = new Date();
    const semFlag = await empresa({ flag: false });
    await vender(semFlag, 200, { ref: agora });
    expect(await passar(semFlag, agora)).toMatchObject({ status: 'ignorada', novos: 0 });

    const semEscopo = await empresa({ escopo: false });
    await vender(semEscopo, 200, { ref: agora });
    expect(await passar(semEscopo, agora)).toMatchObject({ status: 'sem_permissao' });
    expect((await destinoDe(semEscopo)).last_error).toMatch(/^sem_permissao: a autorização do Google não inclui o envio de conversões/);

    const parada = await empresa();
    await vender(parada, 200, { ref: agora });
    await ownerQuery(`insert into liame.kill_switch (id, level, tenant_id, reason) values (gen_random_uuid(), 'tenant', $1, 'teste: equipe parada')`, [parada.tenantId]);
    expect(await passar(parada, agora)).toMatchObject({ status: 'parada', novos: 0 });

    const parado = await empresa();
    await vender(parado, 200, { ref: agora });
    await ownerQuery(`update liame.conversion_destination set stopped_at = now() where connected_account_id = $1`, [parado.google]);
    expect(await passar(parado, agora)).toMatchObject({ status: 'ignorada' });

    const semDestino = await empresa({ destino: false });
    await vender(semDestino, 200, { ref: agora });
    expect(await passar(semDestino, agora)).toMatchObject({ status: 'ignorada' });

    for (const e of [semFlag, semEscopo, parada, parado, semDestino]) {
      expect(envios(e)).toHaveLength(0);
      expect(await ownerQuery(`select 1 from liame.conversion_upload where tenant_id = $1`, [e.tenantId])).toHaveLength(0);
    }
    // A passagem de uma empresa não alcança a conta de outra.
    expect(await passagem.executar(parado.google, semFlag.tenantId, agora)).toMatchObject({ status: 'ignorada' });
  });

  it('a reserva: quatro voltas do laço juntas fazem uma passagem só pela conta, e o pedido sai uma vez', async () => {
    const e = await empresa();
    const v = await vender(e, 200);
    const voltas = await Promise.all([1, 2, 3, 4].map(() => loop.executarLote(5, { tenantIds: [e.tenantId] })));
    expect(voltas.flat()).toHaveLength(1);
    expect(voltas.flat()[0]).toMatchObject({ status: 'ok', novos: 1, enviados: 1 });
    expect(doPedido(e, v).filter((x) => !x.validateOnly)).toHaveLength(1);
    // Reservada e atendida, a conta só volta na hora seguinte.
    expect(await loop.executarLote(5, { tenantIds: [e.tenantId] })).toHaveLength(0);
  });
});
