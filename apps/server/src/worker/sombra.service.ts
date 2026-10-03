import type { CampaignResult, ClosedLoopResponse } from '@liame/contracts';
import { type Database, type Tx, uuidv7, withSystem } from '@liame/database';
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { naTransacaoDaEmpresa } from '../ai/na-empresa.js';
import { currentTx } from '../context/request-context.js';
import { DATABASE } from '../database/database.module.js';
import { ResultsService } from '../results/results.service.js';
import {
  type AcaoHumana,
  type AcaoSombra,
  acaoHumana,
  arrependimento,
  type CampanhaNaJanela,
  type Concordancia,
  concordancia,
  type DecisaoAvaliada,
  JANELA_DIAS,
  prontidao,
  recomendar,
  REGRAS_VERSAO,
  type RotuloDoArrependimento,
} from '../sombra/regras.js';
import { proporPromocoes } from './autonomia-propostas.js';

// A rotina da sombra de uma marca (A3, I5). Fica na pasta do worker porque grava em escopo de sistema, e
// só os jobs do worker podem (regra `liame-escopo-sistema`). Uma vez por dia da loja, depois da leitura
// da manhã:
//   1. olha as recomendações em aberto e registra o que a pessoa fez na plataforma;
//   2. avalia as que já completaram a janela: resultado posterior e arrependimento;
//   3. registra as recomendações novas, com os números da tela Resultados nos últimos 7 dias completos;
//   4. atualiza os sinais de prontidão por conta e ferramenta e, com eles, as propostas de promoção (I13).
// Lê como a empresa (mesma RLS e mesmas contas da tela) e grava em escopo de sistema, com a empresa
// explícita em cada instrução. Nada é executado em plataforma nenhuma.

const FUSO_PADRAO = 'America/Sao_Paulo';
/** Decisão que não conseguiu ser comparada até aqui (fonte parada) sai da amostra. */
const PRAZO_PARA_AVALIAR_DIAS = 14;
/** Janelas de comparação por rodada: o que passar fica para a próxima. */
const JANELAS_POR_RODADA = 14;

export type ResultadoDaSombra =
  | { status: 'feito'; dia: string; novas: number; observadas: number; avaliadas: number; descartadas: number }
  | { status: 'dado_velho'; dia: string; descartadas: number }
  | { status: 'ja_rodou'; dia: string };

type LinhaCampanha = { id: string; connected_account_id: string; provider: string; name: string; status: string; daily_budget_micros: string | null };
type LinhaAberta = {
  id: string;
  campaign_id: string;
  tool: AcaoSombra;
  params: { percent?: number | null };
  state_snapshot: { campanha?: { situacao?: string; verba_diaria_micros?: string | null } };
  decided_on: string;
  evaluate_on: string;
  human_action: AcaoHumana | null;
};

