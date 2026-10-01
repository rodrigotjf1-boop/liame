import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { createDatabase, type Database, withSystem } from '@liame/database';
import { Logger } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MODELO_PADRAO } from '../../src/attribution/motor.js';
import { loadConfig } from '../../src/config.js';
import { registrarConexaoDaDistribuicao } from '../../src/connections/distribuicao.js';
import { newWebhookSecret, webhookHeaders } from '../../src/events/standard-webhooks.js';
import { SincronizadorVendas } from '../../src/orders/sincronizador-vendas.js';
import { VaultService } from '../../src/vault/vault.service.js';
import { apagarAnonimizadosNoSistema, eventoDoRegem, VendasLoop } from '../../src/worker/vendas-loop.js';
import { enableMfa, ownerQuery, resetIpRateLimits, signupAndLogin, startApi, type TestApi } from '../helpers/api.js';
import { APP_URL, hasDb } from './env.js';

// A2.5 · F4: conector do Regem (leitura) contra respostas gravadas no formato do contrato v1
// (docs/integracoes/regem.md; test/fixtures/regem/v1). Carga inicial de 90 dias, cursor, reconciliação
// (que relê a loja e o endereço do cardápio), cancelamento que recalcula a atribuição, cliente anonimizado
// apagado, e nenhum telefone em claro no banco (A2.5-2, A2.5-4, A2.5-7). Na loja da Barra, os conjuntos
// independentes: 404 nos cupons não impede os pedidos, o cupom que chega depois religa a atribuição, cupom
// que o banco recusaria fica de fora e token recusado continua parando tudo.

const FIX = resolve(import.meta.dirname, '../fixtures/regem/v1');
const fixture = (arquivo: string) => JSON.parse(readFileSync(resolve(FIX, arquivo), 'utf8')) as unknown;
const TOKEN = `rgm_it_${'L'.repeat(32)}`;
const TOKEN_BARRA = `rgm_it_${'B'.repeat(32)}`;
const vazia = (cursor: string) => ({ itens: [], proximo_cursor: cursor, tem_mais: false });
const problema = (status: number, title: string) => ({ type: 'about:blank', title, status });
const T0 = new Date('2026-09-28T12:00:00Z');
const mais = (min: number) => new Date(T0.getTime() + min * 60_000);
const CARDAPIO = 'https://cardapio.exemplo.com.br/misterburgers-centro';
const CARDAPIO_NOVO = 'https://cardapio.exemplo.com.br/misterburgers-centro-novo';

