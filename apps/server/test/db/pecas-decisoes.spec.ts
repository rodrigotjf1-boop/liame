import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { AdPieceListResponse, AdPieceRequestListResponse, AdPieceResponse, AdPieceWaitingResponse, ApproveAdPiecesResponse, SummaryResponse } from '@liame/contracts';
import { type Database, runMigrations } from '@liame/database';
import { MockLanguageModelV4 } from 'ai/test';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TAREFA_CRIATIVO_TEXTO } from '../../src/ai/criativo/prompt.js';
import { AiGateway } from '../../src/ai/gateway.js';
import { ModelosIa } from '../../src/ai/modelos.js';
import { APP_CONFIG } from '../../src/config.js';
import { DATABASE } from '../../src/database/database.module.js';
import { FlagService } from '../../src/flags/flag.service.js';
import { ResultsService } from '../../src/results/results.service.js';
import { CriativoLoop } from '../../src/worker/criativo-loop.js';
import { CriativoService } from '../../src/worker/criativo.service.js';
import { enableMfa, ownerQuery, PASSWORD, resetIpRateLimits, signupAndLogin, startApi, TERMOS, type TestApi, tokenFrom, uniqueEmail } from '../helpers/api.js';
import { ligarCriativo, ligarIa, ModelosDeTeste, responde, rotaCompartilhada, uso } from '../helpers/ia.js';
import { hasDb, OWNER_URL } from './env.js';

// As decisões sobre uma peça do Criativo (A4, X6): editar (versão nova, conferida de novo; o que seria barrado não é
// salvo), aprovar (sem o código do app; a barrada e a de oferta que mudou não passam), uma peça ou várias de uma vez
// ("as que passaram"), recusar com o motivo, pedir outra (o Criativo refaz, e a versão nova entra na mesma peça) e
// contestar a conferência (guarda o motivo e não destrava). Com o modelo simulado. E o que espera a pessoa (X8): o
// número do menu (`/v1/ad-pieces/waiting`) e a conta das peças dentro do Resumo.

const OFERTA = 'Combo sexta: smash, batata e refri por R$ 34,90';
const DOSSIE = {
  identity: { summary: 'Hamburgueria de bairro com smash feito na chapa', audience: 'Quem mora ou trabalha no Centro', differentiator: 'Pão feito na casa todo dia', since: '2019' },
  voice: { traits: ['Direta'], rules: ['Frases curtas.'], do_example: 'Bateu a fome? O smash sai da chapa rapidinho.', dont_example: '' },
  products: { items: ['Smash Clássico R$ 29,90'] },
  offers: { items: [OFERTA] },
  forbidden: { items: [{ text: 'gourmet', why: 'não combina com a casa' }] },
  region: { area: 'Centro e Lapa', pickup: true },
};
const BOA = { titulo: 'Sexta é dia de combo', texto: 'Smash, batata e refri por R$ 34,90. Peça pelo cardápio e retire no balcão.', botao: 'pedir_agora' };
const OUTRA = { titulo: 'Combo sexta por R$ 34,90', texto: 'Smash na chapa, batata e refri por R$ 34,90. É só pedir pelo cardápio.', botao: 'ver_cardapio' };
const BARRADA = { titulo: 'Combo gourmet por R$ 29,90', texto: 'Smash, batata e refri. Peça pelo cardápio.', botao: 'pedir_agora' };
/** O título passa do tamanho que a Meta recomenda (27): é só aviso, e dá para aprovar. */
const COM_AVISO = { titulo: 'Combo de sexta com smash, batata e refri', texto: 'O combo completo por R$ 34,90. Peça agora pelo cardápio.', botao: 'pedir_agora' };
const ACOES = ['approve', 'reject', 'redo', 'contest'] as const;
/** O corpo mínimo de cada ação (os contratos são estritos: campo a mais é 400 antes de qualquer regra). */
const CORPO: Record<(typeof ACOES)[number], Record<string, unknown>> = { approve: {}, reject: { reason: 'outro' }, redo: {}, contest: { comment: 'Não concordo com a conferência.' } };

