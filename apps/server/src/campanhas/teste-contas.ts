// As contas do teste de criativo (plano da região, R8; protótipo aprovado pelo dono em 13/11/2026; D-RG-79 e D-RG-91).
// Partes puras: sem rede e sem banco.
//
// Quem decide é o caixa: os pedidos confirmados de cada criativo, com a mesma verba. Se os dois criativos fossem iguais,
// cada pedido cairia num ou no outro com 50% de chance; a conta diz a chance de uma diferença do tamanho da que apareceu
// (ou maior) surgir só por acaso. O Liame não espia (base §7.5): olha o teste só ao fim de cada semana inteira (os dias
// 7, 14, 21 e 28), e, para os 95% de confiança valerem com quatro olhadas, cada olhada pede mais do que 95% (D-RG-91).

/** O mínimo e o máximo de dias do teste de criativo (D-RG-79). */
export const DIAS_DO_TESTE_DE_CRIATIVO = { minimo: 7, maximo: 28 } as const;

/** O Liame só olha o teste ao fim de uma semana inteira: a semana pega todos os dias, o forte e o fraco. */
export const DIAS_DE_UMA_OLHADA = 7;

/**
 * A confiança pedida no teste inteiro (95%) e o que cada uma das quatro olhadas pode aceitar de acaso para o total não
 * passar de 5% (o limite igual em todas as olhadas, de Pocock, para quatro olhadas dos dois lados: 1,82% em cada uma).
 * Olhar quatro vezes com 5% em cada daria um vencedor falso em cerca de 13% dos testes sem diferença nenhuma.
 */
export const ACASO_ACEITO_NO_TESTE = 0.05;
export const ACASO_ACEITO_POR_OLHADA = 0.0182;

/**
 * A chance de uma diferença deste tamanho, ou maior, entre os pedidos dos dois criativos aparecer por acaso, se os dois
 * vendessem igual: o teste binomial exato dos dois lados com 50% (sem aproximação: com poucos pedidos a aproximação
 * erra). De 0 a 1; sem pedido nenhum, ou com os dois iguais, 1.
 */
export function acasoDoTeste(pedidosA: number, pedidosB: number): number {
  if (!Number.isInteger(pedidosA) || !Number.isInteger(pedidosB) || pedidosA < 0 || pedidosB < 0) throw new Error('os pedidos de cada criativo são inteiros de zero para cima');
  const n = pedidosA + pedidosB;
  if (n === 0) return 1;
  const k = Math.max(pedidosA, pedidosB);
  // A cauda P(X >= k) de uma binomial(n, 1/2), somada em logaritmo: 2^n não cabe num número a partir de n = 1024.
  const logDoTotal = n * Math.LN2;
  let logDaCombinacao = 0;
  let cauda = 0;
  for (let i = 0; i <= n; i++) {
    if (i >= k) cauda += Math.exp(logDaCombinacao - logDoTotal);
    if (i < n) logDaCombinacao += Math.log(n - i) - Math.log(i + 1);
  }
  return Math.min(1, 2 * cauda);
}

export type LetraDoTeste = 'A' | 'B';

export type VereditoDoTeste = {
  /**
   * `cedo` (a primeira semana inteira ainda não fechou: o Liame não olha), `ainda_nao` (olhou e a diferença cabe no
   * acaso), `venceu` (a diferença passou do limite numa olhada) ou `sem_vencedor` (chegou ao último dia sem passar).
   */
  situacao: 'cedo' | 'ainda_nao' | 'venceu' | 'sem_vencedor';
  /** Quantas semanas inteiras o teste já fechou (0 a 4): é o dia da última olhada dividido por 7. */
  semanas: number;
  /** O dia da última olhada (7, 14, 21 ou 28); nulo antes da primeira. */
  olhadoNoDia: number | null;
  /** A chance de acaso na última olhada, com os pedidos somados até ela; nula antes da primeira. */
  acaso: number | null;
  vencedor: LetraDoTeste | null;
};

/**
 * O veredito do teste num dia, pelos pedidos somados de cada criativo ATÉ a última semana inteira fechada (quem chama
 * soma até `olhadoNoDia`, e não até hoje: o que entrou depois da olhada só conta na próxima). `diasInteiros` é quantos
 * dias inteiros o teste já rodou, no fuso da loja.
 */
export function vereditoDoTeste(diasInteiros: number, pedidosA: number, pedidosB: number, dias: { minimo: number; maximo: number } = DIAS_DO_TESTE_DE_CRIATIVO): VereditoDoTeste {
  const corridos = Math.max(0, Math.min(Math.floor(diasInteiros), dias.maximo));
  const semanas = Math.floor(corridos / DIAS_DE_UMA_OLHADA);
  if (corridos < dias.minimo || semanas === 0) return { situacao: 'cedo', semanas, olhadoNoDia: null, acaso: null, vencedor: null };
  const olhadoNoDia = semanas * DIAS_DE_UMA_OLHADA;
  const acaso = acasoDoTeste(pedidosA, pedidosB);
  if (acaso < ACASO_ACEITO_POR_OLHADA && pedidosA !== pedidosB) {
    return { situacao: 'venceu', semanas, olhadoNoDia, acaso, vencedor: pedidosA > pedidosB ? 'A' : 'B' };
  }
  return { situacao: olhadoNoDia >= dias.maximo ? 'sem_vencedor' : 'ainda_nao', semanas, olhadoNoDia, acaso, vencedor: null };
}

/** O dia até onde somar os pedidos para o veredito de hoje: o fim da última semana inteira; nulo antes da primeira. */
export function diaDaUltimaOlhada(diasInteiros: number, dias: { minimo: number; maximo: number } = DIAS_DO_TESTE_DE_CRIATIVO): number | null {
  const corridos = Math.max(0, Math.min(Math.floor(diasInteiros), dias.maximo));
  const semanas = Math.floor(corridos / DIAS_DE_UMA_OLHADA);
  return corridos < dias.minimo || semanas === 0 ? null : semanas * DIAS_DE_UMA_OLHADA;
}
