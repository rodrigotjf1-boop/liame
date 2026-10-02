import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { createDatabase, type Database, runMigrations, withTenant } from '@liame/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { atribuirPedidos } from '../../src/attribution/motor.js';
import { gravarToques } from '../../src/attribution/toque-store.js';
import { gravarPedidos, type PedidoLido } from '../../src/orders/order-store.js';
import { enableMfa, ownerQuery, resetIpRateLimits, signupAndLogin, startApi, type TestApi } from '../helpers/api.js';
import { APP_URL, hasDb, OWNER_URL } from './env.js';

// A2.5 · F9 de ponta a ponta: a Atenção do ciclo fechado pela API, com o banco. Uma empresa no cardápio do
// Regem (pedidos atrasados, anúncio sem rastreio, campanha medida pelo clique sem pedido), uma no Anota AI
// (campanha sem cupom, cupom exclusivo sem uso, margem desconhecida, plataforma × caixa), uma sem o Regem,
// uma com o Regem desconectado e outra loja na Brendi; e o isolamento entre empresas.

const CARDAPIO = 'https://app.dmsregem.com/c/atencao-ciclo';
const FUSO = 'America/Sao_Paulo';
const HORA = 3_600_000;
const nbsp = (s: string) => s.replace(/R\$ /g, 'R$ ');

type Item = { kind: string; severity: string; title: string; detail: string; action: string; provider: string | null; campaign_id: string | null; connected_account_id: string | null };

