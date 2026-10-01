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

/** O plano não pode ser montado com este estado (cupom que já existe, loja sem permissão): vira 422 no pedido. */
export class PlanoRecusado extends Error {}

const Dia = z.iso.date();
/**
 * Cupom de campanha no Regem (contrato de cupons §3.3). O código é o do recurso (`cupom:CODIGO`); a campanha e
 * "exclusivo" são do Liame: o cupom nasce ligado à campanha, e só o exclusivo prova de onde veio o pedido.
 */
const CupomParams = z
  .strictObject({
    codigo: z.string().regex(/^[A-Z0-9]{4,20}$/, { error: 'De 4 a 20 letras maiúsculas ou números, sem espaço' }),
    nome: z.string().trim().min(1).max(80).optional(),
    tipo: z.enum(['percentual', 'valor', 'frete_gratis']),
    /** Só no percentual: de 1 a 100, inteiro (o Regem recebe com duas casas). */
    percentual: z.int().min(1).max(100).optional(),
    /** Só no valor fixo. */
    valor_centavos: z.int().min(1).max(100_000_000).optional(),
    pedido_minimo_centavos: z.int().min(0).max(100_000_000).default(0),
    valido_de: Dia,
    valido_ate: Dia,
    campaign_id: z.uuid(),
    exclusive: z.boolean(),
  })
  .superRefine((p, ctx) => {
    if (p.tipo === 'percentual' && p.percentual === undefined) ctx.addIssue({ code: 'custom', path: ['percentual'], message: 'Informe o desconto em %' });
    if (p.tipo !== 'percentual' && p.percentual !== undefined) ctx.addIssue({ code: 'custom', path: ['percentual'], message: 'O percentual só vale no cupom percentual' });
    if (p.tipo === 'valor' && p.valor_centavos === undefined) ctx.addIssue({ code: 'custom', path: ['valor_centavos'], message: 'Informe o valor do desconto' });
    if (p.tipo !== 'valor' && p.valor_centavos !== undefined) ctx.addIssue({ code: 'custom', path: ['valor_centavos'], message: 'O valor só vale no cupom de valor fixo' });
    if (p.valido_ate < p.valido_de) ctx.addIssue({ code: 'custom', path: ['valido_ate'], message: 'O fim não pode ser antes do início' });
  });

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
  regem_cupom_criar: {
    name: 'regem_cupom_criar',
    description: 'Cria um cupom de campanha na loja do Regem e liga à campanha.',
    risk: 'R1',
    providers: ['regem'],
    compensation: 'desativar_cupom',
    params: CupomParams,
    plan(before, params) {
      const p = CupomParams.parse(params);
      if (before.codigo !== p.codigo) throw new PlanoRecusado('O código do cupom não confere com o recurso do pedido.');
      if (before.pode_criar !== true) throw new PlanoRecusado('A loja não liberou "criar cupom de campanha" no Regem. Autorize de novo em Contas conectadas e ligue essa chave lá.');
      if (before.existe === true) throw new PlanoRecusado('Já existe um cupom com este código nesta loja. Escolha outro código.');
      const regra = {
        codigo: p.codigo,
        nome: p.nome ?? `Campanha · ${p.codigo}`,
        tipo: p.tipo,
        ...(p.tipo === 'percentual' ? { percentual: `${p.percentual}.00` } : {}),
        ...(p.tipo === 'valor' ? { valor_centavos: p.valor_centavos } : {}),
        ...(p.pedido_minimo_centavos > 0 ? { pedido_minimo_centavos: p.pedido_minimo_centavos } : {}),
        valido_de: p.valido_de,
        valido_ate: p.valido_ate,
      };
      return {
        action: 'cupom.criar',
        // O desconto sai do caixa da loja, não do orçamento de mídia: nada a reservar no envelope.
        budgetImpact: 'none',
        valueMicros: null,
        currentValueMicros: null,
        reserveMicros: 0,
        desiredState: { codigo: p.codigo, existe: true, regra, campanha: { id: p.campaign_id, exclusivo: p.exclusive } },
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
