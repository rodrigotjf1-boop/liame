import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { createDatabase, type Database, runMigrations } from '@liame/database';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BudgetService } from '../../src/actions/budget.service.js';
import { CONNECTORS } from '../../src/actions/connectors.js';
import { currentStep, totpCode } from '../../src/auth/totp.js';
import { DATABASE } from '../../src/database/database.module.js';
import { FlagService } from '../../src/flags/flag.service.js';
import { ARMAZEM_DE_IMAGENS, type ArmazemNaMemoria } from '../../src/imagens/armazem.js';
import { KillSwitchService } from '../../src/kill-switch/kill-switch.service.js';
import { chaveDaLogoDaMarca } from '../../src/marca/logo-da-marca.service.js';
import { ActionExecutor } from '../../src/worker/action-executor.js';
import { ownerQuery, resetIpRateLimits, startApi, type TestApi } from '../helpers/api.js';
import { ACESSO_DO_GOOGLE, type EmpresaComGoogle, empresaComGoogle, GoogleDeMentira } from '../helpers/google-de-mentira.js';
import { ligarFlagDaEmpresa } from '../helpers/meta-de-mentira.js';
import { fotoGuardada, lojaComCardapio } from '../helpers/posts-semeados.js';
import { APP_URL, hasDb, OWNER_URL } from './env.js';

// A5 · Y9, partes 2 e 3: o pedido da campanha nova no Google e a criação dela, uma Performance Max pausada (P45; D-A5-21
// a D-A5-28; migration 0150), contra Postgres e o Google de mentira. O que se prova:
//   - pedir: só com a função; a peça aprovada, os textos nos tamanhos do Google (no campo de cada um), o nome da loja, a
//     foto (não o vídeo, grande o bastante para os recortes), a logo de Minha marca, a loja no endereço e o cardápio; o
//     pedido `campanha_google_criar` espera o código do app, com o estado que a pessoa aprova; um pedido em aberto por
//     peça, e o recusado libera a peça;
//   - as opções da gaveta: o que impede (a função, a conta, a logo), o nome sugerido e a campanha de cada peça;
//   - aprovado: a conferência do Google (`validateOnly`) e a criação, numa requisição só cada uma; a campanha pausada com
//     o nome único, as regras da marca, a automação desligada, o raio em volta da loja e o português; os textos; os
//     recortes da foto e a logo quadrada, medidos; o link; os ids na linha;
//   - a recusa do Google na conferência: nada é criado, e o motivo do Google fica no pedido e na campanha nova;
//   - a resposta da criação que se perde: a ação espera, e a tentativa seguinte acha a campanha pelo nome, sem criar de
//     novo;
//   - a foto que saiu do armazenamento: não criada, sem ir ao Google.

const CARDAPIO = 'https://cardapio.exemplo.com.br/mister-centro';
const TEXTOS = {
  headlines: ['Combo sexta: R$ 34,90', 'Smash, batata e refri', 'Peça no cardápio online'],
  long_headlines: ['Sexta é dia de combo: smash, batata e refri por R$ 34,90 na Loja Centro'],
  descriptions: ['Peça o combo de sexta pelo cardápio online e receba em casa.', 'Smash, batata e refrigerante por R$ 34,90. Entrega no Centro ou retirada no balcão.'],
};

