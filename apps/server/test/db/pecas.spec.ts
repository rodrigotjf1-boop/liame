import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { AdPieceListResponse, AdPieceOptionsResponse, AdPieceRequestListResponse, AdPieceRequestResponse, AdPieceResponse } from '@liame/contracts';
import { type Database, runMigrations } from '@liame/database';
import { MockLanguageModelV4 } from 'ai/test';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PROMPT_CRIATIVO_TEXTO, TAREFA_CRIATIVO_TEXTO } from '../../src/ai/criativo/prompt.js';
import { AiGateway } from '../../src/ai/gateway.js';
import { ModelosIa } from '../../src/ai/modelos.js';
import { MODELO_PADRAO } from '../../src/attribution/motor.js';
import { APP_CONFIG, type AppConfig } from '../../src/config.js';
import { DATABASE } from '../../src/database/database.module.js';
import { FlagService } from '../../src/flags/flag.service.js';
import { ResultsService } from '../../src/results/results.service.js';
import { CriativoLoop, TENTATIVAS_DA_GERACAO } from '../../src/worker/criativo-loop.js';
import { CriativoService } from '../../src/worker/criativo.service.js';
import { enableMfa, ownerQuery, PASSWORD, resetIpRateLimits, signupAndLogin, startApi, TERMOS, type TestApi, tokenFrom, uniqueEmail } from '../helpers/api.js';
import { ligarCriativo, ligarIa, ModelosDeTeste, recusa as recusaDoFornecedor, responde, rotaCompartilhada, uso } from '../helpers/ia.js';
import { hasDb, OWNER_URL } from './env.js';

// As peças do Criativo (A4, X6 parte b): a pessoa pede peças para uma oferta de Minha marca; o pedido é conferido antes
// de qualquer chamada; a fila do worker chama o Criativo (o modelo simulado), confere cada peça e grava as que servem,
// cada uma com a conferência dela. Nada vai para a Meta. Tudo atrás da flag `criativo`.

const OFERTA = 'Combo sexta: smash, batata e refri por R$ 34,90';
const OFERTA_COM_BEBIDA = 'Smash e chope por R$ 39,90';
const DOSSIE = {
  identity: { summary: 'Hamburgueria de bairro com smash feito na chapa', audience: 'Quem mora ou trabalha no Centro', differentiator: 'Pão feito na casa todo dia', since: '2019' },
  voice: { traits: ['Direta'], rules: ['Frases curtas.'], do_example: 'Bateu a fome? O smash sai da chapa rapidinho.', dont_example: '' },
  products: { items: ['Smash Clássico R$ 29,90'] },
  offers: { items: [OFERTA, OFERTA_COM_BEBIDA] },
  forbidden: { items: [{ text: 'gourmet', why: 'não combina com a casa' }] },
  competitors: { items: [{ text: 'Burger do Zé', why: 'fica na mesma rua' }] },
  region: { area: 'Centro e Lapa', pickup: true },
};
const BOA = { titulo: 'Sexta é dia de combo', texto: 'Smash, batata e refri por R$ 34,90. Peça pelo cardápio e retire no balcão.', botao: 'pedir_agora' };
const COM_AVISO = { titulo: 'Combo sexta: smash, batata e refri', texto: 'Combo sexta por R$ 34,90. É só pedir pelo cardápio.', botao: 'ver_cardapio' };
const BARRADA = { titulo: 'Combo gourmet por R$ 29,90', texto: 'Smash, batata e refri. Peça pelo cardápio.', botao: 'pedir_agora' };