describe.skipIf(!hasDb)('atenção do ciclo fechado (A2.5 · F9)', () => {
  let api: TestApi;
  let database: Database;
  const agora = Date.now();
  const atras = (ms: number) => new Date(agora - ms).toISOString();

  type Empresa = { cookie: string; tenantId: string; brandId: string };
  async function empresa(nome: string): Promise<Empresa> {
    const s = await signupAndLogin(api, undefined, nome);
    await enableMfa(api, s.cookie);
    const tenantId = s.me.active_organization_id as string;
    const brandId = (await ownerQuery<{ id: string }>(`select id from liame.brand where tenant_id = $1 limit 1`, [tenantId]))[0]!.id;
    return { cookie: s.cookie, tenantId, brandId };
  }
  async function loja(e: Empresa, nome: string, plataforma: string | null) {
    const id = randomUUID();
    await ownerQuery(`insert into liame.unit (id, tenant_id, brand_id, name, order_platform) values ($1, $2, $3, $4, $5)`, [id, e.tenantId, e.brandId, nome, plataforma]);
    return id;
  }
  async function conta(e: Empresa, provider: string, nome: string, extra: { unitId?: string; status?: string; atributos?: Record<string, unknown> } = {}) {
    const id = randomUUID();
    await ownerQuery(
      `insert into liame.connected_account (id, tenant_id, brand_id, unit_id, provider, external_id, name, currency, timezone, status, provider_attributes)
       values ($1, $2, $3, $4, $5, $6, $7, 'BRL', $8, $9, $10)`,
      [id, e.tenantId, e.brandId, extra.unitId ?? null, provider, randomUUID(), nome, FUSO, extra.status ?? 'ativa', JSON.stringify(extra.atributos ?? {})],
    );
    return id;
  }
  /** Leitura dos pedidos do Regem (conjunto `pedidos`) há tantos minutos. */
  const pedidosLidos = (e: Empresa, contaId: string, minutos: number) =>
    ownerQuery(
      `insert into liame.sync_state (connected_account_id, dataset, tenant_id, expected_every_minutes, last_success_at, last_attempt_at)
       values ($1, 'pedidos', $2, 15, now() - make_interval(mins => $3), now())`,
      [contaId, e.tenantId, minutos],
    );
  /** Campanha da Meta com um grupo e um anúncio ativo (o que o conector leu do link vai no criativo). */
  async function campanha(e: Empresa, contaId: string, nome: string, o: { status?: string; rastreio?: Record<string, unknown> } = {}) {
    const [c, g, ad, cr] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    const externo = String(Math.floor(Math.random() * 1e12));
    await ownerQuery(`insert into liame.campaign (id, tenant_id, connected_account_id, provider, external_id, name, status) values ($1, $2, $3, 'meta_ads', $4, $5, $6)`, [c, e.tenantId, contaId, externo, nome, o.status ?? 'ativa']);
    await ownerQuery(
      `insert into liame.ad_group (id, tenant_id, connected_account_id, campaign_id, provider, external_id, name, status, provider_attributes)
       values ($1, $2, $3, $4, 'meta_ads', $5, $6, 'ativa', '{"destination_type":"WEBSITE"}')`,
      [g, e.tenantId, contaId, c, `g${externo}`, `Grupo ${nome}`],
    );
    await ownerQuery(`insert into liame.creative (id, tenant_id, connected_account_id, provider, external_id, name, provider_attributes) values ($1, $2, $3, 'meta_ads', $4, $5, $6)`, [
      cr,
      e.tenantId,
      contaId,
      `cr${externo}`,
      nome,
      JSON.stringify(o.rastreio ?? {}),
    ]);
    await ownerQuery(
      `insert into liame.ad (id, tenant_id, connected_account_id, ad_group_id, creative_id, provider, external_id, name, status) values ($1, $2, $3, $4, $5, 'meta_ads', $6, $7, 'ativa')`,
      [ad, e.tenantId, contaId, g, cr, `a${externo}`, `${nome} · anúncio`],
    );
    return { id: c, ad, criativo: cr, externo: `a${externo}` };
  }
  /** Mais um anúncio ativo na mesma campanha. */
  async function outroAnuncio(e: Empresa, contaId: string, campanhaId: string, nome: string, rastreio: Record<string, unknown>) {
    const [ad, cr] = [randomUUID(), randomUUID()];
    const [g] = await ownerQuery<{ id: string }>(`select id from liame.ad_group where campaign_id = $1 limit 1`, [campanhaId]);
    await ownerQuery(`insert into liame.creative (id, tenant_id, connected_account_id, provider, external_id, name, provider_attributes) values ($1, $2, $3, 'meta_ads', $4, $5, $6)`, [
      cr,
      e.tenantId,
      contaId,
      `cr-${ad}`,
      nome,
      JSON.stringify(rastreio),
    ]);
    await ownerQuery(
      `insert into liame.ad (id, tenant_id, connected_account_id, ad_group_id, creative_id, provider, external_id, name, status) values ($1, $2, $3, $4, $5, 'meta_ads', $6, $7, 'ativa')`,
      [ad, e.tenantId, contaId, g!.id, cr, `a-${ad.slice(0, 12)}`, nome],
    );
    return ad;
  }
  const rastreio = (url_tags: string | null) => ({ rastreio: { url_tags, destinos: [{ url: CARDAPIO, url_tags: null }], sufixo: null, sufixo_nivel: null, modelo: null, modelo_nivel: null } });
  /** Métrica de ontem (no dia da conta) do anúncio. */
  const metrica = (e: Empresa, contaId: string, anuncio: { ad: string; externo: string }, nome: string, janela: string, valor: number, diasAtras = 1) =>
    ownerQuery(
      `insert into liame.metric_latest (connected_account_id, level, external_entity_id, metric_date, metric_name, attribution_window, tenant_id, brand_id,
                                        provider, entity_id, metric_value, currency, timezone, observed_at, changed_at)
       values ($1, 'ad', $2, (now() at time zone $3)::date - $10::int, $4, $5, $6, $7, 'meta_ads', $8, $9, 'BRL', $3, now(), now())`,
      [contaId, anuncio.externo, FUSO, nome, janela, e.tenantId, e.brandId, anuncio.ad, valor, diasAtras],
    );
  const entidadesLidas = async (e: Empresa, contaId: string) => {
    await ownerQuery(
      `insert into liame.sync_run (id, tenant_id, connected_account_id, dataset, kind, status, started_at, finished_at)
       values ($1, $2, $3, 'entidades', 'incremental', 'ok', now() - interval '1 hour', now() - interval '59 minutes')`,
      [randomUUID(), e.tenantId, contaId],
    );
  };
  const pedido = (externalId: string, over: Partial<PedidoLido> = {}): PedidoLido => ({
    externalId,
    channel: 'cardapio',
    channelGroup: 'cardapio',
    status: 'confirmado',
    currency: 'BRL',
    timezone: FUSO,
    revenueMicros: 100_000_000n,
    discountMicros: 0n,
    refundedMicros: 0n,
    couponCode: null,
    customer: null,
    isNewCustomer: null,
    placedAt: null,
    confirmedAt: atras(20 * HORA),
    cancelledAt: null,
    version: 1n,
    sourceUpdatedAt: atras(20 * HORA),
    items: [],
    ...over,
  });
  /** Cupom informado, ligado como exclusivo há tantos dias. */
  async function cupomExclusivo(e: Empresa, contaRegem: string, codigo: string, campanhaId: string, dias: number) {
    const [cp, cc] = [randomUUID(), randomUUID()];
    await ownerQuery(
      `insert into liame.coupon (id, tenant_id, brand_id, connected_account_id, external_id, code, kind, active, uses_count, source_version, source_updated_at, origin, platform)
       values ($1, $2, $3, $4, $5, $6, 'outro', true, 0, 0, now(), 'externo', 'anotaai')`,
      [cp, e.tenantId, e.brandId, contaRegem, `externo:${codigo}`, codigo],
    );
    await ownerQuery(`insert into liame.campaign_coupon (id, tenant_id, brand_id, coupon_id, campaign_id, exclusive, linked_at) values ($1, $2, $3, $4, $5, true, now() - make_interval(days => $6))`, [
      cc,
      e.tenantId,
      e.brandId,
      cp,
      campanhaId,
      dias,
    ]);
  }
  const atencao = async (e: Empresa, query = '') => {
    const r = await api.call('GET', `/v1/results/attention${query}`, { cookie: e.cookie });
    return { status: r.status, itens: (r.body.items ?? []) as Item[], corpo: r.body };
  };

  beforeAll(async () => {
    await runMigrations({ connectionString: OWNER_URL, dir: resolve(process.cwd(), '../../packages/database/migrations') });
    api = await startApi();
    await resetIpRateLimits();
    database = createDatabase({ connectionString: APP_URL, max: 2, applicationName: 'liame-test' });
  });
  afterAll(async () => {
    await database?.close();
    await api?.close();
  });

  it('loja no cardápio do Regem: pedidos atrasados, anúncio sem rastreio e campanha medida pelo clique com gasto e sem pedido; com o pedido atribuído, o aviso some', async () => {
    const e = await empresa('Atenção Cardápio');
    const unidade = await loja(e, 'Loja Centro', 'regem');
    const regem = await conta(e, 'regem', 'Mister Burgers Centro (Regem)', { unitId: unidade, atributos: { cardapio_url: CARDAPIO, escopos: ['pedidos.ler', 'custos.ler'] } });
    await pedidosLidos(e, regem, 180);
    const meta = await conta(e, 'meta_ads', 'CA - Mister');
    const combo = await campanha(e, meta, 'Combo sexta');
    await entidadesLidas(e, meta);
    const link = await api.call('POST', '/v1/links', { cookie: e.cookie, body: { unit_id: unidade, campaign_id: combo.id, name: 'Combo sexta' } });
    expect(link.status).toBe(200);
    // O anúncio da campanha leva os parâmetros; um segundo anúncio foi ao ar sem eles.
    await ownerQuery(`update liame.creative set provider_attributes = $1 where id = $2`, [JSON.stringify(rastreio(link.body.platform_params.value)), combo.criativo]);
    await outroAnuncio(e, meta, combo.id, 'Combo sexta · carrossel', rastreio(null));
    await metrica(e, meta, combo, 'spend', '', 100);

    const r = await atencao(e, `?brand_id=${e.brandId}`);
    expect(r.status).toBe(200);
    expect(r.itens.map((i) => [i.kind, i.severity])).toEqual([
      ['dado_atrasado', 'atencao'],
      ['anuncio_sem_rastreio', 'atencao'],
      ['campanha_sem_pedido', 'atencao'],
    ]);
    expect(r.itens[0]).toMatchObject({ provider: 'regem', connected_account_id: regem, title: 'As vendas da Loja Centro estão atrasadas' });
    expect(r.itens[1]).toMatchObject({ title: '1 anúncio ativo sem os parâmetros do Liame', detail: 'Ele está em 1 campanha: as vendas que vierem dele ficam sem origem.' });
    expect(r.itens[2]).toMatchObject({ campaign_id: combo.id, provider: 'meta_ads', title: nbsp('A campanha "Combo sexta" gastou R$ 100,00 em 7 dias e não teve pedido confirmado') });

    // Um pedido chega pelo link da campanha e fica com ela: a campanha deixa de estar "sem pedido".
    await withTenant(database.db, e.tenantId, async (tx) => {
      const g = await gravarPedidos(tx, { tenantId: e.tenantId, brandId: e.brandId, unitId: unidade, connectedAccountId: regem, provider: 'regem' }, [pedido('ac-1')]);
      await gravarToques(tx, { tenantId: e.tenantId, brandId: e.brandId, connectedAccountId: regem }, [
        { externalId: 'ac-t1', kind: 'clique', occurredAt: atras(21 * HORA), orderExternalId: 'ac-1', linkCode: link.body.code, utm: { source: 'meta' } },
      ]);
      await atribuirPedidos(tx, { tenantId: e.tenantId, orderIds: g.alterados.map((a) => a.id), gatilho: 'pedidos' });
    });
    // O pedido não tem custo cadastrado: a receita atribuída fica com a margem desconhecida, e a loja libera o
    // custo ao Liame, então o aviso pede a ficha técnica.
    const depois = await atencao(e);
    expect(depois.itens.map((i) => i.kind)).toEqual(['dado_atrasado', 'anuncio_sem_rastreio', 'margem_desconhecida']);
    expect(depois.itens[2]!.action).toContain('ficha técnica');
    expect(depois.corpo.generated_at).toEqual(expect.any(String));
  });

  it('loja no Anota AI: campanhas sem cupom exclusivo, cupom exclusivo sem uso com gasto, margem desconhecida e plataforma × caixa', async () => {
    const e = await empresa('Atenção Anota');
    const unidade = await loja(e, 'Loja Praia', 'anotaai');
    const regem = await conta(e, 'regem', 'Mister Burgers Praia (Regem)', { unitId: unidade, atributos: { cardapio_url: CARDAPIO, escopos: ['pedidos.ler'] } });
    await pedidosLidos(e, regem, 5);
    const meta = await conta(e, 'meta_ads', 'CA - Praia');
    const c1 = await campanha(e, meta, 'Delivery noite');
    const c2 = await campanha(e, meta, 'Combo família');
    await campanha(e, meta, 'Reconhecimento');
    await campanha(e, meta, 'Antiga', { status: 'pausada' });
    await entidadesLidas(e, meta);
    // A janela são os 7 dias completos: o gasto de 7 dias atrás conta; o de hoje e o de 8 dias atrás, não.
    await metrica(e, meta, c1, 'spend', '', 50);
    await metrica(e, meta, c1, 'spend', '', 30, 7);
    await metrica(e, meta, c1, 'spend', '', 999, 0);
    await metrica(e, meta, c1, 'spend', '', 999, 8);
    await metrica(e, meta, c2, 'spend', '', 150);
    await metrica(e, meta, c2, 'purchase_value', '7d_click', 1000);
    await cupomExclusivo(e, regem, 'NOITE15', c1.id, 6);
    await cupomExclusivo(e, regem, 'FAMILIA10', c2.id, 6);
    // Dois pedidos do Anota AI com o cupom da "Combo família": ficam com ela; sem custo, a margem é desconhecida.
    await withTenant(database.db, e.tenantId, async (tx) => {
      const g = await gravarPedidos(tx, { tenantId: e.tenantId, brandId: e.brandId, unitId: unidade, connectedAccountId: regem, provider: 'regem' }, [
        pedido('an-1', { channel: 'anotaai', channelGroup: 'outro', couponCode: 'FAMILIA10' }),
        pedido('an-2', { channel: 'anotaai', channelGroup: 'outro', couponCode: 'FAMILIA10' }),
      ]);
      await atribuirPedidos(tx, { tenantId: e.tenantId, orderIds: g.alterados.map((a) => a.id), gatilho: 'pedidos' });
    });

    const r = await atencao(e);
    expect(r.itens.map((i) => [i.kind, i.severity])).toEqual([
      ['campanha_sem_cupom', 'atencao'],
      ['cupom_sem_uso', 'atencao'],
      ['margem_desconhecida', 'atencao'],
      ['plataforma_x_caixa', 'info'],
    ]);
    // Só a "Reconhecimento" está ativa sem cupom exclusivo (a pausada não conta).
    expect(r.itens[0]).toMatchObject({ title: '1 campanha ativa sem cupom exclusivo', detail: 'Os anúncios levam ao Anota AI, e o clique não chega ao pedido: as vendas dela ficam sem origem.' });
    expect(r.itens[1]).toMatchObject({ campaign_id: c1.id, title: 'O cupom NOITE15 não teve nenhum uso em 7 dias', detail: nbsp('Ele é o cupom exclusivo da campanha "Delivery noite", que gastou R$ 80,00 no período (Meta).') });
    expect(r.itens[2]).toMatchObject({ title: 'Margem desconhecida em 100% da receita das campanhas', provider: 'regem' });
    expect(r.itens[2]!.action).toContain('ainda não liberou o custo');
    expect(r.itens[3]!.title).toBe(nbsp('A Meta informa R$ 1.000,00 em vendas; no caixa, o Liame confirmou R$ 200,00'));
    // Cada aviso leva a marca em que nasceu: é com ela que a tela pede a explicação (A3, I4).
    expect((r.corpo.items as Array<{ brand_id: string | null }>).map((i) => i.brand_id)).toEqual(Array(4).fill(e.brandId));
    // Nenhum dado pessoal nem id de clique na resposta.
    expect(JSON.stringify(r.corpo)).not.toMatch(/telefone|fbclid|gclid/);
  });

  it('sem o Regem: um aviso informativo; Regem desconectado é crítico; loja sem plataforma informada e loja na Brendi são informativos', async () => {
    const semRegem = await empresa('Atenção Sem Regem');
    await campanha(semRegem, await conta(semRegem, 'meta_ads', 'CA - Só mídia'), 'Combo');
    const r1 = await atencao(semRegem);
    expect(r1.itens.map((i) => [i.kind, i.severity])).toEqual([['vendas_nao_conectadas', 'info']]);

    const e = await empresa('Atenção Desconectada');
    const centro = await loja(e, 'Loja Centro', null);
    const barra = await loja(e, 'Loja Barra', 'brendi');
    await conta(e, 'regem', 'Centro (Regem)', { unitId: centro, status: 'desconectada' });
    const regemBarra = await conta(e, 'regem', 'Barra (Regem)', { unitId: barra });
    await pedidosLidos(e, regemBarra, 3);
    await campanha(e, await conta(e, 'meta_ads', 'CA'), 'Combo');
    const r2 = await atencao(e);
    expect(r2.itens.map((i) => [i.kind, i.severity, i.title])).toEqual([
      ['conta_desconectada', 'critica', 'O Regem da Loja Centro está desconectado'],
      ['plataforma_nao_informada', 'info', 'Confirme onde a Loja Centro recebe os pedidos online'],
      ['vendas_nao_medidas', 'info', 'As vendas da Brendi da Loja Barra ainda não são medidas'],
    ]);

    // Empresa sem conta de anúncio: só a fonte das vendas importa (nada de "como medir").
    const soVendas = await empresa('Atenção Só Vendas');
    const u = await loja(soVendas, 'Loja Única', null);
    await pedidosLidos(soVendas, await conta(soVendas, 'regem', 'Única (Regem)', { unitId: u }), 2000);
    const r3 = await atencao(soVendas);
    expect(r3.itens.map((i) => [i.kind, i.severity])).toEqual([['dado_atrasado', 'critica']]);
  });

  it('isolamento: a marca de outra empresa dá 404, e cada empresa só vê os próprios avisos (A1-3)', async () => {
    const a = await empresa('Atenção Isolada A');
    await campanha(a, await conta(a, 'meta_ads', 'CA - A'), 'Combo A');
    const b = await empresa('Atenção Isolada B');
    expect((await atencao(b, `?brand_id=${a.brandId}`)).status).toBe(404);
    expect((await atencao(b)).itens).toEqual([]);
    expect((await atencao(a)).itens.map((i) => i.kind)).toEqual(['vendas_nao_conectadas']);
    expect((await api.call('GET', '/v1/results/attention?brand_id=nao-e-id', { cookie: a.cookie })).status).toBe(400);
    expect((await api.call('GET', '/v1/results/attention')).status).toBe(401);
  });
});
