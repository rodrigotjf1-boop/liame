import type { BudgetLimitsRequest, BudgetMonthChange, BudgetMonthResponse, BudgetMonthRhythm, BudgetPolicyRequest, BudgetResponse } from '@liame/contracts';
import { type Tx, uuidv7 } from '@liame/database';
import { Injectable } from '@nestjs/common';
import { type SQL, sql } from 'drizzle-orm';
import { type AuthContext, auditDetail, currentTx } from '../context/request-context.js';
import { FERRAMENTA_DA_VERBA_DO_DIA, FERRAMENTA_DO_RITMO } from '../campanhas/ritmo-plano.js';
import { AppProblem, ValidationProblem } from '../errors/problems.js';
import { FlagService } from '../flags/flag.service.js';
import { PLATFORM_POLICY } from '../policy/engine.js';
import { PolicyService } from '../policy/policy.service.js';
import { regrasDaVerba, tetoDaVerba } from '../policy/teto-da-verba.js';
import { diaNoFuso, menosDias } from '../results/fora-do-normal.js';
import type { VerbaDoMesGuardada } from '../results/relatorio-mensal.js';
import { DIAS_CONFERINDO, nomeDaPlataforma, textoDoGastoAcima } from './conferencia-do-gasto.js';
import { CONNECTORS } from './connectors.js';
import {
  cabeNoMes,
  type ContaDeAnuncio,
  type ContaDoMes,
  contaDoMes,
  erroDaDivisao,
  fraseDeNaoCaber,
  fraseDeNaoCaberNaParte,
  mesDe,
  PLATAFORMAS_DE_ANUNCIO,
  type PartesDaVerba,
  partesDaColuna,
  somaDasPartes,
} from './verba-do-mes.js';

const brl = (micros: number | bigint) => (Number(micros) / 1_000_000).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const FUSO_PADRAO = 'America/Sao_Paulo';
/** Até onde a leitura do gasto volta, no máximo (uma conta parada há mais que isto entra sem ritmo). */
const DIAS_DE_GASTO = 62;
/**
 * A plataforma de referência para ler o teto por campanha e as regras da verba que a tela mostra. O teto que a empresa
 * define não tem provedor e as regras da distribuição são as mesmas na Meta e no Google (D-A5-3): tanto faz qual das
 * duas se usa aqui.
 */
