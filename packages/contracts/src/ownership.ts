import { z } from 'zod';
import { ChaveNoLugarDoCodigo } from './passkeys.js';
import { TermsVersion } from './auth.js';

// A propriedade da conta (A7, W8, parte 2; ADR-017; P34 aprovado; D-A7-59 a D-A7-61): só o Dono transfere, para um
// Administrador da empresa que já entra com o app; quem recebe aceita com o código do app dela e os Termos como dona, em
// até 7 dias. Até o aceite nada muda.

const CodigoDoApp = z.string().trim().regex(/^\d{6}$/, { error: 'O código tem 6 dígitos' });

/** Um pedido de transferência: de quem, para quem, se o Dono antigo fica e a situação. */
export const OwnershipTransfer = z.strictObject({
  id: z.uuid(),
  from: z.strictObject({ user_id: z.uuid(), name: z.string() }),
  to: z.strictObject({ user_id: z.uuid(), name: z.string(), email: z.string() }),
  /** O Dono antigo fica como Administrador, sem a cobrança, ou sai quando a dona nova aceitar (D-A7-61). */
  old_owner_stays: z.boolean(),
  /** `pedido` esperando o aceite (vale até `expires_at`), `aceito`, `recusado`, `cancelado` ou `vencido`. */
  status: z.enum(['pedido', 'aceito', 'recusado', 'cancelado', 'vencido']),
  created_at: z.string(),
  expires_at: z.string(),
  decided_at: z.string().nullable(),
});
export type OwnershipTransfer = z.infer<typeof OwnershipTransfer>;

/** A propriedade da conta, como Pessoas e acessos mostra. */
export const OwnershipResponse = z.strictObject({
  owner: z.strictObject({ user_id: z.uuid(), name: z.string(), since: z.string() }),
  /** O pedido em aberto, só para o Dono e para quem recebe; nulo para os outros e sem pedido. */
  pending: OwnershipTransfer.nullable(),
  /** O pedido em aberto é para quem pede (aceitar ou recusar). */
  addressed_to_me: z.boolean(),
  /** Para o Dono: quem pode receber (os Administradores com o app, de fora das agências). Vazio para os outros. */
  candidates: z.array(z.strictObject({ user_id: z.uuid(), name: z.string(), email: z.string() })),
  /** Quando o Dono pode transferir de novo (7 dias depois de receber a propriedade); nulo = já pode (D-A7-59). */
  can_transfer_from: z.string().nullable(),
});
export type OwnershipResponse = z.infer<typeof OwnershipResponse>;

/** Pedir a transferência: para quem, se o Dono fica como Administrador, e a chave de acesso ou o código do app. */
export const CreateOwnershipTransferRequest = z.strictObject({
  to_user_id: z.uuid(),
  old_owner_stays: z.boolean(),
  code: CodigoDoApp.optional(),
  passkey: ChaveNoLugarDoCodigo,
});
export type CreateOwnershipTransferRequest = z.infer<typeof CreateOwnershipTransferRequest>;

/** Aceitar a propriedade: a chave de acesso ou o código do app e a versão dos Termos que a dona nova aceita como dona. */
export const AcceptOwnershipTransferRequest = z.strictObject({
  code: CodigoDoApp.optional(),
  passkey: ChaveNoLugarDoCodigo,
  terms_version: TermsVersion,
});
export type AcceptOwnershipTransferRequest = z.infer<typeof AcceptOwnershipTransferRequest>;
