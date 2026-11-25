import { describe, expect, it } from 'vitest';
import { avisoDoTesteDeRegiao, DIAS_DO_AVISO_DO_TESTE_DE_REGIAO, textoDoAvisoDoTesteDeRegiao } from '../src/campanhas/teste-regiao-avisos.js';

// R8 (D-RG-102 e D-RG-94), sem rede e sem banco: o aviso da Atenção com o resultado do teste de região. A medida grava o
// resultado uma vez; a Atenção avisa, só informação, com a faixa do que o anúncio traz no bairro ou o motivo de não haver
// conta, e o caminho para o teste em Aprovações. O resultado fora da forma da medida não vira aviso. As frases são as da
// tela do teste em Aprovações (`aprovacoes/teste-de-regiao-textos.ts`).

const ID = '0190d2b0-0000-7000-8000-0000000000c1';
const ACAO = '0190d2b0-0000-7000-8000-0000000000c2';
const NOME = 'Lapa sem anúncio por 14 dias';
const BAIRROS = [
  { nome: 'Centro', antes: 1000, durante: 520 },
  { nome: 'Glória', antes: 412, durante: 210 },
  { nome: 'Saúde', antes: 300, durante: 150 },
];
const comConta = (provou: boolean, faixa: { de: number; ate: number }) => ({
  janela: { de: '2026-11-01', ate: '2026-11-14' },
  pedidos: { alvoAntes: 480, outrosAntes: 1712, alvoDurante: 168, outrosDurante: 880 },
  bairros: BAIRROS,
  efeito: { esperadoPorSemana: 120.5, feitoPorSemana: 84, trazPorSemana: 36.5, faixa, provou },
  motivo: null,
  esperadoPorSemana: null,
  minimoDoRegem: 5,
  medido_em: '2026-11-18T09:00:00.000Z',
});
const semConta = (motivo: string, o: Record<string, unknown> = {}) => ({
  janela: { de: '2026-11-01', ate: '2026-11-14' },
  pedidos: { alvoAntes: 480, outrosAntes: 1712, alvoDurante: null, outrosDurante: null },
  bairros: BAIRROS,
  efeito: null,
  motivo,
  esperadoPorSemana: null,
  minimoDoRegem: null,
  medido_em: '2026-11-18T09:00:00.000Z',
  ...o,
});
const aviso = (resultado: unknown) => avisoDoTesteDeRegiao({ id: ID, acao: ACAO, nome: NOME, resultado });
const texto = (resultado: unknown) => textoDoAvisoDoTesteDeRegiao(aviso(resultado)!);
const ACAO_DA_FAIXA = 'Veja o teste em Aprovações: a faixa do que o anúncio traz e os pedidos de cada bairro, antes e no teste.';
const ACAO_SEM_CONTA = 'Veja o teste em Aprovações. Para medir de novo, peça outro teste em Minha marca › Região › Sua região.';

describe('o aviso do resultado do teste de região (R8)', () => {
  it('fica duas semanas depois da medida', () => {
    expect(DIAS_DO_AVISO_DO_TESTE_DE_REGIAO).toBe(14);
  });

  it('o anúncio provou: o que o bairro fez, o que faria e a faixa, só informação', () => {
    expect(aviso(comConta(true, { de: 12.3, ate: 58 }))).toMatchObject({ teste: ID, acao: ACAO, nome: NOME });
    expect(texto(comConta(true, { de: 12.3, ate: 58 }))).toEqual({
      kind: 'teste_regiao_com_resultado',
      severity: 'info',
      title: `O teste "${NOME}" mostrou que o anúncio traz pedido no bairro`,
      detail: 'Sem anúncio, o bairro fez 84 pedidos por semana; seguindo os outros bairros, faria 120,5. O anúncio traz de 12,3 a 58 pedidos por semana ali.',
      action: ACAO_DA_FAIXA,
    });
  });

  it('não provou: a faixa começa no zero', () => {
    expect(texto(comConta(false, { de: 0, ate: 22.4 }))).toEqual({
      kind: 'teste_regiao_com_resultado',
      severity: 'info',
      title: `O teste "${NOME}" não provou que o anúncio traz pedido no bairro`,
      detail: 'Não deu para provar que o anúncio traz pedido no bairro: a faixa vai de 0 a 22,4 por semana.',
      action: ACAO_DA_FAIXA,
    });
  });

  it('sem conta: cada motivo na frase da tela, e o caminho para pedir outro teste', () => {
    const casos: Array<[unknown, string]> = [
      [semConta('incompleto'), 'O teste parou antes dos 14 dias: com menos, o Liame não tira conclusão.'],
      [semConta('poucos_bairros', { bairros: BAIRROS.slice(0, 2) }), 'Nos dias do teste, sobraram 2 bairros para comparar; a conta pede pelo menos 3.'],
      [semConta('poucos_bairros', { bairros: BAIRROS.slice(0, 1) }), 'Nos dias do teste, sobrou 1 bairro para comparar; a conta pede pelo menos 3.'],
      [semConta('poucos_bairros', { bairros: [] }), 'Nos dias do teste, não sobrou nenhum bairro para comparar; a conta pede pelo menos 3.'],
      [
        semConta('abaixo_do_minimo', { minimoDoRegem: 5, esperadoPorSemana: 9.5 }),
        'O bairro teve menos pedidos do que o mínimo que o Regem mostra por bairro (5 nos 14 dias); seguindo os outros bairros, faria 9,5 pedidos por semana.',
      ],
      [semConta('abaixo_do_minimo'), 'O bairro teve menos pedidos do que o mínimo que o Regem mostra por bairro.'],
      [semConta('sem_conta'), 'Faltou pedido de um dos lados, antes ou durante o teste: não há conta.'],
      [semConta('sem_leitura'), 'O Liame não conseguiu ler os pedidos do Regem dos 14 dias: sem eles, não há conta.'],
    ];
    for (const [resultado, detalhe] of casos) {
      expect(texto(resultado)).toEqual({
        kind: 'teste_regiao_com_resultado',
        severity: 'info',
        title: `O teste "${NOME}" terminou sem conta`,
        detail: detalhe,
        action: ACAO_SEM_CONTA,
      });
    }
  });

  it('o resultado fora da forma da medida não vira aviso', () => {
    expect(aviso(null)).toBeNull();
    expect(aviso({})).toBeNull();
    // A conta e o motivo juntos (a medida grava um dos dois).
    expect(aviso({ ...comConta(true, { de: 1, ate: 2 }), motivo: 'sem_conta' })).toBeNull();
    // Sem a hora da medida.
    const { medido_em: _, ...semHora } = comConta(true, { de: 1, ate: 2 });
    expect(aviso(semHora)).toBeNull();
    // O motivo que a medida não conhece.
    expect(aviso(semConta('outro'))).toBeNull();
  });
});
