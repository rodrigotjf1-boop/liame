import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { createDatabase, type Database, withTenant } from '@liame/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MODELO_PADRAO } from '../../src/attribution/motor.js';
import { SincronizadorConversas } from '../../src/attribution/sincronizador-conversas.js';
import { loadConfig } from '../../src/config.js';
import { registrarConexaoDaDistribuicao } from '../../src/connections/distribuicao.js';
import { gravarPedidos } from '../../src/orders/order-store.js';
import { VaultService } from '../../src/vault/vault.service.js';
import { ConversasLoop } from '../../src/worker/conversas-loop.js';
import { enableMfa, ownerQuery, resetIpRateLimits, signupAndLogin, startApi, type TestApi } from '../helpers/api.js';
import { APP_URL, hasDb } from './env.js';

// A2.5 · F7: conector do RegemCast (leitura das conversas abertas por anúncio) contra um RegemCast falso que
// fala o MCP 2026-07-28 sem estado, com respostas no formato do contrato v2 (docs/integracoes/regemcast.md;
// test/fixtures/regemcast/v2; erros copiados do servidor real). Distribuição (token conferido pela
// `integracao_situacao`), carga inicial de 90 dias com cursor, telefone só como índice cego, conversa que
// liga o pedido ao anúncio, leitura incremental, os erros do contrato (erro interno, recusa, resposta fora
// do contrato, ferramenta fora do escopo, token revogado), o laço do worker e a revogação dos dois lados.

const FIX = resolve(import.meta.dirname, '../fixtures/regemcast/v2');
const fixture = (arquivo: string) => JSON.parse(readFileSync(resolve(FIX, arquivo), 'utf8')) as Record<string, unknown>;
const TOKEN = `rct_it_${'L'.repeat(43)}`;
const TOKEN_2 = `rct_it_${'D'.repeat(43)}`;
const TOKEN_REGEM = `rct_it_${'R'.repeat(43)}`;
const TOKEN_INVALIDO = `rct_it_${'X'.repeat(43)}`;
const CONTA_2 = '7d1c0b6e-2f4a-4c8e-9b1d-5a3e6f8c2d42';
const T0 = new Date('2026-09-28T12:00:00Z');
const mais = (min: number) => new Date(T0.getTime() + min * 60_000);
const ERRO_INTERNO = 'Erro interno ao ler os dados da conta. Tente de novo em instantes.';

type Chamada = { ferramenta: string; argumentos: Record<string, unknown>; cabecalhos: IncomingHttpHeaders; meta: Record<string, unknown> };

