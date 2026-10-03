import { z } from 'zod';
import { AutonomyMode } from './policy.js';

// Autonomia por conta e ação (A3, I13; `ai-architecture.md` §4.1 e §4.2; protótipo P7, aguardando aprovação). O
// modo de cada ação numa conta vem da política (a regra mais específica vence; sem regra, Sombra). A prontidão não
// é uma nota: são os cinco portões da sombra (I5), por conta e ação. Quando todos passam, o sistema propõe a
// promoção de Sombra para Sugerir, e uma pessoa aprova ou recusa; depois, ela pode voltar para Sombra a qualquer
// momento. Aprovar e voltar publicam uma versão nova da política da marca. Nada é executado: na A3, Sugerir quer
// dizer que a recomendação aparece na Atenção, e quem muda na plataforma é a pessoa. Dinheiro em micros (texto);
// porcentagens com uma casa (texto). Listas que crescem vão como texto (V23); no pedido, a lista fechada.

const Slug = z.string().regex(/^[a-z0-9_]+$/).max(60);
/** Valor em micros da moeda (1 real = 1.000.000), em texto. */
const Micros = z.string().regex(/^-?\d+$/);
/** Porcentagem com uma casa ("83.4"); nula sem amostra. */
const Porcento = z.string().regex(/^\d{1,3}\.\d$/).nullable();
const Pessoa = z.strictObject({ id: z.uuid(), name: z.string() }).nullable();

/** As ações que a sombra recomenda (as ferramentas da sombra). */
export const SHADOW_TOOLS = ['orcamento_reduzir', 'campanha_pausar', 'orcamento_aumentar'] as const;
export const ShadowTool = z.enum(SHADOW_TOOLS);
export type ShadowTool = z.infer<typeof ShadowTool>;

/** Os cinco portões da prontidão (`readiness_snapshot.missing`). */
export const READINESS_GATES = ['amostra', 'concordancia', 'piora', 'arrependimento', 'confianca'] as const;

export const AutonomyThresholds = z.strictObject({
  /** Decisões comparáveis, no mínimo. */
  sample_size: z.int(),
  /** Concordância mínima (a pessoa fez o mesmo ou foi na mesma direção), em %. */
  agreement_min_pct: z.int(),
  /** Parte máxima das comparáveis em que o Liame teria piorado, em %. */
  worse_max_pct: z.int(),
  /** Soma máxima do arrependimento: zero quer dizer, na soma, não pior que o que foi feito. */
  regret_max_micros: Micros,
  /** Confiança média mínima, em %. */
  confidence_min_pct: z.int(),
  /** Depois de uma recusa (ou da volta para Sombra), quantas decisões comparáveis a mais até a próxima proposta. */
  sample_after_rejection: z.int(),
});
export type AutonomyThresholds = z.infer<typeof AutonomyThresholds>;

export const AutonomyReadiness = z.strictObject({
  /** O dia do retrato, no fuso da loja. */
  computed_on: z.iso.date(),
  /** A versão das regras da sombra que gerou a amostra. */
  rule_version: z.int().min(1),
  sample_size: z.int().min(0),
  agreement_pct: Porcento,
  worse_pct: Porcento,
  /** Negativo: na soma, o Liame teria feito melhor que o que foi feito. */
  regret_sum_micros: Micros,
  confidence_avg_pct: Porcento,
  /** Os portões que ainda não passaram (`amostra`, `concordancia`, `piora`, `arrependimento`, `confianca`); vazio: passou em todos. */
  missing: z.array(Slug),
});
export type AutonomyReadiness = z.infer<typeof AutonomyReadiness>;

export const AutonomyProposalSummary = z.strictObject({
  id: z.uuid(),
  /** `pendente`, `aprovada`, `recusada`, `retirada` (os portões deixaram de passar, ou o modo mudou por outro caminho) ou `desfeita` (voltou para Sombra). */
  status: Slug,
  from_mode: AutonomyMode,
  to_mode: AutonomyMode,
  /** A amostra na hora da proposta. */
  sample_size: z.int().min(0),
  proposed_at: z.iso.datetime(),
  decided_by: Pessoa,
  decided_at: z.iso.datetime().nullable(),
  /** A versão da política da marca que a aprovação publicou. */
  policy_version: z.int().nullable(),
  undone_by: Pessoa,
  undone_at: z.iso.datetime().nullable(),
  /** O motivo da recusa, da volta para Sombra ou da retirada. */
  reason: z.string().nullable(),
  /** Recusada, desfeita ou retirada: com quantas decisões comparáveis o sistema propõe de novo. */
  next_sample_size: z.int().nullable(),
});
export type AutonomyProposalSummary = z.infer<typeof AutonomyProposalSummary>;

export const AutonomyItem = z.strictObject({
  connected_account_id: z.uuid(),
  /** `meta_ads` ou `google_ads`. */
  provider: Slug,
  account_name: z.string(),
  /** A ferramenta da sombra: `orcamento_reduzir`, `campanha_pausar` ou `orcamento_aumentar`. */
  tool: Slug,
  /** A ação da política: `orcamento.reduzir`, `campanha.pausar` ou `orcamento.aumentar`. */
  action: z.string(),
  /** O modo de agora, pelo motor de políticas. */
  mode: AutonomyMode,
  /** De onde vem o modo: `padrao` (nenhuma regra casa), `plataforma`, `empresa` ou `marca`, com a versão da política. */
  mode_source: z.strictObject({ policy: Slug, version: z.int().nullable() }),
  /** O último retrato da prontidão (nulo antes da primeira decisão avaliada). */
  readiness: AutonomyReadiness.nullable(),
  /** A proposta pendente ou, sem ela, a mais recente. */
  proposal: AutonomyProposalSummary.nullable(),
});
export type AutonomyItem = z.infer<typeof AutonomyItem>;

export const AutonomyQuery = z.strictObject({ brand_id: z.uuid() });
export type AutonomyQuery = z.infer<typeof AutonomyQuery>;

export const AutonomyResponse = z.strictObject({
  brand_id: z.uuid(),
  /** Cada conta e ação com sombra registrada: a proposta pendente primeiro, depois as em Sugerir, depois a mais perto dos portões. */
  items: z.array(AutonomyItem),
  thresholds: AutonomyThresholds,
  /** A pessoa pode aprovar, recusar e voltar para Sombra (`politicas.gerenciar`). */
  can_decide: z.boolean(),
  generated_at: z.iso.datetime(),
});
export type AutonomyResponse = z.infer<typeof AutonomyResponse>;

export const RejectAutonomyRequest = z.strictObject({ reason: z.string().trim().min(3).max(300).optional() });
export type RejectAutonomyRequest = z.infer<typeof RejectAutonomyRequest>;

export const UndoAutonomyRequest = z.strictObject({
  connected_account_id: z.uuid(),
  tool: ShadowTool,
  reason: z.string().trim().min(3).max(300).optional(),
});
export type UndoAutonomyRequest = z.infer<typeof UndoAutonomyRequest>;
