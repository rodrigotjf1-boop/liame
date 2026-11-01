import { describe, expect, it } from 'vitest';
import { estimarCusto, ehFinalidade, nomeDoModelo, type Opcao, opcoesDaFinalidade, quemUsa } from '../src/ai/escolha-de-modelo.js';
import type { PrecoModelo } from '../src/ai/precos.js';

// A escolha do modelo no Pro (A3, I13; D-A3-12; D-A3-25 a D-A3-28): as regras puras do catálogo e da estimativa.

const opcao = (task: string, model: string, eval_score = '0.9600'): Opcao => ({ task, provider: 'anthropic', model, label: nomeDoModelo(model), speed: 'mais_lento', eval_score });

describe('a escolha do modelo no Pro: as regras puras', () => {
  it('o nome do modelo vem do id da Anthropic, com ou sem a data; o que não segue o formato volta como está', () => {
    expect(nomeDoModelo('claude-sonnet-5-5')).toBe('Claude Sonnet 5.5');
    expect(nomeDoModelo('claude-opus-5-5')).toBe('Claude Opus 5.5');
    expect(nomeDoModelo('claude-haiku-4-5-20251001')).toBe('Claude Haiku 4.5');
    expect(nomeDoModelo('claude-fable-5')).toBe('Claude Fable 5');
    expect(nomeDoModelo('gpt-5')).toBe('gpt-5');
    expect(nomeDoModelo('')).toBe('');
  });

  it('as finalidades são três, e o resto não é finalidade', () => {
    expect(['conversa', 'analise', 'texto'].every(ehFinalidade)).toBe(true);
    expect(ehFinalidade('imagem')).toBe(false);
    expect(ehFinalidade('Conversa')).toBe(false);
  });

  it('um modelo entra na finalidade só quando está no catálogo de TODAS as tarefas dela, com a menor nota', () => {
    const catalogo = [
      opcao('explicar_resultados', 'claude-opus-5-5', '1.0000'),
      opcao('estrategista_plano', 'claude-opus-5-5', '0.8000'),
      opcao('explicar_resultados', 'claude-fable-5-1'),
      opcao('outra_finalidade', 'claude-fable-5-1'),
    ];
    // As duas tarefas oferecem o Opus: entra, com a nota da pior; o Fable falta no Estrategista: fica de fora.
    expect(opcoesDaFinalidade(['explicar_resultados', 'estrategista_plano'], catalogo)).toEqual([
      { provider: 'anthropic', model: 'claude-opus-5-5', label: 'Claude Opus 5.5', speed: 'mais_lento', evalScore: '0.8000' },
    ]);
    // Uma tarefa a mais na finalidade, sem o Opus: nada é oferecido.
    expect(opcoesDaFinalidade(['explicar_resultados', 'estrategista_plano', 'compliance_revisao'], catalogo)).toEqual([]);
    // Finalidade sem tarefa ativa: nada (nunca "tudo").
    expect(opcoesDaFinalidade([], catalogo)).toEqual([]);
    // Ordem pelo nome.
    const dois = opcoesDaFinalidade(['conversa_lia'], [opcao('conversa_lia', 'claude-sonnet-6'), opcao('conversa_lia', 'claude-opus-5-5')]);
    expect(dois.map((o) => o.label)).toEqual(['Claude Opus 5.5', 'Claude Sonnet 6']);
  });

  it('a estimativa: os tokens da janela pelo preço comum do modelo, 10% a mais no `us`; sem preço, nula', () => {
    // US$ 5 por milhão de entrada, US$ 25 de saída, cache lido a US$ 0,50 e escrito (5 min) a US$ 6,25.
    const preco: PrecoModelo = { input: 5_000_000n, output: 25_000_000n, cacheRead: 500_000n, cacheWrite5m: 6_250_000n, cacheWrite1h: 10_000_000n };
    const grupos = [
      { geo: 'global' as const, input: 1_000_000, cacheRead: 2_000_000, cacheWrite: 0, output: 100_000 },
      { geo: 'us' as const, input: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 },
    ];
    // global: 5 + 1 + 2,5 = US$ 8,50; us: 5 × 1,1 = US$ 5,50.
    expect(estimarCusto(preco, grupos)).toBe(14_000_000n);
    expect(estimarCusto(preco, [])).toBe(0n);
    expect(estimarCusto(undefined, grupos)).toBeNull();
    // A faixa do prompt longo fica de fora: os tokens vêm somados, e somados passariam de qualquer limite.
    const comFaixa: PrecoModelo = { ...preco, acima: { tokens: 200_000, preco: { input: 50_000_000n, output: 250_000_000n, cacheRead: 5_000_000n, cacheWrite5m: 62_500_000n, cacheWrite1h: 100_000_000n } } };
    expect(estimarCusto(comFaixa, grupos)).toBe(14_000_000n);
  });

  it('quem usa: os funcionários das tarefas, sem repetir; a tarefa sem dono conhecido fica de fora', () => {
    expect(quemUsa(['conversa_lia'])).toEqual(['LIA']);
    expect(quemUsa(['explicar_resultados', 'estrategista_plano', 'compliance_revisao', 'pesquisador_pagina'])).toEqual(['Analista de dados', 'Estrategista', 'Compliance', 'Pesquisador']);
    expect(quemUsa(['criativo_texto', 'tarefa_nova'])).toEqual(['Criativo']);
  });
});
