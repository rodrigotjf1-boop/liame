import { describe, expect, it } from 'vitest';
import type { BaseDaPeca } from '../src/ai/criativo/peca.js';
import { fraseDoCorte, LIMITE_DE_TEMAS, montarTemas, problemaDosTemas, TAMANHO_DO_TEMA, termosDaLoja } from '../src/campanhas/temas-de-busca.js';

// R9, os temas de busca da campanha do Google (D-RG-85 e D-RG-86), sem rede e sem banco: os termos da loja (a categoria
// do perfil e até 3 de Minha marca, sem repetir), a lista por regra como no protótipo aprovado (cada termo com "perto de
// mim", o segundo com "delivery", um tema por bairro, o segundo enquanto couber), a frase de onde a lista parou e a
// conferência de cada tema (a mesma dos textos do Google).

const BASE: BaseDaPeca = { oferta: 'Smash duplo por R$ 29,90', fatos: 'Hamburgueria na Lapa desde 2019.', proibidas: ['o melhor da cidade'], concorrentes: ['Burger King', "McDonald's"], instrucao: null };
const BAIRROS = ['Centro', 'Lapa', 'Glória', 'Santa Teresa', 'Catete', 'Flamengo', 'Laranjeiras', 'Botafogo', 'Cosme Velho', 'Urca', 'Saúde', 'Gamboa', 'Rio Comprido'];

describe('os temas de busca (R9)', () => {
  it('os limites de partida ficam no menor (a conferir na conta real, D-RG-89)', () => {
    expect([LIMITE_DE_TEMAS, TAMANHO_DO_TEMA]).toEqual([25, 80]);
  });

  it('os termos da loja: a categoria do perfil primeiro, até 3 de Minha marca, sem repetir nem vazio', () => {
    expect(termosDaLoja('Hamburgueria', ['hambúrguer', ' smash  burger ', 'HAMBURGUERIA', 'burger', 'quarto'])).toEqual([
      { termo: 'Hamburgueria', fonte: 'perfil' },
      { termo: 'hambúrguer', fonte: 'minha_marca' },
      { termo: 'smash burger', fonte: 'minha_marca' },
    ]);
    expect(termosDaLoja(null, ['', '  '])).toEqual([]);
    expect(termosDaLoja(null, ['pizza'])).toEqual([{ termo: 'pizza', fonte: 'minha_marca' }]);
  });

  it('a lista do protótipo: "perto de mim", "delivery", um tema por bairro e o segundo enquanto couber', () => {
    const termos = termosDaLoja('hamburgueria', ['hambúrguer', 'smash burger']);
    const tres = montarTemas(termos, ['Centro', 'Lapa', 'Glória']);
    expect(tres.temas).toEqual([
      'hamburgueria perto de mim',
      'hambúrguer perto de mim',
      'smash burger perto de mim',
      'hambúrguer delivery',
      'hamburgueria Centro',
      'hamburgueria Lapa',
      'hamburgueria Glória',
      'delivery de hambúrguer Centro',
      'delivery de hambúrguer Lapa',
      'delivery de hambúrguer Glória',
    ]);
    expect(fraseDoCorte(tres)).toBe('');
    // Com 13 bairros, a lista para em 25: os últimos ficam com um tema só, e a tela diz quais.
    const treze = montarTemas(termos, BAIRROS);
    expect(treze.temas).toHaveLength(25);
    expect(treze.corte).toEqual({ semNenhum: [], comUmSo: ['Cosme Velho', 'Urca', 'Saúde', 'Gamboa', 'Rio Comprido'], longos: [] });
    expect(fraseDoCorte(treze)).toBe('A lista parou em 25 temas: Cosme Velho, Urca, Saúde, Gamboa e Rio Comprido ficaram com um tema só. Tire um tema para pôr outro.');
    // Com o limite apertado, há bairro sem nenhum tema.
    const apertado = montarTemas(termos, BAIRROS, 6);
    expect(apertado.corte.semNenhum).toEqual(BAIRROS.slice(2));
    expect(fraseDoCorte(apertado, 6)).toContain('ficaram sem tema; Centro e Lapa ficaram com um tema só');
  });

  it('um termo só faz o "delivery" com ele; sem termo, a lista é vazia; o bairro de nome longo ganha a frase dele', () => {
    const um = montarTemas(termosDaLoja('pizzaria', []), ['Lapa']);
    expect(um.temas).toEqual(['pizzaria perto de mim', 'pizzaria delivery', 'pizzaria Lapa', 'delivery de pizzaria Lapa']);
    expect(montarTemas([], BAIRROS)).toEqual({ temas: [], corte: { comUmSo: [], semNenhum: [], longos: [] } });
    const longo = 'Conjunto Habitacional Jardim das Flores do Alto da Serra Velha Grande';
    const m = montarTemas(termosDaLoja('hamburgueria', []), ['Lapa', longo]);
    expect(m.temas.every((t) => [...t].length <= TAMANHO_DO_TEMA)).toBe(true);
    expect(m.corte.longos).toEqual([longo]);
    expect(fraseDoCorte(m)).toBe(`${longo} ficou sem tema: o nome deixaria o tema com mais de 80 caracteres. Escreva um tema mais curto, se quiser.`);
  });

  it('a conferência: concorrente, o que a marca não diz, tamanho, vazio, repetido e o limite não deixam pedir', () => {
    const temas = montarTemas(termosDaLoja('hamburgueria', ['hambúrguer']), ['Lapa']).temas;
    expect(problemaDosTemas(temas, BASE)).toBeNull();
    const com = (t: string) => problemaDosTemas([...temas, t], BASE);
    expect(com('hambúrguer melhor que burger king')).toMatchObject({ indice: temas.length });
    expect(com('o melhor da cidade na Lapa')).toMatchObject({ indice: temas.length });
    expect(com('x'.repeat(81))?.motivo).toBe('O tema passa de 80 caracteres.');
    expect(com('   ')?.motivo).toBe('O tema está vazio: escreva o tema ou tire a linha.');
    expect(com('HAMBURGUERIA perto de mim')?.motivo).toBe('O tema repete o tema 1.');
    const demais = Array.from({ length: 27 }, (_, i) => `hamburgueria ${i}`);
    expect(problemaDosTemas(demais, BASE)?.motivo).toBe('O Google aceita até 25 temas por campanha: tire 2 temas.');
  });
});
