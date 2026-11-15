import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { type Database, runMigrations } from '@liame/database';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AiGateway } from '../../src/ai/gateway.js';
import { IMAGENS_POR_PEDIDO_MAXIMAS } from '../../src/ai/imagens.js';
import { ModelosIa } from '../../src/ai/modelos.js';
import { TAREFA_SOCIAL_CORTES, WORKFLOW_DO_SOCIAL_CORTES } from '../../src/ai/social/cortes.js';
import { APP_CONFIG } from '../../src/config.js';
import { DATABASE } from '../../src/database/database.module.js';
import { FlagService } from '../../src/flags/flag.service.js';
import { ARMAZEM_DE_IMAGENS, type ArmazemNaMemoria, chaveDoQuadroDosCortes, QUADROS_DOS_CORTES_MAXIMOS } from '../../src/imagens/armazem.js';
import { CortesDoSocialLoop } from '../../src/worker/cortes-do-social.js';
import { enableMfa, ownerQuery, resetIpRateLimits, signupAndLogin, startApi, type TestApi } from '../helpers/api.js';
import { ligarIa, ModelosDeTeste, responde, rotaCompartilhada } from '../helpers/ia.js';
import { ligarFlagDaEmpresa } from '../helpers/meta-de-mentira.js';
import { fotoGuardada, videoGuardado } from '../helpers/posts-semeados.js';
import { hasDb, OWNER_URL } from './env.js';

// Os melhores momentos (A6 · Z16, parte 3; P46; D-A6-150 a D-A6-154): o pedido dos cortes e a leitura pelo Social media,
// com o modelo simulado. As rotas: a função desligada, a foto em vez de vídeo, o vídeo curto, o pedido certo (201
// `pedido`, com quem pediu e a auditoria), a cadeia do "Pedir outros cortes" no limite e a outra empresa (404). O worker:
// os quadros que o serviço de montagem gravaria (JPEG com o SOF, como o gateway exige) vão ao modelo com o vídeo e o
// segundo; a proposta certa vira `pronta`, com os cortes nos vídeos de Fotos; a resposta que a régua recusa vira `falhou`
// com o motivo; a IA desligada e os quadros que não chegaram também; os quadros saem do armazém em todos os casos; a
// leitura parada volta à fila (ou falha na terceira vez) e o pedido esquecido há mais de uma hora falha, levando os quadros.

type Empresa = { cookie: string; tenantId: string; brandId: string; userId: string };

const DOSSIE = {
  identity: { summary: 'Hamburgueria de bairro com smash feito na chapa', audience: 'Quem mora ou trabalha no Centro', differentiator: 'Pão feito na casa todo dia', since: '2019' },
  voice: { traits: ['Direta'], rules: ['Frases curtas.'], do_example: 'Bateu a fome? O smash sai da chapa rapidinho.', dont_example: '' },
  products: { items: ['Smash Clássico R$ 29,90'] },
  offers: { items: ['Combo sexta: smash, batata e refri por R$ 39,90'] },
  forbidden: { items: [{ text: 'o melhor hambúrguer do Rio', why: 'não temos como provar' }] },
  region: { area: 'Centro e Lapa', pickup: true },
};

/** Um JPEG mínimo com um segmento APP0 antes do SOF0 (como os de verdade), com a largura e a altura pedidas. */
const jpegDe = (largura: number, altura: number): Buffer =>
  Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x4a, 0x46, 0xff, 0xc0, 0x00, 0x11, 0x08, altura >> 8, altura & 255, largura >> 8, largura & 255, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xd9]);
const QUADRO = jpegDe(768, 432);