describe.skipIf(!hasDb)('a campanha nova no Google: o pedido e a criação (A5 · Y9, partes 2 e 3)', () => {
  let api: TestApi;
  let database: Database;
  let armazem: ArmazemNaMemoria;
  let executor: ActionExecutor;
  const google = new GoogleDeMentira();
  const anterior: Record<string, string | undefined> = {};

  beforeAll(async () => {
    await runMigrations({ connectionString: OWNER_URL, dir: resolve(process.cwd(), '../../packages/database/migrations') });
    await google.subir();
    const ambiente = google.ambiente();
    for (const k of Object.keys(ambiente)) anterior[k] = process.env[k];
    Object.assign(process.env, ambiente);
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
    await google.fechar();
    for (const [k, v] of Object.entries(anterior)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  type Cenario = EmpresaComGoogle & { unitId: string; peca: string; foto: string; fotoChave: string };

  /** A logo de Minha marca, de verdade no armazenamento (JPEG com fundo branco, como a tela grava), nas medidas dadas. */
  async function logoDaMarca(e: Pick<EmpresaComGoogle, 'tenantId' | 'brandId'>, largura: number, altura: number): Promise<void> {
    const logoId = randomUUID();
    const bytes = await sharp({ create: { width: largura, height: altura, channels: 3, background: { r: 200, g: 40, b: 40 } } }).jpeg({ quality: 90 }).toBuffer();
    await armazem.gravar(chaveDaLogoDaMarca(e.tenantId, e.brandId, logoId), bytes);
    await ownerQuery(`update liame.brand set logo_id = $2, logo_width = $3, logo_height = $4, logo_updated_at = now() where id = $1`, [e.brandId, logoId, largura, altura]);
  }

  /** A empresa com a conta do Google Ads, a logo em Minha marca, a loja no endereço com o cardápio, uma foto e uma peça aprovada. */
  async function cenario(nome: string, o: { ligada?: boolean } = {}): Promise<Cenario> {
    const e = await empresaComGoogle(api, database, { nome });
    await logoDaMarca(e, 512, 512);
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
    return { ...e, unitId, peca, foto: foto.id, fotoChave: foto.chave };
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
    // O pedido recusado em Aprovações (ERR-230): a peça sai da lista na hora e volta a poder pedir. A situação guardada
    // segue `pedida` até o pedido seguinte; lida crua, a peça ficava em "Espera a aprovação", sem o botão.
    await ownerQuery(`update liame.action_request set status = 'cancelada' where id = $1`, [p.body.action_id]);
    expect((await ownerQuery<{ status: string }>(`select status from liame.google_campaign_new where id = $1`, [p.body.id]))[0]!.status).toBe('pedida');
    expect((await opcoes(e)).body.by_piece).toEqual([]);
    // O que parou no meio da criação aparece como não criada (dá para pedir de novo, e o motivo fica em Aprovações).
    await ownerQuery(`update liame.google_campaign_new set status = 'criando' where id = $1`, [p.body.id]);
    expect((await opcoes(e)).body.by_piece).toEqual([{ piece_id: e.peca, campaign_id: p.body.id, status: 'nao_criada', active: false, action_id: p.body.action_id }]);

    // Desligada, sem a conta e sem a logo: o que impede, na ordem e com as palavras da recusa do pedido.
    const sem = await cenario('Brasa Google Sem Nada', { ligada: false });
    await ownerQuery(`update liame.connected_account set disconnected_at = now() where tenant_id = $1 and provider = 'google_ads'`, [sem.tenantId]);
    await ownerQuery(`update liame.brand set logo_id = null, logo_width = null, logo_height = null, logo_updated_at = null where id = $1`, [sem.brandId]);
    const s = (await opcoes(sem)).body;
    expect(s.blocks.map((b: { code: string }) => b.code)).toEqual(['funcao-desligada', 'sem-conta-do-google', 'sem-logo']);
    expect([s.ad_account, s.logo]).toEqual([null, null]);
    expect((await api.call('GET', `/v1/google-campaigns/options?brand_id=${e.brandId}`, { cookie: sem.cookie })).status).toBe(404);
  }, 180_000);

  /** Pede, aprova com o código do app e roda o executor uma vez. Devolve a campanha nova e o pedido. */
  async function pedirEAprovar(e: Cenario, extra: Record<string, unknown> = {}): Promise<{ id: string; pedido: string }> {
    const r = await pedir(e, extra);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const pedido = r.body.action_id as string;
    await ownerQuery(`update liame.app_user set totp_last_step = null where id = $1`, [e.userId]);
    const a = await api.call('POST', `/v1/actions/${pedido}/approve`, { cookie: e.cookie, body: { plan_hash: (await pedidoDe(pedido)).plan_hash, code: totpCode(e.secret, currentStep()) } });
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    await executor.executeBatch(20, { tenantIds: [e.tenantId] });
    return { id: r.body.id as string, pedido };
  }
  const lida = async (e: Cenario, id: string) => (await api.call('GET', `/v1/google-campaigns/${id}`, { cookie: e.cookie })).body;

  it('aprovado: a conferência e a criação numa requisição só; a Performance Max pausada, com a marca, o raio, os textos, os recortes e a logo; os ids na linha', async () => {
    const e = await cenario('Brasa Google Cria');
    expect(CONNECTORS.google_ads?.writeFlag).toBe('google_write');
    // A logo deitada (500 × 250; a de Minha marca tem até 512 de lado): vai inteira, num quadrado branco de 500.
    await logoDaMarca(e, 500, 250);
    google.chamadas.length = 0;
    const { id, pedido } = await pedirEAprovar(e, { end_date: '2099-12-31' });
    const p = await pedidoDe(pedido);
    expect([p.status, p.status_reason], JSON.stringify(p)).toEqual(['executada', null]);

    // A conferência e a criação, com o token curto e a conta gerente; nada de procura (é a primeira tentativa).
    expect(google.resumo(e.cliente)).toEqual(['validacao:mutate', 'escrita:mutate']);
    for (const c of google.chamadasDe(e.cliente)) expect([c.autorizacao, c.gerente]).toEqual([`Bearer ${ACESSO_DO_GOOGLE}`, e.gerente]);
    const [validacao, escrita] = google.chamadasDe(e.cliente);
    expect(validacao!.corpo.mutateOperations).toEqual(escrita!.corpo.mutateOperations);

    const c = [...google.campanhas.values()].find((x) => x.cliente === e.cliente)!;
    // Nasce valendo só para quem está no raio (D-A5-34), e não com o padrão do Google (presença ou interesse).
    expect(c).toMatchObject({ name: `Combo sexta · Google · novembro (Liame ${id.replace(/-/g, '').slice(-12)})`, status: 'PAUSED', local: 'PRESENCE' });
    expect(google.orcamentos.get(c.orcamento!)).toMatchObject({ amountMicros: 30_000_000, explicitlyShared: false, period: 'DAILY' });
    const criacao = google.criacoes.get(c.id)!;
    expect(criacao.corpoDaCampanha).toMatchObject({
      advertisingChannelType: 'PERFORMANCE_MAX',
      status: 'PAUSED',
      maximizeConversions: {},
      brandGuidelinesEnabled: true,
      containsEuPoliticalAdvertising: 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING',
      finalUrlSuffix: 'utm_source=google&utm_medium=cpc&campaign_id={campaignid}',
      endDateTime: '2099-12-31 23:59:59',
    });
    expect(criacao.corpoDaCampanha.assetAutomationSettings).toEqual(
      ['TEXT_ASSET_AUTOMATION', 'FINAL_URL_EXPANSION_TEXT_ASSET_AUTOMATION', 'GENERATE_IMAGE_ENHANCEMENT', 'GENERATE_ENHANCED_YOUTUBE_VIDEOS'].map((t) => ({ assetAutomationType: t, assetAutomationStatus: 'OPTED_OUT' })),
    );
    // O raio em volta da loja (no ponto do endereço) e o português.
    expect(criacao.criterios.map((x) => ({ ...x, campaign: undefined }))).toEqual([
      { proximity: { geoPoint: { latitudeInMicroDegrees: -22906847, longitudeInMicroDegrees: -43172897 }, radius: 5, radiusUnits: 'KILOMETERS' } },
      { language: { languageConstant: 'languageConstants/1014' } },
    ]);
    // Na campanha, o nome da loja e a logo quadrada; no grupo, o cardápio, os textos aprovados e os três recortes da foto
    // (1440 × 1800), no tamanho recomendado.
    expect(criacao.daCampanha).toEqual([
      { papel: 'BUSINESS_NAME', texto: 'Mister Burgers' },
      { papel: 'LOGO', largura: 500, altura: 500 },
    ]);
    const grupo = [...google.grupos.values()].find((g) => g.campanha === c.id)!;
    expect(grupo.finalUrls).toEqual([CARDAPIO]);
    const textos = (papel: string) => grupo.recursos.filter((x) => x.papel === papel).map((x) => x.texto);
    expect([textos('HEADLINE'), textos('LONG_HEADLINE'), textos('DESCRIPTION')]).toEqual([TEXTOS.headlines, TEXTOS.long_headlines, TEXTOS.descriptions]);
    expect(grupo.recursos.filter((x) => x.largura).map(({ papel, largura, altura }) => [papel, largura, altura])).toEqual([
      ['MARKETING_IMAGE', 1200, 628],
      ['SQUARE_MARKETING_IMAGE', 1200, 1200],
      ['PORTRAIT_MARKETING_IMAGE', 960, 1200],
    ]);

    expect(await lida(e, id)).toMatchObject({ status: 'criada', active: false, error: null, google: { account_id: e.cliente, campaign_id: c.id, budget_id: c.orcamento, asset_group_id: grupo.id } });
  }, 180_000);

  it('a recusa do Google na conferência: nada é criado, e o motivo do Google fica no pedido e na campanha nova', async () => {
    const e = await cenario('Brasa Google Recusa');
    google.defeitos.set(e.cliente, (c) =>
      c.tipo === 'validacao' && c.recurso === 'mutate' ? google.erro(400, 'INVALID_ARGUMENT', 'Request contains an invalid argument.', { codigo: { criterionError: 'CANNOT_ADD_CRITERIA_TYPE' }, texto: 'Cannot add criteria of this type.' }) : null,
    );
    const { id, pedido } = await pedirEAprovar(e);
    google.defeitos.delete(e.cliente);
    const p = await pedidoDe(pedido);
    expect([p.status, p.status_reason]).toEqual(['falhou', 'O Google recusou a mudança: Cannot add criteria of this type (criterionError.CANNOT_ADD_CRITERIA_TYPE).']);
    expect(google.resumo(e.cliente)).toEqual(['validacao:mutate']);
    expect([...google.campanhas.values()].filter((x) => x.cliente === e.cliente)).toEqual([]);
    expect(await lida(e, id)).toMatchObject({ status: 'nao_criada', error: p.status_reason, google: { campaign_id: null, budget_id: null, asset_group_id: null } });
  }, 180_000);

  it('a resposta da criação se perde: a ação espera, e a tentativa seguinte acha a campanha pelo nome, sem criar de novo', async () => {
    const e = await cenario('Brasa Google Perde');
    google.perderResposta.add(e.cliente);
    const { id, pedido } = await pedirEAprovar(e);
    const adiado = await pedidoDe(pedido);
    expect(adiado.status, JSON.stringify(adiado)).toBe('aprovada');
    expect((await lida(e, id)).status).toBe('criando');
    expect(google.resumo(e.cliente)).toEqual(['validacao:mutate', 'escrita:mutate']);

    await ownerQuery(`update liame.action_request set next_attempt_at = now() - interval '1 second' where id = $1`, [pedido]);
    await executor.executeBatch(20, { tenantIds: [e.tenantId] });
    expect((await pedidoDe(pedido)).status).toBe('executada');
    // Uma criação só: a segunda tentativa leu e achou.
    expect(google.resumo(e.cliente)).toEqual(['validacao:mutate', 'escrita:mutate', 'leitura']);
    const criadas = [...google.campanhas.values()].filter((x) => x.cliente === e.cliente);
    expect(criadas).toHaveLength(1);
    const grupo = [...google.grupos.values()].find((g) => g.campanha === criadas[0]!.id)!;
    expect(await lida(e, id)).toMatchObject({ status: 'criada', google: { campaign_id: criadas[0]!.id, budget_id: criadas[0]!.orcamento, asset_group_id: grupo.id } });
  }, 180_000);

  it('a foto que saiu do armazenamento: a campanha nova não é criada, sem ir ao Google', async () => {
    const e = await cenario('Brasa Google Sem Foto');
    await armazem.apagar([e.fotoChave]);
    const { id, pedido } = await pedirEAprovar(e);
    const p = await pedidoDe(pedido);
    expect([p.status, p.status_reason]).toEqual(['falhou', 'A foto ou a logo desta campanha não está mais no Liame: nada foi criado no Google. Escolha outra foto e peça de novo.']);
    expect(google.chamadasDe(e.cliente)).toEqual([]);
    expect((await lida(e, id)).status).toBe('nao_criada');
  }, 120_000);

  /** Aprova um pedido com o código do app e roda o executor uma vez. */
  async function aprovarEExecutar(e: Cenario, pedido: string): Promise<void> {
    await ownerQuery(`update liame.app_user set totp_last_step = null where id = $1`, [e.userId]);
    const a = await api.call('POST', `/v1/actions/${pedido}/approve`, { cookie: e.cookie, body: { plan_hash: (await pedidoDe(pedido)).plan_hash, code: totpCode(e.secret, currentStep()) } });
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    await executor.executeBatch(20, { tenantIds: [e.tenantId] });
  }

  it('ativar e a volta (parte 5a): lê no Google, confere e muda a situação; um pedido em aberto; a removida no Google Ads não volta', async () => {
    const e = await cenario('Brasa Google Ativa');
    const ativar = (id: string) => api.call('POST', `/v1/google-campaigns/${id}/activate`, { cookie: e.cookie });
    const r = await pedir(e);
    const id = r.body.id as string;
    // Antes de criada, não ativa.
    expect((await ativar(id)).body.code).toBe('ainda-nao-criada');
    await aprovarEExecutar(e, r.body.action_id as string);
    const criada = await lida(e, id);
    expect(criada).toMatchObject({ status: 'criada', active: false, pending_action_id: null });
    const campanha = google.campanhas.get(criada.google.campaign_id as string)!;
    // Os limites da empresa: o teto do mês e o por campanha (ativar volta a gastar).
    await ownerQuery(`update liame.app_user set totp_last_step = null where id = $1`, [e.userId]);
    expect((await api.call('PUT', '/v1/budget/limits', { cookie: e.cookie, body: { month_micros: 3_000_000_000, campaign_daily_micros: 50_000_000 } })).status).toBe(200);

    const pedido = await ativar(id);
    expect(pedido.status, JSON.stringify(pedido.body)).toBe(201);
    expect(pedido.body).toMatchObject({ active: false, pending_action_id: expect.any(String) });
    const ativacao = pedido.body.pending_action_id as string;
    expect(await pedidoDe(ativacao)).toMatchObject({ status: 'aguardando_aprovacao', tool: 'campanha_google_ativar', provider: 'google_ads' });
    expect((await ativar(id)).body.code).toBe('pedido-em-aberto');
    google.chamadas.length = 0;
    // A campanha criada antes da D-A5-34 nasceu com o padrão do Google (presença ou interesse): ativar acerta isso.
    campanha.local = 'PRESENCE_OR_INTEREST';
    await aprovarEExecutar(e, ativacao);
    expect((await pedidoDe(ativacao)).status).toBe('executada');
    // Lê a campanha no Google, confere a mudança e muda: a campanha passa a rodar, só para quem está no raio.
    expect(google.resumo(e.cliente)).toEqual(['leitura', 'validacao:campaigns', 'escrita:campaigns']);
    expect(campanha.status).toBe('ENABLED');
    expect(campanha.local).toBe('PRESENCE');
    expect(await lida(e, id)).toMatchObject({ active: true, activated_at: expect.any(String), pending_action_id: null });
    expect((await ativar(id)).body.code).toBe('ja-ativa');

    // A volta: pausar, com o código do app.
    const volta = await api.call('POST', `/v1/actions/${ativacao}/undo`, { cookie: e.cookie });
    expect(volta.status, JSON.stringify(volta.body)).toBe(201);
    expect(volta.body).toMatchObject({ tool: 'campanha_google_pausar', status: 'aguardando_aprovacao' });
    await aprovarEExecutar(e, volta.body.id as string);
    expect((await pedidoDe(volta.body.id as string)).status).toBe('executada');
    expect(campanha.status).toBe('PAUSED');
    expect((await lida(e, id)).active).toBe(false);

    // Removida no Google Ads depois: ativar de novo não a traz de volta.
    campanha.status = 'REMOVED';
    const outra = await ativar(id);
    expect(outra.status, JSON.stringify(outra.body)).toBe(201);
    await aprovarEExecutar(e, outra.body.pending_action_id as string);
    const recusada = await pedidoDe(outra.body.pending_action_id as string);
    expect([recusada.status, recusada.status_reason]).toEqual(['falhou', 'Esta campanha não está mais no Google (foi removida no Google Ads): nada foi mudado.']);
    expect((await lida(e, id)).active).toBe(false);
  }, 180_000);
});
