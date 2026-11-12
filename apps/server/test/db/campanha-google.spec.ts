import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { createDatabase, type Database, runMigrations } from '@liame/database';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BudgetService } from '../../src/actions/budget.service.js';
import { CONNECTORS } from '../../src/actions/connectors.js';
import { currentStep, totpCode } from '../../src/auth/totp.js';
import { DATABASE } from '../../src/database/database.module.js';
import { FlagService } from '../../src/flags/flag.service.js';
import { ARMAZEM_DE_IMAGENS, type ArmazemNaMemoria } from '../../src/imagens/armazem.js';
import { KillSwitchService } from '../../src/kill-switch/kill-switch.service.js';
import { ActionExecutor } from '../../src/worker/action-executor.js';
import { ownerQuery, resetIpRateLimits, startApi, type TestApi } from '../helpers/api.js';
import { type EmpresaComGoogle, empresaComGoogle } from '../helpers/google-de-mentira.js';
import { ligarFlagDaEmpresa } from '../helpers/meta-de-mentira.js';
import { fotoGuardada, lojaComCardapio } from '../helpers/posts-semeados.js';
import { APP_URL, hasDb, OWNER_URL } from './env.js';

// A5 · Y9, parte 2: o pedido da campanha nova no Google (P45; D-A5-21 a D-A5-26; migration 0150), contra Postgres. O que
// se prova:
//   - pedir: só com a função; a peça aprovada, os textos nos tamanhos do Google (no campo de cada um), o nome da loja, a
//     foto (não o vídeo, grande o bastante para os recortes), a logo de Minha marca, a loja no endereço e o cardápio; o
//     pedido `campanha_google_criar` espera o código do app, com o estado que a pessoa aprova; um pedido em aberto por
//     peça, e o recusado libera a peça;
//   - as opções da gaveta: o que impede (a função, a conta, a logo), o nome sugerido e a campanha de cada peça;
//   - aprovado, a criação no Google ainda não existe (a parte 3): o pedido falha com o motivo, sem ir ao Google.

const CARDAPIO = 'https://cardapio.exemplo.com.br/mister-centro';
const TEXTOS = {
  headlines: ['Combo sexta: R$ 34,90', 'Smash, batata e refri', 'Peça no cardápio online'],
  long_headlines: ['Sexta é dia de combo: smash, batata e refri por R$ 34,90 na Loja Centro'],
  descriptions: ['Peça o combo de sexta pelo cardápio online e receba em casa.', 'Smash, batata e refrigerante por R$ 34,90. Entrega no Centro ou retirada no balcão.'],
};

