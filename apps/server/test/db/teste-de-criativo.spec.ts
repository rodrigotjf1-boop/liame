import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Database } from '@liame/database';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BudgetService } from '../../src/actions/budget.service.js';
import { testeDeCriativoNaMetaConnector } from '../../src/actions/teste-de-criativo-na-meta.js';
import { currentStep, totpCode } from '../../src/auth/totp.js';
import { publicoNoRaio } from '../../src/campanhas/publico-no-raio.js';
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
import { fotoGuardada, lojaComCardapio } from '../helpers/posts-semeados.js';
import { hasDb } from './env.js';

// Plano da região, R8: o teste de criativo na Meta (protótipo aprovado em 13/11/2026; D-RG-76 a D-RG-80; migration 0157),
// contra Postgres e a Meta de mentira. O que se prova:
//   - pedir: só com a função; as duas peças aprovadas, a metade exata da verba, o teto, a loja com o Regem que liberou
//     criar cupom e os códigos livres; o texto de cada anúncio com a linha do cupom; o pedido espera o código do app em
//     Aprovações; um teste vivo por marca;
//   - criar: uma campanha "Teste · …", dois conjuntos com a metade da verba cada, dois criativos e dois anúncios, cada
//     um validado antes, com a chave de idempotência do passo, tudo pausado; o teste fica `criando` até os cupons;
//   - ativar: só com o teste pronto; com o código e os limites; os cinco objetos em ativo, o anúncio antes da campanha;
//   - encerrar: sem o código, a campanha de teste pausa e o teste fica encerrado.

const CARDAPIO = 'https://cardapio.exemplo.com.br/mister-centro';
const OFERTA = 'Combo sexta: smash, batata e refri por R$ 34,90';
const DOSSIE = {
  identity: { summary: 'Hamburgueria de bairro com smash feito na chapa', audience: 'Quem mora ou trabalha no Centro', differentiator: 'Pão feito na casa todo dia', since: '2019' },
  voice: { traits: ['Direta'], rules: ['Frases curtas.'], do_example: 'Bateu a fome? O smash sai da chapa rapidinho.', dont_example: '' },
  products: { items: ['Smash Clássico R$ 29,90'] },
  offers: { items: [OFERTA] },
  forbidden: { items: [{ text: 'gourmet', why: 'não combina com a casa' }] },
  region: { area: 'Centro e Lapa', pickup: true },
};

/** A estimativa de público da Meta, numa Graph de mentira só deste arquivo: sempre uma faixa grande. */
class EstimativaDeMentira {
  private servidor: Server | null = null;
  base = '';
  async ligar(): Promise<void> {
    this.servidor = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: { users_lower_bound: 50_000, users_upper_bound: 60_000, estimate_ready: true } }));
    });
    await new Promise<void>((ok) => this.servidor!.listen(0, '127.0.0.1', ok));
    this.base = `http://127.0.0.1:${(this.servidor.address() as AddressInfo).port}`;
  }
  async desligar(): Promise<void> {
    await new Promise<void>((ok) => (this.servidor ? this.servidor.close(() => ok()) : ok()));
  }
}

