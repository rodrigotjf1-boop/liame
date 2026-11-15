import { describe, expect, it } from 'vitest';
import { BYTES_POR_IMAGEM_MAXIMOS, ehJpeg, IMAGENS_POR_PEDIDO_MAXIMAS, medidasDoJpeg, paraGuardar, problemaDasImagens, tokensDaImagem } from '../src/ai/imagens.js';

// As imagens no gateway de IA (A6, o vídeo com os cortes escolhidos pelo Social media; D-A6-82), sem rede e sem banco: só
// as tarefas da lista mandam imagem, só JPEG, dentro dos tetos e com as medidas lidas do próprio arquivo; a estimativa de
// tokens pela regra publicada; e o pedido guardado sem a imagem.

/** Um JPEG mínimo com um segmento APP0 antes do SOF0 (como os de verdade), com a largura e a altura pedidas. */
const jpegDe = (largura: number, altura: number): Uint8Array =>
  Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x4a, 0x46, 0xff, 0xc0, 0x00, 0x11, 0x08, altura >> 8, altura & 255, largura >> 8, largura & 255, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xd9]);
const JPEG = jpegDe(768, 432);

describe('as imagens que vão ao modelo', () => {
  it('as medidas saem do SOF do próprio JPEG, pulando os segmentos antes dele; sem SOF, nada', () => {
    expect(medidasDoJpeg(JPEG)).toEqual({ largura: 768, altura: 432 });
    expect(medidasDoJpeg(jpegDe(432, 768))).toEqual({ largura: 432, altura: 768 });
    expect(medidasDoJpeg(Uint8Array.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02]))).toBeNull();
    expect(medidasDoJpeg(Uint8Array.from([0xff, 0xd8, 0xff, 0xc0, 0x00]))).toBeNull();
    expect(medidasDoJpeg(Uint8Array.from([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
  });

  it('só a tarefa da lista, só JPEG, até 16 por pedido, até o teto de bytes e até 768 px no lado maior', () => {
    expect(problemaDasImagens('explicar', [])).toBeNull();
    expect(problemaDasImagens('social_cortes', [{ jpeg: JPEG }])).toBeNull();
    expect(problemaDasImagens('explicar', [{ jpeg: JPEG }])).toBe('a tarefa explicar não manda imagem ao modelo');
    expect(problemaDasImagens('social_cortes', Array.from({ length: IMAGENS_POR_PEDIDO_MAXIMAS + 1 }, () => ({ jpeg: JPEG })))).toMatch(/acima do máximo de 16/);
    expect(problemaDasImagens('social_cortes', [{ jpeg: Uint8Array.from([0x89, 0x50, 0x4e, 0x47]) }])).toBe('imagem que não é JPEG');
    const grande = new Uint8Array(BYTES_POR_IMAGEM_MAXIMOS + 1);
    grande.set(JPEG);
    expect(problemaDasImagens('social_cortes', [{ jpeg: grande }])).toMatch(/acima de 400000 bytes/);
    expect(problemaDasImagens('social_cortes', [{ jpeg: jpegDe(1080, 1920) }])).toBe('imagem com 1920 px no lado maior, acima de 768');
    expect(problemaDasImagens('social_cortes', [{ jpeg: jpegDe(0, 432) }])).toBe('imagem sem as medidas no JPEG');
    expect(problemaDasImagens('social_cortes', [{ jpeg: Uint8Array.from([0xff, 0xd8, 0xff, 0xdb, 0, 1]) }])).toBe('imagem sem as medidas no JPEG');
    expect(ehJpeg(JPEG)).toBe(true);
  });

  it('os tokens de uma imagem: largura × altura / 750, arredondado para cima', () => {
    expect(tokensDaImagem(768, 432)).toBe(443);
    expect(tokensDaImagem(750, 1)).toBe(1);
  });

  it('o pedido guardado leva os bytes e o resumo de cada imagem, nunca ela; o resto fica igual', () => {
    const enviado = {
      instructions: 'x',
      messages: [
        { role: 'user', content: 'só texto' },
        { role: 'user', content: [{ type: 'text', text: 'Escolha os cortes.' }, { type: 'file', data: JPEG, mediaType: 'image/jpeg' }] },
        // A forma antiga (parte `image`, obsoleta no AI SDK) também não fica guardada.
        { role: 'user', content: [{ type: 'image', image: JPEG, mediaType: 'image/jpeg' }] },
      ],
    };
    const g = paraGuardar(enviado);
    expect(g.messages[0]).toEqual({ role: 'user', content: 'só texto' });
    expect(g.messages[1]!.content).toEqual([
      { type: 'text', text: 'Escolha os cortes.' },
      { type: 'image', bytes: JPEG.byteLength, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) },
    ]);
    expect(g.messages[2]!.content).toEqual([{ type: 'image', bytes: JPEG.byteLength, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) }]);
    expect(JSON.stringify(g)).not.toContain('"0":255');
  });
});
