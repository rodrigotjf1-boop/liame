// Teto de custo de IA por empresa (D-A3-3, `ai-architecture.md` §10): alarme em 70%, modelo
// econômico a partir de 80% e, em 100%, só o que é determinístico. Vale o pior entre o dia e o mês.

export type SituacaoDoTeto = 'livre' | 'alerta' | 'economico' | 'bloqueado';

export interface Gasto {
  gastoDia: bigint;
  gastoMes: bigint;
  tetoDia: bigint;
  tetoMes: bigint;
}

const ORDEM: SituacaoDoTeto[] = ['livre', 'alerta', 'economico', 'bloqueado'];

function de(gasto: bigint, teto: bigint): SituacaoDoTeto {
  if (gasto >= teto) return 'bloqueado';
  if (gasto * 100n >= teto * 80n) return 'economico';
  if (gasto * 100n >= teto * 70n) return 'alerta';
  return 'livre';
}

export function situacaoDoTeto(g: Gasto): SituacaoDoTeto {
  const dia = de(g.gastoDia, g.tetoDia);
  const mes = de(g.gastoMes, g.tetoMes);
  return ORDEM.indexOf(dia) >= ORDEM.indexOf(mes) ? dia : mes;
}

/** A chamada que acabou de entrar fez a empresa mudar de faixa? (o aviso sai uma vez, na virada). */
export function virouDeFaixa(antes: Gasto, custo: bigint): SituacaoDoTeto | null {
  const depois = situacaoDoTeto({ ...antes, gastoDia: antes.gastoDia + custo, gastoMes: antes.gastoMes + custo });
  return depois !== situacaoDoTeto(antes) ? depois : null;
}
