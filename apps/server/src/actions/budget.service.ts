import type { BudgetLimitsRequest, BudgetMonthChange, BudgetMonthResponse, BudgetPolicyRequest, BudgetResponse } from '@liame/contracts';
import { type Tx, uuidv7 } from '@liame/database';
import { Injectable } from '@nestjs/common';
import { type SQL, sql } from 'drizzle-orm';
import { type AuthContext, auditDetail, currentTx } from '../context/request-context.js';
import { AppProblem, ValidationProblem } from '../errors/problems.js';
import { PLATFORM_POLICY } from '../policy/engine.js';
import { PolicyService } from '../policy/policy.service.js';
import { regrasDaVerba, tetoDaVerba } from '../policy/teto-da-verba.js';
import { diaNoFuso, menosDias } from '../results/fora-do-normal.js';
import { DIAS_CONFERINDO, nomeDaPlataforma, textoDoGastoAcima } from './conferencia-do-gasto.js';
import { CONNECTORS } from './connectors.js';
import { cabeNoMes, type ContaDeAnuncio, type ContaDoMes, contaDoMes, fraseDeNaoCaber, mesDe, PLATAFORMAS_DE_ANUNCIO } from './verba-do-mes.js';

const brl = (micros: number | bigint) => (Number(micros) / 1_000_000).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const FUSO_PADRAO = 'America/Sao_Paulo';
/** Até onde a leitura do gasto volta, no máximo (uma conta parada há mais que isto entra sem ritmo). */
const DIAS_DE_GASTO = 62;
/** A plataforma em que o Liame muda verba nesta fase: é para ela que a tela mostra o teto por campanha. */
const PLATAFORMA_DA_ESCRITA = 'meta_ads';

/** O fuso em que o mês da empresa vira. */
async function fusoDaEmpresa(tx: Tx, tenantId: string): Promise<string> {
  const r = await tx.execute<{ timezone: string }>(sql`select timezone from liame.organization where id = ${tenantId}`);
  return r.rows[0]?.timezone ?? FUSO_PADRAO;
}

/** Mês corrente no fuso da empresa (`2026-09`): o envelope vira no fuso dela. */
export async function periodOf(tx: Tx, tenantId: string, at = new Date()): Promise<string> {
  return diaNoFuso(at, await fusoDaEmpresa(tx, tenantId)).slice(0, 7);
}

/** Os provedores que gastam dinheiro de mídia de verdade: é o pedido neles que pesa na verba do mês. */
const PROVEDORES_QUE_GASTAM = Object.values(CONNECTORS)
  .filter((c) => c.requiresSpendLimits)
  .map((c) => c.provider);
/** Quantas mudanças do mês a tela recebe (as mais recentes). */
const MUDANCAS_NA_TELA = 100;
const EH_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Uma mudança executada, com a conferência mais recente dela e o pedido que veio depois no mesmo objeto. */
type LinhaDaMudanca = {
  id: string;
  tool: string;
  action: string;
  provider: string;
  account_id: string;
  resource_id: string;
  before_state: Record<string, unknown> | null;
  desired_state: Record<string, unknown> | null;
  updated_at: Date | string;
  dia: string;
  requested_by: string;
  quem: string | null;
  agent_key: string | null;
  compensates_action_id: string | null;
  checked_on: string | null;
  conferencia: string | null;
  informed_status: string | null;
  informed_daily_micros: string | null;
  window_from: string | null;
  window_to: string | null;
  spend_micros: string | null;
  allowed_micros: string | null;
  days_after: number | null;
  spend_after_micros: string | null;
  desde: string | null;
  depois_id: string | null;
  depois_em: Date | string | null;
};

/** A situação e a verba de um estado guardado no pedido, como a resposta mostra (verba zero ou ausente: não mora no objeto). */
export const estadoNaResposta = (estado: Record<string, unknown> | null): { status: string; daily_micros: number | null } => ({
  status: typeof estado?.status === 'string' ? estado.status : 'desconhecido',
  daily_micros: typeof estado?.daily_budget_micros === 'number' && estado.daily_budget_micros > 0 ? estado.daily_budget_micros : null,
});

