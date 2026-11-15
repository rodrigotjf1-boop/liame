import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { type Database, runMigrations } from '@liame/database';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DATABASE } from '../../src/database/database.module.js';
import { chaveDaMiniatura } from '../../src/fotos/conferencia.js';
import { chaveDaVersaoDoInstagram } from '../../src/fotos/versao-do-instagram.js';
import { ARMAZEM_DE_IMAGENS, type ArmazemNaMemoria } from '../../src/imagens/armazem.js';
import { LacoDaMontagem, RenderModule } from '../../src/render/render.module.js';
import { REDUTOR, type Redutor, type VideoReduzidoNoDisco, VideoQueNaoReduz } from '../../src/video/redutor.js';
import { FotosLoop } from '../../src/worker/fotos-loop.js';
import { ReducaoDoVideo, TENTATIVAS_DA_REDUCAO } from '../../src/worker/reducao-do-video.js';
import { ownerQuery, resetIpRateLimits, signupAndLogin, startApi, type TestApi } from '../helpers/api.js';
import { videoGuardado } from '../helpers/posts-semeados.js';
import { hasDb, OWNER_URL } from './env.js';

// A cópia do vídeo para o Instagram (A6 · Z10, parte 3b; D-A6-149), no serviço de montagem, com um redutor de mentira (o
// ffmpeg de verdade tem o teste em `test/video-redutor.spec.ts`): a fila de todas as marcas, o mais antigo primeiro; a
// cópia ao lado do arquivo, com as medidas, o tamanho e a auditoria; a falha que volta à fila até a terceira tentativa e
// o arquivo que não reduz; o vídeo apagado no meio; o serviço que para no meio; a cópia parada; e a limpeza que leva a
// cópia junto com o vídeo.

type Empresa = { tenantId: string; brandId: string };

class RedutorDeMentira implements Redutor {
  entradas: Buffer[] = [];
  falhar: 'nao' | 'passageira' | 'definitiva' = 'nao';
  segurar: Promise<void> | null = null;

  async reduzir(entrada: string, pasta: string): Promise<VideoReduzidoNoDisco> {
    this.entradas.push(await readFile(entrada));
    if (this.segurar) await this.segurar;
    if (this.falhar === 'passageira') throw new Error('o ffmpeg caiu (de mentira)');
    if (this.falhar === 'definitiva') throw new VideoQueNaoReduz('não é vídeo (de mentira)');
    const arquivo = join(pasta, 'instagram.mp4');
    const bytes = Buffer.from('mp4 reduzido de mentira');
    await writeFile(arquivo, bytes);
    return { arquivo, largura: 1080, altura: 1920, duracaoMs: 24_000, bytes: bytes.length };
  }
}

