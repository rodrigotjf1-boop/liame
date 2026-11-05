import { describe, expect, it } from 'vitest';
import { lerCabecalhoDoVideo, VideoIlegivel } from '../src/fotos/cabecalho-do-video.js';
import { chaveDaFoto, chaveDaMiniatura, chaveDoVideo, conferirVideo, RECUSAS_DO_VIDEO } from '../src/fotos/conferencia.js';
import { ArmazemFechado, ArmazemIndisponivel, ArmazemNaMemoria, ArmazemNoDisco, ArmazemS3, type SdkDoS3 } from '../src/imagens/armazem.js';
import { caixa, faixa, ftyp, leitorDe, mdat64, videoDeMentira } from './helpers/video-de-mentira.js';

// A6 · Z10, parte 1 (D-A6-68): o cabeçalho do vídeo que a loja envia, lido aos pedaços (a `moov` antes ou depois dos
// dados, a rotação do celular, o tamanho de 64 bits, o MOV), o que não é vídeo, a conferência (o tamanho, o codec, a
// duração e a resolução, com o vídeo deitado entrando) e as chaves do vídeo e da capa no armazenamento.

const E = '01a00000-0000-7000-8000-000000000001';
const M = '01a00000-0000-7000-8000-000000000002';
const ID = '01a00000-0000-7000-8000-000000000003';

const ler = async (arquivo: Buffer) => {
  const l = leitorDe(arquivo);
  const cabecalho = await lerCabecalhoDoVideo(l.ler, arquivo.length);
  return { cabecalho, lidos: l.lidos() };
};

describe('o cabeçalho do vídeo', () => {
  it('o vídeo do celular em pé: 30 s, 1080 x 1920, H.264 com áudio AAC', async () => {
    const { cabecalho } = await ler(videoDeMentira());
    expect(cabecalho).toEqual({ marca: 'isom', duracaoMs: 30_000, largura: 1080, altura: 1920, codec: 'avc1', temAudio: true, codecDoAudio: 'mp4a' });
  });

  it('a moov depois dos dados: o leitor pula a mdat pelo tamanho, sem ler os dados', async () => {
    const arquivo = videoDeMentira({ moovNoFim: true, dados: 2_000_000 });
    const { cabecalho, lidos } = await ler(arquivo);
    expect(cabecalho).toMatchObject({ duracaoMs: 30_000, largura: 1080, altura: 1920 });
    expect(lidos).toBeLessThan(5_000);
  });

  it('o celular grava deitado e manda girar: as medidas vêm na orientação em que o vídeo aparece', async () => {
    const { cabecalho } = await ler(videoDeMentira({ largura: 1920, altura: 1080, girada: true }));
    expect([cabecalho.largura, cabecalho.altura]).toEqual([1080, 1920]);
  });

  it('o tamanho de 64 bits da mdat e a duração em 64 bits (mvhd versão 1); o MOV do iPhone, sem áudio', async () => {
    const moov = caixa('moov', caixa('mvhd', Buffer.from([1, 0, 0, 0]), Buffer.alloc(16), Buffer.from([0, 0, 2, 88]), Buffer.from([0, 0, 0, 0, 0, 0, 0x8c, 0xa0]), Buffer.alloc(80)), faixa('vide', 'hvc1', 1080, 1920));
    const arquivo = Buffer.concat([ftyp('qt  '), mdat64(1000), moov]);
    const { cabecalho } = await ler(arquivo);
    expect(cabecalho).toEqual({ marca: 'qt  ', duracaoMs: 60_000, largura: 1080, altura: 1920, codec: 'hvc1', temAudio: false, codecDoAudio: null });
    expect((await ler(videoDeMentira({ versaoDoMvhd: 1, segundos: 12.5 }))).cabecalho.duracaoMs).toBe(12_500);
  });

  it('o que não é vídeo: outro arquivo, sem a moov, sem a faixa de vídeo, com o tamanho de caixa errado', async () => {
    const motivo = async (arquivo: Buffer) => {
      try {
        await ler(arquivo);
        return 'leu';
      } catch (e) {
        return e instanceof VideoIlegivel ? e.motivo : String(e);
      }
    };
    expect(await motivo(Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...Array.from({ length: 60 }, () => 0)]))).toBe('nao_e_video');
    expect(await motivo(Buffer.concat([ftyp(), caixa('mdat', Buffer.alloc(100))]))).toBe('sem_moov');
    expect(await motivo(Buffer.concat([ftyp(), caixa('moov', faixa('soun', 'mp4a')), caixa('mdat', Buffer.alloc(10))]))).toBe('sem_faixa_de_video');
    const quebrado = Buffer.concat([ftyp(), caixa('mdat', Buffer.alloc(10))]);
    quebrado.writeUInt32BE(9_999_999, ftyp().length);
    expect(await motivo(quebrado)).toBe('sem_moov');
    expect(await motivo(Buffer.alloc(8))).toBe('nao_e_video');
  });
});