/**
 * O dinheiro do mês (ADR-007; A4, X4). Duas contas, conforme o provedor do pedido:
 *
 * - **Plataforma de anúncio** (a Meta): o teto do mês conta tudo o que as contas conectadas gastam (D-A4-19). O pedido
 *   que faz o gasto subir só passa se a previsão de fechamento, com ele, couber no teto (`verba-do-mes.ts`).
 * - **Os outros** (o sandbox): o envelope com reserva, `requested → reserved → executed`, pela soma do que foi reservado.
 *
 * Nos dois casos a linha do envelope é travada na transação do pedido: dois pedidos ao mesmo tempo não passam juntos
 * do teto. O livro (`budget_ledger_entry`) guarda o que cada pedido reservou por dia, liberou e executou.
 */
@Injectable()
export class BudgetService {
  constructor(private readonly policies: PolicyService) {}

  /**
   * Reserva no envelope da empresa e no da marca (quando houver); passou do teto, nega. `sobeOGasto`: o pedido aumenta
   * verba ou volta a gastar numa plataforma de anúncio, e por isso passa pela conta do mês inteiro (com `amountMicros`
   * sendo o que ele acrescenta por dia, que pode ser zero no anúncio sem verba própria).
   */
  async reserve(
    tx: Tx,
    input: { tenantId: string; brandId: string | null; actionId: string; amountMicros: number; sobeOGasto?: boolean; agora?: Date },
  ): Promise<void> {
    if (input.amountMicros <= 0 && !input.sobeOGasto) return;
    const agora = input.agora ?? new Date();
    const fuso = await fusoDaEmpresa(tx, input.tenantId);
    const period = diaNoFuso(agora, fuso).slice(0, 7);
    // Trava na ordem empresa → marca (sempre a mesma: sem impasse entre transações).
    const envelopes = await tx.execute<{ brand_id: string | null; limit_micros: string }>(sql`
      select brand_id, limit_micros from liame.budget_policy
       where tenant_id = ${input.tenantId} and (brand_id is null or brand_id = ${input.brandId})
       order by brand_id nulls first
       for update`);
    for (const env of envelopes.rows) {
      const scope = env.brand_id ? 'da marca' : 'da empresa';
      if (input.sobeOGasto) {
        const conta = await this.contaDoMes(tx, { tenantId: input.tenantId, brandId: env.brand_id, fuso, agora, teto: BigInt(env.limit_micros), exceto: input.actionId });
        const { cabe, acrescenta } = cabeNoMes(conta, BigInt(input.amountMicros));
        if (!cabe) throw new AppProblem(422, 'orcamento-insuficiente', 'Não cabe na verba do mês', fraseDeNaoCaber(conta, acrescenta, brl, scope));
        continue;
      }
      const committed = await this.committed(tx, input.tenantId, period, env.brand_id);
      const limit = Number(env.limit_micros);
      if (committed + input.amountMicros > limit) {
        throw new AppProblem(
          422,
          'orcamento-insuficiente',
          'Orçamento do mês insuficiente',
          `A ação reserva ${brl(input.amountMicros)}, e o envelope ${scope} tem ${brl(Math.max(0, limit - committed))} livres de ${brl(limit)}.`,
        );
      }
    }
    if (input.amountMicros <= 0) return;
    await tx.execute(sql`
      insert into liame.budget_ledger_entry (id, tenant_id, brand_id, period, action_request_id, kind, amount_micros)
      values (${uuidv7()}, ${input.tenantId}, ${input.brandId}, ${period}, ${input.actionId}, 'reserva', ${input.amountMicros})`);
  }

