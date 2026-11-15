import type { BrandPhoto } from '@liame/contracts';
import { describe, expect, it } from 'vitest';
import {
  type CorteNaTela,
  comChave,
  conferirNaTela,
  corteNoTempo,
  curtoDemais,
  momentosDoVideo,
  motivoDosCortesTxt,
  mover,
  outrosTxt,
  quadrosTxt,
  segundosTxt,
  semChave,
  situacaoDoTotal,
  tempoTxt,
  videosAceitos,
} from '@/components/fotos/video-montado/momentos';
import { aceitas, quantasLeva, rotuloDaPrevia } from '@/components/fotos/video-montado/textos';

// "Os melhores momentos" na gaveta "Montar um vídeo" (A6 · Z16; P46): as contas e as frases dos cortes (o total contra
// a duração, a mesma régua do servidor), a ordem, a conferência antes de gerar, o que o Social media vê, os motivos em
// palavras, o corte da prévia em cada instante e os vídeos que o modelo aceita.

const video = (id: string, duracaoMs: number, o: Partial<BrandPhoto> = {}): BrandPhoto => ({
  id,
  brand_id: 'b',
  product: 'Smash Clássico',
  description: '',
  width: 1080,
  height: 1920,
  bytes: 1000,
  orientation: 'vertical',
  narrow_for_instagram: false,
  instagram_crop: 'nenhum',
  uploaded_at: '2026-11-15T10:00:00.000Z',
  uploaded_by: null,
  url: `https://armazem.test/${id}.mp4`,
  thumbnail_url: `https://armazem.test/${id}-capa.jpg`,
  urls_expire_at: '2026-11-15T10:05:00.000Z',
  kind: 'video',
  video: { width: 1080, height: 1920, duration_ms: duracaoMs, media_type: 'video/mp4', has_audio: true, has_cover: true },
  montage_id: null,
  ...o,
});
const corte = (inicio: number, fim: number, legenda = 'A chapa no ponto', media = 'v1'): CorteNaTela => ({ media_id: media, start_ms: inicio, end_ms: fim, caption: legenda, chave: `${media}-${inicio}` });

describe('os melhores momentos: as contas dos cortes', () => {
  it('os segundos e os instantes como a tela escreve', () => {
    expect([segundosTxt(8_000), segundosTxt(14_500), segundosTxt(1_550)]).toEqual(['8', '14,5', '1,6']);
    expect([tempoTxt(0), tempoTxt(3_000), tempoTxt(12_500), tempoTxt(65_000)]).toEqual(['0:00', '0:03', '0:12,5', '1:05']);
  });

  it('o total contra a duração: fecha, abaixo de 80%, passa da duração (com a folga de meio segundo do servidor) e nenhum', () => {
    expect(situacaoDoTotal([corte(0, 4_000), corte(5_000, 9_500), corte(10_000, 16_000)], 15)).toEqual({ tipo: 'ok', total: 'Total: 14,5 de 15 s', txt: 'fecha a duração' });
    expect(situacaoDoTotal([corte(0, 4_000), corte(5_000, 9_000)], 15)).toEqual({ tipo: 'aviso', total: 'Total: 8 de 15 s', txt: 'abaixo de 80%: faltam 4 s para chegar a 12 s' });
    // 15,5 s cabe (a folga); 16 s passa.
    expect(situacaoDoTotal([corte(0, 8_000), corte(8_000, 15_500)], 15).tipo).toBe('ok');
    expect(situacaoDoTotal([corte(0, 8_000), corte(8_000, 16_000)], 15)).toMatchObject({ tipo: 'perigo', txt: 'passa da duração em 1 s' });
    expect(situacaoDoTotal([], 10)).toMatchObject({ tipo: 'aviso', txt: 'nenhum corte' });
  });

  it('subir, descer e as pontas que não andam; a chave entra e sai sem mudar o corte', () => {
    expect(mover(['a', 'b', 'c'], 1, -1)).toEqual(['b', 'a', 'c']);
    expect(mover(['a', 'b', 'c'], 1, 1)).toEqual(['a', 'c', 'b']);
    expect(mover(['a', 'b', 'c'], 0, -1)).toEqual(['a', 'b', 'c']);
    expect(mover(['a', 'b', 'c'], 2, 1)).toEqual(['a', 'b', 'c']);
    const doContrato = [{ media_id: 'v1', start_ms: 0, end_ms: 4_000, caption: 'A chapa' }];
    expect(semChave(comChave(doContrato, 'p1'))).toEqual(doContrato);
    expect(comChave(doContrato, 'p1')[0]!.chave).toBe('p1-0');
  });

  it('a conferência antes de gerar: sem os cortes, todos tirados, um só, a legenda vazia ou longa e o total fora', () => {
    expect(conferirNaTela([], 15, false).cortes).toBe('Peça os cortes ao Social media antes de gerar o vídeo.');
    expect(conferirNaTela([], 15, true).cortes).toContain('Nenhum corte: todos foram tirados');
    expect(conferirNaTela([corte(0, 8_000)], 10, true).cortes).toContain('pelo menos 2 cortes');
    const longa = 'Uma legenda comprida demais para caber no vídeo';
    const r = conferirNaTela([corte(0, 4_000, '   '), corte(5_000, 9_500, longa, 'v2')], 10, true);
    expect(r.legendas).toEqual({ 'v1-0': 'Escreva a legenda deste corte.', 'v2-5000': `A legenda tem ${[...longa].length} caracteres: o máximo é 40.` });
    expect(conferirNaTela([corte(0, 4_000), corte(5_000, 8_000)], 15, true).cortes).toBe('Total: 7 de 15 s: abaixo de 80%: faltam 5 s para chegar a 12 s. Tire um corte, escolha outra duração ou peça outros cortes.');
    expect(conferirNaTela([corte(0, 4_000), corte(5_000, 9_500)], 10, true)).toEqual({ legendas: {} });
  });
});

