import type { ClosedLoopAttentionResponse } from '@liame/contracts';
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { MODELO_PADRAO } from '../attribution/motor.js';
import { currentTx } from '../context/request-context.js';
import { AppProblem } from '../errors/problems.js';
import { LinksService } from '../links/links.service.js';
import {
  avisoAnunciosSemRastreio,
  avisoCampanhaSemPedido,
  avisoCampanhasSemCupom,
  avisoCupomSemUso,
  avisoMargemDesconhecida,
  avisoPlataformaCaixa,
  avisoPlataformaNaoInformada,
  avisoSemRegem,
  avisosDaFonte,
  avisoVendasNaoMedidas,
  type ItemCiclo,
  LIMIARES,
  ordenarCiclo,
  plataformaIntegrada,
} from './atencao-ciclo.js';
import { avisoCustoPorPedido, avisoGastoDaCampanha, avisoVendasForaDoNormal, DIAS_DA_SERIE, diaNoFuso, lidaHoje, menosDias, type VendasDoDia } from './fora-do-normal.js';

// Atenção do ciclo fechado (A2.5, F9): calculada na hora, na transação da requisição e sob a RLS da empresa,
// em poucas consultas de conjunto para todas as marcas pedidas (só a conferência do rastreio é por marca, e só
// para a marca com loja no cardápio do Regem). As regras e os textos são funções puras (`atencao-ciclo.ts` e,
// para o que saiu do normal, `fora-do-normal.ts`).

const FUSO_PADRAO = 'America/Sao_Paulo';

type LinhaLoja = {
  id: string;
  brand_id: string;
  name: string;
  status: string;
  status_reason: string | null;
  timezone: string | null;
  unit_id: string | null;
  unit_name: string | null;
  order_platform: string | null;
  escopos: string[] | null;
  pedidos_lidos_em: Date | string | null;
};

@Injectable()
export class AtencaoCicloService {
  constructor(private readonly links: LinksService) {}

