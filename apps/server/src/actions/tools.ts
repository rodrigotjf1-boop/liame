import type { BudgetImpact, RiskLevel } from '@liame/contracts';
import { z } from 'zod';

// Registro de ferramentas (arquitetura §6, ADR-007): cada ferramenta declara risco, impacto financeiro,
// estratégia de compensação e o formato dos parâmetros. Ferramenta nova só entra com isso e com testes.

export type ResourceState = Record<string, unknown>;

export interface ToolPlan {
  /** Código da ação para a política: `orcamento.aumentar`, `anuncio.pausar`. */
  action: string;
  budgetImpact: BudgetImpact;
  valueMicros: number | null;
  currentValueMicros: number | null;
  /** Quanto reservar no envelope do mês. */
  reserveMicros: number;
  desiredState: ResourceState;
}

export interface ToolDefinition {
  name: string;
  description: string;
  risk: RiskLevel;
  providers: readonly string[];
  compensation: string;
  params: z.ZodType<Record<string, unknown>>;
  /** Do estado atual e dos parâmetros, o plano. Função pura: a mesma entrada dá o mesmo plano. */
  plan(before: ResourceState, params: Record<string, unknown>): ToolPlan;
}

const BudgetParams = z.strictObject({ daily_budget_micros: z.int().min(1_000_000).max(Number.MAX_SAFE_INTEGER) });
const NoParams = z.strictObject({});

const budgetOf = (s: ResourceState): number => {
  const v = s.daily_budget_micros;
  if (typeof v !== 'number') throw new Error('o recurso não tem daily_budget_micros');
  return v;
};

export const TOOLS: Record<string, ToolDefinition> = {
  orcamento_ajustar: {
    name: 'orcamento_ajustar',
    description: 'Muda o orçamento diário de uma campanha ou conjunto.',
    risk: 'R3',
    providers: ['sandbox'],
    compensation: 'restaurar_orcamento_anterior_se_inalterado',
    params: BudgetParams,
    plan(before, params) {
      const { daily_budget_micros: value } = BudgetParams.parse(params);
      const current = budgetOf(before);
      const increase = value > current;
      return {
        action: increase ? 'orcamento.aumentar' : 'orcamento.reduzir',
        budgetImpact: value === current ? 'none' : increase ? 'increase' : 'decrease',
        valueMicros: value,
        currentValueMicros: current,
        // Reserva a diferença de um dia a mais de gasto; redução não reserva.
        reserveMicros: increase ? value - current : 0,
        desiredState: { ...before, daily_budget_micros: value },
      };
    },
  },
  anuncio_pausar: {
    name: 'anuncio_pausar',
    description: 'Pausa um anúncio (reversível).',
    risk: 'R1',
    providers: ['sandbox'],
    compensation: 'reativar_se_inalterado',
    params: NoParams,
    plan(before) {
      return {
        action: 'anuncio.pausar',
        budgetImpact: 'decrease',
        valueMicros: null,
        currentValueMicros: null,
        reserveMicros: 0,
        desiredState: { ...before, status: 'pausado' },
      };
    },
  },
};
