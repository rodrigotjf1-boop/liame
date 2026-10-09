// A recusa definitiva de uma plataforma de anúncio, na ida e na volta (A5, Y3). Na ida, o conector escreve o motivo que
// fica no pedido (`status_reason`): o que o Liame diz ("A Meta recusou a mudança:") e, em seguida, o que a plataforma
// respondeu, nas palavras dela. Na volta, a resposta do pedido separa as duas coisas (`execution.provider_reply`), para
// a tela pôr entre aspas só o que é da plataforma e mostrar o código dela onde couber (protótipo P13: só no Pro).
//
// As duas funções moram juntas porque uma precisa desfazer exatamente o que a outra faz. Funções puras, sem dependência.

const QUEM_RECUSOU: Record<string, string> = { meta_ads: 'A Meta', google_ads: 'O Google' };
const SEM_PONTO = /[.!?]\s*$/;
/** O código de um erro da Google Ads API, como `falhaDoGoogleAds` o monta: `campaignBudgetError.MONEY_AMOUNT_TOO_LARGE`. */
const CODIGO_DO_GOOGLE = /^[A-Za-z]{1,60}\.[A-Z0-9_]{1,80}$/;

const prefixo = (provider: string): string | null => (QUEM_RECUSOU[provider] ? `${QUEM_RECUSOU[provider]} recusou a mudança: ` : null);

/**
 * O motivo da recusa como ele fica no pedido. A Meta escreve para a pessoa, com a pontuação dela, e não manda código
 * que sirva de leitura; o Google escreve o erro em inglês e manda o código, que vai entre parênteses no fim.
 */
export function motivoDaRecusa(provider: 'meta_ads' | 'google_ads', resposta: string, codigo: string | null = null): string {
  if (provider === 'meta_ads') return `${prefixo(provider)}${resposta}`;
  return `${prefixo(provider)}${resposta.replace(SEM_PONTO, '')}${codigo ? ` (${codigo})` : ''}.`;
}

export type RespostaDaPlataforma = { text: string; code: string | null };

/**
 * O que a plataforma respondeu, tirado do motivo guardado no pedido. Nulo quando o motivo não é uma resposta dela: a
 * autorização venceu, o objeto sumiu, a escrita foi barrada, a plataforma mandou esperar (essas frases são do Liame).
 */
export function respostaDaPlataforma(provider: string, motivo: string | null | undefined): RespostaDaPlataforma | null {
  const comeco = prefixo(provider);
  if (!comeco || !motivo?.startsWith(comeco)) return null;
  const resto = motivo.slice(comeco.length).trim();
  if (!resto) return null;
  if (provider !== 'google_ads') return { text: resto, code: null };
  const comCodigo = /^(.*) \(([^()\s]+)\)\.$/s.exec(resto);
  if (comCodigo && CODIGO_DO_GOOGLE.test(comCodigo[2]!) && comCodigo[1]!.trim()) return { text: `${comCodigo[1]!.trim()}.`, code: comCodigo[2]! };
  return { text: resto, code: null };
}