describe.skipIf(!hasDb)('os melhores momentos: o pedido dos cortes e a leitura pelo Social media (Z16, parte 3)', () => {
  let api: TestApi;
  let database: Database;
  let armazem: ArmazemNaMemoria;
  let flags: FlagService;
  let modelos: ModelosDeTeste;
  let loop: CortesDoSocialLoop;
  let alvo: Awaited<ReturnType<typeof rotaCompartilhada>>;

  beforeAll(async () => {
    await runMigrations({ connectionString: OWNER_URL, dir: resolve(process.cwd(), '../../packages/database/migrations') });
    api = await startApi();
    database = api.app.get(DATABASE);
    armazem = api.app.get(ARMAZEM_DE_IMAGENS) as ArmazemNaMemoria;
    flags = api.app.get(FlagService);
    modelos = new ModelosDeTeste(api.app.get(APP_CONFIG));
    api.app.get(ModelosIa).modelo = (provider, model) => modelos.modelo(provider, model);
    // A rota da tarefa é compartilhada com o caso D-A6-82 do `ia-gateway.spec.ts`: o mesmo nome de modelo, e ninguém
    // aposenta a do outro (no CI os arquivos rodam juntos).
    alvo = await rotaCompartilhada(modelos, TAREFA_SOCIAL_CORTES, responde('{}'));
    loop = new CortesDoSocialLoop(database, armazem, api.app.get(AiGateway));
  }, 120_000);
  beforeEach(resetIpRateLimits);
  afterAll(async () => {
    await api?.close();
  });

  /**
   * A rota compartilhada da tarefa `social_cortes` de novo, logo antes de cada leitura, com o modelo simulado que o
   * `responder` acabou de ligar (a rota compartilhada não troca de dono: ninguém a aposenta).
   */
  async function garantirRota(): Promise<void> {
    await rotaCompartilhada(modelos, TAREFA_SOCIAL_CORTES, modelos.porChave.get(`${alvo.provider}/${alvo.model}`)!);
  }

  async function empresa(nome: string, o: { momentos?: boolean; ia?: boolean } = {}): Promise<Empresa> {
    const s = await signupAndLogin(api, undefined, nome);
    await enableMfa(api, s.cookie);
    const tenantId = s.me.active_organization_id as string;
    const brandId = (await ownerQuery<{ id: string }>(`select id from liame.brand where tenant_id = $1 limit 1`, [tenantId]))[0]!.id;
    await ligarFlagDaEmpresa(api, 'fotos', tenantId, true);
    if (o.momentos !== false) await ligarFlagDaEmpresa(api, 'video_momentos', tenantId, true);
    if (o.ia !== false) await ligarIa(flags, tenantId);
    const salvo = await api.call('PUT', '/v1/brand-dossier', { cookie: s.cookie, body: { brand_id: brandId, base_version: 0, content: DOSSIE } });
    if (salvo.status !== 200) throw new Error(`dossiê não salvo: ${salvo.status} ${JSON.stringify(salvo.body)}`);
    return { cookie: s.cookie, tenantId, brandId, userId: s.me.user.id as string };
  }
  async function video(e: Empresa, duracaoMs: number, produto: string | null = null): Promise<string> {
    const v = await videoGuardado(e, armazem, { duracaoMs });
    if (produto) await ownerQuery(`update liame.brand_photo set product = $2, description = 'Na chapa, saindo agora' where id = $1`, [v.id, produto]);
    return v.id;
  }
  const pedir = (e: Empresa, extra: Record<string, unknown>) =>
    api.call('POST', '/v1/video-montages/cuts', { cookie: e.cookie, body: { brand_id: e.brandId, duration_s: 10, ...extra } });
  const obter = (e: Empresa, id: string) => api.call('GET', `/v1/video-montages/cuts/${id}`, { cookie: e.cookie });
  const escopo = (...e: Empresa[]) => ({ tenantIds: e.map((x) => x.tenantId) });
  const responder = (r: unknown) => {
    const mock = responde(JSON.stringify(r));
    modelos.porChave.set(`${alvo.provider}/${alvo.model}`, mock);
    return mock;
  };
  /** O que o serviço de montagem faz (sessão LIAME): grava os quadros no armazém e marca `quadros_prontos` com o índice. */
  async function quadrosProntos(e: Empresa, id: string, indice: Array<{ video: number; tempo_ms: number }>, gravar = true): Promise<void> {
    if (gravar) for (const n of indice.keys()) await armazem.gravar(chaveDoQuadroDosCortes(e.tenantId, e.brandId, id, n), QUADRO);
    await ownerQuery(`update liame.video_cut_request set status = 'quadros_prontos', frames = $2, frame_index = $3::jsonb, updated_at = now() where id = $1`, [
      id,
      indice.length,
      JSON.stringify(indice),
    ]);
  }
  const quadrosNoArmazem = (id: string) => [...armazem.objetos.keys()].filter((k) => k.includes(`/cortes/${id}-`));
  const linha = async (id: string) =>
    (await ownerQuery<{ status: string; error: string | null; attempts: number; started_at: Date | null; created_by: string | null; previous_id: string | null }>(
      `select status, error, attempts, started_at, created_by, previous_id from liame.video_cut_request where id = $1`,
      [id],
    ))[0]!;

  it('a chave dos quadros: de 0 a 15, aceita pelo armazém; fora disso, recusada', async () => {
    expect(QUADROS_DOS_CORTES_MAXIMOS).toBe(IMAGENS_POR_PEDIDO_MAXIMAS);
    const [t, b, p] = [randomUUID(), randomUUID(), randomUUID()];
    expect(chaveDoQuadroDosCortes(t, b, p, 0)).toBe(`t/${t}/b/${b}/cortes/${p}-0.jpg`);
    await armazem.gravar(chaveDoQuadroDosCortes(t, b, p, 15), QUADRO);
    expect((await armazem.ler(`t/${t}/b/${b}/cortes/${p}-15.jpg`)).equals(QUADRO)).toBe(true);
    await armazem.apagar([chaveDoQuadroDosCortes(t, b, p, 15)]);
    expect(() => chaveDoQuadroDosCortes(t, b, p, 16)).toThrow('quadro fora do desenho');
    expect(() => chaveDoQuadroDosCortes(t, b, p, 1.5)).toThrow('quadro fora do desenho');
    for (const fora of [`${p}-16.jpg`, `${p}-01.jpg`, `${p}.jpg`, `${p}-1.png`, `nao-e-uuid-1.jpg`]) {
      await expect(armazem.gravar(`t/${t}/b/${b}/cortes/${fora}`, QUADRO)).rejects.toThrow('chave fora do formato');
    }
  });

  it('as recusas do pedido: a função desligada, a foto em vez de vídeo, o vídeo curto e o que o contrato não aceita', async () => {
    const desligada = await empresa('Brasa Cortes Desligada', { momentos: false });
    const vd = await video(desligada, 12_000);
    const r = await pedir(desligada, { media_ids: [vd] });
    expect([r.status, r.body.code]).toEqual([409, 'funcao-desligada']);

    const e = await empresa('Brasa Cortes Recusas');
    const foto = await fotoGuardada(e, armazem, { largura: 1080, altura: 1080 });
    const v = await video(e, 12_000);
    const comFoto = await pedir(e, { media_ids: [v, foto.id] });
    expect([comFoto.status, comFoto.body.code]).toEqual([422, 'so-videos']);
    const curto = await video(e, 2_500);
    const recusado = await pedir(e, { media_ids: [v, curto] });
    expect([recusado.status, recusado.body.code, recusado.body.detail]).toEqual([422, 'video-curto', 'Um dos vídeos tem 2 s: escolha vídeos com 3 s ou mais.']);
    // O contrato: sem repetir, de 1 a 4 vídeos, a duração de 10, 15 ou 20 segundos.
    expect((await pedir(e, { media_ids: [v, v] })).status).toBe(400);
    expect((await pedir(e, { media_ids: [] })).status).toBe(400);
    expect((await pedir(e, { media_ids: [v], duration_s: 12 })).status).toBe(400);
    // Nada foi gravado.
    expect(await ownerQuery(`select 1 from liame.video_cut_request where tenant_id in ($1, $2)`, [e.tenantId, desligada.tenantId])).toHaveLength(0);
  }, 120_000);

  it('o pedido certo: 201 `pedido`, com quem pediu e a auditoria; a leitura devolve o mesmo', async () => {
    const e = await empresa('Brasa Cortes Pedido');
    const [v1, v2] = [await video(e, 12_000), await video(e, 9_000)];
    const r = await pedir(e, { media_ids: [v1, v2], duration_s: 15 });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({ brand_id: e.brandId, media_ids: [v1, v2], duration_s: 15, status: 'pedido', cuts: null, total_ms: null, reason: null, others_left: 2 });
    expect(await linha(r.body.id)).toMatchObject({ status: 'pedido', created_by: e.userId, previous_id: null, attempts: 0, error: null });
    const [auditoria] = await ownerQuery<{ n: number }>(
      `select count(*)::int as n from liame.audit_event where tenant_id = $1 and action = 'video_cortes.pedir' and resource_type = 'video_cut_request' and resource_id = $2`,
      [e.tenantId, r.body.id],
    );
    expect(auditoria!.n).toBe(1);
    const g = await obter(e, r.body.id);
    expect(g.status).toBe(200);
    expect(g.body).toEqual(r.body);
  }, 120_000);

  it('o "Pedir outros cortes": até 2 vezes pela cadeia do pedido de antes; o de outra empresa não vale', async () => {
    const e = await empresa('Brasa Cortes Cadeia');
    const v = await video(e, 12_000);
    const a = await pedir(e, { media_ids: [v] });
    const b = await pedir(e, { media_ids: [v], previous_id: a.body.id });
    expect([b.status, b.body.others_left]).toEqual([201, 1]);
    const c = await pedir(e, { media_ids: [v], previous_id: b.body.id });
    expect([c.status, c.body.others_left]).toEqual([201, 0]);
    const d = await pedir(e, { media_ids: [v], previous_id: c.body.id });
    expect([d.status, d.body.code]).toEqual([409, 'outros-acabaram']);
    // A leitura de cada um diz quantos restam a partir dele.
    expect([(await obter(e, a.body.id)).body.others_left, (await obter(e, b.body.id)).body.others_left, (await obter(e, c.body.id)).body.others_left]).toEqual([2, 1, 0]);
    expect(await linha(c.body.id)).toMatchObject({ previous_id: b.body.id });

    const outra = await empresa('Brasa Cortes Cadeia Outra');
    const vo = await video(outra, 12_000);
    const dela = await pedir(outra, { media_ids: [vo] });
    const cruzado = await pedir(e, { media_ids: [v], previous_id: dela.body.id });
    expect([cruzado.status, cruzado.body.code]).toEqual([422, 'pedido-anterior-fora']);
  }, 120_000);

  it('o limite do dia: 10 pedidos por marca, deu ou não deu; o 11º recusa (409 `limite-do-dia`)', async () => {
    const e = await empresa('Brasa Cortes Limite');
    const v = await video(e, 12_000);
    for (let i = 0; i < 10; i++) expect((await pedir(e, { media_ids: [v] })).status).toBe(201);
    // O que falhou também conta: cada pedido tira os quadros e pode ter gastado a IA.
    await ownerQuery(`update liame.video_cut_request set status = 'falhou', error = 'sem_quadros' where id = (select id from liame.video_cut_request where brand_id = $1 order by created_at limit 1)`, [
      e.brandId,
    ]);
    const r = await pedir(e, { media_ids: [v] });
    expect([r.status, r.body.code, r.body.detail]).toEqual([409, 'limite-do-dia', 'A marca já pediu 10 vezes os cortes hoje: o limite volta à meia-noite.']);
    // O de ontem (no fuso da empresa) não conta.
    await ownerQuery(`update liame.video_cut_request set created_at = now() - interval '2 days' where id = (select id from liame.video_cut_request where brand_id = $1 order by created_at limit 1)`, [
      e.brandId,
    ]);
    expect((await pedir(e, { media_ids: [v] })).status).toBe(201);
  }, 120_000);

  it('outra empresa: a marca, o vídeo e o pedido de outra empresa não passam', async () => {
    const e = await empresa('Brasa Cortes Dona');
    const v = await video(e, 12_000);
    const meu = await pedir(e, { media_ids: [v] });
    const outra = await empresa('Brasa Cortes Vizinha');
    expect((await obter(outra, meu.body.id)).status).toBe(404);
    expect((await pedir(outra, { brand_id: e.brandId, media_ids: [v] })).status).toBe(404);
    const comVideoAlheio = await pedir(outra, { media_ids: [v] });
    expect([comVideoAlheio.status, comVideoAlheio.body.code]).toEqual([422, 'midia-fora-das-fotos']);
  }, 120_000);

  it('o worker: a proposta certa vira `pronta`, com os cortes nos vídeos de Fotos, e os quadros saem do armazém', async () => {
    const e = await empresa('Brasa Cortes Pronta');
    const [v1, v2] = [await video(e, 12_000, 'Smash Clássico'), await video(e, 9_000, 'Batata Rústica')];
    const id = (await pedir(e, { media_ids: [v1, v2] })).body.id as string;
    await quadrosProntos(e, id, [
      { video: 0, tempo_ms: 1_000 },
      { video: 1, tempo_ms: 3_000 },
      { video: 0, tempo_ms: 6_000 },
      { video: 1, tempo_ms: 7_000 },
    ]);
    expect(quadrosNoArmazem(id)).toHaveLength(4);
    const mock = responder({
      cortes: [
        { video: 2, inicio: 1, fim: 5, legenda: 'Batata saindo crocante' },
        { video: 1, inicio: 2, fim: 7.5, legenda: 'Smash pronto na chapa.' },
      ],
    });
    await garantirRota();
    expect(await loop.executarLote(3, escopo(e))).toEqual([{ id, situacao: 'pronta', motivo: null }]);

    const g = await obter(e, id);
    expect(g.body).toMatchObject({
      status: 'pronta',
      reason: null,
      total_ms: 9_500,
      // O vídeo de cada corte é o de Fotos (a posição em `media_ids`); o ponto final da legenda sai.
      cuts: [
        { media_id: v2, start_ms: 1_000, end_ms: 5_000, caption: 'Batata saindo crocante' },
        { media_id: v1, start_ms: 2_000, end_ms: 7_500, caption: 'Smash pronto na chapa' },
      ],
    });
    // Ao modelo: os quatro quadros como JPEG, cada um com o vídeo e o segundo, na ordem de cada vídeo.
    expect(mock.doGenerateCalls).toHaveLength(1);
    const enviado = JSON.stringify(mock.doGenerateCalls[0]!.prompt);
    expect(enviado.match(/image\/jpeg/g)).toHaveLength(4);
    for (const rotulo of ['Vídeo 1, 1,0 s:', 'Vídeo 1, 6,0 s:', 'Vídeo 2, 3,0 s:', 'Vídeo 2, 7,0 s:']) expect(enviado).toContain(rotulo);
    expect(enviado.indexOf('Vídeo 1, 6,0 s:')).toBeLessThan(enviado.indexOf('Vídeo 2, 3,0 s:'));
    expect(enviado).toContain('Smash Clássico');
    // O uso na conta do Social media nos cortes, de quem pediu.
    const [uso] = await ownerQuery<{ prompt_version: string; user_id: string; outcome: string }>(
      `select prompt_version, user_id, outcome from liame.ai_usage where tenant_id = $1 and workflow = $2 and task = $3`,
      [e.tenantId, WORKFLOW_DO_SOCIAL_CORTES, TAREFA_SOCIAL_CORTES],
    );
    expect(uso).toMatchObject({ prompt_version: 'social.cortes@1', user_id: e.userId, outcome: 'ok' });
    expect(quadrosNoArmazem(id)).toEqual([]);
    expect(await linha(id)).toMatchObject({ status: 'pronta', attempts: 1, error: null });
  }, 120_000);

  it('o worker: a resposta que a régua recusa, a IA desligada e os quadros que não chegaram viram `falhou` com o motivo, e os quadros saem', async () => {
    const e = await empresa('Brasa Cortes Falhou');
    const v = await video(e, 12_000, 'Smash Clássico');
    const ruim = (await pedir(e, { media_ids: [v] })).body.id as string;
    await quadrosProntos(e, ruim, [
      { video: 0, tempo_ms: 1_000 },
      { video: 0, tempo_ms: 8_000 },
    ]);
    // O primeiro corte tem 1 segundo: a régua recusa.
    const mock = responder({
      cortes: [
        { video: 1, inicio: 0, fim: 1, legenda: 'Smash na chapa' },
        { video: 1, inicio: 2, fim: 9, legenda: 'Pronto para comer' },
      ],
    });
    await garantirRota();
    expect(await loop.executarLote(3, escopo(e))).toEqual([{ id: ruim, situacao: 'falhou', motivo: 'corte_curto' }]);
    expect(mock.doGenerateCalls).toHaveLength(1);
    expect((await obter(e, ruim)).body).toMatchObject({ status: 'falhou', reason: 'corte_curto', cuts: null, total_ms: null });
    expect(quadrosNoArmazem(ruim)).toEqual([]);
    // A proposta recusada conta em Sua equipe, sem o texto.
    const [recusa] = await ownerQuery<{ member: string; kind: string }>(`select member, kind from liame.ai_refusal where tenant_id = $1 and workflow = $2`, [
      e.tenantId,
      WORKFLOW_DO_SOCIAL_CORTES,
    ]);
    expect(recusa).toEqual({ member: 'social', kind: 'corte_curto' });

    // Os quadros que o serviço de montagem não gravou: sem quadros, nada vai ao modelo.
    const semQuadros = (await pedir(e, { media_ids: [v] })).body.id as string;
    await quadrosProntos(e, semQuadros, [{ video: 0, tempo_ms: 1_000 }], false);
    expect(await loop.executarLote(3, escopo(e))).toEqual([{ id: semQuadros, situacao: 'falhou', motivo: 'sem_quadros' }]);
    expect((await obter(e, semQuadros)).body.reason).toBe('sem_quadros');

    // A IA desligada para a empresa: nada vai ao modelo, e os quadros saem.
    const semIa = await empresa('Brasa Cortes Sem IA', { ia: false });
    const vs = await video(semIa, 12_000);
    const desligada = (await pedir(semIa, { media_ids: [vs] })).body.id as string;
    await quadrosProntos(semIa, desligada, [{ video: 0, tempo_ms: 1_000 }]);
    expect(await loop.executarLote(3, escopo(semIa))).toEqual([{ id: desligada, situacao: 'falhou', motivo: 'ia_desligada' }]);
    expect((await obter(semIa, desligada)).body).toMatchObject({ status: 'falhou', reason: 'ia_desligada' });
    expect(quadrosNoArmazem(desligada)).toEqual([]);
    expect(mock.doGenerateCalls).toHaveLength(1);
  }, 120_000);

  it('a fila: leituras ao mesmo tempo não pegam o mesmo pedido, e o lote sai na ordem de chegada (V35, ERR-135)', async () => {
    // A IA desligada: cada leitura termina sem chamar o modelo, e o que importa é quem pegou o quê.
    const e = await empresa('Brasa Cortes Fila', { ia: false });
    const v = await video(e, 12_000);
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const id = (await pedir(e, { media_ids: [v] })).body.id as string;
      await quadrosProntos(e, id, [{ video: 0, tempo_ms: 1_000 }]);
      ids.push(id);
    }
    const vezes = (await Promise.all(Array.from({ length: 5 }, () => loop.executarLote(1, escopo(e))))).flat();
    expect(vezes.map((x) => x.id).sort()).toEqual([...ids].sort());
    // O lote de uma leitura só: na ordem em que os pedidos chegaram.
    const outros: string[] = [];
    for (let i = 0; i < 3; i++) {
      const id = (await pedir(e, { media_ids: [v] })).body.id as string;
      await quadrosProntos(e, id, [{ video: 0, tempo_ms: 1_000 }]);
      outros.push(id);
    }
    expect((await loop.executarLote(3, escopo(e))).map((x) => x.id)).toEqual(outros);
  }, 120_000);

  it('a leitura parada há 10 minutos volta à fila (na terceira tentativa, falha) e o pedido esquecido há mais de uma hora falha, levando os quadros', async () => {
    const e = await empresa('Brasa Cortes Parado');
    const v = await video(e, 12_000);
    const novo = async () => (await pedir(e, { media_ids: [v] })).body.id as string;
    const [volta, desiste, recente] = [await novo(), await novo(), await novo()];
    for (const id of [volta, desiste, recente]) await quadrosProntos(e, id, [{ video: 0, tempo_ms: 1_000 }]);
    await ownerQuery(`update liame.video_cut_request set status = 'lendo', started_at = now() - interval '11 minutes', attempts = 1 where id = $1`, [volta]);
    await ownerQuery(`update liame.video_cut_request set status = 'lendo', started_at = now() - interval '11 minutes', attempts = 3 where id = $1`, [desiste]);
    await ownerQuery(`update liame.video_cut_request set status = 'lendo', started_at = now() - interval '2 minutes', attempts = 1 where id = $1`, [recente]);

    expect(new Set(await loop.soltarParados(escopo(e)))).toEqual(new Set([volta, desiste]));
    // De volta à fila, com os quadros no armazém para a próxima vez.
    expect(await linha(volta)).toMatchObject({ status: 'quadros_prontos', started_at: null, attempts: 1 });
    expect(quadrosNoArmazem(volta)).toHaveLength(1);
    // Na terceira tentativa, falhou: os quadros saem.
    expect((await obter(e, desiste)).body).toMatchObject({ status: 'falhou', reason: 'parado' });
    expect(quadrosNoArmazem(desiste)).toEqual([]);
    expect(await linha(recente)).toMatchObject({ status: 'lendo' });

    // A limpeza: o pedido em `pedido` há mais de uma hora (com 2 quadros que o serviço de montagem chegou a gravar e o
    // `frames` ainda nulo) e o que espera o Social media há duas horas falham, e os quadros saem; o recente fica.
    const esperando = await novo();
    for (const n of [0, 1]) await armazem.gravar(chaveDoQuadroDosCortes(e.tenantId, e.brandId, esperando, n), QUADRO);
    expect(quadrosNoArmazem(esperando)).toHaveLength(2);
    expect(await ownerQuery(`select 1 from liame.video_cut_request where id = $1 and status = 'pedido' and frames is null`, [esperando])).toHaveLength(1);
    await ownerQuery(`update liame.video_cut_request set created_at = now() - interval '61 minutes' where id = $1`, [esperando]);
    await ownerQuery(`update liame.video_cut_request set created_at = now() - interval '2 hours' where id = $1`, [volta]);
    const fresco = await novo();
    expect(new Set(await loop.limpar(escopo(e)))).toEqual(new Set([esperando, volta]));
    for (const id of [esperando, volta]) {
      expect((await obter(e, id)).body).toMatchObject({ status: 'falhou', reason: 'parado' });
      expect(quadrosNoArmazem(id)).toEqual([]);
    }
    expect(await linha(fresco)).toMatchObject({ status: 'pedido' });
    // Nada mais a limpar.
    expect(await loop.limparLote(escopo(e))).toBe(0);
  }, 120_000);
});
