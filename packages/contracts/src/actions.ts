import { z } from 'zod';
import { AutonomyMode, BudgetImpact, PolicyDecision, RiskLevel } from './policy.js';

// Pedido de ação (ADR-007): toda escrita fora do Liame passa por aqui. Risco, impacto e valores vêm
// do registro de ferramentas e do estado lido no provedor, nunca de quem pede.

const Slug = z.string().regex(/^[a-z0-9_]+$/).max(60);
const Ref = z.string().min(1).max(100);
const Micros = z.int().min(0).max(Number.MAX_SAFE_INTEGER);

export const ActionStatus = z.enum(['sombra', 'aguardando_aprovacao', 'aprovada', 'executando', 'executada', 'falhou', 'cancelada', 'expirada']);
export type ActionStatus = z.infer<typeof ActionStatus>;

export const CreateActionRequest = z.strictObject({
  tool: Slug,
  brand_id: z.uuid().nullable().optional(),
  provider: Slug,
  account_id: Ref,
  resource_id: Ref,
  params: z.record(z.string(), z.unknown()),
  /**
   * A recomendação do Gestor de tráfego de que o pedido nasce (A4, X3): o "Pedir esta mudança" da Atenção. O servidor
   * confere que ela está em aberto, é da mesma conta e da mesma campanha e vai na mesma direção do pedido.
   */
  recommendation_id: z.uuid().optional(),
});
export type CreateActionRequest = z.infer<typeof CreateActionRequest>;

export const UpdateActionRequest = z.strictObject({ params: z.record(z.string(), z.unknown()) });
export type UpdateActionRequest = z.infer<typeof UpdateActionRequest>;

/** Aprovar exige o código do app autenticador agora (fora do chat, ADR-007) e o hash do plano visto. */
export const ApproveActionRequest = z.strictObject({
  plan_hash: z.string().regex(/^[0-9a-f]{64}$/),
  code: z.string().regex(/^\d{6}$/, { error: 'Digite os 6 números do app' }),
});
export type ApproveActionRequest = z.infer<typeof ApproveActionRequest>;

/**
 * Recusar (quem pode aprovar): o pedido sai da fila, nada é executado e o motivo fica no pedido e na auditoria.
 * O plano visto vai junto, como na aprovação: se o pedido mudou, a recusa não vale para a versão nova.
 */
export const RejectActionRequest = z.strictObject({
  plan_hash: z.string().regex(/^[0-9a-f]{64}$/),
  reason: z.string().trim().min(3, { error: 'Diga o motivo em poucas palavras' }).max(200),
});
export type RejectActionRequest = z.infer<typeof RejectActionRequest>;

export const ActionApproval = z.strictObject({
  approved_by: z.uuid(),
  approver_name: z.string(),
  approver_role: z.string(),
  sufficient: z.boolean(),
  /** A aprovação foi para o plano atual (se o plano mudou depois, ela não vale). */
  current_plan: z.boolean(),
  created_at: z.string(),
});

/**
 * A recomendação de que um pedido nasceu, com os números do retrato dela (os mesmos de Resultados na janela olhada):
 * é o porquê do pedido na tela de Aprovações. Dinheiro em micros, como texto.
 */
export const ActionRecommendation = z.strictObject({
  id: z.uuid(),
  /** A ação recomendada: `orcamento_reduzir`, `orcamento_aumentar` ou `campanha_pausar`. */
  tool: z.string(),
  /** A regra que recomendou e a versão do conjunto de regras. */
  rule: z.string(),
  rule_version: z.int().min(1),
  /** De 0 a 100, com uma casa. É evidência (gasto observado e margem conhecida), não probabilidade. */
  confidence_pct: z.string(),
  /** Só nas de verba: quanto a regra recomendou mudar, em porcento. */
  percent: z.int().min(0).max(100).nullable(),
  /** O dia da recomendação e a janela olhada (AAAA-MM-DD, no fuso da loja). */
  decided_on: z.string(),
  window: z.strictObject({ from: z.string(), to: z.string() }),
  /** A verba diária da campanha no dia da recomendação. */
  daily_budget_micros: z.string().nullable(),
  spend_micros: z.string().nullable(),
  /** Os pedidos, a receita e a margem do caixa na janela: nulos para quem não vê as vendas (`vendas.ver`). */
  orders: z.int().min(0).nullable(),
  revenue_micros: z.string().nullable(),
  margin_known_micros: z.string().nullable(),
  /** Parte da receita com margem conhecida, de 0 a 100, com uma casa. */
  margin_coverage_pct: z.string().nullable(),
});
export type ActionRecommendation = z.infer<typeof ActionRecommendation>;

