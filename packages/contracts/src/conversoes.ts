import { z } from 'zod';

// Conversões para o Google (A5, Y1; `plano-a5.md` D-A5-5 a D-A5-8; protótipo P14, aprovado em 09/10/2026; a tela é o
// cartão "Vendas informadas ao Google" em Contas conectadas).
// A venda confirmada no caixa que veio de um clique num anúncio do Google é informada ao Google, para a ação de
// conversão que uma pessoa da empresa escolhe em cada conta do Google Ads. Sai só o id do clique, o instante, o valor
// e um id interno do pedido. Estas rotas mostram a situação de cada conta, listam as conversões da conta e escolhem ou
// param o destino. Listas que crescem vão como texto na resposta (V23).

const Slug = z.string().regex(/^[a-z0-9_]+$/).max(60);
const Pessoa = z.strictObject({ id: z.uuid(), name: z.string() });
/** O id de uma ação de conversão do Google Ads: só dígitos. */
const IdDaAcao = z.string().regex(/^[0-9]{1,20}$/);

/**
 * A permissão do Google que deixa informar vendas (Data Manager API). Aparece em `scopes` da autorização do Google que
 * a inclui: é por ela que a tela reconhece a autorização nova que pode assumir as contas já ligadas.
 */
export const GOOGLE_SALES_SCOPE = 'https://www.googleapis.com/auth/datamanager';

export const GoogleConversionCounts = z.strictObject({
  /** Vendas que o Google recebeu (aceitas ou ainda esperando o resultado dele). */
  informed: z.int().min(0),
  /** Esperam a vez de sair: os pedidos confirmados que ainda não completaram o prazo e os que já estão na fila. Zero com o destino parado. */
  waiting: z.int().min(0),
  /** Já informadas e com o valor corrigido depois (cancelada: zero; devolução: o que ficou). */
  corrected: z.int().min(0),
  /** Recusadas pelo Google, na validação ou no resultado. */
  refused: z.int().min(0),
});
export type GoogleConversionCounts = z.infer<typeof GoogleConversionCounts>;

export const GoogleConversionDestination = z.strictObject({
  conversion_action_id: IdDaAcao,
  conversion_action_name: z.string(),
  /** Só entram os pedidos confirmados a partir daqui. */
  starts_at: z.iso.datetime(),
  /** Parado por uma pessoa: nada novo sai. */
  stopped_at: z.iso.datetime().nullable(),
  /** Quem parou (nulo sem parada, ou quando a pessoa saiu da empresa). */
  stopped_by: Pessoa.nullable(),
  /** Quem escolheu a conversão (nulo quando a pessoa saiu da empresa). */
  set_by: Pessoa.nullable(),
});
export type GoogleConversionDestination = z.infer<typeof GoogleConversionDestination>;

export const GoogleConversionAccount = z.strictObject({
  connected_account_id: z.uuid(),
  name: z.string(),
  /** O id da conta no Google Ads. */
  external_id: z.string(),
  /** A autorização do Google desta conta inclui a permissão de informar vendas. */
  authorized: z.boolean(),
  destination: GoogleConversionDestination.nullable(),
  /**
   * `informando`; `esperando_a_plataforma` (o Google pediu para esperar, ou a última passagem falhou e a conta volta
   * sozinha em `next_run_at`); `sem_permissao` (falta autorizar o Google de novo: a autorização não inclui o envio, ou
   * o Google a recusou); `sem_destino` (falta escolher a conversão); `parado` (por uma pessoa); `equipe_parada` (a
   * parada da empresa, da marca ou da Liame: nada sai enquanto ela durar).
   */
  status: Slug,
  /** Desde quando a parada que pega esta conta está valendo (só com `equipe_parada`). */
  team_stopped_at: z.iso.datetime().nullable(),
  /** As vendas dos últimos `window_days` dias. */
  counts: GoogleConversionCounts,
  last_run_at: z.iso.datetime().nullable(),
  /** Quando a conta volta para a fila (nulo sem destino ou com ele parado). */
  next_run_at: z.iso.datetime().nullable(),
  /**
   * A última passagem que falhou, se a conta ainda não voltou ao normal: quando, o motivo (sem identificador) e o tipo:
   * `esperar` (o Google pediu para esperar ou estava fora do ar), `permissao` (ele recusou a autorização) ou `outro`.
   */
  last_failure: z.strictObject({ at: z.iso.datetime(), reason: z.string(), kind: Slug }).nullable(),
  /** A recusa mais recente do Google a uma venda, na janela, com o motivo como ele respondeu (sem identificador). */
  last_refusal: z.strictObject({ at: z.iso.datetime(), reason: z.string() }).nullable(),
});
export type GoogleConversionAccount = z.infer<typeof GoogleConversionAccount>;

export const GoogleConversionsResponse = z.strictObject({
  brand_id: z.uuid(),
  /** A função está ligada para a empresa. Desligada, `accounts` vem vazia e a tela é a de sempre. */
  enabled: z.boolean(),
  /** Quem pediu pode escolher, trocar e parar o destino (`contas.conectar`). */
  can_manage: z.boolean(),
  /** Quantos minutos depois de confirmado o pedido sai. */
  wait_minutes: z.int().min(0),
  /** De quantos dias são as contagens. */
  window_days: z.int().min(1),
  accounts: z.array(GoogleConversionAccount),
});
export type GoogleConversionsResponse = z.infer<typeof GoogleConversionsResponse>;

export const GoogleConversionsQuery = z.strictObject({ brand_id: z.uuid() });
export type GoogleConversionsQuery = z.infer<typeof GoogleConversionsQuery>;

export const GoogleConversionAction = z.strictObject({
  id: IdDaAcao,
  name: z.string(),
  /** A categoria como o Google a escreve (`PURCHASE`, `DEFAULT`…), ou nula. */
  category: z.string().nullable(),
  /** O Google usa esta conversão nos lances por padrão. */
  primary: z.boolean(),
});
export type GoogleConversionAction = z.infer<typeof GoogleConversionAction>;

/** As conversões ativas da conta que recebem venda por clique (`UPLOAD_CLICKS`), lidas do Google na hora. */
export const GoogleConversionActionsResponse = z.strictObject({ connected_account_id: z.uuid(), items: z.array(GoogleConversionAction) });
export type GoogleConversionActionsResponse = z.infer<typeof GoogleConversionActionsResponse>;

export const GoogleConversionActionsQuery = z.strictObject({ connected_account_id: z.uuid() });
export type GoogleConversionActionsQuery = z.infer<typeof GoogleConversionActionsQuery>;

export const SetGoogleConversionDestinationRequest = z.strictObject({ connected_account_id: z.uuid(), conversion_action_id: IdDaAcao });
export type SetGoogleConversionDestinationRequest = z.infer<typeof SetGoogleConversionDestinationRequest>;

export const StopGoogleConversionDestinationRequest = z.strictObject({ connected_account_id: z.uuid() });
export type StopGoogleConversionDestinationRequest = z.infer<typeof StopGoogleConversionDestinationRequest>;
