import { resolve } from 'node:path';
import { type Database, runMigrations } from '@liame/database';
import { MockLanguageModelV4 } from 'ai/test';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ModelosIa } from '../../src/ai/modelos.js';
import { ENFOQUES_DA_RECLAMACAO_NO_DIRECT, TAREFA_SOCIAL_DIRECT } from '../../src/ai/social/direct.js';
import { currentStep, totpCode } from '../../src/auth/totp.js';
import { APP_CONFIG, type AppConfig } from '../../src/config.js';
import { DATABASE } from '../../src/database/database.module.js';
import { FlagService } from '../../src/flags/flag.service.js';
import { VaultService } from '../../src/vault/vault.service.js';
import { DirectLoop } from '../../src/worker/direct-loop.js';
import { ownerQuery, resetIpRateLimits, startApi, type TestApi } from '../helpers/api.js';
import { ligarIa, ModelosDeTeste, responde, rotaCompartilhada } from '../helpers/ia.js';
import { InstagramDeMentira, SEGREDO_DO_APP, TOKEN_DO_INSTAGRAM } from '../helpers/instagram-de-mentira.js';
import { ligarFlagDaEmpresa } from '../helpers/meta-de-mentira.js';
import { type EmpresaComCanais, empresaComCanais } from '../helpers/posts-semeados.js';
import { hasDb, OWNER_URL } from './env.js';

// A6 · Z12, parte 4b-2: a sugestão do Social media numa conversa do Direct, a pedido de quem atende (P39; D-A6-110 e
// D-A6-145), com o modelo simulado, contra Postgres e a Meta local. O que se prova:
//   - a pergunta: a sugestão conferida volta com "respondeu" (ou com o que faltou em Minha marca), e o modelo recebe a
//     conversa como "Pessoa" e "Marca", com Minha marca, sem o nome de usuário de quem escreveu;
//   - a sugestão que cita quem escreveu, promete compensação ou inventa número não volta, e conta em Sua equipe sem o texto;
//   - a reclamação: os três caminhos do Direct, na ordem; o caminho de outro nome fica de fora;
//   - o "Pedir outra": as já vistas vão no contexto, e a que repete não volta;
//   - sem IA: a conversa que não é pergunta nem reclamação não chama o modelo; a IA desligada; a conversa que não espera
//     resposta recusa (409); nada é guardado e nada é enviado à Meta.

const DOSSIE = {
  identity: { summary: 'Hamburgueria de bairro com smash feito na chapa', audience: 'Quem mora ou trabalha no Centro', differentiator: 'Pão feito na casa todo dia', since: '2019' },
  voice: { traits: ['Direta'], rules: ['Frases curtas.'], do_example: 'Bateu a fome? O smash sai da chapa rapidinho.', dont_example: '' },
  products: { items: ['Smash Clássico R$ 29,90'] },
  offers: { items: ['Combo sexta: smash, batata e refri por R$ 34,90'] },
  forbidden: { items: [{ text: 'o melhor hambúrguer do Rio', why: 'não temos como provar' }] },
  region: { area: 'Centro e Lapa', pickup: true },
};
const DA_PERGUNTA = { enfoque: 'Responde com a oferta', texto: 'Oi! O Combo sexta sai por R$ 34,90, com smash, batata e refri.' };
const [C1, C2, C3] = ENFOQUES_DA_RECLAMACAO_NO_DIRECT;
const DA_RECLAMACAO = [
  { enfoque: C1, texto: 'Desculpa pelo pedido. Vou passar o número 4821 para a loja conferir e te respondo por aqui.' },
  { enfoque: C2, texto: 'Desculpa! A loja quer entender o que houve com o pedido 4821 e vai conferir. Te respondo por aqui assim que souber.' },
  { enfoque: C3, texto: 'Obrigado pelo aviso, e desculpa. A loja vai rever a conferência da batata na saída. Sobre o pedido 4821, te respondo por aqui.' },
];

type Sugestao = { origin: string; reason: string | null; kind: string | null; suggestions: { focus: string; text: string; check: string }[]; answered: boolean; missing: string | null; dropped: number; usage_id: string | null };

