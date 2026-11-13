import { describe, expect, it } from 'vitest';
import { ACASO_ACEITO_POR_OLHADA, acasoDoTeste, diaDaUltimaOlhada, vereditoDoTeste } from '../src/campanhas/teste-contas.js';

// As contas do teste de criativo (plano da região, R8; D-RG-79 e D-RG-91).

/** A conta feita do jeito direto, com números inteiros grandes, para conferir a que soma em logaritmo. */
function acasoExato(a: number, b: number): number {
  const n = a + b;
  const k = Math.max(a, b);
  let combinacao = 1n;
  let cauda = 0n;
  for (let i = 0; i <= n; i++) {
    if (i >= k) cauda += combinacao;
    combinacao = (combinacao * BigInt(n - i)) / BigInt(i + 1);
  }
  const total = 2n ** BigInt(n);
  return Math.min(1, Number((2n * cauda * 1_000_000_000n) / total) / 1_000_000_000);
}

describe('a conta do acaso do teste de criativo', () => {
  it('é o teste binomial exato dos dois lados: confere com a conta de números inteiros', () => {
    for (const [a, b] of [[11, 7], [41, 22], [24, 21], [0, 5], [5, 0], [1, 0], [30, 12], [3, 3], [100, 70]] as const) {
      expect(acasoDoTeste(a, b)).toBeCloseTo(acasoExato(a, b), 8);
    }
  });

  it('não depende de qual criativo está na frente, e é 1 sem pedido ou com os dois iguais', () => {
    expect(acasoDoTeste(41, 22)).toBe(acasoDoTeste(22, 41));
    expect(acasoDoTeste(0, 0)).toBe(1);
    expect(acasoDoTeste(8, 8)).toBe(1);
  });

  it('os exemplos do protótipo: 11 contra 7 cabe no acaso; 41 contra 22 é raro', () => {
    expect(acasoDoTeste(11, 7)).toBeGreaterThan(0.4);
    expect(acasoDoTeste(41, 22)).toBeLessThan(0.03);
    expect(acasoDoTeste(24, 21)).toBeGreaterThan(0.7);
  });

  it('aguenta muitos pedidos (2 elevado a n não cabe num número a partir de 1024)', () => {
    const p = acasoDoTeste(1300, 1200);
    expect(p).toBeGreaterThan(0.04);
    expect(p).toBeLessThan(0.05);
    expect(acasoDoTeste(3000, 1000)).toBeLessThan(1e-200);
  });

  it('recusa o que não é contagem', () => {
    expect(() => acasoDoTeste(-1, 3)).toThrow();
    expect(() => acasoDoTeste(1.5, 3)).toThrow();
  });
});

describe('o veredito do teste de criativo', () => {
  it('o Liame não espia: antes de fechar a primeira semana inteira, não olha', () => {
    for (const dia of [0, 1, 6]) {
      expect(vereditoDoTeste(dia, 40, 2)).toEqual({ situacao: 'cedo', semanas: 0, olhadoNoDia: null, acaso: null, vencedor: null });
      expect(diaDaUltimaOlhada(dia)).toBeNull();
    }
  });

  it('olha só ao fim de cada semana inteira: no dia 9, vale a olhada do dia 7', () => {
    expect(diaDaUltimaOlhada(7)).toBe(7);
    expect(diaDaUltimaOlhada(9)).toBe(7);
    expect(diaDaUltimaOlhada(13)).toBe(7);
    expect(diaDaUltimaOlhada(14)).toBe(14);
    expect(diaDaUltimaOlhada(23)).toBe(21);
    expect(diaDaUltimaOlhada(28)).toBe(28);
    expect(diaDaUltimaOlhada(40)).toBe(28);
    expect(vereditoDoTeste(9, 11, 7)).toMatchObject({ situacao: 'ainda_nao', semanas: 1, olhadoNoDia: 7, vencedor: null });
  });

  it('vencedor só quando o acaso da olhada fica abaixo do limite de cada olhada (quatro olhadas somam 5%)', () => {
    // 41 contra 22: abaixo de 5%, mas não do limite de uma olhada entre quatro. Ainda não venceu.
    const quase = vereditoDoTeste(21, 41, 22);
    expect(quase.acaso!).toBeLessThan(0.05);
    expect(quase.acaso!).toBeGreaterThan(ACASO_ACEITO_POR_OLHADA);
    expect(quase).toMatchObject({ situacao: 'ainda_nao', vencedor: null });
    // 45 contra 22: passou.
    expect(vereditoDoTeste(21, 45, 22)).toMatchObject({ situacao: 'venceu', olhadoNoDia: 21, vencedor: 'A' });
    expect(vereditoDoTeste(14, 9, 30)).toMatchObject({ situacao: 'venceu', olhadoNoDia: 14, vencedor: 'B' });
  });

  it('no último dia sem passar do limite, o teste acaba sem vencedor', () => {
    expect(vereditoDoTeste(28, 24, 21)).toMatchObject({ situacao: 'sem_vencedor', semanas: 4, olhadoNoDia: 28, vencedor: null });
    expect(vereditoDoTeste(35, 24, 21)).toMatchObject({ situacao: 'sem_vencedor', olhadoNoDia: 28 });
    expect(vereditoDoTeste(28, 0, 0)).toMatchObject({ situacao: 'sem_vencedor', acaso: 1 });
  });
});