  async atencao(brandId: string | undefined, agora = new Date()): Promise<ClosedLoopAttentionResponse> {
    const tx = currentTx();
    const marcas = (
      await tx.execute<{ id: string }>(sql`
        select id from liame.brand where archived_at is null ${brandId ? sql`and id = ${brandId}` : sql``} order by created_at, id`)
    ).rows.map((m) => m.id);
    if (brandId && !marcas.length) throw new AppProblem(404, 'nao-encontrado', 'Não encontramos', 'Marca não encontrada nesta empresa.');
    if (!marcas.length) return { items: [], generated_at: agora.toISOString() };
    const desde = new Date(agora.getTime() - LIMIARES.dias * 86_400_000).toISOString();

    // 1. As lojas do Regem (com a leitura dos pedidos e a plataforma informada) e as marcas com conta de anúncio.
    const lojas = await tx.execute<LinhaLoja>(sql`
      select a.id, a.brand_id, a.name, a.status, a.status_reason, a.timezone, a.unit_id, u.name as unit_name, u.order_platform,
             array(select jsonb_array_elements_text(case when jsonb_typeof(a.provider_attributes -> 'escopos') = 'array' then a.provider_attributes -> 'escopos' else '[]'::jsonb end)) as escopos,
             s.last_success_at as pedidos_lidos_em
        from liame.connected_account a
        left join liame.unit u on u.id = a.unit_id
        left join liame.sync_state s on s.connected_account_id = a.id and s.dataset = 'pedidos'
       where a.provider = 'regem' and a.disconnected_at is null and a.brand_id in ${marcas}
       order by u.name nulls last, a.name, a.id`);
    const comMidia = new Set(
      (
        await tx.execute<{ brand_id: string }>(sql`
          select distinct brand_id from liame.connected_account
           where provider in ('meta_ads', 'google_ads') and disconnected_at is null and brand_id in ${marcas}`)
      ).rows.map((l) => l.brand_id),
    );

    // 2. Campanhas ativas, com o gasto e o que a plataforma informa na janela (no dia da conta de anúncio).
    const campanhas = await tx.execute<{ id: string; name: string; provider: string; brand_id: string; conta: string; gasto: string; valor: string }>(sql`
      with metricas as (
        select coalesce(g.campaign_id, cd.id) as campaign_id, ml.metric_name, sum(ml.metric_value) as total
          from liame.metric_latest ml
          join liame.connected_account a on a.id = ml.connected_account_id
          left join liame.ad ad on ml.level = 'ad' and ad.id = ml.entity_id
          left join liame.ad_group g on g.id = ad.ad_group_id
          left join liame.campaign cd on ml.level = 'campaign' and cd.id = ml.entity_id
         where a.brand_id in ${marcas} and a.provider in ('meta_ads', 'google_ads') and a.disconnected_at is null
           and ((a.provider = 'meta_ads' and ml.level = 'ad') or (a.provider = 'google_ads' and ml.level = 'campaign'))
           and ((ml.metric_name = 'spend' and ml.attribution_window = '')
             or (a.provider = 'meta_ads' and ml.attribution_window = '7d_click' and ml.metric_name = 'purchase_value')
             or (a.provider = 'google_ads' and ml.attribution_window = 'padrao' and ml.metric_name = 'conversions_value'))
           and ml.metric_date > (${agora.toISOString()}::timestamptz at time zone coalesce(a.timezone, ${FUSO_PADRAO}))::date - ${LIMIARES.dias}::int
         group by 1, 2
      )
      select c.id, c.name, c.provider, a.brand_id, a.id as conta,
             coalesce(round((select m.total from metricas m where m.campaign_id = c.id and m.metric_name = 'spend') * 1000000), 0)::bigint::text as gasto,
             coalesce(round((select sum(m.total) from metricas m where m.campaign_id = c.id and m.metric_name <> 'spend') * 1000000), 0)::bigint::text as valor
        from liame.campaign c join liame.connected_account a on a.id = c.connected_account_id
       where a.brand_id in ${marcas} and a.provider in ('meta_ads', 'google_ads') and a.disconnected_at is null
         and (c.status = 'ativa' or exists (select 1 from metricas m where m.campaign_id = c.id))
       order by c.name, c.id`);
    const ativas = await tx.execute<{ id: string }>(sql`
      select c.id from liame.campaign c join liame.connected_account a on a.id = c.connected_account_id
       where a.brand_id in ${marcas} and a.provider in ('meta_ads', 'google_ads') and a.disconnected_at is null and c.status = 'ativa'`);
    const campanhaAtiva = new Set(ativas.rows.map((c) => c.id));

    // 3. Cupons exclusivos em vigor, com os pedidos confirmados da janela com o código.
    const cupons = await tx.execute<{ code: string; campaign_id: string; linked_at: Date | string; brand_id: string; usos: number }>(sql`
      select cp.code, cc.campaign_id, cc.linked_at, a.brand_id,
             (select count(*)::int from liame.order_fact o
               where o.tenant_id = cp.tenant_id and o.coupon_code = cp.code and o.connected_account_id = cp.connected_account_id
                 and o.status = 'confirmado' and o.confirmed_at >= ${desde}::timestamptz) as usos
        from liame.campaign_coupon cc
        join liame.coupon cp on cp.id = cc.coupon_id
        join liame.connected_account a on a.id = cp.connected_account_id
       where cc.exclusive and cc.linked_at <= now() and (cc.unlinked_at is null or cc.unlinked_at > now())
         and cp.removed_at is null and a.disconnected_at is null and a.brand_id in ${marcas}
       order by cc.linked_at, cc.id`);

    // 4. O que o caixa confirmou e ficou com campanha na janela, e quanto disso tem margem desconhecida.
    const caixa = await tx.execute<{ brand_id: string; campaign_id: string | null; provider: string | null; n: number; receita: string; sem_margem: string }>(sql`
      with pedidos as (
        select o.id, o.brand_id, o.revenue_micros - o.refunded_micros as liquido
          from liame.order_fact o
         where o.brand_id in ${marcas} and o.status = 'confirmado' and o.confirmed_at >= ${desde}::timestamptz
      ),
      custos as (
        select i.order_id, bool_and(i.cost_known) as conhecido, count(*) as n
          from liame.order_item_fact i join pedidos p on p.id = i.order_id
         where i.removed_at is null
         group by 1
      )
      select p.brand_id, r.campaign_id, r.provider, count(*)::int as n, sum(p.liquido)::text as receita,
             coalesce(sum(p.liquido) filter (where not (coalesce(c.conhecido, false) and coalesce(c.n, 0) > 0)), 0)::text as sem_margem
        from pedidos p
        join liame.attribution_result r on r.order_id = p.id and r.model_id = ${MODELO_PADRAO} and r.counted
        left join custos c on c.order_id = p.id
       group by 1, 2, 3`);

    // 5. Fora do normal (A3, I6): a série dos últimos dias de cada loja e de cada campanha, para comparar
    //    ontem com o mesmo dia das semanas anteriores, e os pedidos das 4 semanas antes da janela.
    const inicioDaSerie = new Date(agora.getTime() - DIAS_DA_SERIE * 86_400_000).toISOString();
    const vendasPorDia = await tx.execute<{ loja: string; dia: string; pedidos: number; receita: string }>(sql`
      select o.connected_account_id as loja,
             (coalesce(o.billed_at, o.confirmed_at) at time zone coalesce(a.timezone, ${FUSO_PADRAO}))::date::text as dia,
             count(*)::int as pedidos, sum(o.revenue_micros - o.refunded_micros)::text as receita
        from liame.order_fact o
        join liame.connected_account a on a.id = o.connected_account_id
       where o.brand_id in ${marcas} and o.status = 'confirmado' and a.provider = 'regem' and a.disconnected_at is null
         and coalesce(o.billed_at, o.confirmed_at) >= ${inicioDaSerie}::timestamptz
       group by 1, 2`);
    const serieDaLoja = new Map<string, Map<string, VendasDoDia>>();
    for (const l of vendasPorDia.rows) {
      const serie = serieDaLoja.get(l.loja) ?? new Map<string, VendasDoDia>();
      serie.set(l.dia, { pedidos: Number(l.pedidos), receitaMicros: BigInt(l.receita) });
      serieDaLoja.set(l.loja, serie);
    }
    const gastoPorDia = await tx.execute<{ campaign_id: string | null; dia: string; gasto: string }>(sql`
      select coalesce(g.campaign_id, cd.id) as campaign_id, ml.metric_date::text as dia, round(sum(ml.metric_value) * 1000000)::bigint::text as gasto
        from liame.metric_latest ml
        join liame.connected_account a on a.id = ml.connected_account_id
        left join liame.ad ad on ml.level = 'ad' and ad.id = ml.entity_id
        left join liame.ad_group g on g.id = ad.ad_group_id
        left join liame.campaign cd on ml.level = 'campaign' and cd.id = ml.entity_id
       where a.brand_id in ${marcas} and a.provider in ('meta_ads', 'google_ads') and a.disconnected_at is null
         and ((a.provider = 'meta_ads' and ml.level = 'ad') or (a.provider = 'google_ads' and ml.level = 'campaign'))
         and ml.metric_name = 'spend' and ml.attribution_window = ''
         and ml.metric_date >= (${agora.toISOString()}::timestamptz at time zone coalesce(a.timezone, ${FUSO_PADRAO}))::date - ${DIAS_DA_SERIE}::int
       group by 1, 2`);
    const serieDaCampanha = new Map<string, Map<string, bigint>>();
    for (const l of gastoPorDia.rows) {
      if (!l.campaign_id) continue;
      const serie = serieDaCampanha.get(l.campaign_id) ?? new Map<string, bigint>();
      serie.set(l.dia, BigInt(l.gasto));
      serieDaCampanha.set(l.campaign_id, serie);
    }
    const contasDeAnuncio = new Map(
      (
        await tx.execute<{ id: string; fuso: string; lidas_em: Date | string | null }>(sql`
          select a.id, coalesce(a.timezone, ${FUSO_PADRAO}) as fuso, s.last_success_at as lidas_em
            from liame.connected_account a
            left join liame.sync_state s on s.connected_account_id = a.id and s.dataset = 'metricas'
           where a.brand_id in ${marcas} and a.provider in ('meta_ads', 'google_ads') and a.disconnected_at is null`)
      ).rows.map((c) => [c.id, c]),
    );
    const pedidosDaHistoria = new Map(
      (
        await tx.execute<{ campaign_id: string; n: number }>(sql`
          select r.campaign_id, count(*)::int as n
            from liame.order_fact o
            join liame.attribution_result r on r.order_id = o.id and r.model_id = ${MODELO_PADRAO} and r.counted
           where o.brand_id in ${marcas} and o.status = 'confirmado' and r.campaign_id is not null
             and o.confirmed_at >= ${new Date(agora.getTime() - (LIMIARES.dias + 28) * 86_400_000).toISOString()}::timestamptz
             and o.confirmed_at < ${desde}::timestamptz
           group by 1`)
      ).rows.map((l) => [l.campaign_id, Number(l.n)]),
    );
    const primeiroDia = <T>(serie: Map<string, T> | undefined) => (serie?.size ? [...serie.keys()].sort()[0]! : null);

    const itens: ItemCiclo[] = [];
    // A marca de cada aviso: é com ela que a tela pede a explicação (I4). Os avisos saem das regras sem
    // marca; aqui cada um fica com a da volta em que nasceu.
    const marcaDoAviso = new Map<ItemCiclo, string>();
    for (const marca of marcas) {
      const inicio = itens.length;
      try {
        const lojasDaMarca = lojas.rows.filter((l) => l.brand_id === marca);
        const campanhasDaMarca = campanhas.rows.filter((c) => c.brand_id === marca);
        if (!lojasDaMarca.length) {
          if (comMidia.has(marca) && !itens.some((i) => i.kind === 'vendas_nao_conectadas')) itens.push(avisoSemRegem());
          continue;
        }

        // Fonte das vendas e como cada loja mede.
        const plataformas = new Set<string>();
        for (const l of lojasDaMarca) {
          const loja = { id: l.id, nome: l.unit_name ?? l.name };
          itens.push(...avisosDaFonte({ ...loja, status: l.status, statusReason: l.status_reason, fuso: l.timezone, pedidosLidosEm: l.pedidos_lidos_em }, agora));
          // Vendas de ontem fora do normal: só com os pedidos lidos hoje (dado velho não gera aviso).
          const fusoDaLoja = l.timezone ?? FUSO_PADRAO;
          if (l.status === 'ativa' && l.pedidos_lidos_em && lidaHoje(l.pedidos_lidos_em, agora, fusoDaLoja)) {
            const serie = serieDaLoja.get(l.id) ?? new Map<string, VendasDoDia>();
            const aviso = avisoVendasForaDoNormal({ ...loja, fuso: fusoDaLoja, lidoEm: l.pedidos_lidos_em, desde: primeiroDia(serie), porDia: serie }, menosDias(diaNoFuso(agora, fusoDaLoja), 1));
            if (aviso) itens.push(aviso);
          }
          if (!comMidia.has(marca)) continue;
          if (!l.order_platform) itens.push(avisoPlataformaNaoInformada(loja));
          else if (l.order_platform === 'regem' || plataformaIntegrada(l.order_platform)) plataformas.add(l.order_platform);
          else itens.push(avisoVendasNaoMedidas(loja, l.order_platform));
        }
        if (!comMidia.has(marca)) continue;

        const cuponsDaMarca = cupons.rows.filter((c) => c.brand_id === marca);
        const comCupom = new Set(cuponsDaMarca.map((c) => c.campaign_id));
        const pedidosDaCampanha = new Map<string, number>();
        for (const c of caixa.rows) if (c.brand_id === marca && c.campaign_id) pedidosDaCampanha.set(c.campaign_id, (pedidosDaCampanha.get(c.campaign_id) ?? 0) + Number(c.n));

        // Loja no cardápio do Regem: os anúncios ativos precisam dos parâmetros; a campanha medida pelo clique
        // que gastou e não vendeu vira aviso.
        if (plataformas.has('regem')) {
          const rastreio = await this.links.rastreioPorCampanha(marca, agora);
          const comAnuncioSemRastreio = [...rastreio.campanhas.values()].filter((c) => c.semRastreio > 0).length;
          const aviso = avisoAnunciosSemRastreio(rastreio.resumo.without_tracking, comAnuncioSemRastreio);
          if (aviso) itens.push(aviso);
          for (const c of campanhasDaMarca) {
            if (!campanhaAtiva.has(c.id)) continue;
            const semPedido = avisoCampanhaSemPedido({
              id: c.id,
              name: c.name,
              provider: c.provider,
              connectedAccountId: c.conta,
              gastoMicros: BigInt(c.gasto),
              pedidos: pedidosDaCampanha.get(c.id) ?? 0,
              anunciosComRastreio: rastreio.campanhas.get(c.id)?.comRastreio ?? 0,
              temCupomExclusivo: comCupom.has(c.id),
            });
            if (semPedido) itens.push(semPedido);
          }
        }
        // Loja em plataforma de pedidos integrada: cada campanha ativa precisa de um cupom exclusivo.
        const integrada = [...plataformas].find(plataformaIntegrada);
        if (integrada) {
          const semCupom = campanhasDaMarca.filter((c) => campanhaAtiva.has(c.id) && !comCupom.has(c.id)).length;
          const aviso = avisoCampanhasSemCupom(semCupom, integrada);
          if (aviso) itens.push(aviso);
        }

        // Cupom exclusivo sem uso, com a campanha gastando.
        for (const cupom of cuponsDaMarca) {
          const campanha = campanhasDaMarca.find((c) => c.id === cupom.campaign_id);
          if (!campanha) continue;
          const aviso = avisoCupomSemUso(
            { code: cupom.code, campaignId: campanha.id, campaignName: campanha.name, provider: campanha.provider, connectedAccountId: campanha.conta, ligadoEm: cupom.linked_at, usos: Number(cupom.usos), gastoMicros: BigInt(campanha.gasto) },
            agora,
          );
          if (aviso) itens.push(aviso);
        }

        // Fora do normal por campanha (I6): o gasto de ontem e o custo por pedido, só com a plataforma lida hoje.
        for (const c of campanhasDaMarca) {
          const contaDeAnuncio = contasDeAnuncio.get(c.conta);
          if (!campanhaAtiva.has(c.id) || !contaDeAnuncio || !contaDeAnuncio.lidas_em || !lidaHoje(contaDeAnuncio.lidas_em, agora, contaDeAnuncio.fuso)) continue;
          const serie = serieDaCampanha.get(c.id) ?? new Map<string, bigint>();
          const hoje = diaNoFuso(agora, contaDeAnuncio.fuso);
          const base = { id: c.id, name: c.name, provider: c.provider, connectedAccountId: c.conta };
          const gasto = avisoGastoDaCampanha({ ...base, fuso: contaDeAnuncio.fuso, lidoEm: contaDeAnuncio.lidas_em, desde: primeiroDia(serie), gastoPorDia: serie }, menosDias(hoje, 1));
          if (gasto) itens.push(gasto);
          // As 4 semanas antes dos últimos 7 dias.
          let gastoDaHistoria = 0n;
          for (let d = LIMIARES.dias; d < LIMIARES.dias + 28; d++) gastoDaHistoria += serie.get(menosDias(hoje, d)) ?? 0n;
          const custo = avisoCustoPorPedido({
            ...base,
            semana: { gastoMicros: BigInt(c.gasto), pedidos: pedidosDaCampanha.get(c.id) ?? 0 },
            historia: { gastoMicros: gastoDaHistoria, pedidos: pedidosDaHistoria.get(c.id) ?? 0 },
          });
          if (custo) itens.push(custo);
        }

        // Margem desconhecida na receita atribuída e plataforma × caixa, por plataforma de anúncio.
        const caixaDaMarca = caixa.rows.filter((c) => c.brand_id === marca);
        const receita = caixaDaMarca.reduce((s, c) => s + BigInt(c.receita), 0n);
        const semMargem = caixaDaMarca.reduce((s, c) => s + BigInt(c.sem_margem), 0n);
        const liberaCusto = lojasDaMarca.some((l) => (l.escopos ?? []).includes('custos.ler'));
        const margem = avisoMargemDesconhecida(receita, semMargem, liberaCusto);
        if (margem) itens.push(margem);
        for (const provider of ['meta_ads', 'google_ads']) {
          const informado = campanhasDaMarca.filter((c) => c.provider === provider).reduce((s, c) => s + BigInt(c.valor), 0n);
          const confirmado = caixaDaMarca.filter((c) => c.provider === provider).reduce((s, c) => s + BigInt(c.receita), 0n);
          const aviso = avisoPlataformaCaixa(provider, informado, confirmado);
          if (aviso) itens.push(aviso);
        }
      } finally {
        for (let k = inicio; k < itens.length; k++) marcaDoAviso.set(itens[k]!, marca);
      }
    }
    return { items: ordenarCiclo(itens).map((i) => ({ ...i, brand_id: marcaDoAviso.get(i) ?? null })), generated_at: agora.toISOString() };
  }
}
