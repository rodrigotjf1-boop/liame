import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  chaveDaFoto,
  chaveDaMiniatura,
  conferirMedidas,
  estreitaParaOInstagram,
  medidasOrientadas,
  orientacao,
  prefixoDaEmpresa,
  prefixoDaMarca,
  recorteDoInstagram,
  tipoPeloConteudo,
} from '../src/fotos/conferencia.js';
import { LADO_DA_MINIATURA, processarFoto, RecusaDaFoto } from '../src/fotos/processar.js';
import {
  ArmazemFechado,
  ArmazemIndisponivel,
  ArmazemNaMemoria,
  ArmazemNoDisco,
  ArmazemS3,
  criarArmazem,
  FalhaDoArmazem,
  type SdkDoS3,
} from '../src/imagens/armazem.js';

// A6 · Z4: a conferência da foto enviada (ADR-021, item 3; P20), a regravação com imagens de verdade, feitas aqui pelo
// próprio sharp, e o armazenamento de imagens nas quatro formas (memória, disco, S3 com o SDK de mentira e fechado).

const EMPRESA = '0192f1d4-3c1a-7b2e-9a10-5f1e2d3c4b5a';
const MARCA = '0192f1d4-3c1a-7b2e-9a10-5f1e2d3c4b5b';
const FOTO = '0192f1d4-3c1a-7b2e-9a10-5f1e2d3c4b5c';

function imagem(largura: number, altura: number, fundo = { r: 201, g: 139, b: 78 }, alfa = false) {
  return sharp({ create: { width: largura, height: altura, channels: alfa ? 4 : 3, background: alfa ? { ...fundo, alpha: 0.5 } : fundo } });
}

describe('a conferência da foto (funções puras)', () => {
  it('o tipo vem do conteúdo: JPEG, PNG e WebP passam; HEIC, AVIF, GIF, PDF e o vazio não', async () => {
    expect(tipoPeloConteudo(await imagem(10, 10).jpeg().toBuffer())).toBe('jpeg');
    expect(tipoPeloConteudo(await imagem(10, 10).png().toBuffer())).toBe('png');
    expect(tipoPeloConteudo(await imagem(10, 10).webp().toBuffer())).toBe('webp');
    expect(tipoPeloConteudo(await imagem(10, 10).gif().toBuffer())).toBe('outro');
    // A caixa `ftyp` de um HEIC (foto do iPhone) e a de um AVIF: só o primeiro é avisado como HEIC.
    const ftyp = (marca: string) => Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from(`ftyp${marca}`, 'latin1'), Buffer.alloc(12)]);
    expect(tipoPeloConteudo(ftyp('heic'))).toBe('heic');
    expect(tipoPeloConteudo(ftyp('mif1'))).toBe('heic');
    expect(tipoPeloConteudo(ftyp('avif'))).toBe('outro');
    expect(tipoPeloConteudo(Buffer.from('%PDF-1.7 ...', 'latin1'))).toBe('outro');
    expect(tipoPeloConteudo(Buffer.alloc(0))).toBe('outro');
  });

  it('as medidas: recusa abaixo de 600 px no lado menor e acima de 10.000 no maior', () => {
    expect(conferirMedidas(600, 600)).toBeNull();
    expect(conferirMedidas(599, 4000)).toBe('pequena');
    expect(conferirMedidas(10_000, 7_500)).toBeNull();
    expect(conferirMedidas(10_001, 7_500)).toBe('grande');
    expect(conferirMedidas(0, 800)).toBe('nao_abre');
  });

  it('a orientação da câmera: 5 a 8 giram a foto (as medidas trocam)', () => {
    expect(medidasOrientadas({ width: 4032, height: 3024, orientation: 6 })).toEqual({ largura: 3024, altura: 4032 });
    expect(medidasOrientadas({ width: 4032, height: 3024, orientation: 3 })).toEqual({ largura: 4032, altura: 3024 });
    expect(medidasOrientadas({ width: 4032, height: 3024 })).toEqual({ largura: 4032, altura: 3024 });
  });

  it('o aviso de nitidez é pela LARGURA, não pelo lado menor (ERR-152)', () => {
    // A horizontal baixa sai nítida: o Instagram a mostra com 1.080 de largura, reduzida.
    expect(estreitaParaOInstagram(1600)).toBe(false);
    // A em pé estreita é ampliada lá.
    expect(estreitaParaOInstagram(1000)).toBe(true);
    expect(estreitaParaOInstagram(1079)).toBe(true);
    expect(estreitaParaOInstagram(1080)).toBe(false);
  });

  it('a orientação e o recorte que o Instagram vai pedir (de 4:5 a 1,91:1)', () => {
    expect(orientacao(1080, 1080)).toBe('quadrada');
    expect(orientacao(1600, 900)).toBe('horizontal');
    expect(orientacao(1200, 1600)).toBe('vertical');
    expect(recorteDoInstagram(1080, 1350)).toBe('nenhum');
    expect(recorteDoInstagram(1200, 1600)).toBe('alta');
    expect(recorteDoInstagram(1910, 1000)).toBe('nenhum');
    expect(recorteDoInstagram(4000, 2000)).toBe('larga');
  });

  it('a chave do objeto começa pela empresa e pela marca: apagar uma das duas é apagar um prefixo', () => {
    const chave = chaveDaFoto(EMPRESA, MARCA, FOTO);
    expect(chave).toBe(`t/${EMPRESA}/b/${MARCA}/foto_produto/${FOTO}.jpg`);
    expect(chaveDaMiniatura(chave)).toBe(`t/${EMPRESA}/b/${MARCA}/foto_produto/${FOTO}-mini.jpg`);
    expect(chave.startsWith(prefixoDaMarca(EMPRESA, MARCA))).toBe(true);
    expect(chave.startsWith(prefixoDaEmpresa(EMPRESA))).toBe(true);
  });
});