  /** Devolve ao envelope o que a ação reservou e não executou (cancelada, expirada, falhou ou mudou). */
  async release(tx: Tx, tenantId: string, actionId: string): Promise<number> {
    const r = await tx.execute<{ brand_id: string | null; period: string; open: string }>(sql`
      select brand_id, period,
             sum(case kind when 'reserva' then amount_micros when 'liberacao' then -amount_micros else 0 end)::text as open
        from liame.budget_ledger_entry
       where tenant_id = ${tenantId} and action_request_id = ${actionId}
       group by brand_id, period`);
    let released = 0;
    for (const row of r.rows) {
      const open = Number(row.open);
      if (open <= 0) continue;
      await tx.execute(sql`
        insert into liame.budget_ledger_entry (id, tenant_id, brand_id, period, action_request_id, kind, amount_micros)
        values (${uuidv7()}, ${tenantId}, ${row.brand_id}, ${row.period}, ${actionId}, 'liberacao', ${open})`);
      released += open;
    }
    return released;
  }

  /** Registra o executado (a reserva continua comprometida no mês). */
  async executed(tx: Tx, input: { tenantId: string; brandId: string | null; actionId: string; amountMicros: number }): Promise<void> {
    if (input.amountMicros <= 0) return;
    const period = await periodOf(tx, input.tenantId);
    await tx.execute(sql`
      insert into liame.budget_ledger_entry (id, tenant_id, brand_id, period, action_request_id, kind, amount_micros)
      values (${uuidv7()}, ${input.tenantId}, ${input.brandId}, ${period}, ${input.actionId}, 'execucao', ${input.amountMicros})`);
  }

  async summary(auth: AuthContext): Promise<BudgetResponse> {
    const tx = currentTx();
    const tenantId = tenantOf(auth);
    const period = await periodOf(tx, tenantId);
    const envelopes = await tx.execute<{ brand_id: string | null; limit_micros: string }>(sql`
      select brand_id, limit_micros from liame.budget_policy where tenant_id = ${tenantId} order by brand_id nulls first`);
    const out: BudgetResponse['envelopes'] = [];
    for (const env of envelopes.rows) {
      const committed = await this.committed(tx, tenantId, period, env.brand_id);
      const executed = await this.executedSum(tx, tenantId, period, env.brand_id);
      const limit = Number(env.limit_micros);
      out.push({ brand_id: env.brand_id, limit_micros: limit, committed_micros: committed, executed_micros: executed, available_micros: limit - committed });
    }
    return { period, envelopes: out };
  }

  async setPolicy(auth: AuthContext, input: BudgetPolicyRequest): Promise<void> {
    const tx = currentTx();
    const tenantId = tenantOf(auth);
    if (input.brand_id) {
      const b = await tx.execute(sql`select 1 from liame.brand where id = ${input.brand_id} and tenant_id = ${tenantId}`);
      if (!b.rows[0]) throw new AppProblem(404, 'nao-encontrado', 'Não encontramos', 'Marca não encontrada nesta empresa.');
    }
    const before = await this.gravarEnvelope(tx, { tenantId, brandId: input.brand_id, limitMicros: input.limit_micros, userId: auth.userId });
    auditDetail({
      resourceId: input.brand_id ?? tenantId,
      before: before === null ? null : { limit_micros: before },
      after: { brand_id: input.brand_id, limit_micros: input.limit_micros },
    });
  }

  // ------------------------------------------------------------------ a verba do mês (A4, X4)

