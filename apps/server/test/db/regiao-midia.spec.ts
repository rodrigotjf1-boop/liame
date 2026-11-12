import { randomInt, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { type Database, runMigrations } from '@liame/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_CONFIG, type AppConfig } from '../../src/config.js';
import { DATABASE } from '../../src/database/database.module.js';
import { FlagService } from '../../src/flags/flag.service.js';
import { VaultService } from '../../src/vault/vault.service.js';
import { RegiaoMidiaLoop } from '../../src/worker/regiao-midia.service.js';
import { ownerQuery, startApi, type TestApi } from '../helpers/api.js';
import { type ChamadaAoGoogle, type EmpresaComGoogle, empresaComGoogle, GoogleDeMentira } from '../helpers/google-de-mentira.js';
import { ligarFlagDaEmpresa } from '../helpers/meta-de-mentira.js';
import { hasDb, OWNER_URL } from './env.js';

// A mídia por região e por hora (plano da região, R4, parte 1): a rotina `regiao-midia` do worker contra uma Google
// Ads API local. Só com a função `regiao` ligada; as 4 semanas completas até ontem no fuso da conta, por hora e por
// cidade, com o nome dos lugares novos; a janela lida substitui a guardada; a cidade que falha não derruba a hora; a
// falta de permissão espera um dia; a conta desligada leva junto o que foi lido dela. O lugar é novo a cada rodada (a
// tabela dos nomes é do sistema e o banco de teste é dividido, ERR-215).

/** Quinta-feira, 12/11/2026, 12h em Brasília: a janela vai de 15/10 a 11/11. */
const AGORA = new Date('2026-11-12T15:00:00Z');

describe.skipIf(!hasDb)('a mídia por região e por hora, pela rotina do worker (R4, parte 1)', () => {
  const google = new GoogleDeMentira();
  const anterior: Record<string, string | undefined> = {};
  let api: TestApi;
  let database: Database;
  let rotina: RegiaoMidiaLoop;
  let e: EmpresaComGoogle;
  const LUGAR = String(randomInt(900_000_000, 999_999_999));
  let cidadesFalham = false;
  let semPermissao = false;

  const consulta = (c: ChamadaAoGoogle) => String(c.corpo.query ?? '');
  /** A Google Ads API das consultas da R4, pela conta desta empresa. */
  const responder = (c: ChamadaAoGoogle) => {
    if (c.recurso !== 'searchStream') return null;
    const q = consulta(c);
    if (semPermissao) return { status: 403, corpo: { error: { code: 403, status: 'PERMISSION_DENIED', message: 'The caller does not have permission' } } };
    if (q.includes('segments.hour,') && q.includes(' FROM customer WHERE ')) {
      return {
        status: 200,
        corpo: [
          {
            results: [
              { segments: { date: '2026-11-10', hour: 20 }, metrics: { impressions: '900', clicks: '30', costMicros: '15000000', conversions: 3 } },
              { segments: { date: '2026-11-11', hour: 12 }, metrics: { impressions: '100', clicks: '2', costMicros: '1000000' } },
              // Fora da janela (a plataforma devolveu a mais): não entra.
              { segments: { date: '2026-10-01', hour: 20 }, metrics: { impressions: '1', clicks: '1', costMicros: '1' } },
            ],
          },
        ],
      };
    }
    if (q.includes('FROM user_location_view')) {
      if (cidadesFalham) return { status: 400, corpo: { error: { code: 400, status: 'INVALID_ARGUMENT', message: 'Request contains an invalid argument.' } } };
      return { status: 200, corpo: [{ results: [{ segments: { date: '2026-11-10', geoTargetCity: `geoTargetConstants/${LUGAR}` }, metrics: { impressions: '700', clicks: '25', costMicros: '12000000', conversions: 2 } }] }] };
    }
    if (q.includes('FROM geo_target_constant')) {
      return { status: 200, corpo: [{ results: [{ geoTargetConstant: { id: LUGAR, name: 'Rio de Janeiro', canonicalName: 'Rio de Janeiro,State of Rio de Janeiro,Brazil', targetType: 'City', countryCode: 'BR' } }] }] };
    }
    return null;
  };
  const rodar = (quando = AGORA) => rotina.executarLote(5, { tenantIds: [e.tenantId] }, quando);
  const consultasFeitas = () => google.chamadas.filter((c) => c.cliente === e.cliente && c.recurso === 'searchStream').map(consulta);
  const horas = () =>
    ownerQuery<{ day: string; hour: number; impressions: string; clicks: string; spend: string; conversions: string | null }>(
      `select day::text as day, hour, impressions::text, clicks::text, spend::text, conversions::text from liame.ad_hour_daily where connected_account_id = $1 order by day, hour`,
      [e.conta],
    );
  const cidades = () =>
    ownerQuery<{ day: string; geo_target_id: string; clicks: string; spend: string }>(
      `select day::text as day, geo_target_id::text, clicks::text, spend::text from liame.ad_city_daily where connected_account_id = $1 order by day`,
      [e.conta],
    );
  const cursor = async () =>
    (await ownerQuery<{ cursor: Record<string, unknown>; last_error: string | null }>(`select cursor, last_error from liame.sync_state where connected_account_id = $1 and dataset = 'regiao_midia'`, [e.conta]))[0];

  beforeAll(async () => {
    await runMigrations({ connectionString: OWNER_URL, dir: resolve(process.cwd(), '../../packages/database/migrations') });
    await google.subir();
    const ambiente = google.ambiente();
    for (const k of Object.keys(ambiente)) anterior[k] = process.env[k];
    Object.assign(process.env, ambiente);
    api = await startApi();
    database = api.app.get(DATABASE);
    rotina = new RegiaoMidiaLoop(database, api.app.get<AppConfig>(APP_CONFIG), api.app.get(VaultService), api.app.get(FlagService));
    e = await empresaComGoogle(api, database, { nome: 'Hamburgueria da Região' });
    google.defeitos.set(e.cliente, responder);
  }, 120_000);
  afterAll(async () => {
    await api?.close();
    await google.fechar();
    for (const [k, v] of Object.entries(anterior)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('com a função `regiao` desligada, a conta espera um dia sem chamar o Google', async () => {
    expect(await rodar()).toEqual([{ conta: e.conta, status: 'desligada' }]);
    expect(consultasFeitas()).toEqual([]);
    expect((await cursor())!.cursor.proxima).toBe(new Date(AGORA.getTime() + 24 * 3_600_000).toISOString());
    // Na mesma volta, nada é devido.
    expect(await rodar()).toEqual([]);
  });

  it('com a função ligada: a hora e a cidade das 4 semanas até ontem, e o nome do lugar novo; o que veio fora da janela fica de fora', async () => {
    await ligarFlagDaEmpresa(api, 'regiao', e.tenantId, true);
    await ownerQuery(`update liame.sync_state set cursor = '{}'::jsonb where connected_account_id = $1 and dataset = 'regiao_midia'`, [e.conta]);
    expect(await rodar()).toEqual([{ conta: e.conta, status: 'ok', horas: 3, cidades: 1 }]);
    const feitas = consultasFeitas();
    expect(feitas[0]).toContain("BETWEEN '2026-10-15' AND '2026-11-11'");
    expect(feitas.some((q) => q.includes(`'geoTargetConstants/${LUGAR}'`))).toBe(true);
    expect(await horas()).toEqual([
      { day: '2026-11-10', hour: 20, impressions: '900', clicks: '30', spend: '15.000000', conversions: '3.000000' },
      { day: '2026-11-11', hour: 12, impressions: '100', clicks: '2', spend: '1.000000', conversions: '0.000000' },
    ]);
    expect(await cidades()).toEqual([{ day: '2026-11-10', geo_target_id: LUGAR, clicks: '25', spend: '12.000000' }]);
    expect(await ownerQuery(`select name, target_type, country_code from liame.region_geo_target where id = $1`, [LUGAR])).toEqual([{ name: 'Rio de Janeiro', target_type: 'City', country_code: 'BR' }]);
    expect(await cursor()).toMatchObject({ last_error: null, cursor: { proxima: new Date(AGORA.getTime() + 24 * 3_600_000).toISOString(), falhas_seguidas: 0 } });
  });

  it('o retrato de Sua região traz a mídia (R4, parte 2): os cliques por hora, o bloco mais forte e as cidades do Google, sem dinheiro', async () => {
    const loja = randomUUID();
    await ownerQuery(
      `insert into liame.unit (id, tenant_id, brand_id, name, address_postal_code, address_district, address_city, address_state, ibge_city_code, location_source, delivery_radius_km)
       values ($1, $2, $3, 'Loja da Região', '20520054', 'Tijuca', 'Rio de Janeiro', 'RJ', '3304557', 'cep', 3)`,
      [loja, e.tenantId, e.brandId],
    );
    // A rota usa o relógio de verdade: as linhas lidas para 12/11/2026 só entram se a janela de hoje as cobrir.
    const r = await api.call('GET', `/v1/region/overview?brand_id=${e.brandId}&unit_id=${loja}`, { cookie: e.cookie });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.paid_media_status).toBe('disponivel');
    const m = r.body.paid_media;
    expect(m.accounts).toEqual([{ provider: 'google_ads', name: 'Hamburgueria Ads', read_at: AGORA.toISOString() }]);
    expect(m.by_hour).toHaveLength(24);
    expect(m.cities_status).toBe('disponivel');
    expect(JSON.stringify(m)).not.toMatch(/spend|gasto|micros/);
    const janelaCobre = m.from <= '2026-11-10' && m.to >= '2026-11-11';
    if (janelaCobre) {
      expect(m).toMatchObject({ clicks: 32, impressions: 1000, ad_block: { from_hour: 20, to_hour: 21, clicks_pct: 94 }, orders_block: null });
      expect(m.cities).toEqual([{ id: LUGAR, name: 'Rio de Janeiro', full_name: 'Rio de Janeiro,State of Rio de Janeiro,Brazil', clicks: 25, impressions: 700, clicks_pct: 100 }]);
    } else {
      expect(m).toMatchObject({ clicks: 0, ad_block: null, cities: [] });
    }
  });

  it('o mesmo município com dois lugares "City" no Google (o antigo e o novo) aparece uma vez só, somado', async () => {
    // Visto em produção em 12/11/2026: "Duque de Caxias,State of Rio de Janeiro,Brazil" e "Duque de Caxias,Duque de
    // Caxias,State of Rio de Janeiro,Brazil" em duas linhas. Os lugares são novos a cada rodada (ERR-215).
    const nome = `Cidade Dupla ${randomInt(100_000, 999_999)}`;
    const antigo = String(randomInt(900_000_000, 999_999_999));
    const novo = String(randomInt(900_000_000, 999_999_999));
    await ownerQuery(
      `insert into liame.region_geo_target (id, name, canonical_name, target_type, country_code)
       values ($1, $3, $3 || ',State of Rio de Janeiro,Brazil', 'City', 'BR'), ($2, $3, $3 || ',' || $3 || ',State of Rio de Janeiro,Brazil', 'City', 'BR')`,
      [antigo, novo, nome],
    );
    await ownerQuery(
      `insert into liame.ad_city_daily (connected_account_id, tenant_id, brand_id, provider, day, geo_target_id, impressions, clicks, spend)
       values ($1, $2, $3, 'google_ads', (now() at time zone 'America/Sao_Paulo')::date - 2, $4, 40, 5, 1),
              ($1, $2, $3, 'google_ads', (now() at time zone 'America/Sao_Paulo')::date - 2, $5, 10, 1, 1)`,
      [e.conta, e.tenantId, e.brandId, novo, antigo],
    );
    const loja = randomUUID();
    await ownerQuery(
      `insert into liame.unit (id, tenant_id, brand_id, name, address_postal_code, address_district, address_city, address_state, ibge_city_code, location_source, delivery_radius_km)
       values ($1, $2, $3, 'Loja da Cidade Dupla', '20520054', 'Tijuca', 'Rio de Janeiro', 'RJ', '3304557', 'cep', 3)`,
      [loja, e.tenantId, e.brandId],
    );
    const r = await api.call('GET', `/v1/region/overview?brand_id=${e.brandId}&unit_id=${loja}`, { cookie: e.cookie });
    // As linhas desta prova saem antes das conferências: os testes seguintes contam as cidades lidas da conta.
    await ownerQuery(`delete from liame.ad_city_daily where connected_account_id = $1 and geo_target_id = any($2::bigint[])`, [e.conta, [antigo, novo]]);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const dela =(r.body.paid_media.cities as Array<{ id: string; name: string; full_name: string; clicks: number; impressions: number }>).filter((c) => c.name === nome);
    expect(dela).toEqual([{ id: [antigo, novo].sort((a, b) => Number(a) - Number(b))[0], name: nome, full_name: `${nome},State of Rio de Janeiro,Brazil`, clicks: 6, impressions: 50, clicks_pct: expect.any(Number) }]);
  });

  it('no dia seguinte: o lugar já conhecido não é traduzido de novo; a cidade que falha não derruba a hora e deixa a de antes', async () => {
    google.chamadas.length = 0;
    cidadesFalham = true;
    const amanha = new Date(AGORA.getTime() + 25 * 3_600_000);
    try {
      expect(await rodar(amanha)).toEqual([{ conta: e.conta, status: 'ok', horas: 3 }]);
    } finally {
      cidadesFalham = false;
    }
    expect(consultasFeitas().some((q) => q.includes('geo_target_constant'))).toBe(false);
    // A janela andou um dia (de 16/10 a 12/11) e substituiu a guardada; a cidade é a de antes.
    expect((await horas()).map((h) => [h.day, h.hour])).toEqual([
      ['2026-11-10', 20],
      ['2026-11-11', 12],
    ]);
    expect(await cidades()).toHaveLength(1);
    expect((await cursor())!.cursor).toMatchObject({ cidades: 'falhou', falhas_seguidas: 0 });
  });

  it('sem permissão, a conta espera um dia e o que já foi lido fica; a conta desligada leva junto o que foi lido dela', async () => {
    semPermissao = true;
    const depois = new Date(AGORA.getTime() + 50 * 3_600_000);
    try {
      expect(await rodar(depois)).toMatchObject([{ conta: e.conta, status: 'sem_permissao' }]);
    } finally {
      semPermissao = false;
    }
    const c = await cursor();
    expect(c!.cursor).toMatchObject({ falha: 'permissao', falhas_seguidas: 1, proxima: new Date(depois.getTime() + 24 * 3_600_000).toISOString() });
    expect(c!.last_error).toMatch(/^permissao: /);
    expect(await horas()).toHaveLength(2);

    await ownerQuery(`update liame.connected_account set disconnected_at = now() where id = $1`, [e.conta]);
    expect(await rodar(depois)).toEqual([]);
    expect(await horas()).toEqual([]);
    expect(await cidades()).toEqual([]);
  });
});