describe.skipIf(!hasDb)('a cópia do vídeo para o Instagram (Z10, parte 3b)', () => {
  let api: TestApi;
  let armazem: ArmazemNaMemoria;
  let redutor: RedutorDeMentira;
  let reducao: ReducaoDoVideo;
  let fotosLoop: FotosLoop;

  beforeAll(async () => {
    await runMigrations({ connectionString: OWNER_URL, dir: resolve(process.cwd(), '../../packages/database/migrations') });
    api = await startApi();
    armazem = api.app.get(ARMAZEM_DE_IMAGENS) as ArmazemNaMemoria;
    const database = api.app.get(DATABASE) as Database;
    redutor = new RedutorDeMentira();
    reducao = new ReducaoDoVideo(database, armazem, redutor);
    fotosLoop = new FotosLoop(database, armazem);
  }, 120_000);
  beforeEach(async () => {
    await resetIpRateLimits();
    redutor.entradas = [];
    redutor.falhar = 'nao';
    redutor.segurar = null;
  });
  afterAll(async () => {
    await api?.close();
  });

  async function empresa(nome: string): Promise<Empresa> {
    const s = await signupAndLogin(api, undefined, nome);
    const tenantId = s.me.active_organization_id as string;
    const brandId = (await ownerQuery<{ id: string }>(`select id from liame.brand where tenant_id = $1 limit 1`, [tenantId]))[0]!.id;
    return { tenantId, brandId };
  }
  const escopo = (...e: Empresa[]) => ({ tenantIds: e.map((x) => x.tenantId) });
  const quatroK = { largura: 2160, altura: 3840, bytes: 150_000_000, duracaoMs: 24_000 } as const;
  const copiaDe = async (id: string) =>
    (
      await ownerQuery<{ instagram_status: string | null; instagram_bytes: string | null; instagram_width: number | null; instagram_height: number | null; instagram_attempts: number; started: boolean }>(
        `select instagram_status, instagram_bytes, instagram_width, instagram_height, instagram_attempts, instagram_started_at is not null as started from liame.brand_photo where id = $1`,
        [id],
      )
    )[0]!;
  const auditorias = async (e: Empresa, acao: string) =>
    ownerQuery<{ resource_id: string; after: Record<string, unknown> }>(
      `select resource_id, after from liame.audit_event where tenant_id = $1 and action = $2 and actor_type = 'system' order by chain_seq`,
      [e.tenantId, acao],
    );

  it('a fila de todas as marcas, o mais antigo primeiro; a cópia pronta ao lado do arquivo, com as medidas, o tamanho e a auditoria', async () => {
    const a = await empresa('Brasa Copia A');
    const b = await empresa('Brasa Copia B');
    const va = await videoGuardado(a, armazem, { ...quatroK, copia: 'na_fila' });
    const vb = await videoGuardado(b, armazem, { ...quatroK, copia: 'na_fila' });
    // O que cabe (sem fila) e o apagado na fila não entram.
    const cabe = await videoGuardado(a, armazem);
    const apagado = await videoGuardado(a, armazem, { ...quatroK, copia: 'na_fila' });
    await ownerQuery(`update liame.brand_photo set removed_at = now() where id = $1`, [apagado.id]);
    await ownerQuery(`update liame.brand_photo set created_at = now() - interval '1 minute' where id = $1`, [va.id]);

    expect(await reducao.vez(escopo(a, b))).toEqual({ id: va.id, situacao: 'pronta' });
    // O redutor recebeu o arquivo como a loja gravou.
    expect(redutor.entradas[0]?.equals(armazem.objetos.get(va.chave)!)).toBe(true);
    const chave = chaveDaVersaoDoInstagram(va.chave);
    expect(armazem.objetos.get(chave)?.toString()).toBe('mp4 reduzido de mentira');
    expect(await copiaDe(va.id)).toMatchObject({ instagram_status: 'pronta', instagram_bytes: '23', instagram_width: 1080, instagram_height: 1920, instagram_attempts: 1 });
    expect(await auditorias(a, 'fotos.video_instagram_pronto')).toEqual([
      { resource_id: va.id, after: { brand_id: a.brandId, width: 1080, height: 1920, bytes: 23, duration_ms: 24_000 } },
    ]);

    expect(await reducao.vez(escopo(a, b))).toEqual({ id: vb.id, situacao: 'pronta' });
    expect(await reducao.vez(escopo(a, b))).toBeNull();
    expect((await copiaDe(cabe.id)).instagram_status).toBeNull();
    expect((await copiaDe(apagado.id)).instagram_status).toBe('na_fila');
    expect(redutor.entradas).toHaveLength(2);
  });

  it('a falha volta à fila até a terceira tentativa, e então não deu; o arquivo que não reduz não deu na hora; nada fica no armazenamento', async () => {
    const e = await empresa('Brasa Copia Falha');
    const v = await videoGuardado(e, armazem, { ...quatroK, copia: 'na_fila' });
    redutor.falhar = 'passageira';
    for (let i = 1; i < TENTATIVAS_DA_REDUCAO; i += 1) {
      expect(await reducao.vez(escopo(e))).toEqual({ id: v.id, situacao: 'de_novo' });
      expect(await copiaDe(v.id)).toMatchObject({ instagram_status: 'na_fila', instagram_attempts: i, started: false });
    }
    expect(await reducao.vez(escopo(e))).toEqual({ id: v.id, situacao: 'nao_deu' });
    expect(await copiaDe(v.id)).toMatchObject({ instagram_status: 'nao_deu', instagram_attempts: TENTATIVAS_DA_REDUCAO, instagram_bytes: null });
    expect(await reducao.vez(escopo(e))).toBeNull();
    expect(await auditorias(e, 'fotos.video_instagram_nao_deu')).toEqual([{ resource_id: v.id, after: { brand_id: e.brandId, tentativas: TENTATIVAS_DA_REDUCAO } }]);

    const naoEVideo = await videoGuardado(e, armazem, { ...quatroK, copia: 'na_fila' });
    redutor.falhar = 'definitiva';
    expect(await reducao.vez(escopo(e))).toEqual({ id: naoEVideo.id, situacao: 'nao_deu' });
    expect(await copiaDe(naoEVideo.id)).toMatchObject({ instagram_status: 'nao_deu', instagram_attempts: 1 });
    expect(armazem.objetos.has(chaveDaVersaoDoInstagram(v.chave))).toBe(false);
    expect(armazem.objetos.has(chaveDaVersaoDoInstagram(naoEVideo.chave))).toBe(false);
  });

  it('o vídeo apagado no meio: a cópia desta vez sai do armazenamento; o serviço que para no meio devolve sem contar a tentativa', async () => {
    const e = await empresa('Brasa Copia Meio');
    const apagado = await videoGuardado(e, armazem, { ...quatroK, copia: 'na_fila' });
    let soltar: () => void = () => {};
    redutor.segurar = new Promise((r) => {
      soltar = r;
    });
    const emCurso = reducao.vez(escopo(e));
    await expect.poll(async () => (await copiaDe(apagado.id)).instagram_status).toBe('reduzindo');
    await ownerQuery(`update liame.brand_photo set removed_at = now() where id = $1`, [apagado.id]);
    soltar();
    expect(await emCurso).toEqual({ id: apagado.id, situacao: 'devolvido' });
    expect(armazem.objetos.has(chaveDaVersaoDoInstagram(apagado.chave))).toBe(false);

    // O serviço vai parar: o vídeo volta à fila, a tentativa não conta, e a cópia que terminar depois é descartada.
    const devolvido = await videoGuardado(e, armazem, { ...quatroK, copia: 'na_fila' });
    redutor.segurar = new Promise((r) => {
      soltar = r;
    });
    const outra = reducao.vez(escopo(e));
    await expect.poll(async () => (await copiaDe(devolvido.id)).instagram_status).toBe('reduzindo');
    expect(await reducao.devolverAtual()).toBe(devolvido.id);
    expect(await copiaDe(devolvido.id)).toMatchObject({ instagram_status: 'na_fila', instagram_attempts: 0, started: false });
    soltar();
    expect(await outra).toEqual({ id: devolvido.id, situacao: 'devolvido' });
    expect(armazem.objetos.has(chaveDaVersaoDoInstagram(devolvido.chave))).toBe(false);
    // O próximo serviço faz do começo.
    redutor.segurar = null;
    expect(await reducao.vez(escopo(e))).toEqual({ id: devolvido.id, situacao: 'pronta' });
  });

  it('a cópia parada há 30 minutos volta à fila (na terceira tentativa, não deu); a recente continua', async () => {
    const e = await empresa('Brasa Copia Parada');
    const parada = await videoGuardado(e, armazem, { ...quatroK, copia: 'reduzindo' });
    await ownerQuery(`update liame.brand_photo set instagram_started_at = now() - interval '31 minutes', instagram_attempts = 1 where id = $1`, [parada.id]);
    const ultima = await videoGuardado(e, armazem, { ...quatroK, copia: 'reduzindo' });
    await ownerQuery(`update liame.brand_photo set instagram_started_at = now() - interval '40 minutes', instagram_attempts = $2 where id = $1`, [ultima.id, TENTATIVAS_DA_REDUCAO]);
    const recente = await videoGuardado(e, armazem, { ...quatroK, copia: 'reduzindo' });
    await ownerQuery(`update liame.brand_photo set instagram_started_at = now() - interval '5 minutes', instagram_attempts = 1 where id = $1`, [recente.id]);
    expect((await reducao.soltarParados(escopo(e))).sort()).toEqual([parada.id, ultima.id].sort());
    expect(await copiaDe(parada.id)).toMatchObject({ instagram_status: 'na_fila', started: false });
    expect((await copiaDe(ultima.id)).instagram_status).toBe('nao_deu');
    expect((await copiaDe(recente.id)).instagram_status).toBe('reduzindo');
  });

  it('a limpeza leva a cópia junto com o vídeo apagado; a tabela recusa a cópia pronta sem as medidas e a cópia na foto', async () => {
    const e = await empresa('Brasa Copia Limpeza');
    const v = await videoGuardado(e, armazem, { ...quatroK, copia: 'pronta' });
    expect(armazem.objetos.has(v.copia!)).toBe(true);
    await ownerQuery(`update liame.brand_photo set removed_at = now() where id = $1`, [v.id]);
    expect(await fotosLoop.executarLote(20, escopo(e))).toEqual([v.id]);
    for (const chave of [v.chave, chaveDaMiniatura(v.chave), v.copia!]) expect(armazem.objetos.has(chave)).toBe(false);

    const outro = await videoGuardado(e, armazem, { ...quatroK, copia: 'na_fila' });
    await expect(ownerQuery(`update liame.brand_photo set instagram_status = 'pronta' where id = $1`, [outro.id])).rejects.toThrow(/brand_photo_instagram_pronta_check/);
    await expect(ownerQuery(`update liame.brand_photo set instagram_status = 'pronta', instagram_bytes = 10, instagram_width = 2160, instagram_height = 3840 where id = $1`, [outro.id])).rejects.toThrow(
      /brand_photo_instagram_pronta_check/,
    );
    await expect(ownerQuery(`update liame.brand_photo set instagram_status = 'jogado_fora' where id = $1`, [outro.id])).rejects.toThrow(/brand_photo_instagram_status_check/);
    const foto = await ownerQuery<{ id: string }>(
      `insert into liame.brand_photo (id, tenant_id, brand_id, status, object_key, sha256, bytes, width, height)
       values (gen_random_uuid(), $1, $2, 'pronta', 'foto-de-teste-' || gen_random_uuid(), repeat('a', 64), 1000, 100, 100) returning id`,
      [e.tenantId, e.brandId],
    );
    await expect(ownerQuery(`update liame.brand_photo set instagram_status = 'na_fila' where id = $1`, [foto[0]!.id])).rejects.toThrow(/brand_photo_instagram_status_check/);
  });

  it('o módulo do serviço resolve as dependências (com o redutor de mentira no lugar do ffmpeg)', async () => {
    const m = await Test.createTestingModule({ imports: [RenderModule] }).overrideProvider(REDUTOR).useValue(new RedutorDeMentira()).overrideProvider(LacoDaMontagem).useValue({}).compile();
    expect(m.get(ReducaoDoVideo)).toBeInstanceOf(ReducaoDoVideo);
    await m.close();
  }, 60_000);
});