  /**
   * A verba do mês da empresa, para a tela (D-A4-19): o gasto das contas conectadas, o ritmo, a previsão, o que pesa
   * hoje, os dois limites e o que sobra. Quem acompanha as campanhas vê; quem define os limites é outra rota.
   */
  async month(auth: AuthContext, agora = new Date()): Promise<BudgetMonthResponse> {
    const tx = currentTx();
    const tenantId = tenantOf(auth);
    const fuso = await fusoDaEmpresa(tx, tenantId);
    const env = await tx.execute<{ limit_micros: string; updated_at: Date | string; updated_by: string | null; nome: string | null }>(sql`
      select b.limit_micros::text as limit_micros, b.updated_at, b.updated_by, u.name as nome
        from liame.budget_policy b left join liame.app_user u on u.id = b.updated_by
       where b.tenant_id = ${tenantId} and b.brand_id is null`);
    const envelope = env.rows[0] ?? null;
    const conta = await this.contaDoMes(tx, { tenantId, brandId: null, fuso, agora, teto: envelope ? BigInt(envelope.limit_micros) : null, exceto: null });
    const { policies } = await this.policies.load(tx, tenantId, null);
    const teto = tetoDaVerba(policies, PLATAFORMA_DA_ESCRITA);
    const regras = regrasDaVerba([PLATFORM_POLICY], PLATAFORMA_DA_ESCRITA);
    const { mes } = conta;
    const mudancas = await this.mudancasDoMes(tx, { tenantId, fuso, inicio: mes.inicio, hoje: mes.hoje });
    return {
      period: mes.periodo,
      timezone: fuso,
      today: mes.hoje,
      month_start: mes.inicio,
      month_end: mes.fim,
      through: mes.ontem,
      days_left: mes.diasQueFaltam,
      currency: 'BRL',
      spend_micros: Number(conta.gasto),
      daily_micros: Number(conta.ritmo),
      forecast_micros: Number(conta.previsto),
      forecast_days: conta.diasPrevistos,
      pending_daily_micros: Number(conta.pesamPorDia),
      pending_micros: Number(conta.pesam),
      limits: {
        month_micros: envelope ? Number(envelope.limit_micros) : null,
        campaign_daily_micros: teto,
        set_by: envelope?.updated_by && envelope.nome ? { id: envelope.updated_by, name: envelope.nome } : null,
        set_at: envelope ? new Date(envelope.updated_at).toISOString() : null,
      },
      remaining_micros: conta.sobra === null ? null : Number(conta.sobra),
      platforms: conta.plataformas.map((p) => ({
        provider: p.provider,
        accounts: p.contas,
        spend_micros: Number(p.gasto),
        daily_micros: Number(p.ritmo),
        forecast_micros: Number(p.previsto),
        read_through: p.lidoAte,
        forecast_days: p.diasPrevistos,
        stale: p.atrasada,
        last_success_at: p.lidoEm ? p.lidoEm.toISOString() : null,
      })),
      days: conta.dias.map((d) => ({ day: d.dia, spend_micros: Number(d.gasto), missing: d.faltam })),
      rules: regras,
      changes: mudancas,
      overspend: avisosDeGasto(mudancas, mes.ontem),
      largest_daily_micros: await this.maiorVerbaDiaria(tx, tenantId),
      generated_at: agora.toISOString(),
    };
  }