describe('os melhores momentos: as frases do pedido dos cortes', () => {
  it('os quadros que o Social media vê (16 divididos entre os vídeos) e os pedidos que restam', () => {
    expect([quadrosTxt(1), quadrosTxt(2), quadrosTxt(3), quadrosTxt(4)]).toEqual(['16 quadros do vídeo', '16 quadros, 8 de cada vídeo', '15 quadros, 5 de cada vídeo', '16 quadros, 4 de cada vídeo']);
    expect([outrosTxt(2), outrosTxt(1)]).toEqual(['Dá para pedir outros cortes mais 2 vezes neste vídeo.', 'Dá para pedir outros cortes mais 1 vez neste vídeo.']);
    expect(outrosTxt(0)).toContain('Já pediu outros cortes 2 vezes');
  });

  it('cada motivo em palavras, e o desconhecido com a frase geral (a lista do servidor cresce)', () => {
    expect(motivoDosCortesTxt('funcao-desligada')).toContain('não estão ligados');
    expect(motivoDosCortesTxt('sem_quadros')).toContain('Não deu para ler estes vídeos');
    expect(motivoDosCortesTxt('parado')).toContain('não terminou de ver');
    expect(motivoDosCortesTxt('compliance')).toContain('Compliance');
    expect(motivoDosCortesTxt('total_fora')).toContain('conferência dos cortes');
    expect(motivoDosCortesTxt('limite-do-dia')).toContain('10 vezes hoje');
    expect(motivoDosCortesTxt('so-videos')).toContain('só vídeos');
    expect(motivoDosCortesTxt('motivo_novo_do_servidor')).toBe('O Social media não propôs os cortes agora. Peça de novo em instantes.');
    expect(motivoDosCortesTxt(null)).toBe(motivoDosCortesTxt('motivo_novo_do_servidor'));
  });
});

