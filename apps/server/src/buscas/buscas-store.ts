import type { Tx } from '@liame/database';
import { sql } from 'drizzle-orm';
import { type BuscaLida, type DiaDaBusca, TAMANHO_DA_BUSCA } from '../connectors/search-console/search-console.js';

// O que o Liame guarda do Search Console (A6, Z3; migration 0072): os números de cada site por dia e as buscas que mais
// trouxeram cliques em cada semana. Poucas instruções por lote, na transação de quem chama, sob a RLS da empresa. O que
// o banco não aceita (a contagem que não confere, a posição fora do que o Google usa, o texto comprido ou com caractere
// nulo, a data que não é data) fica de fora aqui, linha a linha, antes da instrução de conjunto (V43).

export type ContaDoSite = { tenantId: string; brandId: string; connectedAccountId: string };

const LOTE = 500;
/** A maior posição que a coluna guarda (`numeric(8, 2)`). */
const POSICAO_MAXIMA = 999_999.99;

const diaValido = (v: string): boolean => {
  if (v.length !== 10 || v[4] !== '-' || v[7] !== '-') return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
};
const contagemValida = (n: number): boolean => Number.isSafeInteger(n) && n >= 0;

/** Os números de uma linha como a tabela aceita, ou nulo: posição com duas casas, só com vezes, de 1 para cima. */
function numeros(n: { cliques: number; vezes: number; posicao: number | null }): { clicks: number; impressions: number; position: number | null } | null {
  if (!contagemValida(n.cliques) || !contagemValida(n.vezes) || n.cliques > n.vezes) return null;
  const posicao = n.posicao !== null && n.vezes > 0 && Number.isFinite(n.posicao) && n.posicao >= 1 && n.posicao <= POSICAO_MAXIMA ? Math.round(n.posicao * 100) / 100 : null;
  return { clicks: n.cliques, impressions: n.vezes, position: posicao };
}

/**
 * Grava os números do site por dia: o valor do dia fica como o Google o informa agora (ele revê os últimos dias). O dia
 * que não veio na resposta fica como estava.
 */
export async function gravarDias(tx: Tx, conta: ContaDoSite, dias: DiaDaBusca[], agora: Date): Promise<{ gravados: number }> {
  const porDia = new Map<string, { day: string; clicks: number; impressions: number; position: number | null }>();
  for (const d of dias) {
    const n = numeros(d);
    if (n && diaValido(d.dia)) porDia.set(d.dia, { day: d.dia, ...n });
  }
  const linhas = [...porDia.values()];
  const quando = agora.toISOString();
  for (let i = 0; i < linhas.length; i += LOTE) {
    await tx.execute(sql`
      insert into liame.search_console_daily (connected_account_id, tenant_id, brand_id, day, clicks, impressions, position, read_at)
      select ${conta.connectedAccountId}, ${conta.tenantId}, ${conta.brandId}, e.day, e.clicks, e.impressions, e.position, ${quando}::timestamptz
        from jsonb_to_recordset(${JSON.stringify(linhas.slice(i, i + LOTE))}::jsonb) as e(day date, clicks bigint, impressions bigint, position numeric)
      on conflict (connected_account_id, day) do update
         set clicks = excluded.clicks, impressions = excluded.impressions, position = excluded.position, read_at = excluded.read_at`);
  }
  return { gravados: linhas.length };
}

/**
 * Grava as buscas de uma semana (a segunda-feira dela): a lista nova substitui a anterior da mesma semana, porque é a
 * do Google que manda (a busca que saiu das que mais trouxeram cliques sai daqui também). Tudo numa transação.
 */
export async function gravarSemana(tx: Tx, conta: ContaDoSite, semana: string, buscas: BuscaLida[], agora: Date): Promise<{ gravadas: number }> {
  if (!diaValido(semana) || new Date(`${semana}T00:00:00Z`).getUTCDay() !== 1) throw new Error(`semana inválida: ${semana.slice(0, 20)}`);
  const porBusca = new Map<string, { query: string; clicks: number; impressions: number; position: number | null }>();
  for (const b of buscas) {
    const n = numeros(b);
    const texto = b.busca.trim();
    if (!n || !texto || texto.length > TAMANHO_DA_BUSCA || texto.includes('\u0000') || porBusca.has(texto)) continue;
    porBusca.set(texto, { query: texto, ...n });
  }
  const linhas = [...porBusca.values()];
  const textos = linhas.map((l) => l.query);
  await tx.execute(sql`
    delete from liame.search_console_query_week
     where connected_account_id = ${conta.connectedAccountId} and week_start = ${semana}::date
       ${textos.length ? sql`and query not in ${textos}` : sql``}`);
  const quando = agora.toISOString();
  for (let i = 0; i < linhas.length; i += LOTE) {
    await tx.execute(sql`
      insert into liame.search_console_query_week (connected_account_id, tenant_id, brand_id, week_start, query, clicks, impressions, position, read_at)
      select ${conta.connectedAccountId}, ${conta.tenantId}, ${conta.brandId}, ${semana}::date, e.query, e.clicks, e.impressions, e.position, ${quando}::timestamptz
        from jsonb_to_recordset(${JSON.stringify(linhas.slice(i, i + LOTE))}::jsonb) as e(query text, clicks bigint, impressions bigint, position numeric)
      on conflict (connected_account_id, week_start, query) do update
         set clicks = excluded.clicks, impressions = excluded.impressions, position = excluded.position, read_at = excluded.read_at`);
  }
  return { gravadas: linhas.length };
}
