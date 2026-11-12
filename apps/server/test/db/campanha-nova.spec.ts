import { randomBytes, randomUUID } from 'node:crypto';
import type { Database } from '@liame/database';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BudgetService } from '../../src/actions/budget.service.js';
import { campanhaNovaNaMetaConnector } from '../../src/actions/campanha-nova-na-meta.js';
import { currentStep, totpCode } from '../../src/auth/totp.js';
import { MELHORIAS_DO_CRIATIVO } from '../../src/campanhas/campanha-nova-plano.js';
import { ClienteConector } from '../../src/connectors/cliente-http.js';
import { versaoRegistrada } from '../../src/connectors/tipos.js';
import { DATABASE } from '../../src/database/database.module.js';
import { FlagService } from '../../src/flags/flag.service.js';
import { ARMAZEM_DE_IMAGENS, type ArmazemNaMemoria } from '../../src/imagens/armazem.js';
import { KillSwitchService } from '../../src/kill-switch/kill-switch.service.js';
import { VaultService } from '../../src/vault/vault.service.js';
import { ActionExecutor } from '../../src/worker/action-executor.js';
import { ownerQuery, resetIpRateLimits, startApi, type TestApi } from '../helpers/api.js';
import { type EmpresaComMeta, empresaComMeta, ligarFlagDaEmpresa, MetaDeMentira, SEGREDO_DO_APP_DA_META } from '../helpers/meta-de-mentira.js';
import { fotoGuardada, lojaComCardapio, videoGuardado } from '../helpers/posts-semeados.js';
import { hasDb } from './env.js';

// A4 · X5, parte 1: a campanha nova na Meta, criada pausada (P10; D-A4-31, D-A4-35, D-A4-40 e D-A4-41; migration 0138),
// contra Postgres e a Meta de mentira que segue a referência reconferida em 11/11/2026. O que se prova:
//   - pedir: só com a função; a peça aprovada, a loja com o ponto no endereço, a verba e o teto; o pedido espera o
//     código do app em Aprovações; um pedido em aberto por peça;
//   - criar com a foto e o cardápio: a campanha, o conjunto, o criativo e o anúncio, cada um validado antes, com a chave
//     de idempotência, tudo pausado, o raio em km, a Página, o botão, o rastreio e as melhorias desligadas;
//   - a Meta que manda esperar no meio: a tentativa seguinte continua de onde parou, sem criar de novo;
//   - o vídeo no WhatsApp: a espera do preparo, o vídeo com a capa e o destino WhatsApp;
//   - a recusa da Meta encerra com o motivo; o que já foi criado fica pausado.

const CARDAPIO = 'https://cardapio.exemplo.com.br/mister-centro';

