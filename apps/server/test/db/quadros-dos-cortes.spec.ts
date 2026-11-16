import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { type Database, runMigrations } from '@liame/database';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DATABASE } from '../../src/database/database.module.js';
import { chaveDaVersaoDoInstagram } from '../../src/fotos/versao-do-instagram.js';
import { carregarSharp } from '../../src/fotos/processar.js';
import { ARMAZEM_DE_IMAGENS, type ArmazemNaMemoria, chaveDoQuadroDosCortes } from '../../src/imagens/armazem.js';
import type { QuadroDoVideo } from '../../src/video/quadros.js';
import { ERRO_DOS_QUADROS, QuadrosDosCortes, quadrosPorVideo, type TirarQuadros } from '../../src/worker/quadros-dos-cortes.js';
import { enableMfa, ownerQuery, resetIpRateLimits, signupAndLogin, startApi, type TestApi } from '../helpers/api.js';
import { videoGuardado } from '../helpers/posts-semeados.js';
import { hasDb, OWNER_URL } from './env.js';

// Os quadros do pedido dos cortes (A6 · Z16, parte 3; D-A6-151), no serviço de montagem, com um tirador de quadros de
// mentira (o ffmpeg de verdade está em `test/video-quadros.spec.ts`): os 16 quadros divididos entre os vídeos, cada JPEG no
// armazenamento na ordem das chaves e o `frame_index` com o vídeo e o tempo; a cópia para o Instagram lida quando pronta;
// o vídeo que saiu de Fotos e o que não abre, pulados; nenhum quadro, `sem_quadros`; o pego há 10 minutos de novo (e o que
// a vez interrompida deixou, apagado); a 3ª tentativa parada, `parado`; e o devolvido à fila quando o serviço para.

type Empresa = { tenantId: string; brandId: string };

class TiradorDeMentira {
  /** O que cada chamada leu do arquivo (o conteúdo de teste diz se foi o original ou a cópia) e quantos pediu. */
  chamadas: { conteudo: string; quantos: number; duracaoMs: number }[] = [];
  /** O conteúdo de arquivo que falha (o vídeo que não abre). */
  falharCom: string | null = null;
  /** Quantos quadros saem no máximo (o `quadrosDoVideo` pula o quadro que não sai). */
  maximo: number | null = null;
  segurar: Promise<void> | null = null;
  private jpeg: Buffer | null = null;

  readonly tirar: TirarQuadros = async (arquivo, { quantos, duracaoMs }) => {
    const conteudo = (await readFile(arquivo)).toString('utf8');
    this.chamadas.push({ conteudo, quantos, duracaoMs });
    if (this.segurar) await this.segurar;
    if (this.falharCom && conteudo.includes(this.falharCom)) throw new Error('o ffprobe não abriu (de mentira)');
    if (!this.jpeg) {
      const sharp = await carregarSharp();
      this.jpeg = await sharp({ create: { width: 768, height: 432, channels: 3, background: '#5a2e14' } }).jpeg().toBuffer();
    }
    return Array.from({ length: Math.min(quantos, this.maximo ?? quantos) }, (_, i): QuadroDoVideo => ({ tempoMs: Math.round(((i + 0.5) * duracaoMs) / quantos), jpeg: new Uint8Array(this.jpeg!) }));
  };
}

