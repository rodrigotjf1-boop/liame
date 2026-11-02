import { z } from 'zod';

// Segurança da conta (tela "Segurança da conta", mockups/prototipo-seguranca.html): o que a própria pessoa
// vê sobre o acesso dela. Vale para todas as empresas; nada de outra pessoa aparece aqui.

export const SecuritySummaryResponse = z.strictObject({
  /** App autenticador ativo desde; nulo = não ativado. */
  mfa_enabled_since: z.string().nullable(),
  /**
   * Como esta sessão foi confirmada: `totp` (o app), `recuperacao` (um código de recuperação), `chave` (uma chave de
   * acesso, A7, W9) ou nulo (ainda não). Texto aberto: a lista cresce (base §14, ERR-015).
   */
  session_mfa_method: z.string().regex(/^[a-z_]{2,30}$/).nullable(),
  /** Quantos dos códigos de recuperação ainda valem. */
  recovery_codes_left: z.int().min(0).max(10),
  /** Pedido de troca do app (aparelho perdido): vale a partir de `usable_after`, até `expires_at`. */
  change_request: z.strictObject({ usable_after: z.string(), expires_at: z.string() }).nullable(),
});
export type SecuritySummaryResponse = z.infer<typeof SecuritySummaryResponse>;

export const SessionResponse = z.strictObject({
  id: z.uuid(),
  /** "Chrome no Windows", deduzido do navegador. */
  device: z.string(),
  /** IP com o final escondido ("177.52.18.x"). */
  ip: z.string().nullable(),
  created_at: z.string(),
  last_seen_at: z.string(),
  /** A sessão desta requisição (este aparelho). */
  current: z.boolean(),
});
export type SessionResponse = z.infer<typeof SessionResponse>;

export const SessionListResponse = z.strictObject({ sessions: z.array(SessionResponse) });
export type SessionListResponse = z.infer<typeof SessionListResponse>;

export const RevokedSessionsResponse = z.strictObject({ revoked: z.int().min(0) });
export type RevokedSessionsResponse = z.infer<typeof RevokedSessionsResponse>;

export const SecurityEvent = z.strictObject({
  /** Ação da auditoria (ex.: `sessao.abrir`); a lista cresce, por isso é texto (V23). */
  action: z.string().regex(/^[a-z_]+\.[a-z_]+$/),
  occurred_at: z.string(),
  device: z.string().nullable(),
  ip: z.string().nullable(),
  /** Detalhe curto quando houver (ex.: `recuperacao` quando entrou com código de recuperação). */
  detail: z.string().nullable(),
});
export type SecurityEvent = z.infer<typeof SecurityEvent>;

export const SecurityEventsResponse = z.strictObject({ events: z.array(SecurityEvent) });
export type SecurityEventsResponse = z.infer<typeof SecurityEventsResponse>;
