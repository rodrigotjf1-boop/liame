import { describe, expect, it } from 'vitest';
import {
  campanhaGoogleDoRecurso,
  type EstadoDaCampanhaNovaNoGoogle,
  motivoDaFotoPequena,
  motivoDosTextos,
  planoDaCampanhaGoogle,
  recortesDaFoto,
  recursoDaCampanhaGoogle,
} from '../src/campanhas/campanha-google-plano.js';

// A5 · Y9, parte 2, sem rede e sem banco: o recurso, os recortes da foto (os mesmos números do P45), a conferência dos
// textos nos tamanhos do Google (base §3.1, lida em 12/11/2026) e o plano da ferramenta `campanha_google_criar`.

const ID = '01900000-0000-7000-8000-000000000001';
const TEXTOS = {
  titulos: ['Combo sexta: R$ 34,90', 'Smash, batata e refri', 'Peça no cardápio online'],
  titulos_longos: ['Sexta é dia de combo: smash, batata e refri por R$ 34,90 na Loja Centro'],
  descricoes: ['Peça o combo de sexta pelo cardápio online e receba em casa.', 'Smash, batata e refrigerante por R$ 34,90. Entrega no Centro ou retirada no balcão.'],
};
const estado = (o: Partial<EstadoDaCampanhaNovaNoGoogle> = {}): EstadoDaCampanhaNovaNoGoogle => ({
  campanha: ID,
  marca: '01900000-0000-7000-8000-0000000000b1',
  nome: 'Combo sexta · Google · novembro',
  peca: { id: '01900000-0000-7000-8000-0000000000c1', versao: 2 },
  textos: TEXTOS,
  foto: { id: '01900000-0000-7000-8000-0000000000d1', arquivo: 'a'.repeat(64), largura: 1440, altura: 1800 },
  loja_no_google: { nome: 'Mister Burgers', logo: '01900000-0000-7000-8000-0000000000f1', logo_lado: 512 },
  conta: { id: '4445556667', nome: 'Hamburgueria Ads' },
  loja: { id: '01900000-0000-7000-8000-0000000000e1', nome: 'Loja Centro', latitude: -22.906847, longitude: -43.172897 },
  raio_km: 5,
  verba_diaria_micros: 30_000_000,
  moeda: 'BRL',
  fim: null,
  fuso: 'America/Sao_Paulo',
  link: 'https://cardapio.exemplo.com.br/mister-centro',
  situacao: 'pedida',
  ativa: false,
  ...o,
});