describe.skipIf(!hasDb)('Peças do Criativo: editar, aprovar, recusar, pedir outra e contestar (A4, X6)', () => {
  let api: TestApi;
  let database: Database;
  let flags: FlagService;
  let modelos: ModelosDeTeste;
  let alvo: { provider: string; model: string };
  let loop: CriativoLoop;

  type Dono = { cookie: string; tenantId: string; userId: string; brandId: string };
  type Peca = ReturnType<typeof AdPieceResponse.parse>;

  async function dono(opcoes: { criativo?: boolean } = {}): Promise<Dono> {
    await resetIpRateLimits();
    const s = await signupAndLogin(api, undefined, 'Hamburgueria das Decisões');
    await enableMfa(api, s.cookie);
    const tenantId = s.me.active_organization_id as string;
    const brandId = (await api.call('GET', '/v1/brands', { cookie: s.cookie })).body.items[0].id as string;
    await ligarIa(flags, tenantId);
    if (opcoes.criativo !== false) await ligarCriativo(flags, tenantId);
    const d = { cookie: s.cookie, tenantId, userId: s.me.user.id as string, brandId };
    await salvarDossie(d, 0, DOSSIE);
    return d;
  }

  async function salvarDossie(d: Dono, base: number, content: Record<string, unknown>): Promise<void> {
    const salvo = await api.call('PUT', '/v1/brand-dossier', { cookie: d.cookie, body: { brand_id: d.brandId, base_version: base, content } });
    if (salvo.status !== 200) throw new Error(`dossiê não salvo: ${salvo.status} ${JSON.stringify(salvo.body)}`);
  }

  async function membro(d: Dono, role: string): Promise<{ cookie: string }> {
    const email = uniqueEmail(role);
    const body: Record<string, unknown> = { email, role };
    if (['administrador', 'gestor', 'aprovador'].includes(role)) body.approve_limit_micros = 1_000_000;
    expect((await api.call('POST', '/v1/invitations', { cookie: d.cookie, body })).status).toBe(201);
    const s = await api.call('POST', '/v1/invitations/signup', { body: { token: tokenFrom(api.mailer, email), name: `Pessoa ${role}`, password: PASSWORD, terms_version: TERMOS } });
    if (!s.cookie) throw new Error(`convite não aceito: ${s.status} ${JSON.stringify(s.body)}`);
    await enableMfa(api, s.cookie);
    return { cookie: s.cookie };
  }

  const responder = (...pecas: Array<Record<string, unknown>>) => {
    const mock = responde(JSON.stringify({ recusa: null, pecas }), uso(2000, 300));
    modelos.porChave.set(`${alvo.provider}/${alvo.model}`, mock);
    return mock;
  };
  const rodarFila = (d: Dono) => loop.executarLote(10, { tenantIds: [d.tenantId] });
  const lista = async (d: Dono, status?: string) =>
    AdPieceListResponse.parse((await api.call('GET', `/v1/ad-pieces?brand_id=${d.brandId}${status ? `&status=${status}` : ''}`, { cookie: d.cookie })).body).items;
  const pedidos = async (d: Dono) => AdPieceRequestListResponse.parse((await api.call('GET', `/v1/ad-pieces/requests?brand_id=${d.brandId}`, { cookie: d.cookie })).body).items;
  const ler = async (d: Dono, id: string) => AdPieceResponse.parse((await api.call('GET', `/v1/ad-pieces/${id}`, { cookie: d.cookie })).body);
  const editar = (d: Dono, p: Peca, texto: { title?: string; body?: string; button?: string }, extra: Record<string, unknown> = {}, cookie = d.cookie) =>
    api.call('PUT', `/v1/ad-pieces/${p.id}`, { cookie, body: { base_version: p.current.version, title: p.current.title, body: p.current.body, button: p.current.button, ...texto, ...extra } });
  const decidir = (d: Dono, p: Peca, acao: 'approve' | 'reject' | 'redo' | 'contest', body: Record<string, unknown> = {}, cookie = d.cookie) =>
    api.call('POST', `/v1/ad-pieces/${p.id}/${acao}`, { cookie, body: { content_hash: p.current.content_hash, ...body } });
  const mensagens = (r: { body: { errors?: Array<{ path: string; message: string }> } }) => (r.body.errors ?? []).map((e) => `${e.path}: ${e.message}`);
  const item = (p: Peca, hash = p.current.content_hash) => ({ id: p.id, content_hash: hash });
  const aprovarVarias = (d: Dono, items: Array<{ id: string; content_hash: string }>, cookie = d.cookie) =>
    api.call('POST', '/v1/ad-pieces/approve', { cookie, body: { brand_id: d.brandId, items } });
  const variasAprovadas = async (d: Dono, items: Array<{ id: string; content_hash: string }>, cookie = d.cookie) => {
    const r = await aprovarVarias(d, items, cookie);
    if (r.status !== 200) throw new Error(`aprovar várias: ${r.status} ${JSON.stringify(r.body)}`);
    return ApproveAdPiecesResponse.parse(r.body);
  };

  /** Uma empresa com as peças que o Criativo (o modelo simulado) escreveu, esperando decisão. */
  async function comPecas(...pecas: Array<Record<string, unknown>>): Promise<{ d: Dono; pecas: Peca[] }> {
    const d = await dono();
    const r = await api.call('POST', '/v1/ad-pieces/requests', { cookie: d.cookie, body: { brand_id: d.brandId, offer: OFERTA, destination: 'cardapio', variations: pecas.length, instruction: 'fale da retirada no balcão' } });
    if (r.status !== 202) throw new Error(`pedido não aceito: ${r.status} ${JSON.stringify(r.body)}`);
    responder(...pecas);
    expect((await rodarFila(d))[0]).toMatchObject({ status: 'concluido' });
    const feitas = await lista(d);
    return { d, pecas: pecas.map((x) => feitas.find((f) => f.current.title === x.titulo)!) };
  }

  beforeAll(async () => {
    await runMigrations({ connectionString: OWNER_URL, dir: resolve(process.cwd(), '../../packages/database/migrations') });
    api = await startApi();
    database = api.app.get(DATABASE);
    flags = api.app.get(FlagService);
    modelos = new ModelosDeTeste(api.app.get(APP_CONFIG));
    api.app.get(ModelosIa).modelo = (provider, model) => modelos.modelo(provider, model);
    loop = new CriativoLoop(database, flags, new CriativoService(database, api.app.get(AiGateway), api.app.get(ResultsService)));
    // A rota desta tarefa é dividida com `pecas.spec.ts`: nome fixo, ninguém apaga (V76).
    alvo = await rotaCompartilhada(modelos, TAREFA_CRIATIVO_TEXTO, new MockLanguageModelV4({ doGenerate: [] }));
  }, 120_000);
  beforeEach(resetIpRateLimits);
  afterAll(async () => {
    await api?.close();
  });

  it('editar: nasce a versão da pessoa, conferida de novo; o texto que seria barrado não é salvo', async () => {
    const { d, pecas } = await comPecas(BOA, BARRADA);
    const [boa, barrada] = pecas as [Peca, Peca];

    // O texto com outro preço ou com o que a marca não diz não é salvo, e a tela recebe o que mudar em cada campo.
    const outroPreco = await editar(d, boa, { title: 'Combo sexta por R$ 29,90' });
    expect(outroPreco.body).toMatchObject({ status: 422, code: 'texto-barrado' });
    expect(mensagens(outroPreco)).toEqual(['title: O texto traz um valor que não é o da oferta ("29,90"). O preço da peça é o da oferta de Minha marca.']);
    expect(mensagens(await editar(d, boa, { body: 'O combo gourmet da casa por R$ 34,90. Ligue (21) 99999-0000.' }))).toEqual([
      'body: Dado pessoal no texto (telefone, e-mail ou documento).',
      'body: Diz o que a marca não diz ("gourmet").',
    ]);
    expect((await ler(d, boa.id)).versions).toHaveLength(1);

    // O texto que passa vira a versão 2, da pessoa. O número que ela escreve não passa pela regra dos números do modelo.
    const r = await editar(d, boa, { title: 'Sexta tem combo', body: 'Smash, batata e refri por R$ 34,90. Sai em 15 minutos. Peça pelo cardápio.' });
    expect(r.status).toBe(200);
    const editada = AdPieceResponse.parse(r.body);
    expect(editada).toMatchObject({ status: 'decidir', ai_generated: true, redoing: false });
    expect(editada.current).toMatchObject({ version: 2, title: 'Sexta tem combo', author: 'pessoa', created_by: { id: d.userId } });
    expect(editada.current.review.status).toBe('passou');
    expect(editada.current.content_hash).not.toBe(boa.current.content_hash);
    expect(editada.versions!.map((v) => [v.version, v.author])).toEqual([
      [2, 'pessoa'],
      [1, 'criativo'],
    ]);
    // Quem estava com a versão antiga na tela não sobrescreve a nova; e salvar sem mudar nada não cria versão.
    expect((await editar(d, boa, { title: 'Outro título' })).body).toMatchObject({ status: 409, code: 'peca-mudou' });
    expect((await editar(d, editada, {})).status).toBe(200);
    expect((await ler(d, boa.id)).versions).toHaveLength(2);

    // A barrada deixa de ser barrada quando a pessoa conserta o texto.
    expect(barrada.current.review.status).toBe('barrou');
    const consertada = AdPieceResponse.parse((await editar(d, barrada, { title: 'Combo sexta por R$ 34,90' })).body);
    expect(consertada.current.review.status).toBe('passou');
    expect((await lista(d)).find((x) => x.id === barrada.id)!.current.version).toBe(2);
    expect(await ownerQuery(`select action from liame.audit_event where tenant_id = $1 and action = 'peca.editar'`, [d.tenantId])).toHaveLength(3);
  });

  it('aprovar: vale para o hash visto, não pede o código do app, e a barrada não passa', async () => {
    const { d, pecas } = await comPecas(BOA, BARRADA);
    const [boa, barrada] = pecas as [Peca, Peca];

    expect((await decidir(d, boa, 'approve', { content_hash: 'a'.repeat(64) })).body).toMatchObject({ status: 409, code: 'peca-mudou' });
    const barrou = await decidir(d, barrada, 'approve');
    expect(barrou.body).toMatchObject({ status: 409, code: 'peca-barrada' });
    expect(mensagens(barrou)).toEqual([
      'title: O texto traz um valor que não é o da oferta ("29,90"). O preço da peça é o da oferta de Minha marca.',
      'title: Diz o que a marca não diz ("gourmet").',
    ]);

    const r = await decidir(d, boa, 'approve');
    expect(r.status).toBe(200);
    const aprovada = AdPieceResponse.parse(r.body);
    expect(aprovada).toMatchObject({ status: 'aprovada', decided_by: { id: d.userId } });
    expect(aprovada.decided_at).not.toBeNull();
    expect(aprovada.decisions).toEqual([expect.objectContaining({ decision: 'aprovada', version: 1, reason: null, comment: null, decided_by: expect.objectContaining({ id: d.userId }) })]);
    // A biblioteca tem a aprovada; decidir de novo, editar ou pedir outra não vale mais.
    expect((await lista(d, 'aprovada')).map((x) => x.id)).toEqual([boa.id]);
    expect((await lista(d, 'decidir')).map((x) => x.id)).toEqual([barrada.id]);
    for (const acao of ACOES) expect((await decidir(d, boa, acao, CORPO[acao])).body).toMatchObject({ status: 409, code: 'peca-decidida' });
    expect((await editar(d, boa, { title: 'Outro' })).body).toMatchObject({ status: 409, code: 'peca-decidida' });
    expect(await ownerQuery(`select action, after from liame.audit_event where tenant_id = $1 and action = 'peca.aprovar'`, [d.tenantId])).toEqual([
      { action: 'peca.aprovar', after: { status: 'aprovada', version: 1, review_status: 'passou' } },
    ]);
  });

  it('aprovar confere de novo com Minha marca de agora: a regra nova barra, e a oferta que mudou pede outra peça', async () => {
    const { d, pecas } = await comPecas(BOA, OUTRA);
    const [boa, outra] = pecas as [Peca, Peca];

    // A marca passa a não dizer "balcão": a peça que passou na conferência de ontem não é aprovada hoje.
    await salvarDossie(d, 1, { ...DOSSIE, forbidden: { items: [...DOSSIE.forbidden.items, { text: 'balcão', why: 'a retirada mudou de lugar' }] } });
    const barrou = await decidir(d, boa, 'approve');
    expect(barrou.body).toMatchObject({ status: 409, code: 'peca-barrada' });
    expect(mensagens(barrou)).toEqual(['body: Diz o que a marca não diz ("balcao").']);
    expect((await decidir(d, outra, 'approve')).status).toBe(200);

    // A oferta mudou de preço em Minha marca: a peça da oferta antiga não é aprovada nem editada; recusar continua valendo.
    await salvarDossie(d, 2, { ...DOSSIE, offers: { items: ['Combo sexta: smash, batata e refri por R$ 36,90'] } });
    expect((await decidir(d, boa, 'approve')).body).toMatchObject({ status: 409, code: 'oferta-mudou' });
    expect((await editar(d, boa, { title: 'Sexta tem combo' })).body).toMatchObject({ status: 409, code: 'oferta-mudou' });
    expect((await decidir(d, boa, 'redo')).body).toMatchObject({ status: 409, code: 'oferta-mudou' });
    expect((await decidir(d, boa, 'reject', { reason: 'nao_preciso_mais' })).status).toBe(200);
  });

  it('aprovar várias de uma vez: as que passaram entram (a de aviso junto), e a que não pode fica como está, com o motivo', async () => {
    const { d, pecas } = await comPecas(BOA, OUTRA, COM_AVISO, BARRADA);
    const [boa, outra, comAviso, barrada] = pecas as [Peca, Peca, Peca, Peca];
    expect(comAviso.current.review.status).toBe('aviso');

    // O contrato: de 1 a 20 peças, sem repetir a mesma.
    expect((await aprovarVarias(d, [])).status).toBe(400);
    expect((await aprovarVarias(d, [item(boa), item(boa)])).status).toBe(400);
    expect((await aprovarVarias(d, Array.from({ length: 21 }, () => ({ id: randomUUID(), content_hash: 'a'.repeat(64) })))).status).toBe(400);

    // A boa e a de aviso entram. A que a pessoa viu em outra versão, a barrada e a que não existe ficam de fora, cada
    // uma com o motivo, e não seguram as outras.
    const desconhecida = randomUUID();
    const resposta = await variasAprovadas(d, [item(boa), item(outra, 'a'.repeat(64)), item(comAviso), item(barrada), { id: desconhecida, content_hash: 'b'.repeat(64) }]);
    expect(resposta.approved).toBe(2);
    expect(resposta.items.map((i) => [i.id, i.approved, i.reason, i.piece?.status ?? null])).toEqual([
      [boa.id, true, null, 'aprovada'],
      [outra.id, false, 'peca_mudou', 'decidir'],
      [comAviso.id, true, null, 'aprovada'],
      [barrada.id, false, 'peca_barrada', 'decidir'],
      [desconhecida, false, 'nao_encontrada', null],
    ]);
    expect(resposta.items[0]!.piece).toMatchObject({ decided_by: { id: d.userId }, current: { version: 1, content_hash: boa.current.content_hash } });
    expect(resposta.items[0]!.piece!.decided_at).not.toBeNull();
    expect((await lista(d, 'aprovada')).map((x) => x.id).sort()).toEqual([boa.id, comAviso.id].sort());
    expect((await lista(d, 'decidir')).map((x) => x.id).sort()).toEqual([outra.id, barrada.id].sort());

    // Cada peça aprovada tem a decisão dela, de quem aprovou, para a versão e o hash vistos; o detalhe mostra a decisão.
    const decisoes = await ownerQuery<{ piece_id: string; version: number; content_hash: string; decision: string; decided_by: string }>(
      `select piece_id, version, content_hash, decision, decided_by from liame.ad_piece_decision where tenant_id = $1`,
      [d.tenantId],
    );
    expect(decisoes).toHaveLength(2);
    for (const p of [boa, comAviso]) expect(decisoes).toContainEqual({ piece_id: p.id, version: 1, content_hash: p.current.content_hash, decision: 'aprovada', decided_by: d.userId });
    expect((await ler(d, comAviso.id)).decisions).toEqual([expect.objectContaining({ decision: 'aprovada', version: 1, decided_by: expect.objectContaining({ id: d.userId }) })]);

    // Um evento de auditoria para o pedido inteiro, com o que entrou e o que ficou de fora.
    expect(await ownerQuery(`select resource_id, after from liame.audit_event where tenant_id = $1 and action = 'peca.aprovar_varias'`, [d.tenantId])).toEqual([
      {
        resource_id: null,
        after: {
          brand_id: d.brandId,
          aprovadas: [
            { id: boa.id, version: 1, review_status: 'passou' },
            { id: comAviso.id, version: 1, review_status: 'aviso' },
          ],
          nao_aprovadas: [
            { id: outra.id, motivo: 'peca_mudou' },
            { id: barrada.id, motivo: 'peca_barrada' },
            { id: desconhecida, motivo: 'nao_encontrada' },
          ],
        },
      },
    ]);

    // De novo: a que já foi aprovada volta como decidida, e a outra entra agora, com o hash certo.
    const deNovo = await variasAprovadas(d, [item(boa), item(outra)]);
    expect(deNovo.approved).toBe(1);
    expect(deNovo.items.map((i) => [i.approved, i.reason, i.piece?.status])).toEqual([
      [false, 'peca_decidida', 'aprovada'],
      [true, null, 'aprovada'],
    ]);
  });

  it('aprovar várias: a peça sendo refeita e a de oferta que mudou não entram; outra marca e outra empresa não acham a peça; só quem opera campanhas', async () => {
    const { d, pecas } = await comPecas(BOA, OUTRA, COM_AVISO);
    const [boa, outra, comAviso] = pecas as [Peca, Peca, Peca];

    // Quem não opera campanhas não aprova; a peça de outra marca, ou de outra empresa, não é encontrada, e nada muda.
    for (const papel of ['somente_leitura', 'aprovador']) expect((await aprovarVarias(d, [item(boa)], (await membro(d, papel)).cookie)).status).toBe(403);
    expect(await variasAprovadas({ ...d, brandId: randomUUID() }, [item(boa)])).toMatchObject({ approved: 0, items: [{ approved: false, reason: 'nao_encontrada', piece: null }] });
    const estranho = await dono();
    expect(await variasAprovadas(estranho, [item(boa)])).toMatchObject({ approved: 0, items: [{ approved: false, reason: 'nao_encontrada', piece: null }] });
    expect(await lista(d, 'aprovada')).toHaveLength(0);

    // O Criativo está refazendo a boa: ela espera a versão nova. A outra entra, pelo gestor.
    expect((await decidir(d, boa, 'redo')).status).toBe(202);
    const gestor = await membro(d, 'gestor');
    const comRefazendo = await variasAprovadas(d, [item(boa), item(outra)], gestor.cookie);
    expect(comRefazendo.items.map((i) => [i.approved, i.reason, i.piece?.redoing])).toEqual([
      [false, 'peca_refazendo', true],
      [true, null, false],
    ]);

    // A oferta mudou de preço em Minha marca: a peça da oferta antiga não entra (o preço dela pode não valer mais).
    await salvarDossie(d, 1, { ...DOSSIE, offers: { items: ['Combo sexta: smash, batata e refri por R$ 36,90'] } });
    expect(await variasAprovadas(d, [item(comAviso)])).toMatchObject({ approved: 0, items: [{ approved: false, reason: 'oferta_mudou', piece: { status: 'decidir' } }] });
    expect((await lista(d, 'aprovada')).map((x) => x.id)).toEqual([outra.id]);
  });

  it('aprovar várias, V37: quatro pedidos juntos aprovam cada peça uma vez; vale com a IA desligada e para com o Criativo desligado', async () => {
    const { d, pecas } = await comPecas(BOA, OUTRA, COM_AVISO);
    const [boa, outra, comAviso] = pecas as [Peca, Peca, Peca];

    // Os pedidos trazem as peças em ordens diferentes: as travas saem sempre na mesma ordem, e nenhum pedido trava o outro.
    const juntas = await Promise.all([aprovarVarias(d, [item(boa), item(outra)]), aprovarVarias(d, [item(outra), item(boa)]), aprovarVarias(d, [item(boa), item(outra)]), aprovarVarias(d, [item(outra), item(boa)])]);
    expect(juntas.map((r) => r.status)).toEqual([200, 200, 200, 200]);
    expect(juntas.reduce((n, r) => n + ApproveAdPiecesResponse.parse(r.body).approved, 0)).toBe(2);
    expect(await ownerQuery(`select count(*)::int as n from liame.ad_piece_decision where tenant_id = $1 and decision = 'aprovada'`, [d.tenantId])).toEqual([{ n: 2 }]);

    // A IA desligada depois de as peças existirem (D-A4-32): aprovar não depende dela.
    await ownerQuery(`delete from liame.feature_flag_rule where flag_key = 'ia' and scope_type = 'tenant' and scope_id = $1`, [d.tenantId]);
    flags.invalidate();
    expect((await variasAprovadas(d, [item(comAviso)])).approved).toBe(1);

    // A flag do Criativo desligada: as decisões param.
    await ownerQuery(`delete from liame.feature_flag_rule where flag_key = 'criativo' and scope_type = 'tenant' and scope_id = $1`, [d.tenantId]);
    flags.invalidate();
    expect((await aprovarVarias(d, [item(comAviso)])).body).toMatchObject({ status: 409, code: 'criativo-desligado' });
  });

  it('recusar: com o motivo, e o comentário fica guardado sem dado pessoal', async () => {
    const { d, pecas } = await comPecas(BOA);
    const [boa] = pecas as [Peca];
    expect((await decidir(d, boa, 'reject', { reason: 'porque sim' })).status).toBe(400);
    const r = await decidir(d, boa, 'reject', { reason: 'nao_parece_a_marca', comment: 'Muito formal. Fale com a Ana: ana@exemplo.com.br' });
    expect(r.status).toBe(200);
    const recusada = AdPieceResponse.parse(r.body);
    expect(recusada).toMatchObject({ status: 'recusada', decided_by: { id: d.userId } });
    expect(recusada.decisions).toEqual([expect.objectContaining({ decision: 'recusada', version: 1, reason: 'nao_parece_a_marca', comment: 'Muito formal. Fale com a Ana: [email]' })]);
    expect(JSON.stringify(await ownerQuery(`select comment from liame.ad_piece_decision where piece_id = $1`, [boa.id]))).not.toContain('exemplo.com.br');
    expect((await lista(d, 'recusada')).map((x) => x.id)).toEqual([boa.id]);
  });

  it('pedir outra: o Criativo refaz, e a versão nova entra na mesma peça; a igual à anterior não conta', async () => {
    const { d, pecas } = await comPecas(BOA);
    const [boa] = pecas as [Peca];

    const instrucaoRuim = await decidir(d, boa, 'redo', { instruction: 'coloque por R$ 29,90' });
    expect(instrucaoRuim.body).toMatchObject({ status: 422, code: 'pedido-recusado' });
    expect(mensagens(instrucaoRuim)[0]).toMatch(/^instruction: A instrução traz um valor que a oferta não tem/);

    const r = await decidir(d, boa, 'redo', { instruction: 'deixe o texto mais curto' });
    expect(r.status).toBe(202);
    expect(AdPieceResponse.parse(r.body)).toMatchObject({ status: 'decidir', redoing: true, current: { version: 1 } });
    // Enquanto o Criativo refaz: um pedido só, e editar, aprovar e contestar esperam. Recusar continua valendo.
    expect((await decidir(d, boa, 'redo')).body).toMatchObject({ status: 409, code: 'peca-refazendo' });
    expect((await decidir(d, boa, 'approve')).body).toMatchObject({ status: 409, code: 'peca-refazendo' });
    expect((await editar(d, boa, { title: 'Sexta tem combo' })).body).toMatchObject({ status: 409, code: 'peca-refazendo' });
    // O "pedir outra" não ocupa a vez do pedido de peças novas da marca.
    const o = (await api.call('GET', `/v1/ad-pieces/options?brand_id=${d.brandId}`, { cookie: d.cookie })).body;
    expect(o).toMatchObject({ available: true, in_progress: null });

    const mock = responder(OUTRA);
    expect((await rodarFila(d))[0]).toMatchObject({ status: 'concluido' });
    // O Criativo recebeu a versão anterior entre marcas e a instrução nova.
    const mensagem = JSON.stringify(mock.doGenerateCalls[0]!.prompt.filter((m) => m.role === 'user'));
    expect(mensagem).toContain('Refaça a peça');
    expect(mensagem).toContain('<<<VERSÃO ANTERIOR DA PEÇA');
    expect(mensagem).toContain(`Título: ${BOA.titulo}`);
    expect(mensagem).toContain('deixe o texto mais curto');
    const refeita = await ler(d, boa.id);
    expect(refeita).toMatchObject({ status: 'decidir', redoing: false });
    expect(refeita.current).toMatchObject({ version: 2, title: OUTRA.titulo, author: 'criativo', created_by: null });
    expect(refeita.versions!.map((v) => v.version)).toEqual([2, 1]);
    expect((await lista(d)).map((x) => x.id)).toEqual([boa.id]);
    const [redo, original] = await pedidos(d);
    expect(redo).toMatchObject({ piece_id: boa.id, status: 'concluido', pieces: 1, variations: 1, instruction: 'deixe o texto mais curto' });
    expect(original).toMatchObject({ piece_id: null, status: 'concluido' });
    expect(await ownerQuery(`select action from liame.audit_event where tenant_id = $1 and action in ('peca.pedir_outra', 'peca.refazer') order by chain_seq`, [d.tenantId])).toEqual([
      { action: 'peca.pedir_outra' },
      { action: 'peca.refazer' },
    ]);

    // Sem instrução nova, vale a do pedido original; e a peça igual à versão anterior não é outra: nada entra.
    expect((await decidir(d, refeita, 'redo')).status).toBe(202);
    const repetiu = responder({ ...OUTRA, titulo: 'COMBO SEXTA POR R$ 34,90!' });
    expect((await rodarFila(d))[0]).toMatchObject({ status: 'recusado', motivo: 'sem_peca' });
    expect(JSON.stringify(repetiu.doGenerateCalls[0]!.prompt.filter((m) => m.role === 'user'))).toContain('fale da retirada no balcão');
    expect(await ler(d, boa.id)).toMatchObject({ redoing: false, current: { version: 2 } });
    expect((await pedidos(d))[0]).toMatchObject({ piece_id: boa.id, status: 'recusado', reason: 'sem_peca' });

    // A peça recusada enquanto o Criativo refazia: o pedido fecha sem chamar o modelo, e nada entra.
    const atual = await ler(d, boa.id);
    expect((await decidir(d, atual, 'redo')).status).toBe(202);
    expect((await decidir(d, atual, 'reject', { reason: 'nao_preciso_mais' })).status).toBe(200);
    const naoChamado = responder(BOA);
    expect((await rodarFila(d))[0]).toMatchObject({ status: 'recusado', motivo: 'peca_decidida' });
    expect(naoChamado.doGenerateCalls).toHaveLength(0);
    expect(await ler(d, boa.id)).toMatchObject({ status: 'recusada', redoing: false, current: { version: 2 } });
  });

  it('contestar: o motivo fica guardado, uma vez por versão, e a peça continua barrada', async () => {
    const { d, pecas } = await comPecas(BOA, BARRADA);
    const [boa, barrada] = pecas as [Peca, Peca];
    expect((await decidir(d, boa, 'contest', { comment: 'Acho que está certo.' })).body).toMatchObject({ status: 409, code: 'sem-o-que-contestar' });
    expect((await decidir(d, barrada, 'contest', { comment: 'x' })).status).toBe(400);
    const r = await decidir(d, barrada, 'contest', { comment: 'O preço de R$ 29,90 é o do Smash Clássico, que vem no combo. Me liga: (21) 99999-0000' });
    expect(r.status).toBe(200);
    const contestada = AdPieceResponse.parse(r.body);
    expect(contestada).toMatchObject({ status: 'decidir', decided_by: null });
    expect(contestada.decisions).toEqual([expect.objectContaining({ decision: 'contestada', version: 1, comment: 'O preço de R$ 29,90 é o do Smash Clássico, que vem no combo. Me liga: [telefone]' })]);
    expect((await decidir(d, barrada, 'contest', { comment: 'De novo.' })).body).toMatchObject({ status: 409, code: 'ja-contestada' });
    // Contestar não destrava: o que é regra não é liberado por quem está com pressa.
    expect((await decidir(d, barrada, 'approve')).body).toMatchObject({ status: 409, code: 'peca-barrada' });
  });

  it('V37: quatro aprovações juntas viram uma; quem não opera campanhas não decide; outra empresa não acha a peça', async () => {
    const { d, pecas } = await comPecas(BOA, OUTRA);
    const [boa, outra] = pecas as [Peca, Peca];
    const juntas = await Promise.all([decidir(d, boa, 'approve'), decidir(d, boa, 'approve'), decidir(d, boa, 'approve'), decidir(d, boa, 'approve')]);
    expect(juntas.map((r) => r.status).sort()).toEqual([200, 409, 409, 409]);
    expect(await ownerQuery(`select decision from liame.ad_piece_decision where piece_id = $1`, [boa.id])).toEqual([{ decision: 'aprovada' }]);

    for (const papel of ['somente_leitura', 'aprovador']) {
      const pessoa = await membro(d, papel);
      expect((await api.call('GET', `/v1/ad-pieces/${outra.id}`, { cookie: pessoa.cookie })).status).toBe(200);
      expect((await editar(d, outra, { title: 'Outro título' }, {}, pessoa.cookie)).status).toBe(403);
      for (const acao of ACOES) expect((await decidir(d, outra, acao, CORPO[acao], pessoa.cookie)).status).toBe(403);
    }
    const gestor = await membro(d, 'gestor');
    expect((await decidir(d, outra, 'approve', {}, gestor.cookie)).status).toBe(200);

    const estranho = await dono();
    const { pecas: delas } = await comPecas(BOA);
    for (const acao of ACOES) expect((await decidir(estranho, delas[0]!, acao, CORPO[acao])).status).toBe(404);
    expect((await editar(estranho, delas[0]!, { title: 'Outro título' })).status).toBe(404);
  });

  it('o que espera a pessoa: o menu e o Resumo contam as que passaram e as barradas; a refeita, a decidida e a de outra empresa ficam fora', async () => {
    const { d, pecas } = await comPecas(BOA, COM_AVISO, BARRADA);
    const [boa, aviso] = pecas as [Peca, Peca, Peca];
    const esperando = async (cookie = d.cookie) => {
      const r = await api.call('GET', '/v1/ad-pieces/waiting', { cookie });
      expect(r.status).toBe(200);
      return AdPieceWaitingResponse.parse(r.body);
    };
    const noResumo = async (cookie = d.cookie, marca = d.brandId) => {
      const r = await api.call('GET', `/v1/summary?brand_id=${marca}`, { cookie });
      expect(r.status).toBe(200);
      return SummaryResponse.parse(r.body).needs_you.approvals;
    };
    /** Um pedido de uma peça para a oferta, já escrita pelo Criativo (o modelo simulado). */
    const pedirUma = async (oferta: string, peca: Record<string, unknown>) => {
      const r = await api.call('POST', '/v1/ad-pieces/requests', { cookie: d.cookie, body: { brand_id: d.brandId, offer: oferta, destination: 'cardapio', variations: 1 } });
      if (r.status !== 202) throw new Error(`pedido não aceito: ${r.status} ${JSON.stringify(r.body)}`);
      responder(peca);
      expect((await rodarFila(d))[0]).toMatchObject({ status: 'concluido' });
    };

    // A de aviso conta com a que passou: as duas podem ser aprovadas agora.
    expect(await esperando()).toEqual({ ready: 2, barred: 1 });
    expect((await noResumo()).pieces).toEqual({ ready: 2, barred: 1, offers: 1, offer: OFERTA });

    // A peça que o Criativo está refazendo não espera a pessoa; com a versão nova, volta a esperar.
    expect((await decidir(d, boa, 'redo', { instruction: 'deixe o texto mais curto' })).status).toBe(202);
    expect(await esperando()).toEqual({ ready: 1, barred: 1 });
    expect((await noResumo()).pieces).toEqual({ ready: 1, barred: 1, offers: 1, offer: OFERTA });
    responder(OUTRA);
    expect((await rodarFila(d))[0]).toMatchObject({ status: 'concluido' });
    expect(await esperando()).toEqual({ ready: 2, barred: 1 });

    // Quem não acompanha as campanhas não recebe a conta: nem pela rota, nem dentro do Resumo.
    await ownerQuery(`insert into liame.role_permission (tenant_id, role_key, permission) select $1, 'dono', p from unnest(array['empresa.ver', 'marcas.ver', 'vendas.ver']) as p`, [d.tenantId]);
    try {
      expect((await api.call('GET', '/v1/ad-pieces/waiting', { cookie: d.cookie })).status).toBe(403);
      expect(await noResumo()).toEqual({ actions: 0, plans: 0, autonomy: 0 });
    } finally {
      await ownerQuery(`delete from liame.role_permission where tenant_id = $1`, [d.tenantId]);
    }

    // Outra empresa não conta estas peças.
    const vizinha = await dono();
    expect(await esperando(vizinha.cookie)).toEqual({ ready: 0, barred: 0 });
    expect((await noResumo(vizinha.cookie, vizinha.brandId)).pieces).toEqual({ ready: 0, barred: 0, offers: 0, offer: null });

    // Decidida, a peça sai da conta (aprovada ou recusada). Só com a barrada, nenhuma oferta é citada.
    expect((await decidir(d, aviso, 'approve')).status).toBe(200);
    expect((await decidir(d, await ler(d, boa.id), 'reject', { reason: 'nao_preciso_mais' })).status).toBe(200);
    expect(await esperando()).toEqual({ ready: 0, barred: 1 });
    expect((await noResumo()).pieces).toEqual({ ready: 0, barred: 1, offers: 0, offer: null });

    // Peças de duas ofertas: o Resumo diz de quantas são e não cita uma só.
    const duplo = 'Smash duplo com fritas por R$ 39,90';
    await salvarDossie(d, 1, { ...DOSSIE, offers: { items: [OFERTA, duplo] } });
    await pedirUma(OFERTA, { titulo: 'O combo de sexta chegou', texto: 'Smash, batata e refri por R$ 34,90. Retire no balcão.', botao: 'pedir_agora' });
    expect((await noResumo()).pieces).toEqual({ ready: 1, barred: 1, offers: 1, offer: OFERTA });
    await pedirUma(duplo, { titulo: 'Smash duplo com fritas', texto: 'Smash duplo com fritas por R$ 39,90. Peça pelo cardápio.', botao: 'pedir_agora' });
    expect((await noResumo()).pieces).toEqual({ ready: 2, barred: 1, offers: 2, offer: null });
    expect(await esperando()).toEqual({ ready: 2, barred: 1 });

    // A marca arquivada não aparece na tela de Criativos: as peças dela não contam no menu.
    await ownerQuery(`update liame.brand set archived_at = now() where id = $1`, [d.brandId]);
    expect(await esperando()).toEqual({ ready: 0, barred: 0 });
  });

  it('com o Criativo desligado para a empresa nada se decide; com a IA desligada, dá para decidir e não para pedir outra', async () => {
    const { d, pecas } = await comPecas(BOA, OUTRA);
    const [boa, outra] = pecas as [Peca, Peca];
    // A IA desligada depois de as peças existirem (D-A4-32): editar, aprovar e recusar continuam; pedir outra, não.
    await ownerQuery(`delete from liame.feature_flag_rule where flag_key = 'ia' and scope_type = 'tenant' and scope_id = $1`, [d.tenantId]);
    flags.invalidate();
    expect((await decidir(d, boa, 'redo')).body).toMatchObject({ status: 409, code: 'criativo-desligado' });
    const editada = AdPieceResponse.parse((await editar(d, boa, { title: 'Sexta tem combo' })).body);
    expect((await decidir(d, editada, 'approve')).status).toBe(200);

    // A flag do Criativo desligada: as decisões param (as leituras seguem mostrando o que existe).
    await ownerQuery(`delete from liame.feature_flag_rule where flag_key = 'criativo' and scope_type = 'tenant' and scope_id = $1`, [d.tenantId]);
    flags.invalidate();
    for (const acao of ACOES) expect((await decidir(d, outra, acao, CORPO[acao])).body).toMatchObject({ status: 409, code: 'criativo-desligado' });
    expect((await editar(d, outra, { title: 'Outro título' })).body).toMatchObject({ status: 409, code: 'criativo-desligado' });
    expect(await lista(d)).toHaveLength(2);
  });
});
