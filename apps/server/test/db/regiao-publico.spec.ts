import { createHmac, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { type Database, runMigrations } from '@liame/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_CONFIG, type AppConfig } from '../../src/config.js';
import { DATABASE } from '../../src/database/database.module.js';
import { FlagService } from '../../src/flags/flag.service.js';
import { VaultService } from '../../src/vault/vault.service.js';
import { RegiaoPublicoLoop } from '../../src/worker/regiao-publico.service.js';
import { ownerQuery, resetIpRateLimits, startApi, type TestApi } from '../helpers/api.js';
import { ligarFlagDaEmpresa } from '../helpers/meta-de-mentira.js';
import { type EmpresaComCanais, empresaComCanais } from '../helpers/posts-semeados.js';
import { hasDb, OWNER_URL } from './env.js';

// O público nas redes (plano da região, R4, parte 3; migration 0151; D-RG-40 a D-RG-43): a rotina `regiao-publico` do
// worker contra uma Graph API local, com o formato da referência do Instagram e da Página lida em 12/11/2026. O que se
// prova aqui:
//   - só com a função `regiao` ligada; o Instagram pelo token da autorização (o nó, quem seguiu e saiu, os toques e a
//     cidade dos seguidores) e a Página pelo token dela (de quem pode analisar), com a janela das 4 semanas até ontem no
//     fuso da loja; o token só no cabeçalho, com a prova do segredo do app no endereço;
//   - o retrato de Sua região traz o bloco para quem vê a região;
//   - no dia seguinte, a cidade não é relida (uma vez por semana) e a série ganha o dia;
//   - com menos de 100 seguidores, o Instagram nem é perguntado sobre quem seguiu e a cidade;
//   - sem permissão, a conta espera um dia e o que já foi lido fica; a conta desligada leva junto o que foi lido dela.

/** Quinta-feira, 12/11/2026, 12h em Brasília: a janela vai de 15/10 a 11/11. */
const AGORA = new Date('2026-11-12T15:00:00Z');
const HORA_MS = 3_600_000;
const TOKEN = `token-da-regiao-${randomUUID()}`;
const TOKEN_DA_PAGINA = `token-da-pagina-${randomUUID()}`;
const SEGREDO = `segredo-do-app-${randomUUID()}`;

type Chamada = { caminho: string; params: Record<string, string>; autorizacao: string | null };

const totalValue = (name: string, chave: string, valores: Record<string, number>) => ({
  data: [{ name, period: 'day', total_value: { value: 0, breakdowns: [{ dimension_keys: [chave], results: Object.entries(valores).map(([k, v]) => ({ dimension_values: [k], value: v })) }] } }],
});

describe.skipIf(!hasDb)('o público nas redes, pela rotina do worker (R4, parte 3)', () => {
  let api: TestApi;
  let rotina: RegiaoPublicoLoop;
  let servidor: Server;
  let e: EmpresaComCanais;
  const chamadas: Chamada[] = [];
  let seguidoresDoIg = 4812;
  let semPermissao = false;

  /** A Graph API das leituras da R4, parte 3, para a Página e o Instagram desta empresa. */
  const responder = (c: Chamada): { status: number; corpo: unknown } => {
    if (semPermissao) return { status: 403, corpo: { error: { code: 10, type: 'OAuthException', message: '(#10) Application does not have permission for this action' } } };
    const ig = e.instagram!.externo;
    const pagina = e.pagina!.externo;
    const versao = 'v26.0';
    if (c.caminho === `/${versao}/${ig}` && c.autorizacao === `Bearer ${TOKEN}`) return { status: 200, corpo: { followers_count: seguidoresDoIg, id: ig } };
    if (c.caminho === `/${versao}/${ig}/insights` && c.autorizacao === `Bearer ${TOKEN}`) {
      if (c.params.metric === 'follows_and_unfollows') return { status: 200, corpo: totalValue('follows_and_unfollows', 'follow_type', { FOLLOWER: 287, NON_FOLLOWER: 73 }) };
      if (c.params.metric === 'profile_links_taps') return { status: 200, corpo: totalValue('profile_links_taps', 'contact_button_type', { DIRECTION: 98, CALL: 31, TEXT: 17 }) };
      if (c.params.metric === 'follower_demographics')
        return { status: 200, corpo: totalValue('follower_demographics', 'city', { 'Rio de Janeiro, Rio de Janeiro': 3417, 'Niterói, Rio de Janeiro': 192, 'Duque de Caxias, Rio de Janeiro': 289 }) };
    }
    if (c.caminho === `/${versao}/me/accounts` && c.autorizacao === `Bearer ${TOKEN}`) return { status: 200, corpo: { data: [{ id: pagina, access_token: TOKEN_DA_PAGINA, tasks: ['ANALYZE', 'CREATE_CONTENT'] }] } };
    if (c.caminho === `/${versao}/${pagina}` && c.autorizacao === `Bearer ${TOKEN_DA_PAGINA}`) return { status: 200, corpo: { followers_count: 2356, id: pagina } };
    if (c.caminho === `/${versao}/${pagina}/insights` && c.autorizacao === `Bearer ${TOKEN_DA_PAGINA}`) {
      return {
        status: 200,
        corpo: {
          data: [
            { name: 'page_daily_follows_unique', period: 'day', values: [{ value: 20 }, { value: 5 }] },
            { name: 'page_daily_unfollows_unique', period: 'day', values: [{ value: 7 }] },
            { name: 'page_views_total', period: 'day', values: [{ value: 600 }, { value: 604 }] },
          ],
        },
      };
    }
    return { status: 400, corpo: { error: { code: 100, type: 'GraphMethodException', message: `pedido fora do teste: ${c.caminho}` } } };
  };

  const rodar = (quando = AGORA) => rotina.executarLote(5, { tenantIds: [e.tenantId] }, quando).then((r) => [...r].sort((a, b) => a.conta.localeCompare(b.conta)));
  const esperado = (ig: object, pagina: object) => [{ conta: e.instagram!.id, ...ig }, { conta: e.pagina!.id, ...pagina }].sort((a, b) => a.conta.localeCompare(b.conta));
  const publico = (conta: string) =>
    ownerQuery<{ day_from: string; day_to: string; followers: string | null; follows: string | null; unfollows: string | null; taps: unknown; page_views: string | null; cities: unknown; cities_read_at: Date | null }>(
      `select day_from::text, day_to::text, followers::text, follows::text, unfollows::text, taps, page_views::text, cities, cities_read_at from liame.social_audience where connected_account_id = $1`,
      [conta],
    ).then((r) => r[0]);
  const serie = (conta: string) => ownerQuery<{ day: string; followers: string }>(`select day::text, followers::text from liame.social_follower_daily where connected_account_id = $1 order by day`, [conta]);
  const cursor = async (conta: string) =>
    (await ownerQuery<{ cursor: Record<string, unknown>; last_error: string | null }>(`select cursor, last_error from liame.sync_state where connected_account_id = $1 and dataset = 'regiao_publico'`, [conta]))[0];

  beforeAll(async () => {
    await runMigrations({ connectionString: OWNER_URL, dir: resolve(process.cwd(), '../../packages/database/migrations') });
    servidor = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const c: Chamada = { caminho: url.pathname, params: Object.fromEntries(url.searchParams), autorizacao: typeof req.headers.authorization === 'string' ? req.headers.authorization : null };
      chamadas.push(c);
      const r = responder(c);
      res.writeHead(r.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(r.corpo));
    });
    await new Promise<void>((ok) => servidor.listen(0, '127.0.0.1', ok));
    const base = `http://127.0.0.1:${(servidor.address() as AddressInfo).port}`;
    api = await startApi();
    await resetIpRateLimits();
    const config: AppConfig = api.app.get(APP_CONFIG);
    const database: Database = api.app.get(DATABASE);
    rotina = new RegiaoPublicoLoop(database, { ...config, plataformas: { ...config.plataformas, metaGraphUrl: base, metaAppSecret: SEGREDO } }, api.app.get(VaultService), api.app.get(FlagService));
    e = await empresaComCanais(api, 'Casa Brasa Do Público', { token: TOKEN, ligada: false });
  }, 120_000);
  afterAll(async () => {
    await api?.close();
    await new Promise<void>((ok) => servidor?.close(() => ok()));
  });

  it('com a função `regiao` desligada, as duas contas esperam um dia sem chamar a Meta', async () => {
    expect(await rodar()).toEqual(esperado({ status: 'desligada' }, { status: 'desligada' }));
    expect(chamadas).toEqual([]);
    expect((await cursor(e.instagram!.id))!.cursor.proxima).toBe(new Date(AGORA.getTime() + 24 * HORA_MS).toISOString());
    expect(await rodar()).toEqual([]);
  });

  it('com a função ligada: o Instagram e a Página das 4 semanas até ontem, a cidade dos seguidores e a série do dia', async () => {
    await ligarFlagDaEmpresa(api, 'regiao', e.tenantId, true);
    await ownerQuery(`update liame.sync_state set cursor = '{}'::jsonb where connected_account_id = any($1::uuid[]) and dataset = 'regiao_publico'`, [[e.instagram!.id, e.pagina!.id]]);
    expect(await rodar()).toEqual(esperado({ status: 'ok', seguidores: 4812, cidades: 3 }, { status: 'ok', seguidores: 2356 }));

    // A janela de 15/10 a 11/11 em Brasília, em segundos; o token só no cabeçalho, com a prova do segredo do app.
    const since = String(Date.parse('2026-10-15T03:00:00Z') / 1000);
    const until = String(Date.parse('2026-11-12T03:00:00Z') / 1000);
    const doIg = chamadas.filter((c) => c.caminho.endsWith(`/${e.instagram!.externo}/insights`));
    expect(doIg.map((c) => [c.params.metric, c.params.breakdown, c.params.since, c.params.until, c.params.timeframe])).toEqual([
      ['follows_and_unfollows', 'follow_type', since, until, undefined],
      ['profile_links_taps', 'contact_button_type', since, until, undefined],
      ['follower_demographics', 'city', undefined, undefined, 'this_month'],
    ]);
    const daPagina = chamadas.find((c) => c.caminho.endsWith(`/${e.pagina!.externo}/insights`))!;
    expect(daPagina.params).toMatchObject({ metric: 'page_daily_follows_unique,page_daily_unfollows_unique,page_views_total', period: 'day', since, until });
    for (const c of chamadas) {
      expect(JSON.stringify(c.params)).not.toContain(TOKEN);
      const token = c.autorizacao!.slice('Bearer '.length);
      expect(c.params.appsecret_proof).toBe(createHmac('sha256', SEGREDO).update(token).digest('hex'));
    }

    expect(await publico(e.instagram!.id)).toMatchObject({
      day_from: '2026-10-15',
      day_to: '2026-11-11',
      followers: '4812',
      follows: '287',
      unfollows: '73',
      taps: { como_chegar: 98, ligar: 31, mensagem: 17, outros: 0 },
      page_views: null,
      cities: [
        { cidade: 'Rio de Janeiro, Rio de Janeiro', seguidores: 3417 },
        { cidade: 'Duque de Caxias, Rio de Janeiro', seguidores: 289 },
        { cidade: 'Niterói, Rio de Janeiro', seguidores: 192 },
      ],
    });
    expect(await publico(e.pagina!.id)).toMatchObject({ followers: '2356', follows: '25', unfollows: '7', page_views: '1204', taps: null, cities: null });
    expect(await serie(e.instagram!.id)).toEqual([{ day: '2026-11-12', followers: '4812' }]);
    expect(await cursor(e.pagina!.id)).toMatchObject({ last_error: null, cursor: { proxima: new Date(AGORA.getTime() + 24 * HORA_MS).toISOString(), falhas_seguidas: 0 } });
  });

  it('o retrato de Sua região traz o público nas redes para quem vê a região', async () => {
    const loja = randomUUID();
    await ownerQuery(
      `insert into liame.unit (id, tenant_id, brand_id, name, address_postal_code, address_district, address_city, address_state, ibge_city_code, location_source, delivery_radius_km)
       values ($1, $2, $3, 'Loja do Público', '20520054', 'Tijuca', 'Rio de Janeiro', 'RJ', '3304557', 'cep', 3)`,
      [loja, e.tenantId, e.brandId],
    );
    const r = await api.call('GET', `/v1/region/overview?brand_id=${e.brandId}&unit_id=${loja}`, { cookie: e.cookie });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.social_audience_status).toBe('disponivel');
    expect(r.body.social_audience).toMatchObject({
      from: '2026-10-15',
      to: '2026-11-11',
      instagram: { name: '@casabrasa', followers: 4812, followers_change: 214, taps: { total: 146, directions: 98, call: 31, message: 17, other: 0 }, cities_status: 'disponivel' },
      page: { name: 'Casa Brasa', followers: 2356, followers_change: 18, views: 1204 },
    });
    expect(r.body.social_audience.instagram.cities[0]).toEqual({ name: 'Rio de Janeiro', full_name: 'Rio de Janeiro, Rio de Janeiro', followers: 3417, followers_pct: 71, store_city: true });
  });

  it('no dia seguinte: a cidade não é relida (uma vez por semana) e fica; a série ganha o dia', async () => {
    chamadas.length = 0;
    const amanha = new Date(AGORA.getTime() + 25 * HORA_MS);
    expect(await rodar(amanha)).toEqual(esperado({ status: 'ok', seguidores: 4812 }, { status: 'ok', seguidores: 2356 }));
    expect(chamadas.some((c) => c.params.metric === 'follower_demographics')).toBe(false);
    expect(((await publico(e.instagram!.id))!.cities as unknown[]).length).toBe(3);
    expect(await serie(e.instagram!.id)).toEqual([
      { day: '2026-11-12', followers: '4812' },
      { day: '2026-11-13', followers: '4812' },
    ]);
  });

  it('com menos de 100 seguidores, o Instagram nem é perguntado sobre quem seguiu e a cidade', async () => {
    chamadas.length = 0;
    seguidoresDoIg = 86;
    const depois = new Date(AGORA.getTime() + 50 * HORA_MS);
    try {
      expect(await rodar(depois)).toEqual(esperado({ status: 'ok', seguidores: 86, cidades: 0 }, { status: 'ok', seguidores: 2356 }));
    } finally {
      seguidoresDoIg = 4812;
    }
    expect(chamadas.filter((c) => c.caminho.endsWith('/insights') && c.caminho.includes(e.instagram!.externo)).map((c) => c.params.metric)).toEqual(['profile_links_taps']);
    expect(await publico(e.instagram!.id)).toMatchObject({ followers: '86', follows: null, unfollows: null, cities: null });
  });

  it('sem permissão, a conta espera um dia e o que já foi lido fica; a conta desligada leva junto o que foi lido dela', async () => {
    semPermissao = true;
    const depois = new Date(AGORA.getTime() + 75 * HORA_MS);
    try {
      expect(await rodar(depois)).toMatchObject(esperado({ status: 'sem_permissao' }, { status: 'sem_permissao' }));
    } finally {
      semPermissao = false;
    }
    const c = await cursor(e.instagram!.id);
    expect(c!.cursor).toMatchObject({ falha: 'permissao', falhas_seguidas: 1, proxima: new Date(depois.getTime() + 24 * HORA_MS).toISOString() });
    expect(c!.last_error).toMatch(/^permissao: /);
    expect((await publico(e.instagram!.id))!.followers).toBe('86');

    await ownerQuery(`update liame.connected_account set disconnected_at = now() where id = any($1::uuid[])`, [[e.instagram!.id, e.pagina!.id]]);
    expect(await rodar(depois)).toEqual([]);
    expect(await publico(e.instagram!.id)).toBeUndefined();
    expect(await serie(e.instagram!.id)).toEqual([]);
  });
});
