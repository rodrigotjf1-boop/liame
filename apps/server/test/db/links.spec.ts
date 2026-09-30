import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { createDatabase, type Database, runMigrations, withTenant } from '@liame/database';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { atribuirPedidos } from '../../src/attribution/motor.js';
import { gravarToques } from '../../src/attribution/toque-store.js';
import { codigoDoLink, parametrosParaColar, qrSvg } from '../../src/links/construtor.js';
import { gravarPedidos, type PedidoLido } from '../../src/orders/order-store.js';
import { enableMfa, ownerQuery, PASSWORD, resetIpRateLimits, signupAndLogin, startApi, type TestApi, TERMOS, tokenFrom, uniqueEmail } from '../helpers/api.js';
import { APP_URL, hasDb, OWNER_URL } from './env.js';

// A2.5 · F5 de ponta a ponta: o construtor do link (opções, criação idempotente pela chave natural, destino
// só dentro do cardápio da loja com os truques de endereço, parâmetros por plataforma e QR com o mesmo lk),
// os pedidos de cada link, a conferência do rastreio dos anúncios ativos, o isolamento entre empresas e a
// permissão. O cardápio vem da conexão do Regem da loja (`cardapio_url` nos atributos da conta).

const CARDAPIO = 'https://cardapio.exemplo.com.br/misterburgers-centro';
const CARDAPIO_OUTRA_LOJA = 'https://cardapio.exemplo.com.br/misterburgers-copa';
const HORA = 3_600_000;

type Link = {
  id: string;
  code: string;
  name: string;
  provider: string;
  tracking_url: string;
  destination_url: string;
  platform_params: { field: string; value: string };
  orders_7d: number;
  qr_svg?: string;
  created?: boolean;
};

