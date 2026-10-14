import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { createDatabase, type Database, runMigrations } from '@liame/database';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ClienteConector, ErroConector } from '../../src/connectors/cliente-http.js';
import { enderecosDasPlataformas } from '../../src/connectors/enderecos.js';
import { ConectorSearchConsole, criarConectorSearchConsole } from '../../src/connectors/search-console/conector-search-console.js';
import { ownerQuery } from '../helpers/api.js';
import { APP_URL, hasDb, OWNER_URL } from './env.js';

// A6 · Z3 (parte a): o conector de leitura do Search Console contra um Search Console local, nos caminhos da API
// (`/webmasters/v3`). Confere a descoberta dos sites, o pedido exato das duas leituras (por dia e por busca), o site
// codificado no caminho, o que o conector recusa antes de pedir, a cota (o 403 com motivo de cota e o 429 viram
// "limite", sem insistir) e o critério A6-6: no registro, as duas capacidades são só de leitura.

const TOKEN = 'token-de-teste-search-console';
const DOMINIO = 'sc-domain:misterburgers.com.br';
const CARDAPIO = 'https://cardapio.misterburgers.com.br/';
const SEM_COTA_NO_DIA = 'https://semcota.misterburgers.com.br/';
const SEM_COTA_DE_CARGA = 'https://carga.misterburgers.com.br/';
const RECUSA = 'https://recusa.misterburgers.com.br/';
const CHEIO = 'https://cheio.misterburgers.com.br/';

type Pedido = { metodo: string; caminho: string; autorizacao: string | undefined; corpo: unknown };

