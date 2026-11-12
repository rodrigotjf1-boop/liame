import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolve } from 'node:path';
import type { VideoRenderProps } from '@liame/contracts';
import { type Database, runMigrations } from '@liame/database';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DATABASE } from '../../src/database/database.module.js';
import { chaveDaMiniatura } from '../../src/fotos/conferencia.js';
import { carregarSharp } from '../../src/fotos/processar.js';
import { ARMAZEM_DE_IMAGENS, type ArmazemNaMemoria } from '../../src/imagens/armazem.js';
import { LacoDaMontagem, RenderModule } from '../../src/render/render.module.js';
import { MONTADOR, type Montador, type VideoMontadoNoDisco } from '../../src/video/montador.js';
import { FotosLoop } from '../../src/worker/fotos-loop.js';
import { MOTIVO, MontagemDoVideo } from '../../src/worker/montagem-do-video.js';
import { enableMfa, ownerQuery, resetIpRateLimits, signupAndLogin, startApi, type TestApi } from '../helpers/api.js';
import { ligarFlagDaEmpresa } from '../helpers/meta-de-mentira.js';
import { fotoGuardada } from '../helpers/posts-semeados.js';
import { hasDb, OWNER_URL } from './env.js';

// O serviço de montagem do vídeo (A6 · Z15, parte 2b; D-A6-139 a D-A6-141), com um montador de mentira (sem o Chrome;
// a montagem de verdade tem a fumaça no job `imagem` do CI): a fila de todas as marcas, na ordem de chegada; o pronto em
// Fotos (`montage_id`, o MP4 e a capa no armazenamento, a auditoria) e que não entra de novo numa montagem; o que falha,
// a foto que saiu antes, o pedido parado no meio, o devolvido à fila quando o serviço para; e o vídeo montado apagado em
// Fotos, que a rotina tira sem travar (0146).

type Empresa = { cookie: string; tenantId: string; brandId: string; userId: string };

const DOSSIE = {
  identity: { summary: 'Hamburgueria de bairro com smash feito na chapa', audience: 'Quem mora ou trabalha no Centro', differentiator: 'Pão feito na casa todo dia', since: '2019' },
  voice: { traits: ['Direta'], rules: ['Frases curtas.'], do_example: 'Bateu a fome? O smash sai da chapa rapidinho.', dont_example: '' },
  products: { items: ['Smash Clássico R$ 29,90'] },
  offers: { items: ['Combo sexta: smash, batata e refri por R$ 39,90'] },
  forbidden: { items: [] },
  region: { area: 'Centro e Lapa', pickup: true },
};

class MontadorDeMentira implements Montador {
  pedidos: VideoRenderProps[] = [];
  falhar = false;
  segurar: Promise<void> | null = null;

  async montar(props: VideoRenderProps, pasta: string, aoAndar: (a: number) => void): Promise<VideoMontadoNoDisco> {
    this.pedidos.push(props);
    aoAndar(0.5);
    if (this.segurar) await this.segurar;
    if (this.falhar) throw new Error('o Chrome caiu (de mentira)');
    const arquivo = join(pasta, 'video.mp4');
    await writeFile(arquivo, Buffer.from('mp4 de mentira'));
    const sharp = await carregarSharp();
    const capa = await sharp({ create: { width: 1080, height: 1920, channels: 3, background: '#5a2e14' } }).jpeg().toBuffer();
    return { arquivo, capa, largura: 1080, altura: 1920, duracaoMs: props.duration_s * 1000, temAudio: false };
  }
}

