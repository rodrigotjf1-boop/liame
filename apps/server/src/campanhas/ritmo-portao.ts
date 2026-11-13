import type { Tx } from '@liame/database';
import { sql } from 'drizzle-orm';
import type { FlagService } from '../flags/flag.service.js';
import { FLAG_DA_REGIAO } from '../regiao/regiao.js';
import { EstadoDoRitmo, FLAG_DO_RITMO, type PassoDoRitmo } from './ritmo-plano.js';

// O portão do passo do ritmo da semana (plano da região, R7, parte 1b-2; D-RG-62 e D-RG-63). O passo de um dia sai sem
// outro pedido de aprovação porque uma pessoa aprovou a semana com o código do app; por isso, antes de pedir e de novo
// antes de executar, o Liame confere se essa aprovação ainda vale para ESTE passo:
//   - as funções `regiao` e `ritmo_da_semana` ligadas;
//   - o passo existe (a rotina o guardou) e é deste objeto, desta conta e desta marca;
//   - o dia do passo é hoje, no fuso da loja (o passo que ficou na fila de ontem não sai);
//   - o valor é o do passo guardado;
//   - a verba do dia: o ritmo aprovado e não parado; subindo, nunca acima do que a pessoa aprovou para o dia;
//   - a volta: só com o ritmo parado ou depois do fim da semana, e nunca além da verba de antes.
// "A campanha como o Liame deixou" é conferida pelo plano da ferramenta (a verba lida na Meta tem de ser a esperada) e,
// na execução, pela versão do estado. Devolve nulo quando o passo pode sair; senão, o porquê.

type Linha = {
  dia: string;
  hoje: string;
  kind: 'ritmo' | 'volta';
  target_micros: string;
  expected_micros: string;
  resource_id: string;
  status: string;
  brand_id: string;
  ad_account_id: string;
  week_end: string;
  plan: unknown;
};

export async function oQueSeguraOPassoDoRitmo(
  tx: Tx,
  flags: FlagService,
  alvo: { tenantId: string; brandId: string; accountId: string; resourceId: string; valorMicros: number; passo: PassoDoRitmo | { acao: string } },
  agora: Date,
): Promise<string | null> {
  const contexto = flags.context({ tenantId: alvo.tenantId, brandId: alvo.brandId });
  if (!(await flags.isEnabled(FLAG_DA_REGIAO, contexto)) || !(await flags.isEnabled(FLAG_DO_RITMO, contexto))) return 'funcao_desligada';
  const qual =
    'acao' in alvo.passo
      ? sql`s.action_id = ${alvo.passo.acao}`
      : sql`s.rhythm_id = ${alvo.passo.ritmo} and s.day = ${alvo.passo.dia}::date and s.kind = ${alvo.passo.tipo} and s.resource_id = ${alvo.resourceId}`;
  const linha = (
    await tx.execute<Linha>(sql`
      select s.day::text as dia, s.kind, s.target_micros::text as target_micros, s.expected_micros::text as expected_micros, s.resource_id,
             r.status, r.brand_id, r.ad_account_id, r.week_end::text as week_end, r.plan,
             (${agora.toISOString()}::timestamptz at time zone coalesce(u.timezone, 'America/Sao_Paulo'))::date::text as hoje
        from liame.budget_rhythm_step s
        join liame.budget_rhythm r on r.id = s.rhythm_id and r.tenant_id = s.tenant_id
        join liame.unit u on u.id = r.unit_id and u.tenant_id = r.tenant_id
       where s.tenant_id = ${alvo.tenantId} and ${qual}`)
  ).rows[0];
  if (!linha) return 'passo_desconhecido';
  if (linha.brand_id !== alvo.brandId || linha.ad_account_id !== alvo.accountId || linha.resource_id !== alvo.resourceId) return 'passo_de_outro_objeto';
  if (linha.dia !== linha.hoje) return 'fora_do_dia';
  if (Number(linha.target_micros) !== alvo.valorMicros) return 'valor_diferente_do_passo';
  const plano = EstadoDoRitmo.omit({ situacao: true }).safeParse(linha.plan);
  const campanha = plano.success ? plano.data.campanhas.find((c) => c.recurso === alvo.resourceId) : undefined;
  if (!plano.success || !campanha) return 'campanha_fora_do_plano';
  const sobe = alvo.valorMicros > Number(linha.expected_micros);
  if (linha.kind === 'ritmo') {
    if (linha.status !== 'aprovado') return linha.status === 'parado' ? 'ritmo_parado' : 'ritmo_nao_aprovado';
    const i = plano.data.dias.findIndex((d) => d.dia === linha.dia);
    if (i < 0) return 'dia_fora_da_semana';
    // O aprovado é o teto do dia: subindo, nunca passa dele (descer até ele pode levar mais de um dia).
    if (sobe && alvo.valorMicros > campanha.dias_micros[i]!) return 'acima_do_aprovado';
    return null;
  }
  // A volta à verba de antes: só com o ritmo parado ou depois do fim da semana, e nunca além dela.
  if (linha.status !== 'parado' && !(linha.status === 'aprovado' && linha.hoje > linha.week_end)) return 'volta_fora_de_hora';
  if (sobe ? alvo.valorMicros > campanha.base_micros : alvo.valorMicros < campanha.base_micros) return 'alem_da_verba_de_antes';
  return null;
}
