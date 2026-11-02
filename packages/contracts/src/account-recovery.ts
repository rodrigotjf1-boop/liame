import { z } from 'zod';
import { SupportContact } from './conversa.js';

// A recuperação da conta do Dono (A7, W8, parte 4; ADR-013; P34 aprovado; D-A7-62, D-A7-64; D-A7-85): quem perdeu o
// celular e os códigos de recuperação pede na própria entrada, depois da senha, com o documento com foto. A DMS confere
// quem é (o documento, o nome no quadro de sócios pelo CNPJ e uma videochamada curta); depois, 7 dias de espera, e o
// pedido cai sozinho se o Dono entrar com o app ou com um código. No fim, o app antigo deixa de valer.

/** O documento com foto: JPG, PNG ou PDF, até 10 MB (o tipo é lido do conteúdo, não do nome). */
export const ACCOUNT_RECOVERY_DOCUMENT_LIMITS = {
  maxBytes: 10 * 1024 * 1024,
  types: ['image/jpeg', 'image/png', 'application/pdf'] as const,
} as const;

/** O que aconteceu: perdeu o celular e os códigos, o celular foi roubado ou quebrou, ou outro motivo. */
export const AccountRecoveryReason = z.enum(['perdi_celular_e_codigos', 'celular_roubado_ou_quebrado', 'outro']);
export type AccountRecoveryReason = z.infer<typeof AccountRecoveryReason>;

/**
 * A situação: `pedido` (a DMS ainda confere), `conferido` (a espera de 7 dias, até `applies_at`), `parado` (um
 * Administrador não reconheceu; só a DMS retoma), `aplicado` (o app antigo saiu), `recusado` (com o motivo) ou
 * `cancelado` (pelo Dono, ou sozinho quando ele entrou com o app ou com um código).
 */
export const AccountRecoveryStatus = z.enum(['pedido', 'conferido', 'parado', 'aplicado', 'recusado', 'cancelado']);
export type AccountRecoveryStatus = z.infer<typeof AccountRecoveryStatus>;

/** Uma empresa de que a pessoa é a dona, como o pedido mostra (o CNPJ é o que a DMS confere na Receita). */
export const AccountRecoveryCompany = z.strictObject({ name: z.string(), cnpj: z.string().nullable() });
export type AccountRecoveryCompany = z.infer<typeof AccountRecoveryCompany>;

/** Um pedido de recuperação, como o Dono vê. */
export const AccountRecovery = z.strictObject({
  id: z.uuid(),
  /** O protocolo, como `REC-2026-0042`. */
  protocol: z.string(),
  status: AccountRecoveryStatus,
  reason: AccountRecoveryReason,
  /** As empresas de que a pessoa era a dona quando pediu. */
  companies: z.array(AccountRecoveryCompany),
  created_at: z.string(),
  /** Quando a DMS conferiu (começo da espera); nulo antes. */
  checked_at: z.string().nullable(),
  /** Quando o app antigo deixa de valer, se nada mudar; nulo fora da espera. */
  applies_at: z.string().nullable(),
  /** O motivo da recusa, em palavras da DMS; nulo fora da recusa. */
  refusal_reason: z.string().nullable(),
  /** Quem cancelou: `voce` (pelo pedido) ou `entrou` (o Dono entrou com o app ou com um código); nulo fora do cancelamento. */
  cancelled_by: z.enum(['voce', 'entrou']).nullable(),
  /** Quando o pedido terminou (aplicado, recusado ou cancelado); nulo enquanto anda. */
  closed_at: z.string().nullable(),
});
export type AccountRecovery = z.infer<typeof AccountRecovery>;

/** A recuperação vista por quem está na entrada (depois da senha): o pedido mais recente e se pode pedir. */
export const MyAccountRecoveryResponse = z.strictObject({
  /** O pedido em andamento, ou o último que terminou há até 30 dias; nulo sem pedido. */
  recovery: AccountRecovery.nullable(),
  /** As empresas de que a pessoa é a dona agora (o pedido vale para todas). */
  owner_of: z.array(AccountRecoveryCompany),
  /**
   * Por que não dá para pedir agora; nulo = pode. `nao-e-dono` (só o Dono pede: os outros falam com o Dono),
   * `ja-entrou` (a sessão já passou pelo app: troque o app em Segurança da conta), `sem-segundo-fator` (a conta não tem
   * app para recuperar), `pedido-em-andamento` ou `indisponivel` (a recuperação ainda não está ligada: fale com o suporte).
   */
  cannot_request: z.enum(['nao-e-dono', 'ja-entrou', 'sem-segundo-fator', 'pedido-em-andamento', 'indisponivel']).nullable(),
  /** O atendimento da Liame, para quem não pode pedir pela entrada (A7, W8, parte 5). */
  support: SupportContact,
});
export type MyAccountRecoveryResponse = z.infer<typeof MyAccountRecoveryResponse>;

/**
 * O aviso aos Administradores da empresa (A7, W8, parte 4b; D-A7-62, D-A7-64): na espera, o pedido de recuperação do Dono
 * aparece em Pessoas e acessos, com "Não reconheço este pedido". Só para os Administradores da própria empresa.
 */
export const AccountRecoveryNotice = z.strictObject({
  id: z.uuid(),
  protocol: z.string(),
  /** O nome do Dono que pediu. */
  owner_name: z.string(),
  /** `conferido` (a espera, até `applies_at`) ou `parado` (um Administrador não reconheceu; só a DMS retoma). */
  status: z.enum(['conferido', 'parado']),
  created_at: z.string(),
  checked_at: z.string(),
  /** Quando o app do Dono é trocado, se nada mudar; nulo com o pedido parado. */
  applies_at: z.string().nullable(),
  stopped_at: z.string().nullable(),
  /** Foi quem pede que parou o pedido. */
  stopped_by_me: z.boolean(),
});
export type AccountRecoveryNotice = z.infer<typeof AccountRecoveryNotice>;

export const AccountRecoveryNoticeResponse = z.strictObject({ notice: AccountRecoveryNotice.nullable() });
export type AccountRecoveryNoticeResponse = z.infer<typeof AccountRecoveryNoticeResponse>;

/** O pedido: o que aconteceu vai na consulta; o documento com foto, cru, no corpo. */
export const CreateAccountRecoveryQuery = z.strictObject({ reason: AccountRecoveryReason });
export type CreateAccountRecoveryQuery = z.infer<typeof CreateAccountRecoveryQuery>;
