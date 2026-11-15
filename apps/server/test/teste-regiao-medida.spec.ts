import { describe, expect, it } from 'vitest';
import { efeitoDoBairro } from '../src/campanhas/teste-regiao-contas.js';
import { janelaDoTesteDeRegiao, leituraVencida, medidaDoTesteDeRegiao, pedidosPorBairro } from '../src/campanhas/teste-regiao-medida.js';
import { ResultadoDoTesteDeRegiao } from '../src/campanhas/teste-regiao-plano.js';

// R8, a medida do teste de região (D-RG-81, D-RG-82 e D-RG-102), sem rede e sem banco: a janela dos 14 dias, a soma dos
// pedidos por bairro (a mesma regra do pedido do teste) e o resultado: o que prova, o que não prova, o bairro de comparar
// que some nos dias do teste (sai dos dois lados), poucos bairros, o bairro do teste abaixo do mínimo do Regem, uma
// contagem zero e o teste incompleto.

const MEDIDO_EM = new Date('2026-11-16T09:00:00.000Z');
const JANELA = janelaDoTesteDeRegiao('2026-11-01', '2026-11-14');

/** As 4 semanas de antes, como o plano guarda: a Lapa (o bairro do teste) e os de comparar. */
const ANTES = [
  { nome: 'Centro', pedidos: 1000 },
  { nome: 'Lapa', pedidos: 480 },
  { nome: 'Glória', pedidos: 412 },
  { nome: 'Saúde', pedidos: 300 },
];

describe('a janela do teste e a espera da leitura', () => {
  it('14 dias a partir do primeiro dia sem anúncio; o fim depois não alonga, o fim antes deixa incompleto', () => {
    expect(JANELA).toEqual({ de: '2026-11-01', ate: '2026-11-14', completa: true });
    expect(janelaDoTesteDeRegiao('2026-11-01', '2026-11-15')).toEqual({ de: '2026-11-01', ate: '2026-11-14', completa: true });
    expect(janelaDoTesteDeRegiao('2026-10-25', '2026-11-07')).toEqual({ de: '2026-10-25', ate: '2026-11-07', completa: true });
    expect(janelaDoTesteDeRegiao('2026-11-01', '2026-11-13')).toEqual({ de: '2026-11-01', ate: '2026-11-13', completa: false });
  });

  it('a leitura vence depois de 7 dias do fim, no dia do fuso do teste', () => {
    expect(leituraVencida('2026-11-14', '2026-11-15')).toBe(false);
    expect(leituraVencida('2026-11-14', '2026-11-21')).toBe(false);
    expect(leituraVencida('2026-11-14', '2026-11-22')).toBe(true);
    expect(leituraVencida('2026-12-28', '2027-01-05')).toBe(true);
  });
});

describe('os pedidos por bairro (a regra do pedido do teste)', () => {
  it('só os bairros com nome do município da loja, somados pelo nome como a tela compara, do maior para o menor', () => {
    const linhas = [
      { bairro: 'Centro', cidade: 'Rio de Janeiro', pedidos: 500 },
      { bairro: 'LAPA', cidade: 'rio de janeiro', pedidos: 80 },
      { bairro: 'Centro', cidade: 'Niterói', pedidos: 70 },
      { bairro: 'centro ', cidade: null, pedidos: 20 },
      { bairro: null, cidade: 'Rio de Janeiro', pedidos: 30 },
      { bairro: 'Gloria', cidade: 'Rio de Janeiro', pedidos: 90 },
    ];
    expect(pedidosPorBairro(linhas, 'Rio de Janeiro')).toEqual([
      { nome: 'Centro', pedidos: 520 },
      { nome: 'Gloria', pedidos: 90 },
      { nome: 'LAPA', pedidos: 80 },
    ]);
    // Sem a cidade da loja, nenhum bairro fica de fora pela cidade.
    expect(pedidosPorBairro(linhas, null).find((b) => b.nome === 'Centro')?.pedidos).toBe(590);
  });
});

