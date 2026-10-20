import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { createDatabase, type Database } from '@liame/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { registrarConexaoDaDistribuicao } from '../../src/connections/distribuicao.js';
import { FLAG_REGEMCAST_POR_CLIQUE } from '../../src/connections/oauth.js';
import { FlagService } from '../../src/flags/flag.service.js';
import { VaultService } from '../../src/vault/vault.service.js';
import { ConexaoProcessor } from '../../src/worker/conexao-processor.js';
import { enableMfa, ownerQuery, resetIpRateLimits, signupAndLogin, startApi, type TestApi } from '../helpers/api.js';
import { APP_URL, hasDb } from './env.js';

// Hub DMS (F2, parte B, B1): conectar o RegemCast por clique, contra um RegemCast de mentira que segue o lado de lá
// (RegemCast #123 e #124: o pedido empurrado em `POST /integracao/autorizacao/pedido`, a página só com o aplicativo e o
// número do pedido, a volta com `code`, `state` e `iss`, a troca em `POST /integracao/autorizacao/token` que devolve o
// segredo da ligação, a `integracao_situacao` pela ligação no MCP) e um DMS ID de mentira (`/oidc/token`, client
// credentials). O mesmo servidor responde em `/regem` para pegar qualquer credencial do RegemCast mandada ao Regem.

const FIX = resolve(import.meta.dirname, '../fixtures/regemcast/v2');
const situacao = JSON.parse(readFileSync(resolve(FIX, 'situacao.json'), 'utf8')) as { contaId: string };
const API_PUBLICA = 'http://api.liame.test';
const VOLTA = `${API_PUBLICA}/v1/oauth/callback`;
const APLICATIVO = 'aplicativo-do-liame-no-clique';
/** O segredo do aplicativo do Liame no DMS ID de mentira (nome neutro, V123). */
const VALOR_DO_APLICATIVO = 'valor-do-aplicativo-de-teste-9876543210';
const TOKEN = `rct_it_${'D'.repeat(43)}`;
const PERMISSOES = ['conta.ler', 'campanhas.ler', 'publicos.ler', 'modelos.ler', 'orcamento.ler', 'conversas.anuncio.ler'];

type Pedido = { numero: string; corpo: Record<string, string>; autorizacao: string };

