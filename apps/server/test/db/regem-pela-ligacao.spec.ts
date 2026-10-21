import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { createDatabase, type Database, runMigrations, withTenant } from '@liame/database';
import { Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { regemCupomConnector } from '../../src/actions/regem-cupom.js';
import { sha256 } from '../../src/audit/audit.js';
import { type AppConfig, loadConfig } from '../../src/config.js';
import { registrarConexaoDaDistribuicao } from '../../src/connections/distribuicao.js';
import { ClienteConector } from '../../src/connectors/cliente-http.js';
import { gerarChave } from '../../src/connectors/dms/integracao-dms.js';
import { enderecosDasPlataformas } from '../../src/connectors/enderecos.js';
import { PERMISSOES_DA_LEITURA, PROPOSITO_DA_LIGACAO_REGEM, resumoDoToken } from '../../src/connectors/regem/acesso-da-loja.js';
import { FlagService } from '../../src/flags/flag.service.js';
import { SincronizadorVendas } from '../../src/orders/sincronizador-vendas.js';
import { VaultService } from '../../src/vault/vault.service.js';
import { ComparacaoDmsIdLoop, FLAG_COMPARACAO } from '../../src/worker/comparacao-dms-id.js';
import { descobrirLojas } from '../../src/worker/conexao-processor.js';
import { apagarAnonimizadosNoSistema } from '../../src/worker/vendas-loop.js';
import { enableMfa, ownerQuery, resetIpRateLimits, signupAndLogin, startApi, type TestApi } from '../helpers/api.js';
import { APP_URL, hasDb, OWNER_URL } from './env.js';

// Hub DMS (F3, parte B): o Liame lê o Regem pela ligação. Contra um Regem e um DMS ID de mentira que seguem o código do
// Regem (#690, #693, #697: `integracao-token.guard.ts`, `dms-id.controller.ts`, `ligacao-integracao.service.ts`,
// `problema.ts`): o `rgm_it_` decide sozinho; sem ele, o token do DMS ID (401 `token-invalido`) e a ligação no
// `DMS-Ligacao` (401 `ligacao-invalida`, a mesma para todo motivo, também a do token revogado: a ligação tem o id dele);
// as recusas em problem+json com `type` = `https://api.dmsregem.com/problemas/<tipo>`; a troca automática em
// `POST /dms-id/ligacao` gira o segredo; a `/loja` pela ligação traz as permissões que valem na chamada; com a via
// desligada, a troca responde 404. O que a documentação do DMS ID não diz (o recurso que ele ainda não conhece) entra
// como o pior caso (V125): ele recusa (400).
//
// A comparação das duas credenciais (decisão F3-6) e a leitura de verdade pela ligação (`REGEM_PELA_LIGACAO`), com o
// `rgm_it_` de reserva e a recusa decidida pela via (ERR-149).

const FIX = resolve(import.meta.dirname, '../fixtures/regem/v1');
const fixture = (arquivo: string) => JSON.parse(readFileSync(resolve(FIX, arquivo), 'utf8')) as Record<string, unknown>;
const TOKEN = `rgm_it_${'G'.repeat(32)}`;
const TOKEN_BARRA = `rgm_it_${'H'.repeat(32)}`;
const CENTRO = 'loja-lig-centro';
const BARRA = 'loja-lig-barra';
const APLICATIVO = 'aplicativo-do-liame-de-teste';
/** O segredo do aplicativo do Liame no DMS ID de mentira (nome neutro, V123). */
const VALOR_DO_APLICATIVO = 'valor-do-aplicativo-de-teste-0123456789';
const T0 = new Date('2026-10-21T12:00:00Z');
const mais = (min: number) => new Date(T0.getTime() + min * 60_000);
const vazia = (cursor: string) => ({ itens: [], proximo_cursor: cursor, tem_mais: false });
type Resposta = { status: number; corpo: unknown; problema?: boolean };
const problema = (status: number, tipo: string): Resposta => ({
  status,
  corpo: { type: `https://api.dmsregem.com/problemas/${tipo}`, title: tipo, status, detail: `recusado: ${tipo}` },
  problema: true,
});

type Chamada = { via: 'token' | 'ligacao'; rota: string; metodo: string; status: number; cabecalhos: IncomingHttpHeaders; corpo: string };

describe.skipIf(!hasDb)('o Liame lê o Regem pela ligação (Hub DMS, F3, parte B)', () => {
  let api: TestApi;
  let database: Database;
  let servidor: Server;
  let base = '';
  const anterior: Record<string, string | undefined> = {};
  const regem = {
    viaLigada: true,
    /** O DMS ID ainda não conhece o recurso do Regem (o pior caso: recusa o pedido, 400). */
    recursoRecusado: false,
    /** O token do DMS ID vem sem nenhuma permissão do Regem: a troca responde 403 (`DmsIdService.conferir` do #690). */
    tokenSemPermissao: false,
    /** O Regem recusa todo token do DMS ID (a chave de assinatura trocou e ele ainda não leu a nova). */
    recusarTokenDmsId: false,
    tokensValidos: new Set([TOKEN, TOKEN_BARRA]),
    tokensDmsId: new Set<string>(),
    tokensDmsIdRecusados: new Set<string>(),
    /** O segredo da ligação de agora de cada `rgm_it_`: a troca gira, e a anterior para de valer. */
    ligacoes: new Map<string, string>(),
    lojaDaTroca: null as string | null,
    /** Pela ligação, o telefone do primeiro pedido vem outro (`vezes`: só nas primeiras N leituras). */
    telefoneNaLigacao: null as { telefone: string; vezes?: number } | null,
    /** A rota que a ligação recusa por permissão (403): o token do DMS ID sem a permissão dela. */
    proibidaNaLigacao: null as string | null,
    /** O que acontece no meio de uma chamada pela ligação que vai ser recusada (a comparação que troca bem nessa hora). */
    antesDeRecusarLigacao: null as (() => Promise<void>) | null,
  };
  const chamadas: Chamada[] = [];
  const trocas: string[] = [];
  const pedidosDeToken: URLSearchParams[] = [];
  /** Os cupons que o Regem criou, pela chave de idempotência. */
  const cuponsCriados = new Map<string, Record<string, unknown>>();
  let e: { cookie: string; tenantId: string; brandId: string; centro: string; barra: string };
  let configDesligada: AppConfig;
  let configLigada: AppConfig;

  const lojaDe = (token: string) => (token === TOKEN ? CENTRO : BARRA);
  const bearer = (c: IncomingHttpHeaders) => (c.authorization ?? '').replace(/^Bearer /, '');
  const tokenDmsIdVale = (t: string) => !regem.recusarTokenDmsId && regem.tokensDmsId.has(t) && !regem.tokensDmsIdRecusados.has(t);

  function tokenDoDmsId(cabecalhos: IncomingHttpHeaders, corpo: string): Resposta {
    const params = new URLSearchParams(corpo);
    pedidosDeToken.push(params);
    const esperado = `Basic ${Buffer.from(`${encodeURIComponent(APLICATIVO)}:${encodeURIComponent(VALOR_DO_APLICATIVO)}`).toString('base64')}`;
    if (cabecalhos.authorization !== esperado || params.get('grant_type') !== 'client_credentials') return { status: 401, corpo: { error: 'invalid_client' } };
    if (regem.recursoRecusado) return { status: 400, corpo: { error: 'invalid_target' } };
    const token = `tok-${regem.tokensDmsId.size + 1}-${randomUUID()}`;
    regem.tokensDmsId.add(token);
    return { status: 200, corpo: { access_token: token, token_type: 'Bearer', expires_in: 3600 } };
  }

  function troca(cabecalhos: IncomingHttpHeaders, corpo: { token_integracao?: string }): Resposta {
    if (!regem.viaLigada) return problema(404, 'nao-encontrado');
    if (!tokenDmsIdVale(bearer(cabecalhos))) return problema(401, 'token-invalido');
    if (regem.tokenSemPermissao) return problema(403, 'escopo-insuficiente');
    const t = corpo.token_integracao ?? '';
    if (!regem.tokensValidos.has(t)) return problema(401, 'ligacao-invalida');
    trocas.push(t);
    const { chave, prefixo } = gerarChave('lg', 'regem');
    regem.ligacoes.set(t, chave);
    return { status: 200, corpo: { ligacao: chave, prefixo, loja_id: regem.lojaDaTroca ?? lojaDe(t), permissoes: [...PERMISSOES_DA_LEITURA], segredo_em: new Date().toISOString() } };
  }

  /** Quem chama (o guard do Regem): o `rgm_it_` decide sozinho; sem ele, o token do DMS ID e depois a ligação. */
  function acesso(cabecalhos: IncomingHttpHeaders): { via: 'token' | 'ligacao'; token?: string; recusa?: Resposta } {
    const b = bearer(cabecalhos);
    if (b.startsWith('rgm_it_')) return regem.tokensValidos.has(b) ? { via: 'token', token: b } : { via: 'token', recusa: problema(401, 'token-invalido') };
    // Sem o `rgm_it_` e com a via desligada, o Regem responde como ao token que não vale.
    if (!regem.viaLigada || !tokenDmsIdVale(b)) return { via: 'ligacao', recusa: problema(401, 'token-invalido') };
    const ligacao = String(cabecalhos['dms-ligacao'] ?? '');
    const dono = [...regem.ligacoes.entries()].find(([, l]) => l === ligacao)?.[0];
    if (!dono || !regem.tokensValidos.has(dono)) return { via: 'ligacao', recusa: problema(401, 'ligacao-invalida') };
    return { via: 'ligacao', token: dono };
  }

  function responder(caminho: string, metodo: string, token: string, via: 'token' | 'ligacao', cabecalhos: IncomingHttpHeaders, corpo: string, q: URLSearchParams): Resposta {
    const centro = token === TOKEN;
    const cursor = q.get('cursor');
    switch (`${metodo} ${caminho}`) {
      case 'GET loja': {
        const loja: Record<string, unknown> = centro
          ? { ...fixture('loja-centro.json'), loja_id: CENTRO }
          : { ...fixture('loja-barra.json'), loja_id: BARRA, escopos: ['pedidos.ler', 'cupons.criar'] };
        // Pela ligação, as permissões que valem na chamada: as da ligação E as do token do DMS ID (só as de leitura).
        if (via === 'ligacao') loja.escopos = (loja.escopos as string[]).filter((s) => (PERMISSOES_DA_LEITURA as readonly string[]).includes(s));
        return { status: 200, corpo: loja };
      }
      case 'GET pedidos': {
        if (!centro) return { status: 200, corpo: cursor ? vazia(cursor) : fixture('pedidos-barra.json') };
        if (!cursor) {
          const pagina = fixture('pedidos-carga-1.json') as { itens: Record<string, unknown>[] };
          const outro = regem.telefoneNaLigacao;
          if (via === 'ligacao' && outro && (outro.vezes === undefined || outro.vezes > 0)) {
            if (outro.vezes !== undefined) outro.vezes -= 1;
            const [primeiro, ...resto] = pagina.itens;
            return { status: 200, corpo: { ...pagina, itens: [{ ...primeiro, cliente: { ...(primeiro!.cliente as object), telefone: outro.telefone } }, ...resto] } };
          }
          return { status: 200, corpo: pagina };
        }
        if (cursor === 'ped-c1') return { status: 200, corpo: fixture('pedidos-carga-2.json') };
        return { status: 200, corpo: vazia(cursor) };
      }
      case 'GET cupons':
        return { status: 200, corpo: cursor ? vazia('cup-c1') : fixture(centro ? 'cupons.json' : 'cupons-barra.json') };
      case 'GET clientes/anonimizados':
        return { status: 200, corpo: vazia(cursor ?? 'anon-c0') };
      case 'PUT webhook': {
        const pedido = JSON.parse(corpo) as { url: string };
        return { status: 200, corpo: { url: pedido.url, registrado_em: new Date().toISOString(), pausado: false, motivo_pausa: null } };
      }
      case 'POST autorizacao/revogar':
        regem.tokensValidos.delete(token);
        return { status: 200, corpo: { revogado: true } };
      case 'POST cupons': {
        const chave = String(cabecalhos['idempotency-key'] ?? '');
        const regra = JSON.parse(corpo) as Record<string, unknown>;
        let cupom = cuponsCriados.get(chave);
        if (!cupom) {
          cupom = {
            id: `cup-novo-${cuponsCriados.size + 1}`,
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
          cuponsCriados.set(chave, cupom);
        }
        return { status: 201, corpo: cupom };
      }
      default:
        return problema(404, 'nao-encontrado');
    }
  }

  async function rota(url: URL, metodo: string, cabecalhos: IncomingHttpHeaders, corpo: string): Promise<Resposta> {
    const caminho = url.pathname.slice('/regem/'.length);
    const a = acesso(cabecalhos);
    const gancho = regem.antesDeRecusarLigacao;
    if (a.recusa && a.via === 'ligacao' && gancho) {
      regem.antesDeRecusarLigacao = null;
      await gancho();
    }
    let r: Resposta;
    if (a.recusa) r = a.recusa;
    else if (a.via === 'ligacao' && regem.proibidaNaLigacao === caminho) r = problema(403, 'escopo-insuficiente');
    else r = responder(caminho, metodo, a.token!, a.via, cabecalhos, corpo, url.searchParams);
    chamadas.push({ via: a.via, rota: caminho, metodo, status: r.status, cabecalhos, corpo });
    return r;
  }

  const loop = () => new ComparacaoDmsIdLoop(database, loadConfig(), api.app.get(VaultService), api.app.get(FlagService));
  const sincronizador = (config: AppConfig) => new SincronizadorVendas(database.db, api.app.get(VaultService), config, apagarAnonimizadosNoSistema(database.db));
  const comparacoes = (conta: string, quando: Date) =>
    ownerQuery<{ tool: string; outcome: string; differences: string[]; retried: boolean; failure: string | null }>(
      `select tool, outcome, differences, retried, failure from liame.credential_comparison where connected_account_id = $1 and compared_at = $2 order by tool`,
      [conta, quando.toISOString()],
    );
  const estadoDaComparacao = async (conta: string) =>
    (await ownerQuery<{ next_at: Date; last_error: string | null }>(`select next_at, last_error from liame.credential_comparison_state where connected_account_id = $1`, [conta]))[0]!;
  const ligacaoNoCofre = async (conta: string) =>
    (
      await ownerQuery<{ ligacao_secret_id: string | null; purpose: string | null; revogado: boolean | null; status: string }>(
        `select a.ligacao_secret_id, s.purpose, s.revoked_at is not null as revogado, a.status
           from liame.connected_account a left join liame.secret s on s.id = a.ligacao_secret_id where a.id = $1`,
        [conta],
      )
    )[0]!;
  const segredoRevogado = async (id: string) => (await ownerQuery<{ revogado: boolean }>(`select revoked_at is not null as revogado from liame.secret where id = $1`, [id]))[0]!.revogado;
  const avisoGravado = async (conta: string) =>
    (await ownerQuery<{ aviso: { em: string; ok: boolean; via?: string } | null }>(`select cursor->'aviso' as aviso from liame.sync_state where connected_account_id = $1 and dataset = 'pedidos'`, [conta]))[0]
      ?.aviso ?? null;
  /** As chamadas de uma loja desde uma posição da lista (as rotas de leitura e escrita, sem a troca). */
  const desde = (posicao: number, token: string) => chamadas.slice(posicao).filter((c) => c.via === 'ligacao' || bearer(c.cabecalhos) === token);

  beforeAll(async () => {
    await runMigrations({ connectionString: OWNER_URL, dir: resolve(process.cwd(), '../../packages/database/migrations') });
    servidor = createServer((req, res) => {
      const partes: Buffer[] = [];
      req.on('data', (d: Buffer) => partes.push(d));
      req.on('end', () => {
        const texto = Buffer.concat(partes).toString('utf8');
        const url = new URL(req.url ?? '/', base);
        const atender = async (): Promise<Resposta> => {
          if (url.pathname === '/dmsid/oidc/token' && req.method === 'POST') return tokenDoDmsId(req.headers, texto);
          if (url.pathname === '/regem/dms-id/ligacao' && req.method === 'POST') return troca(req.headers, JSON.parse(texto || '{}') as { token_integracao?: string });
          if (url.pathname.startsWith('/regem/')) return rota(url, req.method ?? 'GET', req.headers, texto);
          return { status: 404, corpo: {} };
        };
        // Erro no servidor de teste vira 500 (o conector trata como falha passageira), nunca promessa solta.
        atender()
          .catch((): Resposta => ({ status: 500, corpo: {} }))
          .then((r) => {
            res.writeHead(r.status, { 'content-type': r.problema ? 'application/problem+json' : 'application/json' });
            res.end(JSON.stringify(r.corpo));
          });
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
    configDesligada = loadConfig();
    configLigada = { ...configDesligada, produtos: { ...configDesligada.produtos, regemPelaLigacao: true } };
    const s = await signupAndLogin(api, undefined, 'Mister Burgers pela ligação');
    await enableMfa(api, s.cookie);
    const tenantId = s.me.active_organization_id as string;
    const brandId = (await ownerQuery<{ id: string }>(`select id from liame.brand where tenant_id = $1 limit 1`, [tenantId]))[0]!.id;
    const conexao = await registrarConexaoDaDistribuicao(
      { db: database.db, vault: api.app.get(VaultService), config: configDesligada },
      { tenantId, brandId, produto: 'regem', tokens: [TOKEN, TOKEN_BARRA] },
    );
    const ligadas = await api.call('POST', `/v1/connections/${conexao.connectionId}/accounts`, {
      cookie: s.cookie,
      body: { accounts: [{ provider: 'regem', external_id: CENTRO }, { provider: 'regem', external_id: BARRA }] },
    });
    expect(ligadas.status, JSON.stringify(ligadas.body)).toBe(200);
    const id = (externo: string) => (ligadas.body.linked as { id: string; external_id: string }[]).find((l) => l.external_id === externo)!.id;
    e = { cookie: s.cookie, tenantId, brandId, centro: id(CENTRO), barra: id(BARRA) };
    chamadas.length = 0;
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

  async function ligarFlag(valor: boolean) {
    await ownerQuery(`delete from liame.feature_flag_rule where flag_key = $1 and scope_type = 'tenant' and scope_id = $2`, [FLAG_COMPARACAO, e.tenantId]);
    if (valor) {
      await ownerQuery(`insert into liame.feature_flag_rule (id, flag_key, scope_type, scope_id, value, created_by) values (gen_random_uuid(), $1, 'tenant', $2, 'true'::jsonb, 'testes')`, [FLAG_COMPARACAO, e.tenantId]);
    }
    api.app.get(FlagService).invalidate();
  }

  it('comparação: com a função desligada para a empresa, as lojas do Regem passam sem chamada e voltam no dia seguinte', async () => {
    expect(await loop().executarLote(5, { tenantIds: [e.tenantId] }, T0)).toEqual([{ status: 'desligada' }, { status: 'desligada' }]);
    expect([chamadas.length, trocas.length, pedidosDeToken.length]).toEqual([0, 0, 0]);
    expect(new Date((await estadoDaComparacao(e.centro)).next_at).toISOString()).toBe(mais(24 * 60).toISOString());
  });

  it('comparação: o DMS ID que ainda não conhece o recurso do Regem, ou o token sem permissão do Regem, deixam a loja para o dia seguinte', async () => {
    await ligarFlag(true);
    regem.recursoRecusado = true;
    try {
      const r = await loop().executarLote(5, { tenantIds: [e.tenantId] }, mais(24 * 60));
      expect(r).toEqual([
        { status: 'falhou', erro: 'dms_id:400:invalid_target' },
        { status: 'falhou', erro: 'dms_id:400:invalid_target' },
      ]);
    } finally {
      regem.recursoRecusado = false;
    }
    // O token pede o recurso do Regem (o endereço das rotas de integração) e só as permissões de leitura.
    expect(pedidosDeToken[0]!.get('resource')).toBe(`${base}/regem`);
    expect(pedidosDeToken[0]!.get('scope')!.split(' ').sort()).toEqual([...PERMISSOES_DA_LEITURA].sort());
    expect([chamadas.length, trocas.length]).toEqual([0, 0]);
    const estado = await estadoDaComparacao(e.centro);
    expect([new Date(estado.next_at).toISOString(), estado.last_error]).toEqual([mais(48 * 60).toISOString(), 'dms_id:400:invalid_target']);

    // O token sem nenhuma permissão do Regem: a troca recusa (403) e a loja também volta no dia seguinte.
    regem.tokenSemPermissao = true;
    try {
      expect(await loop().executarLote(5, { tenantIds: [e.tenantId] }, mais(48 * 60))).toEqual([
        { status: 'falhou', erro: 'troca: permissao:escopo-insuficiente' },
        { status: 'falhou', erro: 'troca: permissao:escopo-insuficiente' },
      ]);
    } finally {
      regem.tokenSemPermissao = false;
    }
    expect(new Date((await estadoDaComparacao(e.barra)).next_at).toISOString()).toBe(mais(72 * 60).toISOString());
  });

  it('comparação: com a via do DMS ID desligada no Regem, a troca dá 404 e a loja volta no dia seguinte', async () => {
    regem.viaLigada = false;
    try {
      expect(await loop().executarLote(5, { tenantIds: [e.tenantId] }, mais(72 * 60))).toEqual([
        { status: 'falhou', erro: 'troca: definitivo:nao-encontrado' },
        { status: 'falhou', erro: 'troca: definitivo:nao-encontrado' },
      ]);
    } finally {
      regem.viaLigada = true;
    }
    expect(trocas).toEqual([]);
    expect(new Date((await estadoDaComparacao(e.centro)).next_at).toISOString()).toBe(mais(96 * 60).toISOString());
  });

  it('comparação: troca o rgm_it_ pela ligação (cofre e auditoria) e as 4 leituras saem pelas duas vias e dão igual; sem o escopo, sem dado', async () => {
    const agora = mais(96 * 60);
    const comparadora = loop();
    const r = await comparadora.executarLote(5, { tenantIds: [e.tenantId] }, agora);
    expect(r).toEqual(
      expect.arrayContaining([
        { status: 'comparada', iguais: 4, diferentes: 0, outros: 0 },
        { status: 'comparada', iguais: 2, diferentes: 0, outros: 2 },
      ]),
    );
    // Uma troca por loja; o segredo vai para o cofre, com a auditoria (só o prefixo).
    expect([...trocas].sort()).toEqual([TOKEN, TOKEN_BARRA].sort());
    for (const conta of [e.centro, e.barra]) expect(await ligacaoNoCofre(conta)).toMatchObject({ purpose: 'ligacao_regem', revogado: false, status: 'ativa' });
    const auditorias = await ownerQuery<{ resource_id: string; after: Record<string, unknown> }>(
      `select resource_id, "after" from liame.audit_event where tenant_id = $1 and action = 'conexao.ligacao_dms_id'`,
      [e.tenantId],
    );
    expect(auditorias).toHaveLength(2);
    for (const a of auditorias) {
      expect(String(a.after.ligacao)).toMatch(/^dms_lg_regem_.{5}$/);
      for (const segredo of regem.ligacoes.values()) expect(JSON.stringify(a)).not.toContain(segredo);
    }

    // As 4 leituras da loja do Centro pelas duas vias; na da Barra, cupons e avisos ficam sem dado (ela não liberou).
    expect((await comparacoes(e.centro, agora)).map((l) => [l.tool, l.outcome])).toEqual([
      ['regem_clientes_anonimizados', 'igual'],
      ['regem_cupons', 'igual'],
      ['regem_loja', 'igual'],
      ['regem_pedidos', 'igual'],
    ]);
    expect((await comparacoes(e.barra, agora)).map((l) => [l.tool, l.outcome])).toEqual([
      ['regem_clientes_anonimizados', 'sem_dado'],
      ['regem_cupons', 'sem_dado'],
      ['regem_loja', 'igual'],
      ['regem_pedidos', 'igual'],
    ]);
    // Pela via nova, o token do DMS ID e a ligação; pela de hoje, o rgm_it_ e nada de ligação.
    for (const c of chamadas.filter((x) => x.via === 'ligacao')) {
      expect(c.cabecalhos.authorization).toMatch(/^Bearer tok-/);
      expect(String(c.cabecalhos['dms-ligacao'])).toMatch(/^dms_lg_regem_/);
    }
    for (const c of chamadas.filter((x) => x.via === 'token')) expect(c.cabecalhos['dms-ligacao']).toBeUndefined();
    // Os pedidos comparados são os confirmados dos últimos 3 dias, a primeira página, iguais pelas duas vias.
    const pedidos = chamadas.filter((c) => c.rota === 'pedidos');
    expect(new Set(pedidos.map((c) => c.via))).toEqual(new Set(['token', 'ligacao']));

    // Na vez seguinte, usa a ligação e o token guardados: sem troca e sem pedir outro token.
    const tokensAntes = pedidosDeToken.length;
    await comparadora.executarLote(5, { tenantIds: [e.tenantId] }, mais(97 * 60));
    expect([trocas.length, pedidosDeToken.length]).toEqual([2, tokensAntes]);
  });

  it('comparação: diferença de verdade (o telefone de um pedido) repete uma vez e fica "diferente", só com o caminho; o telefone nunca é guardado', async () => {
    regem.telefoneNaLigacao = { telefone: '+5521900000099' };
    try {
      const agora = mais(98 * 60);
      await loop().compararConta(database.db, e.centro, e.tenantId, agora);
      const linha = (await comparacoes(e.centro, agora)).find((l) => l.tool === 'regem_pedidos')!;
      expect(linha).toMatchObject({ outcome: 'diferente', retried: true, differences: ['itens[0].cliente.telefone'] });
      const tudo = JSON.stringify(await ownerQuery(`select * from liame.credential_comparison where tenant_id = $1`, [e.tenantId]));
      expect(tudo).not.toContain('900000099');
      expect(tudo).not.toContain('99999-8888');
    } finally {
      regem.telefoneNaLigacao = null;
    }
    // A diferença que some na repetição (o dado mudou entre as duas leituras) conta como igual, marcada como repetida.
    regem.telefoneNaLigacao = { telefone: '+5521900000099', vezes: 1 };
    const agora = mais(99 * 60);
    await loop().compararConta(database.db, e.centro, e.tenantId, agora);
    expect((await comparacoes(e.centro, agora)).find((l) => l.tool === 'regem_pedidos')).toMatchObject({ outcome: 'igual', retried: true, differences: [] });
    regem.telefoneNaLigacao = null;
  });

  it('comparação: o token do DMS ID recusado pelo Regem é esquecido e pedido de novo uma vez; a comparação segue igual', async () => {
    const comparadora = loop();
    await comparadora.compararConta(database.db, e.centro, e.tenantId, mais(100 * 60));
    for (const t of regem.tokensDmsId) regem.tokensDmsIdRecusados.add(t);
    const antes = pedidosDeToken.length;
    const agora = mais(101 * 60);
    expect(await comparadora.compararConta(database.db, e.centro, e.tenantId, agora)).toEqual({ status: 'comparada', iguais: 4, diferentes: 0, outros: 0 });
    expect(pedidosDeToken.length - antes).toBe(1);
    expect((await comparacoes(e.centro, agora)).filter((l) => l.retried).length).toBeGreaterThan(0);
  });

  it('comparação: a troca que devolve a ligação de OUTRA loja não guarda nada; a ligação recusada sai do cofre e é trocada de novo', async () => {
    // A ligação de agora do Centro para de valer no Regem (girada por outra troca): a comparação recusa e tira do cofre.
    const guardada = await ligacaoNoCofre(e.centro);
    regem.ligacoes.set(TOKEN, gerarChave('lg', 'regem').chave);
    expect(await loop().compararConta(database.db, e.centro, e.tenantId, mais(102 * 60))).toEqual({ status: 'comparada', iguais: 0, diferentes: 4, outros: 0 });
    expect((await comparacoes(e.centro, mais(102 * 60))).every((l) => l.outcome === 'nova_falhou' && l.failure === 'autenticacao:ligacao-invalida')).toBe(true);
    expect(await segredoRevogado(guardada.ligacao_secret_id!)).toBe(true);
    // A recusa da via nova não mexe na loja: ela segue conectada para a leitura de verdade.
    expect((await ligacaoNoCofre(e.centro)).status).toBe('ativa');

    // A troca seguinte devolve outra loja: nada é guardado e a vez conta como falha da troca.
    regem.lojaDaTroca = 'loja-de-outra-empresa';
    try {
      expect(await loop().compararConta(database.db, e.centro, e.tenantId, mais(103 * 60))).toEqual({ status: 'falhou', erro: 'troca: definitivo' });
      expect((await ligacaoNoCofre(e.centro)).ligacao_secret_id).toBe(guardada.ligacao_secret_id);
    } finally {
      regem.lojaDaTroca = null;
    }
    const trocasAntes = trocas.length;
    expect(await loop().compararConta(database.db, e.centro, e.tenantId, mais(104 * 60))).toEqual({ status: 'comparada', iguais: 4, diferentes: 0, outros: 0 });
    expect(trocas.length).toBe(trocasAntes + 1);
  });

  it('distribuição e descoberta: o token que o Regem recusa é da loja (pelo acesso do token)', async () => {
    const recusado = `rgm_it_${'Z'.repeat(32)}`;
    await expect(
      registrarConexaoDaDistribuicao({ db: database.db, vault: api.app.get(VaultService), config: configDesligada }, { tenantId: e.tenantId, brandId: e.brandId, produto: 'regem', tokens: [recusado] }),
    ).rejects.toThrow('o Regem recusou um dos tokens');
    // A descoberta deixa de fora a loja do token recusado; com todos recusados, a conexão precisa ser refeita.
    const cliente = new ClienteConector(database.db, { enderecos: enderecosDasPlataformas(configDesligada.plataformas, configDesligada.produtos), tentativas: 1 });
    const credencial = (tokens: string[]) => ({
      tipo: 'regem' as const,
      lojas: tokens.map((token, i) => ({ loja_id: `loja-${i}`, token, escopos: ['pedidos.ler'] })),
      obtido_em: T0.toISOString(),
    });
    expect((await descobrirLojas(cliente, configDesligada.produtos.regemApiUrl, credencial([recusado, TOKEN]))).map((d) => d.external_id)).toEqual([CENTRO]);
    await expect(descobrirLojas(cliente, configDesligada.produtos.regemApiUrl, credencial([recusado]))).rejects.toMatchObject({ tipo: 'autenticacao' });
  });

  it('leitura de verdade com a chave desligada: tudo pelo rgm_it_, mesmo com a ligação no cofre, que nem é lida', async () => {
    const { ligacao_secret_id } = await ligacaoNoCofre(e.centro);
    expect(ligacao_secret_id).not.toBeNull();
    const leitura = vi.spyOn(api.app.get(VaultService), 'readSecret');
    const posicao = chamadas.length;
    try {
      expect(await sincronizador(configDesligada).sincronizar(e.centro, e.tenantId, T0)).toMatchObject({ status: 'ok', pedidos: { novos: 6 } });
      // A segunda leitura (depois da carga inicial) registra o aviso, pelo token.
      expect((await sincronizador(configDesligada).sincronizar(e.centro, e.tenantId, mais(20))).status).toBe('ok');
      expect(leitura.mock.calls.filter(([, id]) => id === ligacao_secret_id)).toEqual([]);
    } finally {
      leitura.mockRestore();
    }
    const desta = desde(posicao, TOKEN);
    expect(desta.length).toBeGreaterThan(0);
    expect(desta.every((c) => c.via === 'token' && c.cabecalhos['dms-ligacao'] === undefined)).toBe(true);
    expect(desta.filter((c) => c.rota === 'webhook')).toHaveLength(1);
    expect(await avisoGravado(e.centro)).toEqual({ em: mais(20).toISOString(), ok: true, via: 'token' });

    // O registro de antes da F3 (sem `via`) conta como do token: pelo token, nada a repetir antes do dia seguinte.
    await ownerQuery(`update liame.sync_state set cursor = cursor || jsonb_build_object('aviso', jsonb_build_object('em', $2::text, 'ok', true)) where connected_account_id = $1 and dataset = 'pedidos'`, [
      e.centro,
      mais(20).toISOString(),
    ]);
    const antes = chamadas.length;
    expect((await sincronizador(configDesligada).sincronizar(e.centro, e.tenantId, mais(30))).status).toBe('ok');
    expect(desde(antes, TOKEN).filter((c) => c.rota === 'webhook')).toEqual([]);
  });

  it('leitura de verdade pela ligação: com a chave ligada, as leituras saem pela ligação e o aviso é registrado de novo na hora, por ela', async () => {
    const posicao = chamadas.length;
    // Vinte minutos depois do registro pelo token (bem antes do dia seguinte): a passagem para a ligação registra de novo.
    expect((await sincronizador(configLigada).sincronizar(e.centro, e.tenantId, mais(40))).status).toBe('ok');
    const desta = desde(posicao, TOKEN);
    expect(desta.map((c) => c.rota).sort()).toEqual(['clientes/anonimizados', 'cupons', 'pedidos', 'webhook']);
    expect(desta.every((c) => c.via === 'ligacao' && c.status === 200)).toBe(true);
    expect(await avisoGravado(e.centro)).toEqual({ em: mais(40).toISOString(), ok: true, via: 'ligacao' });
    // Sem trocar de credencial, o registro volta a ser uma vez por dia.
    const depois = chamadas.length;
    await sincronizador(configLigada).sincronizar(e.centro, e.tenantId, mais(60));
    expect(desde(depois, TOKEN).filter((c) => c.rota === 'webhook')).toEqual([]);
  });

  it('pela ligação, a ligação recusada é repetida pelo rgm_it_: a leitura termina pelo token, a loja segue ativa e a ligação sai do cofre', async () => {
    const guardada = await ligacaoNoCofre(e.centro);
    regem.ligacoes.set(TOKEN, gerarChave('lg', 'regem').chave);
    const posicao = chamadas.length;
    const aviso = vi.spyOn(Logger.prototype, 'warn');
    try {
      expect((await sincronizador(configLigada).sincronizar(e.centro, e.tenantId, mais(80))).status).toBe('ok');
      const log = aviso.mock.calls.map((c) => String(c[0])).find((m) => m.includes('recusou a ligação do Hub DMS'));
      expect(log).toContain('autenticacao:ligacao-invalida');
      expect(log).toContain('segue pelo token');
      for (const segredo of regem.ligacoes.values()) expect(log).not.toContain(segredo);
    } finally {
      aviso.mockRestore();
    }
    // A primeira chamada pela ligação foi recusada e repetida pelo token; o resto da execução foi pelo token.
    const desta = desde(posicao, TOKEN);
    expect(desta[0]).toMatchObject({ via: 'ligacao', status: 401 });
    expect(desta.slice(1).every((c) => c.via === 'token' && c.status === 200)).toBe(true);
    expect(desta[1]!.rota).toBe(desta[0]!.rota);
    // A loja não foi desconectada; a ligação recusada saiu do cofre; o aviso foi registrado de novo, pelo token.
    expect(await ligacaoNoCofre(e.centro)).toMatchObject({ ligacao_secret_id: null, status: 'ativa' });
    expect(await segredoRevogado(guardada.ligacao_secret_id!)).toBe(true);
    expect((await avisoGravado(e.centro))?.via).toBe('token');

    // Sem ligação no cofre, a leitura segue pelo token; a comparação troca de novo, e a leitura volta para a ligação.
    expect(await loop().compararConta(database.db, e.centro, e.tenantId, mais(105 * 60))).toMatchObject({ status: 'comparada', iguais: 4 });
    const depois = chamadas.length;
    expect((await sincronizador(configLigada).sincronizar(e.centro, e.tenantId, mais(100))).status).toBe('ok');
    expect(desde(depois, TOKEN).every((c) => c.via === 'ligacao')).toBe(true);
  });

  it('a ligação recusada só sai do cofre se ainda for a que a leitura usou: a trocada no meio pela comparação fica', async () => {
    const vault = api.app.get(VaultService);
    const usada = (await ligacaoNoCofre(e.centro)).ligacao_secret_id!;
    regem.ligacoes.set(TOKEN, gerarChave('lg', 'regem').chave);
    let trocadaNoMeio = '';
    // Bem na hora da recusa, a comparação troca de novo e guarda a ligação nova (como `trocarNoRegem`).
    regem.antesDeRecusarLigacao = async () => {
      const nova = gerarChave('lg', 'regem');
      regem.ligacoes.set(TOKEN, nova.chave);
      await withTenant(database.db, e.tenantId, async (tx) => {
        trocadaNoMeio = await vault.putSecret(tx, {
          tenantId: e.tenantId,
          purpose: PROPOSITO_DA_LIGACAO_REGEM,
          plaintext: JSON.stringify({ tipo: 'ligacao_regem', ligacao: nova.chave, prefixo: nova.prefixo, origem: resumoDoToken(TOKEN), obtida_em: new Date().toISOString() }),
        });
        await vault.revokeSecret(tx, usada);
        await tx.execute(sql`update liame.connected_account set ligacao_secret_id = ${trocadaNoMeio} where id = ${e.centro}`);
      });
    };
    expect((await sincronizador(configLigada).sincronizar(e.centro, e.tenantId, mais(110))).status).toBe('ok');
    expect(regem.antesDeRecusarLigacao).toBeNull();
    // A leitura não apagou a ligação que a comparação acabou de guardar; a próxima leitura vai por ela.
    expect(await ligacaoNoCofre(e.centro)).toMatchObject({ ligacao_secret_id: trocadaNoMeio, revogado: false, status: 'ativa' });
    const depois = chamadas.length;
    expect((await sincronizador(configLigada).sincronizar(e.centro, e.tenantId, mais(115))).status).toBe('ok');
    expect(desde(depois, TOKEN).every((c) => c.via === 'ligacao' && c.status === 200)).toBe(true);
  });

  it('pela ligação, o token do DMS ID recusado mesmo depois de pedir outro é do aplicativo: a leitura segue pelo token e a ligação fica', async () => {
    const guardada = await ligacaoNoCofre(e.centro);
    regem.recusarTokenDmsId = true;
    const posicao = chamadas.length;
    try {
      expect((await sincronizador(configLigada).sincronizar(e.centro, e.tenantId, mais(120))).status).toBe('ok');
    } finally {
      regem.recusarTokenDmsId = false;
    }
    const desta = desde(posicao, TOKEN);
    // Duas recusas pela ligação (o token guardado e o pedido de novo), depois tudo pelo token.
    expect(desta.slice(0, 2).map((c) => [c.via, c.status])).toEqual([
      ['ligacao', 401],
      ['ligacao', 401],
    ]);
    expect(desta.slice(2).every((c) => c.via === 'token' && c.status === 200)).toBe(true);
    expect(await ligacaoNoCofre(e.centro)).toMatchObject({ ligacao_secret_id: guardada.ligacao_secret_id, revogado: false, status: 'ativa' });
  });

  it('pela ligação, a leitura que a ligação recusa por permissão (403) é lida pelo token', async () => {
    regem.proibidaNaLigacao = 'cupons';
    const posicao = chamadas.length;
    try {
      expect(await sincronizador(configLigada).sincronizar(e.centro, e.tenantId, mais(140))).toMatchObject({ status: 'ok', semPermissao: [] });
    } finally {
      regem.proibidaNaLigacao = null;
    }
    const cupons = desde(posicao, TOKEN).filter((c) => c.rota === 'cupons');
    expect(cupons.map((c) => [c.via, c.status])).toEqual([
      ['ligacao', 403],
      ['token', 200],
    ]);
  });

  it('cupom pela ligação: a criação vai pela ligação com a chave de idempotência; recusada, repete pelo token com a mesma chave e nasce um cupom só', async () => {
    const vault = api.app.get(VaultService);
    regemCupomConnector.ligar({
      lerSegredo: (tx, id) => vault.readSecret(tx, id),
      cliente: () => new ClienteConector(database.db, { enderecos: enderecosDasPlataformas(configLigada.plataformas, configLigada.produtos), tentativas: 1 }),
      config: configLigada,
      sha256,
    });
    const regra = (codigo: string) => ({ codigo, nome: `Cupom ${codigo}`, tipo: 'percentual' as const, percentual: '10', valido_de: '2026-10-21', valido_ate: '2026-10-31' });
    const criar = (codigo: string) => withTenant(database.db, e.tenantId, (tx) => regemCupomConnector.criarCupomDaMensagem(tx, { tenantId: e.tenantId, lojaId: e.barra, regra: regra(codigo) }));

    let posicao = chamadas.length;
    const tokensAntes = pedidosDeToken.length;
    expect(await criar('LIGA10')).toMatchObject({ ok: true });
    let posts = chamadas.slice(posicao).filter((c) => c.rota === 'cupons' && c.metodo === 'POST');
    expect(posts.map((c) => [c.via, c.status])).toEqual([['ligacao', 201]]);
    expect(String(posts[0]!.cabecalhos['idempotency-key'])).toMatch(/^liame-[0-9a-f]{48}$/);
    // O token do DMS ID da criação pede também "criar cupom" (F3-5); o da leitura, não.
    expect(pedidosDeToken.slice(tokensAntes).map((p) => p.get('scope')!.split(' ').sort())).toEqual([[...PERMISSOES_DA_LEITURA, 'cupons.criar'].sort()]);

    // A ligação da Barra para de valer: a criação repete pelo token, com a MESMA chave; o Regem cria um cupom só.
    regem.ligacoes.set(TOKEN_BARRA, gerarChave('lg', 'regem').chave);
    const criadosAntes = cuponsCriados.size;
    posicao = chamadas.length;
    expect(await criar('LIGA20')).toMatchObject({ ok: true });
    posts = chamadas.slice(posicao).filter((c) => c.rota === 'cupons' && c.metodo === 'POST');
    expect(posts.map((c) => [c.via, c.status])).toEqual([
      ['ligacao', 401],
      ['token', 201],
    ]);
    expect(posts[0]!.cabecalhos['idempotency-key']).toBe(posts[1]!.cabecalhos['idempotency-key']);
    expect(cuponsCriados.size).toBe(criadosAntes + 1);
  });

  it('a recusa do rgm_it_ continua sendo da loja: pela ligação recusada e com o token revogado no Regem, a loja fica desconectada', async () => {
    regem.tokensValidos.delete(TOKEN);
    const posicao = chamadas.length;
    const r = await sincronizador(configLigada).sincronizar(e.centro, e.tenantId, mais(160));
    expect(r.status).toBe('falhou');
    const desta = desde(posicao, TOKEN);
    expect(desta.map((c) => [c.via, c.status])).toEqual([
      ['ligacao', 401],
      ['token', 401],
    ]);
    const [conta] = await ownerQuery<{ status: string; status_reason: string }>(`select status, status_reason from liame.connected_account where id = $1`, [e.centro]);
    expect(conta).toEqual({ status: 'desconectada', status_reason: 'O Regem recusou a autorização desta loja: conecte de novo.' });
  });

  it('desligar a loja revoga o rgm_it_ no Regem (o que leva a ligação junto) e tira a ligação do cofre', async () => {
    const guardada = await ligacaoNoCofre(e.barra);
    expect(guardada.ligacao_secret_id).not.toBeNull();
    const r = await api.call('DELETE', `/v1/connected-accounts/${e.barra}`, { cookie: e.cookie });
    expect(r.status, JSON.stringify(r.body)).toBe(204);
    expect(await segredoRevogado(guardada.ligacao_secret_id!)).toBe(true);
    // A revogação no Regem sai depois do commit, pelo rgm_it_ da loja.
    await vi.waitFor(() => expect(chamadas.some((c) => c.rota === 'autorizacao/revogar')).toBe(true), { timeout: 10_000, interval: 50 });
    const revogacao = chamadas.find((c) => c.rota === 'autorizacao/revogar')!;
    expect([revogacao.via, bearer(revogacao.cabecalhos), revogacao.status]).toEqual(['token', TOKEN_BARRA, 200]);
    expect(regem.tokensValidos.has(TOKEN_BARRA)).toBe(false);
  });
});
