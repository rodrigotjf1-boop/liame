import { type Tx, uuidv7 } from '@liame/database';
import { sql } from 'drizzle-orm';
import { type AvaliacaoLida, METRICAS_CANONICAS_DO_PERFIL, type PontoDoPerfil, TAMANHO_DO_TEXTO } from '../connectors/google-business/perfil-google.js';

// O que o Liame guarda do Perfil da Empresa no Google (A6, Z1; migration 0068): as avaliações, o resumo da loja (a nota
// média e o total) e os números do perfil por dia. Poucas instruções por lote, na transação de quem chama, sob a RLS da
// empresa.
//
// **O nome e a foto de quem avaliou não chegam aqui** (critério A6-1): o tipo que o conector entrega não tem campo
// para eles, e a tabela não tem coluna. O texto da avaliação é de terceiro: o que o banco não aceita (o caractere
// nulo, o tamanho) é acertado aqui, linha a linha, antes da instrução de conjunto (V43).

export type ContaDoPerfil = { tenantId: string; brandId: string; connectedAccountId: string };

/** Uma avaliação que entrou agora (não existia): é dela que sai o aviso de nota baixa. */
export type AvaliacaoNova = { externalId: string; estrelas: number };

const LOTE = 500;
/** O Postgres não aceita o caractere nulo num texto. */
const semNulo = (s: string): string => s.split('\u0000').join('');
const textoLimpo = (s: string | null): string | null => {
  if (s === null) return null;
  const limpo = semNulo(s).trim().slice(0, TAMANHO_DO_TEXTO);
  return limpo.length ? limpo : null;
};

type LinhaDeAvaliacao = {
  new_id: string;
  external_id: string;
  stars: number;
  comment: string | null;
  reviewed_at: string;
  changed_at: string;
  reply_text: string | null;
  reply_changed_at: string | null;
  reply_state: string | null;
  reply_violation: string | null;
};

/** O instante como o banco o aceita (ISO); nulo se o texto não é uma data. */
const instante = (s: string | null | undefined): string | null => {
  if (typeof s !== 'string') return null;
  const ms = Date.parse(s);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
};

/** A avaliação lida vira a linha da tabela; nula quando o id não sobra depois da limpeza ou uma das datas dela não é data. */
export function linhaDaAvaliacao(a: AvaliacaoLida): LinhaDeAvaliacao | null {
  const externalId = semNulo(a.id).trim().slice(0, 200);
  const [criada, mudou] = [instante(a.criadaEm), instante(a.atualizadaEm)];
  if (!externalId || !criada || !mudou) return null;
  // A resposta existe inteira ou não existe (a restrição `profile_review_resposta`): sem texto, não há resposta.
  const resposta = a.resposta ? textoLimpo(a.resposta.texto) : null;
  return {
    new_id: uuidv7(),
    external_id: externalId,
    stars: a.estrelas,
    comment: textoLimpo(a.texto),
    reviewed_at: criada,
    changed_at: mudou,
    reply_text: resposta,
    reply_changed_at: resposta ? instante(a.resposta?.atualizadaEm) : null,
    reply_state: resposta ? (a.resposta?.situacao ?? 'desconhecida') : null,
    reply_violation: resposta ? (a.resposta?.violacao ?? null) : null,
  };
}

/**
 * Grava as avaliações lidas de uma loja: a que não existia entra, a que existia fica como o Google a tem agora (a
 * nota, o texto e a resposta mudam lá). Devolve quantas foram gravadas e quais são novas.
 */