describe.skipIf(!hasDb)('conectar o RegemCast por clique (Hub DMS, B1)', () => {
  let api: TestApi;
  let database: Database;
  let processador: ConexaoProcessor;
  let servidor: Server;
  let base = '';
  const anterior: Record<string, string | undefined> = {};
  const pedidos: Pedido[] = [];
  /** Código → o pedido de onde veio (o "dono autorizou na página"). */
  const codigos = new Map<string, Pedido>();
  const usados = new Set<string>();
  const trocas: Record<string, string>[] = [];
  const ligacoes = new Set<string>();
  const tokensDoDmsId = new Set<string>();
  const tokensRecusados = new Set<string>();
  const pedidosDeToken: URLSearchParams[] = [];
  const chamadasAoRegem: string[] = [];
  const revogados: string[] = [];
  const mcp: { ferramenta: string; bearer: string; ligacao: string }[] = [];
  /** O RegemCast fora do ar no pedido (503). */
  let pedidoForaDoAr = false;
  /** A `integracao_situacao` pela ligação diz outra conta (defeito de alguém do lado de lá). */
  let outraContaNaLigacao = false;

  const problema = (tipo: string, status: number) => ({ type: `https://dev.dmstecnologias.com/erros/${tipo}`, title: tipo, status, detail: `recusado: ${tipo}` });
  const resultado = (id: unknown, sc: unknown) => ({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(sc) }], structuredContent: sc, resultType: 'complete' } });
  const bearerDe = (h: IncomingHttpHeaders) => (h.authorization ?? '').replace(/^Bearer /, '');

  function responder(metodo: string, caminho: string, h: IncomingHttpHeaders, texto: string): { status: number; corpo: unknown; problema?: boolean } {
    if (caminho.startsWith('/regem/')) {
      chamadasAoRegem.push(`${metodo} ${caminho} ${bearerDe(h).slice(0, 7)}`);
      return { status: 401, corpo: problema('token-invalido', 401), problema: true };
    }
    if (caminho === '/dmsid/oidc/token' && metodo === 'POST') {
      const params = new URLSearchParams(texto);
      pedidosDeToken.push(params);
      const esperado = `Basic ${Buffer.from(`${encodeURIComponent(APLICATIVO)}:${encodeURIComponent(VALOR_DO_APLICATIVO)}`).toString('base64')}`;
      if (h.authorization !== esperado || params.get('grant_type') !== 'client_credentials') return { status: 401, corpo: { error: 'invalid_client' } };
      const token = `tok-${tokensDoDmsId.size + 1}-${randomUUID()}`;
      tokensDoDmsId.add(token);
      return { status: 200, corpo: { access_token: token, token_type: 'Bearer', expires_in: 3600 } };
    }
    const doDmsId = tokensDoDmsId.has(bearerDe(h)) && !tokensRecusados.has(bearerDe(h));
    if (caminho === '/cast/integracao/autorizacao/pedido' && metodo === 'POST') {
      if (pedidoForaDoAr) return { status: 503, corpo: problema('indisponivel', 503), problema: true };
      if (!doDmsId) return { status: 401, corpo: problema('token-invalido', 401), problema: true };
      const corpo = JSON.parse(texto || '{}') as Record<string, string>;
      const numero = `urn:ietf:params:oauth:request_uri:rct_${randomBytes(32).toString('base64url')}`;
      pedidos.push({ numero, corpo, autorizacao: bearerDe(h) });
      return { status: 201, corpo: { request_uri: numero, expires_in: 600 } };
    }
    if (caminho === '/cast/integracao/autorizacao/token' && metodo === 'POST') {
      if (!doDmsId) return { status: 401, corpo: problema('token-invalido', 401), problema: true };
      const b = JSON.parse(texto || '{}') as Record<string, string>;
      trocas.push(b);
      const pedido = codigos.get(b.code ?? '');
      // Como o RegemCast: o código é gasto antes das conferências.
      if (!pedido || usados.has(b.code!)) return { status: 400, corpo: problema('autorizacao-invalida', 400), problema: true };
      usados.add(b.code!);
      const desafio = createHash('sha256').update(b.code_verifier ?? '').digest('base64url');
      if (desafio !== pedido.corpo.code_challenge || b.redirect_uri !== pedido.corpo.redirect_uri || b.grant_type !== 'authorization_code' || b.client_id !== APLICATIVO) {
        return { status: 400, corpo: problema('autorizacao-invalida', 400), problema: true };
      }
      const ligacao = `dms_lg_regemcast_${randomBytes(32).toString('base64url')}_${randomBytes(4).toString('base64url').slice(0, 6)}`;
      ligacoes.add(ligacao);
      return { status: 200, corpo: { ligacao, prefixo: ligacao.slice(0, 22), conta_id: situacao.contaId, conta: 'Mister Burgers', permissoes: PERMISSOES.slice(0, 5), segredo_em: new Date().toISOString() } };
    }
    if (caminho === '/cast/mcp' && metodo === 'POST') {
      const corpo = JSON.parse(texto || '{}') as { id?: unknown; params?: { name?: string } };
      const ferramenta = corpo.params?.name ?? '';
      const ligacao = String(h['dms-ligacao'] ?? '');
      mcp.push({ ferramenta, bearer: bearerDe(h), ligacao });
      if (bearerDe(h) === TOKEN) {
        if (ferramenta === 'integracao_revogar') {
          revogados.push(TOKEN);
          return { status: 200, corpo: resultado(corpo.id, { revogado: true, revogadoEm: new Date().toISOString() }) };
        }
        return { status: 200, corpo: resultado(corpo.id, { ...situacao, produto: 'liame', classe: 'dms', token: 'Liame — piloto' }) };
      }
      if (!doDmsId) return { status: 401, corpo: problema('token-invalido', 401), problema: true };
      if (!ligacoes.has(ligacao)) return { status: 401, corpo: problema('ligacao-invalida', 401), problema: true };
      const permissoes = PERMISSOES.slice(0, 5).map((id) => ({ id, rotulo: id, descricao: id }));
      const contaId = outraContaNaLigacao ? '0199f1aa-9999-7999-8999-999999999999' : situacao.contaId;
      return { status: 200, corpo: resultado(corpo.id, { ...situacao, contaId, produto: 'liame', classe: 'dms', token: 'Liame', permissoes }) };
    }
    return { status: 404, corpo: {} };
  }

  async function ligarFlag(tenantId: string) {
    await ownerQuery(`insert into liame.feature_flag_rule (id, flag_key, scope_type, scope_id, value, created_by) values (gen_random_uuid(), $1, 'tenant', $2, 'true'::jsonb, 'testes')`, [
      FLAG_REGEMCAST_POR_CLIQUE,
      tenantId,
    ]);
    api.app.get(FlagService).invalidate();
  }

  async function empresa(nome: string, comFlag = true) {
    const s = await signupAndLogin(api, undefined, nome);
    await enableMfa(api, s.cookie);
    const tenantId = s.me.active_organization_id as string;
    const [marca] = await ownerQuery<{ id: string; name: string }>(`select id, name from liame.brand where tenant_id = $1 limit 1`, [tenantId]);
    if (comFlag) await ligarFlag(tenantId);
    return { cookie: s.cookie, email: s.email, tenantId, brandId: marca!.id, marca: marca!.name };
  }

  const conexao = async (id: string) =>
    (
      await ownerQuery<{ status: string; origin: string; error_code: string | null; credential_secret_id: string | null; code_enc: string | null; discovered: { external_id: string; provider: string; name: string }[]; scopes: string[] }>(
        `select status, origin, error_code, credential_secret_id, code_enc, discovered, scopes from liame.oauth_connection where id = $1`,
        [id],
      )
    )[0]!;

  /** Começa a conexão e "autoriza na página": o código que o RegemCast devolveria na volta, preso ao pedido. */
  async function comecar(e: { cookie: string; brandId: string }) {
    const inicio = await api.call('POST', '/v1/connections', { cookie: e.cookie, body: { provider: 'regemcast', brand_id: e.brandId } });
    expect(inicio.status, JSON.stringify(inicio.body)).toBe(201);
    const pedido = pedidos.at(-1)!;
    const codigo = `rct_ac_${randomBytes(32).toString('base64url')}`;
    codigos.set(codigo, pedido);
    return { inicio, pedido, codigo };
  }

  const voltar = (cookie: string, params: Record<string, string>) =>
    fetch(`${api.base}/v1/oauth/callback?${new URLSearchParams(params)}`, { headers: { cookie }, redirect: 'manual' });

  beforeAll(async () => {
    servidor = createServer((req, res) => {
      const partes: Buffer[] = [];
      req.on('data', (d: Buffer) => partes.push(d));
      req.on('end', () => {
        let r: { status: number; corpo: unknown; problema?: boolean };
        try {
          r = responder(req.method ?? 'GET', new URL(req.url ?? '/', base).pathname, req.headers, Buffer.concat(partes).toString('utf8'));
        } catch {
          r = { status: 500, corpo: {} };
        }
        res.writeHead(r.status, { 'content-type': r.problema ? 'application/problem+json' : 'application/json' });
        res.end(JSON.stringify(r.corpo));
      });
    });
    await new Promise<void>((ok) => servidor.listen(0, '127.0.0.1', ok));
    base = `http://127.0.0.1:${(servidor.address() as AddressInfo).port}`;
    for (const [nome, valor] of [
      ['API_URL', API_PUBLICA],
      ['REGEM_API_URL', `${base}/regem`],
      ['REGEMCAST_API_URL', `${base}/cast`],
      ['REGEMCAST_AUTH_URL', `${base}/castsite`],
      ['DMS_ID_EMISSOR', `${base}/dmsid/oidc`],
      ['DMS_ID_APLICATIVO', APLICATIVO],
      ['DMS_ID_SEGREDO', VALOR_DO_APLICATIVO],
    ] as const) {
      anterior[nome] = process.env[nome];
      process.env[nome] = valor;
    }
    api = await startApi();
    await resetIpRateLimits();
    database = createDatabase({ connectionString: APP_URL, max: 3, applicationName: 'liame-test' });
    processador = new ConexaoProcessor(database, loadConfig(), api.app.get(VaultService), api.app.get(FlagService));
  }, 120_000);
  afterAll(async () => {
    await api?.close();
    await database?.close();
    await new Promise((ok) => servidor?.close(ok));
    for (const [nome, valor] of Object.entries(anterior)) {
      if (valor === undefined) delete process.env[nome];
      else process.env[nome] = valor;
    }
  });

  it('com a flag desligada, o RegemCast não aparece em "available" e começar responde 503, sem pedido e sem conexão', async () => {
    const e = await empresa('Mister Burgers Sem a Flag', false);
    const lista = await api.call('GET', '/v1/connections', { cookie: e.cookie });
    expect(lista.body.available).not.toContain('regemcast');
    const antes = pedidos.length;
    const r = await api.call('POST', '/v1/connections', { cookie: e.cookie, body: { provider: 'regemcast', brand_id: e.brandId } });
    expect(r.status).toBe(503);
    expect(pedidos.length).toBe(antes);
    const [n] = await ownerQuery<{ n: string }>(`select count(*)::text as n from liame.oauth_connection where tenant_id = $1`, [e.tenantId]);
    expect(n?.n).toBe('0');
  });

  it('por clique: o pedido empurrado leva a volta, as permissões, o state, o desafio e a conta que pede; a página leva só o número; a volta com o iss certo; o worker troca pela ligação e descobre a conta por ela; nada vai ao Regem', async () => {
    const e = await empresa('Mister Burgers Por Clique');
    const lista = await api.call('GET', '/v1/connections', { cookie: e.cookie });
    expect(lista.body.available).toContain('regemcast');

    const { inicio, pedido, codigo } = await comecar(e);
    // O pedido: tudo o que a página mostra fica no RegemCast, com o token do DMS ID do aplicativo do Liame.
    expect(tokensDoDmsId.has(pedido.autorizacao)).toBe(true);
    expect(pedido.corpo).toMatchObject({ response_type: 'code', client_id: APLICATIVO, redirect_uri: VOLTA, code_challenge_method: 'S256', conta_email: e.email, conta_marca: e.marca });
    expect(pedido.corpo.scope!.split(' ')).toEqual(PERMISSOES);
    expect(pedido.corpo.conta_nome).toBe('Mister Burgers Por Clique');
    expect(pedido.corpo.conta_cnpj).toBeUndefined();
    expect(pedido.corpo.state!.length).toBeGreaterThanOrEqual(43);
    expect(pedido.corpo.code_challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // O token do DMS ID sai com as permissões do clique, nenhuma de gravar.
    expect(pedidosDeToken.at(-1)!.get('scope')!.split(' ').sort()).toEqual([...PERMISSOES].sort());
    // A página: só o aplicativo e o número do pedido.
    const pagina = new URL(inicio.body.authorize_url as string);
    expect(`${pagina.origin}${pagina.pathname}`).toBe(`${base}/castsite/integracoes/autorizar`);
    expect(Object.fromEntries(pagina.searchParams)).toEqual({ client_id: APLICATIVO, request_uri: pedido.numero });
    const [auditoria] = await ownerQuery<{ after: Record<string, unknown>; actor_type: string }>(
      `select after, actor_type from liame.audit_event where tenant_id = $1 and action = 'conexao.iniciar' and resource_id = $2`,
      [e.tenantId, inicio.body.id],
    );
    expect(auditoria).toMatchObject({ actor_type: 'human', after: { provider: 'regemcast', brand_id: e.brandId, permissoes: PERMISSOES } });

    // A volta com o `iss` do RegemCast (a origem da API dele).
    const volta = await voltar(e.cookie, { state: pedido.corpo.state!, code: codigo, iss: new URL(base).origin });
    expect(volta.status).toBe(303);
    expect(volta.headers.get('location')).not.toContain('erro=');
    expect((await conexao(inicio.body.id)).status).toBe('recebida');

    expect(await processador.processarLote(5, { tenantIds: [e.tenantId] })).toBe(1);
    const troca = trocas.at(-1)!;
    expect(troca).toMatchObject({ grant_type: 'authorization_code', code: codigo, redirect_uri: VOLTA, client_id: APLICATIVO });
    const pronta = await conexao(inicio.body.id);
    expect(pronta).toMatchObject({ status: 'aguardando_escolha', origin: 'oauth', error_code: null, code_enc: null });
    expect(pronta.discovered.map((d) => [d.provider, d.external_id, d.name])).toEqual([['regemcast', situacao.contaId, 'Mister Burgers']]);
    expect(pronta.scopes).toEqual(PERMISSOES.slice(0, 5).sort());
    // A descoberta foi pela ligação (o token do DMS ID e o segredo no cabeçalho).
    const descoberta = mcp.filter((c) => c.ferramenta === 'integracao_situacao').at(-1)!;
    expect(tokensDoDmsId.has(descoberta.bearer)).toBe(true);
    expect(ligacoes.has(descoberta.ligacao)).toBe(true);
    const [segredo] = await ownerQuery<{ purpose: string; ciphertext: string }>(`select purpose, ciphertext from liame.secret where id = $1`, [pronta.credential_secret_id]);
    expect(segredo!.purpose).toBe('oauth_regemcast');
    expect(segredo!.ciphertext).not.toContain('dms_lg_');
    const depois = await api.call('GET', '/v1/connections', { cookie: e.cookie });
    expect(JSON.stringify(depois.body)).not.toContain('dms_lg_');

    const ligar = await api.call('POST', `/v1/connections/${inicio.body.id}/accounts`, { cookie: e.cookie, body: { accounts: [{ provider: 'regemcast', external_id: situacao.contaId }] } });
    expect(ligar.status, JSON.stringify(ligar.body)).toBe(200);
    expect(ligar.body.linked[0]).toMatchObject({ provider: 'regemcast', external_id: situacao.contaId, status: 'ativa', timezone: 'America/Sao_Paulo' });
    expect(chamadasAoRegem).toEqual([]);
  });

  it('a volta com outro iss (ou sem iss) para antes da troca: a conexão vira erro, o código não é guardado e o worker não chama o RegemCast', async () => {
    const e = await empresa('Mister Burgers Outro Emissor');
    for (const iss of ['https://outro-servidor.exemplo', null]) {
      const { inicio, pedido, codigo } = await comecar(e);
      const volta = await voltar(e.cookie, { state: pedido.corpo.state!, code: codigo, ...(iss ? { iss } : {}) });
      expect(volta.status).toBe(303);
      expect(volta.headers.get('location')).toContain('erro=autorizacao_invalida');
      expect(await conexao(inicio.body.id)).toMatchObject({ status: 'erro', error_code: 'emissor_invalido', code_enc: null });
    }
    const trocasAntes = trocas.length;
    expect(await processador.processarLote(5, { tenantIds: [e.tenantId] })).toBe(0);
    expect(trocas.length).toBe(trocasAntes);
  });

  it('com o CNPJ da empresa guardado, o pedido leva o CNPJ (a página do RegemCast compara com o da conta)', async () => {
    const e = await empresa('Mister Burgers Com CNPJ');
    await ownerQuery(`update liame.organization set cnpj = '12345678000195' where id = $1`, [e.tenantId]);
    const { pedido } = await comecar(e);
    expect(pedido.corpo.conta_cnpj).toBe('12345678000195');
  });

  it('a ligação que diz outra conta na descoberta: a conexão vira erro e não fica com conta nenhuma', async () => {
    const e = await empresa('Mister Burgers Outra Conta');
    const { inicio, pedido, codigo } = await comecar(e);
    await voltar(e.cookie, { state: pedido.corpo.state!, code: codigo, iss: new URL(base).origin });
    outraContaNaLigacao = true;
    try {
      expect(await processador.processarLote(5, { tenantIds: [e.tenantId] })).toBe(1);
    } finally {
      outraContaNaLigacao = false;
    }
    const c = await conexao(inicio.body.id);
    expect(c).toMatchObject({ status: 'erro', error_code: 'falha_na_plataforma' });
    expect(c.discovered).toEqual([]);
  });

  it('o RegemCast fora do ar no pedido: 502 plataforma-indisponivel, sem conexão criada', async () => {
    const e = await empresa('Mister Burgers Fora do Ar');
    pedidoForaDoAr = true;
    try {
      const r = await api.call('POST', '/v1/connections', { cookie: e.cookie, body: { provider: 'regemcast', brand_id: e.brandId } });
      expect(r.status).toBe(502);
      expect(r.body.type).toContain('plataforma-indisponivel');
    } finally {
      pedidoForaDoAr = false;
    }
    const [n] = await ownerQuery<{ n: string }>(`select count(*)::text as n from liame.oauth_connection where tenant_id = $1`, [e.tenantId]);
    expect(n?.n).toBe('0');
  });

  it('o token do DMS ID guardado e depois recusado pelo RegemCast: a mesma instância pede outro, uma vez, e o pedido sai (V130)', async () => {
    const e = await empresa('Mister Burgers Token Vencido');
    // A primeira rodada guarda o token na instância da API; o RegemCast passa a recusá-lo.
    await comecar(e);
    const guardado = pedidos.at(-1)!.autorizacao;
    tokensRecusados.add(guardado);
    const pedidosAntes = pedidosDeToken.length;
    const { inicio, pedido } = await comecar(e);
    expect(inicio.status).toBe(201);
    expect(pedidosDeToken.length).toBe(pedidosAntes + 1);
    expect(pedido.autorizacao).not.toBe(guardado);
  });

  it('procurar as contas de novo numa conexão da distribuição: o rct_it_ vai ao RegemCast, nunca ao Regem, e a conexão segue boa', async () => {
    const e = await empresa('Mister Burgers Procurar de Novo');
    const r = await registrarConexaoDaDistribuicao({ db: database.db, vault: api.app.get(VaultService), config: loadConfig() }, { tenantId: e.tenantId, brandId: e.brandId, produto: 'regemcast', tokens: [TOKEN] });
    const procurar = await api.call('POST', `/v1/connections/${r.connectionId}/discover`, { cookie: e.cookie });
    expect(procurar.status).toBe(202);
    const antes = chamadasAoRegem.length;
    expect(await processador.processarLote(5, { tenantIds: [e.tenantId] })).toBe(1);
    expect(chamadasAoRegem.length).toBe(antes);
    const depois = await conexao(r.connectionId);
    expect(depois).toMatchObject({ status: 'aguardando_escolha', error_code: null });
    expect(depois.discovered.map((d) => [d.provider, d.external_id])).toEqual([['regemcast', situacao.contaId]]);
    expect(mcp.filter((c) => c.bearer === TOKEN && c.ferramenta === 'integracao_situacao').length).toBeGreaterThan(0);
  });

  it('a conta passa da conexão da distribuição para a do clique: a antiga é encerrada e o token antigo revogado no RegemCast; a nova fica com a ligação', async () => {
    const e = await empresa('Mister Burgers Troca de Credencial');
    const vault = api.app.get(VaultService);
    const antiga = await registrarConexaoDaDistribuicao({ db: database.db, vault, config: loadConfig() }, { tenantId: e.tenantId, brandId: e.brandId, produto: 'regemcast', tokens: [TOKEN] });
    const ligadaAntes = await api.call('POST', `/v1/connections/${antiga.connectionId}/accounts`, { cookie: e.cookie, body: { accounts: [{ provider: 'regemcast', external_id: situacao.contaId }] } });
    expect(ligadaAntes.status).toBe(200);
    const contaId = ligadaAntes.body.linked[0].id as string;

    const { inicio, pedido, codigo } = await comecar(e);
    await voltar(e.cookie, { state: pedido.corpo.state!, code: codigo, iss: new URL(base).origin });
    expect(await processador.processarLote(5, { tenantIds: [e.tenantId] })).toBe(1);
    revogados.length = 0;
    const ligar = await api.call('POST', `/v1/connections/${inicio.body.id}/accounts`, { cookie: e.cookie, body: { accounts: [{ provider: 'regemcast', external_id: situacao.contaId }] } });
    expect(ligar.status, JSON.stringify(ligar.body)).toBe(200);
    expect(ligar.body.linked[0]).toMatchObject({ id: contaId, connection_id: inicio.body.id, status: 'ativa' });
    for (let i = 0; i < 50 && revogados.length < 1; i++) await new Promise((ok) => setTimeout(ok, 20));
    expect(revogados).toEqual([TOKEN]);
    expect((await conexao(antiga.connectionId)).status).toBe('revogada');
    const [conta] = await ownerQuery<{ credential_secret_id: string }>(`select credential_secret_id from liame.connected_account where id = $1`, [contaId]);
    expect(conta!.credential_secret_id).toBe((await conexao(inicio.body.id)).credential_secret_id);
  });

  it('revogar a conexão do clique (credencial sem lojas): 204, a credencial sai do cofre e a conta para', async () => {
    const e = await empresa('Mister Burgers Revogar Clique');
    const { inicio, pedido, codigo } = await comecar(e);
    await voltar(e.cookie, { state: pedido.corpo.state!, code: codigo, iss: new URL(base).origin });
    expect(await processador.processarLote(5, { tenantIds: [e.tenantId] })).toBe(1);
    const ligar = await api.call('POST', `/v1/connections/${inicio.body.id}/accounts`, { cookie: e.cookie, body: { accounts: [{ provider: 'regemcast', external_id: situacao.contaId }] } });
    expect(ligar.status).toBe(200);
    const revogar = await api.call('DELETE', `/v1/connections/${inicio.body.id}`, { cookie: e.cookie });
    expect(revogar.status).toBe(204);
    const c = await conexao(inicio.body.id);
    expect(c.status).toBe('revogada');
    const [segredo] = await ownerQuery<{ revogado: boolean }>(`select revoked_at is not null as revogado from liame.secret where id = $1`, [c.credential_secret_id]);
    expect(segredo?.revogado).toBe(true);
    const [conta] = await ownerQuery<{ status: string }>(`select status from liame.connected_account where connection_id = $1`, [inicio.body.id]);
    expect(conta?.status).toBe('desconectada');
  });
});
