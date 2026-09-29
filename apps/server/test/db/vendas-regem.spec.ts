import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { createDatabase, type Database, withSystem } from '@liame/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MODELO_PADRAO } from '../../src/attribution/motor.js';
import { loadConfig } from '../../src/config.js';
import { registrarConexaoDaDistribuicao } from '../../src/connections/distribuicao.js';
import { SincronizadorVendas } from '../../src/orders/sincronizador-vendas.js';
import { VaultService } from '../../src/vault/vault.service.js';
import { eventoDoRegem, VendasLoop } from '../../src/worker/vendas-loop.js';
import { enableMfa, ownerQuery, resetIpRateLimits, signupAndLogin, startApi, type TestApi } from '../helpers/api.js';
import { APP_URL, hasDb } from './env.js';

// A2.5 · F4: conector do Regem (leitura) contra respostas gravadas no formato do contrato v1
// (docs/integracoes/regem.md; test/fixtures/regem/v1). Carga inicial de 90 dias, cursor, reconciliação,
// cancelamento que recalcula a atribuição, cliente anonimizado apagado, e nenhum telefone em claro no
// banco (A2.5-2, A2.5-4, A2.5-7).

const FIX = resolve(import.meta.dirname, '../fixtures/regem/v1');
const fixture = (arquivo: string) => JSON.parse(readFileSync(resolve(FIX, arquivo), 'utf8')) as unknown;
const TOKEN = `rgm_it_${'L'.repeat(32)}`;
const vazia = (cursor: string) => ({ itens: [], proximo_cursor: cursor, tem_mais: false });
const T0 = new Date('2026-09-28T12:00:00Z');
const mais = (min: number) => new Date(T0.getTime() + min * 60_000);