describe('a regravação da foto (sharp de verdade)', () => {
  it('a foto do celular em pé (EXIF 6) vira JPEG de 2.048 px no lado maior, girada e sem os dados do celular', async () => {
    const enviada = await imagem(4032, 3024).withMetadata({ orientation: 6 }).jpeg({ quality: 90 }).toBuffer();
    expect((await sharp(enviada).metadata()).orientation).toBe(6);
    const f = await processarFoto(enviada);
    expect(f.copia).toMatchObject({ largura: 1536, altura: 2048 });
    const copia = await sharp(f.copia.bytes).metadata();
    expect(copia.format).toBe('jpeg');
    expect(copia.orientation).toBeUndefined();
    expect(copia.exif).toBeUndefined();
    expect(Math.min(f.miniatura.largura, f.miniatura.altura)).toBe(LADO_DA_MINIATURA);
    expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
    // O mesmo arquivo tem o mesmo hash: é assim que a foto repetida é achada.
    expect((await processarFoto(enviada)).sha256).toBe(f.sha256);
  });

  it('a foto pequena não é ampliada; o PNG com transparência vira JPEG com fundo branco', async () => {
    const f = await processarFoto(await imagem(900, 700, undefined, true).png().toBuffer());
    expect(f.copia).toMatchObject({ largura: 900, altura: 700 });
    const copia = await sharp(f.copia.bytes).metadata();
    expect(copia.format).toBe('jpeg');
    expect(copia.hasAlpha).toBe(false);
    expect((await processarFoto(await imagem(1600, 900).webp().toBuffer())).copia).toMatchObject({ largura: 1600, altura: 900 });
  });

  it('recusa com o motivo: HEIC, GIF, pequena demais, grande demais e o arquivo que não abre', async () => {
    const motivo = async (b: Buffer) => {
      try {
        await processarFoto(b);
        return 'passou';
      } catch (err) {
        return err instanceof RecusaDaFoto ? err.motivo : String(err);
      }
    };
    expect(await motivo(Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypheic', 'latin1'), Buffer.alloc(40)]))).toBe('heic');
    expect(await motivo(await imagem(800, 800).gif().toBuffer())).toBe('formato');
    expect(await motivo(await imagem(500, 500).jpeg().toBuffer())).toBe('pequena');
    expect(await motivo(await imagem(10_001, 600).jpeg().toBuffer())).toBe('grande');
    // Começa como JPEG e não é.
    expect(await motivo(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7)]))).toBe('nao_abre');
  });
});

