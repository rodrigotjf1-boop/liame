import { type SQL, sql } from 'drizzle-orm';
import { VIVAS_PAGAS } from './vida.js';

// A franquia de IA dos planos como o teto da empresa (A7, W1, parte 2; D-A7-26; D-A3-3). O teto de IA da empresa é,
// nesta ordem:
//   1. o que a distribuição definiu para ela (`ai_budget`, a linha `b`), como hoje;
//   2. senão, a soma das franquias dos planos das marcas com assinatura paga e viva (`ativa`, `em_atraso`,
//      `acoes_paradas`, `suspensa`); a marca num plano sem franquia não soma nada;
//   3. senão, o padrão do servidor.
// Os dois planos nascem sem franquia (D-A7-5): até o valor ser fixado, o teto é o de sempre. Os quatro leitores do teto
// (o AI Gateway, o uso para quem pergunta antes, e as duas leituras de Sua equipe) usam estes pedaços sobre
// `liame.organization o left join liame.ai_budget b`; a lista fechada de `test/franquia.spec.ts` confere que nenhum
// leitor fica de fora.

const vivas = sql.join(
  VIVAS_PAGAS.map((s) => sql`${s}`),
  sql`, `,
);

/** A soma da franquia (a coluna dada, do plano `p`) das assinaturas pagas e vivas da empresa `o`; nula sem franquia. */
const franquiaDaEmpresa = (coluna: SQL): SQL => sql`(
  select sum(${coluna}) from liame.subscription s join liame.billing_plan p on p.id = s.plan_id
   where s.tenant_id = o.id and s.status in (${vivas}))`;

/** O teto de IA do dia da empresa `o`, em micros de dólar (texto). */
export const tetoDoDia = (padrao: number): SQL =>
  sql`coalesce(b.daily_usd_micros, ${franquiaDaEmpresa(sql`p.ai_daily_usd_micros`)}, ${padrao})::text`;

/** O teto de IA do mês da empresa `o`, em micros de dólar (texto). */
export const tetoDoMes = (padrao: number): SQL =>
  sql`coalesce(b.monthly_usd_micros, ${franquiaDaEmpresa(sql`p.ai_monthly_usd_micros`)}, ${padrao})::text`;
