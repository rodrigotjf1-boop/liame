import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { createDatabase, type Database, runMigrations, withTenant } from '@liame/database';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { registrarConexaoDaDistribuicao } from '../../src/connections/distribuicao.js';
import { FLAG_REGEM_POR_CLIQUE } from '../../src/connections/oauth.js';
import { gerarChave } from '../../src/connectors/dms/integracao-dms.js';
import { PERMISSOES_DA_ESCRITA, PROPOSITO_DA_LIGACAO_REGEM, resumoDoToken } from '../../src/connectors/regem/acesso-da-loja.js';
import { FlagService } from '../../src/flags/flag.service.js';
import { VaultService } from '../../src/vault/vault.service.js';
import { ConexaoProcessor } from '../../src/worker/conexao-processor.js';
import { enableMfa, ownerQuery, resetIpRateLimits, signupAndLogin, startApi, type TestApi } from '../helpers/api.js';
import { APP_URL, hasDb, OWNER_URL } from './env.js';

// Hub DMS (F3, parte C, PR 4 do Liame): conectar o Regem por clique, contra um Regem de mentira que segue o lado de lá
// (Regem #706: o pedido empurrado em `POST {base}/autorizacao/pedido` com o token do DMS ID, a página só com o aplicativo
// e o número do pedido, a volta com `code`, `state` e `iss` = a origem da API do Regem, a troca em
// `POST {base}/autorizacao/token` com o token do DMS ID, que devolve UMA ligação por loja e nenhum `rgm_it_`; a `/loja`
// pela ligação com as permissões que valem na chamada) e um DMS ID de mentira (`/oidc/token`, client credentials). Sem a
// flag `regem_por_clique`, conectar o Regem segue pela autorização de 01/10 (C1b), que volta ao mesmo endereço sem `iss`.

const FIX = resolve(import.meta.dirname, '../fixtures/regem/v1');
const fixture = (arquivo: string) => JSON.parse(readFileSync(resolve(FIX, arquivo), 'utf8')) as Record<string, unknown>;
const API_PUBLICA = 'http://api.liame.test';
const VOLTA = `${API_PUBLICA}/v1/oauth/callback`;
const APLICATIVO = 'aplicativo-do-liame-no-clique-do-regem';
/** Os segredos de mentira, com nome neutro (V123): o do aplicativo no DMS ID e o do cliente da C1b. */
const VALOR_DO_APLICATIVO = 'valor-do-aplicativo-de-teste-1357924680';
const VALOR_DO_CLIENTE = 'valor-do-cliente-c1b-de-teste-2468013579';
const CENTRO = 'loja-clique-centro';
const BARRA = 'loja-clique-barra';
const TOKEN_CENTRO = `rgm_it_${'Q'.repeat(32)}`;
/** O que o presidente liberou na página para cada loja (as necessárias, e no Centro o custo e criar cupom). */
const LIBERADAS: Record<string, string[]> = {
  [CENTRO]: ['pedidos.ler', 'custos.ler', 'clientes.anonimizacao.ler', 'cupons.ler', 'cupons.uso.ler', 'cupons.criar'],
  [BARRA]: ['pedidos.ler', 'clientes.anonimizacao.ler', 'cupons.ler', 'cupons.uso.ler'],
};

type Pedido = { numero: string; corpo: Record<string, string>; autorizacao: string };
type Resposta = { status: number; corpo: unknown; problema?: boolean };