export const ActionResponse = z.strictObject({
  id: z.uuid(),
  tool: z.string(),
  action: z.string(),
  brand_id: z.uuid().nullable(),
  provider: z.string(),
  account_id: z.string(),
  resource_id: z.string(),
  params: z.record(z.string(), z.unknown()),
  risk_level: RiskLevel,
  budget_impact: BudgetImpact,
  value_micros: Micros.nullable(),
  current_value_micros: Micros.nullable(),
  reserved_micros: Micros,
  plan_hash: z.string(),
  mode: AutonomyMode,
  status: ActionStatus,
  status_reason: z.string().nullable(),
  /**
   * Quantas vezes a execução esperou a plataforma (limite de uso da conta, fora do ar). A ação aprovada volta para a
   * fila com a hora da próxima tentativa, em vez de insistir; depois de seis esperas, falha.
   */
  attempts: z.int().min(0),
  /** Quando a execução tenta de novo; nulo quando não está esperando. */
  next_attempt_at: z.string().nullable(),
  /** A ação que este pedido desfaz (a volta), ou nulo. */
  undoes: z.uuid().nullable(),
  /** O pedido de volta mais recente desta ação (em qualquer situação), ou nulo. */
  undone_by: z.strictObject({ id: z.uuid(), status: ActionStatus }).nullable(),
  policy: PolicyDecision,
  approvals: z.array(ActionApproval),
  /** Estado durável do fluxo (ADR-005): política → orçamento → aprovação → execução. */
  workflow: z.strictObject({
    status: z.enum(['em_andamento', 'aguardando', 'concluido', 'falhou', 'cancelado']),
    steps: z.array(
      z.strictObject({
        name: z.string(),
        status: z.enum(['aguardando', 'concluido', 'falhou', 'pulado']),
        attempts: z.int(),
        finished_at: z.string().nullable(),
      }),
    ),
  }).nullable(),
  expires_at: z.string(),
  created_at: z.string(),
  /** A última mudança de situação (pedido, aprovação, recusa, execução). */
  updated_at: z.string(),
  /** Quem pediu; no pedido de um funcionário de IA (`agent_key`), a pessoa que o deixou pedir. */
  requested_by: z.strictObject({ id: z.uuid(), name: z.string() }),
  /** A conta do alvo, para a tela: a loja do Liame (ou o nome da conta conectada); nula quando a conta não é do Liame (sandbox). */
  account_name: z.string().nullable(),
  /** A campanha citada nos parâmetros (`campaign_id`), quando há; nula se ela saiu da lista. */
  campaign: z.strictObject({ id: z.uuid(), name: z.string(), provider: z.string(), status: z.string() }).nullable(),
  /** A recomendação do Gestor de tráfego de que o pedido nasceu (A4, X3); nula no pedido comum. */
  recommendation: ActionRecommendation.nullable().optional(),
  /**
   * O funcionário de IA que fez o pedido, no modo Aprovação (a chave dele em Sua equipe: `trafego`); nulo no pedido de
   * uma pessoa. No pedido do funcionário, `requested_by` é a pessoa que o deixou pedir (quem publicou a regra do modo).
   */
  agent_key: Slug.nullable().optional(),
});
export type ActionResponse = z.infer<typeof ActionResponse>;

export const ActionListResponse = z.strictObject({ items: z.array(ActionResponse) });
export type ActionListResponse = z.infer<typeof ActionListResponse>;

export const ActionListQuery = z.strictObject({ status: ActionStatus.optional() });
export type ActionListQuery = z.infer<typeof ActionListQuery>;

// ------------------------------------------------------------------ orçamento

export const BudgetPolicyRequest = z.strictObject({ brand_id: z.uuid().nullable().default(null), limit_micros: Micros });
export type BudgetPolicyRequest = z.infer<typeof BudgetPolicyRequest>;

export const BudgetEnvelope = z.strictObject({
  brand_id: z.uuid().nullable(),
  limit_micros: Micros,
  /** Reservado e ainda não liberado (inclui o já executado). */
  committed_micros: Micros,
  executed_micros: Micros,
  available_micros: z.int(),
});

export const BudgetResponse = z.strictObject({ period: z.string(), envelopes: z.array(BudgetEnvelope) });
export type BudgetResponse = z.infer<typeof BudgetResponse>;

// ------------------------------------------------------------------ verba do mês (A4, X4)

/** Dia no fuso da empresa (AAAA-MM-DD). */
const Dia = z.iso.date();

/**
 * Os dois limites que a empresa define para o Liame mexer em verba (D-A4-22), sempre juntos: o teto do mês (tudo o que
 * as contas conectadas podem gastar em anúncios no mês) e o teto por campanha (a maior verba diária que um aumento
 * pode deixar numa campanha ou num conjunto). O teto por campanha é por dia e não passa do teto do mês.
 */
export const BudgetLimitsRequest = z.strictObject({
  month_micros: z.int().min(1_000_000, { error: 'O teto do mês começa em R$ 1,00' }).max(Number.MAX_SAFE_INTEGER),
  campaign_daily_micros: z.int().min(1_000_000, { error: 'O teto por campanha começa em R$ 1,00' }).max(Number.MAX_SAFE_INTEGER),
});
export type BudgetLimitsRequest = z.infer<typeof BudgetLimitsRequest>;