export async function gravarAvaliacoes(tx: Tx, conta: ContaDoPerfil, avaliacoes: AvaliacaoLida[], agora: Date): Promise<{ gravadas: number; novas: AvaliacaoNova[] }> {
  // A mesma avaliação duas vezes na leitura (mudou entre uma página e outra): vale a mudança mais recente.
  const porId = new Map<string, LinhaDeAvaliacao>();
  for (const a of avaliacoes) {
    const l = linhaDaAvaliacao(a);
    if (!l) continue;
    const anterior = porId.get(l.external_id);
    if (!anterior || anterior.changed_at <= l.changed_at) porId.set(l.external_id, l);
  }
  const linhas = [...porId.values()];
  const quando = agora.toISOString();
  const novas: AvaliacaoNova[] = [];
  for (let i = 0; i < linhas.length; i += LOTE) {
    const r = await tx.execute<{ external_id: string; stars: number; nova: boolean }>(sql`
      with e as (
        select * from jsonb_to_recordset(${JSON.stringify(linhas.slice(i, i + LOTE))}::jsonb) as e(
          new_id uuid, external_id text, stars smallint, comment text, reviewed_at timestamptz, changed_at timestamptz,
          reply_text text, reply_changed_at timestamptz, reply_state text, reply_violation text)
      )
      insert into liame.profile_review (
        id, tenant_id, brand_id, connected_account_id, external_id, stars, comment, reviewed_at, changed_at,
        reply_text, reply_changed_at, reply_state, reply_violation, first_seen_at, last_seen_at, created_at, updated_at)
      select e.new_id, ${conta.tenantId}, ${conta.brandId}, ${conta.connectedAccountId}, e.external_id, e.stars, e.comment, e.reviewed_at, e.changed_at,
             e.reply_text, e.reply_changed_at, e.reply_state, e.reply_violation,
             ${quando}::timestamptz, ${quando}::timestamptz, ${quando}::timestamptz, ${quando}::timestamptz
        from e
      on conflict (connected_account_id, external_id) do update
         set stars = excluded.stars, comment = excluded.comment, reviewed_at = excluded.reviewed_at, changed_at = excluded.changed_at,
             reply_text = excluded.reply_text, reply_changed_at = excluded.reply_changed_at, reply_state = excluded.reply_state,
             reply_violation = excluded.reply_violation, last_seen_at = excluded.last_seen_at, updated_at = excluded.updated_at
      returning external_id, stars, (xmax = 0) as nova`);
    for (const l of r.rows) if (l.nova) novas.push({ externalId: l.external_id, estrelas: Number(l.stars) });
  }
  return { gravadas: linhas.length, novas };
}

/** A nota média e o total de avaliações da loja, como o Google informou nesta leitura (nulos quando ele não informa). */
export async function gravarResumo(tx: Tx, conta: ContaDoPerfil, resumo: { media: number | null; total: number | null }, agora: Date): Promise<void> {
  const quando = agora.toISOString();
  const media = resumo.media !== null && resumo.media >= 1 && resumo.media <= 5 ? resumo.media : null;
  const total = resumo.total !== null && Number.isInteger(resumo.total) && resumo.total >= 0 && resumo.total <= 2_000_000_000 ? resumo.total : null;
  await tx.execute(sql`
    insert into liame.profile_summary (connected_account_id, tenant_id, brand_id, rating, review_count, read_at, created_at, updated_at)
    values (${conta.connectedAccountId}, ${conta.tenantId}, ${conta.brandId}, ${media}, ${total}, ${quando}::timestamptz, ${quando}::timestamptz, ${quando}::timestamptz)
    on conflict (connected_account_id) do update
       set rating = excluded.rating, review_count = excluded.review_count, read_at = excluded.read_at, updated_at = excluded.updated_at`);
}

/**
 * Grava os números do perfil por dia: o valor do dia fica como o Google o informa agora (ele revê os últimos dias).
 * Fica de fora o que a tabela não aceita: métrica fora da lista, valor que não é um inteiro de zero para cima.
 */
export async function gravarNumeros(tx: Tx, conta: ContaDoPerfil, pontos: PontoDoPerfil[], agora: Date): Promise<{ gravados: number }> {
  const porChave = new Map<string, { day: string; metric: string; value: number }>();
  for (const p of pontos) {
    if (!METRICAS_CANONICAS_DO_PERFIL.includes(p.metrica)) continue;
    if (!Number.isSafeInteger(p.valor) || p.valor < 0) continue;
    porChave.set(`${p.dia}/${p.metrica}`, { day: p.dia, metric: p.metrica, value: p.valor });
  }
  const linhas = [...porChave.values()];
  const quando = agora.toISOString();
  for (let i = 0; i < linhas.length; i += LOTE) {
    await tx.execute(sql`
      insert into liame.profile_metric_daily (connected_account_id, tenant_id, brand_id, day, metric, value, read_at)
      select ${conta.connectedAccountId}, ${conta.tenantId}, ${conta.brandId}, e.day, e.metric, e.value, ${quando}::timestamptz
        from jsonb_to_recordset(${JSON.stringify(linhas.slice(i, i + LOTE))}::jsonb) as e(day date, metric text, value bigint)
      on conflict (connected_account_id, day, metric) do update set value = excluded.value, read_at = excluded.read_at`);
  }
  return { gravados: linhas.length };
}
