import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { createDatabase, type Database, runMigrations, withTenant } from '@liame/database';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { atribuirPedidos } from '../../src/attribution/motor.js';
import type { CupomRegem } from '../../src/connectors/regem/contrato-regem.js';
import { diaNoFuso } from '../../src/coupons/plataforma.js';
import { gravarPedidos, type PedidoLido } from '../../src/orders/order-store.js';
import { gravarCupons } from '../../src/orders/regem-leitura.js';
import { enableMfa, ownerQuery, PASSWORD, resetIpRateLimits, signupAndLogin, startApi, type TestApi, TERMOS, tokenFrom, uniqueEmail } from '../helpers/api.js';
import { APP_URL, hasDb, OWNER_URL } from './env.js';

// A2.5 · F6 de ponta a ponta: a lista de cupons (do Regem e informados de outra plataforma, com os usos de 7
// dias e a campanha), a plataforma de pedidos da loja (informada e sugerida pelos anúncios), ligar e desligar
// com o período no fuso da loja, a atribuição refeita na hora, o cupom apagado no Regem, o isolamento entre
// empresas e a permissão.

const CARDAPIO = 'https://app.dmsregem.com/c/525ad7a2c822';
const FUSO = 'America/Sao_Paulo';
const HORA = 3_600_000;

type Item = {
  id: string;
  code: string;
  origin: string;
  platform: string | null;
  kind: string;
  percent: number | null;
  min_order_micros: string | null;
  active: boolean;
  expired: boolean;
  uses_7d: number;
  revenue_7d_micros: string;
  link: { id: string; campaign: { id: string; name: string }; exclusive: boolean; starts_at: string; ends_at: string | null; campaign_spend_7d_micros: string | null } | null;
};