describe.skipIf(!hasDb)('o Direct: a sugestão do Social media a pedido (A6 · Z12, parte 4b-2)', () => {
  let api: TestApi;
  let fila: DirectLoop;
  let flags: FlagService;
  let modelos: ModelosDeTeste;
  let alvo: Awaited<ReturnType<typeof rotaCompartilhada>>;
  const meta = new InstagramDeMentira();

  beforeAll(async () => {
    await runMigrations({ connectionString: OWNER_URL, dir: resolve(process.cwd(), '../../packages/database/migrations') });
    api = await startApi();
    await resetIpRateLimits();
    await meta.ligar();
    const config: AppConfig = api.app.get(APP_CONFIG);
    const database: Database = api.app.get(DATABASE);
    flags = api.app.get(FlagService);
    fila = new DirectLoop(database, { ...config, plataformas: { ...config.plataformas, metaGraphUrl: meta.base, metaAppSecret: SEGREDO_DO_APP } }, api.app.get(VaultService), flags);
    modelos = new ModelosDeTeste(config);
    api.app.get(ModelosIa).modelo = (provider, model) => modelos.modelo(provider, model);
    alvo = await rotaCompartilhada(modelos, TAREFA_SOCIAL_DIRECT, new MockLanguageModelV4({ doGenerate: [] }));
  }, 120_000);
  beforeEach(async () => {
    await resetIpRateLimits();
    meta.normalizar();
  });
  afterAll(async () => {
    await meta.desligar();
    await api?.close();
  });

  /** A empresa com o Instagram e a Página, o Direct ligado na marca, Minha marca preenchida e (por padrão) a IA ligada. */
  async function empresa(nome: string, o: { ia?: boolean } = {}): Promise<EmpresaComCanais> {
    const e = await empresaComCanais(api, nome, { token: TOKEN_DO_INSTAGRAM, instagram: true, pagina: true });
    meta.paginas.set(e.pagina!.externo, ['MODERATE', 'MESSAGING']);
    await ligarFlagDaEmpresa(api, 'direct', e.tenantId, true);
    if (o.ia !== false) await ligarIa(flags, e.tenantId);
    const salvo = await api.call('PUT', '/v1/brand-dossier', { cookie: e.cookie, body: { brand_id: e.brandId, base_version: 0, content: DOSSIE } });
    if (salvo.status !== 200) throw new Error(`dossiê não salvo: ${salvo.status} ${JSON.stringify(salvo.body)}`);
    await ownerQuery(`update liame.app_user set totp_last_step = null where id = $1`, [e.userId]);
    await ownerQuery(`delete from liame.rate_limit where key = $1`, [`segundo-fator:${e.userId}`]);
    const ligado = await api.call('PUT', '/v1/direct/settings', { cookie: e.cookie, body: { brand_id: e.brandId, enabled: true, no_other_app: true, code: totpCode(e.secret, currentStep()) } });
    if (ligado.status !== 200) throw new Error(`Direct não ligado: ${ligado.status} ${JSON.stringify(ligado.body)}`);
    return e;
  }
  const ler = async (e: EmpresaComCanais) => (await fila.executarLote(10, { tenantIds: [e.tenantId] })).filter((r) => r.conta === e.instagram!.id);
  const pedir = (e: EmpresaComCanais, conversa: string, previous?: { focus: string; text: string }[]) =>
    api.call('POST', `/v1/direct/conversations/${conversa}/suggestion`, { cookie: e.cookie, body: { brand_id: e.brandId, ...(previous ? { previous } : {}) } });
  const responder = (r: Record<string, unknown>) => {
    const mock = responde(JSON.stringify(r));
    modelos.porChave.set(`${alvo.provider}/${alvo.model}`, mock);
    return mock;
  };
  const recusas = (usageId: string | null) =>
    ownerQuery<{ member: string; workflow: string; kind: string; rules: string[]; items: number }>(`select member, workflow, kind, rules, items from liame.ai_refusal where usage_id = $1`, [usageId]);

  it('a pergunta: a sugestão conferida volta com "respondeu" ou com o que faltou; o modelo recebe a conversa sem o nome de usuário; a que cita quem escreveu não volta', async () => {
    const e = await empresa('Casa Brasa Sugestão Pergunta');
    const pagina = e.pagina!.externo;
    const ana = meta.escreveuNoDirect(pagina, { usuario: 'ana.paula_rj', texto: 'Oi, boa noite', minutos: 30 });
    meta.marcaNoDirect(ana, 'Oi! Como a gente pode ajudar?', 28);
    meta.escreveuNoDirect(pagina, { usuario: 'ana.paula_rj', texto: 'Quanto tá o combo de sexta?', minutos: 5 });
    expect((await ler(e))[0]).toMatchObject({ status: 'ok', conversas: 1 });

    const mock = responder({ sugestoes: [DA_PERGUNTA], respondida: 'sim', falta: '' });
    const r = await pedir(e, ana);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toEqual({
      origin: 'ia',
      reason: null,
      kind: 'pergunta',
      suggestions: [{ focus: DA_PERGUNTA.enfoque, text: DA_PERGUNTA.texto, check: 'passou' }],
      answered: true,
      missing: null,
      dropped: 0,
      retry_at: null,
      usage_id: expect.any(String),
    });
    // O que foi ao modelo: a conversa em "Pessoa" e "Marca", o canal, o tipo e Minha marca; nunca o nome de usuário.
    const enviado = JSON.stringify(mock.doGenerateCalls[0]!.prompt);
    expect(enviado).toContain('Pessoa: Oi, boa noite');
    expect(enviado).toContain('Marca: Oi! Como a gente pode ajudar?');
    expect(enviado).toContain('Pessoa: Quanto tá o combo de sexta?');
    expect(enviado).toContain('no Direct do Instagram');
    expect(enviado).toContain('Hamburgueria de bairro');
    expect(enviado).not.toContain('ana.paula_rj');
    // A chamada fica no uso de IA, na conta do Social media; nada foi guardado da sugestão nem enviado à Meta.
    const [uso] = await ownerQuery<{ task: string; workflow: string; prompt_version: string }>(`select task, workflow, prompt_version from liame.ai_usage where id = $1`, [(r.body as Sugestao).usage_id]);
    expect(uso).toEqual({ task: 'social_direct', workflow: 'social.direct', prompt_version: 'social.direct@1' });
    expect(await ownerQuery<{ n: number }>(`select count(*)::int as n from liame.direct_message where tenant_id = $1 and direction = 'saida' and body = $2`, [e.tenantId, DA_PERGUNTA.texto])).toEqual([{ n: 0 }]);

    // "Precisa de você": ele não soube responder, e diz o que Minha marca não tem.
    responder({ sugestoes: [{ enfoque: 'Confirma com a loja', texto: 'Oi! Vou confirmar o horário do feriado com a loja e te respondo por aqui.' }], respondida: 'nao', falta: 'o horário do feriado.' });
    expect((await pedir(e, ana)).body).toMatchObject({ origin: 'ia', kind: 'pergunta', answered: false, missing: 'o horário do feriado', dropped: 0 });
    // O "sim" com aviso da conferência (o tamanho acima do recomendado) não vira "Conferido".
    responder({ sugestoes: [{ enfoque: 'Responde', texto: `Oi! O Combo sexta sai por R$ 34,90. ${'Vem pedir o seu com a gente. '.repeat(12)}` }], respondida: 'sim', falta: '' });
    expect((await pedir(e, ana)).body).toMatchObject({ origin: 'ia', answered: false, missing: null, suggestions: [{ check: 'aviso' }] });

    // A que cita quem escreveu, a que promete compensação e a que inventa número não voltam; contam em Sua equipe, sem o texto.
    responder({ sugestoes: [{ enfoque: 'Responde', texto: 'Oi, ana.paula_rj! O Combo sexta sai por R$ 34,90.' }], respondida: 'sim', falta: '' });
    const citou = (await pedir(e, ana)).body as Sugestao;
    expect(citou).toMatchObject({ origin: 'sem_ia', reason: 'barrado', kind: 'pergunta', suggestions: [], dropped: 1 });
    expect(await recusas(citou.usage_id)).toEqual([{ member: 'social', workflow: 'social.direct', kind: 'compliance', rules: ['nome'], items: 1 }]);
    responder({ sugestoes: [{ enfoque: 'Responde', texto: 'Oi! Hoje o Combo sexta sai por R$ 24,90 e a batata é por nossa conta.' }], respondida: 'sim', falta: '' });
    const inventou = (await pedir(e, ana)).body as Sugestao;
    expect(inventou).toMatchObject({ origin: 'sem_ia', reason: 'barrado', dropped: 1 });
    expect((await recusas(inventou.usage_id))[0]!.rules.sort()).toEqual(['compensacao', 'numero_fora']);
    // Fora do formato (sem a `falta`): o gateway não aceita a resposta, e a rota volta sem IA, sem sugestão nenhuma.
    responder({ sugestoes: [DA_PERGUNTA], respondida: 'sim' });
    expect((await pedir(e, ana)).body).toMatchObject({ origin: 'sem_ia', reason: 'indisponivel', suggestions: [] });

    // O "Pedir outra": a que a pessoa já viu vai no contexto, e a nova que a repete não volta.
    const outra = responder({ sugestoes: [{ enfoque: 'Responde de outro jeito', texto: 'Oi! Às sextas, o Combo sexta leva smash, batata e refri e sai por R$ 34,90.' }], respondida: 'sim', falta: '' });
    const vista = [{ focus: DA_PERGUNTA.enfoque, text: DA_PERGUNTA.texto }];
    expect((await pedir(e, ana, vista)).body).toMatchObject({ origin: 'ia', answered: true, suggestions: [{ focus: 'Responde de outro jeito', check: 'passou' }] });
    expect(JSON.stringify(outra.doGenerateCalls[0]!.prompt)).toContain(DA_PERGUNTA.texto);
    responder({ sugestoes: [DA_PERGUNTA], respondida: 'sim', falta: '' });
    expect((await pedir(e, ana, vista)).body).toMatchObject({ origin: 'sem_ia', reason: 'formato', dropped: 1 });
    expect(meta.defeitos).toEqual([]);
  }, 180_000);

  it('a reclamação: os três caminhos do Direct, na ordem; o caminho de outro nome fica de fora; o número do pedido que a pessoa mandou vale', async () => {
    const e = await empresa('Casa Brasa Sugestão Reclamação');
    const rui = meta.escreveuNoDirect(e.pagina!.externo, { usuario: 'rui.s', texto: 'Chegou frio e faltou a batata. Pedido 4821.', minutos: 7 });
    expect((await ler(e))[0]).toMatchObject({ status: 'ok' });
    // O modelo manda os caminhos fora de ordem e um a mais, de outro nome.
    const mock = responder({ sugestoes: [DA_RECLAMACAO[2], DA_RECLAMACAO[0], { enfoque: 'Oferecer uma solução', texto: 'Desculpa! Me conta o que você prefere.' }, DA_RECLAMACAO[1]], respondida: 'nao', falta: '' });
    const r = (await pedir(e, rui)).body as Sugestao;
    expect(r).toMatchObject({ origin: 'ia', reason: null, kind: 'reclamacao', answered: false, missing: null, dropped: 1 });
    expect(r.suggestions).toEqual(DA_RECLAMACAO.map((s) => ({ focus: s.enfoque, text: s.texto, check: 'passou' })));
    const enviado = JSON.stringify(mock.doGenerateCalls[0]!.prompt);
    expect(enviado).toContain('Pessoa: Chegou frio e faltou a batata. Pedido 4821.');
    for (const c of ENFOQUES_DA_RECLAMACAO_NO_DIRECT) expect(enviado).toContain(c);
    expect(enviado).not.toContain('rui.s');
    // Um caminho barrado (a compensação) sai; os outros dois voltam.
    responder({ sugestoes: [{ enfoque: C1, texto: 'Desculpa pelo pedido. A gente estorna o valor do pedido 4821.' }, DA_RECLAMACAO[1], DA_RECLAMACAO[2]], respondida: 'nao', falta: '' });
    const dois = (await pedir(e, rui)).body as Sugestao;
    expect(dois).toMatchObject({ origin: 'ia', kind: 'reclamacao', dropped: 1 });
    expect(dois.suggestions.map((s) => s.focus)).toEqual([C2, C3]);
    expect(await recusas(dois.usage_id)).toEqual([{ member: 'social', workflow: 'social.direct', kind: 'compliance', rules: ['compensacao'], items: 1 }]);
  }, 180_000);

  it('sem IA: o elogio não chama o modelo (tem a resposta pronta); a IA desligada; a conversa que não espera resposta e a que não existe recusam', async () => {
    const e = await empresa('Casa Brasa Sugestão Sem IA');
    const pagina = e.pagina!.externo;
    const carla = meta.escreveuNoDirect(pagina, { usuario: 'carla.m', texto: 'Que delícia esse smash!', minutos: 9 });
    const lucas = meta.escreveuNoDirect(pagina, { usuario: 'lucas_fern', texto: 'Tem combo pra 2?', minutos: 40 });
    meta.marcaNoDirect(lucas, 'Tem sim! O Combo duplo serve bem duas pessoas.', 30);
    expect((await ler(e))[0]).toMatchObject({ status: 'ok', conversas: 2 });
    const mock = responder({ sugestoes: [DA_PERGUNTA], respondida: 'sim', falta: '' });
    expect((await pedir(e, carla)).body).toEqual({ origin: 'sem_ia', reason: 'tipo_sem_ia', kind: null, suggestions: [], answered: false, missing: null, dropped: 0, retry_at: null, usage_id: null });
    const respondida = await pedir(e, lucas);
    expect([respondida.status, (respondida.body as { code?: string }).code]).toEqual([409, 'conversa-nao-espera']);
    const sumiu = await pedir(e, 'nao-existe');
    expect([sumiu.status, (sumiu.body as { code?: string }).code]).toEqual([404, 'nao-encontrado']);
    expect(mock.doGenerateCalls).toHaveLength(0);

    const semIa = await empresa('Casa Brasa Sugestão IA Desligada', { ia: false });
    const ana = meta.escreveuNoDirect(semIa.pagina!.externo, { usuario: 'ana.paula_rj', texto: 'Vocês entregam na Lapa?', minutos: 5 });
    expect((await ler(semIa))[0]).toMatchObject({ status: 'ok' });
    expect((await pedir(semIa, ana)).body).toMatchObject({ origin: 'sem_ia', reason: 'ia_desligada', kind: 'pergunta', suggestions: [] });
    expect(mock.doGenerateCalls).toHaveLength(0);
  }, 180_000);
});
