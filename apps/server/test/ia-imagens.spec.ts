import { describe, expect, it } from 'vitest';
import { BYTES_POR_IMAGEM_MAXIMOS, ehJpeg, IMAGENS_POR_PEDIDO_MAXIMAS, paraGuardar, problemaDasImagens, tokensDaImagem } from '../src/ai/imagens.js';

// As imagens no gateway de IA (A6, o vídeo com os cortes escolhidos pelo Social media; D-A6-82), sem rede e sem banco: só
// as tarefas da lista mandam imagem, só JPEG e dentro dos tetos; a estimativa de tokens pela regra publicada; e o pedido
// guardado sem a imagem.

const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xdb, 0, 1]);

describe('as imagens que vão ao modelo', () => {
  it('só a tarefa da lista, só JPEG, até 16 por pedido e até o teto de bytes', () => {
    expect(problemaDasImagens('explicar', [])).toBeNull();
    expect(problemaDasImagens('social_cortes', [{ jpeg: JPEG }])).toBeNull();
    expect(problemaDasImagens('explicar', [{ jpeg: JPEG }])).toBe('a tarefa explicar não manda imagem ao modelo');
    expect(problemaDasImagens('social_cortes', Array.from({ length: IMAGENS_POR_PEDIDO_MAXIMAS + 1 }, () => ({ jpeg: JPEG })))).toMatch(/acima do máximo de 16/);
    expect(problemaDasImagens('social_cortes', [{ jpeg: Uint8Array.from([0x89, 0x50, 0x4e, 0x47]) }])).toBe('imagem que não é JPEG');
    const grande = new Uint8Array(BYTES_POR_IMAGEM_MAXIMOS + 1);
    grande.set([0xff, 0xd8, 0xff]);
    expect(problemaDasImagens('social_cortes', [{ jpeg: grande }])).toMatch(/acima de 400000 bytes/);
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
        { role: 'user', content: [{ type: 'text', text: 'Escolha os cortes.' }, { type: 'image', image: JPEG, mediaType: 'image/jpeg' }] },
      ],
    };
    const g = paraGuardar(enviado);
    expect(g.messages[0]).toEqual({ role: 'user', content: 'só texto' });
    expect(g.messages[1]!.content).toEqual([
      { type: 'text', text: 'Escolha os cortes.' },
      { type: 'image', bytes: 6, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) },
    ]);
    expect(JSON.stringify(g)).not.toContain('"0":255');
  });
});