describe.skipIf(!hasDb)('conector do Regem: vendas da loja (A2.5 · F4)', () => {
  let api: TestApi;
  let database: Database;
  let regem: Server;
  let base = '';
  const anterior: Record<string, string | undefined> = {};
  const estado = {
    incremental: false,
    anonimizar: false,
    tokenRevogado: false,
    cuponsProibidos: false,
    cardapio: null as string | null,
    aviso: 'ok' as 'ok' | 'recusa',
    /** O que acontece no Regem enquanto o Liame lê os pedidos da loja Centro (um aviso que chega no meio da leitura). */
    aoLerPedidos: null as (() => Promise<void>) | null,
  };
  /** Os registros de aviso que a loja Centro recebeu (`PUT /webhook`), em ordem. */
  const avisos: { url: string; segredo: string }[] = [];
  const pedidosPedidos: URLSearchParams[] = [];
  /** Leituras da rota `/loja` da loja Centro (a conexão lê uma; a reconciliação, uma por dia). */
  let lojaLida = 0;
  let lojaLidaNaReconciliacao = 0;
  let tenantId = '';
  let contaId = '';
  let marcaId = '';
  let campanhaMeta = '';
  let cookie = '';
  let sincronizador: SincronizadorVendas;
  /** Loja da Barra: cupons fora do ar (404) e depois de volta; token recusado no fim. As rotas pedidas, em ordem. */
  const barra = { cupons: 'fora' as 'fora' | 'ok', tokenRevogado: false, rotas: [] as string[] };

  function responderBarra(url: URL): { status: number; corpo: unknown } {
    barra.rotas.push(url.pathname.slice('/regem/'.length));
    if (barra.tokenRevogado) return { status: 401, corpo: problema(401, 'Token inválido') };
    const cursor = url.searchParams.get('cursor');
    switch (url.pathname) {
      case '/regem/loja':
        return { status: 200, corpo: fixture('loja-barra.json') };
      case '/regem/cupons':
        if (barra.cupons === 'fora') return { status: 404, corpo: problema(404, 'Não encontrado') };
        return { status: 200, corpo: cursor ? vazia('bcup-c1') : fixture('cupons-barra.json') };
      case '/regem/pedidos':
        return { status: 200, corpo: cursor ? vazia(cursor) : fixture('pedidos-barra.json') };
      case '/regem/clientes/anonimizados':
        return { status: 200, corpo: vazia(cursor ?? 'banon-c0') };
      default:
        return { status: 404, corpo: problema(404, 'Não encontrado') };
    }
  }

  function responder(url: URL, autorizacao: string | undefined, metodo = 'GET', corpo = ''): { status: number; corpo: unknown } {
    if (autorizacao === `Bearer ${TOKEN_BARRA}`) return responderBarra(url);
    if (autorizacao !== `Bearer ${TOKEN}` || estado.tokenRevogado) return { status: 401, corpo: problema(401, 'Token inválido') };
    const q = url.searchParams;
    // O aviso (webhook) da loja Centro: o registro que o Liame faz depois da carga inicial (contrato §3).
    if (url.pathname === '/regem/webhook') {
      if (metodo !== 'PUT') return { status: 404, corpo: problema(404, 'Não encontrado') };
      const pedido = JSON.parse(corpo) as { url: string; segredo: string };
      avisos.push(pedido);
      if (estado.aviso === 'recusa') {
        return { status: 422, corpo: { type: 'https://api.dmsregem.com/problemas/endereco-nao-permitido', title: 'Endereço não permitido', status: 422, detail: 'endereço fora da lista' } };
      }
      return { status: 200, corpo: { url: pedido.url, registrado_em: '2026-09-28T12:20:00.000000Z', pausado: false, pausado_em: null, motivo_pausa: null, ultimo_envio_em: null, ultimo_status_http: null, falhas_seguidas: 0, entregues: 0 } };
    }
    switch (url.pathname) {
      case '/regem/loja':
        lojaLida++;
        return { status: 200, corpo: { ...(fixture('loja-centro.json') as Record<string, unknown>), ...(estado.cardapio ? { cardapio_url: estado.cardapio } : {}) } };
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
      const partes: Buffer[] = [];
      req.on('data', (d: Buffer) => partes.push(d));
      req.on('end', () => {
        const atender = async () => {
          const url = new URL(req.url ?? '/', base);
          if (url.pathname === '/regem/pedidos' && req.headers.authorization === `Bearer ${TOKEN}` && estado.aoLerPedidos) await estado.aoLerPedidos();
          const r = responder(url, req.headers.authorization, req.method, Buffer.concat(partes).toString('utf8'));
          res.writeHead(r.status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(r.corpo));
        };
        // Erro no servidor de teste vira 500 (o conector trata como falha passageira), nunca promessa solta.
        void atender().catch(() => {
          if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
          res.end('{}');
        });
      });
    });
    await new Promise<void>((ok) => regem.listen(0, '127.0.0.1', ok));
    base = `http://127.0.0.1:${(regem.address() as AddressInfo).port}`;
    anterior.REGEM_API_URL = process.env.REGEM_API_URL;
    process.env.REGEM_API_URL = `${base}/regem`;
    api = await startApi();
    await resetIpRateLimits();
    database = createDatabase({ connectionString: APP_URL, max: 3, applicationName: 'liame-test' });
    sincronizador = new SincronizadorVendas(database.db, api.app.get(VaultService), loadConfig(), apagarAnonimizadosNoSistema(database.db));

    const s = await signupAndLogin(api, undefined, 'Mister Burgers Vendas');
    await enableMfa(api, s.cookie);
    cookie = s.cookie;
    tenantId = s.me.active_organization_id as string;
    const [marca] = await ownerQuery<{ id: string }>(`select id from liame.brand where tenant_id = $1 limit 1`, [tenantId]);
    marcaId = marca!.id;
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
    campanhaMeta = c!.id;
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
    expect(conta?.cardapio).toBe(CARDAPIO);
    // A carga inicial não relê a loja: a conexão acabou de ler.
    expect(lojaLida).toBe(1);

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
    // A carga inicial não registra o aviso (a primeira leitura já é pesada): fica para a seguinte.
    expect(avisos).toEqual([]);
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
    // A loja trocou o endereço do cardápio no Regem (sem reconectar).
    estado.cardapio = CARDAPIO_NOVO;
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

    // A reconciliação relê a loja (uma chamada) e atualiza o endereço do cardápio que mudou, com auditoria.
    expect(lojaLida).toBe(2);
    lojaLidaNaReconciliacao = lojaLida;
    const [conta] = await ownerQuery<{ atributos: Record<string, unknown> }>(`select provider_attributes as atributos from liame.connected_account where id = $1`, [contaId]);
    expect(conta?.atributos).toMatchObject({ cardapio_url: CARDAPIO_NOVO, empresa: 'Mister Burgers' });
    expect((conta?.atributos.escopos as string[] | undefined)?.length).toBe(6);
    const auditoria = await ownerQuery<{ actor_type: string; origin: string; before: unknown; after: unknown }>(
      `select actor_type, origin, before, after from liame.audit_event
        where tenant_id = $1 and action = 'conexao.atualizar_cardapio' and resource_id = $2`,
      [tenantId, contaId],
    );
    expect(auditoria).toEqual([{ actor_type: 'system', origin: 'worker', before: { cardapio_url: CARDAPIO }, after: { cardapio_url: CARDAPIO_NOVO } }]);
  });

  it('cliente anonimizado no Regem: o Liame apaga o cliente pseudonimizado e o pedido fica sem cliente', async () => {
    estado.anonimizar = true;
    const r = await sincronizador.sincronizar(contaId, tenantId, mais(40));
    expect(r).toMatchObject({ status: 'ok', anonimizados: 1 });
    // A loja é relida uma vez por dia: não de novo 20 minutos depois.
    expect(lojaLida).toBe(lojaLidaNaReconciliacao);
    expect((await pedidos()).find((x) => x.external_id === 'ped-001')?.tem_cliente).toBe(false);
    const [n] = await ownerQuery<{ n: string }>(`select count(*)::text as n from liame.customer_ref_link where connected_account_id = $1 and external_id = 'cli-1'`, [contaId]);
    expect(n?.n).toBe('0');
  });

  const conexaoDaLoja = async () => (await ownerQuery<{ connection_id: string }>(`select connection_id from liame.connected_account where id = $1`, [contaId]))[0]!.connection_id;
  const avisoGravado = async () =>
    (await ownerQuery<{ aviso: { em: string; ok: boolean } | null }>(`select cursor->'aviso' as aviso from liame.sync_state where connected_account_id = $1 and dataset = 'pedidos'`, [contaId]))[0]!.aviso;
  /** Em quantos segundos a loja volta para a fila (negativo ou zero = já está na vez), pelo relógio do banco. */
  const esperaDaLoja = async () =>
    Number(
      (
        await ownerQuery<{ espera: string }>(
          `select extract(epoch from ((cursor->>'proxima')::timestamptz - now()))::text as espera from liame.sync_state where connected_account_id = $1 and dataset = 'pedidos'`,
          [contaId],
        )
      )[0]!.espera,
    );
  const evento = (conexaoId: string, corpo: Record<string, unknown>) => ({
    id: randomUUID(),
    provider: 'regem',
    external_event_id: `msg_${randomUUID()}`,
    tenant_id: tenantId,
    connection_id: conexaoId,
    type: null,
    body: JSON.stringify(corpo),
    attempts: 0,
  });

  it('aviso do Regem: depois da carga inicial o Liame registra para onde avisar, uma vez por dia, com o segredo da conexão', async () => {
    const conexaoId = await conexaoDaLoja();
    // As duas leituras depois da carga inicial (aos 20 e aos 40 minutos) registraram UMA vez.
    expect(avisos).toHaveLength(1);
    expect(avisos[0]!.url).toBe(`${loadConfig().apiUrl}/v1/inbox/regem/${conexaoId}`);
    expect(avisos[0]!.segredo).toMatch(/^whsec_[A-Za-z0-9+/]{43}=$/);
    expect(await avisoGravado()).toEqual({ em: mais(20).toISOString(), ok: true });

    // O segredo fica no cofre (cifrado), ligado à conexão; a criação fica na auditoria, sem o segredo.
    const [c] = await ownerQuery<{ inbox_secret_id: string | null }>(`select inbox_secret_id from liame.oauth_connection where id = $1`, [conexaoId]);
    expect(c?.inbox_secret_id).toBeTruthy();
    const [guardado] = await ownerQuery<{ purpose: string; texto: string }>(`select purpose, row_to_json(s)::text as texto from liame.secret s where id = $1`, [c!.inbox_secret_id]);
    expect(guardado?.purpose).toBe('inbox_regem');
    expect(guardado?.texto).not.toContain(avisos[0]!.segredo.slice(6));
    const auditoria = await ownerQuery<{ actor_type: string; origin: string; resource_id: string; texto: string }>(
      `select actor_type, origin, resource_id, row_to_json(a)::text as texto from liame.audit_event a where tenant_id = $1 and action = 'conexao.ativar_aviso'`,
      [tenantId],
    );
    expect(auditoria).toHaveLength(1);
    expect(auditoria[0]).toMatchObject({ actor_type: 'system', origin: 'worker', resource_id: conexaoId });
    expect(auditoria[0]!.texto).not.toContain(avisos[0]!.segredo.slice(6));

    // O aviso assinado com esse segredo entra pelo inbox da conexão; com outro segredo, não.
    const corpo = JSON.stringify({ tipo: 'pedido.alterado', id: 'ped-001', versao: 4, loja_id: 'loja-centro' });
    const enviar = (segredo: string) =>
      fetch(`${api.base}/v1/inbox/regem/${conexaoId}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...webhookHeaders(segredo, `msg_${randomUUID()}`, corpo) },
        body: corpo,
      });
    expect((await enviar(avisos[0]!.segredo)).status).toBe(202);
    expect((await enviar(newWebhookSecret())).status).toBe(401);
  });

  it('aviso recusado pelo Regem não falha a leitura: nova tentativa em uma hora, com o MESMO segredo', async () => {
    const registradoEm = (data: Date, ok: boolean) =>
      ownerQuery(`update liame.sync_state set cursor = cursor || jsonb_build_object('aviso', jsonb_build_object('em', $2::text, 'ok', $3::boolean)) where connected_account_id = $1 and dataset = 'pedidos'`, [
        contaId,
        data.toISOString(),
        ok,
      ]);
    // Um dia depois do último registro, o Liame repete (repetir religa o que o Regem tiver pausado). Desta vez o Regem recusa.
    await registradoEm(new Date(mais(45).getTime() - 86_400_000), true);
    estado.aviso = 'recusa';
    const aviso = vi.spyOn(Logger.prototype, 'warn');
    try {
      const r = await sincronizador.sincronizar(contaId, tenantId, mais(45));
      expect(r.status).toBe('ok');
      expect(avisos).toHaveLength(2);
      const log = aviso.mock.calls.map((c) => String(c[0])).find((m) => m.includes('aviso do Regem não registrado'));
      expect(log).toContain('definitivo: endereço fora da lista');
      expect(log).not.toContain(avisos[1]!.segredo.slice(6));
      expect(log).not.toContain(TOKEN);
    } finally {
      aviso.mockRestore();
    }
    expect(await avisoGravado()).toEqual({ em: mais(45).toISOString(), ok: false });

    // Cinco minutos depois, ainda não; passada uma hora da falha, de novo — e o segredo é o mesmo (um por conexão).
    estado.aviso = 'ok';
    await sincronizador.sincronizar(contaId, tenantId, mais(50));
    expect(avisos).toHaveLength(2);
    await registradoEm(new Date(mais(55).getTime() - 3_600_000), false);
    await sincronizador.sincronizar(contaId, tenantId, mais(55));
    expect(avisos).toHaveLength(3);
    expect(new Set(avisos.map((a) => a.segredo)).size).toBe(1);
    expect(new Set(avisos.map((a) => a.url)).size).toBe(1);
    expect(await avisoGravado()).toEqual({ em: mais(55).toISOString(), ok: true });
  });

  it('webhook do Regem antecipa a leitura só da loja do aviso; o laço lê só as lojas do Regem', async () => {
    const conexaoId = await conexaoDaLoja();
    const daquiADezMinutos = () =>
      ownerQuery(`update liame.sync_state set cursor = cursor || jsonb_build_object('proxima', now() + interval '10 minutes') where connected_account_id = $1 and dataset = 'pedidos'`, [contaId]);
    await daquiADezMinutos();
    expect(await esperaDaLoja()).toBeGreaterThan(500);

    // Aviso de OUTRA loja da mesma conexão: esta não é acordada.
    await withSystem(database.db, (tx) => eventoDoRegem(tx, evento(conexaoId, { tipo: 'pedido.alterado', id: 'ped-x', versao: 1, loja_id: 'loja-de-outra-conta' })));
    expect(await esperaDaLoja()).toBeGreaterThan(500);
    // Aviso desta loja: fica na vez agora, e o instante do aviso fica guardado.
    await withSystem(database.db, (tx) => eventoDoRegem(tx, evento(conexaoId, { tipo: 'pedido.alterado', id: 'ped-001', versao: 4, loja_id: 'loja-centro' })));
    expect(await esperaDaLoja()).toBeLessThanOrEqual(0);
    const [s] = await ownerQuery<{ recente: boolean }>(
      `select (cursor->>'evento_em')::timestamptz > now() - interval '1 minute' as recente from liame.sync_state where connected_account_id = $1 and dataset = 'pedidos'`,
      [contaId],
    );
    expect(s?.recente).toBe(true);
    // Aviso sem `loja_id` (token da empresa inteira, ou corpo que não é JSON): vale para todas as lojas da conexão.
    await daquiADezMinutos();
    await withSystem(database.db, (tx) => eventoDoRegem(tx, { ...evento(conexaoId, {}), body: 'não é json' }));
    expect(await esperaDaLoja()).toBeLessThanOrEqual(0);

    const loop = new VendasLoop(database, loadConfig(), api.app.get(VaultService));
    const resultados = await loop.executarLote(5, { tenantIds: [tenantId] });
    expect(resultados).toHaveLength(1);
    expect(resultados[0]!.status).toBe('ok');
    // Lida, a loja volta para a fila no ritmo normal: o aviso de antes da leitura não a segura na vez.
    expect(await esperaDaLoja()).toBeGreaterThan(14 * 60);
  });

  it('aviso que chega NO MEIO de uma leitura pede outra leitura em seguida, em vez de esperar os 15 minutos', async () => {
    const conexaoId = await conexaoDaLoja();
    // O Regem publica uma venda e avisa enquanto o Liame ainda está lendo a página dos pedidos.
    let avisou = 0;
    estado.aoLerPedidos = async () => {
      estado.aoLerPedidos = null;
      avisou++;
      await withSystem(database.db, (tx) => eventoDoRegem(tx, evento(conexaoId, { tipo: 'pedido.alterado', id: 'ped-novo', versao: 1, loja_id: 'loja-centro' })));
    };
    try {
      const r = await sincronizador.sincronizar(contaId, tenantId);
      expect(r.status).toBe('ok');
    } finally {
      estado.aoLerPedidos = null;
    }
    expect(avisou).toBe(1);
    expect(await esperaDaLoja()).toBeLessThanOrEqual(0);
    // A leitura seguinte (sem aviso no meio) devolve a loja ao ritmo normal.
    await sincronizador.sincronizar(contaId, tenantId);
    expect(await esperaDaLoja()).toBeGreaterThan(14 * 60);
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

  it('revogar a conexão tira do cofre o segredo dos avisos: o inbox dela deixa de aceitar', async () => {
    const conexaoId = await conexaoDaLoja();
    const [antes] = await ownerQuery<{ inbox_secret_id: string }>(`select inbox_secret_id from liame.oauth_connection where id = $1`, [conexaoId]);
    expect((await api.call('DELETE', `/v1/connections/${conexaoId}`, { cookie })).status).toBe(204);
    const [segredo] = await ownerQuery<{ revogado: boolean }>(`select revoked_at is not null as revogado from liame.secret where id = $1`, [antes!.inbox_secret_id]);
    expect(segredo?.revogado).toBe(true);
    const corpo = JSON.stringify({ tipo: 'pedido.alterado', id: 'ped-001', versao: 9, loja_id: 'loja-centro' });
    const r = await fetch(`${api.base}/v1/inbox/regem/${conexaoId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...webhookHeaders(avisos[0]!.segredo, `msg_${randomUUID()}`, corpo) },
      body: corpo,
    });
    expect(r.status).toBe(404);
  });

  describe('conjuntos independentes (loja da Barra)', () => {
    const TB0 = new Date('2026-09-29T15:00:00Z');
    const depoisDe = (min: number) => new Date(TB0.getTime() + min * 60_000);
    let contaBarra = '';

    const estadosBarra = () =>
      ownerQuery<{ dataset: string; last_error: string | null; cursor: Record<string, unknown> }>(
        `select dataset, last_error, cursor from liame.sync_state where connected_account_id = $1 order by dataset`,
        [contaBarra],
      );
    const ultimaExecucao = async () =>
      (
        await ownerQuery<{ status: string; error: string | null }>(
          `select status, error from liame.sync_run where connected_account_id = $1 order by started_at desc, id desc limit 1`,
          [contaBarra],
        )
      )[0];
    const situacao = async () =>
      (await ownerQuery<{ status: string; status_reason: string | null }>(`select status, status_reason from liame.connected_account where id = $1`, [contaBarra]))[0];
    const atribuicaoBar001 = async () =>
      (
        await ownerQuery<{ status: string; evidence: string | null; provider: string | null; counted: boolean; reason: string | null; campanha: string | null }>(
          `select r.status, r.evidence, r.provider, r.counted, r.reason, c.external_id as campanha
             from liame.attribution_result r join liame.order_fact o on o.id = r.order_id left join liame.campaign c on c.id = r.campaign_id
            where o.connected_account_id = $1 and o.external_id = 'bar-001' and r.model_id = $2`,
          [contaBarra, MODELO_PADRAO],
        )
      )[0];

    beforeAll(async () => {
      const unidade = randomUUID();
      await ownerQuery(`insert into liame.unit (id, tenant_id, brand_id, name) values ($1, $2, $3, 'Loja Barra')`, [unidade, tenantId, marcaId]);
      const conexao = await registrarConexaoDaDistribuicao(
        { db: database.db, vault: api.app.get(VaultService), config: loadConfig() },
        { tenantId, brandId: marcaId, produto: 'regem', tokens: [TOKEN_BARRA] },
      );
      const ligar = await api.call('POST', `/v1/connections/${conexao.connectionId}/accounts`, {
        cookie,
        body: { accounts: [{ provider: 'regem', external_id: 'loja-barra', unit_id: unidade }] },
      });
      expect(ligar.status).toBe(200);
      contaBarra = ligar.body.linked[0].id;
      // O cupom exclusivo da campanha da Meta já está no espelho com o código antigo; na origem ele virou
      // BARRA15 (versão 2), o código que o pedido bar-001 cita.
      const cupom = randomUUID();
      await ownerQuery(
        `insert into liame.coupon (id, tenant_id, brand_id, connected_account_id, external_id, code, kind, percent, active, source_version, source_updated_at)
         values ($1, $2, $3, $4, 'cup-barra', 'BARRA10', 'percentual', 10, true, 1, '2026-09-20T12:00:00Z')`,
        [cupom, tenantId, marcaId, contaBarra],
      );
      await ownerQuery(
        `insert into liame.campaign_coupon (id, tenant_id, brand_id, coupon_id, campaign_id, exclusive, linked_at) values ($1, $2, $3, $4, $5, true, '2026-09-20T12:00:00Z')`,
        [randomUUID(), tenantId, marcaId, cupom, campanhaMeta],
      );
      barra.rotas.length = 0;
    });

    it('404 nos cupons não impede a leitura dos pedidos: o erro e a espera ficam só no conjunto dos cupons', async () => {
      const r = await sincronizador.sincronizar(contaBarra, tenantId, TB0);
      expect(r).toMatchObject({
        status: 'parcial',
        pedidos: { novos: 1, atualizados: 0, ignorados: 0 },
        falhas: { cupons: 'definitivo: HTTP 404' },
        erro: 'cupons: definitivo: HTTP 404',
        semPermissao: [],
        adiados: [],
      });
      expect(barra.rotas).toEqual(['cupons', 'pedidos', 'clientes/anonimizados']);
      // O pedido chegou antes do cupom que ele cita (no Liame o cupom ainda tem o código antigo): sem origem.
      expect(await atribuicaoBar001()).toMatchObject({ status: 'sem_origem', evidence: null, reason: 'canal_sem_clique' });

      const estados = await estadosBarra();
      const cupons = estados.find((e) => e.dataset === 'cupons')!;
      expect(cupons.last_error).toBe('definitivo: HTTP 404');
      // Erro definitivo: os cupons esperam 6 h; os pedidos e os avisos seguem no ritmo deles.
      expect(cupons.cursor).toMatchObject({ espera_ate: depoisDe(6 * 60).toISOString(), falha: 'definitivo', falhas_seguidas: 1 });
      const pedidosEstado = estados.find((e) => e.dataset === 'pedidos')!;
      expect(pedidosEstado.last_error).toBeNull();
      expect(pedidosEstado.cursor).toMatchObject({ cursor: 'bar-c1', carga_inicial_em: TB0.toISOString(), proxima: depoisDe(15).toISOString() });
      expect(pedidosEstado.cursor.espera_ate).toBeUndefined();
      expect(estados.find((e) => e.dataset === 'clientes_anonimizados')!.last_error).toBeNull();

      // A execução diz o que falhou; a conta mostra o erro só dos cupons.
      expect(await ultimaExecucao()).toEqual({ status: 'parcial', error: 'cupons: definitivo: HTTP 404' });
      expect(await situacao()).toEqual({ status: 'erro', status_reason: 'A leitura dos cupons falhou; tentamos de novo mais tarde.' });

      // 20 minutos depois (a loja voltou para a fila em 15): os cupons esperam a vez deles e os outros seguem.
      barra.rotas.length = 0;
      const r2 = await sincronizador.sincronizar(contaBarra, tenantId, depoisDe(20));
      expect(r2).toMatchObject({ status: 'ok', falhas: {}, adiados: ['cupons'] });
      expect(barra.rotas).not.toContain('cupons');
      expect(barra.rotas).toContain('pedidos');
      expect(barra.rotas).toContain('clientes/anonimizados');
      // A loja volta quando os pedidos pedem (15 min), não quando os cupons voltam (6 h); a conta segue com o erro.
      const [p] = await ownerQuery<{ proxima: string }>(`select cursor->>'proxima' as proxima from liame.sync_state where connected_account_id = $1 and dataset = 'pedidos'`, [
        contaBarra,
      ]);
      expect(p?.proxima).toBe(depoisDe(20 + 15).toISOString());
      expect((await situacao())?.status).toBe('erro');
    });

    it('o cupom que chega depois dos pedidos que o citam religa a atribuição; o que o banco recusaria fica de fora', async () => {
      barra.cupons = 'ok';
      barra.rotas.length = 0;
      const aviso = vi.spyOn(Logger.prototype, 'warn');
      try {
        // 7 h depois: a espera dos cupons (6 h) passou.
        const r = await sincronizador.sincronizar(contaBarra, tenantId, depoisDe(7 * 60));
        expect(r).toMatchObject({ status: 'ok', cupons: 1, cuponsIgnorados: 2, atribuidos: 1, falhas: {}, adiados: [] });
        expect(barra.rotas[0]).toBe('cupons');
        // O cupom ligado à campanha agora tem o código que o pedido citou: o pedido passa a ser da campanha, pelo cupom.
        expect(await atribuicaoBar001()).toEqual({ status: 'atribuido', evidence: 'cupom', provider: 'meta_ads', counted: true, reason: null, campanha: '120215566778899' });
        const cupons = await ownerQuery<{ external_id: string; code: string; versao: string }>(
          `select external_id, code, source_version::text as versao from liame.coupon where connected_account_id = $1 order by external_id`,
          [contaBarra],
        );
        expect(cupons).toEqual([{ external_id: 'cup-barra', code: 'BARRA15', versao: '2' }]);
        // Cada cupom de fora vai para o log com o motivo, sem o código nem o nome (podem ter nome de gente).
        const log = aviso.mock.calls.map((c) => String(c[0])).find((m) => m.includes('ficaram de fora'));
        expect(log).toContain('"cup-sem-limite" (limite ou contagem de usos acima do que o banco guarda)');
        expect(log).toContain('"cup-espacos" (código vazio ou com mais de 60 caracteres)');
        expect(log).not.toMatch(/MARIA|Maria/);
      } finally {
        aviso.mockRestore();
      }
      const cuponsEstado = (await estadosBarra()).find((e) => e.dataset === 'cupons')!;
      expect(cuponsEstado.last_error).toBeNull();
      expect(cuponsEstado.cursor).toMatchObject({ cursor: 'bcup-c1', falhas_seguidas: 0 });
      expect(cuponsEstado.cursor.espera_ate).toBeUndefined();
      expect(cuponsEstado.cursor.falha).toBeUndefined();
      expect(await situacao()).toEqual({ status: 'ativa', status_reason: null });
      // A atribuição refeita pelo cupom fica registrada com o gatilho dela (uma execução, a desta página).
      const [n] = await ownerQuery<{ n: string }>(`select count(*)::text as n from liame.attribution_run where tenant_id = $1 and trigger = 'cupons'`, [tenantId]);
      expect(n?.n).toBe('1');
    });

    it('token recusado continua parando tudo: depois do 401, nenhum outro conjunto é lido', async () => {
      barra.tokenRevogado = true;
      barra.rotas.length = 0;
      const r = await sincronizador.sincronizar(contaBarra, tenantId, depoisDe(8 * 60));
      expect(r).toEqual({ status: 'falhou', erro: 'autenticacao: HTTP 401' });
      expect(barra.rotas).toEqual(['cupons']);
      expect(await ultimaExecucao()).toEqual({ status: 'falhou', error: 'cupons: autenticacao: HTTP 401' });
      const conta = await situacao();
      expect(conta?.status).toBe('desconectada');
      expect(conta?.status_reason).toContain('conecte de novo');
    });
  });
});
