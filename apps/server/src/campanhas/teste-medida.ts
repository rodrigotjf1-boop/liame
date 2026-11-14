import type { Tx } from '@liame/database';
import { sql } from 'drizzle-orm';
import { MODELO_PADRAO } from '../attribution/motor.js';
import { contaConectada } from '../connections/conectada.js';
import type { LetraDoTeste } from './teste-contas.js';
import { verbaDeCadaCriativo } from './teste-de-criativo-plano.js';

// A medida do teste de criativo (plano da região, R8; D-RG-77, D-RG-79 e D-RG-91). Quem decide é o caixa: os pedidos
// confirmados da loja do teste, pelo dia da confirmação no fuso da loja, do primeiro dia do teste até o dia de uma
// olhada (nunca "até agora"). O pedido é de um criativo quando tem o cupom dele (`order_fact.coupon_code`) ou quando a
// atribuição do Liame aponta para o anúncio dele (o clique que chegou pelo cardápio, com o id do anúncio no link). O
// mesmo pedido conta uma vez; com o cupom de um criativo e o clique do outro, vale o cupom, que foi o que o cliente
// digitou (é a precedência do motor de atribuição: no pedido com cupom exclusivo, ele nem guarda o anúncio). Sem o
// cardápio que manda o toque do clique, só o cupom separa os criativos. Só leitura do que o Liame já tem: nada vai à
// Meta nem ao Regem.

export type NumerosDoCriativo = {
  pedidos: number;
  receitaMicros: number;
  /** O gasto e os cliques no link do anúncio do criativo no período; nulos enquanto a leitura da Meta não trouxe os números dele. */
  gastoMicros: number | null;
  visitas: number | null;
};
export type MedidaDoTeste = Record<LetraDoTeste, NumerosDoCriativo>;

export type PeriodoDoTeste = { teste: string; tenantId: string; de: string; ate: string; fuso: string };
type Periodo = PeriodoDoTeste;

/** Os anúncios do teste (o id na Meta, a conta de anúncios e, quando a leitura já o trouxe, o da lista do Liame) e o cupom de cada criativo. */
const bracos = (p: Pick<Periodo, 'teste' | 'tenantId'>) => sql`
  select b.letter, b.coupon_code, b.meta_ad_id, t.ad_account_id as conta, a.id as ad_id
    from liame.campaign_test t
    join liame.campaign_test_arm b on b.test_id = t.id and b.tenant_id = t.tenant_id
    left join liame.ad a on a.tenant_id = t.tenant_id and a.connected_account_id = t.ad_account_id and a.external_id = b.meta_ad_id
   where t.id = ${p.teste} and t.tenant_id = ${p.tenantId}`;

/**
 * O gasto e os cliques no link do anúncio de cada criativo no período, como a tela de Resultados lê (por anúncio, sem
 * janela de atribuição). A leitura vai pelo prefixo da chave de `metric_latest` (a conta de anúncios, o nível e o id do
 * anúncio na Meta): a tabela guarda as métricas de todas as empresas, e sem a conta na frente cada olhada a varreria
 * inteira. A busca é por criativo (`lateral`), para o id do anúncio entrar na condição do índice em qualquer plano. Por
 * ir pelo id da Meta, não depende de o anúncio já estar na lista do Liame.
 */
export const consultaDaEntrega = (p: Periodo) => sql`
  with braco as (${bracos(p)})
  select b.letter as letra, m.gasto, m.visitas
    from braco b
    cross join lateral (
      select sum(ml.metric_value) filter (where ml.metric_name = 'spend')::text as gasto,
             sum(ml.metric_value) filter (where ml.metric_name = 'link_clicks')::text as visitas
        from liame.metric_latest ml
       where ml.connected_account_id = b.conta and ml.level = 'ad' and ml.external_entity_id = b.meta_ad_id
         and ml.metric_date between ${p.de}::date and ${p.ate}::date and ml.metric_name in ('spend', 'link_clicks') and ml.attribution_window = ''
    ) m
   where b.meta_ad_id is not null`;