/** O gasto de uma plataforma no mês, somando as contas conectadas dela. */
export const BudgetMonthPlatform = z.strictObject({
  provider: z.string(),
  accounts: z.int().min(1),
  /** Do primeiro dia do mês até `read_through`. */
  spend_micros: Micros,
  /** O ritmo: a média dos 7 dias inteiros mais recentes que a leitura cobre. */
  daily_micros: Micros,
  /** O gasto lido mais o ritmo vezes os dias que a leitura ainda não cobre, até o fim do mês. */
  forecast_micros: Micros,
  /** O último dia inteiro que as leituras cobrem (o mais antigo entre as contas); nulo se alguma nunca foi lida. */
  read_through: Dia.nullable(),
  /** Quantos dias entram na previsão pelo ritmo; nulo quando as contas da plataforma foram lidas até dias diferentes. */
  forecast_days: z.int().min(0).nullable(),
  /** A leitura de hoje ainda não chegou em alguma conta: o gasto vale só até `read_through`. */
  stale: z.boolean(),
  /** A leitura boa mais antiga entre as contas; nula se alguma nunca foi lida. */
  last_success_at: z.iso.datetime().nullable(),
});
export type BudgetMonthPlatform = z.infer<typeof BudgetMonthPlatform>;

/**
 * A verba do mês (D-A4-19): o que as contas de anúncio conectadas já gastaram no mês, a previsão de fechamento pelo
 * ritmo dos últimos 7 dias, os aumentos e as retomadas pedidos ou feitos hoje (que o ritmo ainda não mostra) e os dois
 * limites da empresa. O pedido que faz o gasto subir só passa se a previsão, com ele, couber no teto do mês.
 * Dinheiro em micros da moeda das contas, sempre em centavos inteiros: as parcelas somam o total que a tela mostra.
 */
export const BudgetMonthResponse = z.strictObject({
  /** O mês corrente no fuso da empresa (`2026-10`). */
  period: z.string().regex(/^\d{4}-\d{2}$/),
  timezone: z.string(),
  today: Dia,
  month_start: Dia,
  month_end: Dia,
  /** Ontem: o último dia com gasto quando as contas foram lidas hoje. */
  through: Dia,
  /** De hoje ao fim do mês, contando hoje. */
  days_left: z.int().min(1).max(31),
  currency: z.string(),
  spend_micros: Micros,
  daily_micros: Micros,
  forecast_micros: Micros,
  /** Os dias previstos pelo ritmo, quando são os mesmos em todas as contas; senão, nulo. */
  forecast_days: z.int().min(0).nullable(),
  /** Aumentos e retomadas pedidos (esperando aprovação ou execução) ou feitos hoje: quanto somam por dia. */
  pending_daily_micros: Micros,
  /** O mesmo, até o fim do mês (`pending_daily_micros` × `days_left`). */
  pending_micros: Micros,
  limits: z.strictObject({
    /** O teto do mês; nulo enquanto a empresa não define. */
    month_micros: Micros.nullable(),
    /** O teto por campanha (verba diária); nulo enquanto a empresa não define. */
    campaign_daily_micros: Micros.nullable(),
    /** Quem definiu os limites por último, e quando. */
    set_by: z.strictObject({ id: z.uuid(), name: z.string() }).nullable(),
    set_at: z.iso.datetime().nullable(),
  }),
  /** O que sobra do teto do mês: teto − previsão − aumentos de hoje. Negativo quando o mês passa do teto; nulo sem teto. */
  remaining_micros: z.int().nullable(),
  platforms: z.array(BudgetMonthPlatform),
  /** As regras da distribuição que a tela cita (valem para todas as empresas); nulas se a regra deixar de existir. */
  rules: z.strictObject({
    /** Quanto um pedido pode mexer na verba diária, em %. */
    change_percent_max: z.number().min(0).max(1000).nullable(),
    /** Mudanças de verba no mesmo objeto por janela. */
    rate_limit: z.strictObject({ max: z.int().min(1), window_minutes: z.int().min(1) }).nullable(),
  }),
  generated_at: z.iso.datetime(),
});
export type BudgetMonthResponse = z.infer<typeof BudgetMonthResponse>;

// ------------------------------------------------------------------ sandbox

export const SandboxResourceRequest = z.strictObject({ account_id: Ref, resource_id: Ref, state: z.record(z.string(), z.unknown()) });
export type SandboxResourceRequest = z.infer<typeof SandboxResourceRequest>;

export const SandboxResourceResponse = z.strictObject({
  account_id: z.string(),
  resource_id: z.string(),
  state: z.record(z.string(), z.unknown()),
  version: z.int(),
});
export type SandboxResourceResponse = z.infer<typeof SandboxResourceResponse>;
