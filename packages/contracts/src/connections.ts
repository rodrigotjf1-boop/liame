import { z } from 'zod';

// Conectar contas (A2, G3): a empresa autoriza a Meta ou o Google por OAuth, o Liame descobre as
// contas que a autorização alcança e a pessoa escolhe quais ligar a cada marca. Token nenhum passa por
// aqui: fica só no cofre. Listas que crescem (plataformas, situações) vão como texto nas respostas (V23).

/**
 * Quem autoriza: `meta` (Meta Ads), `google` (Google Ads e GA4 na mesma autorização), `regem` (lojas do
 * Regem: pedidos, custos e cupons) ou `regemcast` (conversas abertas por anúncio). Os dois últimos são
 * produtos da DMS (A2.5, ADR-019).
 */
export const ConnectionProvider = z.enum(['meta', 'google', 'regem', 'regemcast']);
export type ConnectionProvider = z.infer<typeof ConnectionProvider>;

/**
 * A permissão do Perfil da Empresa no Google (A6, D-A6-17): a autorização do Google que a inclui alcança as lojas do
 * perfil. O Google não oferece uma só de leitura. Pública: a tela de Contas confere se a autorização a tem.
 */
export const GOOGLE_BUSINESS_SCOPE = 'https://www.googleapis.com/auth/business.manage';

/**
 * A permissão do Search Console (A6, Z3), a de só leitura: a autorização do Google que a inclui alcança os sites que a
 * conta do Google pode ler. Pública: a tela de Contas confere se a autorização a tem.
 */
export const SEARCH_CONSOLE_SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';

/**
 * Plataforma da conta ligada. `google_business`: a loja do Perfil da Empresa no Google; `search_console`: um site do
 * Search Console (as duas vêm na autorização do Google, cada uma com a função dela ligada).
 */
export const AccountProvider = z.enum(['meta_ads', 'google_ads', 'ga4', 'regem', 'regemcast', 'google_business', 'search_console']);
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
  /** Quem emitiu a volta (RFC 9207). Na autorização por clique do RegemCast, obrigatório e conferido. */
  iss: z.string().max(500).optional(),
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
  /**
   * Só na loja do Perfil da Empresa no Google (`google_business`): o site que o perfil informa, para distinguir lojas de
   * mesmo nome; nulo quando o perfil não tem site. Opcional: a resposta de antes de 14/10/2026 não traz.
   */
  site: z.string().nullable().optional(),
  /**
   * Só no site do Search Console (`search_console`): o acesso da conta do Google ao site, como o Search Console diz:
   * `dono`, `completo` ou `restrito` (texto, a lista pode crescer); nulo quando não veio. O site sem verificação não chega
   * aqui. Opcional: a resposta de antes de 20/10/2026 não traz.
   */
  site_access: Slug.nullable().optional(),
});
export type DiscoveredAccount = z.infer<typeof DiscoveredAccount>;

/**
 * A última procura das lojas do Perfil da Empresa numa autorização do Google (A6): `ok` (com quantas lojas, que pode ser
 * zero), `limite` (o Google ainda não liberou o acesso do Liame ao perfil, ou pediu para esperar), `sem_permissao` (o
 * Google recusou a leitura) ou `falhou`. Nos casos `limite` e `falhou`, o Liame procura de novo uma vez por dia.
 */
export const ProfileSearch = z.strictObject({
  result: Slug,
  searched_at: z.string(),
  stores: z.int().min(0),
});
export type ProfileSearch = z.infer<typeof ProfileSearch>;

/**
 * A última procura dos sites do Search Console numa autorização do Google (A6, Z3), nas mesmas palavras da procura das
 * lojas: `ok` (com quantos sites, que pode ser zero), `limite`, `sem_permissao` ou `falhou`. A procura que não deu certo
 * não se repete sozinha: a tela oferece procurar de novo.
 */
