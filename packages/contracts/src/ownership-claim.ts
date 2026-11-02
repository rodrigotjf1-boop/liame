import { z } from 'zod';
import { TermsVersion } from './auth.js';

// A propriedade pedida à DMS quando o Dono não está mais (A7, W8, parte 6a; P34 aprovado; D-A7-63, D-A7-64; D-A7-86): um
// Administrador da empresa pede, com o documento com foto e o documento da empresa que mostra quem a representa. A DMS
// confere; o Dono é avisado no e-mail e há 14 dias de espera; se ele responder, a DMS fala com os dois. Aprovado, quem
// pediu vira a dona, e o acesso do Dono antigo sai.

/** O que aconteceu com o Dono. */
export const OwnershipClaimReason = z.enum(['saiu_da_sociedade', 'faleceu', 'perdeu_acesso']);
export type OwnershipClaimReason = z.infer<typeof OwnershipClaimReason>;

/** Os dois documentos: o de quem pede (com foto) e o da empresa (contrato social, alteração ou certidão da Junta). */
export const OwnershipClaimDocumentKind = z.enum(['documento_com_foto', 'documento_da_empresa']);
export type OwnershipClaimDocumentKind = z.infer<typeof OwnershipClaimDocumentKind>;

/**
 * A situação: `rascunho` (faltam documentos ou o envio), `pedido` (a DMS confere), `conferido` (a espera de 14 dias, até
 * `decide_from`), `contestado` (o Dono respondeu: a DMS fala com os dois), `aprovado`, `recusado` (com o motivo) ou
 * `cancelado` (por quem pediu).
 */
export const OwnershipClaimStatus = z.enum(['rascunho', 'pedido', 'conferido', 'contestado', 'aprovado', 'recusado', 'cancelado']);
export type OwnershipClaimStatus = z.infer<typeof OwnershipClaimStatus>;

export const OwnershipClaim = z.strictObject({
  id: z.uuid(),
  /** O protocolo, como `PROP-2026-0007`. */
  protocol: z.string(),
  status: OwnershipClaimStatus,
  reason: OwnershipClaimReason,
  /** O que quem pediu escreveu para a DMS (só para quem pediu). */
  note: z.string().nullable(),
  requester: z.strictObject({ user_id: z.uuid(), name: z.string() }),
  /** O nome do Dono quando o pedido foi feito. */
  owner_name: z.string().nullable(),
  /** Os documentos já enviados (no rascunho, o que falta é o que não está aqui). */
  documents: z.array(OwnershipClaimDocumentKind),
  created_at: z.string(),
  sent_at: z.string().nullable(),
  checked_at: z.string().nullable(),
  /** A partir de quando a DMS decide (a conferência + 14 dias); nulo antes da conferência. */
  decide_from: z.string().nullable(),
  contested_at: z.string().nullable(),
  refusal_reason: z.string().nullable(),
  closed_at: z.string().nullable(),
});
export type OwnershipClaim = z.infer<typeof OwnershipClaim>;

/** O pedido da propriedade à DMS, como Pessoas e acessos mostra. */
export const OwnershipClaimResponse = z.strictObject({
  /** O pedido de quem lê (em andamento, ou o último que terminou há até 30 dias), ou, para o Dono, o pedido contra ele na espera. */
  claim: OwnershipClaim.nullable(),
  /** O pedido é de quem lê. */
  mine: z.boolean(),
  /** O pedido é sobre quem lê (o Dono): ele pode responder "Ainda cuido da conta". */
  about_me: z.boolean(),
  /**
   * Por que quem lê não pode pedir; nulo = pode. `e-o-dono` (o Dono transfere), `nao-e-administrador`, `vem-de-agencia`
   * (a conta é sempre do dono do negócio), `sem-segundo-fator` (quem vira dono precisa do app), `pedido-em-andamento` ou
   * `indisponivel` (a chave da DMS ainda não está no ar).
   */
  cannot_claim: z
    .enum(['e-o-dono', 'nao-e-administrador', 'vem-de-agencia', 'sem-segundo-fator', 'pedido-em-andamento', 'indisponivel'])
    .nullable(),
});
export type OwnershipClaimResponse = z.infer<typeof OwnershipClaimResponse>;

/** Começar o pedido (o rascunho): o que aconteceu, o que a DMS precisa saber e os Termos aceitos como dona. */
export const CreateOwnershipClaimRequest = z.strictObject({
  reason: OwnershipClaimReason,
  note: z.string().trim().max(600).nullable().optional(),
  terms_version: TermsVersion,
});
export type CreateOwnershipClaimRequest = z.infer<typeof CreateOwnershipClaimRequest>;

/** O documento do rascunho: qual dos dois (o arquivo vai cru no corpo). */
export const OwnershipClaimDocumentParams = z.strictObject({ id: z.uuid(), kind: OwnershipClaimDocumentKind });
export type OwnershipClaimDocumentParams = z.infer<typeof OwnershipClaimDocumentParams>;
