import { z } from 'zod';
import { ChaveNoLugarDoCodigo } from './passkeys.js';
import { ExplanationNumber, ExplanationSegment } from './ai.js';

// Planos do Estrategista (A3, I11; protótipo P8, aguardando aprovação): o plano de 90 dias (objetivos, mês a mês,
// verba por canal e o calendário comercial), a pauta da semana (dia a dia) e a oferta (a promoção pedida). O
// Estrategista propõe; quem decide é a pessoa: aprovar (com o código do app, para o hash que ela viu), editar (nasce
// uma versão nova, e a aprovação antiga deixa de valer), recusar (com o motivo) ou pedir nova análise. Nada é
// executado: quem muda campanha, verba ou cardápio é quem cuida deles. A verba de hoje é calculada pelo código (o
// gasto dos 7 dias completos levado para 30 dias); o Estrategista só propõe a nova. Listas que crescem vão como
// texto na resposta (V23); no pedido, a lista fechada.

const Slug = z.string().regex(/^[a-z0-9_]+$/).max(60);
const Dia = z.iso.date();
const Hora = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, { error: 'Use HH:MM' });
const Texto = (max: number) => z.string().trim().min(1).max(max);
/** Reais inteiros por mês (a tela mostra "R$ 1.400,00"). */
const Reais = z.int().min(0).max(10_000_000);

export const PLAN_KINDS = ['noventa_dias', 'pauta', 'oferta'] as const;
export const PlanKind = z.enum(PLAN_KINDS);
export type PlanKind = z.infer<typeof PlanKind>;

/** O que é comum aos três tipos: a frase do plano, os porquês, o risco, o que fazer e o que acontece depois. */
const Comum = {
  /** O que o plano propõe, numa ou duas frases. */
  summary: Texto(400),
  /** Os porquês, cada um com o número que o sustenta (a fonte de cada número está em `numbers`). */
  reasons: z.array(Texto(300)).min(1).max(3),
  risk: z.enum(['baixo', 'medio', 'alto']),
  /** Por que o risco é esse: começa em minúscula, para vir depois do selo ("Risco médio"). */
  risk_reason: Texto(300),
  /** O que a pessoa faz depois de aprovar (nada é executado pelo Liame). */
  to_do: z.array(Texto(240)).max(3),
  /** O que acontece depois ("a revisão de segunda mostra o resultado"). */
  after: Texto(300),
};

/** Verba de anúncios por mês, por canal, em reais inteiros: a de hoje (calculada pelo código) e a proposta. */
export const PlanBudget = z.strictObject({
  today: z.strictObject({ meta: Reais, google: Reais }),
  proposal: z.strictObject({ meta: Reais, google: Reais }),
});
export type PlanBudget = z.infer<typeof PlanBudget>;

// O plano de mídia por região (plano da região, R5; revisão P45 do P8; D-RG-26 a D-RG-31): dentro do plano de 90 dias,
// só quando a marca tem loja no mapa e a função `regiao` ligada. O código faz os anéis do raio, o dinheiro de cada anel e
// os horários (dos pedidos da loja ou, sem pedidos que bastem, da referência do setor); o Estrategista escolhe a parte de
// cada etapa do funil, dentro das regras, e escreve o criativo de cada uma. Nada é executado: a campanha com raio é a R6.

/** As etapas do funil local (plano da região §4.1), na ordem. A recompra fica fora da verba de mídia. */
export const MEDIA_STAGES = ['reconhecimento', 'seguidores', 'cardapio_conversa', 'pedido'] as const;
export const MediaStageKind = z.enum(MEDIA_STAGES);
export type MediaStageKind = z.infer<typeof MediaStageKind>;
const Parte = z.int().min(0).max(100);
/** Quilômetros do raio, em passos de 0,5 (D-RG-15). */
const Km = z.number().min(0).max(15).multipleOf(0.5);

/** Um anel do raio de entrega: a parte da verba da loja e quanto isso dá em cada canal, por mês (contas do código). */
export const MediaRing = z.strictObject({
  ring: z.enum(['nucleo', 'expansao']),
  from_km: Km,
  to_km: Km,
  share: Parte,
  meta: Reais,
  google: Reais,
});
export type MediaRing = z.infer<typeof MediaRing>;

/**
 * Os horários da loja (D-RG-29): os dias mais fortes e o bloco de até 4 horas com mais pedidos, dos pedidos confirmados
 * da própria loja; sem pedidos que bastem, a referência do setor (imprensa), dita como tal. Os anúncios começam 1 hora
 * antes do bloco.
 */
