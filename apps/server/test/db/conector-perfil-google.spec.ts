import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { createDatabase, type Database, runMigrations } from '@liame/database';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ClienteConector, ErroConector } from '../../src/connectors/cliente-http.js';
import { enderecosDasPlataformas } from '../../src/connectors/enderecos.js';
import { BALDE_DO_PERFIL_GOOGLE, ConectorPerfilGoogle, criarConectorPerfilGoogle } from '../../src/connectors/google-business/conector-perfil-google.js';
import { APP_URL, hasDb, OWNER_URL } from './env.js';

// A6 · Z1 (parte a): o conector de leitura do Perfil da Empresa no Google contra um Google local, com as quatro APIs
// em quatro caminhos (em produção, quatro endereços). Confere a descoberta das lojas, as avaliações (a ordem, as
// páginas, o corte por data, o teto), os números do perfil (os parâmetros exatos da consulta) e os dois critérios da
// entrega: nada de quem avaliou sai do conector (A6-1), e no limite de cota a leitura para e diz quanto esperar, sem
// insistir (A6-2).

const TOKEN = 'token-de-teste-perfil-google';
const CONTA = 'accounts/111000111';
const LOJA = 'locations/222000222';
const CHAVE_DO_BALDE_APERTADO = 'teste-do-balde-apertado';

type Pedido = { api: string; metodo: string; caminho: string; busca: URLSearchParams; autorizacao: string | undefined; corpo: unknown };

/** Uma avaliação como o Google a manda, com o nome e a foto de quem avaliou. */
const avaliacao = (n: number, atualizadaEm: string, extra: Record<string, unknown> = {}) => ({
  name: `${CONTA}/${LOJA}/reviews/rev-${n}`,
  reviewId: `rev-${n}`,
  reviewer: { displayName: `Pessoa Número ${n}`, profilePhotoUrl: `https://lh3.googleusercontent.com/a/foto-${n}`, isAnonymous: false },
  starRating: ['ONE', 'TWO', 'THREE', 'FOUR', 'FIVE'][n % 5],
  comment: `Comentário ${n}`,
  createTime: '2026-09-01T12:00:00Z',
  updateTime: atualizadaEm,
  ...extra,
});

