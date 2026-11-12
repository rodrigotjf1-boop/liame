import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { createDatabase, type Database, runMigrations } from '@liame/database';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ARMAZEM_DE_IMAGENS, type ArmazemNaMemoria } from '../../src/imagens/armazem.js';
import { chaveDaMiniatura, copiarMiniaturas } from '../../src/media/miniaturas.js';
import { hojeNoFuso } from '../../src/media/sincronizador.js';
import { enableMfa, ownerQuery, resetIpRateLimits, signupAndLogin, startApi, type TestApi } from '../helpers/api.js';
import { APP_URL, hasDb, OWNER_URL } from './env.js';

// A miniatura do anúncio (A3 · I14, parte 1; P44; D-A3-29, D-A3-30 e D-A3-32): depois da sincronização, o Liame copia
// para o armazenamento a miniatura do criativo que mais gastou em cada campanha, só quando ainda não copiou ou quando a
// imagem mudou; e Resultados devolve, em cada campanha, o anúncio que mais gastou no período com a cópia (o anúncio
// fora do ar, sem imagem).

const FUSO = 'America/Sao_Paulo';
const DIA_MS = 86_400_000;
const HOJE = hojeNoFuso(new Date(), FUSO);
const menos = (n: number) => new Date(new Date(`${HOJE}T00:00:00Z`).getTime() - n * DIA_MS).toISOString().slice(0, 10);