describe.skipIf(!hasDb)('Peças do Criativo: pedido, fila, conferência e leitura (A4, X6)', () => {
  let api: TestApi;
  let database: Database;
  let config: AppConfig;
  let flags: FlagService;
  let modelos: ModelosDeTeste;
  let alvo: { provider: string; model: string };
  let loop: CriativoLoop;

  type Dono = { cookie: string; tenantId: string; userId: string; brandId: string };

  async function dono(opcoes: { ia?: boolean; criativo?: boolean; dossie?: Record<string, unknown> | null } = {}): Promise<Dono> {
    await resetIpRateLimits();
    const s = await signupAndLogin(api, undefined, 'Hamburgueria das Peças');
    await enableMfa(api, s.cookie);
    const tenantId = s.me.active_organization_id as string;
    const brandId = (await api.call('GET', '/v1/brands', { cookie: s.cookie })).body.items[0].id as string;
    if (opcoes.ia !== false) await ligarIa(flags, tenantId);
    if (opcoes.criativo !== false) await ligarCriativo(flags, tenantId);
    const d = { cookie: s.cookie, tenantId, userId: s.me.user.id as string, brandId };
    if (opcoes.dossie !== null) {
      const salvo = await api.call('PUT', '/v1/brand-dossier', { cookie: d.cookie, body: { brand_id: brandId, base_version: 0, content: opcoes.dossie ?? DOSSIE } });
      if (salvo.status !== 200) throw new Error(`dossiê não salvo: ${salvo.status} ${JSON.stringify(salvo.body)}`);
    }
    return d;
  }

  async function membro(d: Dono, role: string): Promise<{ cookie: string }> {
    const email = uniqueEmail(role);
    expect((await api.call('POST', '/v1/invitations', { cookie: d.cookie, body: { email, role } })).status).toBe(201);
    const s = await api.call('POST', '/v1/invitations/signup', { body: { token: tokenFrom(api.mailer, email), name: `Pessoa ${role}`, password: PASSWORD, terms_version: TERMOS } });
    if (!s.cookie) throw new Error(`convite não aceito: ${s.status} ${JSON.stringify(s.body)}`);
    await enableMfa(api, s.cookie);
    return { cookie: s.cookie };
  }

  const modelo = (mock: MockLanguageModelV4) => {
    modelos.porChave.set(`${alvo.provider}/${alvo.model}`, mock);
    return mock;
  };
  const responder = (resposta: Record<string, unknown>) => modelo(responde(JSON.stringify(resposta), uso(2000, 300)));
  const pedir = (d: Dono, body: Record<string, unknown> = {}, cookie = d.cookie) =>
    api.call('POST', '/v1/ad-pieces/requests', { cookie, body: { brand_id: d.brandId, offer: OFERTA, destination: 'cardapio', variations: 3, ...body } });
  const rodarFila = (d: Dono, agora?: Date) => loop.executarLote(10, { tenantIds: [d.tenantId] }, agora);
  const opcoes = async (d: Dono, cookie = d.cookie) => AdPieceOptionsResponse.parse((await api.call('GET', `/v1/ad-pieces/options?brand_id=${d.brandId}`, { cookie })).body);
  const pedidos = async (d: Dono) => AdPieceRequestListResponse.parse((await api.call('GET', `/v1/ad-pieces/requests?brand_id=${d.brandId}`, { cookie: d.cookie })).body).items;
  const pecas = async (d: Dono, status?: string) =>
    AdPieceListResponse.parse((await api.call('GET', `/v1/ad-pieces?brand_id=${d.brandId}${status ? `&status=${status}` : ''}`, { cookie: d.cookie })).body).items;
  const erros = (r: { body: { errors?: Array<{ path: string; message: string }> } }) => (r.body.errors ?? []).map((e) => e.path);

  /** Um anúncio da Meta com pedidos confirmados e atribuídos a ele, há alguns dias (dentro dos 7 dias completos). */
  async function anuncioQueVende(d: Dono, nome: string, quantos: number): Promise<string> {
    const [loja, conta, campanha, anuncio] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    const numero = () => String(Math.floor(1e9 + Math.random() * 9e9));
    await ownerQuery(
      `insert into liame.connected_account (id, tenant_id, brand_id, unit_id, provider, external_id, name, currency, timezone) values
         ($1, $3, $4, null, 'regem', $5, 'Loja Centro', 'BRL', 'America/Sao_Paulo'), ($2, $3, $4, null, 'meta_ads', $6, 'Conta de anúncios', 'BRL', 'America/Sao_Paulo')`,
      [loja, conta, d.tenantId, d.brandId, randomUUID(), `act_${numero()}`],
    );
    await ownerQuery(`insert into liame.campaign (id, tenant_id, connected_account_id, provider, external_id, name, status) values ($1, $2, $3, 'meta_ads', $4, 'Combo sexta', 'ativa')`, [campanha, d.tenantId, conta, numero()]);
    await ownerQuery(`insert into liame.ad (id, tenant_id, connected_account_id, provider, external_id, name, status) values ($1, $2, $3, 'meta_ads', $4, $5, 'ativa')`, [anuncio, d.tenantId, conta, numero(), nome]);
    for (let i = 0; i < quantos; i += 1) {
      const pedido = randomUUID();
      await ownerQuery(
        `insert into liame.order_fact (id, tenant_id, brand_id, connected_account_id, provider, external_id, channel, channel_group, status, currency, timezone, revenue_micros, confirmed_at, source_version, source_updated_at)
         values ($1, $2, $3, $4, 'regem', $5, 'cardapio', 'cardapio', 'confirmado', 'BRL', 'America/Sao_Paulo', 34900000, now() - interval '3 days', 1, now())`,
        [pedido, d.tenantId, d.brandId, loja, `p-${numero()}`],
      );
      await ownerQuery(
        `insert into liame.attribution_result (order_id, model_id, tenant_id, brand_id, status, provider, campaign_id, ad_id, evidence, confidence, window_days, counted)
         values ($1, $2, $3, $4, 'atribuido', 'meta_ads', $5, $6, 'clique', 'alta', 7, true)`,
        [pedido, MODELO_PADRAO, d.tenantId, d.brandId, campanha, anuncio],
      );
    }
    return anuncio;
  }

  beforeAll(async () => {
    await runMigrations({ connectionString: OWNER_URL, dir: resolve(process.cwd(), '../../packages/database/migrations') });
    api = await startApi();
    database = api.app.get(DATABASE);
    config = api.app.get(APP_CONFIG);
    flags = api.app.get(FlagService);
    modelos = new ModelosDeTeste(config);
    api.app.get(ModelosIa).modelo = (provider, model) => modelos.modelo(provider, model);
    loop = new CriativoLoop(database, flags, new CriativoService(database, api.app.get(AiGateway), api.app.get(ResultsService)));
    // A rota desta tarefa é dividida com `pecas-decisoes.spec.ts`: nome fixo, ninguém apaga (V76).
    alvo = await rotaCompartilhada(modelos, TAREFA_CRIATIVO_TEXTO, new MockLanguageModelV4({ doGenerate: [] }));
  }, 120_000);
  beforeEach(resetIpRateLimits);
  afterAll(async () => {
    await api?.close();
  });

  it('o pedido entra na fila, o Criativo escreve, cada peça sai conferida e a barrada aparece com o motivo', async () => {
    const d = await dono();
    const anuncio = await anuncioQueVende(d, 'Combo sexta · carrossel', 3);
    await anuncioQueVende(d, 'Smash em dobro · foto', 1);

    const o = await opcoes(d);
    expect(o).toMatchObject({ available: true, reason: null, dossier_version: 1, in_progress: null, limits: { variations_min: 1, variations_max: 4, instruction_max: 300 } });
    expect(o.offers).toEqual([
      { text: OFERTA, has_value: true, problems: [] },
      { text: OFERTA_COM_BEBIDA, has_value: true, problems: [{ reason: 'bebida_alcoolica', excerpt: 'chope' }] },
    ]);
    expect(o.reference_ads.map((a) => [a.name, a.campaign, a.orders])).toEqual([
      ['Combo sexta · carrossel', 'Combo sexta', 3],
      ['Smash em dobro · foto', 'Combo sexta', 1],
    ]);

    const r = await pedir(d, { instruction: 'fale da retirada no balcão', reference_ad_id: anuncio });
    expect(r.status).toBe(202);
    const p = AdPieceRequestResponse.parse(r.body);
    expect(p).toMatchObject({
      kind: 'texto',
      offer: OFERTA,
      dossier_version: 1,
      destination: 'cardapio',
      variations: 3,
      instruction: 'fale da retirada no balcão',
      reference: { ad_id: anuncio, name: 'Combo sexta · carrossel' },
      piece_id: null,
      status: 'pendente',
      reason: null,
      pieces: 0,
      requested_by: { id: d.userId },
      finished_at: null,
    });
    // Um pedido de peças novas por marca de cada vez.
    expect((await pedir(d)).body).toMatchObject({ status: 409, code: 'lote-em-andamento' });
    expect(await opcoes(d)).toMatchObject({ available: false, reason: 'lote_em_andamento', in_progress: { id: p.id, status: 'pendente' } });

    const mock = responder({ recusa: null, pecas: [BOA, COM_AVISO, BARRADA] });
    expect(await rodarFila(d)).toEqual([{ id: p.id, tenantId: d.tenantId, status: 'concluido' }]);

    // O Criativo recebeu o prompt registrado, o contexto do sistema (com o dossiê) e, na mensagem, a oferta, a referência e a instrução entre marcas.
    expect(mock.doGenerateCalls).toHaveLength(1);
    const enviado = mock.doGenerateCalls[0]!.prompt;
    const sistema = JSON.stringify(enviado.filter((m) => m.role === 'system'));
    expect(sistema).toContain(PROMPT_CRIATIVO_TEXTO.content.split('\n')[0]);
    expect(sistema).toContain('Destino do anúncio: o cardápio online da loja');
    expect(sistema).toContain('NUNCA DIZER: \\"gourmet\\"');
    const mensagem = JSON.stringify(enviado.filter((m) => m.role === 'user'));
    expect(mensagem).toContain('<<<OFERTA DE MINHA MARCA>>>');
    expect(mensagem).toContain(OFERTA);
    expect(mensagem).toContain('Nome: Combo sexta · carrossel');
    expect(mensagem).toContain('fale da retirada no balcão');
    expect(mock.doGenerateCalls[0]!.tools ?? []).toEqual([]);

    const [pedido] = await pedidos(d);
    expect(pedido).toMatchObject({ id: p.id, status: 'concluido', reason: null, pieces: 3 });
    expect(pedido!.finished_at).not.toBeNull();
    expect(await opcoes(d)).toMatchObject({ available: true, in_progress: null });

    const lista = await pecas(d, 'decidir');
    expect(lista).toHaveLength(3);
    const por = (titulo: string) => lista.find((x) => x.current.title === titulo)!;
    expect(por(BOA.titulo)).toMatchObject({ status: 'decidir', offer: OFERTA, destination: 'cardapio', ai_generated: true, redoing: false, request_id: p.id, decided_by: null, decided_at: null });
    expect(por(BOA.titulo).current).toMatchObject({ version: 1, body: BOA.texto, button: 'pedir_agora', author: 'criativo', created_by: null });
    expect(por(BOA.titulo).current.review).toMatchObject({ status: 'passou', cites_value: true, characters: { title: 20 }, recommended: { title: 27, body: 125 } });
    expect(por(BOA.titulo).current.review.items.map((i) => [i.item, i.status])).toEqual([
      ['oferta', 'passou'],
      ['regras_da_liame', 'passou'],
      ['regras_da_marca', 'passou'],
      ['tamanho', 'passou'],
    ]);
    expect(por(COM_AVISO.titulo).current.review).toMatchObject({ status: 'aviso' });
    expect(por(COM_AVISO.titulo).current.review.items.find((i) => i.item === 'tamanho')).toEqual({
      item: 'tamanho',
      status: 'aviso',
      findings: [{ kind: 'acima_do_recomendado', field: 'titulo', excerpt: '34 de 27' }],
    });
    const barrada = por(BARRADA.titulo).current.review;
    expect(barrada.status).toBe('barrou');
    expect(barrada.items.filter((i) => i.status === 'barrou').map((i) => [i.item, i.findings.map((f) => `${f.kind}:${f.excerpt}`)])).toEqual([
      ['oferta', ['preco_fora:29,90']],
      ['regras_da_marca', ['regra_da_marca:gourmet']],
    ]);
    expect(await pecas(d, 'aprovada')).toEqual([]);
    expect(await pecas(d)).toHaveLength(3);

    // O detalhe traz as versões, e o hash é o do que a pessoa vê.
    const detalhe = AdPieceResponse.parse((await api.call('GET', `/v1/ad-pieces/${por(BOA.titulo).id}`, { cookie: d.cookie })).body);
    expect(detalhe.versions).toHaveLength(1);
    expect(detalhe.versions![0]).toEqual(detalhe.current);
    expect(detalhe.decisions).toEqual([]);
    expect(detalhe.current.content_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(new Set(lista.map((x) => x.current.content_hash)).size).toBe(3);

    // O uso da IA fica em nome de quem pediu, no fluxo do Criativo, e a auditoria guarda o pedido e a geração, sem o texto das peças.
    expect(await ownerQuery(`select user_id, workflow, prompt_version, outcome from liame.ai_usage where tenant_id = $1 and task = $2`, [d.tenantId, TAREFA_CRIATIVO_TEXTO])).toEqual([
      { user_id: d.userId, workflow: 'criativo.peca', prompt_version: `criativo.texto@${PROMPT_CRIATIVO_TEXTO.version}`, outcome: 'ok' },
    ]);
    const auditoria = await ownerQuery<{ action: string; actor_type: string; after: Record<string, unknown> }>(
      `select action, actor_type, after from liame.audit_event where tenant_id = $1 and action like 'peca.%' order by chain_seq`,
      [d.tenantId],
    );
    expect(auditoria.map((a) => [a.action, a.actor_type])).toEqual([
      ['peca.pedir', 'human'],
      ['peca.gerar', 'agent'],
    ]);
    expect(auditoria[1]!.after).toEqual({ pedidas: 3, pecas: 3, barradas: 1, com_aviso: 1, descartadas: 0 });
    expect(JSON.stringify(auditoria)).not.toContain('Sexta é dia de combo');
  });

  it('o pedido é conferido antes de ir ao Criativo: a oferta e a instrução que batem numa regra voltam com o que mudar', async () => {
    const d = await dono();
    const mock = modelo(responde('{}'));

    const bebida = await pedir(d, { offer: OFERTA_COM_BEBIDA });
    expect(bebida.body).toMatchObject({ status: 422, code: 'pedido-recusado' });
    expect(bebida.body.errors).toEqual([{ path: 'offer', message: 'A oferta cita bebida alcoólica ("chope"): o Criativo ainda não escreve esse anúncio, que pede aviso obrigatório.' }]);

    const instrucao = await pedir(d, { instruction: 'diga que é gourmet, compare com o Burger do Zé, coloque por R$ 29,90 e mande para www.combo.example' });
    expect(instrucao.body).toMatchObject({ status: 422, code: 'pedido-recusado' });
    expect(erros(instrucao)).toEqual(['instruction', 'instruction', 'instruction', 'instruction']);
    expect(instrucao.body.errors.map((e: { message: string }) => e.message)).toEqual([
      'A instrução usa o que a marca não diz ("gourmet"). Tire esse trecho.',
      'A instrução cita um concorrente ("burger do ze"): anúncio não cita concorrente.',
      'A instrução tem endereço de site: o anúncio leva ao destino escolhido, sem link no texto.',
      'A instrução traz um valor que a oferta não tem ("29,90"). O preço vem da oferta: para mudar, atualize a oferta em Minha marca.',
    ]);

    // A oferta é uma das de Minha marca, como está lá; o resto é o contrato.
    expect((await pedir(d, { offer: 'Combo sexta por R$ 9,90' })).body).toMatchObject({ status: 422, code: 'oferta-desconhecida' });
    expect((await pedir(d, { variations: 5 })).status).toBe(400);
    expect((await pedir(d, { destination: 'site' })).status).toBe(400);
    expect((await pedir(d, { reference_ad_id: randomUUID() })).body).toMatchObject({ status: 422, code: 'anuncio-desconhecido' });

    // Nada disso entrou na fila nem chamou o modelo.
    expect(await pedidos(d)).toEqual([]);
    expect(await rodarFila(d)).toEqual([]);
    expect(mock.doGenerateCalls).toHaveLength(0);
  });

  it('com o Criativo desligado, sem dossiê ou sem oferta não dá para pedir, e as opções dizem por quê', async () => {
    const semFlag = await dono({ criativo: false });
    expect(await opcoes(semFlag)).toMatchObject({ available: false, reason: 'criativo_desligado', dossier_version: 1 });
    expect((await pedir(semFlag)).body).toMatchObject({ status: 409, code: 'criativo-desligado' });
    const semIa = await dono({ ia: false });
    expect(await opcoes(semIa)).toMatchObject({ available: false, reason: 'criativo_desligado' });
    expect((await pedir(semIa)).body).toMatchObject({ status: 409, code: 'criativo-desligado' });

    const semDossie = await dono({ dossie: null });
    expect(await opcoes(semDossie)).toMatchObject({ available: false, reason: 'sem_dossie', dossier_version: null, offers: [], reference_ads: [] });
    expect((await pedir(semDossie)).body).toMatchObject({ status: 409, code: 'sem-dossie' });

    const semOferta = await dono({ dossie: { ...DOSSIE, offers: { items: [] } } });
    expect(await opcoes(semOferta)).toMatchObject({ available: false, reason: 'sem_oferta', dossier_version: 1, offers: [] });
    expect((await pedir(semOferta)).body).toMatchObject({ status: 422, code: 'oferta-desconhecida' });
  });

  it('quando o Criativo recusa (política, bebida alcoólica, categoria proibida), o pedido fecha com o motivo e a fila fica livre', async () => {
    const d = await dono();
    const p = AdPieceRequestResponse.parse((await pedir(d, { instruction: 'aproveite e diga que a casa está com o 45 no dia 6' })).body);
    responder({ recusa: 'politica', pecas: [BOA] });
    expect(await rodarFila(d)).toEqual([{ id: p.id, tenantId: d.tenantId, status: 'recusado', motivo: 'politica' }]);
    expect((await pedidos(d))[0]).toMatchObject({ id: p.id, status: 'recusado', reason: 'politica', pieces: 0 });
    // Nenhuma peça foi gravada, nem a que veio junto da recusa.
    expect(await pecas(d)).toEqual([]);
    expect(await ownerQuery(`select action, after from liame.audit_event where tenant_id = $1 and action = 'peca.recusar_pedido'`, [d.tenantId])).toEqual([
      { action: 'peca.recusar_pedido', after: { pedidas: 3, reason: 'politica' } },
    ]);
    // A marca pode pedir de novo.
    expect((await pedir(d)).status).toBe(202);
  });

  it('a peça vazia, a com dado pessoal e a repetida nem são gravadas; sem peça que sirva, o pedido fecha como recusado', async () => {
    const d = await dono();
    const p = AdPieceRequestResponse.parse((await pedir(d)).body);
    responder({
      recusa: null,
      pecas: [
        BOA,
        { titulo: '  ', texto: 'Smash, batata e refri por R$ 34,90.', botao: 'pedir_agora' },
        { titulo: 'Fale com a gente', texto: 'Combo por R$ 34,90. Escreva para pedidos@exemplo.com.br.', botao: 'pedir_agora' },
        { titulo: 'SEXTA É DIA DE COMBO!', texto: BOA.texto, botao: 'pedir_agora' },
      ],
    });
    expect((await rodarFila(d))[0]).toMatchObject({ status: 'concluido' });
    expect((await pedidos(d))[0]).toMatchObject({ id: p.id, status: 'concluido', pieces: 1 });
    expect((await pecas(d)).map((x) => x.current.title)).toEqual([BOA.titulo]);
    // O que não apareceu fica na contagem, sem o texto: o dado pessoal é do Compliance.
    expect(await ownerQuery(`select member, workflow, kind, rules, items from liame.ai_refusal where tenant_id = $1 order by kind`, [d.tenantId])).toEqual([
      { member: 'criativo', workflow: 'criativo.peca', kind: 'compliance', rules: ['dado_pessoal'], items: 1 },
      { member: 'criativo', workflow: 'criativo.peca', kind: 'repetida', rules: [], items: 1 },
      { member: 'criativo', workflow: 'criativo.peca', kind: 'vazia', rules: [], items: 1 },
    ]);
    expect(JSON.stringify(await ownerQuery(`select discards from liame.ad_piece_request where id = $1`, [p.id]))).not.toContain('exemplo.com.br');

    const outro = AdPieceRequestResponse.parse((await pedir(d)).body);
    responder({ recusa: null, pecas: [{ titulo: '', texto: '', botao: 'pedir_agora' }] });
    expect((await rodarFila(d))[0]).toMatchObject({ id: outro.id, status: 'recusado', motivo: 'sem_peca' });
    expect((await pedidos(d))[0]).toMatchObject({ id: outro.id, status: 'recusado', reason: 'sem_peca', pieces: 0 });
  });

  it('falha passageira tenta de novo logo, poucas vezes, e fecha como falhou; a IA desligada no meio fecha na hora, com o motivo', async () => {
    const d = await dono();
    const p = AdPieceRequestResponse.parse((await pedir(d)).body);
    // Resposta fora do formato do Criativo: o gateway devolve falha, e a fila tenta de novo.
    const mock = modelo(responde(JSON.stringify({ pecas: 'nenhuma' })));
    const t0 = new Date();
    expect((await rodarFila(d, t0))[0]).toMatchObject({ id: p.id, status: 'falhou' });
    expect((await pedidos(d))[0]).toMatchObject({ status: 'pendente', pieces: 0 });
    // Antes da hora, a fila não pega o pedido de novo.
    expect(await rodarFila(d, new Date(t0.getTime() + 30_000))).toEqual([]);
    let agora = t0;
    for (let tentativa = 2; tentativa <= TENTATIVAS_DA_GERACAO; tentativa += 1) {
      agora = new Date(agora.getTime() + 10 * 60_000);
      expect((await rodarFila(d, agora))[0]).toMatchObject({ id: p.id, status: tentativa === TENTATIVAS_DA_GERACAO ? 'falhou_de_vez' : 'falhou' });
    }
    expect((await pedidos(d))[0]).toMatchObject({ id: p.id, status: 'falhou', pieces: 0 });
    expect((await pedidos(d))[0]!.reason).toMatch(/^(formato|ia_fora_do_ar)$/);
    expect(mock.doGenerateCalls.length).toBeGreaterThanOrEqual(TENTATIVAS_DA_GERACAO);
    expect(await rodarFila(d, new Date(agora.getTime() + 86_400_000))).toEqual([]);

    // O fornecedor recusando a chamada é falha passageira também.
    const q = AdPieceRequestResponse.parse((await pedir(d)).body);
    modelo(recusaDoFornecedor(500));
    expect((await rodarFila(d))[0]).toMatchObject({ id: q.id, status: 'falhou', motivo: 'ia_fora_do_ar' });
    expect((await pedidos(d))[0]).toMatchObject({ id: q.id, status: 'pendente' });

    // A IA desligada para a empresa no meio do caminho: o pedido fecha, e a marca pode pedir de novo quando ela voltar.
    await ownerQuery(`delete from liame.feature_flag_rule where flag_key = 'ia' and scope_type = 'tenant' and scope_id = $1`, [d.tenantId]);
    flags.invalidate();
    expect((await rodarFila(d, new Date(Date.now() + 10 * 60_000)))[0]).toMatchObject({ id: q.id, status: 'sem_ia', motivo: 'ia_desligada' });
    expect((await pedidos(d))[0]).toMatchObject({ id: q.id, status: 'falhou', reason: 'ia_desligada' });
  });

  it('V35 e V37: quatro pedidos juntos viram um só, e quatro filas juntas geram as peças de cada pedido uma vez', async () => {
    const d = await dono();
    const juntos = await Promise.all([pedir(d), pedir(d), pedir(d), pedir(d)]);
    expect(juntos.map((r) => r.status).sort()).toEqual([202, 409, 409, 409]);
    expect(await pedidos(d)).toHaveLength(1);

    const outra = await dono();
    expect((await pedir(outra, { variations: 1 })).status).toBe(202);
    const mock = responder({ recusa: null, pecas: [BOA] });
    const escopo = { tenantIds: [d.tenantId, outra.tenantId] };
    const voltas = (await Promise.all([loop.executarLote(10, escopo), loop.executarLote(10, escopo), loop.executarLote(10, escopo), loop.executarLote(10, escopo)])).flat();
    expect(voltas.map((v) => v.status)).toEqual(['concluido', 'concluido']);
    expect(mock.doGenerateCalls).toHaveLength(2);
    expect(await pecas(d)).toHaveLength(1);
    expect(await pecas(outra)).toHaveLength(1);
  });

  it('quem só vê campanhas lê as peças e não pede; outra empresa não vê nada', async () => {
    const d = await dono();
    AdPieceRequestResponse.parse((await pedir(d, { variations: 1 })).body);
    responder({ recusa: null, pecas: [BOA] });
    await rodarFila(d);
    const [peca] = await pecas(d);

    const leitor = await membro(d, 'somente_leitura');
    expect((await pedir(d, {}, leitor.cookie)).status).toBe(403);
    expect((await opcoes(d, leitor.cookie)).offers).toHaveLength(2);
    expect((await api.call('GET', `/v1/ad-pieces?brand_id=${d.brandId}`, { cookie: leitor.cookie })).body.items).toHaveLength(1);
    expect((await api.call('GET', `/v1/ad-pieces/${peca!.id}`, { cookie: leitor.cookie })).status).toBe(200);
    expect((await api.call('GET', `/v1/ad-pieces/requests?brand_id=${d.brandId}`, { cookie: leitor.cookie })).body.items).toHaveLength(1);

    const outra = await dono();
    expect((await api.call('GET', `/v1/ad-pieces/${peca!.id}`, { cookie: outra.cookie })).status).toBe(404);
    expect((await api.call('GET', `/v1/ad-pieces?brand_id=${d.brandId}`, { cookie: outra.cookie })).status).toBe(404);
    expect((await api.call('GET', `/v1/ad-pieces/requests?brand_id=${d.brandId}`, { cookie: outra.cookie })).status).toBe(404);
    expect((await api.call('GET', `/v1/ad-pieces/options?brand_id=${d.brandId}`, { cookie: outra.cookie })).status).toBe(404);
    expect((await pedir(d, {}, outra.cookie)).status).toBe(404);
    expect(await pecas(outra)).toEqual([]);
    expect((await api.call('GET', '/v1/ad-pieces/nao-e-um-id', { cookie: d.cookie })).status).toBe(400);
  });
});