describe.skipIf(!hasDb)('links de campanha (A2.5 · F5)', () => {
  let api: TestApi;
  let database: Database;
  let cookie = '';
  let tenantId = '';
  let brandId = '';
  let unidade: Record<'centro' | 'barra', string> = { centro: '', barra: '' };
  const contas: Record<string, string> = {};
  const ids: Record<string, string> = {};
  const links: Record<string, Link> = {};
  const agora = Date.now();
  const atras = (horas: number) => new Date(agora - horas * HORA).toISOString();

  async function conta(provider: string, nome: string, extra: { unitId?: string | null; brandId?: string; atributos?: Record<string, unknown> } = {}) {
    const id = randomUUID();
    await ownerQuery(
      `insert into liame.connected_account (id, tenant_id, brand_id, unit_id, provider, external_id, name, currency, timezone, provider_attributes)
       values ($1, $2, $3, $4, $5, $6, $7, 'BRL', 'America/Sao_Paulo', $8)`,
      [id, tenantId, extra.brandId ?? brandId, extra.unitId ?? null, provider, randomUUID(), nome, JSON.stringify(extra.atributos ?? {})],
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
  async function grupo(contaId: string, campanhaId: string, provider: string, externo: string, atributos: Record<string, unknown> = {}) {
    const id = randomUUID();
    await ownerQuery(
      `insert into liame.ad_group (id, tenant_id, connected_account_id, campaign_id, provider, external_id, name, status, provider_attributes)
       values ($1, $2, $3, $4, $5, $6, $7, 'ativa', $8)`,
      [id, tenantId, contaId, campanhaId, provider, externo, `Grupo ${externo}`, JSON.stringify(atributos)],
    );
    return id;
  }
  /** Anúncio (e, na Meta, o criativo dele) com o que o conector leu do link. */
  async function anuncio(p: { conta: string; grupo: string; provider: string; externo: string; nome: string; status?: string; providerStatus?: string; atributos?: Record<string, unknown> }) {
    const id = randomUUID();
    let criativo: string | null = null;
    if (p.provider === 'meta_ads') {
      criativo = randomUUID();
      await ownerQuery(`insert into liame.creative (id, tenant_id, connected_account_id, provider, external_id, name, provider_attributes) values ($1, $2, $3, $4, $5, $6, $7)`, [
        criativo,
        tenantId,
        p.conta,
        p.provider,
        `cr${p.externo}`,
        p.nome,
        JSON.stringify(p.atributos ?? {}),
      ]);
    }
    await ownerQuery(
      `insert into liame.ad (id, tenant_id, connected_account_id, ad_group_id, creative_id, provider, external_id, name, status, provider_status, provider_attributes)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [id, tenantId, p.conta, p.grupo, criativo, p.provider, p.externo, p.nome, p.status ?? 'ativa', p.providerStatus ?? null, JSON.stringify(p.provider === 'meta_ads' ? {} : (p.atributos ?? {}))],
    );
    return id;
  }
  /** O que o conector guarda do link do anúncio. */
  const rastreio = (r: { url_tags?: string | null; destinos?: string[]; sufixo?: string | null }) => ({
    rastreio: {
      url_tags: r.url_tags ?? null,
      destinos: (r.destinos ?? [CARDAPIO]).map((url) => ({ url, url_tags: null })),
      sufixo: r.sufixo ?? null,
      sufixo_nivel: r.sufixo ? 'conta' : null,
      modelo: null,
      modelo_nivel: null,
    },
  });
  const pedidoDoCriativo = async (anuncioId: string, atributos: Record<string, unknown>) =>
    ownerQuery(`update liame.creative set provider_attributes = $1 where id = (select creative_id from liame.ad where id = $2)`, [JSON.stringify(atributos), anuncioId]);

  const criar = (body: Record<string, unknown>, c = cookie) => api.call('POST', '/v1/links', { cookie: c, body });

  beforeAll(async () => {
    await runMigrations({ connectionString: OWNER_URL, dir: resolve(process.cwd(), '../../packages/database/migrations') });
    api = await startApi();
    await resetIpRateLimits();
    database = createDatabase({ connectionString: APP_URL, max: 2, applicationName: 'liame-test' });
    const s = await signupAndLogin(api, undefined, 'Mister Burgers Links');
    await enableMfa(api, s.cookie);
    cookie = s.cookie;
    tenantId = s.me.active_organization_id as string;
    brandId = (await ownerQuery<{ id: string }>(`select id from liame.brand where tenant_id = $1 limit 1`, [tenantId]))[0]!.id;
    unidade = { centro: randomUUID(), barra: randomUUID() };
    await ownerQuery(`insert into liame.unit (id, tenant_id, brand_id, name) values ($1, $2, $3, 'Loja Centro'), ($4, $2, $3, 'Loja Barra')`, [unidade.centro, tenantId, brandId, unidade.barra]);

    // Regem: a Loja Centro com cardápio; a Barra sem cardápio; uma loja do Regem ainda sem loja do Liame.
    contas.regemCentro = await conta('regem', 'Mister Burgers Centro (Regem)', { unitId: unidade.centro, atributos: { cardapio_url: CARDAPIO, escopos: ['pedidos.ler'] } });
    contas.regemBarra = await conta('regem', 'Mister Burgers Barra (Regem)', { unitId: unidade.barra, atributos: { cardapio_url: null } });
    contas.regemSolta = await conta('regem', 'Mister Burgers Copa (Regem)', { atributos: { cardapio_url: CARDAPIO_OUTRA_LOJA } });

    // Meta: "Combo sexta" leva ao site; "Smash em dobro" abre o WhatsApp; uma removida.
    contas.meta = await conta('meta_ads', 'CA - Mister');
    ids.C1 = await campanha(contas.meta, 'meta_ads', '1201', 'Combo sexta');
    ids.C2 = await campanha(contas.meta, 'meta_ads', '1202', 'Smash em dobro');
    ids.C3 = await campanha(contas.meta, 'meta_ads', '1203', 'Inauguração', 'removida');
    ids.G1 = await grupo(contas.meta, ids.C1, 'meta_ads', '2301', { destination_type: 'WEBSITE' });
    ids.G2 = await grupo(contas.meta, ids.C2, 'meta_ads', '2302', { destination_type: 'WHATSAPP' });
    const meta = (externo: string, nome: string, extra: { status?: string; providerStatus?: string } = {}) =>
      anuncio({ conta: contas.meta!, grupo: ids.G1!, provider: 'meta_ads', externo, nome, ...extra });
    ids.A1 = await meta('3401', 'Combo sexta · 1 vídeo');
    ids.A2 = await meta('3402', 'Combo sexta · 2 carrossel');
    ids.A3 = await meta('3403', 'Combo sexta · 3 stories');
    ids.A4 = await meta('3404', 'Combo sexta · 4 feed');
    ids.A5 = await meta('3405', 'Combo sexta · 5 reels');
    ids.A6 = await meta('3406', 'Combo sexta · 6 ifood');
    ids.A7 = await meta('3407', 'Combo sexta · 7 novo');
    ids.A8 = await anuncio({ conta: contas.meta, grupo: ids.G2, provider: 'meta_ads', externo: '3408', nome: 'Smash · vídeo 2' });
    ids.A9 = await meta('3409', 'Combo sexta · 9 pausado', { status: 'pausada', providerStatus: 'PAUSED' });
    ids.A10 = await meta('3410', 'Combo sexta · 10 sumiu');
    ids.A11 = await meta('3411', 'Combo sexta · 11 reprovado', { providerStatus: 'DISAPPROVED' });

    // Google Ads: "Busca hambúrguer perto".
    contas.google = await conta('google_ads', 'Google Ads Mister');
    ids.G = await campanha(contas.google, 'google_ads', '9001', 'Busca “hambúrguer perto”');
    ids.GG = await grupo(contas.google, ids.G, 'google_ads', '9101');
    ids.GA1 = await anuncio({ conta: contas.google, grupo: ids.GG, provider: 'google_ads', externo: '9201', nome: 'Anúncio de pesquisa 1' });
    ids.GA2 = await anuncio({ conta: contas.google, grupo: ids.GG, provider: 'google_ads', externo: '9202', nome: 'Anúncio de pesquisa 2', atributos: rastreio({ sufixo: 'utm_source=google' }) });
    ids.GA3 = await anuncio({ conta: contas.google, grupo: ids.GG, provider: 'google_ads', externo: '9203', nome: 'Anúncio de pesquisa 3', atributos: rastreio({ destinos: [] }) });

    // Última leitura das entidades: há uma hora. O anúncio que sumiu da plataforma ficou com a leitura de antes.
    for (const c of [contas.meta, contas.google]) {
      await ownerQuery(
        `insert into liame.sync_run (id, tenant_id, connected_account_id, dataset, kind, status, started_at, finished_at)
         values ($1, $2, $3, 'entidades', 'incremental', 'ok', now() - interval '1 hour', now() - interval '59 minutes')`,
        [randomUUID(), tenantId, c],
      );
      await ownerQuery(
        `insert into liame.sync_state (connected_account_id, dataset, tenant_id, expected_every_minutes, last_success_at, last_attempt_at)
         values ($1, 'entidades', $2, 1440, now() - interval '59 minutes', now() - interval '59 minutes')`,
        [c, tenantId],
      );
    }
    await ownerQuery(`update liame.ad set last_seen_at = now() - interval '2 days' where id = $1`, [ids.A10]);
  });
  afterAll(async () => {
    await database?.close();
    await api?.close();
  });

  it('opções: cardápios das lojas (com o motivo quando não dá), campanhas com anúncios e tipo de destino, e a leitura de cada conta', async () => {
    const r = await api.call('GET', `/v1/links/options?brand_id=${brandId}`, { cookie });
    expect(r.status).toBe(200);
    expect(r.body.destinations).toEqual([
      { connected_account_id: contas.regemBarra, unit: { id: unidade.barra, name: 'Loja Barra' }, store_name: 'Mister Burgers Barra (Regem)', menu_url: null, usable: false, reason: 'sem_cardapio' },
      { connected_account_id: contas.regemCentro, unit: { id: unidade.centro, name: 'Loja Centro' }, store_name: 'Mister Burgers Centro (Regem)', menu_url: CARDAPIO, usable: true, reason: null },
      { connected_account_id: contas.regemSolta, unit: null, store_name: 'Mister Burgers Copa (Regem)', menu_url: CARDAPIO_OUTRA_LOJA, usable: false, reason: 'sem_loja' },
    ]);
    const campanhas = r.body.campaigns as { id: string; name: string; provider: string; destination_kind: string; ads: { name: string; status: string }[] }[];
    expect(campanhas.map((c) => [c.name, c.provider, c.destination_kind])).toEqual([
      ['Busca “hambúrguer perto”', 'google_ads', 'site'],
      ['Combo sexta', 'meta_ads', 'site'],
      ['Smash em dobro', 'meta_ads', 'mensagens'],
    ]);
    const combo = campanhas.find((c) => c.id === ids.C1)!;
    expect(combo.ads.map((a) => a.name)).toContain('Combo sexta · 1 vídeo');
    expect(combo.ads.at(-1)).toEqual({ id: ids.A9, name: 'Combo sexta · 9 pausado', status: 'pausada' });
    expect(r.body.sources.map((s: { provider: string; freshness: string; read_at: string | null }) => [s.provider, s.freshness, s.read_at !== null])).toEqual([
      ['google_ads', 'fresh', true],
      ['meta_ads', 'fresh', true],
    ]);
  });

  it('cria o link da Meta: parâmetros do protótipo, link com rastreio e QR com o mesmo lk; criar de novo devolve o mesmo link', async () => {
    const r = await criar({ unit_id: unidade.centro, campaign_id: ids.C1, name: '  Combo   sexta ' });
    expect(r.status).toBe(200);
    const l = r.body as Link & { campaign: unknown; ad: unknown; unit: unknown };
    // O código sai da chave natural: empresa, loja, campanha, anúncio (todos) e destino.
    expect(l.code).toBe(codigoDoLink({ tenantId, unitId: unidade.centro, campaignId: ids.C1!, adId: null, destinationUrl: CARDAPIO }));
    expect(l).toMatchObject({
      created: true,
      name: 'Combo sexta',
      provider: 'meta_ads',
      campaign: { id: ids.C1, name: 'Combo sexta', status: 'ativa' },
      ad: null,
      unit: { id: unidade.centro, name: 'Loja Centro' },
      destination_url: CARDAPIO,
      tracking_url: `${CARDAPIO}?utm_source=meta&utm_medium=paid&utm_campaign=combo-sexta&lk=${l.code}`,
      platform_params: { field: 'url_tags', value: parametrosParaColar('meta_ads', l.code) },
      orders_7d: 0,
    });
    expect(l.qr_svg).toBe(qrSvg(l.tracking_url));
    links.L1 = l;

    const deNovo = await criar({ unit_id: unidade.centro, campaign_id: ids.C1, name: 'Outro nome', ad_id: null });
    expect(deNovo.status).toBe(200);
    expect(deNovo.body).toMatchObject({ created: false, id: l.id, code: l.code, name: 'Combo sexta' });
    const linhas = await ownerQuery<{ n: string; criador: string | null }>(`select count(*)::text as n, max(created_by::text) as criador from liame.tracking_link where tenant_id = $1 and code = $2`, [tenantId, l.code]);
    expect(linhas[0]).toMatchObject({ n: '1' });
    expect(linhas[0]!.criador).not.toBeNull();
    const auditoria = await ownerQuery<{ after: { criado: boolean; code: string } }>(
      `select after from liame.audit_event where chain_key = $1 and action = 'link.criar' and resource_id = $2 order by chain_seq`,
      [tenantId, l.id],
    );
    expect(auditoria.map((a) => [a.after.code, a.after.criado])).toEqual([
      [l.code, true],
      [l.code, false],
    ]);
  });

  it('o mesmo link pedido quatro vezes ao mesmo tempo vira um link só', async () => {
    const corpo = { unit_id: unidade.centro, campaign_id: ids.C1, ad_id: ids.A2, name: 'Combo sexta · carrossel' };
    const rs = await Promise.all(Array.from({ length: 4 }, () => criar(corpo)));
    expect(rs.map((r) => r.status)).toEqual([200, 200, 200, 200]);
    expect(new Set(rs.map((r) => r.body.id)).size).toBe(1);
    expect(rs.filter((r) => r.body.created).length).toBe(1);
    const [n] = await ownerQuery<{ n: string }>(`select count(*)::text as n from liame.tracking_link where tenant_id = $1 and ad_id = $2`, [tenantId, ids.A2]);
    expect(n!.n).toBe('1');
    links.L2 = rs[0]!.body;
  });

  it('anúncio e página dentro do cardápio fazem outro link; o do Google vai no sufixo do URL final', async () => {
    const stories = await criar({ unit_id: unidade.centro, campaign_id: ids.C1, ad_id: ids.A3, name: 'Combo sexta · stories' });
    expect(stories.status).toBe(200);
    expect(stories.body).toMatchObject({ created: true, ad: { id: ids.A3, name: 'Combo sexta · 3 stories' } });
    expect(stories.body.code).not.toBe(links.L1!.code);

    const pagina = await criar({ unit_id: unidade.centro, campaign_id: ids.C1, name: 'Combo sexta · combo', destination_url: `${CARDAPIO}/combo` });
    expect(pagina.status).toBe(200);
    expect(pagina.body).toMatchObject({ created: true, destination_url: `${CARDAPIO}/combo` });
    expect(pagina.body.tracking_url).toBe(`${CARDAPIO}/combo?utm_source=meta&utm_medium=paid&utm_campaign=combo-sexta&lk=${pagina.body.code}`);

    const google = await criar({ unit_id: unidade.centro, campaign_id: ids.G, name: 'Busca hambúrguer perto' });
    expect(google.status).toBe(200);
    expect(google.body).toMatchObject({
      created: true,
      provider: 'google_ads',
      tracking_url: `${CARDAPIO}?utm_source=google&utm_medium=cpc&utm_campaign=busca-hamburguer-perto&lk=${google.body.code}`,
      platform_params: {
        field: 'final_url_suffix',
        value: `utm_source=google&utm_medium=cpc&campaign_id={campaignid}&adgroup_id={adgroupid}&ad_id={creative}&lk=${google.body.code}`,
      },
    });
    links.LG = google.body;
  });

  it('destino fora do cardápio da loja é recusado (V33): outro host, subdomínio parecido, @, javascript:, http:, porta, outra loja', async () => {
    const [antes] = await ownerQuery<{ n: string }>(`select count(*)::text as n from liame.tracking_link where tenant_id = $1`, [tenantId]);
    for (const destino of [
      'https://outro.site/misterburgers-centro',
      'https://cardapio.exemplo.com.br.outro.site/misterburgers-centro',
      'https://xcardapio.exemplo.com.br/misterburgers-centro',
      'https://cardapio.exemplo.com.br@outro.site/misterburgers-centro',
      'https://pessoa:senha@cardapio.exemplo.com.br/misterburgers-centro',
      'javascript:alert(1)//cardapio.exemplo.com.br/misterburgers-centro',
      'http://cardapio.exemplo.com.br/misterburgers-centro',
      'https://cardapio.exemplo.com.br:8443/misterburgers-centro',
      'https://cardapio.exemplo.com.br/misterburgers-centro/../misterburgers-copa',
      CARDAPIO_OUTRA_LOJA,
      `${CARDAPIO}?lk=ABCDEF123`,
    ]) {
      const r = await criar({ unit_id: unidade.centro, campaign_id: ids.C1, name: 'Ataque', destination_url: destino });
      expect([destino, r.status, r.body.code]).toEqual([destino, 422, 'destino-fora-do-cardapio']);
    }
    const [depois] = await ownerQuery<{ n: string }>(`select count(*)::text as n from liame.tracking_link where tenant_id = $1`, [tenantId]);
    expect(depois!.n).toBe(antes!.n);
  });

  it('regras: campanha de mensagens, de outra marca ou encerrada, anúncio de outra campanha, loja sem cardápio, nome vazio e ids que não existem', async () => {
    const outraMarca = randomUUID();
    await ownerQuery(`insert into liame.brand (id, tenant_id, name) values ($1, $2, 'Mister Burgers Express')`, [outraMarca, tenantId]);
    const contaOutraMarca = await conta('meta_ads', 'CA - Express', { brandId: outraMarca });
    const campanhaOutraMarca = await campanha(contaOutraMarca, 'meta_ads', '7701', 'Express no almoço');

    const codigo = async (body: Record<string, unknown>) => {
      const r = await criar({ unit_id: unidade.centro, campaign_id: ids.C1, name: 'Teste', ...body });
      return [r.status, r.body.code];
    };
    expect(await codigo({ campaign_id: ids.C2 })).toEqual([422, 'campanha-sem-site']);
    expect(await codigo({ campaign_id: campanhaOutraMarca })).toEqual([422, 'campanha-fora-da-marca']);
    expect(await codigo({ campaign_id: ids.C3 })).toEqual([422, 'campanha-encerrada']);
    expect(await codigo({ ad_id: ids.A8 })).toEqual([422, 'anuncio-fora-da-campanha']);
    expect(await codigo({ unit_id: unidade.barra })).toEqual([422, 'loja-sem-cardapio']);
    expect(await codigo({ name: '   ' })).toEqual([400, 'validacao']);
    expect(await codigo({ campaign_id: randomUUID() })).toEqual([404, 'nao-encontrado']);
    expect(await codigo({ unit_id: randomUUID() })).toEqual([404, 'nao-encontrado']);
    expect(await codigo({ ad_id: randomUUID() })).toEqual([404, 'nao-encontrado']);
    expect(await codigo({ extra: 'campo' })).toEqual([400, 'validacao']);
  });

  it('lista: os links da marca com os pedidos dos últimos 7 dias que chegaram por cada um (cupom exclusivo conta pelo cupom)', async () => {
    const cupom = randomUUID();
    await ownerQuery(
      `insert into liame.coupon (id, tenant_id, brand_id, connected_account_id, external_id, code, kind, percent, active, source_version, source_updated_at)
       values ($1, $2, $3, $4, 'cp-1', 'SEXTA10', 'percentual', 10, true, 1, now())`,
      [cupom, tenantId, brandId, contas.regemCentro],
    );
    await ownerQuery(`insert into liame.campaign_coupon (id, tenant_id, brand_id, coupon_id, campaign_id, exclusive, linked_at) values ($1, $2, $3, $4, $5, true, $6)`, [
      randomUUID(),
      tenantId,
      brandId,
      cupom,
      ids.C1,
      atras(24 * 10),
    ]);
    const pedido = (externalId: string, confirmadoHa: number, over: Partial<PedidoLido> = {}): PedidoLido => ({
      externalId,
      channel: 'cardapio',
      channelGroup: 'cardapio',
      status: 'confirmado',
      currency: 'BRL',
      timezone: 'America/Sao_Paulo',
      revenueMicros: 50_000_000n,
      discountMicros: 0n,
      refundedMicros: 0n,
      couponCode: null,
      customer: null,
      isNewCustomer: null,
      placedAt: null,
      confirmedAt: atras(confirmadoHa),
      cancelledAt: null,
      version: 1n,
      sourceUpdatedAt: atras(confirmadoHa),
      items: [],
      ...over,
    });
    const L1 = links.L1!.code;
    const LG = links.LG!.code;
    await withTenant(database.db, tenantId, async (tx) => {
      const ctx = { tenantId, brandId, unitId: unidade.centro, connectedAccountId: contas.regemCentro!, provider: 'regem' };
      const r = await gravarPedidos(tx, ctx, [
        pedido('p1', 24),
        pedido('p2', 48, { couponCode: 'SEXTA10' }),
        pedido('p3', 24 * 9),
        pedido('p4', 24, { status: 'cancelado', cancelledAt: atras(12) }),
        pedido('p5', 24),
        pedido('p6', 24),
      ]);
      await gravarToques(tx, { tenantId, brandId, connectedAccountId: contas.regemCentro! }, [
        { externalId: 't1', kind: 'clique', occurredAt: atras(25), orderExternalId: 'p1', linkCode: L1, utm: { source: 'meta' } },
        { externalId: 't2', kind: 'clique', occurredAt: atras(49), orderExternalId: 'p2', linkCode: L1, utm: { source: 'meta' } },
        { externalId: 't3', kind: 'clique', occurredAt: atras(24 * 9 + 1), orderExternalId: 'p3', linkCode: L1, utm: { source: 'meta' } },
        { externalId: 't4', kind: 'clique', occurredAt: atras(25), orderExternalId: 'p4', linkCode: L1, utm: { source: 'meta' } },
        { externalId: 't5', kind: 'clique', occurredAt: atras(25), orderExternalId: 'p5', linkCode: LG, utm: { source: 'google' } },
        { externalId: 't6', kind: 'clique', occurredAt: atras(25), orderExternalId: 'p6', fbclid: 'IwAR6', campaignExternalId: '1201' },
      ]);
      await atribuirPedidos(tx, { tenantId, orderIds: r.alterados.map((a) => a.id), gatilho: 'pedidos' });
    });

    const r = await api.call('GET', `/v1/links?brand_id=${brandId}`, { cookie });
    expect(r.status).toBe(200);
    const porCodigo = new Map((r.body.items as Link[]).map((l) => [l.code, l]));
    expect(porCodigo.get(L1)!.orders_7d).toBe(1);
    expect(porCodigo.get(LG)!.orders_7d).toBe(1);
    expect(porCodigo.get(links.L2!.code)!.orders_7d).toBe(0);
    expect(r.body.items.map((l: Link) => l.name)).toEqual(['Busca hambúrguer perto', 'Combo sexta · combo', 'Combo sexta · stories', 'Combo sexta · carrossel', 'Combo sexta']);
    expect(r.body.items[0].qr_svg).toBeUndefined();

    const soGoogle = await api.call('GET', `/v1/links?brand_id=${brandId}&campaign_id=${ids.G}`, { cookie });
    expect(soGoogle.body.items.map((l: Link) => l.code)).toEqual([LG]);
    const barra = await api.call('GET', `/v1/links?brand_id=${brandId}&unit_id=${unidade.barra}`, { cookie });
    expect(barra.body.items).toEqual([]);
  });

  it('conferência do rastreio: os sem rastreio e os não verificados com o motivo; o resumo; o que não está ativo fica de fora', async () => {
    const L1 = links.L1!;
    const LG = links.LG!;
    await pedidoDoCriativo(ids.A1!, rastreio({ url_tags: L1.platform_params.value }));
    await pedidoDoCriativo(ids.A2!, rastreio({}));
    await pedidoDoCriativo(ids.A3!, rastreio({ url_tags: 'campaign_id={{campaign.id}}&ad_id={{ad.id}}' }));
    await pedidoDoCriativo(ids.A4!, rastreio({ url_tags: LG.platform_params.value }));
    await pedidoDoCriativo(ids.A5!, rastreio({ url_tags: 'campaign_id={campaignid}&ad_id={creative}' }));
    await pedidoDoCriativo(ids.A6!, rastreio({ url_tags: L1.platform_params.value, destinos: ['https://www.ifood.com.br/delivery/rio-de-janeiro-rj/mister-burgers'] }));
    // A7 fica sem leitura (o conector ainda não leu o link); A9 está pausado, A10 sumiu da plataforma, A11 foi reprovado.
    for (const id of [ids.A9!, ids.A10!, ids.A11!]) await pedidoDoCriativo(id, rastreio({}));
    await ownerQuery(`update liame.ad set provider_attributes = $1 where id = $2`, [JSON.stringify(rastreio({ sufixo: LG.platform_params.value })), ids.GA1]);

    const r = await api.call('GET', `/v1/links/tracking-check?brand_id=${brandId}`, { cookie });
    expect(r.status).toBe(200);
    expect(r.body.summary).toEqual({ active_ads: 11, with_tracking: 3, without_tracking: 5, not_verifiable: 2, not_applicable: 1 });
    expect(r.body.items.map((i: { ad: { name: string }; status: string; reason: string }) => [i.ad.name, i.status, i.reason])).toEqual([
      ['Anúncio de pesquisa 2', 'sem_rastreio', 'sem_parametros'],
      ['Combo sexta · 2 carrossel', 'sem_rastreio', 'sem_parametros'],
      ['Combo sexta · 4 feed', 'sem_rastreio', 'link_de_outra_campanha'],
      ['Combo sexta · 5 reels', 'sem_rastreio', 'parametros_de_outra_plataforma'],
      ['Combo sexta · 6 ifood', 'sem_rastreio', 'destino_fora_do_cardapio'],
      ['Anúncio de pesquisa 3', 'nao_verificavel', 'sem_link'],
      ['Combo sexta · 7 novo', 'nao_verificavel', 'leitura_pendente'],
    ]);
    const carrossel = r.body.items.find((i: { ad: { id: string } }) => i.ad.id === ids.A2);
    expect(carrossel).toMatchObject({
      provider: 'meta_ads',
      connected_account_id: contas.meta,
      campaign: { id: ids.C1, name: 'Combo sexta' },
      ad: { id: ids.A2, external_id: '3402' },
      title: 'O anúncio "Combo sexta · 2 carrossel" está sem o rastreio do Liame',
      detail: 'O link do anúncio não tem os parâmetros do Liame: as vendas dele ficam sem origem.',
      destination_url: null,
      // O link deste anúncio (criado no teste da criação simultânea) vem antes do da campanha.
      suggested_link_id: links.L2!.id,
    });
    const reels = r.body.items.find((i: { ad: { id: string } }) => i.ad.id === ids.A5);
    expect(reels.suggested_link_id).toBe(L1.id);
    const ifood = r.body.items.find((i: { ad: { id: string } }) => i.ad.id === ids.A6);
    expect(ifood.destination_url).toBe('https://www.ifood.com.br/delivery/rio-de-janeiro-rj/mister-burgers');
    const google = r.body.items.find((i: { ad: { id: string } }) => i.ad.id === ids.GA2);
    expect(google).toMatchObject({ detail: 'O URL final deste anúncio está sem o sufixo com os parâmetros do Liame: as vendas dele ficam sem a campanha.', suggested_link_id: LG.id });
    expect(r.body.sources.map((s: { provider: string }) => s.provider)).toEqual(['google_ads', 'meta_ads']);
    // Nenhum id de clique nem telefone na resposta.
    expect(JSON.stringify(r.body)).not.toMatch(/IwAR|gclid|fbclid|telefone/);
  });

  it('detalhe com o QR do mesmo lk; link inexistente ou id fora do formato', async () => {
    const r = await api.call('GET', `/v1/links/${links.L1!.id}`, { cookie });
    expect(r.status).toBe(200);
    expect(r.body.code).toBe(links.L1!.code);
    expect(r.body.qr_svg).toBe(qrSvg(`${CARDAPIO}?utm_source=meta&utm_medium=paid&utm_campaign=combo-sexta&lk=${links.L1!.code}`));
    expect((await api.call('GET', `/v1/links/${randomUUID()}`, { cookie })).status).toBe(404);
    expect((await api.call('GET', '/v1/links/nao-e-id', { cookie })).status).toBe(400);
  });

  it('isolamento: outra empresa não vê, não cria nem confere com os ids desta (A1-3)', async () => {
    const outra = await signupAndLogin(api, undefined, 'Outra Hamburgueria');
    await enableMfa(api, outra.cookie);
    const outraTenant = outra.me.active_organization_id as string;
    const outraMarca = (await ownerQuery<{ id: string }>(`select id from liame.brand where tenant_id = $1 limit 1`, [outraTenant]))[0]!.id;
    const pedidos = [
      api.call('GET', `/v1/links?brand_id=${brandId}`, { cookie: outra.cookie }),
      api.call('GET', `/v1/links/options?brand_id=${brandId}`, { cookie: outra.cookie }),
      api.call('GET', `/v1/links/tracking-check?brand_id=${brandId}`, { cookie: outra.cookie }),
      api.call('GET', `/v1/links/${links.L1!.id}`, { cookie: outra.cookie }),
      criar({ unit_id: unidade.centro, campaign_id: ids.C1, name: 'Invasão' }, outra.cookie),
    ];
    expect((await Promise.all(pedidos)).map((r) => r.status)).toEqual([404, 404, 404, 404, 404]);
    const dela = await api.call('GET', `/v1/links?brand_id=${outraMarca}`, { cookie: outra.cookie });
    expect(dela.body.items).toEqual([]);
    const visiveis = await withTenant(database.db, outraTenant, (tx) => tx.execute<{ n: string }>(sql`select count(*)::text as n from liame.tracking_link`));
    expect(visiveis.rows[0]!.n).toBe('0');
  });

  it('permissão: Somente leitura vê os links e a conferência, mas não cria nem abre as opções', async () => {
    const email = uniqueEmail('leitura');
    expect((await api.call('POST', '/v1/invitations', { cookie, body: { email, role: 'somente_leitura' } })).status).toBe(201);
    const leitor = await api.call('POST', '/v1/invitations/signup', { body: { token: tokenFrom(api.mailer, email), name: 'Leitor', password: PASSWORD, terms_version: TERMOS } });
    expect(leitor.status).toBe(200);
    const c = leitor.cookie!;
    expect((await api.call('GET', `/v1/links?brand_id=${brandId}`, { cookie: c })).status).toBe(200);
    expect((await api.call('GET', `/v1/links/tracking-check?brand_id=${brandId}`, { cookie: c })).status).toBe(200);
    expect((await api.call('GET', `/v1/links/${links.L1!.id}`, { cookie: c })).status).toBe(200);
    const opcoes = await api.call('GET', `/v1/links/options?brand_id=${brandId}`, { cookie: c });
    expect([opcoes.status, opcoes.body.code]).toEqual([403, 'sem-permissao']);
    const novo = await criar({ unit_id: unidade.centro, campaign_id: ids.C1, name: 'Sem permissão' }, c);
    expect([novo.status, novo.body.code]).toEqual([403, 'sem-permissao']);
  });
});