describe.skipIf(!hasDb)('a miniatura do anúncio (P44)', () => {
  let api: TestApi;
  let database: Database;
  let armazem: ArmazemNaMemoria;
  let cookie = '';
  let tenantId = '';
  let brandId = '';
  const ids = { conta: randomUUID(), camp: randomUUID(), grupo: randomUUID(), adForte: randomUUID(), adFraco: randomUUID(), crForte: randomUUID(), crFraco: randomUUID() };
  const baixadas: string[] = [];
  let png: Buffer;
  const buscar = (async (url: URL | string) => {
    baixadas.push(String(url));
    return new Response(new Uint8Array(png), { status: 200, headers: { 'content-type': 'image/png' } });
  }) as typeof fetch;

  async function gasto(nivel: 'ad' | 'campaign', externo: string, entidade: string, dia: string, valor: number) {
    await ownerQuery(
      `insert into liame.metric_latest (connected_account_id, level, external_entity_id, metric_date, metric_name, attribution_window, tenant_id, brand_id, provider, entity_id, metric_value, currency, timezone, observed_at, changed_at)
       values ($1, $2, $3, $4, 'spend', '', $5, $6, 'meta_ads', $7, $8, 'BRL', $9, now(), now())
       on conflict (connected_account_id, level, external_entity_id, metric_date, metric_name, attribution_window) do update set metric_value = excluded.metric_value`,
      [ids.conta, nivel, externo, dia, tenantId, brandId, entidade, valor, FUSO],
    );
  }

  beforeAll(async () => {
    await runMigrations({ connectionString: OWNER_URL, dir: resolve(process.cwd(), '../../packages/database/migrations') });
    api = await startApi();
    database = createDatabase({ connectionString: APP_URL, max: 2, applicationName: 'liame-test' });
    armazem = api.app.get(ARMAZEM_DE_IMAGENS) as ArmazemNaMemoria;
    png = await sharp({ create: { width: 600, height: 600, channels: 3, background: { r: 230, g: 160, b: 60 } } }).png().toBuffer();
    await resetIpRateLimits();
    const s = await signupAndLogin(api, undefined, 'Mister Burgers Miniaturas');
    await enableMfa(api, s.cookie);
    cookie = s.cookie;
    tenantId = s.me.active_organization_id as string;
    brandId = (await ownerQuery<{ id: string }>(`select id from liame.brand where tenant_id = $1 limit 1`, [tenantId]))[0]!.id;
    await ownerQuery(
      `insert into liame.connected_account (id, tenant_id, brand_id, provider, external_id, name, currency, timezone) values ($1, $2, $3, 'meta_ads', 'act_7700000123', 'CA - Mister', 'BRL', $4)`,
      [ids.conta, tenantId, brandId, FUSO],
    );
    await ownerQuery(`insert into liame.campaign (id, tenant_id, connected_account_id, provider, external_id, name, status) values ($1, $2, $3, 'meta_ads', '120330000000000777', 'TRÁFEGO | CARDAPIO | 04-2026', 'ativa')`, [
      ids.camp,
      tenantId,
      ids.conta,
    ]);
    await ownerQuery(`insert into liame.ad_group (id, tenant_id, connected_account_id, campaign_id, provider, external_id, name, status) values ($1, $2, $3, $4, 'meta_ads', '120330000000000778', 'Conjunto', 'ativa')`, [
      ids.grupo,
      tenantId,
      ids.conta,
      ids.camp,
    ]);
    await ownerQuery(
      `insert into liame.creative (id, tenant_id, connected_account_id, provider, external_id, name, kind, thumbnail_url) values
         ($1, $3, $4, 'meta_ads', '120330000000000901', 'Combo foto', 'PHOTO', 'https://scontent.xx.fbcdn.net/v/t45/combo.jpg?stp=dst&oh=AAA&oe=111'),
         ($2, $3, $4, 'meta_ads', '120330000000000902', 'Combo vídeo', 'VIDEO', 'https://scontent.xx.fbcdn.net/v/t15/video.jpg?oh=BBB&oe=222')`,
      [ids.crForte, ids.crFraco, tenantId, ids.conta],
    );
    await ownerQuery(
      `insert into liame.ad (id, tenant_id, connected_account_id, ad_group_id, creative_id, provider, external_id, name, status, provider_status) values
         ($1, $3, $5, $6, $7, 'meta_ads', '120330000000001001', 'Anúncio do combo', 'ativa', 'ACTIVE'),
         ($2, $3, $5, $6, $4, 'meta_ads', '120330000000001002', 'Anúncio do vídeo', 'ativa', 'ACTIVE')`,
      [ids.adForte, ids.adFraco, tenantId, ids.crFraco, ids.conta, ids.grupo, ids.crForte],
    );
    // O anúncio do combo gastou mais nos 7 dias; o do vídeo, menos.
    for (const d of [1, 2, 3]) {
      await gasto('ad', '120330000000001001', ids.adForte, menos(d), 30_000_000);
      await gasto('ad', '120330000000001002', ids.adFraco, menos(d), 5_000_000);
      await gasto('campaign', '120330000000000777', ids.camp, menos(d), 35_000_000);
    }
  }, 120_000);
  afterAll(async () => {
    await api?.close();
    await database?.close();
  });

  const coluna = async (id: string) =>
    (await ownerQuery<{ thumbnail_key: string | null; thumbnail_source: string | null; thumbnail_width: number | null }>(`select thumbnail_key, thumbnail_source, thumbnail_width from liame.creative where id = $1`, [id]))[0]!;

  it('copia o criativo que mais gastou, só uma vez; copia de novo quando a imagem muda; recusa o endereço fora da Meta', async () => {
    const r = await copiarMiniaturas({ db: database.db, armazem, contaId: ids.conta, tenantId, buscar });
    expect(r).toEqual({ copiadas: 1, falhas: 0 });
    expect(baixadas).toEqual(['https://scontent.xx.fbcdn.net/v/t45/combo.jpg?stp=dst&oh=AAA&oe=111']);
    const chave = chaveDaMiniatura(tenantId, brandId, ids.crForte);
    expect(await coluna(ids.crForte)).toEqual({ thumbnail_key: chave, thumbnail_source: 'https://scontent.xx.fbcdn.net/v/t45/combo.jpg', thumbnail_width: 480 });
    const meta = await sharp(armazem.objetos.get(chave)!).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(['jpeg', 480, 480]);
    // O vídeo não é o que mais gastou em campanha nenhuma: não foi copiado.
    expect((await coluna(ids.crFraco)).thumbnail_key).toBeNull();

    // A assinatura mudou, a imagem não: nada a baixar.
    await ownerQuery(`update liame.creative set thumbnail_url = 'https://scontent.xx.fbcdn.net/v/t45/combo.jpg?stp=dst&oh=CCC&oe=333' where id = $1`, [ids.crForte]);
    expect(await copiarMiniaturas({ db: database.db, armazem, contaId: ids.conta, tenantId, buscar })).toEqual({ copiadas: 0, falhas: 0 });
    // A imagem mudou: copia de novo.
    await ownerQuery(`update liame.creative set thumbnail_url = 'https://scontent.xx.fbcdn.net/v/t45/combo-nova.jpg?oh=DDD' where id = $1`, [ids.crForte]);
    expect(await copiarMiniaturas({ db: database.db, armazem, contaId: ids.conta, tenantId, buscar })).toEqual({ copiadas: 1, falhas: 0 });
    expect((await coluna(ids.crForte)).thumbnail_source).toBe('https://scontent.xx.fbcdn.net/v/t45/combo-nova.jpg');
    // Fora da Meta: não baixa.
    const antes = baixadas.length;
    await ownerQuery(`update liame.creative set thumbnail_url = 'https://exemplo.com/combo.jpg' where id = $1`, [ids.crForte]);
    expect(await copiarMiniaturas({ db: database.db, armazem, contaId: ids.conta, tenantId, buscar })).toEqual({ copiadas: 0, falhas: 0 });
    expect(baixadas.length).toBe(antes);
  }, 60_000);

  it('Resultados: a campanha traz o anúncio que mais gastou, com a cópia; fora do ar, sem imagem', async () => {
    const q = `brand_id=${brandId}&from=${menos(7)}&to=${menos(1)}`;
    const r = await api.call('GET', `/v1/results/closed-loop?${q}`, { cookie });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const camp = (r.body.campaigns as { campaign_id: string; top_ad: Record<string, unknown> }[]).find((c) => c.campaign_id === ids.camp)!;
    expect(camp.top_ad).toMatchObject({
      name: 'Anúncio do combo',
      kind: 'imagem',
      off_air: false,
      image: { url: expect.any(String), width: 480, height: 480 },
      manager_url: 'https://adsmanager.facebook.com/adsmanager/manage/ads?act=7700000123&selected_ad_ids=120330000000001001',
    });

    await ownerQuery(`update liame.ad set provider_status = 'DISAPPROVED' where id = $1`, [ids.adForte]);
    const fora = await api.call('GET', `/v1/results/closed-loop?${q}`, { cookie });
    const c2 = (fora.body.campaigns as { campaign_id: string; top_ad: Record<string, unknown> }[]).find((c) => c.campaign_id === ids.camp)!;
    expect(c2.top_ad).toMatchObject({ name: 'Anúncio do combo', off_air: true, image: null });
  }, 60_000);
});
