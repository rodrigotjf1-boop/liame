import { z } from 'zod';

// Conectar contas (A2, G3): a empresa autoriza a Meta ou o Google por OAuth, o Liame descobre as
// contas que a autorização alcança e a pessoa escolhe quais ligar a cada marca. Token nenhum passa por
// aqui: fica só no cofre. Listas que crescem (plataformas, situações) vão como texto nas respostas (V23).

/** Quem autoriza: `meta` (Meta Ads) ou `google` (Google Ads e GA4 na mesma autorização). */
export const ConnectionProvider = z.enum(['meta', 'google']);
export type ConnectionProvider = z.infer<typeof ConnectionProvider>;

/** Plataforma da conta ligada. */
export const AccountProvider = z.enum(['meta_ads', 'google_ads', 'ga4']);
export type AccountProvider = z.infer<typeof AccountProvider>;

const Slug = z.string().regex(/^[a-z0-9_]+$/);

export const StartConnectionRequest = z.strictObject({
  provider: ConnectionProvider,
  brand_id: z.uuid(),
});
export type StartConnectionRequest = z.infer<typeof StartConnectionRequest>;

export const StartConnectionResponse = z.strictObject({
  id: z.uuid(),
  /** Página da plataforma onde a pessoa autoriza; a volta chega em `/v1/oauth/callback`. */
  authorize_url: z.url(),
  /** Até quando a autorização pode voltar (10 minutos). */
  expires_at: z.string(),
});
export type StartConnectionResponse = z.infer<typeof StartConnectionResponse>;

export const OAuthCallbackQuery = z.object({
  state: z.string().min(16).max(200),
  code: z.string().min(1).max(2048).optional(),
  /** A plataforma devolve `error` quando a pessoa recusa ou algo falha lá. */
  error: z.string().max(200).optional(),
  error_reason: z.string().max(200).optional(),
  error_description: z.string().max(1000).optional(),
});
export type OAuthCallbackQuery = z.infer<typeof OAuthCallbackQuery>;

export const DiscoveredAccount = z.strictObject({
  provider: Slug,
  external_id: z.string(),
  name: z.string(),
  currency: z.string().nullable(),
  timezone: z.string().nullable(),
  /** Já ligada a uma marca desta empresa. */
  linked: z.boolean(),
  /** Alcançada por meio de outra conta (a gerente do Google Ads, em geral a da agência): o nome dela. Nulo = acesso direto. */
  via: z.string().nullable(),
});
export type DiscoveredAccount = z.infer<typeof DiscoveredAccount>;

export const ConnectedAccountResponse = z.strictObject({
  id: z.uuid(),
  brand_id: z.uuid(),
  connection_id: z.uuid().nullable(),
  provider: Slug,
  external_id: z.string(),
  name: z.string(),
  currency: z.string().nullable(),
  timezone: z.string().nullable(),
  /** `ativa`, `desconectada`, `sem_permissao` ou `erro`. */
  status: Slug,
  status_reason: z.string().nullable(),
  connected_at: z.string(),
  disconnected_at: z.string().nullable(),
});
export type ConnectedAccountResponse = z.infer<typeof ConnectedAccountResponse>;

export const ConnectionResponse = z.strictObject({
  id: z.uuid(),
  brand_id: z.uuid(),
  provider: Slug,
  /** `aguardando_autorizacao`, `recebida`, `processando`, `aguardando_escolha`, `ativa`, `erro`, `expirada` ou `revogada`. */
  status: Slug,
  error_code: Slug.nullable(),
  /** Nome de quem autorizou (quem começou a conexão é quem precisa voltar dela). */
  authorized_by: z.string().nullable(),
  created_at: z.string(),
  completed_at: z.string().nullable(),
  /** Google em modo de teste: a autorização vence (7 dias); nulo = não vence. */
  refresh_expires_at: z.string().nullable(),
  /** Contas que a autorização alcança (só depois da descoberta). */
  discovered: z.array(DiscoveredAccount),
  accounts: z.array(ConnectedAccountResponse),
});
export type ConnectionResponse = z.infer<typeof ConnectionResponse>;

export const ConnectionListQuery = z.strictObject({ brand_id: z.uuid().optional() });
export type ConnectionListQuery = z.infer<typeof ConnectionListQuery>;

export const ConnectionListResponse = z.strictObject({ items: z.array(ConnectionResponse) });
export type ConnectionListResponse = z.infer<typeof ConnectionListResponse>;

export const LinkAccountsRequest = z.strictObject({
  accounts: z
    .array(z.strictObject({ provider: AccountProvider, external_id: z.string().min(1).max(100) }))
    .min(1)
    .max(200),
});
export type LinkAccountsRequest = z.infer<typeof LinkAccountsRequest>;

export const LinkAccountsResponse = z.strictObject({
  linked: z.array(ConnectedAccountResponse),
  /** Já ligadas a uma marca desta empresa (ficam como estão). */
  already_linked: z.array(z.strictObject({ provider: Slug, external_id: z.string() })),
});
export type LinkAccountsResponse = z.infer<typeof LinkAccountsResponse>;
