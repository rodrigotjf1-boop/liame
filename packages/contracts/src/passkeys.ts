import { z } from 'zod';

// As chaves de acesso (passkeys, WebAuthn; A7, W9; ADR-013; P28 aprovado; D-A7-54 a D-A7-58; D-A7-87): cadastrar em
// Segurança da conta e usar no lugar do código do app. As opções e as respostas da cerimônia são o JSON do WebAuthn
// (o navegador as passa ao aparelho e devolve o que ele assinou); o servidor confere tudo.

const CodigoDoApp = z.string().trim().regex(/^\d{6}$/, { error: 'O código tem 6 dígitos' });

/** O JSON que o navegador recebe para a cerimônia, ou devolve depois dela (o servidor confere o formato). */
export const WebAuthnJson = z.record(z.string(), z.unknown());
export type WebAuthnJson = z.infer<typeof WebAuthnJson>;

/** Uma chave, como a lista mostra. */
export const Passkey = z.strictObject({
  id: z.uuid(),
  /** O nome: vem do gerenciador do aparelho ("Senhas do Google", "iCloud", "Windows Hello") e dá para trocar. */
  name: z.string(),
  /** Sincroniza entre os aparelhos da mesma conta (Google, Apple); falso = só naquele aparelho ou chave física. */
  synced: z.boolean(),
  created_at: z.string(),
  last_used_at: z.string().nullable(),
  /** Onde foi o último uso ("Chrome no Windows"). */
  last_used_where: z.string().nullable(),
});
export type Passkey = z.infer<typeof Passkey>;

export const PasskeysResponse = z.strictObject({
  items: z.array(Passkey),
  /** O máximo de chaves por pessoa (D-A7-54). */
  max: z.number().int(),
  /** A pessoa tem o app autenticador ativo (sem ele, a última chave não sai). */
  has_totp: z.boolean(),
  /**
   * Dá para criar chave agora (a flag `chaves_de_acesso`, A7, W9, parte 9d): desligada, a tela não oferece criar, e o
   * servidor recusa com 409 `funcao-desligada`. As chaves que já existem continuam na lista e valendo.
   */
  can_create: z.boolean(),
});
export type PasskeysResponse = z.infer<typeof PasskeysResponse>;

/** Uma cerimônia: o desafio (de uso único, 5 minutos) e as opções para o navegador. */
export const PasskeyCeremony = z.strictObject({ challenge_id: z.uuid(), options: WebAuthnJson });
export type PasskeyCeremony = z.infer<typeof PasskeyCeremony>;

/** O que o aparelho assinou numa cerimônia de confirmar ou entrar. */
export const PasskeyAssertion = z.strictObject({ challenge_id: z.uuid(), response: WebAuthnJson });
export type PasskeyAssertion = z.infer<typeof PasskeyAssertion>;

/**
 * A chave de acesso no lugar do código do app onde ele é pedido (aprovar, mudar o contrato, gerar códigos novos; A7, W9,
 * parte 9b2; D-A7-56): o que o aparelho assinou, com o desafio de `/v1/me/passkeys/confirmation-options`. Com ela, o
 * `code` não precisa vir; sem nenhum dos dois, 400 `confirme-que-e-voce`.
 */
export const ChaveNoLugarDoCodigo = PasskeyAssertion.optional().meta({
  description:
    'A chave de acesso no lugar do código do app: o que o aparelho assinou, com o desafio de `/v1/me/passkeys/confirmation-options`. Com ela, o `code` não precisa vir; sem nenhum dos dois, 400 `confirme-que-e-voce`.',
});

/**
 * Antes de cadastrar, a pessoa confirma que é ela (D-A7-54): com o código do app, ou com uma chave que já tem. Quem ainda
 * não tem segundo fator cadastra a primeira chave sem confirmar (como quem ativa o app).
 */
export const PasskeyRegistrationOptionsRequest = z.strictObject({
  code: CodigoDoApp.optional(),
  passkey: PasskeyAssertion.optional(),
});
export type PasskeyRegistrationOptionsRequest = z.infer<typeof PasskeyRegistrationOptionsRequest>;

/** Cadastrar: o que o aparelho criou, e o nome (opcional: sem ele, vem do gerenciador). */
export const CreatePasskeyRequest = z.strictObject({
  challenge_id: z.uuid(),
  response: WebAuthnJson,
  name: z.string().trim().min(1).max(60).optional(),
});
export type CreatePasskeyRequest = z.infer<typeof CreatePasskeyRequest>;

export const CreatePasskeyResponse = z.strictObject({
  passkey: Passkey,
  /** Os 10 códigos de recuperação, mostrados uma vez, quando a primeira chave chega sem o app (D-A7-57); nulo nos outros casos. */
  recovery_codes: z.array(z.string()).nullable(),
});
export type CreatePasskeyResponse = z.infer<typeof CreatePasskeyResponse>;

export const RenamePasskeyRequest = z.strictObject({ name: z.string().trim().min(1).max(60) });
export type RenamePasskeyRequest = z.infer<typeof RenamePasskeyRequest>;
