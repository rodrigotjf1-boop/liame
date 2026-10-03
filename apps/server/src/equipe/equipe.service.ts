import type { PauseTeamMemberRequest, ResumeTeamMemberRequest, TeamMember, TeamResponse } from '@liame/contracts';
import { uuidv7 } from '@liame/database';
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { ativoPeloPlano } from '../ai/registro/ativacao.js';
import { motivoSemDadoPessoal } from '../ai/sanitizar.js';
import { situacaoDoTeto } from '../ai/teto.js';
import { ultimaCotacao } from '../cambio/cotacao.js';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { type AuthContext, auditDetail, currentTx } from '../context/request-context.js';
import { AppProblem } from '../errors/problems.js';
import { FlagService } from '../flags/flag.service.js';
import { KillSwitchService } from '../kill-switch/kill-switch.service.js';
import { EQUIPE, ehMembro, type Membro, MEMBROS } from './membros.js';
import { type ContagensDoMes, numerosDoMembro, situacaoDoMembro } from './numeros.js';

// Sua equipe (A3, I13b; protótipo P7, aguardando aprovação; sem tela ainda). Na requisição, sob a RLS da empresa: quem
// trabalha para a marca, a situação de cada um, o custo de IA e o que fez no mês. A empresa desliga e liga um membro
// nesta marca (`agent_pause`); parar a equipe inteira é a parada da empresa (`/v1/kill-switches`).

type Pausa = { agent_key: string; paused_by: string | null; name: string | null; paused_at: Date | string; reason: string | null };

const iso = (v: Date | string) => new Date(v).toISOString();
const quem = (id: string | null, nome: string | null) => (id ? { id, name: nome ?? 'Pessoa removida' } : null);