describe.skipIf(!hasDb)('o serviço de montagem do vídeo (Z15, parte 2b)', () => {
  let api: TestApi;
  let armazem: ArmazemNaMemoria;
  let montador: MontadorDeMentira;
  let montagem: MontagemDoVideo;
  let fotosLoop: FotosLoop;

  beforeAll(async () => {
    await runMigrations({ connectionString: OWNER_URL, dir: resolve(process.cwd(), '../../packages/database/migrations') });
    api = await startApi();
    armazem = api.app.get(ARMAZEM_DE_IMAGENS) as ArmazemNaMemoria;
    const database = api.app.get(DATABASE) as Database;
    montador = new MontadorDeMentira();
    montagem = new MontagemDoVideo(database, armazem, montador);
    fotosLoop = new FotosLoop(database, armazem);
  }, 120_000);
  beforeEach(async () => {
    await resetIpRateLimits();
    montador.pedidos = [];
    montador.falhar = false;
    montador.segurar = null;
  });
  afterAll(async () => {
    await api?.close();
  });

  async function empresa(nome: string): Promise<Empresa> {
    const s = await signupAndLogin(api, undefined, nome);
    await enableMfa(api, s.cookie);
    const tenantId = s.me.active_organization_id as string;
    const brandId = (await ownerQuery<{ id: string }>(`select id from liame.brand where tenant_id = $1 limit 1`, [tenantId]))[0]!.id;
    await ligarFlagDaEmpresa(api, 'fotos', tenantId, true);
    await ligarFlagDaEmpresa(api, 'videos', tenantId, true);
    await ligarFlagDaEmpresa(api, 'video_montado', tenantId, true);
    const salvo = await api.call('PUT', '/v1/brand-dossier', { cookie: s.cookie, body: { brand_id: brandId, base_version: 0, content: DOSSIE } });
    if (salvo.status !== 200) throw new Error(`dossiê não salvo: ${salvo.status} ${JSON.stringify(salvo.body)}`);
    return { cookie: s.cookie, tenantId, brandId, userId: s.me.user.id as string };
  }
  async function pedir(e: Empresa, fotos: string[], extra: Record<string, unknown> = {}): Promise<string> {
    const r = await api.call('POST', '/v1/video-montages', {
      cookie: e.cookie,
      body: { brand_id: e.brandId, template: 'destaque', format: '9x16', duration_s: 6, media_ids: fotos, title: 'Smash duplo na chapa', price_line: 'R$ 39,90', cta: 'Peça pelo link da bio', ...extra },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body.id as string;
  }
  const obter = async (e: Empresa, id: string) => (await api.call('GET', `/v1/video-montages/${id}`, { cookie: e.cookie })).body;
  const escopo = (...e: Empresa[]) => ({ tenantIds: e.map((x) => x.tenantId) });

  it('a fila de todas as marcas, na ordem de chegada; o pronto entra em Fotos e não entra de novo numa montagem', async () => {
    const a = await empresa('Brasa Montagem A');
    const b = await empresa('Brasa Montagem B');
    const fa = await fotoGuardada(a, armazem, { largura: 1080, altura: 1080 });
    const fb = await fotoGuardada(b, armazem, { largura: 1080, altura: 1350 });
    const a1 = await pedir(a, [fa.id]);
    const b1 = await pedir(b, [fb.id], { format: '4x5' });
    const a2 = await pedir(a, [fa.id], { duration_s: 10 });

    const vezes = [await montagem.vez(escopo(a, b)), await montagem.vez(escopo(a, b)), await montagem.vez(escopo(a, b)), await montagem.vez(escopo(a, b))];
    expect(vezes).toEqual([{ id: a1, situacao: 'pronto' }, { id: b1, situacao: 'pronto' }, { id: a2, situacao: 'pronto' }, null]);
    // O modelo recebe o pedido como foi conferido, com o endereço de leitura da foto.
    expect(montador.pedidos[1]).toMatchObject({ template: 'destaque', format: '4x5', duration_s: 6, title: 'Smash duplo na chapa', price_line: 'R$ 39,90', logo_url: null, sound: 'sem' });
    expect(montador.pedidos[1]!.media).toEqual([{ url: expect.any(String), kind: 'foto' }]);

    const pronto = await obter(a, a1);
    expect(pronto).toMatchObject({ status: 'pronto', progress: 100, error: null, queue_ahead: null, photo_id: expect.any(String) });
    const [linha] = await ownerQuery<{ kind: string; status: string; montage_id: string; uploaded_by: string; width: number; height: number; duration_ms: number; has_cover: boolean; media_type: string; object_key: string }>(
      `select kind, status, montage_id, uploaded_by, width, height, duration_ms, has_cover, media_type, object_key from liame.brand_photo where id = $1`,
      [pronto.photo_id],
    );
    expect(linha).toMatchObject({ kind: 'video', status: 'pronta', montage_id: a1, uploaded_by: a.userId, width: 1080, height: 1920, duration_ms: 6000, has_cover: true, media_type: 'video/mp4' });
    expect(armazem.tipos.get(linha!.object_key)).toBe('video/mp4');
    expect(armazem.objetos.has(chaveDaMiniatura(linha!.object_key))).toBe(true);
    // Em Fotos, como vídeo da marca; e a auditoria do sistema.
    const fotos = await api.call('GET', `/v1/brand-photos?brand_id=${a.brandId}`, { cookie: a.cookie });
    expect(fotos.body.items.map((i: { id: string }) => i.id)).toContain(pronto.photo_id);
    const [auditoria] = await ownerQuery<{ n: number }>(
      `select count(*)::int as n from liame.audit_event where tenant_id = $1 and action = 'video_montado.pronto' and resource_id = $2 and actor_type = 'system'`,
      [a.tenantId, a1],
    );
    expect(auditoria!.n).toBe(1);
    // O vídeo montado não entra de novo numa montagem.
    const deNovo = await api.call('POST', '/v1/video-montages', {
      cookie: a.cookie,
      body: { brand_id: a.brandId, template: 'novidade', format: '9x16', duration_s: 6, media_ids: [pronto.photo_id], title: 'Chegou', cta: 'Vem provar' },
    });
    expect(deNovo.body.code).toBe('midia-montada');
  }, 120_000);

  it('o que não deu: a montagem que falha, a foto que saiu antes e a logo que saiu, sem nada em Fotos', async () => {
    const e = await empresa('Brasa Montagem Falha');
    const f = await fotoGuardada(e, armazem, { largura: 1080, altura: 1080 });
    const antes = armazem.objetos.size;

    montador.falhar = true;
    const falhou = await pedir(e, [f.id]);
    expect(await montagem.vez(escopo(e))).toEqual({ id: falhou, situacao: 'nao_deu' });
    expect(await obter(e, falhou)).toMatchObject({ status: 'nao_deu', error: MOTIVO.falhou, photo_id: null });
    montador.falhar = false;

    // A logo pedida que saiu de Minha marca antes da montagem.
    await ownerQuery(`update liame.brand set logo_id = gen_random_uuid(), logo_width = 512, logo_height = 512, logo_updated_at = now() where id = $1`, [e.brandId]);
    const comLogo = await pedir(e, [f.id], { with_logo: true });
    await ownerQuery(`update liame.brand set logo_id = null, logo_width = null, logo_height = null, logo_updated_at = null where id = $1`, [e.brandId]);
    expect(await montagem.vez(escopo(e))).toEqual({ id: comLogo, situacao: 'nao_deu' });
    expect((await obter(e, comLogo)).error).toBe(MOTIVO.logo);

    // A foto apagada em Fotos depois do pedido.
    const saiu = await pedir(e, [f.id]);
    expect((await api.call('DELETE', `/v1/brand-photos/${f.id}`, { cookie: e.cookie })).status).toBe(204);
    expect(await montagem.vez(escopo(e))).toEqual({ id: saiu, situacao: 'nao_deu' });
    expect((await obter(e, saiu)).error).toBe(MOTIVO.foto);

    // O montador só foi chamado na que falhou; nada entrou em Fotos nem no armazenamento.
    expect(montador.pedidos).toHaveLength(1);
    const [n] = await ownerQuery<{ n: number }>(`select count(*)::int as n from liame.brand_photo where brand_id = $1 and montage_id is not null`, [e.brandId]);
    expect(n!.n).toBe(0);
    expect(armazem.objetos.size).toBe(antes);
  }, 120_000);

  it('o parado no meio não deu; o devolvido à fila quando o serviço para é montado do começo', async () => {
    const e = await empresa('Brasa Montagem Parada');
    const f = await fotoGuardada(e, armazem, { largura: 1080, altura: 1080 });

    const parado = await pedir(e, [f.id]);
    await ownerQuery(`update liame.video_montage set status = 'montando', started_at = now() - interval '20 minutes', updated_at = now() - interval '11 minutes' where id = $1`, [parado]);
    const recente = await pedir(e, [f.id]);
    await ownerQuery(`update liame.video_montage set status = 'montando', started_at = now(), updated_at = now() where id = $1`, [recente]);
    expect(await montagem.soltarParados(escopo(e))).toEqual([parado]);
    expect((await obter(e, parado)).error).toBe(MOTIVO.parou);
    expect((await obter(e, recente)).status).toBe('montando');
    await ownerQuery(`update liame.video_montage set status = 'nao_deu', error = 'fora do teste' where id = $1`, [recente]);

    // O serviço vai parar no meio da montagem: o pedido volta à fila, e o que a montagem terminar depois é descartado.
    const devolvido = await pedir(e, [f.id]);
    let soltar: () => void = () => {};
    montador.segurar = new Promise((r) => {
      soltar = r;
    });
    const emCurso = montagem.vez(escopo(e));
    await expect.poll(async () => (await obter(e, devolvido)).status).toBe('montando');
    expect(await montagem.devolverAtual()).toBe(devolvido);
    expect(await obter(e, devolvido)).toMatchObject({ status: 'na_fila', progress: 0, started_at: null });
    soltar();
    expect(await emCurso).toEqual({ id: devolvido, situacao: 'devolvido' });
    const [n] = await ownerQuery<{ n: number }>(`select count(*)::int as n from liame.brand_photo where montage_id = $1`, [devolvido]);
    expect(n!.n).toBe(0);
    // O próximo serviço monta do começo.
    montador.segurar = null;
    expect(await montagem.vez(escopo(e))).toEqual({ id: devolvido, situacao: 'pronto' });
  }, 120_000);

  it('o vídeo montado apagado em Fotos: a rotina tira a linha e o pedido fica pronto, sem o vídeo (0146)', async () => {
    const e = await empresa('Brasa Montagem Apagada');
    const f = await fotoGuardada(e, armazem, { largura: 1080, altura: 1080 });
    const id = await pedir(e, [f.id]);
    expect(await montagem.vez(escopo(e))).toEqual({ id, situacao: 'pronto' });
    const video = (await obter(e, id)).photo_id as string;
    expect((await api.call('DELETE', `/v1/brand-photos/${video}`, { cookie: e.cookie })).status).toBe(204);
    expect(await fotosLoop.executarLote(20, escopo(e))).toEqual([video]);
    expect(await obter(e, id)).toMatchObject({ status: 'pronto', photo_id: null });
  }, 120_000);

  it('o módulo do serviço resolve as dependências (com o montador de mentira no lugar do Remotion)', async () => {
    const m = await Test.createTestingModule({ imports: [RenderModule] }).overrideProvider(MONTADOR).useValue(new MontadorDeMentira()).overrideProvider(LacoDaMontagem).useValue({}).compile();
    expect(m.get(MontagemDoVideo)).toBeInstanceOf(MontagemDoVideo);
    await m.close();
  }, 60_000);
});