describe.skipIf(!hasDb)('o teste de criativo na Meta (plano da região, R8)', () => {
  let api: TestApi;
  let executor: ActionExecutor;
  let armazem: ArmazemNaMemoria;
  const meta = new MetaDeMentira();
  const estimativa = new EstimativaDeMentira();

  beforeAll(async () => {
    api = await startApi();
    await resetIpRateLimits();
    await meta.ligar();
    await estimativa.ligar();
    const database: Database = api.app.get(DATABASE);
    executor = new ActionExecutor(database, api.app.get(BudgetService), api.app.get(KillSwitchService), api.app.get(FlagService));
    armazem = api.app.get(ARMAZEM_DE_IMAGENS);
    const vault = api.app.get(VaultService);
    testeDeCriativoNaMetaConnector.ligar({
      lerSegredo: (tx, id) => vault.readSecret(tx, id),
      cliente: () => new ClienteConector(database.db, { enderecos: { meta_ads: [`${meta.base}/graph`] }, tentativas: 1, balde: { capacidade: 10_000, porSegundo: 1_000 } }),
      graphUrl: `${meta.base}/graph`,
      appSecret: SEGREDO_DO_APP_DA_META,
      versao: (capacidade) => versaoRegistrada(database.db, 'meta_ads', capacidade),
      armazem,
    });
    publicoNoRaio.ligar({
      lerSegredo: (tx, id) => vault.readSecret(tx, id),
      cliente: () => new ClienteConector(database.db, { enderecos: { meta_ads: [`${estimativa.base}/graph`] }, tentativas: 1, balde: { capacidade: 10_000, porSegundo: 1_000 } }),
      graphUrl: `${estimativa.base}/graph`,
      appSecret: SEGREDO_DO_APP_DA_META,
      versao: (capacidade) => versaoRegistrada(database.db, 'meta_ads', capacidade),
    });
  }, 120_000);
  beforeEach(async () => {
    await resetIpRateLimits();
    meta.normalizar();
  });
  afterAll(async () => {
    await meta.desligar();
    await estimativa.desligar();
    await api?.close();
  });

  type Cenario = EmpresaComMeta & { pagina: string; unitId: string; regem: string; pecas: [string, string] };

  /** Liga uma função para a empresa (as duas deste arquivo ainda não estão na lista do ajudante comum). */
  async function ligarFuncao(chave: 'teste_de_criativo' | 'regem_write', tenantId: string): Promise<void> {
    await ownerQuery(`delete from liame.feature_flag_rule where flag_key = $1 and scope_type = 'tenant' and scope_id = $2`, [chave, tenantId]);
    await ownerQuery(
      `insert into liame.feature_flag_rule (id, flag_key, scope_type, scope_id, value, rollout_percent, created_by)
       values (gen_random_uuid(), $1, 'tenant', $2, 'true'::jsonb, null, 'testes')`,
      [chave, tenantId],
    );
    api.app.get(FlagService).invalidate();
  }

  async function pecaAprovada(e: EmpresaComMeta, titulo: string, texto: string, botao = 'pedir_agora'): Promise<string> {
    const [pedidoDePeca, peca] = [randomUUID(), randomUUID()];
    await ownerQuery(
      `insert into liame.ad_piece_request (id, tenant_id, brand_id, offer, dossier_version, destination, variations, status) values ($1, $2, $3, $4, 1, 'cardapio', 1, 'concluido')`,
      [pedidoDePeca, e.tenantId, e.brandId, OFERTA],
    );
    await ownerQuery(
      `insert into liame.ad_piece (id, tenant_id, brand_id, request_id, status, version, review_status, decided_by, decided_at) values ($1, $2, $3, $4, 'aprovada', 1, 'passou', $5, now())`,
      [peca, e.tenantId, e.brandId, pedidoDePeca, e.userId],
    );
    await ownerQuery(
      `insert into liame.ad_piece_version (id, tenant_id, piece_id, version, title, body, button, review, review_status, rules_version, content_hash, author)
       values ($1, $2, $3, 1, $4, $5, $6, '{}'::jsonb, 'passou', '{}'::jsonb, $7, 'criativo')`,
      [randomUUID(), e.tenantId, peca, titulo, texto, botao, randomBytes(32).toString('hex')],
    );
    return peca;
  }

  /** A empresa com a conta de anúncios e a Página, a loja com o cardápio, o ponto no endereço e o Regem que cria cupom, o dossiê e duas peças aprovadas. */
  async function cenario(nome: string, o: { ligada?: boolean } = {}): Promise<Cenario> {
    const e = await empresaComMeta(api, meta, nome);
    await ownerQuery(`update liame.connected_account set disconnected_at = now() where id = $1`, [e.contaSemToken]);
    const pagina = `10${randomBytes(6).readUIntBE(0, 6)}`;
    await ownerQuery(
      `insert into liame.connected_account (id, tenant_id, brand_id, provider, external_id, name, provider_attributes) values ($1, $2, $3, 'facebook_page', $4, 'Mister Burgers', '{}'::jsonb)`,
      [randomUUID(), e.tenantId, e.brandId, pagina],
    );
    const { unitId, contaId: regem } = await lojaComCardapio(e, 'Loja Centro', CARDAPIO);
    await ownerQuery(`update liame.connected_account set provider_attributes = provider_attributes || '{"escopos": ["cupons.criar"]}'::jsonb where id = $1`, [regem]);
    await ownerQuery(
      `update liame.unit set address_postal_code = '20040002', address_street = 'Rua da Assembleia', address_number = '10', address_district = 'Centro',
              address_city = 'Rio de Janeiro', address_state = 'RJ', ibge_city_code = '3304557', location_source = 'cep',
              latitude = -22.906847, longitude = -43.172897, location_precision = 'endereco'
        where id = $1`,
      [unitId],
    );
    const dossie = await api.call('PUT', '/v1/brand-dossier', { cookie: e.cookie, body: { brand_id: e.brandId, base_version: 0, content: DOSSIE } });
    expect(dossie.status, JSON.stringify(dossie.body)).toBe(200);
    const pecas: [string, string] = [
      await pecaAprovada(e, 'Sexta é dia de combo', 'Smash, batata e refri por R$ 34,90. Peça pelo cardápio.'),
      await pecaAprovada(e, 'Combo sexta por R$ 34,90', 'Smash na chapa, batata e refri por R$ 34,90. É só pedir pelo cardápio.', 'ver_cardapio'),
    ];
    await ligarFlagDaEmpresa(api, 'meta_write', e.tenantId, true);
    await ligarFuncao('regem_write', e.tenantId);
    if (o.ligada ?? true) await ligarFuncao('teste_de_criativo', e.tenantId);
    return { ...e, pagina, unitId, regem, pecas };
  }

  const pedir = (e: Cenario, midias: [string, string], extra: Record<string, unknown> = {}) =>
    api.call('POST', '/v1/creative-tests', {
      cookie: e.cookie,
      body: {
        brand_id: e.brandId,
        unit_id: e.unitId,
        name: 'Combo sexta: a foto ou a outra',
        arms: [
          { piece_id: e.pecas[0], media_id: midias[0], coupon_code: 'SEXTAFOTO' },
          { piece_id: e.pecas[1], media_id: midias[1], coupon_code: 'SEXTAOUTRA' },
        ],
        discount: { kind: 'percentual', percent: 10 },
        radius_km: 3,
        daily_budget_micros: 40_000_000,
        ...extra,
      },
    });
  const pedidoDe = async (id: string) =>
    (await ownerQuery<{ status: string; status_reason: string | null; plan_hash: string; tool: string; mode: string; before_state: Record<string, unknown> }>(
      `select status, status_reason, plan_hash, tool, mode, before_state from liame.action_request where id = $1`,
      [id],
    ))[0]!;
  const testeDe = async (id: string) =>
    (await ownerQuery<{ status: string; active: boolean; error: string | null; meta_campaign_id: string | null; started_on: string | null; stopped_at: Date | null; stopped_by: string | null }>(
      `select status, active, error, meta_campaign_id, started_on::text as started_on, stopped_at, stopped_by from liame.campaign_test where id = $1`,
      [id],
    ))[0]!;
  const bracosDe = (id: string) =>
    ownerQuery<{ letter: string; meta_adset_id: string | null; meta_creative_id: string | null; meta_ad_id: string | null; coupon_status: string }>(
      `select letter, meta_adset_id, meta_creative_id, meta_ad_id, coupon_status from liame.campaign_test_arm where test_id = $1 order by letter`,
      [id],
    );
  async function aprovar(e: Cenario, pedido: string): Promise<void> {
    await ownerQuery(`update liame.app_user set totp_last_step = null where id = $1`, [e.userId]);
    await ownerQuery(`delete from liame.rate_limit where key = $1`, [`segundo-fator:${e.userId}`]);
    const r = await api.call('POST', `/v1/actions/${pedido}/approve`, { cookie: e.cookie, body: { plan_hash: (await pedidoDe(pedido)).plan_hash, code: totpCode(e.secret, currentStep()) } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  }
  const executar = (e: Cenario) => executor.executeBatch(20, { tenantIds: [e.tenantId] });
  const doTeste = (id: string, aresta: string) => meta.criados.filter((c) => c.aresta === aresta && c.chave?.startsWith(`teste:${id}:`));
  const limites = async (e: Cenario, campanha: number) => {
    await ownerQuery(`update liame.app_user set totp_last_step = null where id = $1`, [e.userId]);
    const t = await api.call('PUT', '/v1/budget/limits', { cookie: e.cookie, body: { month_micros: 3_000_000_000, campaign_daily_micros: campanha } });
    expect(t.status, JSON.stringify(t.body)).toBe(200);
  };

  it('pedir: só com a função; as peças, a metade da verba, o teto, o Regem e os códigos; o texto com o cupom; um teste vivo por marca', async () => {
    const e = await cenario('Brasa Teste Pede', { ligada: false });
    const fotos: [string, string] = [(await fotoGuardada(e, armazem, { largura: 1080, altura: 1350 })).id, (await fotoGuardada(e, armazem, { largura: 1080, altura: 1080 })).id];
    const codigo = async (r: { status: number; body: Record<string, unknown> }) => [r.status, r.body.code];
    expect(await codigo(await pedir(e, fotos))).toEqual([409, 'funcao-desligada']);
    await ligarFuncao('teste_de_criativo', e.tenantId);

    // O contrato: os dois códigos iguais, os dois criativos iguais e a verba abaixo do mínimo nem chegam à regra.
    expect((await pedir(e, fotos, { arms: [{ piece_id: e.pecas[0], media_id: fotos[0], coupon_code: 'IGUAL1' }, { piece_id: e.pecas[1], media_id: fotos[1], coupon_code: 'IGUAL1' }] })).status).toBe(400);
    expect((await pedir(e, fotos, { arms: [{ piece_id: e.pecas[0], media_id: fotos[0], coupon_code: 'SEXTAFOTO' }, { piece_id: e.pecas[0], media_id: fotos[0], coupon_code: 'SEXTAOUTRA' }] })).status).toBe(400);
    expect((await pedir(e, fotos, { daily_budget_micros: 19_000_000 })).status).toBe(400);

    await ownerQuery(`update liame.ad_piece set status = 'decidir' where id = $1`, [e.pecas[1]]);
    expect(await codigo(await pedir(e, fotos))).toEqual([422, 'peca-nao-aprovada']);
    await ownerQuery(`update liame.ad_piece set status = 'aprovada' where id = $1`, [e.pecas[1]]);
    expect(await codigo(await pedir(e, [fotos[0], randomUUID()]))).toEqual([422, 'midia-fora-das-fotos']);
    // R$ 40,01 por dia: a metade não fecha em centavos.
    expect(await codigo(await pedir(e, fotos, { daily_budget_micros: 40_010_000 }))).toEqual([422, 'verba-invalida']);
    // O teto por campanha vale para a verba do teste INTEIRO.
    await limites(e, 30_000_000);
    expect(await codigo(await pedir(e, fotos))).toEqual([422, 'acima-do-teto']);
    await limites(e, 50_000_000);
    // A loja que não liberou criar cupom no Regem, e o código que já existe nela.
    await ownerQuery(`update liame.connected_account set provider_attributes = provider_attributes - 'escopos' where id = $1`, [e.regem]);
    expect(await codigo(await pedir(e, fotos))).toEqual([409, 'regem-sem-cupom']);
    await ownerQuery(`update liame.connected_account set provider_attributes = provider_attributes || '{"escopos": ["cupons.criar"]}'::jsonb where id = $1`, [e.regem]);
    await ownerQuery(
      `insert into liame.coupon (id, tenant_id, brand_id, connected_account_id, external_id, code, kind, percent, active, source_version, source_updated_at)
       values ($1, $2, $3, $4, $5, 'SEXTAOUTRA', 'percentual', 10, true, 1, now())`,
      [randomUUID(), e.tenantId, e.brandId, e.regem, randomUUID()],
    );
    expect(await codigo(await pedir(e, fotos))).toEqual([422, 'cupom-em-uso']);
    await ownerQuery(`delete from liame.coupon where connected_account_id = $1`, [e.regem]);

    const r = await pedir(e, fotos);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({ status: 'pedido', active: false, daily_budget_micros: 40_000_000, radius_km: 3, min_days: 7, max_days: 28, link: CARDAPIO, meta: { campaign_id: null } });
    expect(r.body.discount).toMatchObject({ kind: 'percentual', percent: 10, value_cents: null, min_order_cents: 0 });
    const [a, b] = r.body.arms as Array<Record<string, unknown>>;
    expect(a).toMatchObject({ letter: 'A', piece_id: e.pecas[0], coupon_code: 'SEXTAFOTO', coupon_status: 'a_criar' });
    expect(a!.ad_text).toBe('Smash, batata e refri por R$ 34,90. Peça pelo cardápio.\n\nCupom SEXTAFOTO: 10% de desconto.');
    expect(b).toMatchObject({ letter: 'B', piece_id: e.pecas[1], coupon_code: 'SEXTAOUTRA' });
    expect(b!.ad_text).toBe('Smash na chapa, batata e refri por R$ 34,90. É só pedir pelo cardápio.\n\nCupom SEXTAOUTRA: 10% de desconto.');
    const pedido = await pedidoDe(r.body.action_id as string);
    expect(pedido).toMatchObject({ status: 'aguardando_aprovacao', tool: 'teste_de_criativo_criar' });
    expect(pedido.before_state).toMatchObject({ nome: 'Combo sexta: a foto ou a outra', objetivo: 'cardapio', verba_diaria_micros: 40_000_000, raio_km: 3, situacao: 'pedido', ativa: false, pagina: { id: e.pagina } });
    // Nada vai à Meta antes da aprovação, e a marca só tem um teste vivo por vez.
    expect(doTeste(r.body.id as string, 'campaigns')).toEqual([]);
    expect(await codigo(await pedir(e, fotos))).toEqual([409, 'teste-em-andamento']);
    // Recusado em Aprovações, a marca fica livre para outro teste.
    await ownerQuery(`update liame.action_request set status = 'cancelada' where id = $1`, [r.body.action_id]);
    expect((await pedir(e, fotos)).status).toBe(201);
    expect((await api.call('GET', `/v1/creative-tests/${r.body.id}`, { cookie: e.cookie })).body.status).toBe('cancelado');
  }, 120_000);

  it('criar, ativar e encerrar: uma campanha com dois conjuntos de metade da verba, tudo pausado; ativar com o código; encerrar sem ele', async () => {
    const e = await cenario('Brasa Teste Cria');
    const fotos: [string, string] = [(await fotoGuardada(e, armazem, { largura: 1080, altura: 1350 })).id, (await fotoGuardada(e, armazem, { largura: 1080, altura: 1080 })).id];
    await limites(e, 50_000_000);
    const r = await pedir(e, fotos);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const id = r.body.id as string;
    await aprovar(e, r.body.action_id as string);
    await executar(e);
    expect((await pedidoDe(r.body.action_id as string)).status).toBe('executada');

    // Na Meta: uma campanha, e para cada criativo o conjunto, o criativo e o anúncio, com a chave de idempotência do passo.
    const [campanha] = doTeste(id, 'campaigns');
    expect(campanha).toMatchObject({ chave: `teste:${id}:campanha`, params: { name: 'Teste · Combo sexta: a foto ou a outra', status: 'PAUSED' } });
    // A verba mora em cada CONJUNTO, e não na campanha: com orçamento na campanha, a Meta deslocaria a verba para o
    // conjunto que ela preferisse, e o teste deixaria de ser meio a meio.
    expect(campanha!.params.daily_budget).toBeUndefined();
    expect(campanha!.params.lifetime_budget).toBeUndefined();
    expect(campanha!.params.is_adset_budget_sharing_enabled).toBe('false');
    const conjuntos = doTeste(id, 'adsets');
    expect(conjuntos.map((c) => [c.chave, c.params.daily_budget, c.params.campaign_id, c.params.status])).toEqual([
      [`teste:${id}:conjunto:A`, '2000', campanha!.id, 'PAUSED'],
      [`teste:${id}:conjunto:B`, '2000', campanha!.id, 'PAUSED'],
    ]);
    // O mesmo público nos dois: só o criativo muda.
    expect(conjuntos[0]!.params.targeting).toBe(conjuntos[1]!.params.targeting);
    const criativos = doTeste(id, 'adcreatives');
    expect(criativos.map((c) => c.chave)).toEqual([`teste:${id}:criativo:A`, `teste:${id}:criativo:B`]);
    expect(criativos[0]!.params.object_story_spec).toContain('Cupom SEXTAFOTO: 10% de desconto.');
    expect(criativos[1]!.params.object_story_spec).toContain('Cupom SEXTAOUTRA: 10% de desconto.');
    const anuncios = doTeste(id, 'ads');
    expect(anuncios.map((c) => [c.chave, c.params.adset_id, c.params.status])).toEqual([
      [`teste:${id}:anuncio:A`, conjuntos[0]!.id, 'PAUSED'],
      [`teste:${id}:anuncio:B`, conjuntos[1]!.id, 'PAUSED'],
    ]);
    // O teste fica `criando` (faltam os cupons, que são do Regem), com o que existe na Meta guardado.
    expect(await testeDe(id)).toMatchObject({ status: 'criando', active: false, meta_campaign_id: campanha!.id, error: null });
    expect((await bracosDe(id)).map((b) => [b.letter, b.meta_adset_id, b.meta_ad_id])).toEqual([
      ['A', conjuntos[0]!.id, anuncios[0]!.id],
      ['B', conjuntos[1]!.id, anuncios[1]!.id],
    ]);

    // Ativar só com o teste pronto: a campanha de teste e os DOIS cupons.
    expect((await api.call('POST', `/v1/creative-tests/${id}/activate`, { cookie: e.cookie })).body.code).toBe('teste-nao-esta-pronto');
    // Os cupons criados (a rotina dos testes, que vem depois): o teste fica pronto.
    await ownerQuery(`update liame.campaign_test_arm set coupon_status = 'criado' where test_id = $1`, [id]);
    await ownerQuery(`update liame.campaign_test set status = 'pronto' where id = $1`, [id]);
    // O teto por campanha de agora vale para a verba do teste inteiro: baixado depois do pedido de criar, segura o ativar.
    await limites(e, 30_000_000);
    expect((await api.call('POST', `/v1/creative-tests/${id}/activate`, { cookie: e.cookie })).body.code).toBe('acima-do-teto');
    await limites(e, 50_000_000);
    const pedido = await api.call('POST', `/v1/creative-tests/${id}/activate`, { cookie: e.cookie });
    expect(pedido.status, JSON.stringify(pedido.body)).toBe(201);
    const ativacao = pedido.body.pending_action_id as string;
    expect(await pedidoDe(ativacao)).toMatchObject({ status: 'aguardando_aprovacao', tool: 'teste_de_criativo_ativar' });
    expect((await api.call('POST', `/v1/creative-tests/${id}/activate`, { cookie: e.cookie })).body.code).toBe('ja-pedido');
    await aprovar(e, ativacao);
    const antes = meta.chamadas.length;
    await executar(e);
    expect((await pedidoDe(ativacao)).status).toBe('executada');
    const ids = [anuncios[0]!.id, anuncios[1]!.id, conjuntos[0]!.id, conjuntos[1]!.id, campanha!.id];
    expect(ids.map((i) => meta.objetos.get(i)?.status)).toEqual(['ACTIVE', 'ACTIVE', 'ACTIVE', 'ACTIVE', 'ACTIVE']);
    // Lê os cinco, valida os cinco e escreve: os anúncios primeiro e a campanha por último.
    const feitas = meta.chamadas.slice(antes).map((c) => `${c.metodo === 'GET' ? 'ler' : c.validar ? 'validar' : 'escrever'}:${ids.indexOf(c.id)}`);
    expect(feitas).toEqual([0, 1, 2, 3, 4].map((i) => `ler:${i}`).concat([0, 1, 2, 3, 4].map((i) => `validar:${i}`), [0, 1, 2, 3, 4].map((i) => `escrever:${i}`)));
    const rodando = await testeDe(id);
    expect(rodando).toMatchObject({ status: 'rodando', active: true });
    // O primeiro dia inteiro é o dia seguinte, no fuso da loja.
    const amanha = new Date(Date.now() + 24 * 3_600_000);
    expect(rodando.started_on).toBe(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(amanha));

    // Encerrar: sem o código do app. A campanha de teste pausa (os filhos herdam) e o teste fica encerrado.
    const fim = await api.call('POST', `/v1/creative-tests/${id}/stop`, { cookie: e.cookie });
    expect(fim.status, JSON.stringify(fim.body)).toBe(201);
    const pausa = (await ownerQuery<{ id: string; status: string; mode: string }>(`select id, status, mode from liame.action_request where tool = 'teste_de_criativo_pausar' and resource_id = $1`, [`teste_de_criativo:${id}`]))[0]!;
    expect(pausa.status).toBe('aprovada');
    const antesDaPausa = meta.chamadas.length;
    await executar(e);
    expect((await pedidoDe(pausa.id)).status).toBe('executada');
    expect(meta.objetos.get(campanha!.id)?.status).toBe('PAUSED');
    // Pausar mexe só na campanha (ler, validar e escrever): ela para tudo de uma vez, e os conjuntos e os anúncios herdam.
    expect(meta.chamadas.slice(antesDaPausa).map((c) => `${c.metodo === 'GET' ? 'ler' : c.validar ? 'validar' : 'escrever'}:${c.id === campanha!.id ? 'campanha' : 'outro'}`)).toEqual([
      'ler:campanha',
      'validar:campanha',
      'escrever:campanha',
    ]);
    const encerrado = await testeDe(id);
    expect(encerrado).toMatchObject({ status: 'encerrado', active: false, stopped_by: e.userId });
    expect(encerrado.stopped_at).not.toBeNull();
    // Encerrar de novo devolve como está.
    expect((await api.call('POST', `/v1/creative-tests/${id}/stop`, { cookie: e.cookie })).body.status).toBe('encerrado');
  }, 180_000);
});
