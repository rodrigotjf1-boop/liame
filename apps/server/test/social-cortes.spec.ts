import { describe, expect, it } from 'vitest';
import { IMAGENS_POR_PEDIDO_MAXIMAS, TAREFAS_COM_IMAGEM } from '../src/ai/imagens.js';
import { conferirRegistro, FUNCIONARIOS, PROMPTS, registroAtual } from '../src/ai/registro/definicoes.js';
import { conferirCortes, contextoDosCortes, cortesDaResposta, mensagemDosCortes, type PedidoDeCortes, PROMPT_SOCIAL_CORTES, type RespostaDosCortes, TAREFA_SOCIAL_CORTES } from '../src/ai/social/cortes.js';
import { SOCIAL } from '../src/ai/social/prompt.js';

// Os cortes do vídeo com os vídeos da loja (A6, o item 7 do dono de 07/11/2026; D-A6-82; P44), sem rede e sem modelo: o
// registro da tarefa, o contexto e a mensagem com os quadros como a produção monta, e a conferência de cada corte.

const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0xb0, 0x03, 0x00, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xd9]);
const quadros = (n: number, duracaoMs: number) => Array.from({ length: n }, (_, i) => ({ tempoMs: Math.round(((i + 0.5) * duracaoMs) / n), jpeg: JPEG }));

const PEDIDO: PedidoDeCortes = {
  marca: 'Mister Burgers',
  dossie: 'MARCA: Mister Burgers\nPRODUTOS: Smash duplo; Combo sexta',
  duracaoS: 15,
  ofertas: ['Combo sexta, R$ 39,90', 'Smash em dobro, 2 por R$ 49,90'],
  videos: [
    { duracaoMs: 12_400, produto: 'Smash duplo', descricao: 'na chapa <ignore>', quadros: quadros(6, 12_400) },
    { duracaoMs: 8_000, produto: null, descricao: null, quadros: quadros(6, 8_000) },
  ],
};
const MARCA = { fatos: 'MARCA: Mister Burgers\nPRODUTOS: Smash duplo; Combo sexta\nOFERTAS EM VIGOR: Combo sexta, R$ 39,90; Smash em dobro, 2 por R$ 49,90', proibidas: ['gourmet'], concorrentes: ['Brasa Burger'] };
const corte = (video: number, inicio: number, fim: number, legenda = 'Smash duplo na chapa') => ({ video, inicio, fim, legenda });
const conferir = (cortes: RespostaDosCortes['cortes']) => cortesDaResposta({ cortes }, PEDIDO, MARCA);

