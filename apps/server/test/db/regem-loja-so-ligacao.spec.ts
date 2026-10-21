import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { createDatabase, type Database, runMigrations, uuidv7, withTenant } from '@liame/database';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { regemCupomConnector } from '../../src/actions/regem-cupom.js';
import { sha256 } from '../../src/audit/audit.js';
import { type AppConfig, loadConfig } from '../../src/config.js';
import type { DescobertaGuardada } from '../../src/connections/connections.service.js';
import { type CredencialLigacaoRegem, hashEstado } from '../../src/connections/oauth.js';
import { ClienteConector } from '../../src/connectors/cliente-http.js';
import { gerarChave } from '../../src/connectors/dms/integracao-dms.js';
import { enderecosDasPlataformas } from '../../src/connectors/enderecos.js';
import { PERMISSOES_DA_ESCRITA, PERMISSOES_DA_LEITURA } from '../../src/connectors/regem/acesso-da-loja.js';
import { FlagService } from '../../src/flags/flag.service.js';
import { SincronizadorVendas } from '../../src/orders/sincronizador-vendas.js';
import { VaultService } from '../../src/vault/vault.service.js';
import { ComparacaoDmsIdLoop, FLAG_COMPARACAO } from '../../src/worker/comparacao-dms-id.js';
import { ConexaoProcessor, descobrirLojasPelaLigacao } from '../../src/worker/conexao-processor.js';
import { apagarAnonimizadosNoSistema } from '../../src/worker/vendas-loop.js';
import { enableMfa, ownerQuery, resetIpRateLimits, signupAndLogin, startApi, type TestApi } from '../helpers/api.js';
import { APP_URL, hasDb, OWNER_URL } from './env.js';

// Hub DMS (F3, parte C, PR 3 do Liame): a loja do Regem só com a ligação. A autorização por clique do Regem (#706)
// entrega uma ligação por loja e nenhum `rgm_it_` (lá, o segredo do token da loja é descartado na troca); a credencial
// `regem_ligacao` guarda as ligações. Quem a cria é a conexão por clique do Liame (o PR seguinte): aqui ela é plantada no
// cofre como aquele PR vai gravar. Contra um Regem e um DMS ID de mentira que seguem o código do Regem (#690, #706: o
// guard aceita o token do DMS ID com a ligação no `DMS-Ligacao`; `ligacao-invalida` para a ligação revogada,
// `token-invalido` para o token do DMS ID recusado e para o `rgm_it_` que não vale; a `/loja` pela ligação traz as
// permissões que valem na chamada, as da loja E as do token; a rota que pede uma permissão que não vale responde 403
// `escopo-insuficiente`; `POST /autorizacao/revogar` pela ligação revoga a linha dela, que é a do acesso da loja).

const FIX = resolve(import.meta.dirname, '../fixtures/regem/v1');
const fixture = (arquivo: string) => JSON.parse(readFileSync(resolve(FIX, arquivo), 'utf8')) as Record<string, unknown>;
const CENTRO = 'loja-clique-centro';
const BARRA = 'loja-clique-barra';
const APLICATIVO = 'aplicativo-do-liame-de-teste';
/** O segredo do aplicativo do Liame no DMS ID de mentira (nome neutro, V123). */
const VALOR_DO_APLICATIVO = 'valor-do-aplicativo-de-teste-0123456789';
/** O que o presidente liberou para cada loja na página do clique (as necessárias e, no Centro, criar cupom). */
const LIBERADAS: Record<string, string[]> = {
  [CENTRO]: ['pedidos.ler', 'clientes.anonimizacao.ler', 'cupons.ler', 'cupons.uso.ler', 'cupons.criar'],
  [BARRA]: ['pedidos.ler'],
};
const LIG_CENTRO = gerarChave('lg', 'regem');
const LIG_BARRA = gerarChave('lg', 'regem');
const T0 = new Date('2026-10-21T12:00:00Z');
const mais = (min: number) => new Date(T0.getTime() + min * 60_000);
const vazia = (cursor: string) => ({ itens: [], proximo_cursor: cursor, tem_mais: false });
type Resposta = { status: number; corpo: unknown; problema?: boolean };
const problema = (status: number, tipo: string): Resposta => ({
  status,
  corpo: { type: `https://api.dmsregem.com/problemas/${tipo}`, title: tipo, status, detail: `recusado: ${tipo}` },
  problema: true,
});
/** A permissão que cada rota pede (o `@Escopos` do controlador do Regem). */
const PERMISSAO_DA_ROTA: Record<string, string> = {
  'GET pedidos': 'pedidos.ler',
  'GET cupons': 'cupons.ler',
  'GET clientes/anonimizados': 'clientes.anonimizacao.ler',
  'POST cupons': 'cupons.criar',
};