describe.skipIf(!hasDb)('conector do Perfil da Empresa no Google (leitura; A6 · Z1)', () => {
  let database: Database;
  let google: Server;
  let base = '';
  const pedidos: Pedido[] = [];
  /** O que o Google local faz na próxima chamada de avaliações: responder com a cota esgotada. */
  let semCota: { retryAfter?: string } | null = null;

  const json = (status: number, corpo: unknown, cabecalhos: Record<string, string> = {}) => ({ status, corpo, cabecalhos });
  const naoAchou = () => json(404, { error: { code: 404, status: 'NOT_FOUND', message: 'not found' } });

  function responder(req: IncomingMessage, corpo: unknown) {
    const url = new URL(req.url ?? '/', base);
    const [, api, ...resto] = url.pathname.split('/');
    const caminho = `/${resto.join('/')}`;
    pedidos.push({ api: api ?? '', metodo: req.method ?? '', caminho, busca: url.searchParams, autorizacao: req.headers.authorization, corpo });
    const pagina = url.searchParams.get('pageToken');

    if (api === 'contas' && caminho === '/v1/accounts') {
      // Duas páginas de contas; um nome fora do formato é ignorado.
      if (!pagina) return json(200, { accounts: [{ name: CONTA, accountName: 'Mister Burgers' }, { name: 'contas/x' }], nextPageToken: 'contas-2' });
      return json(200, { accounts: [{ name: 'accounts/333000333' }, { name: 'accounts/444000444' }] });
    }
    if (api === 'lojas' && caminho === `/v1/${CONTA}/locations`) {
      if (!pagina) return json(200, { locations: [{ name: LOJA, title: 'Mister Burgers — Centro', websiteUri: 'https://misterburgers.exemplo.test', metadata: { placeId: 'ChIJ-centro', mapsUri: 'https://maps.google.com/?cid=1' } }], nextPageToken: 'lojas-2' });
      return json(200, { locations: [{ name: 'locations/555000555', title: 'Mister Burgers — Praia' }, { name: 'lojas/sem-formato', title: 'Fora do formato' }] });
    }
    // A segunda conta recusa a leitura das lojas; a terceira não tem loja nenhuma.
    if (api === 'lojas' && caminho === '/v1/accounts/333000333/locations') return json(403, { error: { code: 403, status: 'PERMISSION_DENIED', message: 'The caller does not have permission' } });
    if (api === 'lojas' && caminho === '/v1/accounts/444000444/locations') return json(200, {});

    if (api === 'avaliacoes' && caminho === `/v4/${CONTA}/${LOJA}/reviews`) {
      if (semCota) {
        const r = json(429, { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded for quota metric Requests and limit Requests per minute' } }, semCota.retryAfter ? { 'retry-after': semCota.retryAfter } : {});
        return r;
      }
      // Três páginas, da mais recente para a mais antiga: 8, 7 | 6, 5 (uma sem nota no meio) | 4.
      if (!pagina) return json(200, { reviews: [avaliacao(8, '2026-10-10T10:00:00Z'), avaliacao(7, '2026-10-09T10:00:00Z', { reviewReply: { comment: 'Obrigado!', updateTime: '2026-10-09T15:00:00Z', reviewReplyState: 'APPROVED' } })], averageRating: 4.6, totalReviewCount: 1284, nextPageToken: 'av-2' });
      if (pagina === 'av-2') return json(200, { reviews: [avaliacao(6, '2026-10-08T10:00:00Z'), { reviewId: 'sem-nota', reviewer: { displayName: 'Sem Nota' }, starRating: 'STAR_RATING_UNSPECIFIED', createTime: '2026-10-07T12:00:00Z' }, avaliacao(5, '2026-10-07T10:00:00Z')], averageRating: 4.6, totalReviewCount: 1284, nextPageToken: 'av-3' });
      if (pagina === 'av-3') return json(200, { reviews: [avaliacao(4, '2026-10-01T10:00:00Z')], averageRating: 4.6, totalReviewCount: 1284 });
      return naoAchou();
    }
    // Uma avaliação pelo nome, a resposta e o apagar da resposta, como a referência REST da v4 descreve (lida em
    // 11/10/2026): `reviews.get`; `reviews.updateReply` é PUT em `…/reply`, com `ReviewReply` no corpo e na volta ("A
    // reply is created if one does not exist"); `reviews.deleteReply` é DELETE, sem corpo, e devolve um objeto vazio.
    // O que o Google responde para a avaliação que não existe não está na referência: aqui é o 404 NOT_FOUND das APIs
    // dele. Se for outro erro, a leitura falha classificada, e nada é respondido.
    const umaAvaliacao = `/v4/${CONTA}/${LOJA}/reviews/`;
    if (api === 'avaliacoes' && caminho.startsWith(umaAvaliacao)) {
      const [id = '', sufixo, ...mais] = caminho.slice(umaAvaliacao.length).split('/');
      if (mais.length || (sufixo !== undefined && sufixo !== 'reply') || id === 'rev-sumiu') return naoAchou();
      if (sufixo === undefined && req.method === 'GET') {
        // O Google devolve outra avaliação no lugar da pedida: o conector não a aceita.
        if (id === 'rev-trocada') return json(200, avaliacao(99, '2026-10-10T10:00:00Z'));
        if (id === 'rev-7') return json(200, avaliacao(7, '2026-10-09T10:00:00Z', { reviewReply: { comment: 'Obrigado!', updateTime: '2026-10-09T15:00:00Z', reviewReplyState: 'APPROVED' } }));
        return json(200, avaliacao(Number(id.split('-')[1]), '2026-10-10T10:00:00Z'));
      }
      if (sufixo === 'reply' && req.method === 'PUT') {
        if (id === 'rev-recusa') return json(403, { error: { code: 403, status: 'PERMISSION_DENIED', message: 'The caller does not have permission' } });
        // A volta sem o texto (não é o que a referência diz, mas o conector não depende dela).
        if (id === 'rev-calada') return json(200, {});
        return json(200, { comment: (corpo as { comment?: unknown } | null)?.comment, updateTime: '2026-10-11T12:00:00Z', reviewReplyState: 'PENDING' });
      }
      // A avaliação 6 não tem resposta para apagar.
      if (sufixo === 'reply' && req.method === 'DELETE') return id === 'rev-6' ? naoAchou() : json(200, {});
      return naoAchou();
    }
    if (api === 'numeros' && caminho === `/v1/${LOJA}:fetchMultiDailyMetricsTimeSeries`) {
      return json(200, {
        multiDailyMetricTimeSeries: [
          {
            dailyMetricTimeSeries: [
              { dailyMetric: 'WEBSITE_CLICKS', timeSeries: { datedValues: [{ date: { year: 2026, month: 10, day: 1 }, value: '12' }, { date: { year: 2026, month: 10, day: 2 } }] } },
              { dailyMetric: 'BUSINESS_IMPRESSIONS_MOBILE_SEARCH', timeSeries: { datedValues: [{ date: { year: 2026, month: 10, day: 1 }, value: '340' }] } },
            ],
          },
        ],
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
    perfilGoogle: { contas: `${base}/contas`, lojas: `${base}/lojas`, avaliacoes: `${base}/avaliacoes`, numeros: `${base}/numeros` },
    metaAppSecret: null,
  });
  const cliente = (extra: Partial<ConstructorParameters<typeof ClienteConector>[1]> = {}) =>
    new ClienteConector(database.db, { enderecos: enderecosDasPlataformas(plataformas()), tentativas: 1, esperaMaximaMs: 2_000, balde: { capacidade: 500, porSegundo: 50 }, ...extra });
  /** `chaveDaCota`: só o teste que esvazia o balde usa uma chave dele (a do projeto é dividida com os outros arquivos de teste). */
  const conector = (c = cliente(), chaveDaCota?: string) => new ConectorPerfilGoogle(c, plataformas().perfilGoogle, { contas: 'v1', lojas: 'v1', avaliacoes: 'v4', numeros: 'v1' }, chaveDaCota);
  const credencial = { accessToken: TOKEN };
  const daApi = (api: string) => pedidos.filter((p) => p.api === api);
  /** O erro que a chamada devolve. */
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
        res.writeHead(r.status, { 'content-type': 'application/json', ...r.cabecalhos });
        res.end(JSON.stringify(r.corpo));
      });
    });
    await new Promise<void>((ok) => google.listen(0, '127.0.0.1', ok));
    base = `http://127.0.0.1:${(google.address() as AddressInfo).port}`;
  }, 120_000);
  beforeEach(() => {
    pedidos.length = 0;
    semCota = null;
  });
  afterAll(async () => {
    await new Promise((ok) => google?.close(ok));
    await database?.close();
  });

  it('as versões vêm do registro de capacidades: cada API do Perfil tem a dela', async () => {
    const c = await criarConectorPerfilGoogle(database.db, cliente(), plataformas());
    await c.lerAvaliacoes(credencial, { conta: CONTA, loja: LOJA }, { maximo: 1 });
    await c.lerNumeros(credencial, { loja: LOJA }, { inicio: '2026-10-01', fim: '2026-10-02' });
    expect(pedidos.map((p) => `${p.api}${p.caminho.split('/').slice(0, 2).join('/')}`)).toEqual(['avaliacoes/v4', 'numeros/v1']);
  });

  it('descoberta: as lojas de todas as contas e de todas as páginas; a conta que recusa fica de fora', async () => {
    expect(await conector().descobrirLojas(credencial)).toEqual([
      { conta: CONTA, loja: LOJA, nome: 'Mister Burgers — Centro', site: 'https://misterburgers.exemplo.test', placeId: 'ChIJ-centro', mapsUri: 'https://maps.google.com/?cid=1' },
      { conta: CONTA, loja: 'locations/555000555', nome: 'Mister Burgers — Praia', site: null, placeId: null, mapsUri: null },
    ]);
    expect(pedidos.every((p) => p.autorizacao === `Bearer ${TOKEN}`)).toBe(true);
    // As contas, de 20 em 20, nas duas páginas.
    expect(daApi('contas').map((p) => [p.caminho, p.busca.get('pageSize'), p.busca.get('pageToken')])).toEqual([
      ['/v1/accounts', '20', null],
      ['/v1/accounts', '20', 'contas-2'],
    ]);
    // As lojas de cada conta, com o `readMask` obrigatório e 100 por página.
    expect(daApi('lojas').map((p) => [p.caminho, p.busca.get('readMask'), p.busca.get('pageSize'), p.busca.get('pageToken')])).toEqual([
      [`/v1/${CONTA}/locations`, 'name,title,websiteUri,metadata', '100', null],
      [`/v1/${CONTA}/locations`, 'name,title,websiteUri,metadata', '100', 'lojas-2'],
      ['/v1/accounts/333000333/locations', 'name,title,websiteUri,metadata', '100', null],
      ['/v1/accounts/444000444/locations', 'name,title,websiteUri,metadata', '100', null],
    ]);
  });

  it('avaliações: da mais recente para a mais antiga, por todas as páginas, com a nota média e o total da loja', async () => {
    const lidas = await conector().lerAvaliacoes(credencial, { conta: CONTA, loja: LOJA });
    expect(lidas.avaliacoes.map((a) => [a.id, a.estrelas, a.atualizadaEm])).toEqual([
      ['rev-8', 4, '2026-10-10T10:00:00.000Z'],
      ['rev-7', 3, '2026-10-09T10:00:00.000Z'],
      ['rev-6', 2, '2026-10-08T10:00:00.000Z'],
      ['rev-5', 1, '2026-10-07T10:00:00.000Z'],
      ['rev-4', 5, '2026-10-01T10:00:00.000Z'],
    ]);
    expect(lidas).toMatchObject({ media: 4.6, total: 1284, completa: true });
    expect(lidas.avaliacoes[1]).toMatchObject({ texto: 'Comentário 7', resposta: { texto: 'Obrigado!', situacao: 'aprovada', atualizadaEm: '2026-10-09T15:00:00.000Z', violacao: null } });
    expect(daApi('avaliacoes').map((p) => [p.caminho, p.busca.get('pageSize'), p.busca.get('orderBy'), p.busca.get('pageToken')])).toEqual([
      [`/v4/${CONTA}/${LOJA}/reviews`, '50', 'updateTime desc', null],
      [`/v4/${CONTA}/${LOJA}/reviews`, '50', 'updateTime desc', 'av-2'],
      [`/v4/${CONTA}/${LOJA}/reviews`, '50', 'updateTime desc', 'av-3'],
    ]);
  });

  it('A6-1: o nome e a foto de quem avaliou não saem do conector', async () => {
    const lidas = await conector().lerAvaliacoes(credencial, { conta: CONTA, loja: LOJA });
    const tudo = JSON.stringify(lidas);
    // O Google local mandou o nome e a foto em toda avaliação.
    for (const proibido of ['Pessoa Número', 'Sem Nota', 'foto-', 'googleusercontent', 'reviewer', 'displayName', 'profilePhotoUrl']) expect(tudo, proibido).not.toContain(proibido);
    for (const a of lidas.avaliacoes) expect(Object.keys(a).sort()).toEqual(['atualizadaEm', 'criadaEm', 'estrelas', 'id', 'resposta', 'texto']);
  });

  it('a leitura do dia a dia para no corte, sem pedir as páginas antigas; o teto avisa que não leu tudo', async () => {
    const desde = await conector().lerAvaliacoes(credencial, { conta: CONTA, loja: LOJA }, { desde: new Date('2026-10-08T00:00:00Z') });
    expect(desde.avaliacoes.map((a) => a.id)).toEqual(['rev-8', 'rev-7', 'rev-6']);
    expect(desde.completa).toBe(true);
    // Parou na segunda página: a terceira não foi pedida.
    expect(daApi('avaliacoes').map((p) => p.busca.get('pageToken'))).toEqual([null, 'av-2']);

    pedidos.length = 0;
    const comTeto = await conector().lerAvaliacoes(credencial, { conta: CONTA, loja: LOJA }, { maximo: 3 });
    expect(comTeto.avaliacoes.map((a) => a.id)).toEqual(['rev-8', 'rev-7', 'rev-6']);
    expect(comTeto).toMatchObject({ completa: false, media: 4.6, total: 1284 });
    expect(daApi('avaliacoes')).toHaveLength(2);
  });

  it('os números do perfil: as nove métricas e a janela nos parâmetros que a API pede; o dia sem valor é zero', async () => {
    const pontos = await conector().lerNumeros(credencial, { loja: LOJA }, { inicio: '2026-10-01', fim: '2026-10-07' });
    expect(pontos).toEqual([
      { dia: '2026-10-01', metrica: 'profile_views_search_mobile', valor: 340 },
      { dia: '2026-10-01', metrica: 'website_clicks', valor: 12 },
      { dia: '2026-10-02', metrica: 'website_clicks', valor: 0 },
    ]);
    const [p] = daApi('numeros');
    expect(p!.caminho).toBe(`/v1/${LOJA}:fetchMultiDailyMetricsTimeSeries`);
    expect(p!.busca.getAll('dailyMetrics')).toEqual([
      'BUSINESS_IMPRESSIONS_DESKTOP_MAPS',
      'BUSINESS_IMPRESSIONS_DESKTOP_SEARCH',
      'BUSINESS_IMPRESSIONS_MOBILE_MAPS',
      'BUSINESS_IMPRESSIONS_MOBILE_SEARCH',
      'BUSINESS_DIRECTION_REQUESTS',
      'CALL_CLICKS',
      'WEBSITE_CLICKS',
      'BUSINESS_BOOKINGS',
      'BUSINESS_FOOD_MENU_CLICKS',
    ]);
    expect(Object.fromEntries([...p!.busca.entries()].filter(([k]) => k.startsWith('dailyRange.')))).toEqual({
      'dailyRange.start_date.year': '2026',
      'dailyRange.start_date.month': '10',
      'dailyRange.start_date.day': '1',
      'dailyRange.end_date.year': '2026',
      'dailyRange.end_date.month': '10',
      'dailyRange.end_date.day': '7',
    });
  });

  it('a conta, a loja e as datas fora do formato não viram chamada', async () => {
    const c = conector();
    for (const alvo of [{ conta: 'accounts/1/../2', loja: LOJA }, { conta: CONTA, loja: 'locations/abc' }, { conta: 'contas/111', loja: LOJA }, { conta: CONTA, loja: `${LOJA}?x=1` }]) {
      expect((await erroDe(() => c.lerAvaliacoes(credencial, alvo))).tipo, JSON.stringify(alvo)).toBe('definitivo');
    }
    expect((await erroDe(() => c.lerNumeros(credencial, { loja: LOJA }, { inicio: '2026-10-07', fim: '2026-10-01' }))).tipo).toBe('definitivo');
    expect((await erroDe(() => c.lerNumeros(credencial, { loja: LOJA }, { inicio: '2026-13-01', fim: '2026-13-02' }))).tipo).toBe('definitivo');
    expect((await erroDe(() => c.lerNumeros(credencial, { loja: 'locations/../x' }, { inicio: '2026-10-01', fim: '2026-10-02' }))).tipo).toBe('definitivo');
    expect(pedidos).toEqual([]);
  });

  it('A6-2: com a cota do Google esgotada, a leitura para, diz quanto esperar e não insiste', async () => {
    // Um cliente que tentaria três vezes: mesmo assim sai uma chamada só.
    const insistente = conector(cliente({ tentativas: 3 }));
    semCota = {};
    const semPrazo = await erroDe(() => insistente.lerAvaliacoes(credencial, { conta: CONTA, loja: LOJA }));
    expect([semPrazo.tipo, semPrazo.status, semPrazo.esperarMs]).toEqual(['limite', 429, 60_000]);
    expect(daApi('avaliacoes')).toHaveLength(1);
    // Quando o Google diz quanto esperar, é esse o prazo que sobe para o job.
    pedidos.length = 0;
    semCota = { retryAfter: '120' };
    const comPrazo = await erroDe(() => insistente.lerAvaliacoes(credencial, { conta: CONTA, loja: LOJA }));
    expect([comPrazo.tipo, comPrazo.esperarMs]).toEqual(['limite', 120_000]);
    expect(daApi('avaliacoes')).toHaveLength(1);
  });

  it('A6-2: a cota é uma só para todas as lojas, e o balde do conector fica abaixo das 300 chamadas por minuto do Google', async () => {
    expect(BALDE_DO_PERFIL_GOOGLE.porSegundo * 60).toBeLessThan(300);
    expect(BALDE_DO_PERFIL_GOOGLE.capacidade).toBeLessThanOrEqual(BALDE_DO_PERFIL_GOOGLE.porSegundo * 60);
    // Um balde de duas fichas que quase não enche: a terceira chamada, de outra loja, já não sai (a chave é uma só para
    // todas as lojas). A chave é deste teste: esvaziar a do projeto deixaria sem ficha quem roda ao mesmo tempo (V76).
    const apertado = conector(cliente({ balde: { capacidade: 2, porSegundo: 0.001 }, esperaMaximaMs: 200 }), CHAVE_DO_BALDE_APERTADO);
    await ownerLimpa();
    await apertado.lerNumeros(credencial, { loja: LOJA }, { inicio: '2026-10-01', fim: '2026-10-02' });
    await apertado.lerAvaliacoes(credencial, { conta: CONTA, loja: LOJA }, { maximo: 1 });
    const erro = await erroDe(() => apertado.lerNumeros(credencial, { loja: 'locations/555000555' }, { inicio: '2026-10-01', fim: '2026-10-02' }));
    expect(erro.tipo).toBe('limite');
    expect(erro.esperarMs).toBeGreaterThan(200);
    // Só as duas primeiras chegaram ao Google.
    expect(pedidos).toHaveLength(2);
    await ownerLimpa();
  });

  // ---------------------------------------------------------------- Z2: a resposta a uma avaliação

  it('Z2: uma avaliação lida agora, sem nada de quem avaliou; a que não existe mais volta nula; e a que o Google troca não serve', async () => {
    const c = conector();
    const lida = await c.lerAvaliacao(credencial, { conta: CONTA, loja: LOJA, avaliacao: 'rev-7' });
    expect(lida).toEqual({
      id: 'rev-7',
      estrelas: 3,
      texto: 'Comentário 7',
      criadaEm: '2026-09-01T12:00:00.000Z',
      atualizadaEm: '2026-10-09T10:00:00.000Z',
      resposta: { texto: 'Obrigado!', atualizadaEm: '2026-10-09T15:00:00.000Z', situacao: 'aprovada', violacao: null },
    });
    // O Google local mandou o nome e a foto (A6-1).
    for (const proibido of ['Pessoa Número', 'foto-', 'reviewer']) expect(JSON.stringify(lida), proibido).not.toContain(proibido);
    expect(daApi('avaliacoes').map((p) => [p.metodo, p.caminho, p.autorizacao])).toEqual([['GET', `/v4/${CONTA}/${LOJA}/reviews/rev-7`, `Bearer ${TOKEN}`]]);

    expect(await c.lerAvaliacao(credencial, { conta: CONTA, loja: LOJA, avaliacao: 'rev-sumiu' })).toBeNull();
    expect((await erroDe(() => c.lerAvaliacao(credencial, { conta: CONTA, loja: LOJA, avaliacao: 'rev-trocada' }))).tipo).toBe('definitivo');
  });

  it('Z2: a resposta sai por PUT, com o texto inteiro, e volta como o Google a gravou (ele ainda confere)', async () => {
    const c = conector();
    const alvo = { conta: CONTA, loja: LOJA, avaliacao: 'rev-8' };
    expect(await c.responderAvaliacao(credencial, alvo, '  Obrigado pela visita! Volte sempre.  ')).toEqual({
      texto: 'Obrigado pela visita! Volte sempre.',
      atualizadaEm: '2026-10-11T12:00:00.000Z',
      situacao: 'pendente',
      violacao: null,
    });
    expect(daApi('avaliacoes').map((p) => [p.metodo, p.caminho, p.corpo, p.autorizacao])).toEqual([
      ['PUT', `/v4/${CONTA}/${LOJA}/reviews/rev-8/reply`, { comment: 'Obrigado pela visita! Volte sempre.' }, `Bearer ${TOKEN}`],
    ]);
    // O Google não devolveu o texto: vale o que foi enviado, com a situação que ele ainda não disse.
    expect(await c.responderAvaliacao(credencial, { ...alvo, avaliacao: 'rev-calada' }, 'Obrigado!')).toEqual({ texto: 'Obrigado!', atualizadaEm: null, situacao: 'desconhecida', violacao: null });
    // A avaliação que sumiu e a recusa do Google sobem classificadas: quem chama decide.
    const sumiu = await erroDe(() => c.responderAvaliacao(credencial, { ...alvo, avaliacao: 'rev-sumiu' }, 'Obrigado!'));
    expect([sumiu.tipo, sumiu.status]).toEqual(['definitivo', 404]);
    expect((await erroDe(() => c.responderAvaliacao(credencial, { ...alvo, avaliacao: 'rev-recusa' }, 'Obrigado!'))).tipo).toBe('permissao');
  });

  it('Z2: o texto vazio ou grande demais, e o id que não serve para endereço, não viram chamada; o texto no limite sai inteiro', async () => {
    const c = conector();
    const alvo = { conta: CONTA, loja: LOJA, avaliacao: 'rev-8' };
    // 1.501 caracteres passam do limite do Liame; 1.100 emojis são 4.400 bytes, acima dos 4.096 do Google.
    for (const texto of ['', '   ', String.fromCharCode(0), 'x'.repeat(1501), '😀'.repeat(1100)]) {
      expect((await erroDe(() => c.responderAvaliacao(credencial, alvo, texto))).tipo, `texto de ${texto.length}`).toBe('definitivo');
    }
    for (const avaliacao of ['', 'rev/8', '..', 'rev 8', 'rev?x=1', 'rev.8', 'rév-8', 'a'.repeat(201)]) {
      const ruim = { ...alvo, avaliacao };
      expect((await erroDe(() => c.responderAvaliacao(credencial, ruim, 'Obrigado!'))).tipo, avaliacao).toBe('definitivo');
      expect((await erroDe(() => c.lerAvaliacao(credencial, ruim))).tipo, avaliacao).toBe('definitivo');
      expect((await erroDe(() => c.apagarResposta(credencial, ruim))).tipo, avaliacao).toBe('definitivo');
    }
    expect((await erroDe(() => c.responderAvaliacao(credencial, { ...alvo, loja: 'locations/../x' }, 'Obrigado!'))).tipo).toBe('definitivo');
    expect(pedidos).toEqual([]);

    const noLimite = 'x'.repeat(1500);
    expect((await c.responderAvaliacao(credencial, alvo, noLimite)).texto).toBe(noLimite);
    expect((pedidos[0]!.corpo as { comment: string }).comment).toHaveLength(1500);
  });

  it('Z2: apagar a resposta é um DELETE sem corpo; a que já não existe conta como apagada', async () => {
    const c = conector();
    await c.apagarResposta(credencial, { conta: CONTA, loja: LOJA, avaliacao: 'rev-7' });
    await c.apagarResposta(credencial, { conta: CONTA, loja: LOJA, avaliacao: 'rev-6' });
    expect(daApi('avaliacoes').map((p) => [p.metodo, p.caminho, p.corpo, p.autorizacao])).toEqual([
      ['DELETE', `/v4/${CONTA}/${LOJA}/reviews/rev-7/reply`, null, `Bearer ${TOKEN}`],
      ['DELETE', `/v4/${CONTA}/${LOJA}/reviews/rev-6/reply`, null, `Bearer ${TOKEN}`],
    ]);
  });

  it('Z2: o registro tem a leitura de uma avaliação e a única escrita, e a flag de escrita nasce desligada, sem regra', async () => {
    const { ownerQuery } = await import('../helpers/api.js');
    const capacidades = await ownerQuery<{ capability: string; api_version: string; read: boolean; write: boolean; required_scope: string[] }>(
      `select capability, api_version, read, write, required_scope from liame.connector_capability where provider = 'google_business' order by capability`,
    );
    expect(capacidades.map((c) => [c.capability, c.api_version, c.read, c.write])).toEqual([
      ['accounts', 'v1', true, false],
      ['locations', 'v1', true, false],
      ['performance_daily', 'v1', true, false],
      ['review_reply', 'v4', false, true],
      ['review_state', 'v4', true, false],
      ['reviews', 'v4', true, false],
    ]);
    expect(capacidades.every((c) => c.required_scope.length === 1 && c.required_scope[0] === 'https://www.googleapis.com/auth/business.manage')).toBe(true);
    const flag = await ownerQuery<{ default_value: unknown; is_write: boolean; owner: string; regras: number }>(
      `select f.default_value, f.is_write, f.owner, (select count(*)::int from liame.feature_flag_rule r where r.flag_key = f.key and r.created_by <> 'testes') as regras
         from liame.feature_flag f where f.key = 'perfil_google_write'`,
    );
    expect(flag).toEqual([{ default_value: false, is_write: true, owner: 'social', regras: 0 }]);
  });

  /** Zera o balde do teste do balde apertado (outra rodada pode tê-lo deixado vazio). */
  async function ownerLimpa(): Promise<void> {
    const { ownerQuery } = await import('../helpers/api.js');
    const { chaveDe } = await import('../../src/connectors/cota.js');
    await ownerQuery(`delete from liame.quota_bucket where bucket_key = $1`, [chaveDe('google_business', CHAVE_DO_BALDE_APERTADO)]);
  }
});
