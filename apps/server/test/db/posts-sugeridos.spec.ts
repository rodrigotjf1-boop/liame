import { randomUUID } from 'node:crypto';
import { createDatabase, type Database } from '@liame/database';
import { MockLanguageModelV4 } from 'ai/test';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AiGateway } from '../../src/ai/gateway.js';
import { ModelosIa } from '../../src/ai/modelos.js';
import { currentStep, totpCode } from '../../src/auth/totp.js';
import { loadConfig } from '../../src/config.js';
import { FlagService } from '../../src/flags/flag.service.js';
import { ARMAZEM_DE_IMAGENS, type ArmazemNaMemoria } from '../../src/imagens/armazem.js';
import { PostsService } from '../../src/posts/posts.service.js';
import { PostsSugeridosLoop } from '../../src/worker/posts-sugeridos-loop.js';
import { PostsSugeridosService } from '../../src/worker/posts-sugeridos.service.js';
import { ownerQuery, resetIpRateLimits, startApi, type TestApi } from '../helpers/api.js';
import * as ia from '../helpers/ia.js';
import { type EmpresaComCanais, empresaComCanais, fotoGuardada } from '../helpers/posts-semeados.js';
import { APP_URL, hasDb } from './env.js';

// A6 · Z6, os posts, parte 2 (D-A6-58 a D-A6-60; P21): a rotina dos posts do Social media, contra o Postgres e com o
// modelo de IA simulado (nenhum fornecedor é chamado). O que se prova aqui:
//   - abrir as vezes: amanhã e depois de amanhã (no fuso da empresa), o dia com item na pauta aprovada, uma vez só; o
//     "nada novo", o dia com post e a função desligada ficam de fora;
//   - a vez: o post na Agenda (a foto escolhida pela referência, o texto de cada canal, às 19h, o recorte no centro) e o
//     pedido em Aprovações, feito pelo funcionário em nome do dono, que espera a aprovação com o código do app; ao modelo
//     vão o item e as Fotos pelo produto e a descrição, nunca o arquivo;
//   - a conferência barra (o "grátis" que ninguém disse): nada vai para Aprovações, e o texto não fica guardado;
//   - o que fica para depois sem chamar o modelo (sem Fotos, sem canal, a função desligada) e o que acaba (o dia passou,
//     ganhou post, a pauta mudou, nenhuma foto combina); a resposta fora do formato conta tentativa.

const FUSO = 'America/Sao_Paulo';
const diaEmSP = (n: number, base = new Date()): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: FUSO, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(base.getTime() + n * 86_400_000));
const ITEM = 'Sexta do combo: smash, batata e refri para fechar a semana';
// A marca do teste não tem cardápio: sem o link do post, o "link da bio" seria barrado (`link_que_nao_existe`).
const IG = 'Sexta pede combo: smash, batata e refri para fechar a semana. 🍔\nPassa aqui no Centro.';
const FB = 'Sexta pede combo: smash, batata e refri para fechar a semana.\nPassa aqui no Centro.';
const CHAVES = ['posts_sugeridos', 'ia'];

type Vez = { id: string; day: string; status: string; reason: string | null; barred_by: string[] | null; post_id: string | null; action_id: string | null; usage_id: string | null; attempts: number };