/** Os pedidos, a receita, o gasto e as visitas de cada criativo, de `de` a `ate` (os dois dias inteiros, no fuso da loja). */
export async function medidaDoTeste(tx: Tx, p: Periodo): Promise<MedidaDoTeste> {
  const medida: MedidaDoTeste = { A: { pedidos: 0, receitaMicros: 0, gastoMicros: null, visitas: null }, B: { pedidos: 0, receitaMicros: 0, gastoMicros: null, visitas: null } };
  const pedidos = await tx.execute<{ letra: LetraDoTeste; pedidos: number; receita: string }>(sql`
    with braco as (${bracos(p)}),
    pedido as (
      select o.id, o.revenue_micros,
             (select x.letter from braco x where x.coupon_code = o.coupon_code limit 1) as pelo_cupom,
             (select x.letter from braco x
                join liame.attribution_result r on r.order_id = o.id and r.model_id = ${MODELO_PADRAO} and r.counted and r.ad_id = x.ad_id
               limit 1) as pelo_anuncio
        from liame.campaign_test t
        join liame.connected_account l on l.tenant_id = t.tenant_id and l.unit_id = t.unit_id and l.provider = 'regem'
        join liame.order_fact o on o.tenant_id = t.tenant_id and o.brand_id = t.brand_id and o.connected_account_id = l.id
       where t.id = ${p.teste} and t.tenant_id = ${p.tenantId} and o.status = 'confirmado'
         and o.confirmed_at >= (${p.de}::date)::timestamp at time zone ${p.fuso}
         and o.confirmed_at < (${p.ate}::date + 1)::timestamp at time zone ${p.fuso}
    )
    select coalesce(pelo_cupom, pelo_anuncio) as letra, count(*)::int as pedidos, coalesce(sum(revenue_micros), 0)::text as receita
      from pedido
     where coalesce(pelo_cupom, pelo_anuncio) is not null
     group by 1`);
  for (const l of pedidos.rows) {
    medida[l.letra].pedidos = l.pedidos;
    medida[l.letra].receitaMicros = Number(l.receita);
  }
  const entrega = await tx.execute<{ letra: LetraDoTeste; gasto: string | null; visitas: string | null }>(consultaDaEntrega(p));
  for (const l of entrega.rows) {
    medida[l.letra].gastoMicros = l.gasto === null ? null : Math.round(Number(l.gasto) * 1_000_000);
    medida[l.letra].visitas = l.visitas === null ? null : Math.round(Number(l.visitas));
  }
  return medida;
}

/**
 * A leitura dos pedidos da loja do teste já cobre o dia inteiro? A olhada de um dia só é feita depois de a leitura do
 * caixa passar do fim dele: a olhada guardada não é refeita, e o pedido que chegasse depois ficaria fora para sempre.
 */
export async function leituraDosPedidosCobre(tx: Tx, p: { teste: string; tenantId: string; dia: string; fuso: string }): Promise<boolean> {
  const r = await tx.execute(sql`
    select 1
      from liame.campaign_test t
      join liame.connected_account l on l.tenant_id = t.tenant_id and l.unit_id = t.unit_id and l.provider = 'regem' and ${contaConectada('l')}
      join liame.sync_state s on s.connected_account_id = l.id and s.dataset = 'pedidos'
     where t.id = ${p.teste} and t.tenant_id = ${p.tenantId}
       and s.last_success_at >= (${p.dia}::date + 1)::timestamp at time zone ${p.fuso}
     limit 1`);
  return r.rows.length > 0;
}

/**
 * O que mexeram no teste por fora do Liame, pelo que a leitura da Meta já guardou DEPOIS de o teste começar (a leitura
 * de antes ainda mostra a campanha pausada, como ela nasceu): a campanha de teste ou um conjunto pausado ou apagado, ou
 * a verba de um conjunto diferente da metade. Nulo quando está como o Liame deixou, ou quando a leitura ainda não passou
 * por lá. Quem chama só pergunta com o teste rodando: encerrar e pausar o criativo que perdeu vêm depois.
 */
export async function oQueMexeramNoTeste(tx: Tx, p: { teste: string; tenantId: string; desde: string; fuso: string }): Promise<string | null> {
  const r = await tx.execute<{ letra: LetraDoTeste | null; status: string; verba: string | null; do_teste: string }>(sql`
    select null::text as letra, c.status, null::text as verba, t.daily_budget_micros::text as do_teste
      from liame.campaign_test t
      join liame.campaign c on c.tenant_id = t.tenant_id and c.connected_account_id = t.ad_account_id and c.external_id = t.meta_campaign_id
     where t.id = ${p.teste} and t.tenant_id = ${p.tenantId} and c.last_seen_at >= (${p.desde}::date)::timestamp at time zone ${p.fuso}
    union all
    select b.letter, g.status, g.daily_budget_micros::text, t.daily_budget_micros::text
      from liame.campaign_test t
      join liame.campaign_test_arm b on b.test_id = t.id and b.tenant_id = t.tenant_id
      join liame.ad_group g on g.tenant_id = t.tenant_id and g.connected_account_id = t.ad_account_id and g.external_id = b.meta_adset_id
     where t.id = ${p.teste} and t.tenant_id = ${p.tenantId} and g.last_seen_at >= (${p.desde}::date)::timestamp at time zone ${p.fuso}
     order by 1 nulls first`);
  for (const l of r.rows) {
    const onde = l.letra === null ? 'A campanha de teste' : `O conjunto do criativo ${l.letra}`;
    if (l.status !== 'ativa' && l.status !== 'desconhecida') return `${onde} foi ${l.status === 'pausada' ? 'pausad' : 'apagad'}${l.letra === null ? 'a' : 'o'} fora do Liame.`;
    if (l.letra !== null && l.verba !== null && Number(l.verba) !== verbaDeCadaCriativo(Number(l.do_teste))) return `A verba do conjunto do criativo ${l.letra} foi mudada fora do Liame.`;
  }
  return null;
}