export const MediaHours = z.strictObject({
  /** `loja` (os pedidos dela, pelo Regem) ou `setor` (a referência da imprensa, nunca como número da loja). */
  source: z.enum(['loja', 'setor']),
  /** Os dias mais fortes (0 = domingo), na ordem da semana a partir de segunda. */
  days: z.array(z.int().min(0).max(6)).min(1).max(7),
  /** O bloco de horas com mais pedidos: começa em `from` e acaba em `to` (pode passar da meia-noite). */
  from: Hora,
  to: Hora,
  /** Quando os anúncios começam: 1 hora antes do bloco. */
  ads_from: Hora,
  /** A parte dos pedidos que caem nesses dias e nesse bloco; nulas na referência do setor. */
  days_share: Parte.nullable(),
  hours_share: Parte.nullable(),
  /** Os dias dos pedidos lidos (as 4 semanas completas até ontem); nulos na referência do setor. */
  orders_from: Dia.nullable(),
  orders_to: Dia.nullable(),
});
export type MediaHours = z.infer<typeof MediaHours>;

/** Uma loja no plano de mídia: o nome, o bairro e o município (nunca o endereço, D-RG-2), o raio, os anéis e os horários. */
export const StoreMediaPlan = z.strictObject({
  unit_id: z.uuid(),
  store: Texto(120),
  district: z.string().trim().min(1).max(120).nullable(),
  city: z.string().trim().min(1).max(120).nullable(),
  radius_km: Km,
  rings: z.array(MediaRing).min(1).max(2),
  hours: MediaHours,
});
export type StoreMediaPlan = z.infer<typeof StoreMediaPlan>;

/** Uma etapa do funil: a parte da verba (as quatro somam 100) e o criativo que o Estrategista propõe para ela. */
export const MediaStage = z.strictObject({
  stage: MediaStageKind,
  share: Parte,
  creative: Texto(240),
});
export type MediaStage = z.infer<typeof MediaStage>;

export const MediaPlan = z.strictObject({
  /** Até 5 lojas no mapa; a verba proposta se divide igual entre elas. */
  stores: z.array(StoreMediaPlan).min(1).max(5),
  /** As quatro etapas, na ordem de `MEDIA_STAGES`. */
  stages: z.array(MediaStage).length(4),
});
export type MediaPlan = z.infer<typeof MediaPlan>;

export const NinetyDaysPlanContent = z.strictObject({
  kind: z.literal('noventa_dias'),
  ...Comum,
  goals: z.array(z.strictObject({ goal: Texto(200), how_to_know: Texto(300) })).min(1).max(3),
  /** Os três meses, em ordem ("Outubro": o que fazer). */
  months: z.array(z.strictObject({ month: Texto(20), plan: Texto(400) })).min(1).max(3),
  budget: PlanBudget,
  /** As datas do calendário comercial que o plano usa (dia e nome, como estão na tabela do Liame) e o que fazer em cada uma. */
  dates: z.array(z.strictObject({ day: Dia, name: Texto(120), what: Texto(240) })).max(12),
  /** O plano de mídia por região (R5): só com loja no mapa e a função `regiao` ligada na marca. */
  media_plan: MediaPlan.optional(),
});

export const WeekPlanContent = z.strictObject({
  kind: z.literal('pauta'),
  ...Comum,
  /** Um item por dia, do primeiro ao último dia da pauta. */
  days: z.array(z.strictObject({ day: Dia, item: Texto(160) })).min(1).max(7),
});

export const OfferPlanContent = z.strictObject({
  kind: z.literal('oferta'),
  ...Comum,
  offer: Texto(120),
  day: Dia,
  starts_at: Hora,
  ends_at: Hora,
  /** Onde a oferta aparece (no anúncio da campanha, no cardápio, no balcão). */
  where: Texto(200),
  /** O texto do anúncio: passa pelo Compliance e pelo que a marca não diz. */
  ad_text: Texto(220),
  /** O cupom que já existe e entra na oferta; nulo sem cupom (o Estrategista não cria cupom). */
  coupon_code: z.string().regex(/^[A-Z0-9]{4,20}$/).nullable(),
  how_to_measure: Texto(300),
});

/** O conteúdo de uma versão do plano, pelo tipo. */
export const PlanContent = z.discriminatedUnion('kind', [NinetyDaysPlanContent, WeekPlanContent, OfferPlanContent]);
export type PlanContent = z.infer<typeof PlanContent>;

export const PlanListQuery = z.strictObject({
  brand_id: z.uuid(),
  /** Só os de uma situação (`pendente` é a fila de Aprovações). */
  status: z.enum(['pendente', 'aprovado', 'recusado', 'nova_analise', 'expirado']).optional(),
});
export type PlanListQuery = z.infer<typeof PlanListQuery>;