describe('o resultado do teste (D-RG-102)', () => {
  const medir = (durante: Array<{ nome: string; pedidos: number }> | null, antes = ANTES, janela = JANELA) =>
    ResultadoDoTesteDeRegiao.parse(medidaDoTesteDeRegiao({ bairro: 'Lapa', antes, janela, leitura: durante ? { minimo: 5, bairros: durante } : null, medidoEm: MEDIDO_EM }));

  it('prova: a Lapa caiu sem anúncio enquanto os outros seguiram; a faixa fica acima de zero (os nomes casam sem acento e sem caixa)', () => {
    const r = medir([
      { nome: 'CENTRO', pedidos: 520 },
      { nome: 'lapa', pedidos: 168 },
      { nome: 'Gloria', pedidos: 210 },
      { nome: 'Saude', pedidos: 150 },
      { nome: 'Barra', pedidos: 40 },
    ]);
    const conta = efeitoDoBairro({ alvoAntes: 480, outrosAntes: 1712, alvoDurante: 168, outrosDurante: 880, semanasAntes: 4, diasDurante: 14 })!;
    expect(r).toEqual({
      janela: { de: '2026-11-01', ate: '2026-11-14' },
      pedidos: { alvoAntes: 480, outrosAntes: 1712, alvoDurante: 168, outrosDurante: 880 },
      bairros: ['Centro', 'Glória', 'Saúde'],
      efeito: conta,
      motivo: null,
      esperadoPorSemana: null,
      minimoDoRegem: 5,
      medido_em: '2026-11-16T09:00:00.000Z',
    });
    expect(r.efeito!.provou).toBe(true);
    expect(r.efeito!.faixa.de).toBeGreaterThan(0);
    expect(r.efeito!.feitoPorSemana).toBe(84);
  });

  it('não prova: com poucos pedidos, a mesma queda cabe no acaso e a faixa começa em zero', () => {
    const antes = [
      { nome: 'Centro', pedidos: 250 },
      { nome: 'Lapa', pedidos: 120 },
      { nome: 'Glória', pedidos: 100 },
      { nome: 'Saúde', pedidos: 78 },
    ];
    const r = medir(
      [
        { nome: 'Centro', pedidos: 130 },
        { nome: 'Lapa', pedidos: 42 },
        { nome: 'Glória', pedidos: 50 },
        { nome: 'Saúde', pedidos: 40 },
      ],
      antes,
    );
    expect(r.pedidos).toEqual({ alvoAntes: 120, outrosAntes: 428, alvoDurante: 42, outrosDurante: 220 });
    expect(r.motivo).toBeNull();
    expect(r.efeito!.provou).toBe(false);
    expect(r.efeito!.faixa.de).toBe(0);
    expect(Math.round(r.efeito!.faixa.ate)).toBe(17);
  });

  it('o bairro de comparar que não veio pelo nome nos dias do teste sai dos dois lados', () => {
    const antes = [...ANTES, { nome: 'Pouco', pedidos: 60 }];
    const durante = [
      { nome: 'Centro', pedidos: 520 },
      { nome: 'Lapa', pedidos: 168 },
      { nome: 'Glória', pedidos: 210 },
      { nome: 'Saúde', pedidos: 150 },
    ];
    const r = medir(durante, antes);
    // Os 60 pedidos de antes do "Pouco" não entram: sem ele no teste, a conta comparava 4 bairros antes com 3 durante.
    expect(r.pedidos).toEqual({ alvoAntes: 480, outrosAntes: 1712, alvoDurante: 168, outrosDurante: 880 });
    expect(r.bairros).toEqual(['Centro', 'Glória', 'Saúde']);
    expect(r.efeito).toEqual(medir(durante).efeito);
  });

  it('poucos bairros: com menos de 3 bairros de comparar nos dois lados, não há conta', () => {
    const r = medir([
      { nome: 'Centro', pedidos: 520 },
      { nome: 'Lapa', pedidos: 168 },
      { nome: 'Glória', pedidos: 210 },
    ]);
    expect(r).toMatchObject({ motivo: 'poucos_bairros', efeito: null, esperadoPorSemana: null, bairros: ['Centro', 'Glória'], minimoDoRegem: 5 });
    expect(r.pedidos).toEqual({ alvoAntes: 480, outrosAntes: 1412, alvoDurante: 168, outrosDurante: 730 });
  });

  it('abaixo do mínimo: a Lapa não veio pelo nome; vai o mínimo do Regem e o que ela faria seguindo os outros, sem número inventado', () => {
    const r = medir([
      { nome: 'Centro', pedidos: 520 },
      { nome: 'Glória', pedidos: 210 },
      { nome: 'Saúde', pedidos: 150 },
    ]);
    expect(r).toMatchObject({ motivo: 'abaixo_do_minimo', efeito: null, minimoDoRegem: 5, bairros: ['Centro', 'Glória', 'Saúde'] });
    expect(r.pedidos).toEqual({ alvoAntes: 480, outrosAntes: 1712, alvoDurante: null, outrosDurante: 880 });
    // 480 × 880 / 1712 nos 14 dias, por semana.
    expect(r.esperadoPorSemana).toBeCloseTo((480 * 880) / 1712 / 2, 6);
  });

  it('sem conta: uma das quatro contagens deu zero (a Lapa sem pedidos nas semanas de antes)', () => {
    const antes = ANTES.filter((b) => b.nome !== 'Lapa');
    const r = medir(
      [
        { nome: 'Centro', pedidos: 520 },
        { nome: 'Lapa', pedidos: 30 },
        { nome: 'Glória', pedidos: 210 },
        { nome: 'Saúde', pedidos: 150 },
      ],
      antes,
    );
    expect(r).toMatchObject({ motivo: 'sem_conta', efeito: null, esperadoPorSemana: null });
    expect(r.pedidos).toEqual({ alvoAntes: 0, outrosAntes: 1712, alvoDurante: 30, outrosDurante: 880 });
  });

  it('incompleto: o teste parou antes dos 14 dias; nada de conta, mesmo com a leitura; sem leitura, o motivo dela', () => {
    const curta = janelaDoTesteDeRegiao('2026-11-01', '2026-11-09');
    const r = medir([{ nome: 'Lapa', pedidos: 100 }], ANTES, curta);
    expect(r).toEqual({
      janela: { de: '2026-11-01', ate: '2026-11-09' },
      pedidos: { alvoAntes: 480, outrosAntes: 1712, alvoDurante: null, outrosDurante: null },
      bairros: ['Centro', 'Glória', 'Saúde'],
      efeito: null,
      motivo: 'incompleto',
      esperadoPorSemana: null,
      minimoDoRegem: null,
      medido_em: '2026-11-16T09:00:00.000Z',
    });
    expect(medir(null)).toMatchObject({ motivo: 'sem_leitura', efeito: null, minimoDoRegem: null, pedidos: { alvoDurante: null, outrosDurante: null } });
  });

  it('o resultado guardado leva a conta ou o motivo, um dos dois', () => {
    const r = medir(null);
    expect(ResultadoDoTesteDeRegiao.safeParse({ ...r, motivo: null }).success).toBe(false);
    expect(ResultadoDoTesteDeRegiao.safeParse({ ...r, motivo: 'outro' }).success).toBe(false);
  });
});