  /**
   * O que o Liame executou nas plataformas de anúncio desde o começo do mês (D-A4-24), com a conferência mais recente
   * de cada mudança (`action_spend_check`, gravada todo dia pela rotina do worker), desde quando ela dá aquele
   * resultado e o pedido que mudou o mesmo objeto depois, se houve. A ação que achou o objeto já como queria não
   * mudou nada, e fica de fora.
   */
  private async mudancasDoMes(tx: Tx, e: { tenantId: string; fuso: string; inicio: string; hoje: string }): Promise<BudgetMonthChange[]> {
    if (!PROVEDORES_QUE_GASTAM.length) return [];
    const escreveu = (pedido: SQL) => sql`exists (select 1 from liame.action_execution x
      where x.action_request_id = ${pedido} and x.status = 'executada' and coalesce((x.result_state->>'sem_escrita')::boolean, false) = false)`;
    const r = await tx.execute<LinhaDaMudanca>(sql`
      select r.id, r.tool, r.action, r.provider, r.account_id, r.resource_id, r.before_state, r.desired_state, r.updated_at,
             (r.updated_at at time zone ${e.fuso})::date::text as dia, r.requested_by, u.name as quem, r.agent_key, r.compensates_action_id,
             k.checked_on::text as checked_on, k.status as conferencia, k.informed_status, k.informed_daily_micros::text as informed_daily_micros,
             k.window_from::text as window_from, k.window_to::text as window_to, k.spend_micros::text as spend_micros,
             k.allowed_micros::text as allowed_micros, k.days_after, k.spend_after_micros::text as spend_after_micros,
             -- Desde quando a conferência dá o resultado de agora: o primeiro dia sem outro resultado depois dele.
             (select min(k2.checked_on)::text from liame.action_spend_check k2
               where k2.action_request_id = r.id and k2.status = k.status
                 and not exists (select 1 from liame.action_spend_check k3
                                  where k3.action_request_id = r.id and k3.checked_on > k2.checked_on and k3.status <> k.status)) as desde,
             s.id as depois_id, s.updated_at as depois_em
        from liame.action_request r
        left join liame.app_user u on u.id = r.requested_by
        left join lateral (select * from liame.action_spend_check k where k.action_request_id = r.id order by k.checked_on desc limit 1) k on true
        left join lateral (
          select s.id, s.updated_at from liame.action_request s
           where s.tenant_id = r.tenant_id and s.provider = r.provider and s.account_id = r.account_id and s.resource_id = r.resource_id
             and s.status = 'executada' and (s.updated_at, s.id) > (r.updated_at, r.id) and ${escreveu(sql`s.id`)}
           order by s.updated_at, s.id limit 1
        ) s on true
       where r.tenant_id = ${e.tenantId} and r.provider in ${PROVEDORES_QUE_GASTAM} and r.status = 'executada' and ${escreveu(sql`r.id`)}
         -- As do mês e, de antes dele, as que continuam valendo e sendo conferidas (enquanto a rotina as confere).
         and (r.updated_at >= (${e.inicio}::date)::timestamp at time zone ${e.fuso}
              or (s.id is null and (r.updated_at at time zone ${e.fuso})::date >= ${e.hoje}::date - ${DIAS_CONFERINDO}::int))
       order by r.updated_at desc, r.id desc
       limit ${MUDANCAS_NA_TELA}`);
    const campanhaDe = await this.campanhasDosObjetos(tx, r.rows);
    return r.rows.map((l) => {
      const [antes, depois] = [estadoNaResposta(l.before_state), estadoNaResposta(l.desired_state)];
      const tipo = typeof l.before_state?.tipo === 'string' ? l.before_state.tipo : (l.resource_id.split(':')[0] ?? 'objeto');
      return {
        action_id: l.id,
        executed_at: new Date(l.updated_at).toISOString(),
        executed_on: l.dia,
        tool: l.tool,
        action: l.action,
        provider: l.provider,
        account_id: l.account_id,
        target: {
          kind: tipo,
          name: typeof l.before_state?.nome === 'string' && l.before_state.nome ? l.before_state.nome : l.resource_id,
          campaign_name: tipo === 'campanha' ? null : (campanhaDe.get(`${l.account_id}/${l.resource_id}`) ?? null),
        },
        from: antes,
        to: depois,
        requested_by: { id: l.requested_by, name: l.quem ?? 'Pessoa removida' },
        agent_key: l.agent_key,
        undoes: l.compensates_action_id,
        check:
          l.checked_on && l.conferencia && l.window_from && l.window_to
            ? {
                checked_on: l.checked_on,
                status: l.conferencia,
                since: l.desde ?? l.checked_on,
                informed_status: l.informed_status,
                informed_daily_micros: l.informed_daily_micros === null ? null : Number(l.informed_daily_micros),
                window: { from: l.window_from, to: l.window_to },
                window_spend_micros: Number(l.spend_micros ?? 0),
                window_allowed_micros: l.allowed_micros === null ? null : Number(l.allowed_micros),
                days_after: Number(l.days_after ?? 0),
                spend_after_micros: Number(l.spend_after_micros ?? 0),
              }
            : null,
        superseded_by: l.depois_id && l.depois_em ? { action_id: l.depois_id, executed_at: new Date(l.depois_em).toISOString() } : null,
      };
    });
  }