/** "2026-10-02" no fuso dado. */
export function diaNoFuso(agora: Date, fuso: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: fuso, year: 'numeric', month: '2-digit', day: '2-digit' }).format(agora);
}
/** Soma dias a uma data AAAA-MM-DD. */
export function somarDias(dia: string, n: number): string {
  return new Date(Date.parse(`${dia}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

const micros = (texto: string | null | undefined): bigint | null => (texto === null || texto === undefined ? null : BigInt(texto));
/** "83.4" → 834. */
const porMil = (pct: string | null): number => (pct === null ? 0 : Math.round(Number(pct) * 10));
const razaoDe = (porMilValor: number | null): string | null => (porMilValor === null ? null : (porMilValor / 1000).toFixed(4));

function naJanela(c: CampaignResult, estado: LinhaCampanha): CampanhaNaJanela {
  return {
    status: estado.status,
    dailyBudgetMicros: micros(estado.daily_budget_micros),
    spendMicros: BigInt(c.platform.spend_micros),
    orders: c.confirmed.orders,
    revenueMicros: BigInt(c.confirmed.revenue_micros),
    marginKnownMicros: micros(c.confirmed.margin_known_micros),
    marginCoveragePorMil: porMil(c.confirmed.margin_coverage_pct),
    verdict: c.confirmed.verdict as CampanhaNaJanela['verdict'],
  };
}

@Injectable()
export class SombraService {
  constructor(
    @Inject(DATABASE) private readonly database: Database | null,
    private readonly results: ResultsService,
  ) {}

  /**
   * Roda a sombra de uma marca. `ultimoDia` é o último dia da loja em que a rotina já terminou: no mesmo
   * dia ela não repete. O relógio injetado vale para a operação inteira (V34).
   */
  async rodarMarca(alvo: { tenantId: string; brandId: string; ultimoDia?: string | null }, agora = new Date()): Promise<ResultadoDaSombra> {
    if (!this.database) throw new Error('sombra: sem banco');
    const { tenantId, brandId } = alvo;

    // ---- 1. leitura, como a empresa
    const lido = await naTransacaoDaEmpresa(this.database, { tenantId, userId: null }, async () => {
      const tx = currentTx();
      const marca = await tx.execute<{ fuso: string | null }>(sql`
        select (select u.timezone from liame.unit u where u.brand_id = b.id order by u.created_at, u.id limit 1) as fuso
          from liame.brand b where b.id = ${brandId} and b.archived_at is null`);
      if (!marca.rows.length) throw new Error('sombra: marca não encontrada nesta empresa');
      const fuso = marca.rows[0]!.fuso ?? FUSO_PADRAO;
      const hoje = diaNoFuso(agora, fuso);
      if (alvo.ultimoDia === hoje) return { hoje, repetida: true as const };

      const abertas = (
        await tx.execute<LinhaAberta>(sql`
          select id, campaign_id, tool, params, state_snapshot, decided_on::text as decided_on, evaluate_on::text as evaluate_on, human_action
            from liame.shadow_decision where brand_id = ${brandId} and status = 'aberta' order by decided_on, id`)
      ).rows;
      const campanhas = (
        await tx.execute<LinhaCampanha>(sql`
          select c.id, c.connected_account_id, c.provider, c.name, c.status, c.daily_budget_micros::text as daily_budget_micros
            from liame.campaign c join liame.connected_account a on a.id = c.connected_account_id
           where a.brand_id = ${brandId} and a.provider in ('meta_ads', 'google_ads') and a.disconnected_at is null`)
      ).rows;
      const inicio = await tx.execute<{ inicio: Date | string }>(sql`select (${hoje}::date::timestamp at time zone ${fuso}) as inicio`);
      const inicioDoDia = new Date(inicio.rows[0]!.inicio);

      const janela = { from: somarDias(hoje, -JANELA_DIAS), to: somarDias(hoje, -1) };
      const atual = await this.results.closedLoop({ brand_id: brandId, ...janela }, agora);
      // Em dia: toda fonte dentro do prazo e, nas contas de anúncio, a leitura de hoje já feita (só ela
      // traz o dia de ontem inteiro).
      const emDia =
        atual.sources.length > 0 &&
        atual.sources.every((s) => s.freshness === 'fresh' && (s.dataset !== 'metricas' || (s.last_success_at !== null && new Date(s.last_success_at) >= inicioDoDia)));

      const depois = new Map<string, ClosedLoopResponse>();
      if (emDia) {
        const devidas = [...new Set(abertas.filter((a) => a.evaluate_on <= hoje).map((a) => a.decided_on))].slice(0, JANELAS_POR_RODADA);
        for (const dia of devidas) depois.set(dia, await this.results.closedLoop({ brand_id: brandId, from: dia, to: somarDias(dia, JANELA_DIAS - 1) }, agora));
      }
      return { hoje, repetida: false as const, fuso, janela, atual, emDia, abertas, campanhas, depois };
    });
    if (lido.repetida) return { status: 'ja_rodou', dia: lido.hoje };
    const { hoje, fuso, janela, atual, emDia, abertas, depois } = lido;
    const estado = new Map(lido.campanhas.map((c) => [c.id, c]));

    // ---- 2. o que muda nas recomendações em aberto
    const observadas: Array<{ id: string; human_action: AcaoHumana; dia: string; agreement: Concordancia }> = [];
    const avaliadas: Array<{ id: string; human_action: AcaoHumana; agreement: Concordancia; outcome: Record<string, unknown>; regret: string | null; label: RotuloDoArrependimento }> = [];
    const descartadas: Array<{ id: string; motivo: string }> = [];
    const fechadas = new Set<string>();
    for (const a of abertas) {
      const agoraDaCampanha = estado.get(a.campaign_id);
      if (!agoraDaCampanha) {
        descartadas.push({ id: a.id, motivo: 'conta de anúncio desconectada' });
        fechadas.add(a.campaign_id);
        continue;
      }
      if (!emDia) {
        if (somarDias(a.evaluate_on, PRAZO_PARA_AVALIAR_DIAS) < hoje) {
          descartadas.push({ id: a.id, motivo: 'sem dado em dia para comparar dentro do prazo' });
          fechadas.add(a.campaign_id);
        }
        continue;
      }
      let humana = a.human_action;
      if (humana === null) {
        const vista = acaoHumana(
          { status: a.state_snapshot.campanha?.situacao ?? 'ativa', dailyBudgetMicros: micros(a.state_snapshot.campanha?.verba_diaria_micros) },
          { status: agoraDaCampanha.status, dailyBudgetMicros: micros(agoraDaCampanha.daily_budget_micros) },
        );
        if (vista !== 'nenhuma') {
          humana = vista;
          observadas.push({ id: a.id, human_action: vista, dia: hoje, agreement: concordancia(a.tool, vista) });
        }
      }
      const resultado = a.evaluate_on <= hoje ? depois.get(a.decided_on) : undefined;
      if (!resultado) continue;
      const c = resultado.campaigns.find((x) => x.campaign_id === a.campaign_id);
      const noPeriodo = {
        spendMicros: c ? BigInt(c.platform.spend_micros) : 0n,
        orders: c?.confirmed.orders ?? 0,
        marginKnownMicros: micros(c?.confirmed.margin_known_micros),
        marginCoveragePorMil: porMil(c?.confirmed.margin_coverage_pct ?? null),
      };
      const final = humana ?? 'nenhuma';
      const r = arrependimento(a.tool, a.params.percent ?? null, final, noPeriodo);
      avaliadas.push({
        id: a.id,
        human_action: final,
        agreement: concordancia(a.tool, final),
        outcome: {
          janela: { de: resultado.period.from, ate: resultado.period.to, fuso: resultado.period.timezone },
          campanha: { situacao: agoraDaCampanha.status, verba_diaria_micros: agoraDaCampanha.daily_budget_micros },
          plataforma: c?.platform ?? null,
          caixa: c?.confirmed ?? null,
        },
        regret: r.regretMicros === null ? null : r.regretMicros.toString(),
        label: r.label,
      });
      fechadas.add(a.campaign_id);
    }

    // ---- 3. recomendações novas: campanha sem recomendação em aberto, com os números da janela
    const emAberto = new Set(abertas.map((a) => a.campaign_id).filter((id) => !fechadas.has(id)));
    const novas: Array<Record<string, unknown>> = [];
    if (emDia) {
      for (const c of atual.campaigns) {
        const e = estado.get(c.campaign_id);
        if (!e || emAberto.has(c.campaign_id)) continue;
        const r = recomendar(naJanela(c, e));
        if (!r) continue;
        novas.push({
          id: uuidv7(),
          connected_account_id: e.connected_account_id,
          campaign_id: c.campaign_id,
          provider: e.provider,
          tool: r.tool,
          rule_key: r.rule,
          rule_version: r.ruleVersion,
          params: r.percent === null ? {} : { percent: r.percent },
          confidence: (r.confidencePorMil / 1000).toFixed(3),
          state_snapshot: {
            campanha: { nome: e.name, situacao: e.status, verba_diaria_micros: e.daily_budget_micros },
            janela: { de: janela.from, ate: janela.to, fuso },
            plataforma: c.platform,
            caixa: c.confirmed,
            modelo: atual.model,
            fontes: atual.sources.map((s) => ({ provider: s.provider, dataset: s.dataset, freshness: s.freshness, last_success_at: s.last_success_at })),
          },
        });
      }
    }

    // ---- 4. gravação, em escopo de sistema e com a empresa em cada instrução
    await withSystem(this.database.db, async (tx) => {
      if (observadas.length) {
        await tx.execute(sql`
          update liame.shadow_decision d
             set human_action = x.human_action, human_action_on = x.dia::date, agreement = x.agreement, updated_at = now()
            from jsonb_to_recordset(${JSON.stringify(observadas)}::jsonb) as x (id uuid, human_action text, dia text, agreement text)
           where d.id = x.id and d.tenant_id = ${tenantId} and d.status = 'aberta' and d.human_action is null`);
      }
      if (avaliadas.length) {
        await tx.execute(sql`
          update liame.shadow_decision d
             set status = 'avaliada', human_action = coalesce(d.human_action, x.human_action), agreement = coalesce(d.agreement, x.agreement),
                 outcome = x.outcome, action_regret_micros = x.regret, regret_label = x.label,
                 evaluated_at = ${agora.toISOString()}::timestamptz, updated_at = now()
            from jsonb_to_recordset(${JSON.stringify(avaliadas)}::jsonb) as x (id uuid, human_action text, agreement text, outcome jsonb, regret bigint, label text)
           where d.id = x.id and d.tenant_id = ${tenantId} and d.status = 'aberta'`);
      }
      if (descartadas.length) {
        await tx.execute(sql`
          update liame.shadow_decision d
             set status = 'descartada', discard_reason = x.motivo, updated_at = now()
            from jsonb_to_recordset(${JSON.stringify(descartadas)}::jsonb) as x (id uuid, motivo text)
           where d.id = x.id and d.tenant_id = ${tenantId} and d.status = 'aberta'`);
      }
      if (novas.length) {
        await tx.execute(sql`
          insert into liame.shadow_decision (id, tenant_id, brand_id, connected_account_id, campaign_id, provider, source, tool, rule_key, rule_version,
                                             params, confidence, state_snapshot, decided_on, window_from, window_to, evaluate_on, status)
          select x.id, ${tenantId}, ${brandId}, x.connected_account_id, x.campaign_id, x.provider, 'regra', x.tool, x.rule_key, x.rule_version,
                 x.params, x.confidence, x.state_snapshot, ${hoje}::date, ${janela.from}::date, ${janela.to}::date, ${somarDias(hoje, JANELA_DIAS)}::date, 'aberta'
            from jsonb_to_recordset(${JSON.stringify(novas)}::jsonb) as x (
              id uuid, connected_account_id uuid, campaign_id uuid, provider text, tool text, rule_key text, rule_version integer,
              params jsonb, confidence numeric, state_snapshot jsonb)
          on conflict do nothing`);
      }
      if (avaliadas.length) await this.gravarProntidao(tx, { tenantId, brandId, hoje });
    });

    if (!emDia) return { status: 'dado_velho', dia: hoje, descartadas: descartadas.length };
    return { status: 'feito', dia: hoje, novas: novas.length, observadas: observadas.length, avaliadas: avaliadas.length, descartadas: descartadas.length };
  }

  /** Um retrato por dia dos sinais de prontidão de cada conta e ferramenta da marca, com as regras em uso. */
  private async gravarProntidao(tx: Tx, alvo: { tenantId: string; brandId: string; hoje: string }): Promise<void> {
    const r = await tx.execute<{ connected_account_id: string; tool: string; agreement: Concordancia; regret_label: RotuloDoArrependimento; regret: string | null; confidence: string }>(sql`
      select connected_account_id, tool, agreement, regret_label, action_regret_micros::text as regret, confidence::text as confidence
        from liame.shadow_decision
       where tenant_id = ${alvo.tenantId} and brand_id = ${alvo.brandId} and status = 'avaliada' and rule_version = ${REGRAS_VERSAO}`);
    const grupos = new Map<string, { conta: string; tool: string; decisoes: DecisaoAvaliada[] }>();
    for (const l of r.rows) {
      const chave = `${l.connected_account_id}|${l.tool}`;
      const g = grupos.get(chave) ?? { conta: l.connected_account_id, tool: l.tool, decisoes: [] };
      g.decisoes.push({ agreement: l.agreement, label: l.regret_label, regretMicros: micros(l.regret), confidencePorMil: Math.round(Number(l.confidence) * 1000) });
      grupos.set(chave, g);
    }
    if (!grupos.size) return;
    const linhas = [...grupos.values()].map((g) => {
      const p = prontidao(g.decisoes);
      return {
        id: uuidv7(),
        connected_account_id: g.conta,
        tool: g.tool,
        sample_size: p.sampleSize,
        agreement_rate: razaoDe(p.agreementPorMil),
        worse_rate: razaoDe(p.worsePorMil),
        regret_sum_micros: p.regretSumMicros.toString(),
        confidence_avg: p.confidenceAvgPorMil === null ? null : (p.confidenceAvgPorMil / 1000).toFixed(3),
        missing: p.missing,
      };
    });
    await tx.execute(sql`
      insert into liame.readiness_snapshot (id, tenant_id, brand_id, connected_account_id, tool, computed_on, rule_version, sample_size,
                                            agreement_rate, worse_rate, regret_sum_micros, confidence_avg, missing)
      select x.id, ${alvo.tenantId}, ${alvo.brandId}, x.connected_account_id, x.tool, ${alvo.hoje}::date, ${REGRAS_VERSAO}, x.sample_size,
             x.agreement_rate, x.worse_rate, x.regret_sum_micros, x.confidence_avg,
             array(select jsonb_array_elements_text(x.missing))
        from jsonb_to_recordset(${JSON.stringify(linhas)}::jsonb) as x (
          id uuid, connected_account_id uuid, tool text, sample_size integer, agreement_rate numeric, worse_rate numeric,
          regret_sum_micros bigint, confidence_avg numeric, missing jsonb)
      on conflict (connected_account_id, tool, computed_on) do update
         set rule_version = excluded.rule_version, sample_size = excluded.sample_size, agreement_rate = excluded.agreement_rate,
             worse_rate = excluded.worse_rate, regret_sum_micros = excluded.regret_sum_micros, confidence_avg = excluded.confidence_avg,
             missing = excluded.missing`);
    // Com o retrato novo, a vez das propostas de promoção (I13): o sistema propõe, uma pessoa aprova.
    await proporPromocoes(tx, alvo);
  }
}