describe.skipIf(!hasDb)('conector do RegemCast: conversas abertas por anúncio (A2.5 · F7)', () => {
  let api: TestApi;
  let database: Database;
  let regemcast: Server;
  let base = '';
  const anterior: Record<string, string | undefined> = {};
  const estado = {
    nova: false,
    erroInterno: false,
    recusa: false,
    foraDoContrato: false,
    semEscopo: false,
  };
  const revogados = new Set<string>();
  const chamadas: Chamada[] = [];
  let tenantId = '';
  let contaId = '';
  let marcaId = '';
  let cookie = '';
  let conexaoId = '';
  let sincronizador: SincronizadorConversas;
  const situacao = fixture('situacao.json');

  const resultado = (sc: unknown) => ({ result: { content: [{ type: 'text', text: JSON.stringify(sc) }], structuredContent: sc, resultType: 'complete', _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'regemcast', version: '1.0.0' } } } });
  const recusada = (texto: string) => ({ result: { content: [{ type: 'text', text: texto }], isError: true, resultType: 'complete' } });

  /** A situação que cada token conhecido devolve (o mapa dispensa comparar o token com `===`). */
  const perfis = new Map<string, Record<string, unknown>>([
    [TOKEN, situacao],
    [TOKEN_2, { ...situacao, contaId: CONTA_2, conta: 'Mister Burgers Barra' }],
    [TOKEN_REGEM, { ...situacao, produto: 'regem' }],
  ]);

  function responder(credencial: string, corpo: { id?: unknown; params?: { name?: string; arguments?: Record<string, unknown> } }): { status: number; corpo: unknown } {
    const perfil = perfis.get(credencial);
    if (!perfil || revogados.has(credencial)) return { status: 401, corpo: { mensagem: 'Token de integração inválido ou revogado.' } };
    const nome = corpo.params?.name ?? '';
    const args = corpo.params?.arguments ?? {};
    const comId = (r: object) => ({ jsonrpc: '2.0', id: corpo.id, ...r });
    if (nome === 'integracao_situacao') return { status: 200, corpo: comId(resultado(perfil)) };
    if (nome === 'integracao_revogar') {
      if (args.confirmar !== true) return { status: 200, corpo: comId(recusada('Input validation error: confirmar')) };
      revogados.add(credencial);
      return { status: 200, corpo: comId(resultado({ revogado: true, revogadoEm: new Date().toISOString() })) };
    }
    if (nome !== 'conversas_anuncio_listar' || estado.semEscopo) return { status: 200, corpo: comId({ error: { code: -32602, message: `Tool ${nome} not found` } }) };
    if (estado.erroInterno) return { status: 200, corpo: comId(recusada(ERRO_INTERNO)) };
    if (estado.recusa) return { status: 200, corpo: comId(recusada('O cursor não é válido. Recomece a leitura sem cursor.')) };
    if (estado.foraDoContrato) return { status: 200, corpo: comId(resultado({ itens: [], proximo_cursor: 'cv-c9' })) };
    const cursor = typeof args.cursor === 'string' ? args.cursor : null;
    if (!cursor) return { status: 200, corpo: comId(resultado(fixture('conversas-1.json'))) };
    if (cursor === 'cv-c1') return { status: 200, corpo: comId(resultado(fixture('conversas-2.json'))) };
    if (cursor === 'cv-c2' && estado.nova) return { status: 200, corpo: comId(resultado(fixture('conversas-nova.json'))) };
    return { status: 200, corpo: comId(resultado({ itens: [], proximo_cursor: cursor, tem_mais: false })) };
  }

  const toques = () =>
    ownerQuery<{ external_id: string; provider: string; ad_external_id: string | null; ctwa_clid: string | null; tem_cliente: boolean }>(
      `select external_id, provider, ad_external_id, ctwa_clid, customer_ref_id is not null as tem_cliente
         from liame.touchpoint where connected_account_id = $1 and kind = 'conversa' order by external_id`,
      [contaId],
    );
  const estadoDaLeitura = async () =>
    (
      await ownerQuery<{ cursor: Record<string, unknown>; last_error: string | null }>(
        `select cursor, last_error from liame.sync_state where connected_account_id = $1 and dataset = 'conversas_anuncio'`,
        [contaId],
      )
    )[0];
  const situacaoDaConta = async (id = contaId) =>
    (await ownerQuery<{ status: string; status_reason: string | null }>(`select status, status_reason from liame.connected_account where id = $1`, [id]))[0];

  beforeAll(async () => {
    regemcast = createServer((req, res) => {
      const partes: Buffer[] = [];
      req.on('data', (d: Buffer) => partes.push(d));
      req.on('end', () => {
        try {
          const corpo = JSON.parse(Buffer.concat(partes).toString('utf8') || '{}') as { id?: unknown; method?: string; params?: { name?: string; arguments?: Record<string, unknown>; _meta?: Record<string, unknown> } };
          const ferramenta = corpo.params?.name ?? '';
          chamadas.push({ ferramenta, argumentos: corpo.params?.arguments ?? {}, cabecalhos: req.headers, meta: corpo.params?._meta ?? {} });
          const url = new URL(req.url ?? '/', base);
          let r: { status: number; corpo: unknown };
          if (url.pathname !== '/cast/mcp' || req.method !== 'POST') r = { status: 405, corpo: { mensagem: 'só POST' } };
          // Como o servidor de verdade (especificação 2026-07-28): o cabeçalho tem de bater com o corpo.
          else if (req.headers['mcp-method'] !== corpo.method || req.headers['mcp-name'] !== ferramenta) r = { status: 400, corpo: { jsonrpc: '2.0', id: corpo.id, error: { code: -32020, message: 'header mismatch' } } };
          else r = responder((req.headers.authorization ?? '').replace(/^Bearer /, ''), corpo);
          res.writeHead(r.status, { 'content-type': 'application/json', ...(r.status === 401 ? { 'www-authenticate': 'Bearer error="invalid_token"' } : {}) });
          res.end(JSON.stringify(r.corpo));
        } catch {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end('{}');
        }
      });
    });
    await new Promise<void>((ok) => regemcast.listen(0, '127.0.0.1', ok));
    base = `http://127.0.0.1:${(regemcast.address() as AddressInfo).port}`;
    anterior.REGEMCAST_API_URL = process.env.REGEMCAST_API_URL;
    process.env.REGEMCAST_API_URL = `${base}/cast`;
    api = await startApi();
    await resetIpRateLimits();
    database = createDatabase({ connectionString: APP_URL, max: 3, applicationName: 'liame-test' });
    sincronizador = new SincronizadorConversas(database.db, api.app.get(VaultService), loadConfig());

    const s = await signupAndLogin(api, undefined, 'Mister Burgers Conversas');
    await enableMfa(api, s.cookie);
    cookie = s.cookie;
    tenantId = s.me.active_organization_id as string;
    const [marca] = await ownerQuery<{ id: string }>(`select id from liame.brand where tenant_id = $1 limit 1`, [tenantId]);
    marcaId = marca!.id;

    // O anúncio da Meta (já sincronizado pela A2) e a loja do Regem com um pedido do cliente que conversou.
    const meta = randomUUID();
    await ownerQuery(`insert into liame.connected_account (id, tenant_id, brand_id, provider, external_id, name, currency, timezone) values ($1, $2, $3, 'meta_ads', $4, 'CA - Mister', 'BRL', 'America/Sao_Paulo')`, [
      meta,
      tenantId,
      marcaId,
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
    const regem = randomUUID();
    await ownerQuery(`insert into liame.connected_account (id, tenant_id, brand_id, provider, external_id, name, currency, timezone) values ($1, $2, $3, 'regem', $4, 'Loja Centro', 'BRL', 'America/Sao_Paulo')`, [
      regem,
      tenantId,
      marcaId,
      `loja-${randomUUID().slice(0, 8)}`,
    ]);
    const vault = api.app.get(VaultService);
    await withTenant(database.db, tenantId, async (tx) => {
      const indice = await vault.blindIndexFor(tx, tenantId, '+5521988887777');
      await gravarPedidos(tx, { tenantId, brandId: marcaId, unitId: null, connectedAccountId: regem, provider: 'regem' }, [
        {
          externalId: 'ped-conversa-1',
          channel: 'whatsapp',
          channelGroup: 'whatsapp',
          status: 'confirmado',
          currency: 'BRL',
          timezone: 'America/Sao_Paulo',
          revenueMicros: 59_900_000n,
          discountMicros: 0n,
          refundedMicros: 0n,
          couponCode: null,
          customer: { phoneIndex: indice, externalId: 'cli-conversa-1' },
          isNewCustomer: true,
          placedAt: '2026-09-28T11:25:00.000Z',
          confirmedAt: '2026-09-28T11:30:00.000Z',
          cancelledAt: null,
          version: 1n,
          sourceUpdatedAt: '2026-09-28T11:30:00.000Z',
          items: [{ externalId: 'it-1', name: 'Combo sexta', quantity: '1', revenueMicros: 59_900_000n, costMicros: null }],
        },
      ]);
    });
  });
  afterAll(async () => {
    await api?.close();
    await database?.close();
    await new Promise((ok) => regemcast?.close(ok));
    if (anterior.REGEMCAST_API_URL === undefined) delete process.env.REGEMCAST_API_URL;
    else process.env.REGEMCAST_API_URL = anterior.REGEMCAST_API_URL;
  });

  it('distribuição: confere o token pela situação, recusa o que não serve e grava a conexão com a conta descoberta', async () => {
    const deps = { db: database.db, vault: api.app.get(VaultService), config: loadConfig() };
    const registrar = (tokens: string[]) => registrarConexaoDaDistribuicao(deps, { tenantId, brandId: marcaId, produto: 'regemcast', tokens });
    await expect(registrar(['rgm_it_nao-e-do-regemcast'])).rejects.toThrow(/fora do formato do RegemCast/);
    await expect(registrar([TOKEN_INVALIDO])).rejects.toThrow(/RegemCast recusou um dos tokens/);
    await expect(registrar([TOKEN_REGEM])).rejects.toThrow(/emitido para o produto "regem", não para o Liame/);

    const conexao = await registrar([TOKEN]);
    conexaoId = conexao.connectionId;
    expect(conexao.lojas).toEqual([
      {
        provider: 'regemcast',
        external_id: situacao.contaId,
        name: 'Mister Burgers',
        currency: null,
        timezone: 'America/Sao_Paulo',
        provider_attributes: { escopos: ['conversas.anuncio.ler'], classe: 'dms', token_nome: 'Liame — piloto' },
      },
    ]);
    // A chamada que conferiu o token foi o MCP de verdade: cabeçalhos e metadados da versão 2026-07-28.
    const conferencia = chamadas.find((x) => x.ferramenta === 'integracao_situacao' && x.cabecalhos.authorization === `Bearer ${TOKEN}`)!;
    expect(conferencia.cabecalhos['mcp-protocol-version']).toBe('2026-07-28');
    expect(conferencia.cabecalhos.accept).toBe('application/json, text/event-stream');
    expect(conferencia.meta['io.modelcontextprotocol/protocolVersion']).toBe('2026-07-28');
    expect(conferencia.meta['io.modelcontextprotocol/clientInfo']).toEqual({ name: 'liame', version: 'v2' });

    // O token fica só cifrado no cofre, com a finalidade do RegemCast; nada dele na conexão.
    const [g] = await ownerQuery<{ purpose: string; texto: string }>(
      `select s.purpose, (o.discovered::text || coalesce(array_to_string(o.scopes, ','), '')) as texto
         from liame.oauth_connection o join liame.secret s on s.id = o.credential_secret_id where o.id = $1`,
      [conexaoId],
    );
    expect(g?.purpose).toBe('oauth_regemcast');
    expect(g?.texto).not.toContain('rct_it_');

    const ligar = await api.call('POST', `/v1/connections/${conexaoId}/accounts`, { cookie, body: { accounts: [{ provider: 'regemcast', external_id: situacao.contaId }] } });
    expect(ligar.status).toBe(200);
    contaId = ligar.body.linked[0].id;
  });

  it('carga inicial: 90 dias pelo cursor, um toque por conversa, telefone só como índice cego', async () => {
    chamadas.length = 0;
    const r = await sincronizador.sincronizar(contaId, tenantId, T0);
    expect(r).toMatchObject({ status: 'ok', conversas: 4, toques: 4 });

    const listar = chamadas.filter((x) => x.ferramenta === 'conversas_anuncio_listar');
    expect(listar).toHaveLength(2);
    expect(listar[0]!.argumentos).toEqual({ limite: 200, desde: new Date(T0.getTime() - 90 * 86_400_000).toISOString() });
    expect(listar[1]!.argumentos).toMatchObject({ cursor: 'cv-c1' });
    for (const x of listar) {
      expect(x.cabecalhos['mcp-method']).toBe('tools/call');
      expect(x.cabecalhos['mcp-name']).toBe('conversas_anuncio_listar');
    }

    expect(await toques()).toEqual([
      { external_id: 'conversa:0b2d6c1a-9e1f-4b3a-8c2d-1f0e9a8b7c61', provider: 'meta_ads', ad_external_id: '120215566771111', ctwa_clid: 'ARAkLkA8rmlFeiCktEJQ-teste-1', tem_cliente: true },
      { external_id: 'conversa:0b2d6c1a-9e1f-4b3a-8c2d-1f0e9a8b7c62', provider: 'meta_ads', ad_external_id: '120215566771111', ctwa_clid: null, tem_cliente: true },
      // Publicação, não anúncio: entra como conversa da Meta, sem anúncio.
      { external_id: 'conversa:0b2d6c1a-9e1f-4b3a-8c2d-1f0e9a8b7c63', provider: 'meta_ads', ad_external_id: null, ctwa_clid: null, tem_cliente: true },
      { external_id: 'conversa:0b2d6c1a-9e1f-4b3a-8c2d-1f0e9a8b7c64', provider: 'meta_ads', ad_external_id: '120215566771111', ctwa_clid: 'ARAkLkA8rmlFeiCktEJQ-teste-4', tem_cliente: true },
    ]);

    // Nenhum telefone em claro em lugar nenhum do que a leitura gravou.
    const [claro] = await ownerQuery<{ n: string }>(
      `select (select count(*) from liame.touchpoint t where t.connected_account_id = $1 and t::text ~ '9888877|9777766|9666655|9555544')
            + (select count(*) from liame.customer_ref r where r.tenant_id = $2 and r::text ~ '9888877|9777766|9666655|9555544')
            + (select count(*) from liame.sync_state s where s.connected_account_id = $1 and s::text ~ '9888877|9777766')
            + (select count(*) from liame.sync_run x where x.connected_account_id = $1 and x::text ~ '9888877|9777766') as n`,
      [contaId, tenantId],
    );
    expect(claro?.n).toBe('0');

    const e = await estadoDaLeitura();
    expect(e?.cursor).toMatchObject({ cursor: 'cv-c2', carga_inicial_em: T0.toISOString(), proxima: mais(15).toISOString(), falhas_seguidas: 0 });
    expect(e?.last_error).toBeNull();
    const [run] = await ownerQuery<{ kind: string; status: string; api_version: string; entities_written: number }>(
      `select kind, status, api_version, entities_written from liame.sync_run where connected_account_id = $1 order by started_at limit 1`,
      [contaId],
    );
    expect(run).toEqual({ kind: 'carga_inicial', status: 'ok', api_version: 'v2', entities_written: 4 });

    // Nos Resultados, a fonte RegemCast mostra a leitura das conversas (e não a dos pedidos, que ela não tem).
    const res = await api.call('GET', `/v1/results/closed-loop?${new URLSearchParams({ brand_id: marcaId, from: '2026-09-27', to: '2026-09-28' })}`, { cookie });
    expect(res.status).toBe(200);
    const fonte = (res.body.sources as { provider: string; dataset: string; last_success_at: string | null }[]).find((s) => s.provider === 'regemcast');
    expect(fonte).toMatchObject({ dataset: 'conversas_anuncio' });
    expect(fonte?.last_success_at).not.toBeNull();
  });

  it('a conversa aberta pelo anúncio liga o pedido do mesmo cliente à campanha', async () => {
    const r = await ownerQuery<{ evidence: string | null; provider: string | null; campanha: string | null }>(
      `select r.evidence, r.provider, c.external_id as campanha
         from liame.attribution_result r join liame.order_fact o on o.id = r.order_id left join liame.campaign c on c.id = r.campaign_id
        where o.tenant_id = $1 and o.external_id = 'ped-conversa-1' and r.model_id = $2`,
      [tenantId, MODELO_PADRAO],
    );
    expect(r).toEqual([{ evidence: 'conversa_anuncio', provider: 'meta_ads', campanha: '120215566778899' }]);
  });

  it('incremental: só pelo cursor, sem o "desde"; nada novo devolve o mesmo cursor', async () => {
    chamadas.length = 0;
    estado.nova = true;
    let r = await sincronizador.sincronizar(contaId, tenantId, mais(20));
    expect(r).toMatchObject({ status: 'ok', conversas: 1, toques: 1 });
    expect(chamadas.filter((x) => x.ferramenta === 'conversas_anuncio_listar').map((x) => x.argumentos)).toEqual([{ limite: 200, cursor: 'cv-c2' }]);
    const [run] = await ownerQuery<{ kind: string }>(`select kind from liame.sync_run where connected_account_id = $1 order by started_at desc limit 1`, [contaId]);
    expect(run?.kind).toBe('incremental');

    r = await sincronizador.sincronizar(contaId, tenantId, mais(40));
    expect(r).toMatchObject({ status: 'ok', conversas: 0, toques: 0 });
    expect((await estadoDaLeitura())?.cursor).toMatchObject({ cursor: 'cv-c3', proxima: mais(55).toISOString() });
    expect(await toques()).toHaveLength(5);
  });

  it('erro interno do RegemCast: passageiro (30 min), a conta segue ativa; depois volta a ler', async () => {
    estado.erroInterno = true;
    let r = await sincronizador.sincronizar(contaId, tenantId, mais(60));
    expect(r.status).toBe('falhou');
    const e = await estadoDaLeitura();
    expect(e?.cursor).toMatchObject({ falha: 'transitorio', espera_ate: mais(90).toISOString(), cursor: 'cv-c3' });
    expect(e?.last_error).toContain('Erro interno');
    expect((await situacaoDaConta())?.status).toBe('ativa');
    // Antes da espera vencer, a vez é adiada sem chamar o RegemCast.
    chamadas.length = 0;
    r = await sincronizador.sincronizar(contaId, tenantId, mais(70));
    expect(r.status).toBe('adiada');
    expect(chamadas).toHaveLength(0);
    estado.erroInterno = false;
    r = await sincronizador.sincronizar(contaId, tenantId, mais(95));
    expect(r.status).toBe('ok');
  });

  it('recusa da ferramenta e resposta fora do contrato: definitivos (6 h), a conta mostra erro e nada torto entra', async () => {
    estado.recusa = true;
    let r = await sincronizador.sincronizar(contaId, tenantId, mais(120));
    expect(r.status).toBe('falhou');
    expect(r.erro).toContain('O cursor não é válido');
    expect((await estadoDaLeitura())?.cursor).toMatchObject({ falha: 'definitivo', espera_ate: mais(120 + 360).toISOString() });
    expect(await situacaoDaConta()).toEqual({ status: 'erro', status_reason: 'A leitura das conversas abertas por anúncio falhou; tentamos de novo mais tarde.' });
    estado.recusa = false;

    estado.foraDoContrato = true;
    r = await sincronizador.sincronizar(contaId, tenantId, mais(500));
    expect(r.erro).toContain('resposta fora do contrato em conversas_anuncio_listar (tem_mais)');
    expect(await toques()).toHaveLength(5);
    estado.foraDoContrato = false;

    r = await sincronizador.sincronizar(contaId, tenantId, mais(900));
    expect(r.status).toBe('ok');
    expect((await situacaoDaConta())?.status).toBe('ativa');
  });

  it('ferramenta fora das permissões do token: sem permissão, espera um dia, sem desligar a conta', async () => {
    estado.semEscopo = true;
    const r = await sincronizador.sincronizar(contaId, tenantId, mais(1000));
    expect(r.status).toBe('sem_permissao');
    expect((await estadoDaLeitura())?.cursor).toMatchObject({ falha: 'permissao', espera_ate: mais(1000 + 1440).toISOString() });
    expect((await situacaoDaConta())?.status).toBe('ativa');
    estado.semEscopo = false;
  });

  it('o laço do worker lê a conta devida desta empresa', async () => {
    const loop = new ConversasLoop(database, loadConfig(), api.app.get(VaultService));
    const resultados = await loop.executarLote(5, { tenantIds: [tenantId] }, mais(3000));
    expect(resultados).toEqual([expect.objectContaining({ status: 'ok' })]);
  });

  it('desligar a conta no Liame chama a revogação do próprio token no RegemCast', async () => {
    const deps = { db: database.db, vault: api.app.get(VaultService), config: loadConfig() };
    const conexao = await registrarConexaoDaDistribuicao(deps, { tenantId, brandId: marcaId, produto: 'regemcast', tokens: [TOKEN_2] });
    const ligar = await api.call('POST', `/v1/connections/${conexao.connectionId}/accounts`, { cookie, body: { accounts: [{ provider: 'regemcast', external_id: CONTA_2 }] } });
    expect(ligar.status).toBe(200);
    const desligar = await api.call('DELETE', `/v1/connected-accounts/${ligar.body.linked[0].id}`, { cookie });
    expect(desligar.status).toBe(204);
    for (let i = 0; i < 100 && !revogados.has(TOKEN_2); i++) await new Promise((ok) => setTimeout(ok, 20));
    expect(revogados.has(TOKEN_2)).toBe(true);
    const revogar = chamadas.find((x) => x.ferramenta === 'integracao_revogar');
    expect(revogar?.argumentos).toEqual({ confirmar: true });
  });

  it('token revogado no RegemCast (401): a conta fica desconectada, pedindo para conectar de novo', async () => {
    revogados.add(TOKEN);
    const r = await sincronizador.sincronizar(contaId, tenantId, mais(4000));
    expect(r.status).toBe('falhou');
    expect(await situacaoDaConta()).toEqual({ status: 'desconectada', status_reason: 'O RegemCast recusou a autorização desta conta: conecte de novo.' });
  });
});