export const SiteSearch = z.strictObject({
  result: Slug,
  searched_at: z.string(),
  sites: z.int().min(0),
});
export type SiteSearch = z.infer<typeof SiteSearch>;

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
  /** Loja do Liame a que a conta pertence (a loja do Regem, a conta do RegemCast); nulo = a marca toda. */
  unit_id: z.uuid().nullable(),
  /** Nome da loja do Liame (a tela mostra "Loja no Liame: Centro"); nulo sem loja. */
  unit_name: z.string().nullable(),
  /** O que a loja do Regem libera para o Liame (escopos do token dela: `pedidos.ler`, `custos.ler`…); vazio nas outras plataformas. */
  scopes: z.array(z.string()),
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
  /** `oauth` (a pessoa autorizou) ou `distribuicao` (token emitido pela distribuição no produto DMS, no piloto). */
  origin: Slug,
  /** Nome de quem autorizou (quem começou a conexão é quem precisa voltar dela). */
  authorized_by: z.string().nullable(),
  created_at: z.string(),
  completed_at: z.string().nullable(),
  /** Google em modo de teste: a autorização vence (7 dias); nulo = não vence. */
  refresh_expires_at: z.string().nullable(),
  /** O que a autorização libera (Regem: a união dos escopos das lojas; Meta e Google: os escopos do OAuth). */
  scopes: z.array(z.string()),
  /**
   * Só nas autorizações da Meta: por qual configuração do login a pessoa autorizou. `escrita` = a que também pede para
   * gerenciar anúncios (o Liame só muda campanha de conta lida por uma destas); `leitura` = a de leitura. A Meta não
   * devolve os escopos, e é por aqui que a tela sabe que a autorização nova assume a conta lida pela de leitura
   * (ERR-138). Nulo nas outras plataformas e nas autorizações da Meta anteriores a 04/10/2026, que eram de leitura.
   * Opcional: a resposta de antes de 16/10/2026 não traz.
   */
  requested_access: Slug.nullable().optional(),
  /** Contas que a autorização alcança (só depois da descoberta). */
  discovered: z.array(DiscoveredAccount),
  accounts: z.array(ConnectedAccountResponse),
  /**
   * Só nas autorizações do Google: como terminou a última procura das lojas do Perfil da Empresa. Nulo = o Liame não
   * procurou (a função desligada para a empresa, ou a permissão do perfil não veio nesta autorização). Opcional: a
   * resposta de antes de 14/10/2026 não traz.
   */
  profile_search: ProfileSearch.nullable().optional(),
  /**
   * Só nas autorizações do Google: como terminou a última procura dos sites do Search Console. Nulo = o Liame não
   * procurou (a função desligada para a empresa, ou a permissão do Search Console não veio nesta autorização).
   * Opcional: a resposta de antes de 20/10/2026 não traz.
   */
  site_search: SiteSearch.nullable().optional(),
});
export type ConnectionResponse = z.infer<typeof ConnectionResponse>;

export const ConnectionListQuery = z.strictObject({ brand_id: z.uuid().optional() });
export type ConnectionListQuery = z.infer<typeof ConnectionListQuery>;

export const ConnectionListResponse = z.strictObject({
  items: z.array(ConnectionResponse),
  /**
   * Autorizações que dá para começar agora (a do Regem depende de a distribuição ter configurado o cliente; a do
   * RegemCast, a autorização por clique, também da flag `regemcast_por_clique` ligada para a empresa).
   */
  available: z.array(ConnectionProvider),
  /** Criar cupom no Regem pelo Liame (com aprovação) está ligado para a empresa: a permissão que a loja liberou no Regem passa a valer. */
  regem_write: z.boolean(),
  /**
   * As plataformas de anúncio (`meta_ads`, `google_ads`) em que mudar campanhas pelo Liame está ligado para a empresa
   * (ou para a marca do filtro): as mesmas flags que o pedido confere. Na Meta, só quando a autorização nova também pede
   * para gerenciar anúncios. É o que o diálogo de conectar diz que a autorização permite. Opcional: a resposta de
   * antes de 09/10/2026 não traz.
   */
  ads_write: z.array(z.string()).optional(),
  /**
   * O Perfil da Empresa no Google está ligado para a empresa (ou para a marca do filtro): a autorização nova do Google
   * pede também a permissão do perfil, e o Liame procura e lê as lojas dele (A6). A mesma flag que o começo da conexão e
   * a procura conferem. Opcional: a resposta de antes de 14/10/2026 não traz.
   */
  business_profile: z.boolean().optional(),
  /**
   * O Search Console está ligado para a empresa (ou para a marca do filtro): a autorização nova do Google pede também a
   * permissão dele, só de leitura, e o Liame procura e lê os sites (A6, Z3). A mesma flag que o começo da conexão e a
   * procura conferem. Opcional: a resposta de antes de 20/10/2026 não traz.
   */
  search_console: z.boolean().optional(),
});
export type ConnectionListResponse = z.infer<typeof ConnectionListResponse>;

/** Lojas do Liame de uma marca: a escolha de "Loja no Liame" ao ligar as lojas do Regem. */
export const UnitListQuery = z.strictObject({ brand_id: z.uuid() });
export type UnitListQuery = z.infer<typeof UnitListQuery>;

export const UnitSummary = z.strictObject({ id: z.uuid(), brand_id: z.uuid(), name: z.string() });
export type UnitSummary = z.infer<typeof UnitSummary>;

export const UnitListResponse = z.strictObject({ items: z.array(UnitSummary) });
export type UnitListResponse = z.infer<typeof UnitListResponse>;

export const LinkAccountsRequest = z.strictObject({
  accounts: z
    .array(
      z.strictObject({
        provider: AccountProvider,
        external_id: z.string().min(1).max(100),
        /** Loja do Liame (da marca da conexão) para a loja do Regem ou a conta do RegemCast. */
        unit_id: z.uuid().optional(),
      }),
    )
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