describe.skipIf(!hasDb)('os quadros do pedido dos cortes (Z16, parte 3)', () => {
  let api: TestApi;
  let armazem: ArmazemNaMemoria;
  let tirador: TiradorDeMentira;
  let quadros: QuadrosDosCortes;

  beforeAll(async () => {
    await runMigrations({ connectionString: OWNER_URL, dir: resolve(process.cwd(), '../../packages/database/migrations') });
    api = await startApi();
    armazem = api.app.get(ARMAZEM_DE_IMAGENS) as ArmazemNaMemoria;
    tirador = new TiradorDeMentira();
    quadros = new QuadrosDosCortes(api.app.get(DATABASE) as Database, armazem, tirador.tirar);
  }, 120_000);
  beforeEach(async () => {
    await resetIpRateLimits();
    tirador.chamadas = [];
    tirador.falharCom = null;
    tirador.maximo = null;
    tirador.segurar = null;
  });
  afterAll(async () => {
    await api?.close();
  });

  async function empresa(nome: string): Promise<Empresa> {
    const s = await signupAndLogin(api, undefined, nome);
    await enableMfa(api, s.cookie);
    const tenantId = s.me.active_organization_id as string;
    const brandId = (await ownerQuery<{ id: string }>(`select id from liame.brand where tenant_id = $1 limit 1`, [tenantId]))[0]!.id;
    return { tenantId, brandId };
  }
  async function pedido(e: Empresa, mediaIds: string[], extra: { attempts?: number; startedMinAtras?: number } = {}): Promise<string> {
    const id = randomUUID();
    await ownerQuery(
      `insert into liame.video_cut_request (id, tenant_id, brand_id, media_ids, duration_s, attempts, started_at)
       values ($1, $2, $3, $4::uuid[], 15, $5, case when $6::int is null then null else now() - make_interval(mins => $6::int) end)`,
      [id, e.tenantId, e.brandId, `{${mediaIds.join(',')}}`, extra.attempts ?? 0, extra.startedMinAtras ?? null],
    );
    return id;
  }
  const linha = async (id: string) =>
    (
      await ownerQuery<{ status: string; frames: number | null; frame_index: { video: number; tempo_ms: number }[] | null; started_at: string | null; attempts: number; error: string | null }>(
        `select status, frames, frame_index, started_at, attempts, error from liame.video_cut_request where id = $1`,
        [id],
      )
    )[0]!;
  const escopo = (e: Empresa) => ({ tenantIds: [e.tenantId] });
  const chaves = (e: Empresa, id: string, n: number) => Array.from({ length: n }, (_, i) => chaveDoQuadroDosCortes(e.tenantId, e.brandId, id, i));

  it('os 16 quadros divididos entre os vídeos, gravados na ordem das chaves, com o vídeo e o tempo de cada um; a cópia para o Instagram quando pronta', async () => {
    expect([1, 2, 3, 4].map(quadrosPorVideo)).toEqual([16, 8, 5, 4]);
    const e = await empresa('Brasa Cortes Quadros');
    const v1 = await videoGuardado(e, armazem, { duracaoMs: 12_000, copia: 'pronta' });
    const v2 = await videoGuardado(e, armazem, { duracaoMs: 9_000 });
    const id = await pedido(e, [v1.id, v2.id]);

    expect(await quadros.vez(escopo(e))).toEqual({ id, situacao: 'quadros_prontos', quadros: 16 });
    // O primeiro vídeo foi lido pela cópia para o Instagram; o segundo, sem cópia, pelo original.
    expect(tirador.chamadas.map((c) => [c.conteudo.startsWith('copia-de-teste-'), c.quantos, c.duracaoMs])).toEqual([
      [true, 8, 12_000],
      [false, 8, 9_000],
    ]);
    const l = await linha(id);
    expect(l).toMatchObject({ status: 'quadros_prontos', frames: 16, started_at: null, attempts: 0, error: null });
    expect(l.frame_index!.map((q) => q.video)).toEqual([...Array(8).fill(0), ...Array(8).fill(1)]);
    expect(l.frame_index!.slice(0, 2).map((q) => q.tempo_ms)).toEqual([750, 2_250]);
    for (const chave of chaves(e, id, 16)) {
      expect(armazem.objetos.has(chave)).toBe(true);
      expect(armazem.tipos.get(chave)).toBe('image/jpeg');
    }
    expect(chaveDaVersaoDoInstagram(v1.chave)).toBe(v1.copia);
    // O que está pronto não volta à vez.
    expect(await quadros.vez(escopo(e))).toBeNull();
  }, 120_000);

  it('o vídeo que saiu de Fotos e o que não abre são pulados; sem quadro nenhum, falhou com sem_quadros', async () => {
    const e = await empresa('Brasa Cortes Pulados');
    const v1 = await videoGuardado(e, armazem, { duracaoMs: 12_000 });
    const v2 = await videoGuardado(e, armazem, { duracaoMs: 9_000 });
    const v3 = await videoGuardado(e, armazem, { duracaoMs: 6_000 });

    // O primeiro saiu de Fotos depois do pedido: os outros dois dividem os 16; o do meio não abre.
    const id = await pedido(e, [v1.id, v2.id, v3.id]);
    await ownerQuery(`update liame.brand_photo set removed_at = now() where id = $1`, [v1.id]);
    tirador.falharCom = v2.id;
    expect(await quadros.vez(escopo(e))).toEqual({ id, situacao: 'quadros_prontos', quadros: 8 });
    expect(tirador.chamadas.map((c) => c.quantos)).toEqual([8, 8]);
    // O índice guarda a posição na lista do pedido (o terceiro vídeo é o 2).
    expect((await linha(id)).frame_index!.map((q) => q.video)).toEqual(Array(8).fill(2));

    // Nenhum vídeo dá quadro: falhou, com o código.
    tirador.falharCom = 'video-de-teste-';
    const nada = await pedido(e, [v2.id, v3.id]);
    expect(await quadros.vez(escopo(e))).toEqual({ id: nada, situacao: 'falhou', quadros: 0 });
    expect(await linha(nada)).toMatchObject({ status: 'falhou', error: ERRO_DOS_QUADROS.semQuadros, frames: null, frame_index: null, started_at: null });
    expect(chaves(e, nada, 16).some((c) => armazem.objetos.has(c))).toBe(false);
  }, 120_000);

  it('o pego há 10 minutos volta à vez (o que a vez interrompida deixou sai); a 3ª tentativa parada falhou com parado', async () => {
    const e = await empresa('Brasa Cortes Parados');
    const v = await videoGuardado(e, armazem, { duracaoMs: 12_000 });
    const a = await videoGuardado(e, armazem, { duracaoMs: 12_000 });

    // Na vez há 2 minutos: ninguém pega.
    const recente = await pedido(e, [v.id], { attempts: 1, startedMinAtras: 2 });
    expect(await quadros.vez(escopo(e))).toBeNull();
    // Na vez há 11 minutos, na 1ª tentativa: volta à vez, e o quadro que a vez interrompida deixou (o 16º) sai.
    await ownerQuery(`update liame.video_cut_request set started_at = now() - interval '11 minutes' where id = $1`, [recente]);
    const sobra = chaveDoQuadroDosCortes(e.tenantId, e.brandId, recente, 15);
    await armazem.gravar(sobra, Buffer.from('quadro da vez interrompida'));
    // Desta vez saem só 4 quadros (os outros não saíram do vídeo): as chaves 0 a 3; a 16ª, que sobrou, não fica.
    tirador.maximo = 4;
    expect(await quadros.vez(escopo(e))).toEqual({ id: recente, situacao: 'quadros_prontos', quadros: 4 });
    expect(await linha(recente)).toMatchObject({ frames: 4, attempts: 0 });
    expect(armazem.objetos.has(sobra)).toBe(false);
    expect(chaves(e, recente, 4).every((c) => armazem.objetos.has(c))).toBe(true);

    // A 3ª tentativa parada há 11 minutos: não volta à vez; a rotina dos parados a dá como falhou, e os quadros saem.
    const parado = await pedido(e, [a.id], { attempts: 3, startedMinAtras: 11 });
    await armazem.gravar(chaveDoQuadroDosCortes(e.tenantId, e.brandId, parado, 0), Buffer.from('quadro que ficou'));
    expect(await quadros.vez(escopo(e))).toBeNull();
    expect(await quadros.soltarParados(escopo(e))).toEqual([parado]);
    expect(await linha(parado)).toMatchObject({ status: 'falhou', error: ERRO_DOS_QUADROS.parado, started_at: null });
    expect(armazem.objetos.has(chaveDoQuadroDosCortes(e.tenantId, e.brandId, parado, 0))).toBe(false);
  }, 120_000);

  it('o serviço vai parar no meio: o pedido volta à fila, os quadros desta vez saem, e o próximo serviço tira do começo', async () => {
    const e = await empresa('Brasa Cortes Devolvido');
    const v = await videoGuardado(e, armazem, { duracaoMs: 12_000 });
    const id = await pedido(e, [v.id]);
    let soltar: () => void = () => {};
    tirador.segurar = new Promise((r) => {
      soltar = r;
    });
    const emCurso = quadros.vez(escopo(e));
    await expect.poll(async () => (await linha(id)).started_at).not.toBeNull();
    expect(await quadros.devolverAtual()).toBe(id);
    expect(await linha(id)).toMatchObject({ status: 'pedido', started_at: null, attempts: 1 });
    soltar();
    expect(await emCurso).toEqual({ id, situacao: 'devolvido', quadros: 0 });
    expect(chaves(e, id, 16).some((c) => armazem.objetos.has(c))).toBe(false);
    // O próximo serviço tira do começo (2ª tentativa), e a tentativa zera para o worker.
    tirador.segurar = null;
    expect(await quadros.vez(escopo(e))).toEqual({ id, situacao: 'quadros_prontos', quadros: 16 });
    expect(await linha(id)).toMatchObject({ status: 'quadros_prontos', attempts: 0 });
  }, 120_000);
});