describe('a campanha nova no Google (A5 · Y9, parte 2)', () => {
  it('o recurso: campanha_google:<uuid>, e nada mais', () => {
    expect(campanhaGoogleDoRecurso(recursoDaCampanhaGoogle(ID))).toBe(ID);
    expect(campanhaGoogleDoRecurso(`campanha_nova:${ID}`)).toBeNull();
    expect(campanhaGoogleDoRecurso('campanha_google:nao-e-uuid')).toBeNull();
  });

  it('os recortes pelo centro: os números do P45; a foto pequena recusada com as medidas', () => {
    expect(recortesDaFoto(1440, 1800).map((r) => `${r.id}:${r.largura}x${r.altura}:${r.ok}`)).toEqual(['deitada:1440x754:true', 'quadrada:1440x1440:true', 'em_pe:1440x1800:true']);
    expect(recortesDaFoto(1600, 1200).map((r) => `${r.largura}x${r.altura}`)).toEqual(['1600x838', '1200x1200', '960x1200']);
    // 520 × 520: a quadrada serve; a deitada, não (o mínimo é 600 × 314); a em pé é opcional e fica de fora.
    expect(recortesDaFoto(520, 520).map((r) => r.ok)).toEqual([false, true, false]);
    expect(motivoDaFotoPequena(520, 520)).toBe('A foto é pequena para o recorte deitado: o Google pede pelo menos 600 × 314, e o maior recorte desta foto dá 520 × 272. Use outra foto.');
    expect(motivoDaFotoPequena(1440, 1800)).toBeNull();
    // A em pé pequena não impede: ela é opcional (1600 × 500: a em pé dá 400 × 500, abaixo de 480 × 600).
    expect(recortesDaFoto(1600, 500).map((r) => r.ok)).toEqual([true, true, false]);
    expect(motivoDaFotoPequena(1600, 500)).toBeNull();
  });

  it('os textos: as quantidades, os tamanhos, os vazios e os repetidos, no campo de cada um', () => {
    const t = (o: Partial<{ titulos: string[]; titulosLongos: string[]; descricoes: string[] }> = {}) => ({ titulos: TEXTOS.titulos, titulosLongos: TEXTOS.titulos_longos, descricoes: TEXTOS.descricoes, ...o });
    expect(motivoDosTextos(t())).toBeNull();
    expect(motivoDosTextos(t({ titulos: TEXTOS.titulos.slice(0, 2) }))).toEqual({ campo: 'headlines', motivo: 'O Google pede pelo menos 3 títulos.' });
    expect(motivoDosTextos(t({ titulos: ['Combo de sexta com smash, batata e refrigerante', ...TEXTOS.titulos.slice(1)] }))).toEqual({
      campo: 'headlines',
      motivo: '“Combo de sexta com smash, batata e refrigerante” tem 47 caracteres: o título vai até 30.',
    });
    expect(motivoDosTextos(t({ titulos: [...TEXTOS.titulos, 'combo SEXTA: R$ 34,90'] }))?.motivo).toBe('Há títulos repetidos: o Google recusa o mesmo texto duas vezes.');
    expect(motivoDosTextos(t({ titulos: [...TEXTOS.titulos, '  '] }))?.motivo).toBe('Há título vazio: escreva ou tire.');
    expect(motivoDosTextos(t({ titulos: Array.from({ length: 16 }, (_, i) => `Título ${i}`) }))?.motivo).toBe('O Google aceita até 15 títulos.');
    expect(motivoDosTextos(t({ titulosLongos: [] }))).toEqual({ campo: 'long_headlines', motivo: 'O Google pede pelo menos 1 título longo.' });
    expect(motivoDosTextos(t({ descricoes: [TEXTOS.descricoes[0]!] }))).toEqual({ campo: 'descriptions', motivo: 'O Google pede pelo menos 2 descrições.' });
    expect(motivoDosTextos(t({ descricoes: [TEXTOS.descricoes[0]!, 'x'.repeat(91)] }))?.motivo).toMatch(/tem 91 caracteres: a descrição vai até 90\.$/);
    // O tamanho conta caracteres, não bytes: o acento não pesa mais.
    expect(motivoDosTextos(t({ titulos: ['Ç'.repeat(30), ...TEXTOS.titulos.slice(1)] }))).toBeNull();
  });

  it('o plano: pedida vira criada; o que já foi criado, cancelado ou não criado não volta; os textos e a foto são conferidos de novo', () => {
    const p = planoDaCampanhaGoogle(estado());
    expect(p.ok && p.desejado.situacao).toBe('criada');
    expect(planoDaCampanhaGoogle(estado({ situacao: 'criada' }))).toEqual({ ok: false, motivo: 'Esta campanha nova já foi criada no Google, pausada.' });
    expect(planoDaCampanhaGoogle(estado({ situacao: 'cancelada' })).ok).toBe(false);
    expect(planoDaCampanhaGoogle(estado({ situacao: 'nao_criada' })).ok).toBe(false);
    expect(planoDaCampanhaGoogle(estado({ foto: { ...estado().foto, largura: 520, altura: 520 } }))).toMatchObject({ ok: false, motivo: expect.stringMatching(/^A foto é pequena para o recorte deitado/) });
    expect(planoDaCampanhaGoogle(estado({ textos: { ...TEXTOS, titulos: [...TEXTOS.titulos, 'Smash, batata e refri'] } }))).toMatchObject({ ok: false, motivo: expect.stringMatching(/repetidos/) });
    // O estado fora do formato (a logo pequena, a conta fora do formato, outra coisa qualquer) não vira plano.
    expect(planoDaCampanhaGoogle(estado({ loja_no_google: { nome: 'Mister Burgers', logo: 'x', logo_lado: 96 } })).ok).toBe(false);
    expect(planoDaCampanhaGoogle(estado({ conta: { id: 'act_123', nome: 'x' } })).ok).toBe(false);
    expect(planoDaCampanhaGoogle({ qualquer: 1 }).ok).toBe(false);
  });
});