  /** A maior verba diária entre as campanhas e os conjuntos ativos das contas em que o Liame muda verba (a leitura mais recente). */
  private async maiorVerbaDiaria(tx: Tx, tenantId: string): Promise<number | null> {
    if (!PROVEDORES_QUE_GASTAM.length) return null;
    const daConta = (tabela: SQL) => sql`
      select o.daily_budget_micros as verba from ${tabela} o join liame.connected_account a on a.id = o.connected_account_id
       where a.tenant_id = ${tenantId} and a.disconnected_at is null and a.provider in ${PROVEDORES_QUE_GASTAM}
         and o.status = 'ativa' and o.daily_budget_micros > 0`;
    const r = await tx.execute<{ maior: string | null }>(sql`
      select max(x.verba)::text as maior from (${daConta(sql`liame.campaign`)} union all ${daConta(sql`liame.ad_group`)}) x`);
    return r.rows[0]?.maior ? Number(r.rows[0].maior) : null;
  }

  /** A campanha de cada conjunto e de cada anúncio da lista, pelo que o Liame leu da conta (`conta/recurso` → nome). */
  private async campanhasDosObjetos(tx: Tx, linhas: Array<Pick<LinhaDaMudanca, 'account_id' | 'resource_id'>>): Promise<Map<string, string>> {
    const nomes = new Map<string, string>();
    const doTipo = (tipo: 'conjunto' | 'anuncio') => linhas.flatMap((l) => (l.resource_id.startsWith(`${tipo}:`) && EH_UUID.test(l.account_id) ? [{ conta: l.account_id, externo: l.resource_id.slice(tipo.length + 1) }] : []));
    const [conjuntos, anuncios] = [doTipo('conjunto'), doTipo('anuncio')];
    if (conjuntos.length) {
      const g = await tx.execute<{ conta: string; externo: string; nome: string }>(sql`
        select g.connected_account_id::text as conta, g.external_id as externo, c.name as nome
          from liame.ad_group g join liame.campaign c on c.id = g.campaign_id
         where g.connected_account_id in ${[...new Set(conjuntos.map((x) => x.conta))]} and g.external_id in ${[...new Set(conjuntos.map((x) => x.externo))]}`);
      for (const l of g.rows) nomes.set(`${l.conta}/conjunto:${l.externo}`, l.nome);
    }
    if (anuncios.length) {
      const a = await tx.execute<{ conta: string; externo: string; nome: string }>(sql`
        select ad.connected_account_id::text as conta, ad.external_id as externo, c.name as nome
          from liame.ad ad join liame.ad_group g on g.id = ad.ad_group_id join liame.campaign c on c.id = g.campaign_id
         where ad.connected_account_id in ${[...new Set(anuncios.map((x) => x.conta))]} and ad.external_id in ${[...new Set(anuncios.map((x) => x.externo))]}`);
      for (const l of a.rows) nomes.set(`${l.conta}/anuncio:${l.externo}`, l.nome);
    }
    return nomes;
  }

  /**
   * Define os dois limites da empresa (D-A4-22): o teto do mês, no envelope, e o teto por campanha, numa versão nova
   * da política da empresa. Valem na hora, para os pedidos seguintes, e a mudança fica na auditoria.
   */
  async setLimits(auth: AuthContext, input: BudgetLimitsRequest, agora = new Date()): Promise<BudgetMonthResponse> {
    const tx = currentTx();
    const tenantId = tenantOf(auth);
    if (input.campaign_daily_micros > input.month_micros) {
      throw new ValidationProblem([{ path: 'campaign_daily_micros', message: 'O teto por campanha é por dia e não pode passar do teto do mês.' }]);
    }
    const { policies } = await this.policies.load(tx, tenantId, null);
    const tetoAntes = tetoDaVerba(policies, PLATAFORMA_DA_ESCRITA);
    const mesAntes = await this.gravarEnvelope(tx, { tenantId, brandId: null, limitMicros: input.month_micros, userId: auth.userId });
    const politica = await this.policies.publicarTetoDaVerba(tx, { tenantId, userId: auth.userId, maxMicros: input.campaign_daily_micros });
    auditDetail({
      resourceId: tenantId,
      before: { month_micros: mesAntes, campaign_daily_micros: tetoAntes },
      after: { month_micros: input.month_micros, campaign_daily_micros: input.campaign_daily_micros, policy_version: politica.version },
    });
    return this.month(auth, agora);
  }