describe.skipIf(!hasDb)('cupons de campanha (A2.5 · F6)', () => {
  let api: TestApi;
  let database: Database;
  let cookie = '';
  let tenantId = '';
  let brandId = '';
  const unidade: Record<'centro' | 'barra', string> = { centro: '', barra: '' };
  const contas: Record<string, string> = {};
  const ids: Record<string, string> = {};
  const cupons: Record<string, string> = {};
  const pedidos: Record<string, string> = {};
  const agora = Date.now();
  const atras = (ms: number) => new Date(agora - ms).toISOString();
  const hoje = diaNoFuso(new Date(), FUSO);
  const somarDias = (dia: string, n: number) => new Date(Date.parse(`${dia}T12:00:00Z`) + n * 24 * HORA).toISOString().slice(0, 10);
  const inicioDoDia = async (dia: string) =>
    (await ownerQuery<{ t: Date }>(`select ($1::date)::timestamp at time zone $2 as t`, [dia, FUSO]))[0]!.t.toISOString();

  const listar = (c = cookie) => api.call('GET', `/v1/coupons?brand_id=${brandId}`, { cookie: c });
  const itemDe = async (codigo: string) => ((await listar()).body.items as Item[]).find((i) => i.code === codigo);
  const ligar = (cupom: string, body: Record<string, unknown>, c = cookie) => api.call('POST', `/v1/coupons/${cupom}/link`, { cookie: c, body });
  const desligar = (cupom: string, c = cookie) => api.call('POST', `/v1/coupons/${cupom}/unlink`, { cookie: c });
  const informar = (body: Record<string, unknown>, c = cookie) => api.call('POST', '/v1/coupons/external', { cookie: c, body });
  const plataforma = (unit: string, body: Record<string, unknown>, c = cookie) => api.call('PUT', `/v1/units/${unit}/order-platform`, { cookie: c, body });
  const resultado = async (pedido: string) =>
    (await ownerQuery<{ campaign_id: string | null; evidence: string | null; counted: boolean; reason: string | null }>(
      `select campaign_id, evidence, counted, reason from liame.attribution_result where order_id = $1 and model_id = '0199a000-0000-7000-8000-000000000001'`,
      [pedido],
    ))[0];

  async function conta(provider: string, nome: string, extra: { unitId?: string | null; brandId?: string; atributos?: Record<string, unknown> } = {}) {
    const id = randomUUID();
    await ownerQuery(
      `insert into liame.connected_account (id, tenant_id, brand_id, unit_id, provider, external_id, name, currency, timezone, provider_attributes)
       values ($1, $2, $3, $4, $5, $6, $7, 'BRL', $8, $9)`,
      [id, tenantId, extra.brandId ?? brandId, extra.unitId ?? null, provider, randomUUID(), nome, FUSO, JSON.stringify(extra.atributos ?? {})],
    );
    return id;
  }
  async function campanha(contaId: string, provider: string, externo: string, nome: string, status = 'ativa') {
    const id = randomUUID();
    await ownerQuery(`insert into liame.campaign (id, tenant_id, connected_account_id, provider, external_id, name, status) values ($1, $2, $3, $4, $5, $6, $7)`, [
      id,
      tenantId,
      contaId,
      provider,
      externo,
      nome,
      status,
    ]);
    return id;
  }
  async function grupo(contaId: string, campanhaId: string, provider: string, externo: string) {
    const id = randomUUID();
    await ownerQuery(
      `insert into liame.ad_group (id, tenant_id, connected_account_id, campaign_id, provider, external_id, name, status) values ($1, $2, $3, $4, $5, $6, $7, 'ativa')`,
      [id, tenantId, contaId, campanhaId, provider, externo, `Grupo ${externo}`],
    );
    return id;
  }
  /** Anúncio ativo com o destino que o conector leu (Meta: no criativo; Google: no anúncio). */
  async function anuncio(p: { conta: string; grupo: string; provider: string; externo: string; destinos: string[] }) {
    const id = randomUUID();
    const rastreio = { rastreio: { url_tags: null, destinos: p.destinos.map((url) => ({ url, url_tags: null })), sufixo: null, sufixo_nivel: null, modelo: null, modelo_nivel: null } };
    let criativo: string | null = null;
    if (p.provider === 'meta_ads') {
      criativo = randomUUID();
      await ownerQuery(`insert into liame.creative (id, tenant_id, connected_account_id, provider, external_id, name, provider_attributes) values ($1, $2, $3, $4, $5, $6, $7)`, [
        criativo,
        tenantId,
        p.conta,
        p.provider,
        `cr${p.externo}`,
        `Criativo ${p.externo}`,
        JSON.stringify(rastreio),
      ]);
    }
    await ownerQuery(
      `insert into liame.ad (id, tenant_id, connected_account_id, ad_group_id, creative_id, provider, external_id, name, status, provider_attributes)
       values ($1, $2, $3, $4, $5, $6, $7, $8, 'ativa', $9)`,
      [id, tenantId, p.conta, p.grupo, criativo, p.provider, p.externo, `Anúncio ${p.externo}`, JSON.stringify(p.provider === 'meta_ads' ? {} : rastreio)],
    );
    return id;
  }
  const cupomRegem = (id: string, codigo: string, over: Partial<CupomRegem> = {}): CupomRegem => ({
    id,
    versao: 1,
    atualizado_em: atras(HORA),
    codigo,
    tipo: 'percentual',
    percentual: 10,
    pedido_minimo_centavos: 5000,
    fuso: FUSO,
    ativo: true,
    usos: 3,
    ...over,
  });
  const pedido = (externalId: string, confirmadoHaMs: number, over: Partial<PedidoLido> = {}): PedidoLido => ({
    externalId,
    channel: 'cardapio',
    channelGroup: 'cardapio',
    status: 'confirmado',
    currency: 'BRL',
    timezone: FUSO,
    revenueMicros: 50_000_000n,
    discountMicros: 0n,
    refundedMicros: 0n,
    couponCode: null,
    customer: null,
    isNewCustomer: null,
    placedAt: null,
    confirmedAt: atras(confirmadoHaMs),
    cancelledAt: null,
    version: 1n,
    sourceUpdatedAt: atras(confirmadoHaMs),
    items: [],
    ...over,
  });
  async function gravarEAtribuir(lista: PedidoLido[]) {
    await withTenant(database.db, tenantId, async (tx) => {
      const r = await gravarPedidos(tx, { tenantId, brandId, unitId: unidade.centro, connectedAccountId: contas.regemCentro!, provider: 'regem' }, lista);
      await atribuirPedidos(tx, { tenantId, orderIds: r.alterados.map((a) => a.id), gatilho: 'pedidos' });
    });
    const linhas = await ownerQuery<{ id: string; external_id: string }>(
      `select id, external_id from liame.order_fact where connected_account_id = $1 and external_id = any($2)`,
      [contas.regemCentro, lista.map((p) => p.externalId)],
    );
    for (const l of linhas) pedidos[l.external_id] = l.id;
  }

  beforeAll(async () => {
    await runMigrations({ connectionString: OWNER_URL, dir: resolve(process.cwd(), '../../packages/database/migrations') });
    api = await startApi();
    await resetIpRateLimits();
    database = createDatabase({ connectionString: APP_URL, max: 2, applicationName: 'liame-test' });
    const s = await signupAndLogin(api, undefined, 'Mister Burgers Cupons');
    await enableMfa(api, s.cookie);
    cookie = s.cookie;
    tenantId = s.me.active_organization_id as string;
    brandId = (await ownerQuery<{ id: string }>(`select id from liame.brand where tenant_id = $1 limit 1`, [tenantId]))[0]!.id;
    unidade.centro = randomUUID();
    unidade.barra = randomUUID();
    await ownerQuery(`insert into liame.unit (id, tenant_id, brand_id, name) values ($1, $2, $3, 'Loja Centro'), ($4, $2, $3, 'Loja Barra')`, [unidade.centro, tenantId, brandId, unidade.barra]);

    // Regem: a Loja Centro com cardápio e cupons lidos há 5 minutos; uma loja do Regem ainda sem loja do Liame,
    // que não liberou os cupons. A Barra não tem o Regem.
    contas.regemCentro = await conta('regem', 'Mister Burgers Centro (Regem)', { unitId: unidade.centro, atributos: { cardapio_url: CARDAPIO } });
    contas.regemSolta = await conta('regem', 'Mister Burgers Copa (Regem)');
    await ownerQuery(
      `insert into liame.sync_state (connected_account_id, dataset, tenant_id, expected_every_minutes, last_success_at, last_attempt_at, last_error)
       values ($1, 'cupons', $3, 15, now() - interval '5 minutes', now() - interval '5 minutes', null),
              ($2, 'cupons', $3, 15, null, now() - interval '5 minutes', 'sem_permissao: a loja não liberou este escopo')`,
      [contas.regemCentro, contas.regemSolta, tenantId],
    );

    // Meta: dois anúncios levam ao Anota AI e um ao cardápio do Regem; Google: um ao CardápioWeb.
    contas.meta = await conta('meta_ads', 'CA - Mister');
    ids.C1 = await campanha(contas.meta, 'meta_ads', '1201', 'Combo sexta');
    ids.C2 = await campanha(contas.meta, 'meta_ads', '1202', 'Smash em dobro');
    ids.C3 = await campanha(contas.meta, 'meta_ads', '1203', 'Inauguração', 'removida');
    ids.G1 = await grupo(contas.meta, ids.C1, 'meta_ads', '2301');
    ids.A1 = await anuncio({ conta: contas.meta, grupo: ids.G1, provider: 'meta_ads', externo: '3401', destinos: ['https://pedido.anota.ai/loja/mister-burgers'] });
    ids.A2 = await anuncio({ conta: contas.meta, grupo: ids.G1, provider: 'meta_ads', externo: '3402', destinos: ['https://pedido.anota.ai/loja/mister-burgers?x=1'] });
    ids.A3 = await anuncio({ conta: contas.meta, grupo: ids.G1, provider: 'meta_ads', externo: '3403', destinos: [CARDAPIO] });
    contas.google = await conta('google_ads', 'Google Ads Mister');
    ids.G = await campanha(contas.google, 'google_ads', '9001', 'Busca “hambúrguer perto”');
    ids.GG = await grupo(contas.google, ids.G, 'google_ads', '9101');
    ids.GA1 = await anuncio({ conta: contas.google, grupo: ids.GG, provider: 'google_ads', externo: '9201', destinos: ['https://mister.cardapioweb.com/'] });
    // Gasto de ontem do "Combo sexta" (Meta, pelo anúncio): R$ 152,60.
    await ownerQuery(
      `insert into liame.metric_latest (connected_account_id, level, external_entity_id, metric_date, metric_name, attribution_window, tenant_id, brand_id,
                                        provider, entity_id, metric_value, currency, timezone, observed_at, changed_at)
       values ($1, 'ad', '3401', (now() at time zone $2)::date - 1, 'spend', '', $3, $4, 'meta_ads', $5, 152.60, 'BRL', $2, now(), now())`,
      [contas.meta, FUSO, tenantId, brandId, ids.A1],
    );

    // Cupons do Regem da Loja Centro, pela gravação da leitura (F4).
    await withTenant(database.db, tenantId, (tx) =>
      gravarCupons(tx, { tenantId, brandId, connectedAccountId: contas.regemCentro! }, [
        cupomRegem('r-sexta', 'sexta10'),
        cupomRegem('r-noite', 'NOITE15', { percentual: 15, pedido_minimo_centavos: null }),
        cupomRegem('r-fds', 'FDS20', { percentual: 20 }),
        cupomRegem('r-copa', 'COPA5', { tipo: 'valor', percentual: null, valor_centavos: 500, valido_ate: somarDias(hoje, -3) }),
        cupomRegem('r-off', 'OFF', { ativo: false }),
        cupomRegem('r-velho', 'VELHO', { removido: true }),
      ]),
    );
    for (const c of await ownerQuery<{ id: string; code: string }>(`select id, code from liame.coupon where connected_account_id = $1`, [contas.regemCentro])) cupons[c.code] = c.id;

    // Pedidos: SEXTA10 hoje e há 2 dias (conta nos usos), cancelado (não conta) e há 10 dias (fora dos 7); o do
    // Anota AI com o cupom informado depois; nenhum com origem ainda.
    await gravarEAtribuir([
      pedido('p-hoje', 5_000, { couponCode: 'SEXTA10' }),
      pedido('p-antes', 48 * HORA, { couponCode: 'SEXTA10' }),
      pedido('p-cancelado', 30 * HORA, { couponCode: 'SEXTA10', status: 'cancelado', cancelledAt: atras(29 * HORA) }),
      pedido('p-velho', 240 * HORA, { couponCode: 'SEXTA10' }),
      pedido('p-anota', 5_000, { couponCode: 'TESTELIAME', channel: 'anotaai', channelGroup: 'outro', revenueMicros: 80_000_000n }),
    ]);
  });
  afterAll(async () => {
    await database?.close();
    await api?.close();
  });

  it('lista: lojas com a plataforma e a leitura dos cupons, cupons com os usos de 7 dias (sem os apagados), campanhas e a plataforma sugerida', async () => {
    const r = await listar();
    expect(r.status).toBe(200);
    expect(r.body.stores).toEqual([
      {
        connected_account_id: contas.regemCentro,
        unit: { id: unidade.centro, name: 'Loja Centro' },
        store_name: 'Mister Burgers Centro (Regem)',
        timezone: FUSO,
        order_platform: null,
        order_platform_url: null,
        order_platform_set_at: null,
        coupons_read_at: expect.any(String),
        coupons_freshness: 'fresh',
        coupons_error: null,
      },
      {
        connected_account_id: contas.regemSolta,
        unit: null,
        store_name: 'Mister Burgers Copa (Regem)',
        timezone: FUSO,
        order_platform: null,
        order_platform_url: null,
        order_platform_set_at: null,
        coupons_read_at: null,
        coupons_freshness: 'unknown',
        coupons_error: 'sem_permissao',
      },
    ]);
    const itens = r.body.items as Item[];
    expect(itens.map((i) => i.code)).toEqual(['COPA5', 'FDS20', 'NOITE15', 'OFF', 'SEXTA10']);
    expect(itens.find((i) => i.code === 'SEXTA10')).toMatchObject({
      origin: 'regem',
      platform: null,
      kind: 'percentual',
      percent: 10,
      min_order_micros: '50000000',
      active: true,
      expired: false,
      uses_7d: 2,
      revenue_7d_micros: '100000000',
      link: null,
    });
    expect(itens.find((i) => i.code === 'COPA5')).toMatchObject({ kind: 'valor', expired: true });
    expect(itens.find((i) => i.code === 'OFF')).toMatchObject({ active: false });
    expect(r.body.campaigns.map((c: { name: string; provider: string }) => [c.name, c.provider])).toEqual([
      ['Busca “hambúrguer perto”', 'google_ads'],
      ['Combo sexta', 'meta_ads'],
      ['Smash em dobro', 'meta_ads'],
    ]);
    expect(r.body.detected_platform).toEqual({ platform: 'anotaai', host: 'pedido.anota.ai', provider: 'meta_ads', ads: 2 });
    expect(r.body.create_in_regem).toBe(false);
  });

  it('plataforma de pedidos da loja: informar, trocar para outra com o endereço, voltar; recusas', async () => {
    const r = await plataforma(unidade.centro, { platform: 'anotaai' });
    expect(r.status).toBe(200);
    expect(r.body.store).toMatchObject({ connected_account_id: contas.regemCentro, order_platform: 'anotaai', order_platform_url: null });
    expect(r.body.store.order_platform_set_at).not.toBeNull();

    const semEndereco = await plataforma(unidade.centro, { platform: 'outra' });
    expect([semEndereco.status, semEndereco.body.code]).toEqual([422, 'endereco-obrigatorio']);
    const http = await plataforma(unidade.centro, { platform: 'outra', url: 'http://pedidos.misterburgers.com.br' });
    expect([http.status, http.body.code]).toEqual([422, 'endereco-invalido']);
    const outra = await plataforma(unidade.centro, { platform: 'outra', url: 'https://pedidos.misterburgers.com.br/cardapio' });
    expect(outra.body.store).toMatchObject({ order_platform: 'outra', order_platform_url: 'https://pedidos.misterburgers.com.br/cardapio' });
    const volta = await plataforma(unidade.centro, { platform: 'anotaai', url: 'https://ignorado.com.br' });
    expect(volta.body.store).toMatchObject({ order_platform: 'anotaai', order_platform_url: null });

    expect((await plataforma(unidade.barra, { platform: 'anotaai' })).body.code).toBe('loja-sem-regem');
    expect((await plataforma(randomUUID(), { platform: 'anotaai' })).status).toBe(404);
    expect((await plataforma(unidade.centro, { platform: 'ifood' })).status).toBe(400);

    const auditoria = await ownerQuery<{ after: { order_platform: string } }>(
      `select after from liame.audit_event where chain_key = $1 and action = 'loja.plataforma_pedidos' and resource_id = $2 order by chain_seq`,
      [tenantId, unidade.centro],
    );
    expect(auditoria.map((a) => a.after.order_platform)).toEqual(['anotaai', 'outra', 'anotaai']);
  });

  it('informar cupom do Anota AI: fica em maiúsculas, ligado à campanha como exclusivo, e o pedido de hoje com o código passa a contar para ela', async () => {
    expect((await resultado(pedidos['p-anota']!))?.counted).toBe(false);
    const r = await informar({ unit_id: unidade.centro, platform: 'anotaai', code: ' testeliame ', campaign_id: ids.C1, exclusive: true });
    expect(r.status).toBe(200);
    expect(r.body.reattributed_orders).toBe(1);
    expect(r.body.item).toMatchObject({
      code: 'TESTELIAME',
      origin: 'externo',
      platform: 'anotaai',
      kind: 'outro',
      active: true,
      expired: false,
      uses_7d: 1,
      revenue_7d_micros: '80000000',
      link: { campaign: { id: ids.C1, name: 'Combo sexta' }, exclusive: true, ends_at: null, campaign_spend_7d_micros: '152600000' },
    });
    expect(r.body.item.link.starts_at).toBe(await inicioDoDia(hoje));
    cupons.TESTELIAME = r.body.item.id;
    expect(await resultado(pedidos['p-anota']!)).toMatchObject({ campaign_id: ids.C1, evidence: 'cupom', counted: true });

    const [linha] = await ownerQuery<{ external_id: string; created_by: string | null; source_version: string }>(
      `select external_id, created_by, source_version::text from liame.coupon where id = $1`,
      [cupons.TESTELIAME],
    );
    expect(linha).toMatchObject({ external_id: 'externo:TESTELIAME', source_version: '0' });
    expect(linha!.created_by).not.toBeNull();
    const auditoria = await ownerQuery<{ after: { code: string; platform: string } }>(
      `select after from liame.audit_event where chain_key = $1 and action = 'cupom.informar' and resource_id = $2`,
      [tenantId, cupons.TESTELIAME],
    );
    expect(auditoria.map((a) => [a.after.code, a.after.platform])).toEqual([['TESTELIAME', 'anotaai']]);
  });

  it('recusas ao informar: o mesmo código (inclusive o do Regem), código fora do formato, plataforma sem integração, loja sem Regem; a recusa não deixa cupom pela metade', async () => {
    const base = { unit_id: unidade.centro, platform: 'anotaai', campaign_id: ids.C1, exclusive: true };
    const repetido = await informar({ ...base, code: 'TesteLiame' });
    expect([repetido.status, repetido.body.code]).toEqual([409, 'cupom-ja-existe']);
    expect((await informar({ ...base, code: 'SEXTA10' })).status).toBe(409);
    expect((await informar({ ...base, code: 'ab' })).status).toBe(400);
    expect((await informar({ ...base, code: 'COM ESPACO' })).status).toBe(400);
    expect((await informar({ ...base, code: 'BRENDI10', platform: 'brendi' })).status).toBe(400);
    expect((await informar({ ...base, code: 'BARRA10', unit_id: unidade.barra })).body.code).toBe('loja-sem-regem');
    const encerrada = await informar({ ...base, code: 'INAUGURA', campaign_id: ids.C3 });
    expect([encerrada.status, encerrada.body.code]).toEqual([422, 'campanha-encerrada']);
    const [n] = await ownerQuery<{ n: string }>(`select count(*)::text as n from liame.coupon where tenant_id = $1 and code = 'INAUGURA'`, [tenantId]);
    expect(n!.n).toBe('0');
  });

  it('ligar cupom do Regem: vale do começo do dia de hoje no fuso da loja; os pedidos de hoje com o código contam, os de antes não', async () => {
    const r = await ligar(cupons.SEXTA10!, { campaign_id: ids.C2, exclusive: true, starts_on: hoje });
    expect(r.status).toBe(200);
    expect(r.body.reattributed_orders).toBe(1);
    expect(r.body.item.link).toMatchObject({ campaign: { id: ids.C2, name: 'Smash em dobro' }, exclusive: true, ends_at: null });
    expect(r.body.item.link.starts_at).toBe(await inicioDoDia(hoje));
    expect(await resultado(pedidos['p-hoje']!)).toMatchObject({ campaign_id: ids.C2, evidence: 'cupom', counted: true });
    expect(await resultado(pedidos['p-antes']!)).toMatchObject({ campaign_id: null, counted: false });

    const outra = await ligar(cupons.SEXTA10!, { campaign_id: ids.C1, exclusive: true });
    expect([outra.status, outra.body.code]).toEqual([409, 'cupom-ja-ligado']);
    expect(outra.body.detail).toContain('Smash em dobro');

    // Ligados primeiro na lista.
    const lista = (await listar()).body.items as Item[];
    expect(lista.slice(0, 2).map((i) => i.code).sort()).toEqual(['SEXTA10', 'TESTELIAME']);
    const auditoria = await ownerQuery<{ after: { coupon_id: string; exclusive: boolean } }>(
      `select after from liame.audit_event where chain_key = $1 and action = 'cupom.ligar' and resource_id = $2`,
      [tenantId, r.body.item.link.id],
    );
    expect(auditoria.map((a) => [a.after.coupon_id, a.after.exclusive])).toEqual([[cupons.SEXTA10, true]]);
  });

  it('recusas ao ligar: início no passado, fim antes do início, cupom vencido ou desativado, campanha encerrada, de outra marca ou que não existe', async () => {
    const noite = cupons.NOITE15!;
    expect((await ligar(noite, { campaign_id: ids.C1, exclusive: true, starts_on: somarDias(hoje, -1) })).body.code).toBe('inicio-no-passado');
    expect((await ligar(noite, { campaign_id: ids.C1, exclusive: true, starts_on: somarDias(hoje, 2), ends_on: somarDias(hoje, 1) })).body.code).toBe('fim-antes-do-inicio');
    expect((await ligar(noite, { campaign_id: ids.C1, exclusive: true, starts_on: '2026-02-30' })).body.code).toBe('dia-invalido');
    expect((await ligar(noite, { campaign_id: ids.C1, exclusive: true, starts_on: '30/09/2026' })).status).toBe(400);
    expect((await ligar(cupons.COPA5!, { campaign_id: ids.C1, exclusive: true })).body.code).toBe('cupom-vencido');
    expect((await ligar(cupons.OFF!, { campaign_id: ids.C1, exclusive: true })).body.code).toBe('cupom-desativado');
    expect((await ligar(noite, { campaign_id: ids.C3, exclusive: true })).body.code).toBe('campanha-encerrada');

    const outraMarca = randomUUID();
    await ownerQuery(`insert into liame.brand (id, tenant_id, name) values ($1, $2, 'Outra marca')`, [outraMarca, tenantId]);
    const contaOutra = await conta('meta_ads', 'CA - Outra', { brandId: outraMarca });
    const campOutra = await campanha(contaOutra, 'meta_ads', '7001', 'Da outra marca');
    expect((await ligar(noite, { campaign_id: campOutra, exclusive: true })).body.code).toBe('campanha-fora-da-marca');
    expect((await ligar(noite, { campaign_id: randomUUID(), exclusive: true })).status).toBe(404);
    expect((await ligar(randomUUID(), { campaign_id: ids.C1, exclusive: true })).status).toBe(404);
    expect((await itemDe('NOITE15'))!.link).toBeNull();
  });

  it('vínculo agendado e com fim: começa no dia escolhido; desligar antes de começar apaga o vínculo', async () => {
    const amanha = somarDias(hoje, 1);
    const fim = somarDias(hoje, 30);
    const r = await ligar(cupons.NOITE15!, { campaign_id: ids.C1, exclusive: false, starts_on: amanha, ends_on: fim });
    expect(r.status).toBe(200);
    expect(r.body.reattributed_orders).toBe(0);
    expect(r.body.item.link).toMatchObject({ exclusive: false, starts_at: await inicioDoDia(amanha), ends_at: await inicioDoDia(somarDias(fim, 1)) });

    const d = await desligar(cupons.NOITE15!);
    expect(d.status).toBe(200);
    expect(d.body.item.link).toBeNull();
    const [n] = await ownerQuery<{ n: string }>(`select count(*)::text as n from liame.campaign_coupon where coupon_id = $1`, [cupons.NOITE15]);
    expect(n!.n).toBe('0');
  });

  it('desligar o que já vale: os pedidos até aqui ficam com a campanha, os depois não; ligar de novo começa onde o anterior acabou', async () => {
    const d = await desligar(cupons.SEXTA10!);
    expect(d.status).toBe(200);
    expect(d.body.item.link).toBeNull();
    expect(await resultado(pedidos['p-hoje']!)).toMatchObject({ campaign_id: ids.C2, counted: true });
    const [anterior] = await ownerQuery<{ unlinked_at: Date }>(`select unlinked_at from liame.campaign_coupon where coupon_id = $1 and unlinked_at is not null`, [cupons.SEXTA10]);
    expect(anterior!.unlinked_at).not.toBeNull();

    // Pedido depois do desligamento: sem o cupom como prova.
    const depois = Date.now() + 2_000;
    await gravarEAtribuir([pedido('p-depois', agora - depois, { couponCode: 'SEXTA10' })]);
    expect(await resultado(pedidos['p-depois']!)).toMatchObject({ campaign_id: null, counted: false });

    // Desligar de novo não muda nada.
    const outraVez = await desligar(cupons.SEXTA10!);
    expect([outraVez.status, outraVez.body.reattributed_orders]).toEqual([200, 0]);

    // Ligar de novo (hoje): o vínculo novo começa onde o anterior acabou, sem cruzar os períodos.
    const r = await ligar(cupons.SEXTA10!, { campaign_id: ids.C1, exclusive: true });
    expect(r.status).toBe(200);
    expect(r.body.item.link.starts_at).toBe(anterior!.unlinked_at.toISOString());
    expect(await resultado(pedidos['p-hoje']!)).toMatchObject({ campaign_id: ids.C2, counted: true });
    expect(await resultado(pedidos['p-depois']!)).toMatchObject({ campaign_id: ids.C1, counted: true });
    const auditoria = await ownerQuery<{ n: string }>(`select count(*)::text as n from liame.audit_event where chain_key = $1 and action = 'cupom.desligar'`, [tenantId]);
    expect(Number(auditoria[0]!.n)).toBeGreaterThanOrEqual(3);
  });

  it('cupom apagado no Regem: o vínculo em vigor fecha e o agendado sai; o cupom some da lista', async () => {
    expect((await ligar(cupons.FDS20!, { campaign_id: ids.C2, exclusive: true })).status).toBe(200);
    expect((await ligar(cupons.NOITE15!, { campaign_id: ids.C2, exclusive: true, starts_on: somarDias(hoje, 3) })).status).toBe(200);
    await withTenant(database.db, tenantId, (tx) =>
      gravarCupons(tx, { tenantId, brandId, connectedAccountId: contas.regemCentro! }, [
        cupomRegem('r-fds', 'FDS20', { percentual: 20, versao: 2, removido: true }),
        cupomRegem('r-noite', 'NOITE15', { percentual: 15, versao: 2, removido: true }),
      ]),
    );
    const fds = await ownerQuery<{ unlinked_at: Date | null }>(`select unlinked_at from liame.campaign_coupon where coupon_id = $1`, [cupons.FDS20]);
    expect(fds.map((l) => l.unlinked_at !== null)).toEqual([true]);
    const noite = await ownerQuery(`select 1 from liame.campaign_coupon where coupon_id = $1`, [cupons.NOITE15]);
    expect(noite).toEqual([]);
    const codigos = ((await listar()).body.items as Item[]).map((i) => i.code);
    expect(codigos).not.toContain('FDS20');
    expect(codigos).not.toContain('NOITE15');
  });

  it('isolamento: outra empresa não vê a lista, não liga, não desliga, não informa e não muda a plataforma com os ids desta (A1-3)', async () => {
    const outra = await signupAndLogin(api, undefined, 'Outra Hamburgueria Cupons');
    await enableMfa(api, outra.cookie);
    const outraTenant = outra.me.active_organization_id as string;
    const tentativas = [
      listar(outra.cookie),
      ligar(cupons.TESTELIAME!, { campaign_id: ids.C1, exclusive: true }, outra.cookie),
      desligar(cupons.TESTELIAME!, outra.cookie),
      informar({ unit_id: unidade.centro, platform: 'anotaai', code: 'INVASAO', campaign_id: ids.C1, exclusive: true }, outra.cookie),
      plataforma(unidade.centro, { platform: 'brendi' }, outra.cookie),
    ];
    expect((await Promise.all(tentativas)).map((r) => r.status)).toEqual([404, 404, 404, 404, 404]);
    expect((await itemDe('TESTELIAME'))!.link).not.toBeNull();
    const visiveis = await withTenant(database.db, outraTenant, (tx) => tx.execute<{ n: string }>(sql`select count(*)::text as n from liame.coupon`));
    expect(visiveis.rows[0]!.n).toBe('0');
  });

  it('permissão: Somente leitura vê os cupons, mas não liga, não desliga, não informa e não muda a plataforma', async () => {
    const email = uniqueEmail('leitura-cupons');
    expect((await api.call('POST', '/v1/invitations', { cookie, body: { email, role: 'somente_leitura' } })).status).toBe(201);
    const leitor = await api.call('POST', '/v1/invitations/signup', { body: { token: tokenFrom(api.mailer, email), name: 'Leitor', password: PASSWORD, terms_version: TERMOS } });
    expect(leitor.status).toBe(200);
    const c = leitor.cookie!;
    expect((await listar(c)).status).toBe(200);
    const negados = await Promise.all([
      ligar(cupons.SEXTA10!, { campaign_id: ids.C1, exclusive: true }, c),
      desligar(cupons.SEXTA10!, c),
      informar({ unit_id: unidade.centro, platform: 'anotaai', code: 'LEITOR10', campaign_id: ids.C1, exclusive: true }, c),
      plataforma(unidade.centro, { platform: 'brendi' }, c),
    ]);
    expect(negados.map((r) => [r.status, r.body.code])).toEqual([
      [403, 'sem-permissao'],
      [403, 'sem-permissao'],
      [403, 'sem-permissao'],
      [403, 'sem-permissao'],
    ]);
  });
});