export const PlanSummary = z.strictObject({
  id: z.uuid(),
  brand_id: z.uuid(),
  /** `noventa_dias`, `pauta` ou `oferta`. */
  kind: Slug,
  title: z.string(),
  /** `pendente`, `aprovado`, `recusado`, `nova_analise` (o Estrategista prepara a versão seguinte) ou `expirado`. */
  status: Slug,
  version: z.number().int().min(1),
  /** `baixo`, `medio` ou `alto`. */
  risk: Slug,
  /** Quanto a verba de anúncios muda por mês (proposta − hoje), em micros; nulo quando o plano não mexe em verba. */
  money_micros: z.string().regex(/^-?\d+$/).nullable(),
  /** O hash da versão atual: é o que a aprovação, a recusa e o pedido de nova análise mandam de volta. */
  content_hash: z.string().regex(/^[0-9a-f]{64}$/),
  expires_at: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  /** A demanda que pediu o plano (I10) e quem pediu; nulos no plano que a rotina gerou. */
  demand_id: z.uuid().nullable(),
  requested_by: z.strictObject({ id: z.uuid(), name: z.string() }).nullable(),
});
export type PlanSummary = z.infer<typeof PlanSummary>;

export const PlanListResponse = z.strictObject({ items: z.array(PlanSummary) });
export type PlanListResponse = z.infer<typeof PlanListResponse>;

export const PlanDecision = z.strictObject({
  version: z.number().int().min(1),
  /** `aprovado`, `recusado` ou `nova_analise`. */
  decision: Slug,
  reasons: z.array(Slug),
  comment: z.string().nullable(),
  decided_by: z.strictObject({ id: z.uuid(), name: z.string() }).nullable(),
  created_at: z.string(),
});
export type PlanDecision = z.infer<typeof PlanDecision>;

/**
 * Um texto do plano com número, em trechos: cada número com a posição dele em `numbers`. `path` é o campo do conteúdo
 * ("summary", "reasons.0", "goals.1.how_to_know", "days.2.item") ou a verba de hoje ("budget.today.meta",
 * "budget.today.google"), que o código calculou. O texto sem número não vem aqui: a tela usa o do conteúdo.
 */
export const PlanMarkedText = z.strictObject({
  path: z.string().regex(/^[a-z_]+(\.[a-z0-9_]+)*$/).max(80),
  text: z.array(ExplanationSegment),
});
export type PlanMarkedText = z.infer<typeof PlanMarkedText>;

export const PlanResponse = z.strictObject({
  plan: PlanSummary,
  content: PlanContent,
  /** Cada número citado nos textos e de onde ele veio (quem diz a fonte é o código). */
  numbers: z.array(ExplanationNumber),
  marked: z.array(PlanMarkedText),
  /** `estrategista` (a IA propôs) ou `pessoa` (alguém editou esta versão). */
  author: Slug,
  edited_by: z.strictObject({ id: z.uuid(), name: z.string() }).nullable(),
  /** O pedido de nova análise que gerou esta versão, quando houver. */
  reanalysis: z.string().nullable(),
  decisions: z.array(PlanDecision),
  /** A pessoa da sessão pode decidir (aprovar, editar, recusar, pedir nova análise). */
  can_decide: z.boolean(),
});
export type PlanResponse = z.infer<typeof PlanResponse>;

const PlanHash = z.string().regex(/^[0-9a-f]{64}$/);

/** Editar: o conteúdo inteiro da versão nova, a partir da versão aberta. A verba de hoje continua a calculada pelo código. */
export const EditPlanRequest = z.strictObject({
  base_version: z.int().min(1),
  content: PlanContent,
});
export type EditPlanRequest = z.infer<typeof EditPlanRequest>;

/** Aprovar exige a chave de acesso ou o código do app agora e o hash do plano visto (como as ações, ADR-007). */
export const ApprovePlanRequest = z.strictObject({
  plan_hash: PlanHash,
  code: z.string().regex(/^\d{6}$/, { error: 'Digite os 6 números do app' }).optional(),
  passkey: ChaveNoLugarDoCodigo,
});
export type ApprovePlanRequest = z.infer<typeof ApprovePlanRequest>;

export const PLAN_REJECT_REASONS = ['nao_e_o_momento', 'verba_nao_serve', 'oferta_nao_serve', 'falta_gente', 'nao_concordo'] as const;

export const RejectPlanRequest = z.strictObject({
  plan_hash: PlanHash,
  reasons: z.array(z.enum(PLAN_REJECT_REASONS)).min(1, { error: 'Marque pelo menos um motivo' }).max(5),
  /** Opcional. Dado pessoal reconhecido é removido antes de gravar. */
  comment: z.string().trim().max(500).optional(),
});
export type RejectPlanRequest = z.infer<typeof RejectPlanRequest>;

export const ReanalyzePlanRequest = z.strictObject({
  plan_hash: PlanHash,
  /** O que a pessoa quer diferente, nas palavras dela (sem dado pessoal: é removido antes de gravar). */
  request: z.string().trim().min(3, { error: 'Diga o que mudar em poucas palavras' }).max(1000),
});
export type ReanalyzePlanRequest = z.infer<typeof ReanalyzePlanRequest>;
