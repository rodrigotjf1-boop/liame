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
    await ownerQuery(`update liame.unit set latitude = -22.906847, longitude = -43.172897, location_precision = 'endereco' where id = $1`, [unitId]);
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
