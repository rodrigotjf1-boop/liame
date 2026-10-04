import { z } from 'zod';

// IA no produto (A3, I4; protótipo P4 aprovado em 02/10/2026): o "Explicar" dos resultados e de um aviso da
// Atenção, e o retorno da pessoa. Quem calcula é o código; a LIA só escreve. Todo número da explicação vem
// marcado, com a lista de onde cada um saiu (quem diz a fonte é o código, não a IA). Sem IA (desligada,
// fora do ar, no limite, com dado velho ou com a resposta recusada na conferência), a mesma rota devolve a
// explicação montada pelo sistema, no mesmo formato. Listas que crescem vão como texto (V23).

const Slug = z.string().regex(/^[a-z0-9_]+$/);

export const AiStatusQuery = z.strictObject({ brand_id: z.uuid().optional() });
export type AiStatusQuery = z.infer<typeof AiStatusQuery>;

export const AiStatusResponse = z.strictObject({
  /**
   * A LIA responde para esta empresa (e esta marca): a função está ligada e o Analista, ativo. Falso: as
   * explicações são montadas pelo sistema, por regra, com os mesmos números.
   */
  lia: z.boolean(),
});
export type AiStatusResponse = z.infer<typeof AiStatusResponse>;

export const ExplainResultsRequest = z.strictObject({
  brand_id: z.uuid(),
  /** Loja do Liame: sem ela, todas as lojas da marca. */
  unit_id: z.uuid().optional(),
  /** Dias no fuso da loja (AAAA-MM-DD), inclusive: os mesmos da tela Resultados. */
  from: z.iso.date(),
  to: z.iso.date(),
});
export type ExplainResultsRequest = z.infer<typeof ExplainResultsRequest>;

/**
 * Os avisos da Atenção que têm "Explicar": os de campanha, os de medição e os que saíram do normal. Os de
 * conexão, de leitura atrasada e de configuração já dizem o que fazer e não têm número para explicar. A
 * tela usa a lista para mostrar o botão; o servidor, para responder 422 aos outros.
 */
export const EXPLAINABLE_ATTENTION_KINDS = [
  'campanha_parou',
  'gasto_fora_do_normal',
  'campanha_sem_pedido',
  'cupom_sem_uso',
  'anuncio_sem_rastreio',
  'campanha_sem_cupom',
  'margem_desconhecida',
  'plataforma_x_caixa',
  'vendas_fora_do_normal',
  'gasto_da_campanha_fora_do_normal',
  'custo_por_pedido_fora_do_normal',
] as const;

/** O aviso da tela, pelo que o identifica: os avisos são calculados na hora e não têm id. */
export const ExplainAttentionRequest = z.strictObject({
  brand_id: z.uuid(),
  kind: Slug,
  connected_account_id: z.uuid().nullable(),
  campaign_id: z.uuid().nullable(),
  provider: Slug.nullable(),
});
export type ExplainAttentionRequest = z.infer<typeof ExplainAttentionRequest>;

/** Um trecho do texto: comum (`number` nulo) ou um número, com a posição dele em `numbers`. */
export const ExplanationSegment = z.strictObject({
  text: z.string(),
  number: z.number().int().min(0).nullable(),
});
export type ExplanationSegment = z.infer<typeof ExplanationSegment>;

const Texto = z.array(ExplanationSegment);

export const ExplanationNumber = z.strictObject({
  /** Como aparece no texto: "R$ 3.605,00", "17,5%", "22/09/2026". */
  value: z.string(),
  /** De onde veio (plataforma ou caixa, o que é, período e hora da leitura). Mais de uma quando o número está em mais de um lugar. */
  sources: z.array(z.string()),
});
export type ExplanationNumber = z.infer<typeof ExplanationNumber>;

export const ExplanationResponse = z.strictObject({
  /** `lia`: escrita pela IA e conferida pelo código. `sistema`: montada por regra, sem IA. */
  source: Slug,
  /**
   * Por que a explicação é a do sistema; nulo quando é da LIA. `desligada` e `funcionario_desligado` (a LIA
   * não está ligada para a empresa), `travada`, `sem_rota`, `dado_velho`, `conteudo_politico`,
   * `limite_usuario` (ver `retry_at`), `teto` (ver `budget_window`), `indisponivel`, `entrada_grande` e, com a
   * resposta da LIA recusada na conferência: `numero_fora`, `trecho_proibido`, `compliance`, `risco`, `vazia`,
   * `longa` e `revisor` (passou nas regras, e o revisor de IA do Compliance apontou tom, clareza ou alegação). A lista
   * cresce: motivo desconhecido se trata como `indisponivel`.
   */
  reason: Slug.nullable(),
  explanation: z.strictObject({
    what_happened: Texto,
    reasons: z.array(Texto),
    /** `baixo`, `medio` ou `alto`. */
    risk: Slug,
    /** Por que o risco é esse: uma frase que começa em minúscula, para vir depois do selo ("Risco médio"). */
    risk_reason: Texto,
    what_to_do: z.array(Texto),
  }),
  numbers: z.array(ExplanationNumber),
  /** O período explicado, como aparece no texto (DD/MM/AAAA). */
  period: z.strictObject({ from: z.string().nullable(), to: z.string().nullable() }),
  /** O período anterior usado na comparação; nulo sem dado para comparar. */
  compared_to: z.strictObject({ from: z.string().nullable(), to: z.string().nullable() }).nullable(),
  /** Fontes que não estão em dia: com alguma, a LIA não explica (`dado_velho`). `last_read`: DD/MM/AAAA HH:MM no fuso da loja; nulo se nunca leu. */
  stale_sources: z.array(z.strictObject({ platform: z.string().nullable(), name: z.string(), freshness: z.string(), last_read: z.string().nullable() })),
  /** A chamada que gerou a explicação da LIA: é o que o retorno (`POST /v1/ai/feedback`) referencia. Nulo na do sistema. */
  usage_id: z.uuid().nullable(),
  /** Com `limite_usuario`: quando a LIA volta a responder. */
  retry_at: z.string().nullable(),
  /** Com `teto`: `dia` ou `mes`. */
  budget_window: Slug.nullable(),
  generated_at: z.string(),
});
export type ExplanationResponse = z.infer<typeof ExplanationResponse>;

export const AI_FEEDBACK_REASONS = ['numero', 'motivo', 'faltou', 'sugestao'] as const;

export const AiFeedbackRequest = z.strictObject({
  usage_id: z.uuid(),
  verdict: z.enum(['fez_sentido', 'discordo']),
  /** Só no `discordo`: um número está errado, o motivo não é esse, faltou algo importante, a sugestão não serve. */
  reasons: z.array(z.enum(AI_FEEDBACK_REASONS)).max(4).default([]),
  /** Só no `discordo`, opcional. Dado pessoal reconhecido é removido antes de gravar. */
  comment: z.string().trim().max(500).optional(),
});
export type AiFeedbackRequest = z.infer<typeof AiFeedbackRequest>;

export const AiFeedbackResponse = z.strictObject({
  usage_id: z.uuid(),
  /** `fez_sentido` ou `discordo`. */
  verdict: Slug,
  reasons: z.array(Slug),
  comment: z.string().nullable(),
  updated_at: z.string(),
});
export type AiFeedbackResponse = z.infer<typeof AiFeedbackResponse>;