  /** Grava o envelope (da empresa ou da marca) e devolve o limite de antes, ou nulo se não havia. */
  private async gravarEnvelope(tx: Tx, e: { tenantId: string; brandId: string | null; limitMicros: number; userId: string }): Promise<number | null> {
    const before = await tx.execute<{ limit_micros: string }>(sql`
      select limit_micros from liame.budget_policy where tenant_id = ${e.tenantId} and brand_id is not distinct from ${e.brandId} for update`);
    await tx.execute(sql`
      insert into liame.budget_policy (id, tenant_id, brand_id, limit_micros, created_by, updated_by)
      values (${uuidv7()}, ${e.tenantId}, ${e.brandId}, ${e.limitMicros}, ${e.userId}, ${e.userId})
      on conflict (tenant_id, brand_id) do update set limit_micros = excluded.limit_micros, updated_by = excluded.updated_by, updated_at = now()`);
    return before.rows[0] ? Number(before.rows[0].limit_micros) : null;
  }

  /**
   * A conta do mês no escopo de um envelope: a empresa inteira (`brandId` nulo) ou uma marca. Lê as contas de anúncio
   * conectadas, o gasto de cada dia e os aumentos e retomadas que ainda pesam (`exceto`: o próprio pedido, que entra
   * à parte na conferência).
   */
  private async contaDoMes(tx: Tx, e: { tenantId: string; brandId: string | null; fuso: string; agora: Date; teto: bigint | null; exceto: string | null }): Promise<ContaDoMes> {
    const hoje = diaNoFuso(e.agora, e.fuso);
    const mes = mesDe(hoje);
    const daMarca = e.brandId ? sql`and a.brand_id = ${e.brandId}` : sql``;
    const lidas = await tx.execute<{ id: string; provider: string; timezone: string | null; last_success_at: Date | string | null }>(sql`
      select a.id, a.provider, a.timezone, s.last_success_at
        from liame.connected_account a
        left join liame.sync_state s on s.connected_account_id = a.id and s.dataset = 'metricas'
       where a.tenant_id = ${e.tenantId} and a.disconnected_at is null and a.provider in ${[...PLATAFORMAS_DE_ANUNCIO]} ${daMarca}
       order by a.provider, a.id`);
    const contas = lidas.rows.map((c) => {
      const lidoEm = c.last_success_at ? new Date(c.last_success_at) : null;
      // A leitura feita num dia traz a véspera inteira (no fuso da conta): é até lá que o gasto vale.
      return { id: c.id, provider: c.provider, lidoEm, lidoAte: lidoEm ? menosDias(diaNoFuso(lidoEm, c.timezone ?? e.fuso), 1) : null, gastoPorDia: new Map<string, bigint>() };
    });
    if (contas.length) {
      // Do começo do mês, ou dos 7 dias antes do último dia lido da conta mais atrasada, o que vier primeiro.
      const maisAtrasada = contas.map((c) => c.lidoAte ?? mes.ontem).sort()[0]!;
      const piso = menosDias(hoje, DIAS_DE_GASTO);
      const desde = [mes.inicio, menosDias(maisAtrasada, 6)].sort()[0]!;
      const gastos = await tx.execute<{ conta: string; dia: string; micros: string }>(sql`
        select l.connected_account_id as conta, l.metric_date::text as dia, round(sum(l.metric_value) * 1000000)::bigint::text as micros
          from liame.metric_latest l join liame.connected_account a on a.id = l.connected_account_id
         where l.connected_account_id in ${contas.map((c) => c.id)} and l.metric_name = 'spend' and l.attribution_window = ''
           and l.metric_date >= ${desde < piso ? piso : desde}::date and l.metric_date < ${hoje}::date
           and ((a.provider = 'google_ads' and l.level = 'campaign') or (a.provider = 'meta_ads' and l.level = 'ad'))
         group by 1, 2`);
      const porId = new Map(contas.map((c) => [c.id, c]));
      for (const g of gastos.rows) porId.get(g.conta)?.gastoPorDia.set(g.dia, BigInt(g.micros));
    }
    return contaDoMes({ hoje, contas: contas satisfies ContaDeAnuncio[], pesamPorDia: await this.pesamHoje(tx, { ...e, hoje }), teto: e.teto });
  }