type Chamada = { rota: string; metodo: string; status: number; bearer: string; ligacao: string | null };

describe.skipIf(!hasDb)('a loja do Regem só com a ligação (Hub DMS, F3, parte C)', () => {
  let api: TestApi;
  let database: Database;
  let servidor: Server;
  let base = '';
  const anterior: Record<string, string | undefined> = {};
  const regem = {
    /** As ligações que valem, cada uma com a loja dela. */
    ligacoes: new Map<string, string>([
      [LIG_CENTRO.chave, CENTRO],
      [LIG_BARRA.chave, BARRA],
    ]),
    /** Os tokens do DMS ID emitidos, com as permissões que cada um pediu. */
    tokensDmsId: new Map<string, string[]>(),
    tokensDmsIdRecusados: new Set<string>(),
    /** O Regem recusa todo token do DMS ID (a chave de assinatura trocou e ele ainda não leu a nova). */
    recusarTokenDmsId: false,
  };
  const chamadas: Chamada[] = [];
  const pedidosDeToken: URLSearchParams[] = [];
  const cuponsCriados = new Map<string, Record<string, unknown>>();
  let e: { cookie: string; tenantId: string; brandId: string };
  let config: AppConfig;
  let credencial: CredencialLigacaoRegem;
  let conexao = '';
  const conta: Record<string, string> = {};

  const bearer = (c: IncomingHttpHeaders) => (c.authorization ?? '').replace(/^Bearer /, '');

  function tokenDoDmsId(cabecalhos: IncomingHttpHeaders, corpo: string): Resposta {
    const params = new URLSearchParams(corpo);
    pedidosDeToken.push(params);
    const esperado = `Basic ${Buffer.from(`${encodeURIComponent(APLICATIVO)}:${encodeURIComponent(VALOR_DO_APLICATIVO)}`).toString('base64')}`;
    if (cabecalhos.authorization !== esperado || params.get('grant_type') !== 'client_credentials') return { status: 401, corpo: { error: 'invalid_client' } };
    const token = `tok-${regem.tokensDmsId.size + 1}-${randomUUID()}`;
    regem.tokensDmsId.set(token, (params.get('scope') ?? '').split(' ').filter(Boolean));
    return { status: 200, corpo: { access_token: token, token_type: 'Bearer', expires_in: 3600 } };
  }

  /** Quem chama (o guard do Regem): o `rgm_it_` decide sozinho; sem ele, o token do DMS ID e depois a ligação. */
  function acesso(cabecalhos: IncomingHttpHeaders): { loja: string; ligacao: string; permissoes: string[] } | Resposta {
    const b = bearer(cabecalhos);
    // Nesta loja não há `rgm_it_`: qualquer um é recusado como o token que não vale.
    if (b.startsWith('rgm_it_')) return problema(401, 'token-invalido');
    const doToken = regem.tokensDmsId.get(b);
    if (regem.recusarTokenDmsId || !doToken || regem.tokensDmsIdRecusados.has(b)) return problema(401, 'token-invalido');
    const ligacao = String(cabecalhos['dms-ligacao'] ?? '');
    const loja = regem.ligacoes.get(ligacao);
    if (!loja) return problema(401, 'ligacao-invalida');
    // Valem as permissões que a loja liberou E as que o token do DMS ID tem.
    return { loja, ligacao, permissoes: (LIBERADAS[loja] ?? []).filter((p) => doToken.includes(p)) };
  }

  function responder(chave: string, a: { loja: string; ligacao: string; permissoes: string[] }, cabecalhos: IncomingHttpHeaders, corpo: string, q: URLSearchParams): Resposta {
    const exigida = PERMISSAO_DA_ROTA[chave];
    if (exigida && !a.permissoes.includes(exigida)) return problema(403, 'escopo-insuficiente');
    const centro = a.loja === CENTRO;
    const cursor = q.get('cursor');
    switch (chave) {
      case 'GET loja':
        return { status: 200, corpo: { ...fixture(centro ? 'loja-centro.json' : 'loja-barra.json'), loja_id: a.loja, escopos: a.permissoes } };
      case 'GET pedidos': {
        if (!centro) return { status: 200, corpo: cursor ? vazia(cursor) : fixture('pedidos-barra.json') };
        if (!cursor) return { status: 200, corpo: fixture('pedidos-carga-1.json') };
        if (cursor === 'ped-c1') return { status: 200, corpo: fixture('pedidos-carga-2.json') };
        return { status: 200, corpo: vazia(cursor) };
      }
      case 'GET cupons':
        return { status: 200, corpo: cursor ? vazia('cup-c1') : fixture('cupons.json') };
      case 'GET clientes/anonimizados':
        return { status: 200, corpo: vazia(cursor ?? 'anon-c0') };
      case 'PUT webhook': {
        const pedido = JSON.parse(corpo) as { url: string };
        return { status: 200, corpo: { url: pedido.url, registrado_em: new Date().toISOString(), pausado: false, motivo_pausa: null } };
      }
      case 'POST autorizacao/revogar':
        regem.ligacoes.delete(a.ligacao);
        return { status: 200, corpo: { revogado: true } };
      case 'POST cupons': {
        const idem = String(cabecalhos['idempotency-key'] ?? '');
        const regra = JSON.parse(corpo) as Record<string, unknown>;
        let cupom = cuponsCriados.get(idem);
        if (!cupom) {
          cupom = {
            id: `cup-clique-${cuponsCriados.size + 1}`,
            versao: 1,
            atualizado_em: new Date().toISOString(),
            codigo: regra.codigo,
            nome: regra.nome,
            tipo: regra.tipo,
            percentual: regra.percentual ?? null,
            valido_de: regra.valido_de,
            valido_ate: regra.valido_ate,
            fuso: 'America/Sao_Paulo',
            ativo: true,
            usos: 0,
          };
          cuponsCriados.set(idem, cupom);
        }
        return { status: 201, corpo: cupom };
      }
      default:
        return problema(404, 'nao-encontrado');
    }
  }

  function rota(url: URL, metodo: string, cabecalhos: IncomingHttpHeaders, corpo: string): Resposta {
    const caminho = url.pathname.slice('/regem/'.length);
    const a = acesso(cabecalhos);
    const r = 'status' in a ? a : responder(`${metodo} ${caminho}`, a, cabecalhos, corpo, url.searchParams);
    const ligacao = cabecalhos['dms-ligacao'];
    chamadas.push({ rota: caminho, metodo, status: r.status, bearer: bearer(cabecalhos), ligacao: ligacao === undefined ? null : String(ligacao) });
    return r;
  }

  const sincronizador = () => new SincronizadorVendas(database.db, api.app.get(VaultService), config, apagarAnonimizadosNoSistema(database.db));
  const cliente = () => new ClienteConector(database.db, { enderecos: enderecosDasPlataformas(config.plataformas, config.produtos), tentativas: 1 });
  const situacao = async (id: string) =>
    (await ownerQuery<{ status: string; status_reason: string | null }>(`select status, status_reason from liame.connected_account where id = $1`, [id]))[0]!;
  const avisoGravado = async (id: string) =>
    (await ownerQuery<{ aviso: { em: string; ok: boolean; via?: string } | null }>(`select cursor->'aviso' as aviso from liame.sync_state where connected_account_id = $1 and dataset = 'pedidos'`, [id]))[0]
      ?.aviso ?? null;
  const revogacoes = (ligacao: string) => chamadas.filter((c) => c.rota === 'autorizacao/revogar' && c.ligacao === ligacao).map((c) => c.status);
  /** As ligações nunca aparecem na trilha de auditoria (só o prefixo, quando aparece). */
  const semLigacaoNaTrilha = async () => {
    const trilha = JSON.stringify(await ownerQuery(`select "before", "after" from liame.audit_event where chain_key = $1`, [e.tenantId]));
    for (const l of [LIG_CENTRO.chave, LIG_BARRA.chave]) expect(trilha).not.toContain(l);
  };

  beforeAll(async () => {
    await runMigrations({ connectionString: OWNER_URL, dir: resolve(process.cwd(), '../../packages/database/migrations') });
    servidor = createServer((req, res) => {
      const partes: Buffer[] = [];
      req.on('data', (d: Buffer) => partes.push(d));
      req.on('end', () => {
        const texto = Buffer.concat(partes).toString('utf8');
        const url = new URL(req.url ?? '/', base);
        let r: Resposta;
        try {
          if (url.pathname === '/dmsid/oidc/token' && req.method === 'POST') r = tokenDoDmsId(req.headers, texto);
          else if (url.pathname.startsWith('/regem/')) r = rota(url, req.method ?? 'GET', req.headers, texto);
          else r = { status: 404, corpo: {} };
        } catch {
          // Erro no servidor de teste vira 500 (o conector trata como falha passageira).
          r = { status: 500, corpo: {} };
        }
        res.writeHead(r.status, { 'content-type': r.problema ? 'application/problem+json' : 'application/json' });
        res.end(JSON.stringify(r.corpo));
      });
    });
    await new Promise<void>((ok) => servidor.listen(0, '127.0.0.1', ok));
    base = `http://127.0.0.1:${(servidor.address() as AddressInfo).port}`;
    for (const [nome, valor] of [
      ['REGEM_API_URL', `${base}/regem`],
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
    // A chave REGEM_PELA_LIGACAO fica desligada (o padrão): a loja do clique não depende dela.
    config = loadConfig();
    const s = await signupAndLogin(api, undefined, 'Mister Burgers pelo clique');
    await enableMfa(api, s.cookie);
    const tenantId = s.me.active_organization_id as string;
    const brandId = (await ownerQuery<{ id: string }>(`select id from liame.brand where tenant_id = $1 limit 1`, [tenantId]))[0]!.id;
    e = { cookie: s.cookie, tenantId, brandId };
    credencial = {
      tipo: 'regem_ligacao',
      lojas: [
        { loja_id: CENTRO, ligacao: LIG_CENTRO.chave, prefixo: LIG_CENTRO.prefixo, escopos: LIBERADAS[CENTRO]! },
        { loja_id: BARRA, ligacao: LIG_BARRA.chave, prefixo: LIG_BARRA.prefixo, escopos: LIBERADAS[BARRA]! },
      ],
      obtido_em: T0.toISOString(),
    };
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

  it('descoberta: cada ligação diz a loja dela pela /loja, com o token do DMS ID do aplicativo inteiro; a recusada fica de fora', async () => {
    const lojas = await descobrirLojasPelaLigacao(cliente(), config, credencial);
    // As permissões que valem pela ligação são as que o presidente liberou: o token pediu as do aplicativo inteiro.
    expect(lojas.map((l) => [l.provider, l.external_id, (l.provider_attributes as { escopos: string[] }).escopos])).toEqual([
      ['regem', CENTRO, LIBERADAS[CENTRO]],
      ['regem', BARRA, LIBERADAS[BARRA]],
    ]);
    expect(pedidosDeToken.map((p) => p.get('scope')!.split(' ').sort())).toEqual([[...PERMISSOES_DA_ESCRITA].sort()]);
    // Tudo pelo token do DMS ID e a ligação da loja; nada de `rgm_it_`.
    expect(chamadas.map((c) => [c.rota, c.status, c.ligacao])).toEqual([
      ['loja', 200, LIG_CENTRO.chave],
      ['loja', 200, LIG_BARRA.chave],
    ]);
    expect(chamadas.every((c) => c.bearer.startsWith('tok-'))).toBe(true);

    // A ligação que o Regem não reconhece (revogada lá) fica de fora; com todas recusadas, a conexão precisa ser refeita.
    const revogada = gerarChave('lg', 'regem');
    const comRevogada: CredencialLigacaoRegem = { ...credencial, lojas: [...credencial.lojas, { loja_id: 'loja-revogada', ligacao: revogada.chave, prefixo: revogada.prefixo, escopos: [] }] };
    expect((await descobrirLojasPelaLigacao(cliente(), config, comRevogada)).map((l) => l.external_id)).toEqual([CENTRO, BARRA]);
    await expect(descobrirLojasPelaLigacao(cliente(), config, { ...credencial, lojas: comRevogada.lojas.slice(2) })).rejects.toMatchObject({ tipo: 'autenticacao' });
  });

  it('descoberta: o token do DMS ID recusado mesmo depois de pedir outro é do aplicativo e sobe (não conta como loja recusada)', async () => {
    regem.recusarTokenDmsId = true;
    try {
      await expect(descobrirLojasPelaLigacao(cliente(), config, credencial)).rejects.toMatchObject({ tipo: 'autenticacao', codigoProvider: 'token-invalido' });
    } finally {
      regem.recusarTokenDmsId = false;
    }
  });

  it('ligar as lojas: a conexão do clique liga as duas, e a credencial de cada uma é a das ligações', async () => {
    const descobertas: DescobertaGuardada[] = await descobrirLojasPelaLigacao(cliente(), config, credencial);
    conexao = uuidv7();
    // O que a conexão por clique do Liame (o PR seguinte) vai gravar: a credencial no cofre e as lojas descobertas.
    await withTenant(database.db, e.tenantId, async (tx) => {
      const secretId = await api.app.get(VaultService).putSecret(tx, { tenantId: e.tenantId, purpose: 'oauth_regem', plaintext: JSON.stringify(credencial) });
      const escopos = [...new Set(credencial.lojas.flatMap((l) => l.escopos))].sort();
      await tx.execute(sql`
        insert into liame.oauth_connection (id, tenant_id, brand_id, provider, origin, status, state_hash, redirect_uri,
                                            credential_secret_id, scopes, discovered, expires_at)
        values (${conexao}, ${e.tenantId}, ${e.brandId}, 'regem', 'oauth', 'aguardando_escolha', ${hashEstado(randomBytes(32).toString('base64url'))},
                ${`${config.apiUrl}/v1/oauth/callback`}, ${secretId}, array(select jsonb_array_elements_text(${JSON.stringify(escopos)}::jsonb)),
                ${JSON.stringify(descobertas)}::jsonb, now())`);
    });
    const ligadas = await api.call('POST', `/v1/connections/${conexao}/accounts`, {
      cookie: e.cookie,
      body: { accounts: [{ provider: 'regem', external_id: CENTRO }, { provider: 'regem', external_id: BARRA }] },
    });
    expect(ligadas.status, JSON.stringify(ligadas.body)).toBe(200);
    for (const l of ligadas.body.linked as { id: string; external_id: string }[]) conta[l.external_id] = l.id;
    const linhas = await ownerQuery<{ external_id: string; status: string; mesma: boolean; ligacao_secret_id: string | null }>(
      `select a.external_id, a.status, a.credential_secret_id = o.credential_secret_id as mesma, a.ligacao_secret_id
         from liame.connected_account a join liame.oauth_connection o on o.id = a.connection_id
        where a.connection_id = $1 order by a.external_id`,
      [conexao],
    );
    expect(linhas).toEqual([
      { external_id: BARRA, status: 'ativa', mesma: true, ligacao_secret_id: null },
      { external_id: CENTRO, status: 'ativa', mesma: true, ligacao_secret_id: null },
    ]);
  });

  it('procurar as lojas de novo: o processador de conexões descobre a conexão do clique pela ligação de cada loja', async () => {
    const r = await api.call('POST', `/v1/connections/${conexao}/discover`, { cookie: e.cookie });
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    const posicao = chamadas.length;
    const processador = new ConexaoProcessor(database, loadConfig(), api.app.get(VaultService), api.app.get(FlagService));
    expect(await processador.processarLote(5, { tenantIds: [e.tenantId] })).toBe(1);
    expect(chamadas.slice(posicao).map((c) => [c.rota, c.status, c.ligacao])).toEqual([
      ['loja', 200, LIG_CENTRO.chave],
      ['loja', 200, LIG_BARRA.chave],
    ]);
    const [c] = await ownerQuery<{ status: string; discovered: { external_id: string; provider_attributes: { escopos: string[] } }[] }>(
      `select status, discovered from liame.oauth_connection where id = $1`,
      [conexao],
    );
    expect(c!.discovered.map((d) => [d.external_id, d.provider_attributes.escopos])).toEqual([
      [CENTRO, LIBERADAS[CENTRO]],
      [BARRA, LIBERADAS[BARRA]],
    ]);
    expect(['ativa', 'aguardando_escolha']).toContain(c!.status);
  });

  it('leitura das vendas com REGEM_PELA_LIGACAO desligada: a loja do clique lê pela ligação, e o aviso é registrado por ela', async () => {
    expect(config.produtos.regemPelaLigacao).toBe(false);
    const posicao = chamadas.length;
    const tokensAntes = pedidosDeToken.length;
    expect(await sincronizador().sincronizar(conta[CENTRO]!, e.tenantId, T0)).toMatchObject({ status: 'ok', pedidos: { novos: 6 } });
    // A segunda leitura (depois da carga inicial) registra o aviso e confere o cardápio (a `/loja`), pela ligação.
    expect((await sincronizador().sincronizar(conta[CENTRO]!, e.tenantId, mais(20))).status).toBe('ok');
    const desta = chamadas.slice(posicao);
    expect(new Set(desta.map((c) => c.rota))).toEqual(new Set(['pedidos', 'cupons', 'clientes/anonimizados', 'webhook', 'loja']));
    expect(desta.every((c) => c.status === 200 && c.ligacao === LIG_CENTRO.chave && c.bearer.startsWith('tok-'))).toBe(true);
    expect(desta.filter((c) => c.rota === 'webhook')).toHaveLength(1);
    expect(await avisoGravado(conta[CENTRO]!)).toEqual({ em: mais(20).toISOString(), ok: true, via: 'ligacao' });
    // O token do DMS ID da leitura pede só as permissões de leitura.
    for (const p of pedidosDeToken.slice(tokensAntes)) expect(p.get('scope')!.split(' ').sort()).toEqual([...PERMISSOES_DA_LEITURA].sort());
  });

  it('comparação: a loja do clique fica fora, sem chamada nenhuma, com o motivo, e é vista de novo no dia seguinte', async () => {
    await ownerQuery(`insert into liame.feature_flag_rule (id, flag_key, scope_type, scope_id, value, created_by) values (gen_random_uuid(), $1, 'tenant', $2, 'true'::jsonb, 'testes')`, [
      FLAG_COMPARACAO,
      e.tenantId,
    ]);
    api.app.get(FlagService).invalidate();
    const [posicao, tokensAntes] = [chamadas.length, pedidosDeToken.length];
    const loop = new ComparacaoDmsIdLoop(database, loadConfig(), api.app.get(VaultService), api.app.get(FlagService));
    expect(await loop.executarLote(5, { tenantIds: [e.tenantId] }, mais(60))).toEqual([{ status: 'ignorada' }, { status: 'ignorada' }]);
    expect([chamadas.length - posicao, pedidosDeToken.length - tokensAntes]).toEqual([0, 0]);
    const estados = await ownerQuery<{ next_at: Date; last_error: string | null }>(
      `select c.next_at, c.last_error from liame.credential_comparison_state c join liame.connected_account a on a.id = c.connected_account_id where a.connection_id = $1`,
      [conexao],
    );
    expect(estados).toHaveLength(2);
    for (const s of estados) {
      expect(s.last_error).toBe('loja ligada pela autorização por clique: só tem a ligação, nada a comparar');
      expect(new Date(s.next_at).toISOString()).toBe(mais(60 + 24 * 60).toISOString());
    }
    expect(await ownerQuery(`select 1 from liame.credential_comparison where tenant_id = $1`, [e.tenantId])).toEqual([]);
  });

  it('cupom pela ligação do clique: a criação vai pela ligação, com "criar cupom" no token do DMS ID; a loja que não liberou nem chama', async () => {
    const vault = api.app.get(VaultService);
    regemCupomConnector.ligar({ lerSegredo: (tx, id) => vault.readSecret(tx, id), cliente, config, sha256 });
    const regra = (codigo: string) => ({ codigo, nome: `Cupom ${codigo}`, tipo: 'percentual' as const, percentual: '10', valido_de: '2026-10-21', valido_ate: '2026-10-31' });
    const criar = (lojaId: string, codigo: string) => withTenant(database.db, e.tenantId, (tx) => regemCupomConnector.criarCupomDaMensagem(tx, { tenantId: e.tenantId, lojaId, regra: regra(codigo) }));

    const posicao = chamadas.length;
    expect(await criar(conta[CENTRO]!, 'CLIQUE10')).toMatchObject({ ok: true });
    const posts = chamadas.slice(posicao).filter((c) => c.rota === 'cupons' && c.metodo === 'POST');
    expect(posts.map((c) => [c.status, c.ligacao])).toEqual([[201, LIG_CENTRO.chave]]);
    // O token do DMS ID da criação é o que pediu também "criar cupom" (F3-5; o mesmo que a descoberta guardou).
    expect([...(regem.tokensDmsId.get(posts[0]!.bearer) ?? [])].sort()).toEqual([...PERMISSOES_DA_ESCRITA].sort());
    // A Barra não liberou "criar cupom" na página: a recusa sai antes de chamar o Regem.
    const antes = chamadas.length;
    expect(await criar(conta[BARRA]!, 'CLIQUE20')).toMatchObject({ ok: false });
    expect(chamadas.length).toBe(antes);
  });

  it('o token do DMS ID recusado mesmo depois de pedir outro é do aplicativo: a leitura falha e a loja segue ativa, sem "conecte de novo"', async () => {
    regem.recusarTokenDmsId = true;
    const posicao = chamadas.length;
    try {
      expect((await sincronizador().sincronizar(conta[BARRA]!, e.tenantId, mais(80))).status).toBe('falhou');
    } finally {
      regem.recusarTokenDmsId = false;
    }
    // Pela ligação, sem `rgm_it_` de reserva: duas recusas (o token guardado e o pedido de novo) e nada pelo token.
    expect(chamadas.slice(posicao).map((c) => [c.rota, c.status])).toEqual([
      ['pedidos', 401],
      ['pedidos', 401],
    ]);
    expect(await situacao(conta[BARRA]!)).toEqual({ status: 'ativa', status_reason: null });
  });

  it('a ligação revogada no Regem é da loja: ligacao-invalida desconecta a loja, que pede para conectar de novo', async () => {
    regem.ligacoes.delete(LIG_BARRA.chave);
    try {
      // Depois da espera da falha anterior (30 minutos): os pedidos da Barra são lidos de novo.
      expect((await sincronizador().sincronizar(conta[BARRA]!, e.tenantId, mais(140))).status).toBe('falhou');
      expect(await situacao(conta[BARRA]!)).toEqual({ status: 'desconectada', status_reason: 'O Regem recusou a autorização desta loja: conecte de novo.' });
    } finally {
      // Volta a valer lá, para a revogação da conexão (o último teste) ter o que revogar.
      regem.ligacoes.set(LIG_BARRA.chave, BARRA);
    }
  });

  it('desligar a loja do clique revoga a ligação dela no Regem, pela ligação; o token do DMS ID recusado é pedido de novo uma vez', async () => {
    // O token do DMS ID guardado passa a ser recusado: a revogação pede outro e repete (antes, o 401 contava como "já
    // revogado" e a ligação seguia valendo no Regem).
    for (const t of regem.tokensDmsId.keys()) regem.tokensDmsIdRecusados.add(t);
    const r = await api.call('DELETE', `/v1/connected-accounts/${conta[CENTRO]}`, { cookie: e.cookie });
    expect(r.status, JSON.stringify(r.body)).toBe(204);
    await vi.waitFor(() => expect(revogacoes(LIG_CENTRO.chave)).toEqual([401, 200]), { timeout: 10_000, interval: 50 });
    expect(regem.ligacoes.has(LIG_CENTRO.chave)).toBe(false);
    // Só a ligação do Centro: a da Barra segue valendo lá.
    expect(revogacoes(LIG_BARRA.chave)).toEqual([]);
    const [auditoria] = await ownerQuery<{ after: Record<string, unknown> }>(
      `select after from liame.audit_event where chain_key = $1 and resource_id = $2 and action = 'conta.desconectar' order by chain_seq desc limit 1`,
      [e.tenantId, conta[CENTRO]],
    );
    expect(auditoria?.after).toMatchObject({ provider: 'regem', external_id: CENTRO, revogada_no_regem: true });
    await semLigacaoNaTrilha();
  });

  it('revogar a conexão do clique revoga no Regem a ligação de cada loja; a que já não vale lá conta como revogada', async () => {
    const r = await api.call('DELETE', `/v1/connections/${conexao}`, { cookie: e.cookie });
    expect(r.status, JSON.stringify(r.body)).toBe(204);
    await vi.waitFor(() => expect(revogacoes(LIG_BARRA.chave)).toEqual([200]), { timeout: 10_000, interval: 50 });
    // A do Centro já tinha sido revogada lá (desligada antes): `ligacao-invalida`, que conta como revogada.
    await vi.waitFor(() => expect(revogacoes(LIG_CENTRO.chave)).toEqual([401, 200, 401]), { timeout: 10_000, interval: 50 });
    expect(regem.ligacoes.size).toBe(0);
    const [c] = await ownerQuery<{ status: string; revogado: boolean }>(
      `select o.status, s.revoked_at is not null as revogado from liame.oauth_connection o join liame.secret s on s.id = o.credential_secret_id where o.id = $1`,
      [conexao],
    );
    expect(c).toEqual({ status: 'revogada', revogado: true });
    await semLigacaoNaTrilha();
  });
});