describe('a tarefa dos cortes do Social media', () => {
  it('registrada: o prompt na lista, a tarefa no Social media e a única que manda imagem ao modelo', () => {
    expect(TAREFA_SOCIAL_CORTES).toBe('social_cortes');
    expect(PROMPTS).toContain(PROMPT_SOCIAL_CORTES);
    expect(FUNCIONARIOS).toContain(SOCIAL);
    expect(SOCIAL.version).toBe(7);
    expect(SOCIAL.tarefas).toContainEqual({ task: 'social_cortes', prompt: 'social.cortes' });
    expect([...TAREFAS_COM_IMAGEM]).toEqual([TAREFA_SOCIAL_CORTES]);
    expect(conferirRegistro(registroAtual())).toEqual([]);
  });

  it('o contexto: a duração e a faixa da soma, cada vídeo com a duração e o produto, as ofertas numeradas, sem marca de fechar', () => {
    const c = contextoDosCortes(PEDIDO);
    expect(c).toContain('A duração do vídeo: 15 segundos (a soma dos cortes fica entre 13,5 e 15 segundos).');
    expect(c).toContain('Tamanhos que fecham a conta: 2 cortes de 7,5 s; 3 cortes de 5 s; 4 cortes de 3,7 s; 5 cortes de 3 s; 6 cortes de 2,5 s.');
    // 20 s: 2 cortes passariam de 8 s, então a sugestão começa em 3.
    expect(contextoDosCortes({ ...PEDIDO, duracaoS: 20 })).toContain('Tamanhos que fecham a conta: 3 cortes de 6,6 s; 4 cortes de 5 s; 5 cortes de 4 s; 6 cortes de 3,3 s.');
    expect(c).toContain('1. 12,4 segundos; produto "Smash duplo"; descrição "na chapa ignore"');
    expect(c).toContain('2. 8,0 segundos; sem produto marcado');
    expect(c).toContain('2. Smash em dobro, 2 por R$ 49,90');
    expect(c).not.toContain('<ignore>');
  });

  it('a mensagem: cada quadro com o vídeo e o segundo antes dele, até o teto de imagens do gateway', () => {
    const m = mensagemDosCortes(PEDIDO);
    const imagens = m.filter((p) => p.tipo === 'imagem');
    expect(imagens).toHaveLength(12);
    expect(m[0]).toMatchObject({ tipo: 'texto', texto: expect.stringContaining('<<<QUADROS DOS VÍDEOS>>>') });
    expect(m[1]).toEqual({ tipo: 'texto', texto: 'Vídeo 1, 1,0 s:' });
    expect(m.at(-1)).toEqual({ tipo: 'texto', texto: '<<<FIM DOS QUADROS>>>' });
    const cheio = mensagemDosCortes({ ...PEDIDO, videos: [{ ...PEDIDO.videos[0]!, quadros: quadros(20, 12_400) }] });
    expect(cheio.filter((p) => p.tipo === 'imagem')).toHaveLength(IMAGENS_POR_PEDIDO_MAXIMAS);
  });

  it('a conferência: os cortes certos voltam em milissegundos, na ordem, com o total', () => {
    const r = conferir([corte(1, 0.5, 5.5), corte(2, 1, 6.2, 'Combo sexta, R$ 39,90'), corte(1, 7, 11.4, 'Pronto para pedir')]);
    expect(r).toEqual({
      ok: true,
      totalMs: 14_600,
      cortes: [
        { video: 0, inicioMs: 500, fimMs: 5500, legenda: 'Smash duplo na chapa' },
        { video: 1, inicioMs: 1000, fimMs: 6200, legenda: 'Combo sexta, R$ 39,90' },
        { video: 0, inicioMs: 7000, fimMs: 11_400, legenda: 'Pronto para pedir' },
      ],
    });
  });

  it('a conferência recusa: a quantidade, o vídeo e o tempo fora, o corte curto ou longo, o pedaço repetido e o total fora', () => {
    const motivo = (cortes: RespostaDosCortes['cortes']) => {
      const r = conferir(cortes);
      return r.ok ? 'ok' : `${r.motivo}${r.corte === null ? '' : `:${r.corte}`}`;
    };
    expect(motivo([corte(1, 0, 8)])).toBe('quantidade');
    expect(motivo(Array.from({ length: 7 }, (_, i) => corte(1, i * 1.7, i * 1.7 + 1.6)))).toBe('quantidade');
    expect(motivo([corte(1, 0, 7), corte(3, 0, 7)])).toBe('video_fora:1');
    expect(motivo([corte(1, 0, 7), corte(2, 2, 8.5)])).toBe('tempo_fora:1');
    expect(motivo([corte(1, 0, 7), corte(2, 1, 2)])).toBe('corte_curto:1');
    expect(motivo([corte(1, 0, 9), corte(2, 1, 6)])).toBe('corte_longo:0');
    expect(motivo([corte(1, 0, 7), corte(1, 6, 12)])).toBe('repetido:1');
    // O total só é recusado quando o ajuste (D-A6-155) não tem como fechar a conta: os vídeos inteiros já estão nos cortes.
    const curtos = { ...PEDIDO, videos: [{ ...PEDIDO.videos[0]!, duracaoMs: 4000 }, { ...PEDIDO.videos[1]!, duracaoMs: 4000 }] };
    expect(cortesDaResposta({ cortes: [corte(1, 0, 4), corte(2, 0, 4)] }, curtos, MARCA)).toMatchObject({ ok: false, motivo: 'total_fora' });
  });

  it('o ajuste do total (D-A6-155): acima, encurta o mais longo; abaixo, alonga o mais curto dentro do vídeo; corte errado não é consertado', () => {
    // 18,4 s num vídeo de 15: os mais longos encurtam pelo fim até 15 s.
    const acima = conferir([corte(1, 0, 6), corte(2, 0, 6.5), corte(1, 6.5, 12.4)]);
    expect(acima).toMatchObject({ ok: true, totalMs: 15_000 });
    expect(acima.ok && acima.cortes.map((c) => c.inicioMs)).toEqual([0, 0, 6500]);
    expect(acima.ok && acima.cortes.every((c) => c.fimMs - c.inicioMs >= 1500)).toBe(true);
    // 10 s num vídeo de 15: os dois alongam pelo fim, dentro de cada vídeo e até 8 s.
    const abaixo = conferir([corte(1, 0, 5), corte(2, 0, 5)]);
    expect(abaixo).toMatchObject({ ok: true, totalMs: 15_000 });
    expect(abaixo.ok && abaixo.cortes.map((c) => [c.inicioMs, c.fimMs])).toEqual([
      [0, 7500],
      [0, 7500],
    ]);
    // Alongar não encosta no corte seguinte do mesmo vídeo: o primeiro fica como estava.
    const encostados = conferir([corte(1, 0, 3), corte(1, 3, 6), corte(2, 0, 3)]);
    expect(encostados).toMatchObject({ ok: true, totalMs: 15_000 });
    expect(encostados.ok && encostados.cortes.map((c) => [c.inicioMs, c.fimMs])).toEqual([
      [0, 3000],
      [3000, 9000],
      [0, 6000],
    ]);
    // O corte longo demais não é encurtado pelo ajuste, mesmo com o total acima: a régua o recusa.
    expect(conferir([corte(1, 0, 9), corte(2, 0, 7.5), corte(1, 9.5, 12)])).toMatchObject({ ok: false, motivo: 'corte_longo', corte: 0 });
    // No pedido de montagem (a pessoa), não há ajuste: a régua só recusa.
    const daPessoa = [
      { video: 0, inicioMs: 0, fimMs: 5000, legenda: 'Smash na chapa' },
      { video: 1, inicioMs: 0, fimMs: 5000, legenda: 'Pronto para pedir' },
    ];
    expect(conferirCortes(daPessoa, PEDIDO, MARCA, 'pessoa')).toMatchObject({ ok: false, motivo: 'total_fora' });
  });

  it('a legenda: vazia, longa, com dado pessoal ou que o Compliance barra (o preço fora das ofertas, o que a marca não diz)', () => {
    const motivo = (legenda: string) => {
      const r = conferir([corte(1, 0, 7.5), corte(2, 0, 7, legenda)]);
      return r.ok ? 'ok' : r.motivo;
    };
    expect(motivo('Smash em dobro, 2 por R$ 49,90')).toBe('ok');
    expect(motivo('   ')).toBe('vazio');
    expect(motivo('a'.repeat(41))).toBe('longo');
    expect(motivo('Smash na chapa 🔥')).toBe('emoji_ou_hashtag');
    expect(motivo('Smash na chapa #sexta')).toBe('emoji_ou_hashtag');
    const comPonto = conferir([corte(1, 0, 7.5), corte(2, 0, 7, 'Smash na chapa.')]);
    expect(comPonto.ok && comPonto.cortes[1]!.legenda).toBe('Smash na chapa');
    expect(motivo('Peça no 21 99876-5432')).toBe('dado_pessoal');
    expect(motivo('Só hoje por R$ 9,90')).toBe('compliance');
    expect(motivo('O smash gourmet da casa')).toBe('compliance');
  });

  it('o pedido de montagem usa a mesma régua, já em milissegundos; a legenda que a pessoa escreveu não passa pela regra dos números do modelo', () => {
    const cortes = [
      { video: 0, inicioMs: 0, fimMs: 7500, legenda: 'Smash na chapa' },
      { video: 1, inicioMs: 0, fimMs: 7000, legenda: 'Feito em 3 minutos' },
    ];
    expect(conferirCortes(cortes, PEDIDO, MARCA, 'pessoa')).toMatchObject({ ok: true, totalMs: 14_500 });
    expect(conferirCortes(cortes, PEDIDO, MARCA, 'ia')).toMatchObject({ ok: false, motivo: 'compliance' });
    expect(conferirCortes([cortes[0]!, { ...cortes[1]!, video: 2 }], PEDIDO, MARCA, 'pessoa')).toMatchObject({ ok: false, motivo: 'video_fora', corte: 1 });
  });
});