describe('a conferência do vídeo (D-A6-68)', () => {
  const base = { duracaoMs: 30_000, largura: 1080, altura: 1920, codec: 'avc1', temAudio: true, codecDoAudio: 'mp4a' };

  it('o que entra: até 90 s, até 1080p nos dois lados, H.264 ou HEVC, com ou sem som; o deitado também', () => {
    expect(conferirVideo(base, 50_000_000)).toBeNull();
    expect(conferirVideo({ ...base, duracaoMs: 90_000 }, 1)).toBeNull();
    expect(conferirVideo({ ...base, duracaoMs: 3_000 }, 1)).toBeNull();
    expect(conferirVideo({ ...base, codec: 'hev1', temAudio: false, codecDoAudio: null }, 1)).toBeNull();
    expect(conferirVideo({ ...base, largura: 1920, altura: 1080 }, 1)).toBeNull();
    expect(conferirVideo(base, 300 * 1024 * 1024)).toBeNull();
  });

  it('o que não entra, cada um com o seu motivo', () => {
    expect(conferirVideo(base, 300 * 1024 * 1024 + 1)).toBe('grande');
    expect(conferirVideo({ ...base, codec: 'vp09' }, 1)).toBe('codec');
    expect(conferirVideo({ ...base, codecDoAudio: 'Opus' }, 1)).toBe('codec');
    expect(conferirVideo({ ...base, duracaoMs: 2_999 }, 1)).toBe('curto');
    expect(conferirVideo({ ...base, duracaoMs: 90_001 }, 1)).toBe('longo');
    expect(conferirVideo({ ...base, largura: 2160, altura: 3840 }, 1)).toBe('resolucao');
    expect(conferirVideo({ ...base, largura: 1440, altura: 2560 }, 1)).toBe('resolucao');
    expect(conferirVideo({ ...base, largura: 0 }, 1)).toBe('nao_abre');
  });

  it('os textos das recusas são os do P37, com os números dos limites', () => {
    expect(RECUSAS_DO_VIDEO.longo.detail).toBe('Passa de 90 segundos, o máximo para sair também como Reels na Página do Facebook. Corte no celular e envie de novo.');
    expect(RECUSAS_DO_VIDEO.grande.detail).toBe('Passa de 300 MB, o máximo do Reels. Grave em 1080p (não em 4K) ou corte no celular.');
    expect(RECUSAS_DO_VIDEO.curto.detail).toBe('Tem menos de 3 segundos, o mínimo do Reels.');
    expect(RECUSAS_DO_VIDEO.resolucao.detail).toBe('Passa de 1080p (1.920 px no lado maior), o máximo do Reels. Grave em 1080p (não em 4K) e envie de novo.');
    expect(new Set(Object.values(RECUSAS_DO_VIDEO).map((r) => r.code)).size).toBe(Object.keys(RECUSAS_DO_VIDEO).length);
  });
});