describe('os melhores momentos: a prévia e os vídeos', () => {
  it('o corte de cada instante, a legenda 0,15 s depois do começo e o andamento', () => {
    const cs = [corte(0, 3_000), corte(5_000, 7_000, 'O queijo', 'v2')];
    expect(corteNoTempo(cs, 0)).toEqual({ k: 0, legenda: false, x: 0 });
    expect(corteNoTempo(cs, 1)).toMatchObject({ k: 0, legenda: true });
    expect(corteNoTempo(cs, 3.05)).toMatchObject({ k: 1, legenda: false });
    expect(corteNoTempo(cs, 4.9)).toMatchObject({ k: 1, legenda: true });
    expect(corteNoTempo(cs, 4.9).x).toBeCloseTo(0.98, 5);
    expect(corteNoTempo([], 1)).toEqual({ k: -1, legenda: false, x: 0 });
  });

  it('só os vídeos da loja (nem foto, nem o montado); o curto demais para cortes; quantos o modelo leva', () => {
    const foto = video('f1', 1, { kind: 'foto_produto', video: null });
    const montado = video('v9', 10_000, { montage_id: 'm1' });
    const lista = [video('v1', 12_000), foto, montado, video('v2', 2_500)];
    expect(videosAceitos(lista).map((f) => f.id)).toEqual(['v1', 'v2']);
    expect(aceitas(lista, 'momentos').map((f) => f.id)).toEqual(['v1', 'v2']);
    expect([curtoDemais(video('v2', 2_500)), curtoDemais(video('v3', 3_000))]).toEqual([true, false]);
    expect(quantasLeva('momentos')).toBe('de 1 a 4 vídeos, na ordem em que entram no vídeo');
    expect(quantasLeva('combo')).toBe('de 2 a 4 fotos, na ordem em que entram no vídeo');
  });

  it('o vídeo pronto em Fotos: os cortes do pedido de onde ele saiu, com a capa e a posição de cada vídeo', () => {
    const v1 = video('v1', 12_000);
    const v2 = video('v2', 9_000);
    const pedido = {
      id: 'm1', brand_id: 'b', template: 'momentos' as const, format: '9x16' as const, duration_s: 10, media_ids: ['v1', 'v2'], title: 'Os melhores momentos', price_line: null, cta: '',
      cuts: [{ media_id: 'v2', start_ms: 1_000, end_ms: 5_500, caption: 'O queijo' }, { media_id: 'v1', start_ms: 0, end_ms: 4_000, caption: 'A chapa' }],
      with_logo: false, sound: 'sem' as const, status: 'pronto' as const, progress: 100, error: null, queue_ahead: null, photo_id: 'p1', created_at: '2026-11-15T09:00:00.000Z', started_at: null, finished_at: null,
    };
    expect(momentosDoVideo({ montage_id: 'm1' }, [pedido], [v1])).toEqual({
      videos: 2,
      cortes: [
        { capa: null, video: 1, start_ms: 1_000, end_ms: 5_500, caption: 'O queijo' },
        { capa: v1.thumbnail_url, video: 0, start_ms: 0, end_ms: 4_000, caption: 'A chapa' },
      ],
    });
    // A foto da loja, o pedido fora da lista e os outros modelos: nada.
    expect(momentosDoVideo({ montage_id: null }, [pedido], [v1])).toBeNull();
    expect(momentosDoVideo({ montage_id: 'm9' }, [pedido], [v1])).toBeNull();
    expect(momentosDoVideo({ montage_id: 'm1' }, [{ ...pedido, template: 'combo', cuts: null }], [v1])).toBeNull();
  });

  it('o rótulo da prévia com os cortes, e a faixa "Novidade" só na Novidade', () => {
    const base = { formato: '9x16' as const, dur: 10, midias: [{ video: false, produto: 'Smash' }, { video: false, produto: 'Batata' }], titulo: '', preco: '', chamada: '', logo: true, somOriginal: true };
    const cortes = [
      { media: 1, start_ms: 1_000, end_ms: 5_500, caption: 'O queijo' },
      { media: 0, start_ms: 0, end_ms: 4_000, caption: 'A chapa' },
    ];
    expect(rotuloDaPrevia({ ...base, modelo: 'momentos', cortes })).toBe(
      'Prévia do vídeo: Os melhores momentos, Reels e Story (9:16), 8,5 de 10 segundos: 2 cortes de 2 vídeos, na ordem: corte 1, vídeo 2 de 0:01 a 0:05,5, “O queijo”; corte 2, vídeo 1 de 0:00 a 0:04, “A chapa”, com a logo, com o som original de cada corte.',
    );
    expect(rotuloDaPrevia({ ...base, modelo: 'momentos', cortes: [] })).toContain('ainda sem os cortes, com a logo, sem música');
    expect(rotuloDaPrevia({ ...base, modelo: 'combo', midias: base.midias, titulo: 'Combo', chamada: 'Vem' })).not.toContain('Novidade”');
  });
});