describe.skipIf(!hasDb)('a campanha nova no Google: o pedido (A5 · Y9, parte 2)', () => {
  let api: TestApi;
  let database: Database;
  let armazem: ArmazemNaMemoria;
  let executor: ActionExecutor;

  beforeAll(async () => {
    await runMigrations({ connectionString: OWNER_URL, dir: resolve(process.cwd(), '../../packages/database/migrations') });
    api = await startApi();
    database = createDatabase({ connectionString: APP_URL, max: 2, applicationName: 'liame-test' });
    armazem = api.app.get(ARMAZEM_DE_IMAGENS) as ArmazemNaMemoria;
    const db: Database = api.app.get(DATABASE);
    executor = new ActionExecutor(db, api.app.get(BudgetService), api.app.get(KillSwitchService), api.app.get(FlagService));
  }, 120_000);
  beforeEach(resetIpRateLimits);
  afterAll(async () => {
    await api?.close();
    await database?.close();
  });

  type Cenario = EmpresaComGoogle & { unitId: string; peca: string; foto: string };

  /** A empresa com a conta do Google Ads, a logo em Minha marca, a loja no endereço com o cardápio, uma foto e uma peça aprovada. */
  async function cenario(nome: string, o: { ligada?: boolean } = {}): Promise<Cenario> {
    const e = await empresaComGoogle(api, database, { nome });
    await ownerQuery(`update liame.brand set logo_id = $2, logo_width = 512, logo_height = 512, logo_updated_at = now() where id = $1`, [e.brandId, randomUUID()]);
    const { unitId } = await lojaComCardapio(e, 'Loja Centro', CARDAPIO);
    await ownerQuery(
      `update liame.unit set address_postal_code = '20040002', address_street = 'Rua da Assembleia', address_number = '10', address_district = 'Centro',
              address_city = 'Rio de Janeiro', address_state = 'RJ', ibge_city_code = '3304557', location_source = 'cep',
              latitude = -22.906847, longitude = -43.172897, location_precision = 'endereco'
        where id = $1`,
      [unitId],
    );
    const pedidoDePeca = randomUUID();
    const peca = randomUUID();
    await ownerQuery(
      `insert into liame.ad_piece_request (id, tenant_id, brand_id, offer, dossier_version, destination, variations, status) values ($1, $2, $3, 'Combo sexta', 1, 'cardapio', 1, 'concluido')`,
      [pedidoDePeca, e.tenantId, e.brandId],
    );
    await ownerQuery(
      `insert into liame.ad_piece (id, tenant_id, brand_id, request_id, status, version, review_status, decided_by, decided_at) values ($1, $2, $3, $4, 'aprovada', 1, 'passou', $5, now())`,
      [peca, e.tenantId, e.brandId, pedidoDePeca, e.userId],
    );
    await ownerQuery(
      `insert into liame.ad_piece_version (id, tenant_id, piece_id, version, title, body, button, review, review_status, rules_version, content_hash, author)
       values ($1, $2, $3, 1, 'Sexta é dia de combo', 'Peça o combo pelo cardápio.', 'pedir_agora', '{}'::jsonb, 'passou', '{}'::jsonb, $4, 'criativo')`,
      [randomUUID(), e.tenantId, peca, randomBytes(32).toString('hex')],
    );
    const foto = await fotoGuardada(e, armazem, { largura: 1440, altura: 1800 });
    await ligarFlagDaEmpresa(api, 'google_write', e.tenantId, true);
    if (o.ligada ?? true) await ligarFlagDaEmpresa(api, 'campanha_google', e.tenantId, true);
    return { ...e, unitId, peca, foto: foto.id };
  }

  const pedir = (e: Cenario, extra: Record<string, unknown> = {}) =>
    api.call('POST', '/v1/google-campaigns', {
      cookie: e.cookie,
      body: { brand_id: e.brandId, piece_id: e.peca, media_id: e.foto, unit_id: e.unitId, name: 'Combo sexta · Google · novembro', business_name: 'Mister Burgers', radius_km: 5, daily_budget_micros: 30_000_000, ...TEXTOS, ...extra },
    });
  const pedidoDe = async (id: string) =>
    (await ownerQuery<{ status: string; status_reason: string | null; plan_hash: string; tool: string; provider: string; before_state: Record<string, unknown> }>(
      `select status, status_reason, plan_hash, tool, provider, before_state from liame.action_request where id = $1`,
      [id],
    ))[0]!;
  const codigo = async (r: { status: number; body: Record<string, unknown> }) => [r.status, r.body.code];

  it('pedir: só com a função; as recusas no campo de cada uma; o pedido espera o código, com o estado aprovado; um em aberto por peça', async () => {
    const e = await cenario('Brasa Google Pede', { ligada: false });
    expect(await codigo(await pedir(e))).toEqual([409, 'funcao-desligada']);
    await ligarFlagDaEmpresa(api, 'campanha_google', e.tenantId, true);

    // Os textos: a recusa vem com as palavras da tela, no campo deles.
    const poucos = await pedir(e, { headlines: TEXTOS.headlines.slice(0, 2) });
    expect([poucos.status, poucos.body.code, poucos.body.detail]).toEqual([422, 'textos-do-google', 'O Google pede pelo menos 3 títulos.']);
    expect(poucos.body.errors).toEqual([{ path: 'headlines', message: 'O Google pede pelo menos 3 títulos.' }]);
    const longo = await pedir(e, { descriptions: [TEXTOS.descriptions[0], 'x'.repeat(91)] });
    expect([longo.body.code, (longo.body.errors as { path: string }[])[0]!.path]).toEqual(['textos-do-google', 'descriptions']);
    expect(await codigo(await pedir(e, { business_name: 'Mister Burgers Hamburgueria Artesanal' }))).toEqual([422, 'nome-da-loja-longo']);

    // A foto: a de outra marca não existe; a pequena é recusada com as medidas.
    expect(await codigo(await pedir(e, { media_id: randomUUID() }))).toEqual([422, 'midia-fora-das-fotos']);
    const pequena = await fotoGuardada(e, armazem, { largura: 520, altura: 520 });
    const p = await pedir(e, { media_id: pequena.id });
    expect([p.status, p.body.code, p.body.detail]).toEqual([422, 'foto-pequena', 'A foto é pequena para o recorte deitado: o Google pede pelo menos 600 × 314, e o maior recorte desta foto dá 520 × 272. Use outra foto.']);

    // A logo de Minha marca; a loja no endereço.
    await ownerQuery(`update liame.brand set logo_id = null, logo_width = null, logo_height = null, logo_updated_at = null where id = $1`, [e.brandId]);
    expect(await codigo(await pedir(e))).toEqual([409, 'sem-logo']);
    await ownerQuery(`update liame.brand set logo_id = $2, logo_width = 512, logo_height = 512, logo_updated_at = now() where id = $1`, [e.brandId, randomUUID()]);
    await ownerQuery(`update liame.unit set location_precision = 'bairro' where id = $1`, [e.unitId]);
    expect(await codigo(await pedir(e))).toEqual([422, 'loja-sem-endereco']);
    await ownerQuery(`update liame.unit set location_precision = 'endereco' where id = $1`, [e.unitId]);
    expect(await codigo(await pedir(e, { daily_budget_micros: 30_005_000 }))).toEqual([422, 'verba-invalida']);
    expect(await codigo(await pedir(e, { end_date: '2020-01-01' }))).toEqual([422, 'fim-no-passado']);

    const r = await pedir(e);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({ status: 'pedida', piece_version: 1, link: CARDAPIO, business_name: 'Mister Burgers', radius_km: 5, daily_budget_micros: 30_000_000, ...TEXTOS, google: { account_id: e.cliente, campaign_id: null } });
    const pedido = await pedidoDe(r.body.action_id as string);
    expect(pedido).toMatchObject({ status: 'aguardando_aprovacao', tool: 'campanha_google_criar', provider: 'google_ads' });
    expect(pedido.before_state).toMatchObject({
      nome: 'Combo sexta · Google · novembro',
      textos: { titulos: TEXTOS.headlines, titulos_longos: TEXTOS.long_headlines, descricoes: TEXTOS.descriptions },
      foto: { id: e.foto, largura: 1440, altura: 1800 },
      loja_no_google: { nome: 'Mister Burgers', logo_lado: 512 },
      conta: { id: e.cliente },
      loja: { nome: 'Loja Centro', latitude: -22.906847, longitude: -43.172897 },
      raio_km: 5,
      link: CARDAPIO,
      situacao: 'pedida',
    });
    expect(await codigo(await pedir(e))).toEqual([409, 'ja-pedida']);
    // Recusado em Aprovações, a peça fica livre para outro pedido, e a campanha nova diz cancelada.
    await ownerQuery(`update liame.action_request set status = 'cancelada' where id = $1`, [r.body.action_id]);
    expect((await api.call('GET', `/v1/google-campaigns/${r.body.id}`, { cookie: e.cookie })).body.status).toBe('cancelada');
    expect((await pedir(e)).status).toBe(201);
    // A de outra empresa: 404.
    const outra = await cenario('Brasa Google Outra');
    expect((await api.call('GET', `/v1/google-campaigns/${r.body.id}`, { cookie: outra.cookie })).status).toBe(404);
  }, 180_000);

  it('as opções da gaveta: o que impede (a função, a conta, a logo), o nome sugerido, a logo e a campanha de cada peça', async () => {
    const e = await cenario('Brasa Google Opcoes');
    const opcoes = (emp: Cenario) => api.call('GET', `/v1/google-campaigns/options?brand_id=${emp.brandId}`, { cookie: emp.cookie });
    const r = await opcoes(e);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ enabled: true, blocks: [], ad_account: { name: 'Hamburgueria Ads', currency: 'BRL' }, logo: { width: 512, height: 512 }, campaign_cap_micros: null, by_piece: [] });
    // O nome da marca, cortado em 25 caracteres.
    expect([...r.body.business_name].length).toBeLessThanOrEqual(25);
    expect(r.body.units).toEqual([{ id: e.unitId, name: 'Loja Centro', address: 'Rua da Assembleia, 10, Centro', has_address: true, delivery_radius_km: null, menu_available: true, menu_block: null }]);
    const p = await pedir(e);
    expect((await opcoes(e)).body.by_piece).toEqual([{ piece_id: e.peca, campaign_id: p.body.id, status: 'pedida', active: false, action_id: p.body.action_id }]);

    // Desligada, sem a conta e sem a logo: o que impede, na ordem e com as palavras da recusa do pedido.
    const sem = await cenario('Brasa Google Sem Nada', { ligada: false });
    await ownerQuery(`update liame.connected_account set disconnected_at = now() where tenant_id = $1 and provider = 'google_ads'`, [sem.tenantId]);
    await ownerQuery(`update liame.brand set logo_id = null, logo_width = null, logo_height = null, logo_updated_at = null where id = $1`, [sem.brandId]);
    const s = (await opcoes(sem)).body;
    expect(s.blocks.map((b: { code: string }) => b.code)).toEqual(['funcao-desligada', 'sem-conta-do-google', 'sem-logo']);
    expect([s.ad_account, s.logo]).toEqual([null, null]);
    expect((await api.call('GET', `/v1/google-campaigns/options?brand_id=${e.brandId}`, { cookie: sem.cookie })).status).toBe(404);
  }, 180_000);

  it('aprovado, a criação no Google é a parte 3: o pedido falha com o motivo, sem ir ao Google, e a campanha nova fica cancelada', async () => {
    const e = await cenario('Brasa Google Aprova');
    expect(CONNECTORS.google_ads?.writeFlag).toBe('google_write');
    const r = await pedir(e);
    const pedido = r.body.action_id as string;
    await ownerQuery(`update liame.app_user set totp_last_step = null where id = $1`, [e.userId]);
    const a = await api.call('POST', `/v1/actions/${pedido}/approve`, { cookie: e.cookie, body: { plan_hash: (await pedidoDe(pedido)).plan_hash, code: totpCode(e.secret, currentStep()) } });
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    await executor.executeBatch(20, { tenantIds: [e.tenantId] });
    const p = await pedidoDe(pedido);
    expect(p.status).toBe('falhou');
    expect(p.status_reason).toContain('A criação de campanha no Google ainda não está disponível no Liame');
    const lida = await api.call('GET', `/v1/google-campaigns/${r.body.id}`, { cookie: e.cookie });
    expect(lida.body).toMatchObject({ status: 'cancelada', google: { campaign_id: null, budget_id: null, asset_group_id: null } });
  }, 120_000);
});