  /**
   * O que os aumentos e as retomadas pedidos ou feitos hoje acrescentam por dia (o ritmo de 7 dias ainda não os
   * mostra): os pedidos vivos (esperando aprovação ou execução) e os executados hoje que não foram desfeitos.
   */
  private async pesamHoje(tx: Tx, e: { tenantId: string; brandId: string | null; fuso: string; hoje: string; exceto: string | null }): Promise<bigint> {
    if (!PROVEDORES_QUE_GASTAM.length) return 0n;
    const r = await tx.execute<{ n: string }>(sql`
      select coalesce(sum(r.reserved_micros), 0)::text as n
        from liame.action_request r
       where r.tenant_id = ${e.tenantId} ${e.brandId ? sql`and r.brand_id = ${e.brandId}` : sql``}
         and r.provider in ${PROVEDORES_QUE_GASTAM} and r.budget_impact in ('increase', 'new_spend')
         ${e.exceto ? sql`and r.id <> ${e.exceto}` : sql``}
         and (r.status in ('aguardando_aprovacao', 'aprovada', 'executando')
              or (r.status = 'executada' and r.updated_at >= (${e.hoje}::date)::timestamp at time zone ${e.fuso}
                  and not exists (select 1 from liame.action_request v where v.compensates_action_id = r.id and v.status = 'executada')))`);
    return BigInt(r.rows[0]?.n ?? '0');
  }

  private async committed(tx: Tx, tenantId: string, period: string, brandId: string | null): Promise<number> {
    const r = await tx.execute<{ n: string }>(sql`
      select coalesce(sum(case kind when 'reserva' then amount_micros when 'liberacao' then -amount_micros else 0 end), 0)::text as n
        from liame.budget_ledger_entry
       where tenant_id = ${tenantId} and period = ${period} ${brandId ? sql`and brand_id = ${brandId}` : sql``}`);
    return Number(r.rows[0]?.n ?? 0);
  }

  private async executedSum(tx: Tx, tenantId: string, period: string, brandId: string | null): Promise<number> {
    const r = await tx.execute<{ n: string }>(sql`
      select coalesce(sum(amount_micros), 0)::text as n from liame.budget_ledger_entry
       where tenant_id = ${tenantId} and period = ${period} and kind = 'execucao' ${brandId ? sql`and brand_id = ${brandId}` : sql``}`);
    return Number(r.rows[0]?.n ?? 0);
  }
}

/**
 * As mudanças que continuam valendo e cuja conferência mais recente (de hoje ou de ontem) deu "acima", em palavras:
 * o mesmo aviso da Atenção. A conferência mais velha que ontem não avisa mais (a de hoje pode não ter rodado ainda).
 */
function avisosDeGasto(mudancas: BudgetMonthChange[], ontem: string): BudgetMonthResponse['overspend'] {
  return mudancas.flatMap((m) => {
    const c = m.check;
    if (!c || c.status !== 'acima' || c.window_allowed_micros === null || m.superseded_by || c.checked_on < ontem) return [];
    const texto = textoDoGastoAcima(
      {
        tipo: m.target.kind,
        nome: m.target.name,
        executadaEm: m.executed_on,
        depois: { status: m.to.status, verbaDiaria: m.to.daily_micros === null ? null : BigInt(m.to.daily_micros) },
        janela: { de: c.window.from, ate: c.window.to },
        gasto: BigInt(c.window_spend_micros),
        permitido: BigInt(c.window_allowed_micros),
      },
      brl,
      nomeDaPlataforma(m.provider),
    );
    return [{ action_id: m.action_id, ...texto }];
  });
}

function tenantOf(auth: AuthContext): string {
  if (!auth.tenantId) throw new AppProblem(403, 'sem-empresa-ativa', 'Escolha uma empresa', 'Selecione uma empresa com acesso ativo.');
  return auth.tenantId;
}