describe.skipIf(!hasDb)('conectar o Regem por clique (Hub DMS, F3, parte C)', () => {
  let api: TestApi;
  let database: Database;
  let processador: ConexaoProcessor;
  let servidor: Server;
  let base = '';
  const anterior: Record<string, string | undefined> = {};
  const pedidos: Pedido[] = [];
  /** Código → o pedido de onde veio (o "presidente autorizou na página"). */
  const codigos = new Map<string, Pedido>();
  const usados = new Set<string>();
  const trocas: Record<string, string>[] = [];
  /** As ligações que valem no Regem, com a loja de cada uma. */
  const ligacoes = new Map<string, string>();
  const tokensDoDmsId = new Map<string, string[]>();
  const tokensRecusados = new Set<string>();
  const pedidosDeToken: URLSearchParams[] = [];
  const tokensValidos = new Set([TOKEN_CENTRO]);
  const revogacoes: { via: 'token' | 'ligacao'; credencial: string; status: number }[] = [];
  const chamadas: { metodo: string; caminho: string; bearer: string; ligacao: string | null }[] = [];
  /** O Regem fora do ar no pedido (503). */
  let pedidoForaDoAr = false;

  const problema = (tipo: string, status: number): Resposta => ({
    status,
    corpo: { type: `https://api.dmsregem.com/problemas/${tipo}`, title: tipo, status, detail: `recusado: ${tipo}` },
    problema: true,
  });
  const bearerDe = (h: IncomingHttpHeaders) => (h.authorization ?? '').replace(/^Bearer /, '');
  const lojaDoFixture = (loja: string) => fixture(loja === CENTRO ? 'loja-centro.json' : 'loja-barra.json');

  function responder(metodo: string, caminho: string, h: IncomingHttpHeaders, texto: string): Resposta {
    if (caminho === '/dmsid/oidc/token' && metodo === 'POST') {
      const params = new URLSearchParams(texto);
      pedidosDeToken.push(params);
      const esperado = `Basic ${Buffer.from(`${encodeURIComponent(APLICATIVO)}:${encodeURIComponent(VALOR_DO_APLICATIVO)}`).toString('base64')}`;
      if (h.authorization !== esperado || params.get('grant_type') !== 'client_credentials') return { status: 401, corpo: { error: 'invalid_client' } };
      const token = `tok-${tokensDoDmsId.size + 1}-${randomUUID()}`;
      tokensDoDmsId.set(token, (params.get('scope') ?? '').split(' ').filter(Boolean));
      return { status: 200, corpo: { access_token: token, token_type: 'Bearer', expires_in: 3600 } };
    }
    if (!caminho.startsWith('/regem/')) return { status: 404, corpo: {} };
    const rota = caminho.slice('/regem/'.length);
    const b = bearerDe(h);
    const ligacao = h['dms-ligacao'] === undefined ? null : String(h['dms-ligacao']);
    chamadas.push({ metodo, caminho: rota, bearer: b, ligacao });
    // O `rgm_it_` decide sozinho (a loja da conexão de antes).
    if (b.startsWith('rgm_it_')) {
      if (!tokensValidos.has(b)) return problema('token-invalido', 401);
      if (metodo === 'GET' && rota === 'loja') return { status: 200, corpo: { ...lojaDoFixture(CENTRO), loja_id: CENTRO } };
      if (metodo === 'POST' && rota === 'autorizacao/revogar') {
        tokensValidos.delete(b);
        revogacoes.push({ via: 'token', credencial: b, status: 200 });
        return { status: 200, corpo: { revogado: true } };
      }
      return problema('nao-encontrado', 404);
    }
    const doToken = tokensDoDmsId.get(b);
    const tokenVale = doToken !== undefined && !tokensRecusados.has(b);
    if (metodo === 'POST' && rota === 'autorizacao/pedido') {
      if (pedidoForaDoAr) return problema('indisponivel', 503);
      if (!tokenVale) return problema('token-invalido', 401);
      const corpo = JSON.parse(texto || '{}') as Record<string, string>;
      const numero = `urn:ietf:params:oauth:request_uri:rgm_${randomBytes(32).toString('base64url')}`;
      pedidos.push({ numero, corpo, autorizacao: b });
      return { status: 201, corpo: { request_uri: numero, expires_in: 600 } };
    }
    if (metodo === 'POST' && rota === 'autorizacao/token') {
      if (!tokenVale) return problema('token-invalido', 401);
      const corpo = JSON.parse(texto || '{}') as Record<string, string>;
      trocas.push(corpo);
      const pedido = codigos.get(corpo.code ?? '');
      // Como o Regem: o código é gasto antes das conferências.
      if (!pedido || usados.has(corpo.code!)) return problema('autorizacao-invalida', 400);
      usados.add(corpo.code!);
      const desafio = createHash('sha256').update(corpo.code_verifier ?? '').digest('base64url');
      if (desafio !== pedido.corpo.code_challenge || corpo.redirect_uri !== pedido.corpo.redirect_uri || corpo.grant_type !== 'authorization_code' || corpo.client_id !== APLICATIVO) {
        return problema('autorizacao-invalida', 400);
      }
      // O acesso que a loja tinha com o Liame (o `rgm_it_`) é revogado na mesma transação em que a ligação nasce.
      tokensValidos.delete(TOKEN_CENTRO);
      const lojas = [CENTRO, BARRA].map((loja) => {
        const { chave, prefixo } = gerarChave('lg', 'regem');
        ligacoes.set(chave, loja);
        return { ...lojaDoFixture(loja), loja_id: loja, escopos: LIBERADAS[loja], ligacao: chave, prefixo, permissoes: LIBERADAS[loja], segredo_em: new Date().toISOString() };
      });
      return { status: 200, corpo: { lojas } };
    }
    if (!tokenVale) return problema('token-invalido', 401);
    const loja = ligacao ? ligacoes.get(ligacao) : undefined;
    if (!loja) return problema('ligacao-invalida', 401);
    if (metodo === 'GET' && rota === 'loja') {
      // As permissões que valem na chamada: as que a loja liberou E as do token do DMS ID.
      return { status: 200, corpo: { ...lojaDoFixture(loja), loja_id: loja, escopos: LIBERADAS[loja]!.filter((p) => doToken!.includes(p)) } };
    }
    if (metodo === 'POST' && rota === 'autorizacao/revogar') {
      ligacoes.delete(ligacao!);
      revogacoes.push({ via: 'ligacao', credencial: ligacao!, status: 200 });
      return { status: 200, corpo: { revogado: true } };
    }
    return problema('nao-encontrado', 404);
  }

  async function empresa(nome: string, comFlag = true) {
    const s = await signupAndLogin(api, undefined, nome);
    await enableMfa(api, s.cookie);
    const tenantId = s.me.active_organization_id as string;
    const [marca] = await ownerQuery<{ id: string; name: string }>(`select id, name from liame.brand where tenant_id = $1 limit 1`, [tenantId]);
    if (comFlag) {
      await ownerQuery(`insert into liame.feature_flag_rule (id, flag_key, scope_type, scope_id, value, created_by) values (gen_random_uuid(), $1, 'tenant', $2, 'true'::jsonb, 'testes')`, [
        FLAG_REGEM_POR_CLIQUE,
        tenantId,
      ]);
      api.app.get(FlagService).invalidate();
    }
    return { cookie: s.cookie, email: s.email, tenantId, brandId: marca!.id, marca: marca!.name };
  }

  const conexao = async (id: string) =>
    (
      await ownerQuery<{
        status: string;
        origin: string;
        error_code: string | null;
        credential_secret_id: string | null;
        code_enc: string | null;
        authorization_flow: string | null;
        discovered: { external_id: string; provider: string; name: string; provider_attributes: { escopos: string[] } }[];
        scopes: string[];
      }>(`select status, origin, error_code, credential_secret_id, code_enc, authorization_flow, discovered, scopes from liame.oauth_connection where id = $1`, [id])
    )[0]!;

  /** Começa a conexão e "autoriza na página": o código que o Regem devolveria na volta, preso ao pedido. */
  async function comecar(e: { cookie: string; brandId: string }) {
    const inicio = await api.call('POST', '/v1/connections', { cookie: e.cookie, body: { provider: 'regem', brand_id: e.brandId } });
    expect(inicio.status, JSON.stringify(inicio.body)).toBe(201);
    const pedido = pedidos.at(-1)!;
    const codigo = `rgm_ac_${randomBytes(32).toString('base64url')}`;
    codigos.set(codigo, pedido);
    return { inicio, pedido, codigo };
  }

  const voltar = (cookie: string, params: Record<string, string>) =>
    fetch(`${api.base}/v1/oauth/callback?${new URLSearchParams(params)}`, { headers: { cookie }, redirect: 'manual' });

  /** O caminho inteiro até a conexão pronta para ligar as lojas. */
  async function ateEscolher(e: { cookie: string; brandId: string; tenantId: string }) {
    const c = await comecar(e);
    const volta = await voltar(e.cookie, { state: c.pedido.corpo.state!, code: c.codigo, iss: new URL(base).origin });
    expect(volta.headers.get('location')).not.toContain('erro=');
    expect(await processador.processarLote(5, { tenantIds: [e.tenantId] })).toBe(1);
    return c;
  }

  beforeAll(async () => {
    await runMigrations({ connectionString: OWNER_URL, dir: resolve(process.cwd(), '../../packages/database/migrations') });
    servidor = createServer((req, res) => {
      const partes: Buffer[] = [];
      req.on('data', (d: Buffer) => partes.push(d));
      req.on('end', () => {
        let r: Resposta;
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
      ['REGEM_AUTH_URL', `${base}/regemsite`],
      ['REGEM_CLIENT_ID', 'liame'],
      ['REGEM_CLIENT_SECRET', VALOR_DO_CLIENTE],
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

  it('sem a flag, conectar o Regem segue pela autorização de 01/10: a página leva o cliente e o desafio, nenhum pedido empurrado, e a volta sem iss vale', async () => {
    const e = await empresa('Mister Burgers Sem o Clique', false);
    const lista = await api.call('GET', '/v1/connections', { cookie: e.cookie });
    expect(lista.body.available).toContain('regem');
    expect(lista.body.regem_by_click).toBe(false);
    const antes = pedidos.length;
    const inicio = await api.call('POST', '/v1/connections', { cookie: e.cookie, body: { provider: 'regem', brand_id: e.brandId } });
    expect(inicio.status, JSON.stringify(inicio.body)).toBe(201);
    expect(pedidos.length).toBe(antes);
    const pagina = new URL(inicio.body.authorize_url as string);
    expect(`${pagina.origin}${pagina.pathname}`).toBe(`${base}/regemsite/integracoes/autorizar`);
    expect(pagina.searchParams.get('cliente')).toBe('liame');
    expect(pagina.searchParams.get('code_challenge_method')).toBe('S256');
    expect(pagina.searchParams.get('request_uri')).toBeNull();
    expect((await conexao(inicio.body.id)).authorization_flow).toBeNull();
    // A volta da C1b não traz `iss` e segue como sempre (a conferência do emissor é só da autorização por clique).
    const volta = await voltar(e.cookie, { state: pagina.searchParams.get('state')!, code: 'codigo-da-c1b' });
    expect(volta.headers.get('location')).not.toContain('erro=');
    expect((await conexao(inicio.body.id)).status).toBe('recebida');
  });

  it('por clique: o pedido leva a volta, as 7 permissões, o state, o desafio e a conta que pede; a página leva só o número; o worker troca por uma ligação por loja e descobre as lojas por elas', async () => {
    const e = await empresa('Mister Burgers Clique Regem');
    const lista = await api.call('GET', '/v1/connections', { cookie: e.cookie });
    expect(lista.body.available).toContain('regem');
    expect(lista.body.regem_by_click).toBe(true);

    const { inicio, pedido, codigo } = await comecar(e);
    // O pedido: tudo o que a página mostra fica no Regem, com o token do DMS ID do aplicativo do Liame.
    expect(tokensDoDmsId.has(pedido.autorizacao)).toBe(true);
    expect(pedido.corpo).toMatchObject({ response_type: 'code', client_id: APLICATIVO, redirect_uri: VOLTA, code_challenge_method: 'S256', conta_email: e.email, conta_marca: e.marca });
    expect(pedido.corpo.scope!.split(' ')).toEqual([...PERMISSOES_DA_ESCRITA]);
    expect(pedido.corpo.conta_nome).toBe('Mister Burgers Clique Regem');
    expect(pedido.corpo.conta_cnpj).toBeUndefined();
    expect(pedido.corpo.state!.length).toBeGreaterThanOrEqual(43);
    expect(pedido.corpo.code_challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // A página: só o aplicativo e o número do pedido.
    const pagina = new URL(inicio.body.authorize_url as string);
    expect(`${pagina.origin}${pagina.pathname}`).toBe(`${base}/regemsite/integracoes/autorizar`);
    expect(Object.fromEntries(pagina.searchParams)).toEqual({ client_id: APLICATIVO, request_uri: pedido.numero });
    expect((await conexao(inicio.body.id)).authorization_flow).toBe('clique');
    const [auditoria] = await ownerQuery<{ after: Record<string, unknown> }>(`select after from liame.audit_event where tenant_id = $1 and action = 'conexao.iniciar' and resource_id = $2`, [
      e.tenantId,
      inicio.body.id,
    ]);
    expect(auditoria?.after).toMatchObject({ provider: 'regem', brand_id: e.brandId, por_clique: true, permissoes: [...PERMISSOES_DA_ESCRITA] });

    // A volta com o `iss` do Regem (a origem da API dele) e o worker.
    const volta = await voltar(e.cookie, { state: pedido.corpo.state!, code: codigo, iss: new URL(base).origin });
    expect(volta.status).toBe(303);
    expect(volta.headers.get('location')).not.toContain('erro=');
    expect(await processador.processarLote(5, { tenantIds: [e.tenantId] })).toBe(1);
    expect(trocas.at(-1)).toMatchObject({ grant_type: 'authorization_code', code: codigo, redirect_uri: VOLTA, client_id: APLICATIVO });
    const pronta = await conexao(inicio.body.id);
    expect(pronta).toMatchObject({ status: 'aguardando_escolha', origin: 'oauth', error_code: null, code_enc: null, authorization_flow: 'clique' });
    // A descoberta pela ligação de cada loja: as permissões que valem são as que o presidente liberou.
    expect(pronta.discovered.map((d) => [d.provider, d.external_id, d.provider_attributes.escopos])).toEqual([
      ['regem', CENTRO, LIBERADAS[CENTRO]],
      ['regem', BARRA, LIBERADAS[BARRA]],
    ]);
    expect(pronta.scopes).toEqual([...new Set([...LIBERADAS[CENTRO]!, ...LIBERADAS[BARRA]!])].sort());
    const descobertas = chamadas.filter((c) => c.caminho === 'loja' && c.ligacao !== null).slice(-2);
    expect(descobertas.every((c) => tokensDoDmsId.has(c.bearer) && ligacoes.has(c.ligacao!))).toBe(true);
    const [segredo] = await ownerQuery<{ purpose: string; ciphertext: string }>(`select purpose, ciphertext from liame.secret where id = $1`, [pronta.credential_secret_id]);
    expect(segredo!.purpose).toBe('oauth_regem');
    expect(segredo!.ciphertext).not.toContain('dms_lg_');
    const depois = await api.call('GET', '/v1/connections', { cookie: e.cookie });
    expect(JSON.stringify(depois.body)).not.toContain('dms_lg_');
    expect((depois.body.items as { id: string; authorization_flow: string | null }[]).find((c) => c.id === inicio.body.id)?.authorization_flow).toBe('clique');

    const ligar = await api.call('POST', `/v1/connections/${inicio.body.id}/accounts`, {
      cookie: e.cookie,
      body: { accounts: [{ provider: 'regem', external_id: CENTRO }, { provider: 'regem', external_id: BARRA }] },
    });
    expect(ligar.status, JSON.stringify(ligar.body)).toBe(200);
    expect((ligar.body.linked as { external_id: string; status: string }[]).map((l) => [l.external_id, l.status]).sort()).toEqual([
      [BARRA, 'ativa'],
      [CENTRO, 'ativa'],
    ]);
  });

  it('a volta com outro iss (ou sem iss) para antes da troca: a conexão vira erro e o worker não chama o Regem', async () => {
    const e = await empresa('Mister Burgers Clique Outro Emissor');
    for (const iss of ['https://outro-servidor.exemplo', null]) {
      const { inicio, pedido, codigo } = await comecar(e);
      const volta = await voltar(e.cookie, { state: pedido.corpo.state!, code: codigo, ...(iss ? { iss } : {}) });
      expect(volta.headers.get('location')).toContain('erro=autorizacao_invalida');
      expect(await conexao(inicio.body.id)).toMatchObject({ status: 'erro', error_code: 'emissor_invalido', code_enc: null });
    }
    const trocasAntes = trocas.length;
    expect(await processador.processarLote(5, { tenantIds: [e.tenantId] })).toBe(0);
    expect(trocas.length).toBe(trocasAntes);
  });

  it('com o CNPJ da empresa guardado, o pedido leva o CNPJ (a página do Regem compara a raiz com a da empresa lá)', async () => {
    const e = await empresa('Mister Burgers Clique Com CNPJ');
    await ownerQuery(`update liame.organization set cnpj = '12345678000195' where id = $1`, [e.tenantId]);
    const { pedido } = await comecar(e);
    expect(pedido.corpo.conta_cnpj).toBe('12345678000195');
  });

  it('o Regem fora do ar no pedido: 502 plataforma-indisponivel, sem conexão criada', async () => {
    const e = await empresa('Mister Burgers Clique Fora do Ar');
    pedidoForaDoAr = true;
    try {
      const r = await api.call('POST', '/v1/connections', { cookie: e.cookie, body: { provider: 'regem', brand_id: e.brandId } });
      expect(r.status).toBe(502);
      expect(r.body.type).toContain('plataforma-indisponivel');
    } finally {
      pedidoForaDoAr = false;
    }
    const [n] = await ownerQuery<{ n: string }>(`select count(*)::text as n from liame.oauth_connection where tenant_id = $1`, [e.tenantId]);
    expect(n?.n).toBe('0');
  });

  it('o token do DMS ID guardado e depois recusado pelo Regem: a mesma instância pede outro, uma vez, e o pedido sai (V130)', async () => {
    const e = await empresa('Mister Burgers Clique Token Vencido');
    await comecar(e);
    const guardado = pedidos.at(-1)!.autorizacao;
    tokensRecusados.add(guardado);
    const pedidosAntes = pedidosDeToken.length;
    const { inicio, pedido } = await comecar(e);
    expect(inicio.status).toBe(201);
    expect(pedidosDeToken.length).toBe(pedidosAntes + 1);
    expect(pedido.autorizacao).not.toBe(guardado);
  });

  it('a loja passa da conexão do token para a do clique: a antiga é encerrada e o rgm_it_ revogado no Regem; a ligação da troca automática sai do cofre', async () => {
    const e = await empresa('Mister Burgers Clique Troca');
    const vault = api.app.get(VaultService);
    tokensValidos.add(TOKEN_CENTRO);
    const antiga = await registrarConexaoDaDistribuicao({ db: database.db, vault, config: loadConfig() }, { tenantId: e.tenantId, brandId: e.brandId, produto: 'regem', tokens: [TOKEN_CENTRO] });
    const ligadaAntes = await api.call('POST', `/v1/connections/${antiga.connectionId}/accounts`, { cookie: e.cookie, body: { accounts: [{ provider: 'regem', external_id: CENTRO }] } });
    expect(ligadaAntes.status, JSON.stringify(ligadaAntes.body)).toBe(200);
    const contaId = ligadaAntes.body.linked[0].id as string;
    // A ligação que a comparação trocou do `rgm_it_` de antes (como `trocarNoRegem` guarda).
    const daTroca = gerarChave('lg', 'regem');
    let ligacaoAntiga = '';
    await withTenant(database.db, e.tenantId, async (tx) => {
      ligacaoAntiga = await vault.putSecret(tx, {
        tenantId: e.tenantId,
        purpose: PROPOSITO_DA_LIGACAO_REGEM,
        plaintext: JSON.stringify({ tipo: 'ligacao_regem', ligacao: daTroca.chave, prefixo: daTroca.prefixo, origem: resumoDoToken(TOKEN_CENTRO), obtida_em: new Date().toISOString() }),
      });
      await tx.execute(sql`update liame.connected_account set ligacao_secret_id = ${ligacaoAntiga} where id = ${contaId}`);
    });

    const { inicio } = await ateEscolher(e);
    revogacoes.length = 0;
    const ligar = await api.call('POST', `/v1/connections/${inicio.body.id}/accounts`, { cookie: e.cookie, body: { accounts: [{ provider: 'regem', external_id: CENTRO }] } });
    expect(ligar.status, JSON.stringify(ligar.body)).toBe(200);
    expect(ligar.body.linked[0]).toMatchObject({ id: contaId, connection_id: inicio.body.id, status: 'ativa' });
    // A conexão antiga ficou sem loja: encerrada, com o `rgm_it_` revogado no Regem (lá ele já tinha parado de valer na
    // troca do clique: o 401 conta como revogado).
    expect((await conexao(antiga.connectionId)).status).toBe('revogada');
    await vi.waitFor(() => expect(chamadas.some((c) => c.caminho === 'autorizacao/revogar' && c.bearer === TOKEN_CENTRO)).toBe(true), { timeout: 10_000, interval: 50 });
    const [conta] = await ownerQuery<{ credential_secret_id: string; ligacao_secret_id: string | null }>(`select credential_secret_id, ligacao_secret_id from liame.connected_account where id = $1`, [contaId]);
    expect(conta).toEqual({ credential_secret_id: (await conexao(inicio.body.id)).credential_secret_id, ligacao_secret_id: null });
    const [segredo] = await ownerQuery<{ revogado: boolean }>(`select revoked_at is not null as revogado from liame.secret where id = $1`, [ligacaoAntiga]);
    expect(segredo?.revogado).toBe(true);
  });

  it('revogar a conexão do clique: a credencial sai do cofre, as lojas param e cada ligação é revogada no Regem, pela ligação', async () => {
    const e = await empresa('Mister Burgers Clique Revogar');
    const { inicio } = await ateEscolher(e);
    const ligar = await api.call('POST', `/v1/connections/${inicio.body.id}/accounts`, {
      cookie: e.cookie,
      body: { accounts: [{ provider: 'regem', external_id: CENTRO }, { provider: 'regem', external_id: BARRA }] },
    });
    expect(ligar.status).toBe(200);
    const vivas = [...ligacoes.keys()];
    revogacoes.length = 0;
    const revogar = await api.call('DELETE', `/v1/connections/${inicio.body.id}`, { cookie: e.cookie });
    expect(revogar.status).toBe(204);
    const c = await conexao(inicio.body.id);
    expect(c.status).toBe('revogada');
    const [segredo] = await ownerQuery<{ revogado: boolean }>(`select revoked_at is not null as revogado from liame.secret where id = $1`, [c.credential_secret_id]);
    expect(segredo?.revogado).toBe(true);
    await vi.waitFor(() => expect(revogacoes.filter((r) => r.via === 'ligacao').length).toBe(2), { timeout: 10_000, interval: 50 });
    expect(revogacoes.every((r) => vivas.includes(r.credencial))).toBe(true);
    const contas = await ownerQuery<{ status: string }>(`select status from liame.connected_account where connection_id = $1`, [inicio.body.id]);
    expect(contas.map((x) => x.status)).toEqual(['desconectada', 'desconectada']);
  });
});