@Injectable()
export class EquipeService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly flags: FlagService,
    private readonly switches: KillSwitchService,
  ) {}

  async ver(auth: AuthContext, brandId: string, agora = new Date()): Promise<TeamResponse> {
    const tenantId = this.empresa(auth);
    await this.exigirMarca(brandId);
    const tx = currentTx();
    const instante = agora.toISOString();

    // O mês e o teto, no fuso da empresa (os mesmos do AI Gateway).
    const org = (
      await tx.execute<{ fuso: string; de: string; ate: string; inicio: Date | string; inicio_do_dia: Date | string; teto_dia: string; teto_mes: string }>(sql`
        select o.timezone as fuso,
               date_trunc('month', ${instante}::timestamptz at time zone o.timezone)::date::text as de,
               (date_trunc('month', ${instante}::timestamptz at time zone o.timezone) + interval '1 month - 1 day')::date::text as ate,
               (date_trunc('month', ${instante}::timestamptz at time zone o.timezone) at time zone o.timezone) as inicio,
               (date_trunc('day', ${instante}::timestamptz at time zone o.timezone) at time zone o.timezone) as inicio_do_dia,
               coalesce(b.daily_usd_micros, ${this.config.ai.dailyLimitUsdMicros})::text as teto_dia,
               coalesce(b.monthly_usd_micros, ${this.config.ai.monthlyLimitUsdMicros})::text as teto_mes
          from liame.organization o left join liame.ai_budget b on b.tenant_id = o.id
         where o.id = ${tenantId}`)
    ).rows[0];
    if (!org) throw new Error('equipe: empresa não encontrada no contexto');
    const inicio = iso(org.inicio);
    const gasto = (
      await tx.execute<{ dia: string; mes: string }>(sql`
        select coalesce(sum(cost_usd_micros) filter (where occurred_at >= ${iso(org.inicio_do_dia)}::timestamptz), 0)::text as dia,
               coalesce(sum(cost_usd_micros), 0)::text as mes
          from liame.ai_usage where tenant_id = ${tenantId} and occurred_at >= ${inicio}::timestamptz`)
    ).rows[0]!;

    // O uso de IA da marca no mês, por fluxo, e o retorno das pessoas.
    const usos = new Map(
      (
        await tx.execute<{ workflow: string; custo: string; chamadas: number; ok: number }>(sql`
          select workflow, coalesce(sum(cost_usd_micros), 0)::text as custo,
                 (count(*) filter (where model is not null))::int as chamadas, (count(*) filter (where outcome = 'ok'))::int as ok
            from liame.ai_usage
           where tenant_id = ${tenantId} and brand_id = ${brandId} and occurred_at >= ${inicio}::timestamptz
           group by workflow`)
      ).rows.map((u) => [u.workflow, u]),
    );
    const retornos = (
      await tx.execute<{ workflow: string; fez_sentido: number; discordo: number }>(sql`
        select u.workflow, (count(*) filter (where f.verdict = 'fez_sentido'))::int as fez_sentido, (count(*) filter (where f.verdict = 'discordo'))::int as discordo
          from liame.ai_feedback f join liame.ai_usage u on u.id = f.usage_id
         where u.tenant_id = ${tenantId} and u.brand_id = ${brandId} and u.occurred_at >= ${inicio}::timestamptz
         group by u.workflow`)
    ).rows;

    // O que a conferência recusou no mês, por funcionário que escreveu (D-A3-15): sem o texto, só a contagem.
    const recusas = (
      await tx.execute<{ member: string; do_compliance: number; outras: number }>(sql`
        select member,
               coalesce(sum(items) filter (where kind in ('compliance', 'revisor')), 0)::int as do_compliance,
               coalesce(sum(items) filter (where kind not in ('compliance', 'revisor')), 0)::int as outras
          from liame.ai_refusal
         where tenant_id = ${tenantId} and brand_id = ${brandId} and created_at >= ${inicio}::timestamptz
         group by member`)
    ).rows;

    // O que cada um fez no mês (e o que está em andamento agora).
    const n = (
      await tx.execute<Record<string, number | string>>(sql`
        select
          (select count(*) from liame.demand where brand_id = ${brandId} and opened_by_agent = 'lia' and created_at >= ${inicio}::timestamptz)::int as demandas_da_lia,
          (select count(*) from liame.weekly_review where brand_id = ${brandId} and generated_at >= ${inicio}::timestamptz)::int as revisoes,
          (select count(*) from liame.weekly_review where brand_id = ${brandId} and generated_at >= ${inicio}::timestamptz and reading_source = 'lia')::int as revisoes_com_ia,
          (select count(*) from liame.plan where brand_id = ${brandId} and created_at >= ${inicio}::timestamptz and status = 'aprovado')::int as planos_aprovados,
          (select count(*) from liame.plan where brand_id = ${brandId} and created_at >= ${inicio}::timestamptz and status = 'recusado')::int as planos_recusados,
          (select count(*) from liame.plan where brand_id = ${brandId} and status = 'pendente' and expires_at > ${instante}::timestamptz)::int as planos_esperando,
          (select count(*) from liame.demand where brand_id = ${brandId} and assignee_agent = 'estrategista' and status in ('aberta', 'em_andamento'))::int as em_preparo,
          (select count(*) from liame.demand where brand_id = ${brandId} and assignee_agent = 'estrategista' and status = 'em_andamento')::int as preparando_agora,
          (select count(*) from liame.research_request where brand_id = ${brandId} and status = 'concluida' and finished_at >= ${inicio}::timestamptz)::int as paginas_lidas,
          (select count(*) from liame.research_request where brand_id = ${brandId} and status = 'recusada' and finished_at >= ${inicio}::timestamptz)::int as paginas_recusadas,
          (select count(*) from liame.research_request where brand_id = ${brandId} and status = 'lendo')::int as lendo_agora,
          (select count(*) from liame.brand_dossier_suggestion where brand_id = ${brandId} and source = 'pesquisador' and created_at >= ${inicio}::timestamptz)::int as sugestoes,
          (select count(*) from liame.shadow_decision where brand_id = ${brandId} and decided_on >= ${org.de}::date)::int as recomendacoes,
          (select count(*) from liame.shadow_decision where brand_id = ${brandId} and decided_on >= ${org.de}::date and status = 'avaliada' and regret_label <> 'sem_dado')::int as comparaveis,
          (select count(*) from liame.shadow_decision where brand_id = ${brandId} and decided_on >= ${org.de}::date and status = 'avaliada' and regret_label <> 'sem_dado'
              and agreement in ('igual', 'mesma_direcao'))::int as mesma_direcao,
          (select coalesce(sum(action_regret_micros), 0) from liame.shadow_decision
            where brand_id = ${brandId} and decided_on >= ${org.de}::date and status = 'avaliada' and regret_label <> 'sem_dado')::text as arrependimento`)
    ).rows[0]!;
    const contagens: ContagensDoMes = {
      respostasPorFluxo: new Map([...usos.values()].map((u) => [u.workflow, Number(u.ok)])),
      retornoPorFluxo: new Map(retornos.map((r) => [r.workflow, { fezSentido: Number(r.fez_sentido), discordo: Number(r.discordo) }])),
      demandasDaLia: Number(n.demandas_da_lia),
      revisoes: Number(n.revisoes),
      revisoesComLeituraDaIa: Number(n.revisoes_com_ia),
      planosAprovados: Number(n.planos_aprovados),
      planosRecusados: Number(n.planos_recusados),
      planosEsperando: Number(n.planos_esperando),
      emPreparo: Number(n.em_preparo),
      paginasLidas: Number(n.paginas_lidas),
      paginasRecusadas: Number(n.paginas_recusadas),
      sugestoesDoPesquisador: Number(n.sugestoes),
      recomendacoes: Number(n.recomendacoes),
      comparaveis: Number(n.comparaveis),
      mesmaDirecao: Number(n.mesma_direcao),
      arrependimentoMicros: BigInt(n.arrependimento as string),
      recusasPorMembro: new Map(recusas.map((r) => [r.member, { doCompliance: Number(r.do_compliance), outras: Number(r.outras) }])),
    };

    // As chaves: a da empresa (pausas), a da distribuição (plano e flags) e a parada.
    const pausas = new Map(
      (
        await tx.execute<Pausa>(sql`
          select p.agent_key, p.paused_by, u.name, p.paused_at, p.reason
            from liame.agent_pause p left join liame.app_user u on u.id = p.paused_by
           where p.brand_id = ${brandId} and p.resumed_at is null`)
      ).rows.map((p) => [p.agent_key, p]),
    );
    const contexto = this.flags.context({ tenantId, userId: auth.userId, brandId });
    const [ia, sombra] = [await this.flags.isEnabled('ia', contexto), await this.flags.isEnabled('sombra', contexto)];
    const trava = await this.switches.check(tx, { tenantId, provider: 'ai', brandId });
    const parada = trava
      ? (
          await tx.execute<{ id: string; level: string; reason: string; activated_at: Date | string; tenant_id: string | null; activated_by: string | null; name: string | null }>(sql`
            select k.id, k.level, k.reason, k.activated_at, k.tenant_id, k.activated_by, u.name
              from liame.kill_switch k left join liame.app_user u on u.id = k.activated_by
             where k.id = ${trava.id}`)
        ).rows[0]
      : undefined;

    const membros: TeamMember[] = [];
    for (const key of MEMBROS) {
      const def = EQUIPE[key];
      const peloPlano = def.funcionario
        ? await ativoPeloPlano(tx, { tenantId, brandId, agentKey: def.funcionario.key, ativoPorPadrao: def.funcionario.ativoPorPadrao })
        : true;
      const pausa = pausas.get(key);
      const doMembro = def.fluxos.map((f) => usos.get(f)).filter((u) => u !== undefined);
      membros.push({
        key,
        kind: def.kind,
        status: situacaoDoMembro(def, { pausado: pausa !== undefined, peloPlano, ia, sombra, parada: parada !== undefined }),
        working_now: (key === 'estrategista' && Number(n.preparando_agora) > 0) || (key === 'pesquisador' && Number(n.lendo_agora) > 0),
        can_pause: def.desligavel,
        paused: pausa ? { by: quem(pausa.paused_by, pausa.name), at: iso(pausa.paused_at), reason: pausa.reason } : null,
        cost: { usd_micros: doMembro.reduce((s, u) => s + BigInt(u.custo), 0n).toString(), calls: doMembro.reduce((s, u) => s + Number(u.chamadas), 0) },
        stats: numerosDoMembro(def, contagens),
      });
    }

    const teto = { gastoDia: BigInt(gasto.dia), gastoMes: BigInt(gasto.mes), tetoDia: BigInt(org.teto_dia), tetoMes: BigInt(org.teto_mes) };
    return {
      brand_id: brandId,
      month: { from: org.de, to: org.ate, timezone: org.fuso },
      ai: { enabled: ia, spent_usd_micros: gasto.mes, ceiling_usd_micros: org.teto_mes, band: situacaoDoTeto(teto) },
      // O custo e o teto seguem em dólar; a cotação é só para a tela mostrar o valor aproximado em reais (D-A3-14).
      usd_brl: await ultimaCotacao(tx),
      stop: parada
        ? {
            id: parada.id,
            level: parada.level,
            by_company: parada.tenant_id !== null,
            since: iso(parada.activated_at),
            reason: parada.reason,
            // Quem acionou a parada da distribuição não aparece para a empresa.
            by: parada.tenant_id !== null ? quem(parada.activated_by, parada.name) : null,
          }
        : null,
      members: membros,
      can_manage: auth.permissions.has('agentes.gerenciar'),
      can_stop: auth.permissions.has('parada.acionar'),
      generated_at: agora.toISOString(),
    };
  }

  /** A empresa desliga o membro nesta marca: ele para de trabalhar e de custar; o histórico fica. O Compliance não desliga. */
  async desligar(auth: AuthContext, key: string, body: PauseTeamMemberRequest): Promise<TeamResponse> {
    const tenantId = this.empresa(auth);
    const membro = this.membroDesligavel(key);
    await this.exigirMarca(body.brand_id);
    const id = uuidv7();
    const motivo = body.reason ? motivoSemDadoPessoal(body.reason) : null;
    const r = await currentTx().execute(sql`
      insert into liame.agent_pause (id, tenant_id, brand_id, agent_key, paused_by, reason)
      values (${id}, ${tenantId}, ${body.brand_id}, ${membro}, ${auth.userId}, ${motivo})
      on conflict do nothing`);
    if (!r.rowCount) throw new AppProblem(409, 'ja-desligado', 'Já está desligado', 'Este funcionário já está desligado nesta marca.');
    auditDetail({ resourceId: id, after: { agent_key: membro, brand_id: body.brand_id, com_motivo: motivo !== null } });
    return this.ver(auth, body.brand_id);
  }

  /** A empresa liga de novo o membro nesta marca. */
  async ligar(auth: AuthContext, key: string, body: ResumeTeamMemberRequest): Promise<TeamResponse> {
    this.empresa(auth);
    const membro = this.membroDesligavel(key);
    await this.exigirMarca(body.brand_id);
    const r = await currentTx().execute<{ id: string }>(sql`
      update liame.agent_pause set resumed_at = now(), resumed_by = ${auth.userId}
       where brand_id = ${body.brand_id} and agent_key = ${membro} and resumed_at is null
       returning id`);
    const id = r.rows[0]?.id;
    if (!id) throw new AppProblem(409, 'ja-ligado', 'Já está ligado', 'Este funcionário não está desligado nesta marca.');
    auditDetail({ resourceId: id, after: { agent_key: membro, brand_id: body.brand_id } });
    return this.ver(auth, body.brand_id);
  }

  private membroDesligavel(key: string): Membro {
    if (!ehMembro(key)) throw new AppProblem(404, 'nao-encontrado', 'Não encontramos', 'Este funcionário não faz parte da equipe.');
    if (!EQUIPE[key].desligavel) {
      throw new AppProblem(422, 'nao-desliga', 'Este funcionário não desliga', 'Sem o Compliance, nenhum texto de IA aparece. Para parar tudo, use a parada da empresa.');
    }
    return key;
  }

  private async exigirMarca(brandId: string): Promise<void> {
    const b = await currentTx().execute(sql`select 1 from liame.brand where id = ${brandId} and archived_at is null`);
    if (!b.rows[0]) throw new AppProblem(404, 'nao-encontrado', 'Não encontramos', 'Marca não encontrada nesta empresa.');
  }

  private empresa(auth: AuthContext): string {
    if (!auth.tenantId) throw new AppProblem(403, 'sem-empresa-ativa', 'Escolha uma empresa', 'Selecione uma empresa com acesso ativo.');
    return auth.tenantId;
  }
}