describe('o armazenamento de imagens', () => {
  const chave = chaveDaFoto(EMPRESA, MARCA, FOTO);
  let pasta: string;

  beforeAll(async () => {
    pasta = await mkdtemp(join(tmpdir(), 'liame-imagens-'));
  });
  afterAll(async () => {
    await rm(pasta, { recursive: true, force: true });
  });

  it('na memória: grava, lê, apaga a chave e o prefixo; recusa chave e prefixo fora do desenho', async () => {
    const a = new ArmazemNaMemoria();
    await a.gravar(chave, Buffer.from('foto'));
    await a.gravar(chaveDaMiniatura(chave), Buffer.from('mini'));
    expect(await a.enderecoDeLeitura(chave, 300)).toBe(`memoria://imagens/${chave}?valido=300`);
    await expect(a.gravar('t/../outra/coisa.jpg', Buffer.from('x'))).rejects.toThrow('chave fora do formato');
    await expect(a.apagarPrefixo('t/')).rejects.toThrow('prefixo fora do formato');
    expect(await a.apagarPrefixo(prefixoDaMarca(EMPRESA, MARCA))).toBe(2);
    expect(a.objetos.size).toBe(0);
    await a.apagar([chave]);
  });

  it('no disco: a foto fica na pasta, o endereço é a própria imagem, e apagar o que já não existe não é erro', async () => {
    const a = new ArmazemNoDisco(pasta);
    await a.gravar(chave, Buffer.from('foto'));
    expect(await a.enderecoDeLeitura(chave, 300)).toBe(`data:image/jpeg;base64,${Buffer.from('foto').toString('base64')}`);
    await a.apagar([chave, chaveDaMiniatura(chave)]);
    await a.gravar(chave, Buffer.from('foto'));
    expect(await a.apagarPrefixo(prefixoDaEmpresa(EMPRESA))).toBe(1);
    expect(await a.apagarPrefixo(prefixoDaEmpresa(EMPRESA))).toBe(0);
  });

  it('no S3: grava JPEG privado, apaga em lotes de 1.000, lê o prefixo por páginas e assina por 5 minutos', async () => {
    const enviados: Array<{ tipo: string; input: Record<string, unknown> }> = [];
    const comando = (tipo: string) =>
      class {
        constructor(readonly input: Record<string, unknown>) {
          enviados.push({ tipo, input });
        }
      };
    const sdk = {
      PutObjectCommand: comando('put'),
      DeleteObjectsCommand: comando('delete'),
      ListObjectsV2Command: comando('list'),
      GetObjectCommand: comando('get'),
    } as unknown as SdkDoS3;
    const SEGUNDA = 'pagina-2';
    const paginas = [
      { Contents: [{ Key: chave }, { Key: chaveDaMiniatura(chave) }], IsTruncated: true, NextContinuationToken: SEGUNDA },
      { Contents: [{ Key: chave.replace(FOTO, '0192f1d4-3c1a-7b2e-9a10-5f1e2d3c4b5d') }], IsTruncated: false },
    ];
    const cliente = {
      async send(c: { input: Record<string, unknown> }) {
        const ultimo = enviados.at(-1);
        if (ultimo?.tipo === 'list') return paginas.shift();
        if (ultimo?.tipo === 'delete') return {};
        return c.input;
      },
    };
    const assinados: number[] = [];
    const a = new ArmazemS3(sdk, cliente, async (_c, _cmd, segundos) => (assinados.push(segundos), 'https://s3.exemplo/assinado'), 'liame-imagens-teste');
    await a.gravar(chave, Buffer.from('foto'));
    expect(enviados[0]).toMatchObject({ tipo: 'put', input: { Bucket: 'liame-imagens-teste', Key: chave, ContentType: 'image/jpeg', CacheControl: 'private, max-age=300' } });
    expect(await a.enderecoDeLeitura(chave, 300)).toBe('https://s3.exemplo/assinado');
    expect(assinados).toEqual([300]);
    expect(await a.apagarPrefixo(prefixoDaMarca(EMPRESA, MARCA))).toBe(3);
    const listas = enviados.filter((e) => e.tipo === 'list');
    expect(listas.map((l) => l.input.ContinuationToken)).toEqual([undefined, SEGUNDA]);
    const muitas = Array.from({ length: 1500 }, (_, i) => chaveDaFoto(EMPRESA, MARCA, `0192f1d4-3c1a-7b2e-9a10-${String(i).padStart(12, '0')}`));
    enviados.length = 0;
    await a.apagar(muitas);
    expect(enviados.map((e) => ((e.input.Delete as { Objects: unknown[] }).Objects).length)).toEqual([1000, 500]);
  });

  it('no S3: a recusa do S3 vira FalhaDoArmazem, só com o nome do erro (sem endereço nem credencial)', async () => {
    const sdk = { PutObjectCommand: class {}, DeleteObjectsCommand: class {}, ListObjectsV2Command: class {}, GetObjectCommand: class {} } as unknown as SdkDoS3;
    const recusa = Object.assign(new Error('Access Denied for https://bucket.s3/... X-Amz-Credential=AKIA'), { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } });
    const a = new ArmazemS3(sdk, { send: () => Promise.reject(recusa) }, async () => '', 'liame-imagens-teste');
    const erro = await a.gravar(chave, Buffer.from('x')).catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(FalhaDoArmazem);
    expect((erro as Error).message).toBe('S3: AccessDenied (403)');
    const parcial = new ArmazemS3(sdk, { send: async () => ({ Errors: [{ Code: 'AccessDenied' }] }) }, async () => '', 'liame-imagens-teste');
    await expect(parcial.apagar([chave])).rejects.toThrow('S3: 1 objeto(s) não apagado(s) (AccessDenied)');
  });

  it('a escolha pelo ambiente: memória nos testes; em produção, o S3, ou fechado sem o bucket; disco em produção não sobe', async () => {
    expect((await criarArmazem({ NODE_ENV: 'test' })).tipo).toBe('memoria');
    const fechado = await criarArmazem({ NODE_ENV: 'production' });
    expect(fechado).toBeInstanceOf(ArmazemFechado);
    expect(fechado.disponivel).toBe(false);
    await expect(fechado.gravar(chave, Buffer.from('x'))).rejects.toBeInstanceOf(ArmazemIndisponivel);
    await expect(criarArmazem({ NODE_ENV: 'production', IMAGENS_ARMAZEM: 'disco' })).rejects.toThrow('IMAGENS_ARMAZEM só pode ser s3');
    expect((await criarArmazem({ NODE_ENV: 'production', IMAGENS_BUCKET: 'liame-imagens-teste' })).tipo).toBe('s3');
    expect((await criarArmazem({ NODE_ENV: 'development', IMAGENS_PASTA_LOCAL: pasta })).tipo).toBe('disco');
  });
});