const PLATAFORMA_DA_ESCRITA = 'meta_ads';
/** A divisão do teto do mês por plataforma (A4, X9; D-A4-36). Desligada, a divisão gravada não vale e não se muda. */
export const FLAG_DA_DIVISAO = 'verba_por_plataforma';
/** A ordem das plataformas na divisão: a da lista das plataformas de anúncio (a Meta, depois o Google). */
const ordemDaPlataforma = (provider: string): number => {
  const i = PLATAFORMAS_DE_ANUNCIO.indexOf(provider);
  return i < 0 ? PLATAFORMAS_DE_ANUNCIO.length : i;
};

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
  constructor(
    private readonly policies: PolicyService,
    private readonly flags: FlagService,
  ) {}

  /**
   * Reserva no envelope da empresa e no da marca (quando houver); passou do teto, nega. `sobeOGasto`: o pedido aumenta
   * verba ou volta a gastar numa plataforma de anúncio, e por isso passa pela conta do mês inteiro (com `amountMicros`
   * sendo o que ele acrescenta por dia, que pode ser zero no anúncio sem verba própria). Com o teto da empresa dividido
   * por plataforma (D-A4-37, função `verba_por_plataforma`), o pedido também precisa caber na parte da plataforma dele
   * (`provider`): a conta do mês só das contas dela, com a parte no lugar do teto.
   */
  async reserve(
    tx: Tx,
    input: { tenantId: string; brandId: string | null; actionId: string; amountMicros: number; sobeOGasto?: boolean; provider?: string; agora?: Date },
  ): Promise<void> {
    if (input.amountMicros <= 0 && !input.sobeOGasto) return;
    const agora = input.agora ?? new Date();
    const fuso = await fusoDaEmpresa(tx, input.tenantId);
    const period = diaNoFuso(agora, fuso).slice(0, 7);
    // Trava na ordem empresa → marca (sempre a mesma: sem impasse entre transações).
    const envelopes = await tx.execute<{ brand_id: string | null; limit_micros: string; platform_parts: unknown }>(sql`
      select brand_id, limit_micros, platform_parts from liame.budget_policy
       where tenant_id = ${input.tenantId} and (brand_id is null or brand_id = ${input.brandId})
       order by brand_id nulls first
       for update`);
    for (const env of envelopes.rows) {
      const scope = env.brand_id ? 'da marca' : 'da empresa';
      if (input.sobeOGasto) {
        const conta = await this.contaDoMes(tx, { tenantId: input.tenantId, brandId: env.brand_id, fuso, agora, teto: BigInt(env.limit_micros), exceto: input.actionId });
        const { cabe, acrescenta } = cabeNoMes(conta, BigInt(input.amountMicros));
        if (!cabe) throw new AppProblem(422, 'orcamento-insuficiente', 'Não cabe na verba do mês', fraseDeNaoCaber(conta, acrescenta, brl, scope));
        // A parte da plataforma (D-A4-37): só no envelope da empresa, onde a divisão mora.
        const parte = env.brand_id === null && input.provider ? (await this.partesQueValem(input.tenantId, env.platform_parts))?.get(input.provider) : undefined;
        if (parte !== undefined && input.provider) {
          const daPlataforma = await this.contaDoMes(tx, { tenantId: input.tenantId, brandId: null, fuso, agora, teto: parte, exceto: input.actionId, provider: input.provider });
          const naParte = cabeNoMes(daPlataforma, BigInt(input.amountMicros));
          if (!naParte.cabe) {
            throw new AppProblem(422, 'orcamento-insuficiente', 'Não cabe na parte da plataforma', fraseDeNaoCaberNaParte(daPlataforma, naParte.acrescenta, brl, input.provider));
          }
        }
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

  /**
   * A divisão que o plano do trimestre aprovado mais recente da empresa propõe (D-A4-38): a verba da Meta e a do Google
   * por mês (em reais inteiros no plano), em micros. Nula sem plano aprovado ou com a proposta sem valor.
   */
  private async divisaoDoPlano(tx: Tx, tenantId: string): Promise<Array<{ provider: string; micros: number }> | null> {
    const r = await tx.execute<{ meta: unknown; google: unknown }>(sql`
      select v.content->'budget'->'proposal'->'meta' as meta, v.content->'budget'->'proposal'->'google' as google
        from liame.plan p
        join liame.plan_version v on v.plan_id = p.id and v.version = p.version and v.tenant_id = p.tenant_id
       where p.tenant_id = ${tenantId} and p.kind = 'noventa_dias' and p.status = 'aprovado'
       order by p.updated_at desc, p.id desc
       limit 1`);
    const linha = r.rows[0];
    if (!linha) return null;
    const emMicros = (reais: unknown): number | null => (typeof reais === 'number' && Number.isSafeInteger(reais) && reais >= 0 ? reais * 1_000_000 : null);
    const meta = emMicros(linha.meta);
    const google = emMicros(linha.google);
    if (meta === null || google === null) return null;
    const partes = [
      { provider: 'meta_ads', micros: meta },
      { provider: 'google_ads', micros: google },
    ].filter((p) => p.micros > 0);
    return partes.length ? partes : null;
  }

  /** A função da divisão por plataforma está ligada para a empresa (D-A4-36)? */
  private divisaoLigada(tenantId: string): Promise<boolean> {
    return this.flags.isEnabled(FLAG_DA_DIVISAO, this.flags.context({ tenantId }));
  }

  /** A divisão gravada, se a função dela está ligada para a empresa; desligada, a divisão não vale (nem trava). */
  private async partesQueValem(tenantId: string, coluna: unknown): Promise<PartesDaVerba | null> {
    const partes = partesDaColuna(coluna);
    return partes && (await this.divisaoLigada(tenantId)) ? partes : null;
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
    const env = await tx.execute<{ limit_micros: string; updated_at: Date | string; updated_by: string | null; nome: string | null; platform_parts: unknown }>(sql`
      select b.limit_micros::text as limit_micros, b.updated_at, b.updated_by, u.name as nome, b.platform_parts
        from liame.budget_policy b left join liame.app_user u on u.id = b.updated_by
       where b.tenant_id = ${tenantId} and b.brand_id is null`);
    const envelope = env.rows[0] ?? null;
    const conta = await this.contaDoMes(tx, { tenantId, brandId: null, fuso, agora, teto: envelope ? BigInt(envelope.limit_micros) : null, exceto: null });
    const { policies } = await this.policies.load(tx, tenantId, null);
    const teto = tetoDaVerba(policies, PLATAFORMA_DA_ESCRITA);
    const regras = regrasDaVerba([PLATFORM_POLICY], PLATAFORMA_DA_ESCRITA);
    const { mes } = conta;
    const mudancas = await this.mudancasDoMes(tx, { tenantId, fuso, inicio: mes.inicio, hoje: mes.hoje });
    const ritmos = await this.ritmosDoMes(tx, { tenantId, inicio: mes.inicio, ate: mes.hoje });
    const comEscrita = await this.plataformasComEscrita(tx, tenantId, auth.userId);
    // A divisão por plataforma (D-A4-36), com a função ligada: a parte de cada uma e o que pesa hoje nela.
    const divisaoLigada = await this.divisaoLigada(tenantId);
    const partes = divisaoLigada ? partesDaColuna(envelope?.platform_parts) : null;
    const pesamNaPlataforma = new Map<string, bigint>();
    for (const provider of partes?.keys() ?? []) {
      const porDia = await this.pesamHoje(tx, { tenantId, brandId: null, fuso, hoje: mes.hoje, exceto: null, provider });
      pesamNaPlataforma.set(provider, porDia * BigInt(mes.diasQueFaltam));
    }
    const parteDa = (provider: string, previsto: bigint): BudgetMonthResponse['platforms'][number]['part'] => {
      const parte = partes?.get(provider);
      if (parte === undefined) return null;
      const pesam = pesamNaPlataforma.get(provider) ?? 0n;
      return { micros: Number(parte), pending_micros: Number(pesam), remaining_micros: Number(parte - previsto - pesam) };
    };
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
        platform_parts: partes
          ? [...partes]
              .sort(([a], [b]) => ordemDaPlataforma(a) - ordemDaPlataforma(b) || a.localeCompare(b))
              .map(([provider, micros]) => ({ provider, micros: Number(micros) }))
          : null,
        platform_parts_enabled: divisaoLigada,
        // A sugestão do plano do trimestre (D-A4-38): só no formulário de quem muda os limites.
        plan_parts: divisaoLigada && auth.permissions.has('orcamento.gerenciar') ? await this.divisaoDoPlano(tx, tenantId) : null,
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
        writes: comEscrita.has(p.provider),
        part: parteDa(p.provider, p.previsto),
      })),
      days: conta.dias.map((d) => ({ day: d.dia, spend_micros: Number(d.gasto), missing: d.faltam })),
      rules: regras,
      changes: mudancas,
      rhythms: ritmos,
      overspend: avisosDeGasto(mudancas, mes.ontem),
      largest_daily_micros: await this.maiorVerbaDiaria(tx, tenantId),
      generated_at: agora.toISOString(),
    };
  }

  /**
   * As plataformas em que mudar campanhas pelo Liame está ligado nesta empresa: a flag de escrita do conector vale para
   * alguma conta conectada (a mesma conferência do pedido, conta a conta). A tela usa para não dizer "só leitura" de
   * uma plataforma em que o pedido existe, nem prometer pedido onde ele não existe.
   */
  private async plataformasComEscrita(tx: Tx, tenantId: string, userId: string): Promise<Set<string>> {
    const ligadas = new Set<string>();
    if (!PROVEDORES_QUE_GASTAM.length) return ligadas;
    const contas = await tx.execute<{ id: string; provider: string; brand_id: string }>(sql`
      select a.id, a.provider, a.brand_id from liame.connected_account a
       where a.tenant_id = ${tenantId} and a.disconnected_at is null and a.provider in ${PROVEDORES_QUE_GASTAM}
       order by a.provider, a.id`);
    for (const c of contas.rows) {
      if (ligadas.has(c.provider)) continue;
      const flag = CONNECTORS[c.provider]?.writeFlag;
      if (!flag || (await this.flags.isEnabled(flag, this.flags.context({ tenantId, userId, brandId: c.brand_id, accountId: c.id })))) ligadas.add(c.provider);
    }
    return ligadas;
  }

  /**
   * O que o Liame executou nas plataformas de anúncio desde o começo do mês (D-A4-24), com a conferência mais recente
   * de cada mudança (`action_spend_check`, gravada todo dia pela rotina do worker), desde quando ela dá aquele
   * resultado e o pedido que mudou o mesmo objeto depois, se houve. A ação que achou o objeto já como queria não
   * mudou nada, e fica de fora.
   */
  private async mudancasDoMes(tx: Tx, e: { tenantId: string; fuso: string; inicio: string; hoje: string; fim?: string }): Promise<BudgetMonthChange[]> {
    if (!PROVEDORES_QUE_GASTAM.length) return [];
    const escreveu = (pedido: SQL) => sql`exists (select 1 from liame.action_execution x
      where x.action_request_id = ${pedido} and x.status = 'executada' and coalesce((x.result_state->>'sem_escrita')::boolean, false) = false)`;
    // As do mês e, de antes dele, as que continuam valendo e sendo conferidas (enquanto a rotina as confere). No mês
    // fechado do relatório (`fim`, o dia seguinte ao último), só as executadas dentro dele.
    const periodo = e.fim
      ? sql`(r.updated_at >= (${e.inicio}::date)::timestamp at time zone ${e.fuso} and r.updated_at < (${e.fim}::date)::timestamp at time zone ${e.fuso})`
      : sql`(r.updated_at >= (${e.inicio}::date)::timestamp at time zone ${e.fuso}
              or (s.id is null and (r.updated_at at time zone ${e.fuso})::date >= ${e.hoje}::date - ${DIAS_CONFERINDO}::int))`;
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
         and ${periodo}
         -- O ritmo da semana (plano da região, R7): o pedido da semana e os passos diários dele ficam no resumo
         -- (ritmosDoMes), e não nesta lista: dezenas de passos por semana tirariam dela as mudanças que alguém pediu.
         and r.tool not in (${FERRAMENTA_DO_RITMO}, ${FERRAMENTA_DA_VERBA_DO_DIA})
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

  /**
   * O ritmo da semana no período (plano da região, R7; D-RG-73): cada ritmo com passos feitos de `inicio` a `ate`, do
   * mais novo ao mais antigo, com quantas mudanças de verba o Liame fez por ele e em quantos objetos.
   */
  private async ritmosDoMes(tx: Tx, e: { tenantId: string; inicio: string; ate: string }): Promise<BudgetMonthRhythm[]> {
    const r = await tx.execute<{ id: string; status: string; week_start: string; week_end: string; action_id: string | null; passos: string; objetos: string }>(sql`
      select b.id, b.status, b.week_start::text as week_start, b.week_end::text as week_end, b.action_id,
             count(*)::text as passos, count(distinct s.resource_id)::text as objetos
        from liame.budget_rhythm b
        join liame.budget_rhythm_step s on s.rhythm_id = b.id and s.tenant_id = b.tenant_id
       where b.tenant_id = ${e.tenantId} and s.status = 'feito' and s.day >= ${e.inicio}::date and s.day <= ${e.ate}::date
       group by b.id
       order by b.week_start desc, b.id desc
       limit 12`);
    return r.rows.map((l) => ({ id: l.id, status: l.status, week: { from: l.week_start, to: l.week_end }, action_id: l.action_id, steps: Number(l.passos), objects: Number(l.objetos) }));
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
   * da política da empresa. Valem na hora, para os pedidos seguintes, e a mudança fica na auditoria. Com a função
   * `verba_por_plataforma` ligada, também a divisão do teto do mês por plataforma (D-A4-36): uma parte para cada
   * plataforma de anúncio conectada, e o teto do mês é a soma delas. Ausente, a divisão fica como está; nula, sai.
   */
  async setLimits(auth: AuthContext, input: BudgetLimitsRequest, agora = new Date()): Promise<BudgetMonthResponse> {
    const tx = currentTx();
    const tenantId = tenantOf(auth);
    if (input.campaign_daily_micros > input.month_micros) {
      throw new ValidationProblem([{ path: 'campaign_daily_micros', message: 'O teto por campanha é por dia e não pode passar do teto do mês.' }]);
    }
    const pedida = input.platform_parts;
    const ligada = await this.divisaoLigada(tenantId);
    if (pedida && !ligada) {
      throw new AppProblem(409, 'funcao-desligada', 'A divisão por plataforma ainda não está ligada', 'Por enquanto, a verba do mês tem o teto da empresa e o teto por campanha.');
    }
    // A linha do envelope fica travada desde a leitura da divisão de antes (dois pedidos juntos não gravam metade de cada).
    const atual = await tx.execute<{ platform_parts: unknown }>(sql`
      select platform_parts from liame.budget_policy where tenant_id = ${tenantId} and brand_id is null for update`);
    const partesAntes = partesDaColuna(atual.rows[0]?.platform_parts);
    let partesDepois: PartesDaVerba | null | undefined;
    if (pedida) {
      const fuso = await fusoDaEmpresa(tx, tenantId);
      const conectadas = [...new Set((await this.contasDeAnuncio(tx, { tenantId, brandId: null, fuso })).map((c) => c.provider))];
      const erro = erroDaDivisao(pedida, conectadas, input.month_micros);
      if (erro) throw new ValidationProblem([erro]);
      partesDepois = new Map(pedida.map((p) => [p.provider, BigInt(p.micros)]));
    } else if (pedida === null) {
      partesDepois = null;
    } else if (ligada && partesAntes && somaDasPartes(partesAntes) !== BigInt(input.month_micros)) {
      throw new ValidationProblem([{ path: 'month_micros', message: 'Com a divisão por plataforma, o teto do mês é a soma das partes: mude as partes, ou tire a divisão.' }]);
    }
    const { policies } = await this.policies.load(tx, tenantId, null);
    const tetoAntes = tetoDaVerba(policies, PLATAFORMA_DA_ESCRITA);
    const mesAntes = await this.gravarEnvelope(tx, { tenantId, brandId: null, limitMicros: input.month_micros, userId: auth.userId, partes: partesDepois });
    const politica = await this.policies.publicarTetoDaVerba(tx, { tenantId, userId: auth.userId, maxMicros: input.campaign_daily_micros });
    // A divisão entra na auditoria só quando existe ou muda: quem não divide tem o registro de sempre.
    const comoObjeto = (p: PartesDaVerba | null) => (p ? Object.fromEntries([...p].map(([k, v]) => [k, Number(v)])) : null);
    const comDivisao = partesAntes !== null || (partesDepois !== undefined && partesDepois !== null);
    auditDetail({
      resourceId: tenantId,
      before: { month_micros: mesAntes, campaign_daily_micros: tetoAntes, ...(comDivisao ? { platform_parts: comoObjeto(partesAntes) } : {}) },
      after: {
        month_micros: input.month_micros,
        campaign_daily_micros: input.campaign_daily_micros,
        policy_version: politica.version,
        ...(comDivisao ? { platform_parts: comoObjeto(partesDepois === undefined ? partesAntes : partesDepois) } : {}),
      },
    });
    return this.month(auth, agora);
  }

  /**
   * Grava o envelope (da empresa ou da marca) e devolve o limite de antes, ou nulo se não havia. `partes`: a divisão
   * por plataforma do envelope da empresa (D-A4-36); ausente, a coluna fica como está; nula, a divisão sai.
   */
  private async gravarEnvelope(
    tx: Tx,
    e: { tenantId: string; brandId: string | null; limitMicros: number; userId: string; partes?: PartesDaVerba | null },
  ): Promise<number | null> {
    const before = await tx.execute<{ limit_micros: string }>(sql`
      select limit_micros from liame.budget_policy where tenant_id = ${e.tenantId} and brand_id is not distinct from ${e.brandId} for update`);
    if (e.partes === undefined) {
      await tx.execute(sql`
        insert into liame.budget_policy (id, tenant_id, brand_id, limit_micros, created_by, updated_by)
        values (${uuidv7()}, ${e.tenantId}, ${e.brandId}, ${e.limitMicros}, ${e.userId}, ${e.userId})
        on conflict (tenant_id, brand_id) do update set limit_micros = excluded.limit_micros, updated_by = excluded.updated_by, updated_at = now()`);
    } else {
      const partes = e.partes ? JSON.stringify(Object.fromEntries([...e.partes].map(([k, v]) => [k, Number(v)]))) : null;
      await tx.execute(sql`
        insert into liame.budget_policy (id, tenant_id, brand_id, limit_micros, created_by, updated_by, platform_parts)
        values (${uuidv7()}, ${e.tenantId}, ${e.brandId}, ${e.limitMicros}, ${e.userId}, ${e.userId}, ${partes}::jsonb)
        on conflict (tenant_id, brand_id) do update set limit_micros = excluded.limit_micros, updated_by = excluded.updated_by, updated_at = now(),
                                                        platform_parts = excluded.platform_parts`);
    }
    return before.rows[0] ? Number(before.rows[0].limit_micros) : null;
  }

  /**
   * A conta do mês no escopo de um envelope: a empresa inteira (`brandId` nulo) ou uma marca. Lê as contas de anúncio
   * conectadas, o gasto de cada dia e os aumentos e retomadas que ainda pesam (`exceto`: o próprio pedido, que entra
   * à parte na conferência). `provider`: só as contas e os pedidos de uma plataforma (a conta da parte dela, D-A4-37).
   */
  private async contaDoMes(
    tx: Tx,
    e: { tenantId: string; brandId: string | null; fuso: string; agora: Date; teto: bigint | null; exceto: string | null; provider?: string },
  ): Promise<ContaDoMes> {
    const hoje = diaNoFuso(e.agora, e.fuso);
    const mes = mesDe(hoje);
    const contas = await this.contasDeAnuncio(tx, e);
    if (contas.length) {
      // Do começo do mês, ou dos 7 dias antes do último dia lido da conta mais atrasada, o que vier primeiro.
      const maisAtrasada = contas.map((c) => c.lidoAte ?? mes.ontem).sort()[0]!;
      const piso = menosDias(hoje, DIAS_DE_GASTO);
      const desde = [mes.inicio, menosDias(maisAtrasada, 6)].sort()[0]!;
      const porId = new Map(contas.map((c) => [c.id, c]));
      for (const g of await this.gastoDosDias(tx, contas.map((c) => c.id), desde < piso ? piso : desde, hoje)) porId.get(g.conta)?.gastoPorDia.set(g.dia, BigInt(g.micros));
    }
    return contaDoMes({ hoje, contas: contas satisfies ContaDeAnuncio[], pesamPorDia: await this.pesamHoje(tx, { ...e, hoje }), teto: e.teto });
  }

  /**
   * As contas de anúncio conectadas da empresa (ou de uma marca) e até que dia a leitura de cada uma vai. `provider`:
   * só as de uma plataforma.
   */
  private async contasDeAnuncio(
    tx: Tx,
    e: { tenantId: string; brandId: string | null; fuso: string; provider?: string },
  ): Promise<Array<Omit<ContaDeAnuncio, 'gastoPorDia'> & { gastoPorDia: Map<string, bigint> }>> {
    const daMarca = e.brandId ? sql`and a.brand_id = ${e.brandId}` : sql``;
    const daPlataforma = e.provider ? sql`and a.provider = ${e.provider}` : sql``;
    const lidas = await tx.execute<{ id: string; provider: string; timezone: string | null; last_success_at: Date | string | null }>(sql`
      select a.id, a.provider, a.timezone, s.last_success_at
        from liame.connected_account a
        left join liame.sync_state s on s.connected_account_id = a.id and s.dataset = 'metricas'
       where a.tenant_id = ${e.tenantId} and a.disconnected_at is null and a.provider in ${[...PLATAFORMAS_DE_ANUNCIO]} ${daMarca} ${daPlataforma}
       order by a.provider, a.id`);
    return lidas.rows.map((c) => {
      const lidoEm = c.last_success_at ? new Date(c.last_success_at) : null;
      // A leitura feita num dia traz a véspera inteira (no fuso da conta): é até lá que o gasto vale.
      return { id: c.id, provider: c.provider, lidoEm, lidoAte: lidoEm ? menosDias(diaNoFuso(lidoEm, c.timezone ?? e.fuso), 1) : null, gastoPorDia: new Map<string, bigint>() };
    });
  }

  /** O gasto de cada conta em cada dia, de `desde` até antes de `antes`: a campanha no Google e o anúncio na Meta. */
  private async gastoDosDias(tx: Tx, contas: string[], desde: string, antes: string): Promise<Array<{ conta: string; dia: string; micros: string }>> {
    if (!contas.length) return [];
    const gastos = await tx.execute<{ conta: string; dia: string; micros: string }>(sql`
      select l.connected_account_id as conta, l.metric_date::text as dia, round(sum(l.metric_value) * 1000000)::bigint::text as micros
        from liame.metric_latest l join liame.connected_account a on a.id = l.connected_account_id
       where l.connected_account_id in ${contas} and l.metric_name = 'spend' and l.attribution_window = ''
         and l.metric_date >= ${desde}::date and l.metric_date < ${antes}::date
         and ((a.provider = 'google_ads' and l.level = 'campaign') or (a.provider = 'meta_ads' and l.level = 'ad'))
       group by 1, 2`);
    return gastos.rows;
  }

  /**
   * A verba de um mês fechado, para o relatório do mês (D-A3-22): o que a Verba do mês mostrava no fim dele. O gasto
   * das contas de anúncio conectadas da empresa nos dias do mês, o teto do mês (o de quando o relatório sai: a tela não
   * guarda o histórico do teto) e as mudanças executadas no mês, com quem aprovou. Quem pediu e quem aprovou vão pelo id:
   * o nome é lido quando a tela abre. Roda na transação da empresa: a rotina do relatório lê como ela.
   */
  async doMesFechado(tenantId: string, mes: { from: string; to: string }): Promise<VerbaDoMesGuardada> {
    const tx = currentTx();
    const fuso = await fusoDaEmpresa(tx, tenantId);
    const seguinte = menosDias(mes.to, -1);
    const contas = await this.contasDeAnuncio(tx, { tenantId, brandId: null, fuso });
    const gasto = (await this.gastoDosDias(tx, contas.map((c) => c.id), mes.from, seguinte)).reduce((s, g) => s + BigInt(g.micros), 0n);
    // A conta que não foi lida até o último dia do mês deixa o gasto dela incompleto: a tela diz qual plataforma.
    const atrasadas = [...new Set(contas.filter((c) => c.lidoAte === null || c.lidoAte < mes.to).map((c) => c.provider))].sort();
    const env = await tx.execute<{ limit_micros: string }>(sql`
      select limit_micros::text as limit_micros from liame.budget_policy where tenant_id = ${tenantId} and brand_id is null`);
    const mudancas = await this.mudancasDoMes(tx, { tenantId, fuso, inicio: mes.from, hoje: seguinte, fim: seguinte });
    const ritmos = await this.ritmosDoMes(tx, { tenantId, inicio: mes.from, ate: mes.to });
    const aprovou = await this.quemAprovou(tx, mudancas.map((m) => m.action_id));
    const estado = (x: { status: string; daily_micros: number | null }) => ({ status: x.status, daily_micros: x.daily_micros === null ? null : String(x.daily_micros) });
    return {
      currency: 'BRL',
      spend_micros: gasto.toString(),
      limit_micros: env.rows[0]?.limit_micros ?? null,
      missing: atrasadas,
      changes: mudancas.map((m) => ({
        action_id: m.action_id,
        executed_on: m.executed_on,
        action: m.action,
        provider: m.provider,
        target: m.target,
        from: estado(m.from),
        to: estado(m.to),
        requested_by: m.requested_by.id,
        approved_by: aprovou.get(m.action_id) ?? null,
        agent_key: m.agent_key,
        check: m.check?.status ?? null,
      })),
      // O ritmo da semana no mês (R7): quantas semanas e quantas mudanças de verba; os passos não entram em `changes`.
      ...(ritmos.length ? { rhythm: { weeks: ritmos.length, steps: ritmos.reduce((t, x) => t + x.steps, 0) } } : {}),
    };
  }

  /** Quem aprovou cada pedido com o código do app: a aprovação que bastou e, entre elas, a mais recente. */
  private async quemAprovou(tx: Tx, pedidos: string[]): Promise<Map<string, string>> {
    if (!pedidos.length) return new Map();
    const r = await tx.execute<{ pedido: string; quem: string }>(sql`
      select distinct on (a.action_request_id) a.action_request_id as pedido, a.approved_by as quem
        from liame.approval a
       where a.action_request_id in ${pedidos}
       order by a.action_request_id, a.sufficient desc, a.created_at desc`);
    return new Map(r.rows.map((l) => [l.pedido, l.quem]));
  }

  /**
   * O que os aumentos e as retomadas pedidos ou feitos hoje acrescentam por dia (o ritmo de 7 dias ainda não os
   * mostra): os pedidos vivos (esperando aprovação ou execução) e os executados hoje que não foram desfeitos.
   */
  private async pesamHoje(
    tx: Tx,
    e: { tenantId: string; brandId: string | null; fuso: string; hoje: string; exceto: string | null; provider?: string },
  ): Promise<bigint> {
    if (!PROVEDORES_QUE_GASTAM.length) return 0n;
    const r = await tx.execute<{ n: string }>(sql`
      select coalesce(sum(r.reserved_micros), 0)::text as n
        from liame.action_request r
       where r.tenant_id = ${e.tenantId} ${e.brandId ? sql`and r.brand_id = ${e.brandId}` : sql``}
         and r.provider in ${PROVEDORES_QUE_GASTAM} and r.budget_impact in ('increase', 'new_spend')
         ${e.provider ? sql`and r.provider = ${e.provider}` : sql``}
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
