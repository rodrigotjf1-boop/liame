import { createHash, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { createDatabase, type Database, withTenant } from '@liame/database';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { registrarConexaoDaDistribuicao } from '../../src/connections/distribuicao.js';
import { newWebhookSecret, webhookHeaders } from '../../src/events/standard-webhooks.js';
import { gravarPedidos } from '../../src/orders/order-store.js';
import { VaultService } from '../../src/vault/vault.service.js';
import { ConexaoProcessor } from '../../src/worker/conexao-processor.js';
import { SincronizacaoLoop } from '../../src/worker/sincronizacao-loop.js';
import { enableMfa, ownerQuery, resetIpRateLimits, signupAndLogin, startApi, type TestApi } from '../helpers/api.js';
import { APP_URL, hasDb } from './env.js';

// A2.5 · F3: conectar o Regem (ADR-019) contra um "Regem" local que segue o contrato v1
// (docs/integracoes/regem.md): autorização com código + PKCE, um token por loja, lojas descobertas pelo
// próprio token, revogação dos dois lados, registro pela distribuição no piloto e webhook por conexão.

const API_PUBLICA = 'http://api.liame.test';
const VOLTA = `${API_PUBLICA}/v1/oauth/callback`;
const TOKEN_CENTRO = `rgm_it_${'C'.repeat(32)}`;
const TOKEN_PRAIA = `rgm_it_${'P'.repeat(32)}`;
const TOKEN_REVOGADO = `rgm_it_${'R'.repeat(32)}`;
const ESCOPOS = ['pedidos.ler', 'clientes.telefone.ler', 'custos.ler', 'cupons.ler', 'cupons.uso.ler'];

describe.skipIf(!hasDb)('conectar o Regem (A2.5 · F3)', () => {
  let api: TestApi;
  let database: Database;
  let processador: ConexaoProcessor;
  let regem: Server;
  let base = '';
  const desafios = new Set<string>();
  const revogados: string[] = [];
  const anterior: Record<string, string | undefined> = {};

  const lojas: Record<string, { loja_id: string; loja_nome: string }> = {
    [TOKEN_CENTRO]: { loja_id: 'loja-centro', loja_nome: 'Mister Burgers — Loja Centro' },
    [TOKEN_PRAIA]: { loja_id: 'loja-praia', loja_nome: 'Mister Burgers — Loja Praia' },
  };
  const loja = (token: string) => ({ ...lojas[token]!, empresa_nome: 'Mister Burgers', fuso: 'America/Sao_Paulo', moeda: 'BRL', escopos: ESCOPOS });

  function responder(req: IncomingMessage, texto: string): { status: number; corpo: unknown } {
    const url = new URL(req.url ?? '/', base);
    const token = req.headers.authorization?.replace(/^Bearer /, '') ?? '';
    const semAutorizacao = { status: 401, corpo: { type: 'https://api.dmsregem.com/problemas/token-invalido', title: 'Token inválido', status: 401 } };
    if (url.pathname === '/regem/loja') return lojas[token] ? { status: 200, corpo: loja(token) } : semAutorizacao;
    if (url.pathname === '/regem/autorizacao/token' && req.method === 'POST') {
      const b = JSON.parse(texto) as Record<string, string>;
      const desafio = createHash('sha256').update(b.code_verifier ?? '').digest('base64url');
      const ok = b.code === 'codigo-regem-bom' && desafios.has(desafio) && b.redirect_uri === VOLTA && b.client_id === 'liame' && b.client_secret === 'segredo-do-liame-no-regem';
      if (!ok) return { status: 400, corpo: { type: 'about:blank', title: 'Código inválido', status: 400 } };
      return { status: 200, corpo: { lojas: [{ ...loja(TOKEN_CENTRO), token: TOKEN_CENTRO }, { ...loja(TOKEN_PRAIA), token: TOKEN_PRAIA }] } };
    }
    if (url.pathname === '/regem/autorizacao/revogar' && req.method === 'POST') {
      if (!lojas[token]) return semAutorizacao;
      revogados.push(token);
      return { status: 200, corpo: {} };
    }
    return { status: 404, corpo: { type: 'about:blank', title: 'Não encontrado', status: 404 } };
  }

  beforeAll(async () => {
    regem = createServer((req, res) => {
      let texto = '';
      req.on('data', (c: Buffer) => {
        texto += c.toString('utf8');
      });
      req.on('end', () => {
        const r = responder(req, texto);
        res.writeHead(r.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(r.corpo));
      });
    });
    await new Promise<void>((ok) => regem.listen(0, '127.0.0.1', ok));
    base = `http://127.0.0.1:${(regem.address() as AddressInfo).port}`;
    const ambiente = {
      API_URL: API_PUBLICA,
      REGEM_API_URL: `${base}/regem`,
      REGEM_AUTH_URL: `${base}/regemapp`,
      REGEM_CLIENT_ID: 'liame',
      REGEM_CLIENT_SECRET: 'segredo-do-liame-no-regem',
    };
    for (const k of Object.keys(ambiente)) anterior[k] = process.env[k];
    Object.assign(process.env, ambiente);
    api = await startApi();
    await resetIpRateLimits();
    database = createDatabase({ connectionString: APP_URL, max: 3, applicationName: 'liame-test' });
    processador = new ConexaoProcessor(database, loadConfig(), api.app.get(VaultService));
  });
  afterAll(async () => {
    await api?.close();
    await database?.close();
    await new Promise((ok) => regem?.close(ok));
    for (const [k, v] of Object.entries(anterior)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  async function empresa(nome: string) {
    const s = await signupAndLogin(api, undefined, nome);
    await enableMfa(api, s.cookie);
    const tenantId = s.me.active_organization_id as string;
    const [marca] = await ownerQuery<{ id: string }>(`select id from liame.brand where tenant_id = $1 limit 1`, [tenantId]);
    const unitId = randomUUID();
    await ownerQuery(`insert into liame.unit (id, tenant_id, brand_id, name) values ($1, $2, $3, 'Loja Centro')`, [unitId, tenantId, marca!.id]);
    return { cookie: s.cookie, tenantId, brandId: marca!.id, unitId };
  }

  const conexao = async (id: string) =>
    (await ownerQuery<{ status: string; origin: string; error_code: string | null; credential_secret_id: string | null; discovered: { external_id: string; name: string; provider: string }[]; scopes: string[] }>(
      `select status, origin, error_code, credential_secret_id, discovered, scopes from liame.oauth_connection where id = $1`,
      [id],
    ))[0]!;

  it('produto: o presidente autoriza no Regem, o worker troca o código por um token por loja e a loja é ligada à loja do Liame', async () => {
    const e = await empresa('Mister Burgers Conexão');
    const inicio = await api.call('POST', '/v1/connections', { cookie: e.cookie, body: { provider: 'regem', brand_id: e.brandId } });
    expect(inicio.status).toBe(201);
    const autorizar = new URL(inicio.body.authorize_url);
    expect(`${autorizar.origin}${autorizar.pathname}`).toBe(`${base}/regemapp/integracoes/autorizar`);
    expect(Object.fromEntries(autorizar.searchParams)).toMatchObject({ cliente: 'liame', redirect_uri: VOLTA, code_challenge_method: 'S256' });
    desafios.add(autorizar.searchParams.get('code_challenge')!);

    const volta = await fetch(`${api.base}/v1/oauth/callback?${new URLSearchParams({ state: autorizar.searchParams.get('state')!, code: 'codigo-regem-bom' })}`, {
      headers: { cookie: e.cookie },
      redirect: 'manual',
    });
    expect(volta.status).toBe(303);
    expect(await processador.processarLote(5, { tenantIds: [e.tenantId] })).toBe(1);

    const pronta = await conexao(inicio.body.id);
    expect(pronta).toMatchObject({ status: 'aguardando_escolha', origin: 'oauth', error_code: null });
    expect(pronta.discovered.map((d) => [d.provider, d.external_id, d.name])).toEqual([
      ['regem', 'loja-centro', 'Mister Burgers — Loja Centro'],
      ['regem', 'loja-praia', 'Mister Burgers — Loja Praia'],
    ]);
    expect(pronta.scopes).toEqual([...ESCOPOS].sort());
    const [segredo] = await ownerQuery<{ purpose: string; ciphertext: string }>(`select purpose, ciphertext from liame.secret where id = $1`, [pronta.credential_secret_id]);
    expect(segredo!.purpose).toBe('oauth_regem');
    expect(segredo!.ciphertext).not.toContain(TOKEN_CENTRO);

    const lista = await api.call('GET', '/v1/connections', { cookie: e.cookie });
    expect(JSON.stringify(lista.body)).not.toContain('rgm_it_');

    // A loja do Regem entra ligada à loja do Liame (fuso da loja nos pedidos).
    const ligar = await api.call('POST', `/v1/connections/${inicio.body.id}/accounts`, {
      cookie: e.cookie,
      body: { accounts: [{ provider: 'regem', external_id: 'loja-centro', unit_id: e.unitId }] },
    });
    expect(ligar.status).toBe(200);
    expect(ligar.body.linked[0]).toMatchObject({ provider: 'regem', external_id: 'loja-centro', unit_id: e.unitId, timezone: 'America/Sao_Paulo', status: 'ativa' });

    // A sincronização de mídia não pega a loja do Regem (ela tem a leitura de vendas, F4).
    const loop = new SincronizacaoLoop(database, loadConfig(), api.app.get(VaultService));
    await loop.executarLote(5, { tenantIds: [e.tenantId] });
    const [estado] = await ownerQuery<{ n: string }>(
      `select count(*)::text as n from liame.sync_state s join liame.connected_account a on a.id = s.connected_account_id where a.tenant_id = $1 and s.dataset = 'metricas'`,
      [e.tenantId],
    );
    expect(estado?.n).toBe('0');

    // Revogar: o token sai do cofre na hora e é revogado no Regem depois do commit.
    const revogar = await api.call('DELETE', `/v1/connections/${inicio.body.id}`, { cookie: e.cookie });
    expect(revogar.status).toBe(204);
    for (let i = 0; i < 50 && revogados.length < 2; i++) await new Promise((ok) => setTimeout(ok, 20));
    expect(revogados.sort()).toEqual([TOKEN_CENTRO, TOKEN_PRAIA].sort());
    const [conta] = await ownerQuery<{ status: string }>(`select status from liame.connected_account where connection_id = $1`, [inicio.body.id]);
    expect(conta?.status).toBe('desconectada');
  });

  it('a loja do Liame precisa ser da marca da conexão', async () => {
    const e = await empresa('Mister Burgers Outra Marca');
    const r = await registrarConexaoDaDistribuicao(
      { db: database.db, vault: api.app.get(VaultService), config: loadConfig() },
      { tenantId: e.tenantId, brandId: e.brandId, produto: 'regem', tokens: [TOKEN_CENTRO] },
    );
    const outraMarca = randomUUID();
    const outraLoja = randomUUID();
    await ownerQuery(`insert into liame.brand (id, tenant_id, name) values ($1, $2, 'Outra marca')`, [outraMarca, e.tenantId]);
    await ownerQuery(`insert into liame.unit (id, tenant_id, brand_id, name) values ($1, $2, $3, 'Loja da outra marca')`, [outraLoja, e.tenantId, outraMarca]);
    const ligar = await api.call('POST', `/v1/connections/${r.connectionId}/accounts`, {
      cookie: e.cookie,
      body: { accounts: [{ provider: 'regem', external_id: 'loja-centro', unit_id: outraLoja }] },
    });
    expect(ligar.status).toBe(422);
    expect(ligar.body.type).toContain('loja-fora-da-marca');
  });

  it('sem loja escolhida, a loja do Regem ganha a loja do Liame com o nome e o fuso dela; ligar de novo ou achar uma de mesmo nome não cria outra (ERR-047)', async () => {
    const e = await empresa('Mister Burgers Sem Loja');
    const deps = { db: database.db, vault: api.app.get(VaultService), config: loadConfig() };
    // Já existe na marca uma loja com o nome da loja Praia do Regem (maiúsculas e espaço diferentes).
    const praia = randomUUID();
    await ownerQuery(`insert into liame.unit (id, tenant_id, brand_id, name) values ($1, $2, $3, ' mister burgers — loja PRAIA ')`, [praia, e.tenantId, e.brandId]);
    const r = await registrarConexaoDaDistribuicao(deps, { tenantId: e.tenantId, brandId: e.brandId, produto: 'regem', tokens: [TOKEN_CENTRO, TOKEN_PRAIA] });
    const ligar = await api.call('POST', `/v1/connections/${r.connectionId}/accounts`, {
      cookie: e.cookie,
      body: { accounts: [{ provider: 'regem', external_id: 'loja-centro' }, { provider: 'regem', external_id: 'loja-praia' }] },
    });
    expect(ligar.status).toBe(200);
    const lojasDoLiame = () => ownerQuery<{ id: string; name: string; timezone: string }>(`select id, name, timezone from liame.unit where tenant_id = $1 order by created_at, id`, [e.tenantId]);
    const unidades = await lojasDoLiame();
    // A do cadastro do teste, a que já existia com o nome da Praia e a nova, da Loja Centro do Regem.
    expect(unidades.map((u) => u.name.trim())).toEqual(['Loja Centro', 'mister burgers — loja PRAIA', 'Mister Burgers — Loja Centro']);
    const nova = unidades[2]!;
    expect(nova.timezone).toBe('America/Sao_Paulo');
    const lojaDe = new Map((ligar.body.linked as { external_id: string; unit_id: string | null }[]).map((l) => [l.external_id, l.unit_id]));
    expect(lojaDe.get('loja-centro')).toBe(nova.id);
    // A resposta leva a loja do Liame e o que a loja do Regem libera (tela Contas conectadas, P2).
    expect((ligar.body.linked as { external_id: string }[]).find((l) => l.external_id === 'loja-centro')).toMatchObject({ unit_name: 'Mister Burgers — Loja Centro', scopes: ESCOPOS });
    const lista = await api.call('GET', '/v1/connections', { cookie: e.cookie });
    const daLista = (lista.body.items as { id: string; scopes: string[]; origin: string; accounts: { unit_name: string | null; scopes: string[] }[] }[]).find((c) => c.id === r.connectionId)!;
    expect(daLista).toMatchObject({ origin: 'distribuicao', scopes: [...ESCOPOS].sort() });
    expect(daLista.accounts.map((a) => [a.unit_name?.trim(), a.scopes.length])).toEqual(expect.arrayContaining([['Mister Burgers — Loja Centro', ESCOPOS.length]]));
    expect(lojaDe.get('loja-praia')).toBe(praia);
    const [auditoria] = await ownerQuery<{ after: { lojas_criadas?: { id: string; name: string }[] } }>(
      `select after from liame.audit_event where tenant_id = $1 and resource_id = $2 and after ? 'lojas_criadas'`,
      [e.tenantId, r.connectionId],
    );
    expect(auditoria!.after.lojas_criadas).toEqual([{ id: nova.id, name: 'Mister Burgers — Loja Centro' }]);

    // Outra autorização da mesma loja (reconectar): a conta continua na mesma loja do Liame, sem loja nova.
    const r2 = await registrarConexaoDaDistribuicao(deps, { tenantId: e.tenantId, brandId: e.brandId, produto: 'regem', tokens: [TOKEN_CENTRO] });
    const deNovo = await api.call('POST', `/v1/connections/${r2.connectionId}/accounts`, { cookie: e.cookie, body: { accounts: [{ provider: 'regem', external_id: 'loja-centro' }] } });
    expect(deNovo.status).toBe(200);
    expect(deNovo.body.linked[0]).toMatchObject({ external_id: 'loja-centro', unit_id: nova.id });
    expect((await lojasDoLiame()).length).toBe(3);
  });

  it('migration 0027: a conta do Regem já ligada sem loja ganha a loja dela e os pedidos lidos passam a apontar para ela; de novo, nada muda', async () => {
    const e = await empresa('Mister Burgers Antes da Loja');
    const contaId = randomUUID();
    await ownerQuery(
      `insert into liame.connected_account (id, tenant_id, brand_id, unit_id, provider, external_id, name, currency, timezone)
       values ($1, $2, $3, null, 'regem', $4, '  Mister Burguer Steakhouse  ', 'BRL', 'America/Manaus')`,
      [contaId, e.tenantId, e.brandId, randomUUID()],
    );
    const agora = new Date().toISOString();
    await withTenant(database.db, e.tenantId, (tx) =>
      gravarPedidos(tx, { tenantId: e.tenantId, brandId: e.brandId, unitId: null, connectedAccountId: contaId, provider: 'regem' }, [
        {
          externalId: 'antes-da-loja-1',
          channel: 'cardapio',
          channelGroup: 'cardapio',
          status: 'confirmado',
          currency: 'BRL',
          timezone: 'America/Manaus',
          revenueMicros: 50_000_000n,
          discountMicros: 0n,
          refundedMicros: 0n,
          couponCode: null,
          customer: null,
          isNewCustomer: null,
          placedAt: null,
          confirmedAt: agora,
          cancelledAt: null,
          version: 1n,
          sourceUpdatedAt: agora,
          items: [],
        },
      ]),
    );

    // O arquivo da migration, só para esta empresa: os outros testes rodam no mesmo banco, em paralelo.
    const arquivo = await readFile(resolve(process.cwd(), '../../packages/database/migrations/0027_loja_do_regem.sql'), 'utf8');
    const escopo = "select set_config('app.scope', 'sistema', true);";
    expect(arquivo.split(escopo).length).toBe(2);
    const soDestaEmpresa = arquivo.replace(escopo, `select set_config('app.tenant_id', '${e.tenantId}', true);`);
    const aplicar = async () => {
      const cliente = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL_OWNER });
      await cliente.connect();
      try {
        await cliente.query(`begin; ${soDestaEmpresa}; commit;`);
      } finally {
        await cliente.end();
      }
    };
    await aplicar();
    const estado = () =>
      ownerQuery<{ unit_id: string | null; nome: string | null; fuso: string | null; pedido: string | null; lojas: string }>(
        `select a.unit_id, u.name as nome, u.timezone as fuso,
                (select o.unit_id::text from liame.order_fact o where o.connected_account_id = a.id) as pedido,
                (select count(*)::text from liame.unit where tenant_id = a.tenant_id) as lojas
           from liame.connected_account a left join liame.unit u on u.id = a.unit_id where a.id = $1`,
        [contaId],
      );
    const [depois] = await estado();
    expect(depois).toMatchObject({ nome: 'Mister Burguer Steakhouse', fuso: 'America/Manaus', lojas: '2' });
    expect(depois!.unit_id).not.toBeNull();
    expect(depois!.pedido).toBe(depois!.unit_id);

    await aplicar();
    expect((await estado())[0]).toEqual(depois);
  });

  it('piloto: a distribuição grava o token no cofre, sem passar pelo usuário; token recusado ou fora do formato não entra', async () => {
    const e = await empresa('Mister Burgers Piloto');
    const deps = { db: database.db, vault: api.app.get(VaultService), config: loadConfig() };
    const r = await registrarConexaoDaDistribuicao(deps, { tenantId: e.tenantId, brandId: e.brandId, produto: 'regem', tokens: [` ${TOKEN_CENTRO} `, '', TOKEN_CENTRO] });
    expect(r.lojas.map((l) => l.external_id)).toEqual(['loja-centro']);
    const c = await conexao(r.connectionId);
    expect(c).toMatchObject({ status: 'aguardando_escolha', origin: 'distribuicao' });
    const [auditoria] = await ownerQuery<{ actor_label: string; origin: string }>(
      `select actor_label, origin from liame.audit_event where tenant_id = $1 and action = 'conexao.registrar_distribuicao'`,
      [e.tenantId],
    );
    expect(auditoria).toEqual({ actor_label: 'Distribuição DMS', origin: 'console' });

    const detalhe = await api.call('GET', `/v1/connections/${r.connectionId}`, { cookie: e.cookie });
    expect(detalhe.body).toMatchObject({ origin: 'distribuicao', provider: 'regem', status: 'aguardando_escolha' });

    await expect(registrarConexaoDaDistribuicao(deps, { tenantId: e.tenantId, brandId: e.brandId, produto: 'regem', tokens: [TOKEN_REVOGADO] })).rejects.toThrow(/recusou/);
    await expect(registrarConexaoDaDistribuicao(deps, { tenantId: e.tenantId, brandId: e.brandId, produto: 'regem', tokens: ['token-qualquer'] })).rejects.toThrow(/formato/);
    await expect(registrarConexaoDaDistribuicao(deps, { tenantId: e.tenantId, brandId: randomUUID(), produto: 'regem', tokens: [TOKEN_CENTRO] })).rejects.toThrow(/marca/);
  });

  it('webhook por conexão: assinado com o segredo dela; outro segredo, conexão desconhecida ou revogada não entram', async () => {
    const e = await empresa('Mister Burgers Webhook');
    const vault = api.app.get(VaultService);
    const r = await registrarConexaoDaDistribuicao({ db: database.db, vault, config: loadConfig() }, { tenantId: e.tenantId, brandId: e.brandId, produto: 'regem', tokens: [TOKEN_PRAIA] });
    const segredo = newWebhookSecret();
    await withTenant(database.db, e.tenantId, async (tx) => {
      const id = await vault.putSecret(tx, { tenantId: e.tenantId, purpose: 'inbox_regem', plaintext: segredo });
      await tx.execute(sql`update liame.oauth_connection set inbox_secret_id = ${id} where id = ${r.connectionId}`);
    });
    const enviar = async (conexaoId: string, chave: string, id: string) => {
      const corpo = JSON.stringify({ tipo: 'pedido.alterado', id: 'ped-1', versao: 3 });
      const res = await fetch(`${api.base}/v1/inbox/regem/${conexaoId}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...webhookHeaders(chave, id, corpo) },
        body: corpo,
      });
      return res.status;
    };
    const eventoId = `msg_${randomUUID()}`;
    expect(await enviar(r.connectionId, segredo, eventoId)).toBe(202);
    expect(await enviar(r.connectionId, segredo, eventoId)).toBe(202);
    const eventos = await ownerQuery<{ tenant_id: string; connection_id: string }>(`select tenant_id, connection_id from liame.inbox_event where external_event_id = $1`, [eventoId]);
    expect(eventos).toEqual([{ tenant_id: e.tenantId, connection_id: r.connectionId }]);

    expect(await enviar(r.connectionId, newWebhookSecret(), `msg_${randomUUID()}`)).toBe(401);
    expect(await enviar(randomUUID(), segredo, `msg_${randomUUID()}`)).toBe(404);
    await ownerQuery(`update liame.oauth_connection set status = 'revogada' where id = $1`, [r.connectionId]);
    expect(await enviar(r.connectionId, segredo, `msg_${randomUUID()}`)).toBe(404);
  });

  // Tela "Contas conectadas" (P2, parte 2): o que a tela precisa para oferecer o Regem, ligar as lojas e revogar por loja.
  it('a lista diz que dá para conectar o Regem e as lojas da marca saem por nome; desligar uma loja revoga só o token dela; autorizar de novo troca a credencial da loja já ligada', async () => {
    const e = await empresa('Mister Burgers Lojas');
    await ownerQuery(`insert into liame.unit (id, tenant_id, brand_id, name) values ($1, $2, $3, 'barra')`, [randomUUID(), e.tenantId, e.brandId]);

    const lista = await api.call('GET', '/v1/connections', { cookie: e.cookie });
    expect(lista.body.available).toContain('regem');
    expect(lista.body.available).not.toContain('regemcast');
    const lojasDaMarca = await api.call('GET', `/v1/units?brand_id=${e.brandId}`, { cookie: e.cookie });
    expect(lojasDaMarca.status).toBe(200);
    expect((lojasDaMarca.body.items as { name: string; brand_id: string }[]).map((u) => [u.name, u.brand_id])).toEqual([
      ['barra', e.brandId],
      ['Loja Centro', e.brandId],
    ]);
    // Marca de outra empresa: a RLS não deixa ver as lojas dela.
    const outra = await empresa('Outra Empresa Lojas');
    expect((await api.call('GET', `/v1/units?brand_id=${e.brandId}`, { cookie: outra.cookie })).body.items).toEqual([]);

    const autorizar = async () => {
      const inicio = await api.call('POST', '/v1/connections', { cookie: e.cookie, body: { provider: 'regem', brand_id: e.brandId } });
      const url = new URL(inicio.body.authorize_url);
      desafios.add(url.searchParams.get('code_challenge')!);
      await fetch(`${api.base}/v1/oauth/callback?${new URLSearchParams({ state: url.searchParams.get('state')!, code: 'codigo-regem-bom' })}`, { headers: { cookie: e.cookie }, redirect: 'manual' });
      expect(await processador.processarLote(5, { tenantIds: [e.tenantId] })).toBe(1);
      return inicio.body.id as string;
    };
    const primeira = await autorizar();
    const ligar = await api.call('POST', `/v1/connections/${primeira}/accounts`, {
      cookie: e.cookie,
      body: { accounts: [{ provider: 'regem', external_id: 'loja-centro', unit_id: e.unitId }, { provider: 'regem', external_id: 'loja-praia' }] },
    });
    expect(ligar.status).toBe(200);
    const contas = ligar.body.linked as { id: string; external_id: string; connection_id: string }[];
    const centro = contas.find((c) => c.external_id === 'loja-centro')!;
    const praia = contas.find((c) => c.external_id === 'loja-praia')!;

    // Revogar por loja: só o token da Praia vai para a revogação no Regem; a Centro segue ligada.
    revogados.length = 0;
    expect((await api.call('DELETE', `/v1/connected-accounts/${praia.id}`, { cookie: e.cookie })).status).toBe(204);
    for (let i = 0; i < 50 && revogados.length < 1; i++) await new Promise((ok) => setTimeout(ok, 20));
    await new Promise((ok) => setTimeout(ok, 60));
    expect(revogados).toEqual([TOKEN_PRAIA]);
    const depois = await ownerQuery<{ external_id: string; status: string; desligada: boolean }>(
      `select external_id, status, disconnected_at is not null as desligada from liame.connected_account where connection_id = $1 order by external_id`,
      [primeira],
    );
    expect(depois).toEqual([
      { external_id: 'loja-centro', status: 'ativa', desligada: false },
      { external_id: 'loja-praia', status: 'desconectada', desligada: true },
    ]);
    const [auditoria] = await ownerQuery<{ after: Record<string, unknown> }>(
      `select after from liame.audit_event where chain_key = $1 and resource_id = $2 and action = 'conta.desconectar' order by chain_seq desc limit 1`,
      [e.tenantId, praia.id],
    );
    expect(auditoria?.after).toMatchObject({ provider: 'regem', external_id: 'loja-praia', revogada_no_regem: true });
    expect(JSON.stringify(auditoria)).not.toContain('rgm_it_');

    // Autorizar de novo (o Regem troca o token da loja): a MESMA conta passa para a autorização nova.
    const segunda = await autorizar();
    const religar = await api.call('POST', `/v1/connections/${segunda}/accounts`, { cookie: e.cookie, body: { accounts: [{ provider: 'regem', external_id: 'loja-centro' }] } });
    expect(religar.status).toBe(200);
    expect(religar.body.linked).toHaveLength(1);
    expect(religar.body.linked[0]).toMatchObject({ id: centro.id, connection_id: segunda, unit_id: e.unitId, status: 'ativa' });
    // A primeira autorização ficou sem loja nenhuma (a Praia foi revogada, a Centro passou para a nova): é encerrada,
    // a credencial dela sai do cofre e ela some da lista de autorizações que valem (ficava na tela com "0 lojas").
    const antiga = await conexao(primeira);
    expect(antiga.status).toBe('revogada');
    const [segredoAntigo] = await ownerQuery<{ revogado: boolean }>(`select revoked_at is not null as revogado from liame.secret where id = $1`, [antiga.credential_secret_id]);
    expect(segredoAntigo?.revogado).toBe(true);
    expect((await conexao(segunda)).status).toBe('ativa');
    const [conta] = await ownerQuery<{ status: string; desligada: boolean }>(`select status, disconnected_at is not null as desligada from liame.connected_account where id = $1`, [centro.id]);
    expect(conta).toEqual({ status: 'ativa', desligada: false });
    const [auditoriaDaTroca] = await ownerQuery<{ after: Record<string, unknown> }>(
      `select after from liame.audit_event where chain_key = $1 and resource_id = $2 and action = 'conta.conectar' order by chain_seq desc limit 1`,
      [e.tenantId, segunda],
    );
    expect(auditoriaDaTroca?.after).toMatchObject({ autorizacoes_encerradas: [primeira] });
  });

  it('RegemCast ainda sem autorização própria: 503, sem criar conexão', async () => {
    const e = await empresa('Mister Burgers RegemCast');
    const r = await api.call('POST', '/v1/connections', { cookie: e.cookie, body: { provider: 'regemcast', brand_id: e.brandId } });
    expect(r.status).toBe(503);
    const [n] = await ownerQuery<{ n: string }>(`select count(*)::text as n from liame.oauth_connection where tenant_id = $1`, [e.tenantId]);
    expect(n?.n).toBe('0');
  });
});