describe.skipIf(!hasDb)('os posts do Social media (A6 · Z6, os posts, parte 2)', () => {
  let api: TestApi;
  let database: Database;
  let flags: FlagService;
  let armazem: ArmazemNaMemoria;
  let modelos: ia.ModelosDeTeste;
  let rota: { provider: string; model: string };
  let servico: PostsSugeridosService;
  let loop: PostsSugeridosLoop;

  /** O que o modelo simulado escreve, pelo pedido que recebeu (a mensagem e o contexto, como texto). */
  let responder: (pedido: string) => unknown = () => ({});
  const simulado = new MockLanguageModelV4({
    doGenerate: async (opcoes) => ({
      content: [{ type: 'text' as const, text: JSON.stringify(responder(JSON.stringify(opcoes.prompt))) }],
      finishReason: { unified: 'stop' as const, raw: undefined },
      usage: ia.uso(1500, 200),
      warnings: [],
    }),
  });
  /** A referência que o contexto deu à foto do produto (as mais novas primeiro: F1, F2…). */
  const refDo = (pedido: string, produto: string): string | null => {
    const marca = `produto \\"${produto}\\"`;
    const i = pedido.indexOf(marca);
    if (i < 0) return null;
    const antes = pedido.slice(0, i);
    const f = antes.lastIndexOf('- F');
    return f < 0 ? null : antes.slice(f + 2, antes.indexOf(':', f));
  };
  const comACombo = (pedido: string) => ({ foto: refDo(pedido, 'Combo sexta'), sem_foto: '', textos: [{ canal: 'instagram', texto: IG }, { canal: 'facebook', texto: FB }] });

  beforeAll(async () => {
    api = await startApi();
    await resetIpRateLimits();
    database = createDatabase({ connectionString: APP_URL, max: 8, applicationName: 'liame-test' });
    flags = api.app.get(FlagService);
    armazem = api.app.get(ARMAZEM_DE_IMAGENS);
    // O modelo de IA é o simulado: nenhum fornecedor é chamado. A rota da tarefa tem nome fixo e ninguém apaga (V76).
    modelos = new ia.ModelosDeTeste(loadConfig());
    api.app.get(ModelosIa).modelo = (provider, model) => modelos.modelo(provider, model);
    rota = await ia.rotaCompartilhada(modelos, 'social_post', simulado);
    servico = new PostsSugeridosService(database, flags, api.app.get(AiGateway), api.app.get(PostsService));
    loop = new PostsSugeridosLoop(database, servico);
  }, 120_000);
  beforeEach(async () => {
    responder = comACombo;
    modelos.porChave.set(`${rota.provider}/${rota.model}`, simulado);
    simulado.doGenerateCalls.length = 0;
    await resetIpRateLimits();
  });
  afterAll(async () => {
    await api?.close();
    await database?.close();
  });

  // ---------------------------------------------------------------- ajudantes
  async function ligarFlag(tenantId: string, flag: string, valor: boolean): Promise<void> {
    await ownerQuery(`delete from liame.feature_flag_rule where flag_key = $1 and scope_type = 'tenant' and scope_id = $2`, [flag, tenantId]);
    if (valor) await ownerQuery(`insert into liame.feature_flag_rule (id, flag_key, scope_type, scope_id, value, created_by) values (gen_random_uuid(), $1, 'tenant', $2, 'true'::jsonb, 'testes')`, [flag, tenantId]);
    flags.invalidate();
  }
  const dossie = {
    identity: { summary: 'Hamburgueria de bairro com smash feito na chapa', audience: 'Quem mora ou trabalha no Centro', differentiator: 'Pão feito na casa todo dia', since: '2019' },
    voice: { traits: ['Direta'], rules: ['Frases curtas.'], do_example: 'Bateu a fome? O smash sai da chapa rapidinho.', dont_example: '' },
    products: { items: ['Smash Clássico R$ 29,90'] },
    offers: { items: ['Combo sexta: smash, batata e refri por R$ 34,90'] },
    forbidden: { items: [] },
    competitors: { items: [] },
    region: { area: 'Centro e Lapa', pickup: true },
  };
  /** Um plano de pauta aprovado da marca, com a versão atual e os dias. */
  async function pauta(e: { tenantId: string; brandId: string }, dias: Array<{ day: string; item: string }>, status = 'aprovado'): Promise<string> {
    const id = randomUUID();
    const quando = new Date(Date.now() - 60_000).toISOString();
    await ownerQuery(
      `insert into liame.plan (id, tenant_id, brand_id, kind, title, status, version, expires_at, created_at, updated_at)
       values ($1, $2, $3, 'pauta', 'Pauta da semana', $4, 1, $5::timestamptz + interval '3 days', $5, $5)`,
      [id, e.tenantId, e.brandId, status, quando],
    );
    await ownerQuery(
      `insert into liame.plan_version (id, tenant_id, plan_id, version, content, risk, content_hash, author, created_at)
       values ($1, $2, $3, 1, $4::jsonb, 'baixo', $5, 'estrategista', $6)`,
      [randomUUID(), e.tenantId, id, JSON.stringify({ kind: 'pauta', days: dias }), 'a'.repeat(64), quando],
    );
    return id;
  }
  /** Uma foto pronta, com o produto e a descrição que a empresa escreveu. */
  async function foto(e: EmpresaComCanais, produto: string, descricao: string): Promise<string> {
    const f = await fotoGuardada(e, armazem, { largura: 1080, altura: 1080 });
    await ownerQuery(`update liame.brand_photo set product = $2, description = $3 where id = $1`, [f.id, produto, descricao]);
    return f.id;
  }
  /** A empresa com o Instagram e a Página, Minha marca salva, duas Fotos, a pauta aprovada de amanhã e as chaves ligadas. */
  async function empresa(nome: string, o: { chaves?: string[]; dias?: Array<{ day: string; item: string }>; fotos?: boolean } = {}) {
    const e = await empresaComCanais(api, nome);
    await ownerQuery(`update liame.organization set timezone = $2 where id = $1`, [e.tenantId, FUSO]);
    const salvo = await api.call('PUT', '/v1/brand-dossier', { cookie: e.cookie, body: { brand_id: e.brandId, base_version: 0, content: dossie } });
    expect(salvo.status, JSON.stringify(salvo.body)).toBe(200);
    const fotos = o.fotos === false ? null : { combo: await foto(e, 'Combo sexta', 'Smash, batata e refri na bandeja'), batata: await foto(e, 'Batata Rústica', 'Porção de batata com páprica') };
    const planId = await pauta(e, o.dias ?? [{ day: diaEmSP(1), item: ITEM }]);
    for (const flag of o.chaves ?? CHAVES) await ligarFlag(e.tenantId, flag, true);
    return { e, fotos, planId };
  }
  const vezes = (e: EmpresaComCanais) =>
    ownerQuery<Vez>(
      `select id, to_char(day, 'YYYY-MM-DD') as day, status, reason, barred_by, post_id, action_id, usage_id, attempts
         from liame.post_suggestion where tenant_id = $1 order by day, id`,
      [e.tenantId],
    );
  const trilha = (e: EmpresaComCanais, acao: string) => ownerQuery<{ resource_id: string; after: Record<string, unknown> }>(`select resource_id, "after" from liame.audit_event where tenant_id = $1 and action = $2 order by chain_seq`, [e.tenantId, acao]);
  const rodar = (e: EmpresaComCanais, agora = new Date()) => loop.executarLote(10, { tenantIds: [e.tenantId] }, agora);
  const abrir = async (e: EmpresaComCanais, agora = new Date()) => {
    await servico.abrirVezes(1000, agora);
    return vezes(e);
  };

  // ---------------------------------------------------------------- abrir as vezes

  it('abre a vez de amanhã e de depois de amanhã com item na pauta aprovada, uma vez só; o "nada novo", o dia fora e a função desligada ficam de fora', async () => {
    const { e } = await empresa('Brasa Abre Vezes', {
      chaves: [],
      dias: [
        { day: diaEmSP(1), item: ITEM },
        { day: diaEmSP(2), item: 'nada novo' },
        { day: diaEmSP(3), item: 'O milk-shake da tarde' },
      ],
    });
    // Com a função desligada, nada abre.
    expect(await abrir(e)).toEqual([]);
    for (const flag of CHAVES) await ligarFlag(e.tenantId, flag, true);
    expect((await abrir(e)).map((v) => [v.day, v.status])).toEqual([[diaEmSP(1), 'esperando']]);
    // A segunda volta não abre de novo.
    expect((await abrir(e)).length).toBe(1);
    // Depois de amanhã com item, e um post de uma pessoa nesse dia: não abre.
    const outra = await empresa('Brasa Dia Com Post', { dias: [{ day: diaEmSP(2), item: 'A batata da tarde' }] });
    const pessoa = await api.call('POST', '/v1/posts', {
      cookie: outra.e.cookie,
      body: { brand_id: outra.e.brandId, photo_id: outra.fotos!.batata, publish_at: `${diaEmSP(2)}T12:00:00-03:00`, channels: [{ channel: 'instagram', text: 'A batata da tarde.' }] },
    });
    expect(pessoa.status, JSON.stringify(pessoa.body)).toBe(201);
    expect(await abrir(outra.e)).toEqual([]);
  });

  // ---------------------------------------------------------------- a vez

  it('a vez vira o post na Agenda e o pedido em Aprovações, em nome do dono, às 19h, com a foto escolhida; o pedido espera o código do app', async () => {
    const { e, fotos } = await empresa('Brasa Propoe');
    const [vez] = await abrir(e);
    const r = await rodar(e);
    expect(r.map((x) => x.feito.status)).toEqual(['pronta']);
    const [v] = await vezes(e);
    expect(v).toMatchObject({ id: vez!.id, status: 'pronta', reason: null, attempts: 0 });
    expect(v!.post_id).not.toBeNull();
    expect(v!.usage_id).not.toBeNull();
    // O post: a foto do combo (a escolhida pela referência), às 19h do dia no fuso da empresa, o recorte no centro.
    const [post] = await ownerQuery<{ photo_id: string; publish_at: Date; crop_pos: number | null; action_id: string; created_by: string }>(
      `select photo_id, publish_at, crop_pos, action_id, created_by from liame.social_post where id = $1`,
      [v!.post_id],
    );
    expect(post).toMatchObject({ photo_id: fotos!.combo, action_id: v!.action_id, created_by: e.userId });
    expect(new Date(post!.publish_at).toISOString()).toBe(new Date(`${diaEmSP(1)}T19:00:00-03:00`).toISOString());
    const canais = await ownerQuery<{ channel: string; body: string; status: string }>(`select channel, body, status from liame.social_post_channel where post_id = $1 order by channel desc`, [v!.post_id]);
    expect(canais).toEqual([
      { channel: 'instagram', body: IG, status: 'aguardando' },
      { channel: 'facebook', body: FB, status: 'aguardando' },
    ]);
    // O pedido: o de publicar o post, do Social media em nome do dono, esperando a aprovação.
    const [pedido] = await ownerQuery<{ tool: string; status: string; actor_type: string; agent_key: string; requested_by: string; resource_id: string; plan_hash: string; mode: string }>(
      `select tool, status, actor_type, agent_key, requested_by, resource_id, plan_hash, mode from liame.action_request where id = $1`,
      [v!.action_id],
    );
    expect(pedido).toMatchObject({ tool: 'post_publicar', status: 'aguardando_aprovacao', actor_type: 'agent', agent_key: 'social', requested_by: e.userId, resource_id: `post:${v!.post_id}`, mode: 'APPROVAL' });
    // A trilha: só números e códigos, nada do texto.
    const [ev] = await trilha(e, 'post.propor');
    expect(ev).toMatchObject({ resource_id: v!.id, after: { post_id: v!.post_id, action_id: v!.action_id, canais: ['instagram', 'facebook'], agent_key: 'social' } });
    expect(JSON.stringify(ev!.after)).not.toContain('combo');
    // Ao modelo: o item e as Fotos pelo produto e a descrição; nunca o arquivo da foto.
    const vai = JSON.stringify(simulado.doGenerateCalls[0]!.prompt);
    expect(vai).toContain(ITEM);
    expect(vai).toContain('produto \\"Combo sexta\\"');
    expect(vai).not.toContain(fotos!.combo);
    expect(vai).not.toContain(fotos!.batata);
    // Na Agenda, o post do dia, esperando a aprovação; e o pedido aprova com o código do app.
    const agenda = await api.call('GET', `/v1/posts?brand_id=${e.brandId}&from=${diaEmSP(0)}&to=${diaEmSP(2)}`, { cookie: e.cookie });
    expect(agenda.body.items.map((p: { id: string; status: string }) => [p.id, p.status])).toEqual([[v!.post_id, 'esperando_aprovacao']]);
    await ownerQuery(`update liame.app_user set totp_last_step = null where id = $1`, [e.userId]);
    await ownerQuery(`delete from liame.rate_limit where key = $1`, [`segundo-fator:${e.userId}`]);
    const aprovado = await api.call('POST', `/v1/actions/${v!.action_id}/approve`, { cookie: e.cookie, body: { plan_hash: pedido!.plan_hash, code: totpCode(e.secret, currentStep()) } });
    expect(aprovado.status, JSON.stringify(aprovado.body)).toBe(200);
    // A vez que acabou não volta.
    expect(await rodar(e)).toEqual([]);
  });

  it('a conferência barra o "grátis" que ninguém disse: nada vai para Aprovações, e o texto não fica guardado', async () => {
    const { e } = await empresa('Brasa Barrada');
    await abrir(e);
    responder = (p) => ({ ...comACombo(p), textos: [{ canal: 'instagram', texto: 'Batata grátis no combo de sexta!' }, { canal: 'facebook', texto: FB }] });
    expect((await rodar(e)).map((x) => x.feito)).toEqual([{ status: 'barrada', itens: ['regras_do_post'] }]);
    expect(await vezes(e)).toMatchObject([{ status: 'barrada', reason: 'conferencia', barred_by: ['regras_do_post'], post_id: null, action_id: null }]);
    expect(await ownerQuery(`select 1 from liame.social_post where tenant_id = $1`, [e.tenantId])).toHaveLength(0);
    const [ev] = await trilha(e, 'post.barrar_proposta');
    expect(ev!.after).toMatchObject({ barred_by: ['regras_do_post'], findings: ['gratis_fora'] });
    expect(JSON.stringify(ev!.after)).not.toContain('Batata');
  });

  it('o que espera sem chamar o modelo (sem Fotos, sem canal, a função desligada) e o que acaba (nenhuma foto combina, a pauta mudou, o dia ganhou post, o dia chegou)', async () => {
    // Sem Fotos: espera uma hora, sem contar tentativa e sem chamar o modelo.
    const semFotos = await empresa('Brasa Sem Fotos', { fotos: false });
    await abrir(semFotos.e);
    expect((await rodar(semFotos.e)).map((x) => x.feito)).toEqual([{ status: 'esperando', motivo: 'sem_fotos' }]);
    // Sem canal: as duas contas caíram (a plataforma recusou a credencial).
    const semCanal = await empresa('Brasa Sem Canal');
    await abrir(semCanal.e);
    await ownerQuery(`update liame.connected_account set status = 'desconectada' where tenant_id = $1`, [semCanal.e.tenantId]);
    expect((await rodar(semCanal.e)).map((x) => x.feito)).toEqual([{ status: 'esperando', motivo: 'sem_canal' }]);
    // A função desligada depois de abrir.
    const desligada = await empresa('Brasa Desligada');
    await abrir(desligada.e);
    await ligarFlag(desligada.e.tenantId, 'posts_sugeridos', false);
    expect((await rodar(desligada.e)).map((x) => x.feito)).toEqual([{ status: 'esperando', motivo: 'funcao_desligada' }]);
    expect(simulado.doGenerateCalls).toHaveLength(0);
    expect((await vezes(desligada.e))[0]).toMatchObject({ status: 'esperando', attempts: 0 });

    // Nenhuma foto combina com o item: descartada, com o gasto de IA registrado.
    const semFoto = await empresa('Brasa Sem Foto Que Combine');
    await abrir(semFoto.e);
    responder = () => ({ foto: null, sem_foto: 'Nenhuma das Fotos mostra pizza.', textos: [] });
    expect((await rodar(semFoto.e)).map((x) => x.feito)).toEqual([{ status: 'descartada', motivo: 'sem_foto' }]);
    expect((await vezes(semFoto.e))[0]!.usage_id).not.toBeNull();

    // A pauta mudou (o plano foi recusado depois de a vez abrir): descartada.
    const mudou = await empresa('Brasa Pauta Mudou');
    await abrir(mudou.e);
    await ownerQuery(`update liame.plan set status = 'recusado' where id = $1`, [mudou.planId]);
    expect((await rodar(mudou.e)).map((x) => x.feito)).toEqual([{ status: 'descartada', motivo: 'pauta_mudou' }]);

    // O dia ganhou post de uma pessoa depois de a vez abrir: descartada, sem chamar o modelo.
    const comPost = await empresa('Brasa Ganhou Post');
    await abrir(comPost.e);
    const pessoa = await api.call('POST', '/v1/posts', {
      cookie: comPost.e.cookie,
      body: { brand_id: comPost.e.brandId, photo_id: comPost.fotos!.combo, publish_at: `${diaEmSP(1)}T12:00:00-03:00`, channels: [{ channel: 'instagram', text: 'O combo da sexta.' }] },
    });
    expect(pessoa.status, JSON.stringify(pessoa.body)).toBe(201);
    simulado.doGenerateCalls.length = 0;
    expect((await rodar(comPost.e)).map((x) => x.feito)).toEqual([{ status: 'descartada', motivo: 'dia_com_post' }]);
    expect(simulado.doGenerateCalls).toHaveLength(0);

    // O dia chegou sem a vez (a rotina parada): tarde demais.
    const tarde = await empresa('Brasa Dia Passou');
    await abrir(tarde.e);
    const amanha = new Date(Date.now() + 86_400_000);
    expect((await rodar(tarde.e, amanha)).map((x) => x.feito)).toEqual([{ status: 'descartada', motivo: 'dia_passou' }]);
  });

  it('a resposta fora do formato (para o gateway, nenhum modelo respondeu) conta tentativa e volta em 15 e em 30 minutos; na terceira, falha de vez', async () => {
    const { e } = await empresa('Brasa Fora Do Formato');
    await abrir(e);
    responder = () => ({ outra: 'coisa' });
    const agora = new Date();
    expect((await rodar(e, agora)).map((x) => x.feito)).toEqual([{ status: 'falhou', motivo: 'ia_fora_do_ar', deVez: false }]);
    // Antes da hora, nada.
    expect(await rodar(e, new Date(agora.getTime() + 10 * 60_000))).toEqual([]);
    const segunda = new Date(agora.getTime() + 16 * 60_000);
    expect((await rodar(e, segunda)).map((x) => x.feito)).toEqual([{ status: 'falhou', motivo: 'ia_fora_do_ar', deVez: false }]);
    expect((await rodar(e, new Date(segunda.getTime() + 31 * 60_000))).map((x) => x.feito)).toEqual([{ status: 'falhou', motivo: 'ia_fora_do_ar', deVez: true }]);
    expect(await vezes(e)).toMatchObject([{ status: 'falhou', reason: 'ia_fora_do_ar', attempts: 3, post_id: null, action_id: null }]);
    expect((await trilha(e, 'post.falhar_proposta')).map((t) => t.after)).toMatchObject([{ reason: 'ia_fora_do_ar', attempts: 3 }]);
  });

  it('V119: as regras da tabela', async () => {
    const { e } = await empresa('Brasa Regras', { chaves: [] });
    const base = { day: diaEmSP(1), status: 'esperando', reason: null as string | null, barred_by: null as string | null, attempts: 0, finished: false };
    const inserir = (c: Partial<typeof base>) => {
      const x = { ...base, ...c };
      return ownerQuery(
        `insert into liame.post_suggestion (id, tenant_id, brand_id, day, status, reason, barred_by, attempts, finished_at)
         values (gen_random_uuid(), $1, $2, $3::date, $4, $5, $6::text[], $7, case when $8::boolean then now() end) returning id`,
        [e.tenantId, e.brandId, x.day, x.status, x.reason, x.barred_by, x.attempts, x.finished],
      );
    };
    // O que passa: a que espera, sem fim; a pronta com o fim; a barrada com o que barrou.
    expect(await inserir({})).toHaveLength(1);
    await expect(inserir({})).rejects.toMatchObject({ code: '23505', constraint: 'post_suggestion_dia' });
    expect(await inserir({ day: diaEmSP(2), status: 'pronta', finished: true })).toHaveLength(1);
    expect(await inserir({ day: diaEmSP(3), status: 'barrada', reason: 'conferencia', barred_by: '{regras_do_post,numeros}', finished: true })).toHaveLength(1);
    // O que não passa, cada uma pela restrição dela (o Postgres confere em ordem alfabética e diz a primeira que falhou).
    const outro = diaEmSP(4);
    await expect(inserir({ day: outro, attempts: -1 })).rejects.toMatchObject({ code: '23514', constraint: 'post_suggestion_attempts_check' });
    await expect(inserir({ day: outro, status: 'barrada', finished: true })).rejects.toMatchObject({ code: '23514', constraint: 'post_suggestion_barrada' });
    await expect(inserir({ day: outro, barred_by: '{numeros}' })).rejects.toMatchObject({ code: '23514', constraint: 'post_suggestion_barrada' });
    await expect(inserir({ day: outro, status: 'barrada', barred_by: '{Regra}', finished: true })).rejects.toMatchObject({ code: '23514', constraint: 'post_suggestion_barred_by_check' });
    const vinteEUma = `{${Array.from({ length: 21 }, (_, i) => `regra_${'abcdefghijklmnopqrstu'[i]}`).join(',')}}`;
    await expect(inserir({ day: outro, status: 'barrada', barred_by: vinteEUma, finished: true })).rejects.toMatchObject({ code: '23514', constraint: 'post_suggestion_barred_by_check' });
    await expect(inserir({ day: outro, finished: true })).rejects.toMatchObject({ code: '23514', constraint: 'post_suggestion_fim' });
    await expect(inserir({ day: outro, status: 'descartada', reason: 'dia_passou' })).rejects.toMatchObject({ code: '23514', constraint: 'post_suggestion_fim' });
    await expect(inserir({ day: outro, reason: 'Funcao Desligada' })).rejects.toMatchObject({ code: '23514', constraint: 'post_suggestion_reason_check' });
    await expect(inserir({ day: outro, status: 'lida', finished: true })).rejects.toMatchObject({ code: '23514', constraint: 'post_suggestion_status_check' });
  });
});