describe.skipIf(!hasDb)('conector do Regem: vendas da loja (A2.5 · F4)', () => {
  let api: TestApi;
  let database: Database;
  let regem: Server;
  let base = '';
  const anterior: Record<string, string | undefined> = {};
  const estado = { incremental: false, anonimizar: false, tokenRevogado: false, cuponsProibidos: false };
  const pedidosPedidos: URLSearchParams[] = [];
  let tenantId = '';
  let contaId = '';
  let sincronizador: SincronizadorVendas;

  function responder(url: URL, autorizacao: string | undefined): { status: number; corpo: unknown } {
    if (autorizacao !== `Bearer ${TOKEN}` || estado.tokenRevogado) return { status: 401, corpo: { type: 'about:blank', title: 'Token inválido', status: 401 } };
    const q = url.searchParams;
    switch (url.pathname) {
      case '/regem/loja':
        return { status: 200, corpo: fixture('loja-centro.json') };
      case '/regem/cupons':
        return estado.cuponsProibidos ? { status: 403, corpo: { type: 'about:blank', title: 'Escopo', status: 403 } } : { status: 200, corpo: q.get('cursor') ? vazia('cup-c1') : fixture('cupons.json') };
      case '/regem/pedidos': {
        pedidosPedidos.push(q);
        const cursor = q.get('cursor');
        if (!cursor) return { status: 200, corpo: fixture('pedidos-carga-1.json') };
        if (cursor === 'ped-c1') return { status: 200, corpo: fixture('pedidos-carga-2.json') };
        if (cursor === 'ped-c2') return { status: 200, corpo: estado.incremental ? fixture('pedidos-incremental.json') : vazia('ped-c2') };
        return { status: 200, corpo: vazia(cursor) };
      }
      case '/regem/clientes/anonimizados':
        // Depois da posição 'anon-c1' não há aviso novo; antes dela, o aviso de cli-1 (quando ligado).
        return { status: 200, corpo: estado.anonimizar && q.get('cursor') !== 'anon-c1' ? fixture('clientes-anonimizados.json') : vazia(q.get('cursor') ?? 'anon-c0') };
      default:
        return { status: 404, corpo: { type: 'about:blank', title: 'Não encontrado', status: 404 } };
    }
  }

  const pedidos = () =>
    ownerQuery<{ external_id: string; status: string; channel_group: string; revenue_micros: string; refunded_micros: string; coupon_code: string | null; tem_cliente: boolean }>(
      `select external_id, status, channel_group, revenue_micros::text, refunded_micros::text, coupon_code, customer_ref_id is not null as tem_cliente
         from liame.order_fact where connected_account_id = $1 order by external_id`,
      [contaId],
    );
  const atribuicoes = () =>
    ownerQuery<{ external_id: string; status: string; evidence: string | null; provider: string | null; counted: boolean; reason: string | null; campanha: string | null }>(
      `select o.external_id, r.status, r.evidence, r.provider, r.counted, r.reason, c.external_id as campanha
         from liame.attribution_result r join liame.order_fact o on o.id = r.order_id left join liame.campaign c on c.id = r.campaign_id
        where o.connected_account_id = $1 and r.model_id = $2 order by o.external_id`,
      [contaId, MODELO_PADRAO],
    );

  beforeAll(async () => {
    regem = createServer((req, res) => {
      const r = responder(new URL(req.url ?? '/', base), req.headers.authorization);
      res.writeHead(r.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(r.corpo));
    });
    await new Promise<void>((ok) => regem.listen(0, '127.0.0.1', ok));
    base = `http://127.0.0.1:${(regem.address() as AddressInfo).port}`;
    anterior.REGEM_API_URL = process.env.REGEM_API_URL;
    process.env.REGEM_API_URL = `${base}/regem`;
    api = await startApi();
    await resetIpRateLimits();
    database = createDatabase({ connectionString: APP_URL, max: 3, applicationName: 'liame-test' });
    sincronizador = new SincronizadorVendas(database.db, api.app.get(VaultService), loadConfig());

    const s = await signupAndLogin(api, undefined, 'Mister Burgers Vendas');
    await enableMfa(api, s.cookie);
    tenantId = s.me.active_organization_id as string;
    const [marca] = await ownerQuery<{ id: string }>(`select id from liame.brand where tenant_id = $1 limit 1`, [tenantId]);
    const unitId = randomUUID();
    await ownerQuery(`insert into liame.unit (id, tenant_id, brand_id, name) values ($1, $2, $3, 'Loja Centro')`, [unitId, tenantId, marca!.id]);

    // A campanha da Meta do clique do ped-001, já sincronizada pela A2.
    const meta = randomUUID();
    await ownerQuery(`insert into liame.connected_account (id, tenant_id, brand_id, provider, external_id, name, currency, timezone) values ($1, $2, $3, 'meta_ads', $4, 'CA - Mister', 'BRL', 'America/Sao_Paulo')`, [
      meta,
      tenantId,
      marca!.id,
      `act_${randomUUID().slice(0, 8)}`,
    ]);
    const [c] = await ownerQuery<{ id: string }>(
      `insert into liame.campaign (id, tenant_id, connected_account_id, provider, external_id, name, status) values ($1, $2, $3, 'meta_ads', '120215566778899', 'Combo sexta', 'ativa') returning id`,
      [randomUUID(), tenantId, meta],
    );
    const [g] = await ownerQuery<{ id: string }>(
      `insert into liame.ad_group (id, tenant_id, connected_account_id, campaign_id, provider, external_id, name, status) values ($1, $2, $3, $4, 'meta_ads', '120215566770000', 'Público', 'ativa') returning id`,
      [randomUUID(), tenantId, meta, c!.id],
    );
    await ownerQuery(
      `insert into liame.ad (id, tenant_id, connected_account_id, ad_group_id, provider, external_id, name, status) values ($1, $2, $3, $4, 'meta_ads', '120215566771111', 'Vídeo combo', 'ativa')`,
      [randomUUID(), tenantId, meta, g!.id],
    );

    const conexao = await registrarConexaoDaDistribuicao(
      { db: database.db, vault: api.app.get(VaultService), config: loadConfig() },
      { tenantId, brandId: marca!.id, produto: 'regem', tokens: [TOKEN] },
    );
    const ligar = await api.call('POST', `/v1/connections/${conexao.connectionId}/accounts`, {
      cookie: s.cookie,
      body: { accounts: [{ provider: 'regem', external_id: 'loja-centro', unit_id: unitId }] },
    });
    expect(ligar.status).toBe(200);
    contaId = ligar.body.linked[0].id;
  });
  afterAll(async () => {
    await api?.close();
    await database?.close();
    await new Promise((ok) => regem?.close(ok));
    if (anterior.REGEM_API_URL === undefined) delete process.env.REGEM_API_URL;
    else process.env.REGEM_API_URL = anterior.REGEM_API_URL;
  });

  it('carga inicial: 90 dias de pedidos, cupons, cliques e atribuição; receita do dia igual à do Regem', async () => {
    const r = await sincronizador.sincronizar(contaId, tenantId, T0);
    expect(r).toMatchObject({ status: 'ok', pedidos: { novos: 6, atualizados: 0, ignorados: 0 }, cupons: 2, semPermissao: [] });
    // A carga inicial pede os confirmados dos últimos 90 dias; as páginas seguintes vão só pelo cursor.
    expect(pedidosPedidos[0]!.get('confirmados_desde')).toBe(new Date(T0.getTime() - 90 * 86_400_000).toISOString());
    expect(pedidosPedidos[1]!.get('cursor')).toBe('ped-c1');
    expect(pedidosPedidos[1]!.get('confirmados_desde')).toBeNull();

    expect(await pedidos()).toEqual([
      { external_id: 'com-010', status: 'confirmado', channel_group: 'presencial', revenue_micros: '19900000', refunded_micros: '0', coupon_code: null, tem_cliente: false },
      { external_id: 'ped-001', status: 'confirmado', channel_group: 'cardapio', revenue_micros: '59900000', refunded_micros: '0', coupon_code: null, tem_cliente: true },
      { external_id: 'ped-002', status: 'confirmado', channel_group: 'marketplace', revenue_micros: '74500000', refunded_micros: '0', coupon_code: null, tem_cliente: false },
      { external_id: 'ped-003', status: 'confirmado', channel_group: 'presencial', revenue_micros: '44100000', refunded_micros: '0', coupon_code: 'COMBOSEXTA', tem_cliente: false },
      { external_id: 'ped-004', status: 'confirmado', channel_group: 'whatsapp', revenue_micros: '39800000', refunded_micros: '0', coupon_code: null, tem_cliente: true },
      { external_id: 'ped-005', status: 'confirmado', channel_group: 'cardapio', revenue_micros: '25900000', refunded_micros: '0', coupon_code: null, tem_cliente: true },
    ]);

    // A2.5-2 (fixture): a soma do dia, pelo instante do faturamento no fuso da loja, é a do Painel do Regem.
    const [dia] = await ownerQuery<{ dia: string; receita: string }>(
      `select (coalesce(billed_at, confirmed_at) at time zone timezone)::date::text as dia, sum(revenue_micros)::text as receita
         from liame.order_fact where connected_account_id = $1 and status = 'confirmado' group by 1`,
      [contaId],
    );
    expect(dia).toEqual({ dia: '2026-09-26', receita: String((5990 + 7450 + 4410 + 3980 + 2590 + 1990) * 10_000) });
    const [conta] = await ownerQuery<{ cardapio: string }>(`select provider_attributes->>'cardapio_url' as cardapio from liame.connected_account where id = $1`, [contaId]);
    expect(conta?.cardapio).toBe('https://cardapio.exemplo.com.br/misterburgers-centro');

    const cupons = await ownerQuery<{ code: string; kind: string; valid_from: Date | null; valid_until: Date | null; max_discount_micros: string | null; conditions: Record<string, unknown>; all_units: boolean }>(
      `select code, kind, valid_from, valid_until, max_discount_micros::text, conditions, all_units from liame.coupon where connected_account_id = $1 order by code`,
      [contaId],
    );
    expect(cupons[0]).toMatchObject({ code: 'COMBOSEXTA', kind: 'percentual', max_discount_micros: '15000000', all_units: false });
    // Validade em datas no fuso da loja: do começo do dia 26/09 ao fim do dia 31/10 (horário de Brasília).
    expect(new Date(cupons[0]!.valid_from!).toISOString()).toBe('2026-09-26T03:00:00.000Z');
    expect(new Date(cupons[0]!.valid_until!).toISOString()).toBe('2026-11-01T03:00:00.000Z');
    expect(cupons[1]).toMatchObject({ code: 'FRETEGRATIS', kind: 'frete_gratis', valid_from: null, all_units: true });

    expect(await atribuicoes()).toEqual([
      { external_id: 'com-010', status: 'sem_origem', evidence: null, provider: null, counted: false, reason: 'canal_sem_clique', campanha: null },
      { external_id: 'ped-001', status: 'atribuido', evidence: 'clique_campanha', provider: 'meta_ads', counted: true, reason: null, campanha: '120215566778899' },
      { external_id: 'ped-002', status: 'sem_origem', evidence: null, provider: null, counted: false, reason: 'canal_sem_clique', campanha: null },
      { external_id: 'ped-003', status: 'sem_origem', evidence: null, provider: null, counted: false, reason: 'canal_sem_clique', campanha: null },
      { external_id: 'ped-004', status: 'sem_origem', evidence: null, provider: null, counted: false, reason: 'sem_evidencia', campanha: null },
      { external_id: 'ped-005', status: 'sem_origem', evidence: null, provider: null, counted: false, reason: 'sem_id', campanha: null },
    ]);

    const estados = await ownerQuery<{ dataset: string; ok: boolean; cursor: Record<string, string> }>(
      `select dataset, last_success_at is not null and last_error is null as ok, cursor from liame.sync_state where connected_account_id = $1 order by dataset`,
      [contaId],
    );
    expect(estados.map((e) => [e.dataset, e.ok, e.cursor.cursor])).toEqual([
      ['clientes_anonimizados', true, 'anon-c0'],
      ['cupons', true, 'cup-c1'],
      ['pedidos', true, 'ped-c2'],
    ]);
    expect(estados.find((e) => e.dataset === 'pedidos')!.cursor.carga_inicial_em).toBe(T0.toISOString());
  });

  it('nenhum telefone em claro no banco: nem pedido, nem ponto de contato, nem auditoria (A2.5-7)', async () => {
    const colunas = await ownerQuery<{ tabela: string; coluna: string }>(
      `select c.table_name as tabela, c.column_name as coluna from information_schema.columns c
        where c.table_schema = 'liame' and c.data_type in ('text', 'jsonb', 'character varying', 'ARRAY')`,
    );
    // Uma consulta só, com todas as colunas de texto do schema (os telefones das respostas gravadas, com e sem o nono dígito).
    const padrao = '(999998888|99998888|988887777|98887777|977776666|97777666)';
    const partes = colunas.map(
      ({ tabela, coluna }) => `select '${tabela}.${coluna}' as onde where exists (select 1 from liame."${tabela}" where "${coluna}"::text ~ '${padrao}')`,
    );
    const achados = await ownerQuery<{ onde: string }>(partes.join(' union all '));
    expect(achados.map((a) => a.onde)).toEqual([]);
  });

  it('incremental: o cancelamento chega pelo cursor, o pedido sai do ROAS e o gclid sem campanha fica na plataforma', async () => {
    estado.incremental = true;
    const r = await sincronizador.sincronizar(contaId, tenantId, mais(20));
    expect(r).toMatchObject({ status: 'ok', pedidos: { novos: 1, atualizados: 2 } });
    const p = await pedidos();
    expect(p.find((x) => x.external_id === 'ped-001')).toMatchObject({ status: 'cancelado', refunded_micros: '59900000' });
    const a = await atribuicoes();
    expect(a.find((x) => x.external_id === 'ped-001')).toMatchObject({ status: 'atribuido', counted: false, reason: 'cancelado' });
    expect(a.find((x) => x.external_id === 'ped-006')).toMatchObject({ status: 'plataforma', evidence: 'clique_plataforma', provider: 'google_ads', counted: true });
    // A comanda que virou parte de um pedido sai das contas como removida (não é cancelamento).
    expect(p.find((x) => x.external_id === 'com-010')).toMatchObject({ status: 'removido' });
    expect(a.find((x) => x.external_id === 'com-010')).toMatchObject({ counted: false, reason: 'removido' });
    // A reconciliação diária releu os confirmados dos últimos 3 dias sem mudar nada (a versão decide).
    const [s] = await ownerQuery<{ cursor: Record<string, string> }>(`select cursor from liame.sync_state where connected_account_id = $1 and dataset = 'pedidos'`, [contaId]);
    expect(s!.cursor.reconciliacao_em).toBe(mais(20).toISOString());
    expect(s!.cursor.cursor).toBe('ped-c3');
    expect(pedidosPedidos.some((q) => q.get('confirmados_desde') === new Date(mais(20).getTime() - 3 * 86_400_000).toISOString())).toBe(true);
  });

  it('cliente anonimizado no Regem: o Liame apaga o cliente pseudonimizado e o pedido fica sem cliente', async () => {
    estado.anonimizar = true;
    const r = await sincronizador.sincronizar(contaId, tenantId, mais(40));
    expect(r).toMatchObject({ status: 'ok', anonimizados: 1 });
    expect((await pedidos()).find((x) => x.external_id === 'ped-001')?.tem_cliente).toBe(false);
    const [n] = await ownerQuery<{ n: string }>(`select count(*)::text as n from liame.customer_ref_link where connected_account_id = $1 and external_id = 'cli-1'`, [contaId]);
    expect(n?.n).toBe('0');
  });

  it('webhook do Regem antecipa a leitura; o laço lê só as lojas do Regem', async () => {
    const [conexao] = await ownerQuery<{ connection_id: string }>(`select connection_id from liame.connected_account where id = $1`, [contaId]);
    await withSystem(database.db, (tx) =>
      eventoDoRegem(tx, { id: randomUUID(), provider: 'regem', external_event_id: 'msg_1', tenant_id: tenantId, connection_id: conexao!.connection_id, type: null, body: '{}', attempts: 0 }),
    );
    const [s] = await ownerQuery<{ devida: boolean }>(`select (cursor->>'proxima')::timestamptz <= now() as devida from liame.sync_state where connected_account_id = $1 and dataset = 'pedidos'`, [contaId]);
    expect(s?.devida).toBe(true);

    const loop = new VendasLoop(database, loadConfig(), api.app.get(VaultService));
    const resultados = await loop.executarLote(5, { tenantIds: [tenantId] });
    expect(resultados).toHaveLength(1);
    expect(resultados[0]!.status).toBe('ok');
  });

  it('escopo faltando para cupons não para os pedidos; token recusado desliga a leitura da loja', async () => {
    estado.cuponsProibidos = true;
    const r = await sincronizador.sincronizar(contaId, tenantId, mais(80));
    expect(r).toMatchObject({ status: 'ok', semPermissao: ['cupons'] });
    const [cupons] = await ownerQuery<{ last_error: string }>(`select last_error from liame.sync_state where connected_account_id = $1 and dataset = 'cupons'`, [contaId]);
    expect(cupons?.last_error).toMatch(/^permissao/);

    estado.tokenRevogado = true;
    const falhou = await sincronizador.sincronizar(contaId, tenantId, mais(100));
    expect(falhou.status).toBe('falhou');
    const [conta] = await ownerQuery<{ status: string; status_reason: string }>(`select status, status_reason from liame.connected_account where id = $1`, [contaId]);
    expect(conta).toMatchObject({ status: 'desconectada' });
    expect(conta!.status_reason).toContain('conecte de novo');
  });
});