describe.skipIf(!hasDb)('conector do Search Console (leitura; A6 · Z3)', () => {
  let database: Database;
  let google: Server;
  let base = '';
  const pedidos: Pedido[] = [];

  const json = (status: number, corpo: unknown) => ({ status, corpo });
  /** O erro no formato antigo das APIs do Google (a página "Standard Error Messages"). */
  const erroAntigo = (code: number, reason: string, message: string) => json(code, { error: { code, message, errors: [{ domain: 'usageLimits', reason, message }] } });
  const naoAchou = () => json(404, { error: { code: 404, message: 'Not Found', errors: [{ domain: 'global', reason: 'notFound', message: 'Not Found' }] } });

  const PREFIXO = '/webmasters/v3/sites/';
  const SUFIXO = '/searchAnalytics/query';

  function responder(req: IncomingMessage, corpo: unknown) {
    const url = new URL(req.url ?? '/', base);
    pedidos.push({ metodo: req.method ?? '', caminho: url.pathname, autorizacao: req.headers.authorization, corpo });
    if (req.method === 'GET' && url.pathname === '/webmasters/v3/sites') {
      return json(200, {
        siteEntry: [
          { siteUrl: DOMINIO, permissionLevel: 'siteOwner' },
          { siteUrl: CARDAPIO, permissionLevel: 'siteFullUser' },
          { siteUrl: 'https://alheio.exemplo.com/', permissionLevel: 'siteUnverifiedUser' },
        ],
      });
    }
    if (req.method === 'POST' && url.pathname.startsWith(PREFIXO) && url.pathname.endsWith(SUFIXO)) {
      const site = decodeURIComponent(url.pathname.slice(PREFIXO.length, -SUFIXO.length));
      if (site === SEM_COTA_NO_DIA) return erroAntigo(403, 'dailyLimitExceeded', 'Daily Limit Exceeded');
      if (site === SEM_COTA_DE_CARGA) return erroAntigo(403, 'quotaExceeded', 'Search Analytics load quota exceeded');
      if (site === RECUSA) return json(403, { error: { code: 403, message: "User does not have sufficient permission for site 'https://recusa.misterburgers.com.br/'.", errors: [{ domain: 'global', reason: 'forbidden' }] } });
      if (site === CHEIO) return json(429, { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded' } });
      const pedido = corpo as { dimensions?: string[] };
      if (pedido.dimensions?.[0] === 'date') {
        return json(200, {
          rows: [
            { keys: ['2026-10-01'], clicks: 4, impressions: 120, ctr: 0.0333, position: 8.5 },
            { keys: ['2026-10-02'], clicks: 9, impressions: 210, ctr: 0.0428, position: 6.1 },
          ],
          responseAggregationType: 'byProperty',
        });
      }
      return json(200, {
        rows: [
          { keys: ['mister burgers'], clicks: 7, impressions: 40, ctr: 0.175, position: 1.2 },
          { keys: ['hamburgueria perto de mim'], clicks: 4, impressions: 300, ctr: 0.0133, position: 6.8 },
        ],
        responseAggregationType: 'byProperty',
      });
    }
    return naoAchou();
  }

  const plataformas = () => ({
    metaGraphUrl: 'https://graph.facebook.com',
    googleAdsUrl: 'https://googleads.googleapis.com',
    ga4DataUrl: 'https://analyticsdata.googleapis.com',
    ga4AdminUrl: 'https://analyticsadmin.googleapis.com',
    dataManagerUrl: 'https://datamanager.googleapis.com',
    perfilGoogle: {
      contas: 'https://mybusinessaccountmanagement.googleapis.com',
      lojas: 'https://mybusinessbusinessinformation.googleapis.com',
      avaliacoes: 'https://mybusiness.googleapis.com',
      numeros: 'https://businessprofileperformance.googleapis.com',
    },
    searchConsoleUrl: base,
    metaAppSecret: null,
  });
  const cliente = () => new ClienteConector(database.db, { enderecos: enderecosDasPlataformas(plataformas()), tentativas: 1, esperaMaximaMs: 2_000, balde: { capacidade: 500, porSegundo: 50 } });
  const conector = () => new ConectorSearchConsole(cliente(), base, { sites: 'v3', buscas: 'v3' });
  const credencial = { accessToken: TOKEN };
  const JANELA = { inicio: '2026-10-01', fim: '2026-10-07' };
  async function erroDe(fn: () => Promise<unknown>): Promise<ErroConector> {
    try {
      await fn();
    } catch (err) {
      if (err instanceof ErroConector) return err;
      throw err;
    }
    throw new Error('a chamada não falhou');
  }

  beforeAll(async () => {
    await runMigrations({ connectionString: OWNER_URL, dir: resolve(process.cwd(), '../../packages/database/migrations') });
    database = createDatabase({ connectionString: APP_URL, max: 2, applicationName: 'liame-test' });
    google = createServer((req, res) => {
      const partes: Buffer[] = [];
      req.on('data', (p: Buffer) => partes.push(p));
      req.on('end', () => {
        const recebido = Buffer.concat(partes).toString('utf8');
        const r = responder(req, recebido ? JSON.parse(recebido) : null);
        res.writeHead(r.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(r.corpo));
      });
    });
    await new Promise<void>((ok) => google.listen(0, '127.0.0.1', ok));
    base = `http://127.0.0.1:${(google.address() as AddressInfo).port}`;
  }, 120_000);
  beforeEach(() => {
    pedidos.length = 0;
  });
  afterAll(async () => {
    await new Promise((ok) => google?.close(ok));
    await database?.close();
  });

  it('no registro de capacidades, as duas leituras são só de leitura e pedem a permissão de só leitura (A6-6); as versões vêm de lá', async () => {
    const linhas = await ownerQuery<{ capability: string; api_version: string; read: boolean; write: boolean; required_scope: string[] }>(
      `select capability, api_version, read, write, required_scope from liame.connector_capability where provider = 'search_console' order by capability collate "C"`,
    );
    expect(linhas).toEqual([
      { capability: 'search_analytics', api_version: 'v3', read: true, write: false, required_scope: ['https://www.googleapis.com/auth/webmasters.readonly'] },
      { capability: 'sites', api_version: 'v3', read: true, write: false, required_scope: ['https://www.googleapis.com/auth/webmasters.readonly'] },
    ]);
    const c = await criarConectorSearchConsole(database.db, cliente(), plataformas());
    expect(c.versoes).toEqual({ sites: 'v3', buscas: 'v3' });
    await c.descobrirSites(credencial);
    await c.lerDias(credencial, DOMINIO, JANELA);
    expect(pedidos.map((p) => p.caminho.split('/').slice(0, 3).join('/'))).toEqual(['/webmasters/v3', '/webmasters/v3']);
    // O conector não tem como escrever: só as três leituras.
    const metodos = Object.getOwnPropertyNames(ConectorSearchConsole.prototype).filter((m) => m !== 'constructor');
    expect(metodos.sort()).toEqual(['cabecalhos', 'consultar', 'descobrirSites', 'lerBuscas', 'lerDias']);
  });

  it('os sites: uma leitura, com a autorização da empresa; o site sem verificação fica de fora', async () => {
    expect(await conector().descobrirSites(credencial)).toEqual([
      { site: DOMINIO, nome: 'misterburgers.com.br', permissao: 'dono' },
      { site: CARDAPIO, nome: 'cardapio.misterburgers.com.br', permissao: 'completo' },
    ]);
    expect(pedidos).toEqual([{ metodo: 'GET', caminho: '/webmasters/v3/sites', autorizacao: `Bearer ${TOKEN}`, corpo: null }]);
  });

  it('por dia: o pedido exato (o dado final, o padrão da API), o domínio codificado no caminho e os dias lidos', async () => {
    expect(await conector().lerDias(credencial, DOMINIO, JANELA)).toEqual([
      { dia: '2026-10-01', cliques: 4, vezes: 120, posicao: 8.5 },
      { dia: '2026-10-02', cliques: 9, vezes: 210, posicao: 6.1 },
    ]);
    expect(pedidos).toEqual([
      {
        metodo: 'POST',
        caminho: '/webmasters/v3/sites/sc-domain%3Amisterburgers.com.br/searchAnalytics/query',
        autorizacao: `Bearer ${TOKEN}`,
        corpo: { startDate: '2026-10-01', endDate: '2026-10-07', dimensions: ['date'], type: 'web', rowLimit: 25_000 },
      },
    ]);
  });

  it('por busca: as que mais trouxeram cliques, até o máximo pedido, com o endereço codificado inteiro no caminho', async () => {
    expect(await conector().lerBuscas(credencial, CARDAPIO, JANELA, 5)).toEqual([
      { busca: 'mister burgers', cliques: 7, vezes: 40, posicao: 1.2 },
      { busca: 'hamburgueria perto de mim', cliques: 4, vezes: 300, posicao: 6.8 },
    ]);
    expect(pedidos.map((p) => [p.caminho, p.corpo])).toEqual([
      ['/webmasters/v3/sites/https%3A%2F%2Fcardapio.misterburgers.com.br%2F/searchAnalytics/query', { startDate: '2026-10-01', endDate: '2026-10-07', dimensions: ['query'], type: 'web', rowLimit: 5 }],
    ]);
    // Sem o máximo, 100.
    await conector().lerBuscas(credencial, CARDAPIO, JANELA);
    expect((pedidos.at(-1)!.corpo as { rowLimit: number }).rowLimit).toBe(100);
  });

  it('o que o conector recusa antes de pedir: o site fora do formato, a janela inválida ou longa demais e a quantidade fora do limite', async () => {
    const c = conector();
    for (const [rotulo, fn] of [
      ['site', () => c.lerDias(credencial, 'misterburgers.com.br', JANELA)],
      ['site com consulta', () => c.lerBuscas(credencial, 'https://cardapio.misterburgers.com.br/?x=1', JANELA)],
      ['mês 13', () => c.lerDias(credencial, DOMINIO, { inicio: '2026-13-01', fim: '2026-10-07' })],
      ['fim antes do início', () => c.lerDias(credencial, DOMINIO, { inicio: '2026-10-07', fim: '2026-10-01' })],
      ['491 dias', () => c.lerDias(credencial, DOMINIO, { inicio: '2025-06-01', fim: '2026-10-04' })],
      ['zero buscas', () => c.lerBuscas(credencial, DOMINIO, JANELA, 0)],
      ['buscas demais', () => c.lerBuscas(credencial, DOMINIO, JANELA, 25_001)],
      ['buscas fracionadas', () => c.lerBuscas(credencial, DOMINIO, JANELA, 1.5)],
    ] as const) {
      const e = await erroDe(fn);
      expect([rotulo, e.tipo, e.provider]).toEqual([rotulo, 'definitivo', 'search_console']);
    }
    // 490 dias passam.
    await c.lerDias(credencial, DOMINIO, { inicio: '2025-06-01', fim: '2026-10-03' });
    expect(pedidos).toHaveLength(1);
  });

  it('a cota: o 403 com motivo de cota e o 429 são limite, com quanto esperar, sem insistir; a recusa do site é permissão', async () => {
    const semDia = await erroDe(() => conector().lerDias(credencial, SEM_COTA_NO_DIA, JANELA));
    expect([semDia.tipo, semDia.status, semDia.esperarMs, semDia.codigoProvider]).toEqual(['limite', 403, 3_600_000, 'dailyLimitExceeded']);
    const semCarga = await erroDe(() => conector().lerBuscas(credencial, SEM_COTA_DE_CARGA, JANELA));
    expect([semCarga.tipo, semCarga.esperarMs, semCarga.codigoProvider]).toEqual(['limite', 15 * 60_000, 'quotaExceeded']);
    const cheio = await erroDe(() => conector().lerDias(credencial, CHEIO, JANELA));
    expect([cheio.tipo, cheio.status]).toEqual(['limite', 429]);
    const recusa = await erroDe(() => conector().lerDias(credencial, RECUSA, JANELA));
    expect([recusa.tipo, recusa.status]).toEqual(['permissao', 403]);
    // Uma chamada para cada: no limite e na recusa, o conector não tenta de novo.
    expect(pedidos).toHaveLength(4);
  });
});