describe.skipIf(!hasDb)('a campanha nova na Meta (A4 · X5, parte 1)', () => {
  let api: TestApi;
  let executor: ActionExecutor;
  let armazem: ArmazemNaMemoria;
  const meta = new MetaDeMentira();

  beforeAll(async () => {
    api = await startApi();
    await resetIpRateLimits();
    await meta.ligar();
    const database: Database = api.app.get(DATABASE);
    executor = new ActionExecutor(database, api.app.get(BudgetService), api.app.get(KillSwitchService), api.app.get(FlagService));
    armazem = api.app.get(ARMAZEM_DE_IMAGENS);
    const vault = api.app.get(VaultService);
    campanhaNovaNaMetaConnector.ligar({
      lerSegredo: (tx, id) => vault.readSecret(tx, id),
      cliente: () => new ClienteConector(database.db, { enderecos: { meta_ads: [`${meta.base}/graph`] }, tentativas: 1, balde: { capacidade: 10_000, porSegundo: 1_000 } }),
      graphUrl: `${meta.base}/graph`,
      appSecret: SEGREDO_DO_APP_DA_META,
      versao: (capacidade) => versaoRegistrada(database.db, 'meta_ads', capacidade),
      armazem,
    });
  }, 120_000);
  beforeEach(async () => {
    await resetIpRateLimits();
    meta.normalizar();
  });
  afterAll(async () => {
    await meta.desligar();
    await api?.close();
  });

  type Cenario = EmpresaComMeta & { pagina: string; instagram: string; unitId: string; peca: string };

  /** A empresa com a conta de anúncios, a Página e o Instagram, a loja com o cardápio e o ponto no endereço, e uma peça aprovada. */
  async function cenario(nome: string, o: { ligada?: boolean } = {}): Promise<Cenario> {
    const e = await empresaComMeta(api, meta, nome);
    // A outra conta da Meta (sem a autorização) sai: a campanha nova pede uma conta de anúncios só.
    await ownerQuery(`update liame.connected_account set disconnected_at = now() where id = $1`, [e.contaSemToken]);
    const [pagina, instagram] = [`10${randomBytes(6).readUIntBE(0, 6)}`, `1784${randomBytes(6).readUIntBE(0, 6)}`];
    await ownerQuery(
      `insert into liame.connected_account (id, tenant_id, brand_id, provider, external_id, name, provider_attributes)
       values ($1, $3, $4, 'facebook_page', $5, 'Mister Burgers', $7::jsonb), ($2, $3, $4, 'instagram', $6, '@misterburgers', '{}'::jsonb)`,
      [randomUUID(), randomUUID(), e.tenantId, e.brandId, pagina, instagram, JSON.stringify({ instagram_id: instagram })],
    );
    const { unitId } = await lojaComCardapio(e, 'Loja Centro', CARDAPIO);
    // O ponto no endereço vem com o endereço inteiro (a regra da 0132): o CEP, a cidade, a UF, o código IBGE e a origem.
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
       values ($1, $2, $3, 1, 'Smash duplo na sexta', 'Peça o combo pelo cardápio.', 'pedir_agora', '{}'::jsonb, 'passou', '{}'::jsonb, $4, 'criativo')`,
      [randomUUID(), e.tenantId, peca, randomBytes(32).toString('hex')],
    );
    await ligarFlagDaEmpresa(api, 'meta_write', e.tenantId, true);
    if (o.ligada ?? true) await ligarFlagDaEmpresa(api, 'campanha_nova', e.tenantId, true);
    return { ...e, pagina, instagram, unitId, peca };
  }

  const pedir = (e: Cenario, extra: Record<string, unknown> = {}) =>
    api.call('POST', '/v1/new-campaigns', {
      cookie: e.cookie,
      body: { brand_id: e.brandId, piece_id: e.peca, unit_id: e.unitId, name: 'Combo sexta · novembro', objective: 'cardapio', radius_km: 5, daily_budget_micros: 30_000_000, ...extra },
    });
  const pedidoDe = async (id: string) =>
    (await ownerQuery<{ status: string; status_reason: string | null; plan_hash: string; tool: string; before_state: Record<string, unknown> }>(
      `select status, status_reason, plan_hash, tool, before_state from liame.action_request where id = $1`,
      [id],
    ))[0]!;
  const linhaDe = async (id: string) =>
    (await ownerQuery<Record<string, string | null>>(
      `select status, error, meta_campaign_id, meta_adset_id, meta_video_id, meta_creative_id, meta_ad_id from liame.ad_campaign_new where id = $1`,
      [id],
    ))[0]!;
  async function aprovar(e: Cenario, pedido: string): Promise<void> {
    await ownerQuery(`update liame.app_user set totp_last_step = null where id = $1`, [e.userId]);
    await ownerQuery(`delete from liame.rate_limit where key = $1`, [`segundo-fator:${e.userId}`]);
    const r = await api.call('POST', `/v1/actions/${pedido}/approve`, { cookie: e.cookie, body: { plan_hash: (await pedidoDe(pedido)).plan_hash, code: totpCode(e.secret, currentStep()) } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  }
  const executar = (e: Cenario) => executor.executeBatch(20, { tenantIds: [e.tenantId] });
  const passaAEspera = (pedido: string) => ownerQuery(`update liame.action_request set next_attempt_at = now() - interval '1 second' where id = $1`, [pedido]);
  const daCampanha = (id: string, aresta: string) => meta.criados.filter((c) => c.aresta === aresta && c.chave?.startsWith(`${id}:`));

  it('pedir: só com a função; a peça aprovada, a loja no endereço e o teto; o pedido espera o código; um em aberto por peça', async () => {
    const e = await cenario('Brasa Campanha Pede', { ligada: false });
    const foto = await fotoGuardada(e, armazem, { largura: 1080, altura: 1350 });
    const codigo = async (r: { status: number; body: Record<string, unknown> }) => [r.status, r.body.code];
    expect(await codigo(await pedir(e, { media_id: foto.id }))).toEqual([409, 'funcao-desligada']);
    await ligarFlagDaEmpresa(api, 'campanha_nova', e.tenantId, true);

    await ownerQuery(`update liame.ad_piece set status = 'decidir' where id = $1`, [e.peca]);
    expect(await codigo(await pedir(e, { media_id: foto.id }))).toEqual([422, 'peca-nao-aprovada']);
    await ownerQuery(`update liame.ad_piece set status = 'aprovada' where id = $1`, [e.peca]);
    await ownerQuery(`update liame.unit set location_precision = 'bairro' where id = $1`, [e.unitId]);
    expect(await codigo(await pedir(e, { media_id: foto.id }))).toEqual([422, 'loja-sem-endereco']);
    await ownerQuery(`update liame.unit set location_precision = 'endereco' where id = $1`, [e.unitId]);
    expect(await codigo(await pedir(e, { media_id: foto.id, daily_budget_micros: 30_005_000 }))).toEqual([422, 'verba-invalida']);
    expect(await codigo(await pedir(e, { media_id: foto.id, end_date: '2020-01-01' }))).toEqual([422, 'fim-no-passado']);
    expect(await codigo(await pedir(e, { media_id: randomUUID() }))).toEqual([422, 'midia-fora-das-fotos']);
    // O teto por campanha da empresa (R$ 20,00 por dia) segura a verba de R$ 30,00.
    const limites = async (campanha: number) => {
      await ownerQuery(`update liame.app_user set totp_last_step = null where id = $1`, [e.userId]);
      const t = await api.call('PUT', '/v1/budget/limits', { cookie: e.cookie, body: { month_micros: 3_000_000_000, campaign_daily_micros: campanha } });
      expect(t.status, JSON.stringify(t.body)).toBe(200);
    };
    await limites(20_000_000);
    expect(await codigo(await pedir(e, { media_id: foto.id }))).toEqual([422, 'acima-do-teto']);
    await limites(50_000_000);

    const r = await pedir(e, { media_id: foto.id });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({ status: 'pedida', objective: 'cardapio', radius_km: 5, daily_budget_micros: 30_000_000, link: CARDAPIO, piece_version: 1, meta: { campaign_id: null } });
    const pedido = await pedidoDe(r.body.action_id as string);
    expect(pedido).toMatchObject({ status: 'aguardando_aprovacao', tool: 'campanha_criar' });
    expect(pedido.before_state).toMatchObject({
      nome: 'Combo sexta · novembro',
      peca: { titulo: 'Smash duplo na sexta', texto: 'Peça o combo pelo cardápio.', botao: 'pedir_agora' },
      pagina: { id: e.pagina, nome: 'Mister Burgers' },
      instagram: { id: e.instagram },
      loja: { nome: 'Loja Centro', latitude: -22.906847, longitude: -43.172897 },
      raio_km: 5,
      situacao: 'pedida',
    });
    // Nada vai à Meta antes da aprovação.
    expect(daCampanha(r.body.id as string, 'campaigns')).toEqual([]);
    expect(await codigo(await pedir(e, { media_id: foto.id }))).toEqual([409, 'ja-pedida']);
    // Recusado em Aprovações, a peça fica livre para outro pedido, e a campanha nova diz cancelada.
    await ownerQuery(`update liame.action_request set status = 'cancelada' where id = $1`, [r.body.action_id]);
    expect((await api.call('GET', `/v1/new-campaigns/${r.body.id}`, { cookie: e.cookie })).body.status).toBe('cancelada');
    expect((await pedir(e, { media_id: foto.id })).status).toBe(201);
  }, 120_000);

  it('as opções da gaveta (parte 2): quem assina, as lojas com o endereço e o cardápio, o teto, o que impede e a campanha de cada peça', async () => {
    const e = await cenario('Brasa Opcoes da Gaveta');
    const opcoes = (emp: Cenario) => api.call('GET', `/v1/new-campaigns/options?brand_id=${emp.brandId}`, { cookie: emp.cookie });
    // Uma segunda loja, sem o ponto no endereço e sem cardápio, com o raio de entrega.
    const { unitId: outra } = await lojaComCardapio(e, 'Loja Tijuca', null);
    await ownerQuery(`update liame.unit set delivery_radius_km = 4.5 where id = $1`, [outra]);

    const r = await opcoes(e);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ enabled: true, blocks: [], page: { name: 'Mister Burgers' }, instagram: { name: '@misterburgers' }, campaign_cap_micros: null, by_piece: [] });
    expect(r.body.ad_account).toMatchObject({ name: expect.any(String) });
    expect(r.body.units).toEqual([
      { id: e.unitId, name: 'Loja Centro', address: 'Rua da Assembleia, 10, Centro', has_address: true, delivery_radius_km: null, menu_available: true, menu_block: null },
      {
        id: outra,
        name: 'Loja Tijuca',
        address: null,
        has_address: false,
        delivery_radius_km: 4.5,
        menu_available: false,
        menu_block: 'O cardápio online ligado à marca é o de outra loja: escolha a loja do cardápio, ou o objetivo de conversas no WhatsApp.',
      },
    ]);

    // O pedido aparece na peça; o teto por campanha aparece quando a empresa define.
    const p = await pedir(e, { media_id: (await fotoGuardada(e, armazem, { largura: 1080, altura: 1080 })).id });
    expect(p.status, JSON.stringify(p.body)).toBe(201);
    await ownerQuery(`update liame.app_user set totp_last_step = null where id = $1`, [e.userId]);
    expect((await api.call('PUT', '/v1/budget/limits', { cookie: e.cookie, body: { month_micros: 3_000_000_000, campaign_daily_micros: 50_000_000 } })).status).toBe(200);
    const depois = (await opcoes(e)).body;
    expect(depois.by_piece).toEqual([{ piece_id: e.peca, campaign_id: p.body.id, status: 'pedida', active: false, action_id: p.body.action_id }]);
    expect(depois.campaign_cap_micros).toBe(50_000_000);

    // A função desligada e a Página que saiu: o que impede, com as palavras da recusa do pedido.
    const sem = await cenario('Brasa Opcoes Sem Pagina', { ligada: false });
    await ownerQuery(`update liame.connected_account set disconnected_at = now() where tenant_id = $1 and provider = 'facebook_page'`, [sem.tenantId]);
    const s = (await opcoes(sem)).body;
    expect(s.enabled).toBe(false);
    expect(s.blocks.map((b: { code: string }) => b.code)).toEqual(['funcao-desligada', 'sem-pagina']);
    expect([s.page, s.instagram]).toEqual([null, null]);
    expect((await pedir(sem, { media_id: randomUUID() })).body.code).toBe('funcao-desligada');
    // Marca de outra empresa: 404.
    expect((await api.call('GET', `/v1/new-campaigns/options?brand_id=${e.brandId}`, { cookie: sem.cookie })).status).toBe(404);
  }, 120_000);

  it('criar com a foto e o cardápio: os quatro objetos, cada um validado antes, com a chave, tudo pausado', async () => {
    const e = await cenario('Brasa Campanha Foto');
    const foto = await fotoGuardada(e, armazem, { largura: 1080, altura: 1350 });
    const r = await pedir(e, { media_id: foto.id, radius_km: 3.5 });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const id = r.body.id as string;
    await aprovar(e, r.body.action_id as string);
    await executar(e);
    expect((await pedidoDe(r.body.action_id as string)).status).toBe('executada');
    const linha = await linhaDe(id);
    expect(linha).toMatchObject({ status: 'criada', error: null });

    const [campanha] = daCampanha(id, 'campaigns');
    const [conjunto] = daCampanha(id, 'adsets');
    const [criativo] = daCampanha(id, 'adcreatives');
    const [anuncio] = daCampanha(id, 'ads');
    expect([campanha?.id, conjunto?.id, criativo?.id, anuncio?.id]).toEqual([linha.meta_campaign_id, linha.meta_adset_id, linha.meta_creative_id, linha.meta_ad_id]);
    expect(campanha!.params).toMatchObject({ objective: 'OUTCOME_TRAFFIC', status: 'PAUSED', special_ad_categories: '[]', is_adset_budget_sharing_enabled: 'false' });
    expect(conjunto!.params).toMatchObject({ campaign_id: campanha!.id, status: 'PAUSED', daily_budget: '3000', optimization_goal: 'LINK_CLICKS', billing_event: 'IMPRESSIONS' });
    expect(JSON.parse(conjunto!.params.targeting!).geo_locations.custom_locations).toEqual([{ latitude: -22.906847, longitude: -43.172897, radius: 3.5, distance_unit: 'kilometer' }]);
    const spec = JSON.parse(criativo!.params.object_story_spec!);
    expect(spec).toMatchObject({ page_id: e.pagina, instagram_user_id: e.instagram, link_data: { link: CARDAPIO, call_to_action: { type: 'ORDER_NOW', value: { link: CARDAPIO } } } });
    // A foto vai pelo endereço assinado do armazenamento (a Meta guarda na biblioteca da conta).
    expect(spec.link_data.picture).toMatch(/^memoria:\/\/imagens\/.+\?valido=\d+$/);
    expect(criativo!.params.url_tags).toContain('utm_source=meta&utm_medium=paid');
    expect(Object.keys(JSON.parse(criativo!.params.degrees_of_freedom_spec!).creative_features_spec)).toHaveLength(MELHORIAS_DO_CRIATIVO.length);
    expect(anuncio!.params).toMatchObject({ adset_id: conjunto!.id, status: 'PAUSED', creative: JSON.stringify({ creative_id: criativo!.id }) });
    // Cada objeto validado antes de criar, e criado com a chave do passo.
    for (const aresta of ['campaigns', 'adsets', 'adcreatives', 'ads']) {
      const chamadas = meta.chamadas.filter((c) => c.id === `act_${meta.conta}/${aresta}` && (c.params.name ?? '').startsWith('Combo sexta'));
      expect(chamadas.slice(-2).map((c) => c.validar)).toEqual([true, false]);
    }
    expect([campanha, conjunto, criativo, anuncio].map((c) => c!.chave)).toEqual([`${id}:campanha`, `${id}:conjunto`, `${id}:criativo`, `${id}:anuncio`]);
    // Na Meta, tudo pausado.
    expect([campanha, conjunto, anuncio].map((c) => meta.objetos.get(c!.id)?.status)).toEqual(['PAUSED', 'PAUSED', 'PAUSED']);
    expect(meta.defeitos).toEqual([]);
    const lida = await api.call('GET', `/v1/new-campaigns/${id}`, { cookie: e.cookie });
    expect(lida.body).toMatchObject({ status: 'criada', meta: { campaign_id: campanha!.id, ad_id: anuncio!.id } });
    // A conta de anúncios na Meta, para o link do Gerenciador (a tela tira o `act_`).
    const [externa] = await ownerQuery<{ external_id: string }>(`select external_id from liame.connected_account where id = $1`, [e.conta]);
    expect(lida.body.meta.account_id).toBe(externa!.external_id);
  }, 120_000);

  it('a Meta manda esperar no meio: a tentativa seguinte continua de onde parou, e a resposta perdida não cria de novo', async () => {
    const e = await cenario('Brasa Campanha Retoma');
    const foto = await fotoGuardada(e, armazem, { largura: 1080, altura: 1350 });
    const r = await pedir(e, { media_id: foto.id });
    const id = r.body.id as string;
    const pedido = r.body.action_id as string;
    await aprovar(e, pedido);
    // No anúncio, a Meta cria e a resposta se perde (fora do ar); na tentativa seguinte, a conta passa do limite.
    meta.falhasDaCriacao = [
      { aresta: 'ads', status: 503, corpo: meta.erro(2, 'Service temporarily unavailable'), aplicaAntes: true },
      { aresta: 'ads', status: 400, corpo: meta.erro(17, 'User request limit reached', { error_subcode: 2446079 }) },
    ];
    await executar(e);
    expect((await pedidoDe(pedido)).status).toBe('aprovada');
    expect(await linhaDe(id)).toMatchObject({ status: 'criando', meta_ad_id: null });
    expect((await linhaDe(id)).meta_creative_id).not.toBeNull();
    await passaAEspera(pedido);
    await executar(e);
    expect((await pedidoDe(pedido)).status).toBe('aprovada');
    await passaAEspera(pedido);
    await executar(e);
    expect((await pedidoDe(pedido)).status).toBe('executada');
    // Uma campanha, um conjunto, um criativo e um anúncio só: a chave do passo devolveu o anúncio que a Meta já tinha criado.
    expect(['campaigns', 'adsets', 'adcreatives', 'ads'].map((a) => daCampanha(id, a).length)).toEqual([1, 1, 1, 1]);
    expect(await linhaDe(id)).toMatchObject({ status: 'criada', meta_ad_id: daCampanha(id, 'ads')[0]!.id });
  }, 120_000);

  it('o vídeo no WhatsApp: a espera do preparo, o vídeo com a capa e o destino WhatsApp com a Página', async () => {
    const e = await cenario('Brasa Campanha Video');
    const video = await videoGuardado(e, armazem, { capa: true });
    const r = await pedir(e, { media_id: video.id, objective: 'whatsapp' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.link).toBeNull();
    const id = r.body.id as string;
    const pedido = r.body.action_id as string;
    await aprovar(e, pedido);
    meta.leiturasDoVideoEmPreparo = 1;
    await executar(e);
    // A Meta ainda prepara o vídeo: o pedido espera, com a campanha, o conjunto e o vídeo já guardados.
    expect((await pedidoDe(pedido)).status).toBe('aprovada');
    const meio = await linhaDe(id);
    expect(meio).toMatchObject({ status: 'criando', meta_creative_id: null });
    expect(meio.meta_video_id).not.toBeNull();
    await passaAEspera(pedido);
    await executar(e);
    expect((await pedidoDe(pedido)).status).toBe('executada');
    const [enviado] = meta.criados.filter((c) => c.aresta === 'advideos' && c.id === meio.meta_video_id);
    expect(enviado!.params.file_url).toMatch(/^memoria:\/\/imagens\/.+\?valido=\d+$/);
    expect(daCampanha(id, 'campaigns')[0]!.params.objective).toBe('OUTCOME_ENGAGEMENT');
    const conjunto = daCampanha(id, 'adsets')[0]!.params;
    expect(conjunto).toMatchObject({ destination_type: 'WHATSAPP', optimization_goal: 'CONVERSATIONS' });
    expect(JSON.parse(conjunto.promoted_object!)).toEqual({ page_id: e.pagina });
    const spec = JSON.parse(daCampanha(id, 'adcreatives')[0]!.params.object_story_spec!);
    expect(spec.video_data).toMatchObject({ video_id: meio.meta_video_id, call_to_action: { type: 'WHATSAPP_MESSAGE', value: { app_destination: 'WHATSAPP' } } });
    expect(spec.video_data.image_url).toMatch(/-mini\.jpg\?valido=\d+$/);
    expect(daCampanha(id, 'adcreatives')[0]!.params.url_tags).toBeUndefined();
  }, 120_000);

  it('ativar e a volta (parte 3): com os limites, os três objetos em ativo; a volta pausa a campanha; o apagado na Meta não volta', async () => {
    const e = await cenario('Brasa Campanha Ativa');
    const foto = await fotoGuardada(e, armazem, { largura: 1080, altura: 1350 });
    const r = await pedir(e, { media_id: foto.id });
    const id = r.body.id as string;
    // Antes de criada, não ativa.
    expect((await api.call('POST', `/v1/new-campaigns/${id}/activate`, { cookie: e.cookie })).body.code).toBe('ainda-nao-criada');
    await aprovar(e, r.body.action_id as string);
    await executar(e);
    const linha = await linhaDe(id);
    expect(linha.status).toBe('criada');
    // Os limites da empresa: o teto do mês e o por campanha (ativar volta a gastar).
    await ownerQuery(`update liame.app_user set totp_last_step = null where id = $1`, [e.userId]);
    expect((await api.call('PUT', '/v1/budget/limits', { cookie: e.cookie, body: { month_micros: 3_000_000_000, campaign_daily_micros: 50_000_000 } })).status).toBe(200);

    const pedido = await api.call('POST', `/v1/new-campaigns/${id}/activate`, { cookie: e.cookie });
    expect(pedido.status, JSON.stringify(pedido.body)).toBe(201);
    expect(pedido.body).toMatchObject({ active: false, pending_action_id: expect.any(String) });
    const ativacao = pedido.body.pending_action_id as string;
    expect(await pedidoDe(ativacao)).toMatchObject({ status: 'aguardando_aprovacao', tool: 'campanha_nova_ativar' });
    expect((await api.call('POST', `/v1/new-campaigns/${id}/activate`, { cookie: e.cookie })).body.code).toBe('pedido-em-aberto');
    await aprovar(e, ativacao);
    const antes = meta.chamadas.length;
    await executar(e);
    expect((await pedidoDe(ativacao)).status).toBe('executada');
    const ids = [linha.meta_ad_id!, linha.meta_adset_id!, linha.meta_campaign_id!];
    expect(ids.map((i) => meta.objetos.get(i)?.status)).toEqual(['ACTIVE', 'ACTIVE', 'ACTIVE']);
    // Lê os três, valida os três e escreve, o anúncio primeiro e a campanha por último.
    const feitas = meta.chamadas.slice(antes).map((c) => `${c.metodo === 'GET' ? 'ler' : c.validar ? 'validar' : 'escrever'}:${ids.indexOf(c.id)}`);
    expect(feitas).toEqual(['ler:0', 'ler:1', 'ler:2', 'validar:0', 'validar:1', 'validar:2', 'escrever:0', 'escrever:1', 'escrever:2']);
    expect((await api.call('GET', `/v1/new-campaigns/${id}`, { cookie: e.cookie })).body).toMatchObject({ active: true, activated_at: expect.any(String), pending_action_id: null });
    expect((await api.call('POST', `/v1/new-campaigns/${id}/activate`, { cookie: e.cookie })).body.code).toBe('ja-ativa');

    // A volta: pausar a campanha (os filhos herdam), com o código do app.
    const volta = await api.call('POST', `/v1/actions/${ativacao}/undo`, { cookie: e.cookie });
    expect(volta.status, JSON.stringify(volta.body)).toBe(201);
    expect(volta.body).toMatchObject({ tool: 'campanha_nova_pausar', status: 'aguardando_aprovacao' });
    await aprovar(e, volta.body.id as string);
    await executar(e);
    expect((await pedidoDe(volta.body.id as string)).status).toBe('executada');
    expect(meta.objetos.get(linha.meta_campaign_id!)?.status).toBe('PAUSED');
    expect((await api.call('GET', `/v1/new-campaigns/${id}`, { cookie: e.cookie })).body.active).toBe(false);

    // Apagada no Gerenciador de Anúncios depois: ativar de novo não a traz de volta.
    meta.objetos.get(linha.meta_campaign_id!)!.status = 'DELETED';
    const outra = await api.call('POST', `/v1/new-campaigns/${id}/activate`, { cookie: e.cookie });
    expect(outra.status, JSON.stringify(outra.body)).toBe(201);
    await aprovar(e, outra.body.pending_action_id as string);
    await executar(e);
    const recusada = await pedidoDe(outra.body.pending_action_id as string);
    expect(recusada.status).toBe('falhou');
    expect(recusada.status_reason).toContain('apagada ou arquivada no Gerenciador de Anúncios');
    expect(meta.defeitos).toEqual([]);
  }, 120_000);

  /** Um post na leitura de Fotos › Do seu Instagram, do Instagram da Página (ou de outro perfil da marca). */
  async function postNoInstagram(e: Cenario, o: { kind?: string; caption?: string; perfil?: string } = {}): Promise<string> {
    const id = `179${randomBytes(6).readUIntBE(0, 6)}`;
    const [conta] = await ownerQuery<{ id: string }>(`select id from liame.connected_account where tenant_id = $1 and provider = 'instagram' and external_id = $2`, [e.tenantId, o.perfil ?? e.instagram]);
    await ownerQuery(
      `insert into liame.instagram_media (connected_account_id, tenant_id, brand_id, media_id, kind, caption, permalink, thumbnail_url, has_file, published_at)
       values ($1, $2, $3, $4, $5, $6, $7, 'https://scontent.exemplo/capa.jpg', false, '2026-09-18T21:00:00Z')`,
      [conta!.id, e.tenantId, e.brandId, id, o.kind ?? 'reels', o.caption ?? 'Smash duplo saindo da chapa. Peça pelo link da bio.', `https://www.instagram.com/reel/${id}/`],
    );
    return id;
  }
  const pedirReels = (e: Cenario, reels: string, extra: Record<string, unknown> = {}) =>
    api.call('POST', '/v1/new-campaigns', {
      cookie: e.cookie,
      body: { brand_id: e.brandId, instagram_media_id: reels, unit_id: e.unitId, name: 'Reels de 18/09 · novembro', objective: 'cardapio', radius_km: 5, daily_budget_micros: 30_000_000, ...extra },
    });

  it('a campanha a partir de um Reels (parte 6): o post do Instagram da Página, como está; a Meta pergunta antes; o que não pode não cria nada', async () => {
    const e = await cenario('Brasa Campanha Reels');
    const reels = await postNoInstagram(e);
    const codigo = async (r: { status: number; body: Record<string, unknown> }) => [r.status, r.body.code];

    // Uma origem ou a outra: a peça com o Reels não passa do contrato.
    expect((await pedirReels(e, reels, { piece_id: e.peca })).status).toBe(400);
    expect((await pedirReels(e, 'nao-e-numero')).status).toBe(400);
    // O post que não está na leitura, o post que é foto e o Reels de outro perfil da marca.
    expect(await codigo(await pedirReels(e, '17900000000000001'))).toEqual([422, 'reels-nao-encontrado']);
    expect(await codigo(await pedirReels(e, await postNoInstagram(e, { kind: 'foto' })))).toEqual([422, 'nao-e-reels']);
    const outroPerfil = `1784${randomBytes(6).readUIntBE(0, 6)}`;
    await ownerQuery(`insert into liame.connected_account (id, tenant_id, brand_id, provider, external_id, name, provider_attributes) values ($1, $2, $3, 'instagram', $4, '@outra', '{}'::jsonb)`, [
      randomUUID(),
      e.tenantId,
      e.brandId,
      outroPerfil,
    ]);
    expect(await codigo(await pedirReels(e, await postNoInstagram(e, { perfil: outroPerfil })))).toEqual([422, 'reels-nao-encontrado']);

    const r = await pedirReels(e, reels);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({
      status: 'pedida',
      piece_id: null,
      piece_version: null,
      media_id: null,
      instagram_media_id: reels,
      reels: { caption: 'Smash duplo saindo da chapa. Peça pelo link da bio.', permalink: `https://www.instagram.com/reel/${reels}/`, published_at: '2026-09-18T21:00:00.000Z' },
    });
    const pedido = await pedidoDe(r.body.action_id as string);
    expect(pedido).toMatchObject({ status: 'aguardando_aprovacao', tool: 'campanha_criar' });
    expect(pedido.before_state).toMatchObject({ peca: null, midia: { id: reels, tipo: 'reels', legenda: 'Smash duplo saindo da chapa. Peça pelo link da bio.' }, instagram: { id: e.instagram } });
    expect(await codigo(await pedirReels(e, reels))).toEqual([409, 'ja-pedida']);
    // As opções: o Reels na lista dele, nunca na das peças.
    const opcoes = (await api.call('GET', `/v1/new-campaigns/options?brand_id=${e.brandId}`, { cookie: e.cookie })).body;
    expect(opcoes.by_reels).toEqual([{ instagram_media_id: reels, campaign_id: r.body.id, status: 'pedida', active: false, action_id: r.body.action_id }]);
    expect(opcoes.by_piece).toEqual([]);

    // Criar: a pergunta da elegibilidade antes de tudo; o criativo aponta para o post; tudo pausado.
    meta.reels.set(reels, true);
    await aprovar(e, r.body.action_id as string);
    await executar(e);
    expect((await pedidoDe(r.body.action_id as string)).status).toBe('executada');
    const id = r.body.id as string;
    expect(await linhaDe(id)).toMatchObject({ status: 'criada', error: null, meta_video_id: null });
    const [criativo] = daCampanha(id, 'adcreatives');
    expect(criativo!.params).toMatchObject({ object_id: e.pagina, instagram_user_id: e.instagram, source_instagram_media_id: reels });
    expect(criativo!.params.object_story_spec).toBeUndefined();
    expect(JSON.parse(criativo!.params.call_to_action!)).toEqual({ type: 'ORDER_NOW', value: { link: CARDAPIO } });
    expect(criativo!.params.url_tags).toContain('utm_source=meta&utm_medium=paid');
    const pergunta = meta.chamadas.findIndex((c) => c.id === reels && c.metodo === 'GET');
    const campanha = meta.chamadas.findIndex((c) => c.id === `act_${meta.conta}/campaigns` && c.params.name === 'Reels de 18/09 · novembro');
    expect(pergunta).toBeGreaterThanOrEqual(0);
    expect(meta.chamadas[pergunta]!.params.fields).toBe('boost_eligibility_info');
    expect(pergunta).toBeLessThan(campanha);
    expect(['campaigns', 'adsets', 'adcreatives', 'ads'].map((a) => daCampanha(id, a).length)).toEqual([1, 1, 1, 1]);
    expect(daCampanha(id, 'advideos')).toEqual([]);
    expect(meta.defeitos).toEqual([]);

    // O Reels que a Meta diz que não pode (a música do Instagram): não criada, com o motivo, e nada criado na Meta.
    const naoPode = await postNoInstagram(e, { caption: 'Com música' });
    meta.reels.set(naoPode, false);
    const n = await pedirReels(e, naoPode, { name: 'Reels com música' });
    expect(n.status, JSON.stringify(n.body)).toBe(201);
    await aprovar(e, n.body.action_id as string);
    await executar(e);
    const recusada = await linhaDe(n.body.id as string);
    expect(recusada.status).toBe('nao_criada');
    expect(recusada.error).toMatch(/^A Meta não deixa este Reels virar anúncio/);
    expect(['campaigns', 'adsets', 'adcreatives', 'ads'].map((a) => daCampanha(n.body.id as string, a).length)).toEqual([0, 0, 0, 0]);
    expect((await pedidoDe(n.body.action_id as string)).status).toBe('falhou');

    // A Meta que não responde o campo: segue, e o criativo diz se aceita.
    const semResposta = await postNoInstagram(e, { caption: 'Sem a resposta' });
    meta.reels.set(semResposta, null);
    const s = await pedirReels(e, semResposta, { name: 'Reels sem resposta' });
    await aprovar(e, s.body.action_id as string);
    await executar(e);
    expect((await linhaDe(s.body.id as string)).status).toBe('criada');

    // O Reels que saiu da leitura do Instagram depois do pedido: não criada, sem ir à Meta.
    const saiu = await postNoInstagram(e, { caption: 'Vai sair' });
    const q = await pedirReels(e, saiu, { name: 'Reels que saiu' });
    await aprovar(e, q.body.action_id as string);
    await ownerQuery(`delete from liame.instagram_media where media_id = $1`, [saiu]);
    await executar(e);
    expect(await linhaDe(q.body.id as string)).toMatchObject({ status: 'nao_criada', meta_campaign_id: null });
    expect((await linhaDe(q.body.id as string)).error).toMatch(/^O Reels desta campanha saiu do Instagram da marca/);
    const lida = await api.call('GET', `/v1/new-campaigns/${q.body.id}`, { cookie: e.cookie });
    expect(lida.body).toMatchObject({ instagram_media_id: saiu, reels: null, status: 'nao_criada' });
  }, 180_000);

  it('a recusa da Meta encerra com o motivo; o que já foi criado fica pausado', async () => {
    const e = await cenario('Brasa Campanha Recusa');
    const foto = await fotoGuardada(e, armazem, { largura: 1080, altura: 1350 });
    const r = await pedir(e, { media_id: foto.id });
    const id = r.body.id as string;
    const pedido = r.body.action_id as string;
    await aprovar(e, pedido);
    meta.falhasDaCriacao = [{ aresta: 'adsets', status: 400, corpo: meta.erro(100, 'Invalid parameter', { error_user_msg: 'O público deste conjunto é pequeno demais.' }) }];
    await executar(e);
    const p = await pedidoDe(pedido);
    expect(p.status).toBe('falhou');
    expect(p.status_reason).toContain('O público deste conjunto é pequeno demais');
    const linha = await linhaDe(id);
    expect(linha.status).toBe('nao_criada');
    expect(linha.error).toContain('ficou pausado');
    expect(daCampanha(id, 'campaigns')).toHaveLength(1);
    expect(daCampanha(id, 'adsets')).toEqual([]);
    expect(meta.objetos.get(linha.meta_campaign_id!)?.status).toBe('PAUSED');
    expect((await api.call('GET', `/v1/new-campaigns/${id}`, { cookie: e.cookie })).body).toMatchObject({ status: 'nao_criada' });
  }, 120_000);
});
