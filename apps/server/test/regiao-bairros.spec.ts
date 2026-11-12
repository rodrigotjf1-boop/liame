import { describe, expect, it } from 'vitest';
import { BairrosRegem } from '../src/connectors/regem/contrato-regem.js';
import { compararBairros, linhasDosBairros } from '../src/regiao/bairros.js';

// Os pedidos da loja por bairro (plano da região, R3, parte 2; D-RG-36 a D-RG-39), sem banco: a resposta do Regem
// conferida pelo contrato e em linhas para gravar, e a conta de atacar e defender (plano da região §4.2, jogada 2).

const RESPOSTA = {
  loja_id: 'loja-1',
  de: '2026-10-15',
  ate: '2026-11-11',
  fuso: 'America/Sao_Paulo',
  minimo: 5,
  bairros: [
    { bairro: ' Tijuca ', cidade: 'Rio de Janeiro', uf: 'rj', pedidos: 42, receita_micros: '2100000000' },
    { bairro: 'Maracanã', cidade: 'Rio de Janeiro', uf: 'RJ', pedidos: 9, receita_micros: 450000000 },
  ],
  outros: { bairros: 3, pedidos: 7, receita_micros: '350000000' },
  sem_bairro: { pedidos: 4, receita_micros: '200000000' },
  retirada_e_balcao: { pedidos: 11 },
};

describe('os pedidos por bairro do Regem (R3, parte 2)', () => {
  it('a resposta conferida pelo contrato (micros como número ou texto) vira linhas na ordem: os bairros, outros, sem bairro e retirada', () => {
    const r = BairrosRegem.parse(RESPOSTA);
    expect(linhasDosBairros(r)).toEqual([
      { posicao: 0, tipo: 'bairro', bairro: 'Tijuca', cidade: 'Rio de Janeiro', uf: 'RJ', bairros: null, pedidos: 42, receita: '2100000000' },
      { posicao: 1, tipo: 'bairro', bairro: 'Maracanã', cidade: 'Rio de Janeiro', uf: 'RJ', bairros: null, pedidos: 9, receita: '450000000' },
      { posicao: 2, tipo: 'outros', bairro: null, cidade: null, uf: null, bairros: 3, pedidos: 7, receita: '350000000' },
      { posicao: 3, tipo: 'sem_bairro', bairro: null, cidade: null, uf: null, bairros: null, pedidos: 4, receita: '200000000' },
      { posicao: 4, tipo: 'retirada', bairro: null, cidade: null, uf: null, bairros: null, pedidos: 11, receita: null },
    ]);
  });

  it('o que foge do contrato não entra: campo que falta, dinheiro em fração, bairro sem pedido', () => {
    expect(BairrosRegem.safeParse({ ...RESPOSTA, minimo: undefined }).success).toBe(false);
    expect(BairrosRegem.safeParse({ ...RESPOSTA, outros: { bairros: 1, pedidos: 1, receita_micros: '1.5' } }).success).toBe(false);
    expect(BairrosRegem.safeParse({ ...RESPOSTA, bairros: [{ bairro: 'Tijuca', cidade: null, uf: null, pedidos: 0, receita_micros: 0 }] }).success).toBe(false);
  });

  it('atacar e defender: pedidos por mil moradores contra a mediana; o bairro da entrega sem o mínimo conta como pouco', () => {
    const r = compararBairros([
      { nome: 'Tijuca', pedidos: 42, populacao: 142_909, naEntrega: true },
      { nome: 'Maracanã', pedidos: 9, populacao: 25_256, naEntrega: true },
      { nome: 'Praça da Bandeira', pedidos: 30, populacao: 8_662, naEntrega: true },
      { nome: 'Vila Isabel', pedidos: null, populacao: 86_018, naEntrega: true },
      { nome: 'Lugar fora do Censo', pedidos: 6, populacao: null, naEntrega: false },
    ]);
    // Por mil: Tijuca 0,29; Maracanã 0,36; Praça da Bandeira 3,46 → a mediana é 0,36; a mediana da gente, 55.637. A
    // Tijuca fica abaixo da mediana, mas não da metade dela (0,18): manter. A Vila Isabel, sem o mínimo e com muita gente: atacar.
    expect(r.map((b) => [b.nome, b.papel])).toEqual([
      ['Praça da Bandeira', 'defender'],
      ['Vila Isabel', 'atacar'],
      ['Maracanã', 'manter'],
      ['Tijuca', 'manter'],
      ['Lugar fora do Censo', null],
    ]);
    expect(r.find((b) => b.nome === 'Vila Isabel')!.porMil).toBe(0);
    expect(r.find((b) => b.nome === 'Lugar fora do Censo')!.porMil).toBeNull();
  });

  it('com menos de 3 bairros com a gente conhecida, nenhum papel', () => {
    const r = compararBairros([
      { nome: 'Tijuca', pedidos: 42, populacao: 142_909, naEntrega: true },
      { nome: 'Maracanã', pedidos: 9, populacao: 25_256, naEntrega: true },
      { nome: 'Fora', pedidos: 6, populacao: null, naEntrega: false },
    ]);
    expect(r.every((b) => b.papel === null)).toBe(true);
  });
});