describe('as chaves do vídeo e da capa', () => {
  it('o vídeo ao lado das fotos da marca, e a capa como a miniatura dele; a foto como antes', async () => {
    expect(chaveDoVideo(E, M, ID, 'video/mp4')).toBe(`t/${E}/b/${M}/video/${ID}.mp4`);
    expect(chaveDoVideo(E, M, ID, 'video/quicktime')).toBe(`t/${E}/b/${M}/video/${ID}.mov`);
    expect(chaveDaMiniatura(chaveDoVideo(E, M, ID, 'video/quicktime'))).toBe(`t/${E}/b/${M}/video/${ID}-mini.jpg`);
    expect(chaveDaMiniatura(chaveDaFoto(E, M, ID))).toBe(`t/${E}/b/${M}/foto_produto/${ID}-mini.jpg`);
    // O armazenamento aceita as três chaves e recusa o que sai do desenho.
    const a = new ArmazemNaMemoria();
    a.chegou(chaveDoVideo(E, M, ID, 'video/mp4'), videoDeMentira());
    await a.gravar(chaveDaMiniatura(chaveDoVideo(E, M, ID, 'video/mp4')), Buffer.from('capa'));
    expect(await a.tamanho(chaveDoVideo(E, M, ID, 'video/mp4'))).toBe(videoDeMentira().length);
    expect(await a.tamanho(chaveDoVideo(E, M, ID, 'video/quicktime'))).toBeNull();
    expect((await a.lerTrecho(chaveDoVideo(E, M, ID, 'video/mp4'), 4, 7)).toString('latin1')).toBe('ftyp');
    await expect(a.lerTrecho(chaveDoVideo(E, M, ID, 'video/mp4'), 10, 5)).rejects.toThrow('trecho fora do desenho');
    await expect(a.enderecoDeEnvio(`t/${E}/b/${M}/video/${ID}.webm`, 'video/webm', 10, 600)).rejects.toThrow('chave fora do formato');
    expect(await a.enderecoDeEnvio(chaveDoVideo(E, M, ID, 'video/mp4'), 'video/mp4', 123_456, 600)).toBe(
      `memoria://envio/t/${E}/b/${M}/video/${ID}.mp4?tipo=video%2Fmp4&bytes=123456&valido=600`,
    );
  });
});

describe('o envio direto no S3 de verdade (o SDK e a assinatura, sem rede)', () => {
  it('assina o tipo e o tamanho declarado e não põe na URL o checksum do corpo vazio (o S3 recusaria o vídeo); a leitura segue como era', async () => {
    // O bucket no formato do de produção, com um número de conta de exemplo; o armazenamento montado como em produção.
    const BUCKET = 'liame-imagens-123456789012-sa-east-1-an';
    const ID_DE_TESTE = 'teste-id';
    const VALOR_DE_TESTE = 'teste-valor';
    const a = await ArmazemS3.criar('sa-east-1', BUCKET, { accessKeyId: ID_DE_TESTE, secretAccessKey: VALOR_DE_TESTE });
    const chave = chaveDoVideo(E, M, ID, 'video/mp4');
    const url = new URL((await a.enderecoDeEnvio(chave, 'video/mp4', 123_456, 600)) ?? 'sem:endereco');
    expect(url.origin).toBe(`https://${BUCKET}.s3.sa-east-1.amazonaws.com`);
    expect(url.pathname).toBe(`/${chave}`);
    expect(url.searchParams.get('X-Amz-Expires')).toBe('600');
    // O navegador manda o arquivo com estes dois cabeçalhos exatamente assim; outro tipo ou outro tamanho, o S3 recusa.
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('content-length;content-type;host');
    // O cliente padrão do SDK punha aqui o CRC32 do corpo vazio (`x-amz-checksum-crc32`), e o envio de verdade falharia.
    expect([...url.searchParams.keys()].filter((k) => /checksum/i.test(k))).toEqual([]);
    expect(new URL(await a.enderecoDeLeitura(chave, 300)).searchParams.get('X-Amz-SignedHeaders')).toBe('host');
    await expect(a.enderecoDeEnvio(chave, 'video/mp4', 0, 600)).rejects.toThrow('tamanho fora do desenho');
    await expect(a.enderecoDeEnvio(`t/${E}/b/${M}/video/${ID}.webm`, 'video/webm', 10, 600)).rejects.toThrow('chave fora do formato');
  });

  it('sem o assinador do envio (o S3 montado de outro jeito) e no disco do desenvolvimento, não há envio direto; fechado, indisponível', async () => {
    const chave = chaveDoVideo(E, M, ID, 'video/mp4');
    const semAssinador = new ArmazemS3({} as SdkDoS3, { send: async () => ({}) }, async () => 'https://s3.exemplo/assinado', 'liame-imagens-teste');
    expect(await semAssinador.enderecoDeEnvio(chave, 'video/mp4', 10, 600)).toBeNull();
    expect(await new ArmazemNoDisco('pasta-que-nao-e-usada').enderecoDeEnvio(chave)).toBeNull();
    await expect(new ArmazemFechado().enderecoDeEnvio()).rejects.toBeInstanceOf(ArmazemIndisponivel);
  });
});
