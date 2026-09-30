import { type Tx, uuidv7 } from '@liame/database';
import { sql } from 'drizzle-orm';
import type { ToqueLido } from '../attribution/toque-store.js';
import type { CupomRegem, PedidoRegem } from '../connectors/regem/contrato-regem.js';
import { centavosParaMicros, type PedidoLido } from './order-store.js';

// Do contrato do Regem (docs/integracoes/regem.md e cupons.md) para o modelo do Liame (F1, F2). Funções
// puras, exceto a gravação dos cupons. O telefone não passa por aqui: quem chama já trocou pelo índice
// cego (a chave é da empresa, no cofre).

/** O pedido do Regem no formato de `gravarPedidos`. Marketplace chega sem cliente (D-A2.5-11). */
export function pedidoDoRegem(p: PedidoRegem, indiceTelefone: string | null): PedidoLido {
  const marketplace = p.grupo_canal === 'marketplace';
  return {
    externalId: p.id,
    channel: p.canal,
    channelGroup: p.grupo_canal,
    status: p.situacao,
    currency: p.moeda,
    timezone: p.fuso,
    revenueMicros: centavosParaMicros(p.receita_centavos),
    discountMicros: centavosParaMicros(p.desconto_loja_centavos),
    refundedMicros: centavosParaMicros(p.estornado_centavos),
    couponCode: p.cupom?.trim() ? p.cupom.trim().toUpperCase() : null,
    customer: marketplace || !p.cliente ? null : { phoneIndex: indiceTelefone, externalId: p.cliente.id },
    isNewCustomer: marketplace ? null : (p.cliente?.novo ?? null),
    placedAt: p.criado_em ?? null,
    confirmedAt: p.confirmado_em,
    billedAt: p.faturado_em ?? null,
    cancelledAt: p.cancelado_em,
    version: p.versao,
    sourceUpdatedAt: p.atualizado_em,
    items: p.itens.map((i) => ({
      externalId: i.id,
      productExternalId: i.produto_id ?? null,
      name: i.nome,
      quantity: i.quantidade,
      revenueMicros: centavosParaMicros(i.receita_centavos),
      costMicros: i.custo_centavos === null ? null : centavosParaMicros(i.custo_centavos),
    })),
  };
}

/**
 * O clique captado pelo cardápio na sessão do pedido (C3a) vira um ponto de contato ligado a ele. Pedido
 * de marketplace não tem clique da loja: a origem, se vier, é ignorada.
 */
export function toqueDoPedido(p: PedidoRegem): ToqueLido | null {
  const o = p.origem;
  if (!o || p.grupo_canal === 'marketplace') return null;
  return {
    externalId: `pedido:${p.id}`,
    kind: 'clique',
    occurredAt: o.capturado_em,
    orderExternalId: p.id,
    linkCode: o.lk ?? null,
    campaignExternalId: o.campaign_id ?? null,
    adGroupExternalId: o.adset_id ?? o.adgroup_id ?? null,
    adExternalId: o.ad_id ?? null,
    gclid: o.gclid ?? null,
    gbraid: o.gbraid ?? null,
    wbraid: o.wbraid ?? null,
    fbclid: o.fbclid ?? null,
    utm: { source: o.utm_source, medium: o.utm_medium, campaign: o.utm_campaign, content: o.utm_content, term: o.utm_term },
    origem: 'url',
  };
}

export type ContextoCupons = { tenantId: string; brandId: string; connectedAccountId: string };

/** Cupom que ficou fora da gravação: o id na origem e o motivo (sem o código nem o nome). */
export type CupomRecusado = { id: string; motivo: string };

export type CuponsGravados = {
  alterados: number;
  /** Cupons do Liame inseridos ou alterados (para refazer a atribuição dos pedidos que os citam). */
  ids: string[];
  recusados: CupomRecusado[];
};

/** Maiores valores das colunas `integer` e `bigint` de `liame.coupon` (o zod do contrato vai além). */
const INTEIRO_MAX = 2_147_483_647;
const BIGINT_MAX = 9_223_372_036_854_775_807n;

/**
 * Texto que o Postgres guarda: sem o caractere nulo (U+0000) e sem metade de par de surrogates. Qualquer um
 * dos dois derruba a conversão da página inteira para jsonb (22P05, 22P02), não só a linha dele. Condições
 * aninhadas além de 32 níveis também ficam de fora (a conferência não desce sem teto).
 */
function textoAceito(v: unknown, nivel = 0): boolean {
  if (typeof v === 'string') return !v.includes('\u0000') && v.isWellFormed();
  if (v === null || typeof v !== 'object') return true;
  if (nivel >= 32) return false;
  return Object.entries(v).every(([k, x]) => textoAceito(k, nivel + 1) && textoAceito(x, nivel + 1));
}

/** Ano 0000: o formato do contrato aceita, o Postgres não (22008). */
const anoZero = (v: string | null | undefined): boolean => typeof v === 'string' && v.startsWith('0000');

/**
 * Fuso que o banco conhece. O Postgres só confere o fuso quando o cupom tem data de validade (`at time zone`):
 * fuso desconhecido ali derruba a instrução (22023). O Node (ICU) e o Postgres usam o banco de fusos da IANA;
 * o que sobra de risco é um nome recém-criado que só um dos dois conheça. Abreviação (`BRT`), que o Postgres
 * aceitaria, fica de fora: o fuso do contrato é o nome da IANA (`America/Sao_Paulo`).
 */
function fusoConhecido(fuso: string): boolean {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: fuso }).resolvedOptions().timeZone.length > 0;
  } catch {
    return false;
  }
}

/**
 * Por que `liame.coupon` (migrations 0022, 0024 e 0025) recusaria o cupom, ou `null`. Uma linha recusada
 * derrubaria a instrução inteira, e a página junto: o cupom recusado fica de fora e o resto grava. O motivo
 * nunca leva o código nem o nome do cupom (podem ter nome de gente).
 */
export function motivoRecusaCupom(c: CupomRegem): string | null {
  if (!textoAceito(c)) return 'texto com caractere que o banco não guarda';
  const codigo = [...c.codigo.trim().toUpperCase()];
  if (codigo.length < 1 || codigo.length > 60) return 'código vazio ou com mais de 60 caracteres';
  if (c.percentual != null && !(Number(c.percentual) > 0 && Number(c.percentual) <= 100)) return 'percentual fora de (0, 100]';
  if ((c.max_usos ?? 0) > INTEIRO_MAX || c.usos > INTEIRO_MAX) return 'limite ou contagem de usos acima do que o banco guarda';
  if (c.versao > BIGINT_MAX) return 'versão acima do que o banco guarda';
  if ([c.valido_de, c.valido_ate, c.atualizado_em].some(anoZero)) return 'data fora do calendário do banco';
  if ((c.valido_de || c.valido_ate) && !fusoConhecido(c.fuso)) return 'fuso desconhecido';
  return null;
}

/**
 * Espelho dos cupons da loja (D-A2.5-3): a versão do recurso decide, como nos pedidos. A validade chega em
 * datas no fuso da loja e vira instante: do começo do primeiro dia até o fim do último (exclusivo). Cupom
 * que o banco recusaria fica de fora (`recusados`), sem derrubar a página.
 */
export async function gravarCupons(tx: Tx, ctx: ContextoCupons, cupons: CupomRegem[]): Promise<CuponsGravados> {
  const porId = new Map<string, CupomRegem>();
  for (const c of cupons) {
    const antes = porId.get(c.id);
    if (!antes || c.versao > antes.versao) porId.set(c.id, c);
  }
  const recusados: CupomRecusado[] = [];
  const aceitos: CupomRegem[] = [];
  for (const c of porId.values()) {
    const motivo = motivoRecusaCupom(c);
    if (motivo) recusados.push({ id: c.id, motivo });
    else aceitos.push(c);
  }
  if (!aceitos.length) return { alterados: 0, ids: [], recusados };
  const linhas = aceitos.map((c) => ({
    new_id: uuidv7(),
    external_id: c.id,
    code: c.codigo.trim().toUpperCase(),
    description: c.nome?.slice(0, 500) ?? null,
    kind: c.tipo,
    percent: c.percentual ?? null,
    value_micros: c.valor_centavos == null ? null : centavosParaMicros(c.valor_centavos).toString(),
    max_discount_micros: c.teto_desconto_centavos == null ? null : centavosParaMicros(c.teto_desconto_centavos).toString(),
    min_order_micros: c.pedido_minimo_centavos == null ? null : centavosParaMicros(c.pedido_minimo_centavos).toString(),
    valido_de: c.valido_de ?? null,
    valido_ate: c.valido_ate ?? null,
    fuso: c.fuso,
    active: c.ativo,
    max_uses: c.max_usos ?? null,
    uses_count: c.usos,
    conditions: c.condicoes ?? {},
    all_units: c.todas_as_lojas ?? false,
    removido: c.removido ?? false,
    source_version: c.versao.toString(),
    source_updated_at: c.atualizado_em,
  }));
  const r = await tx.execute<{ id: string | null; recusado: string | null }>(sql`
    with e as (
      select * from jsonb_to_recordset(${JSON.stringify(linhas)}::jsonb) as e(
        new_id uuid, external_id text, code text, description text, kind text, percent numeric, value_micros bigint,
        max_discount_micros bigint, min_order_micros bigint, valido_de date, valido_ate date, fuso text, active boolean,
        max_uses integer, uses_count integer, conditions jsonb, all_units boolean, removido boolean, source_version bigint,
        source_updated_at timestamptz)
    ),
    -- As maiúsculas do código são conferidas pelas regras do banco (code = upper(code)), que o JS não prevê
    -- em todo caractere: o que ele não aceitaria fica de fora, sem derrubar a página.
    aceitos as (select * from e where e.code = upper(e.code)),
    gravados as (
    insert into liame.coupon (
      id, tenant_id, brand_id, connected_account_id, external_id, code, description, kind, percent, value_micros,
      max_discount_micros, min_order_micros, valid_from, valid_until, active, max_uses, uses_count, conditions, all_units,
      removed_at, source_version, source_updated_at)
    select e.new_id, ${ctx.tenantId}, ${ctx.brandId}, ${ctx.connectedAccountId}, e.external_id, e.code, e.description, e.kind,
           e.percent, e.value_micros, e.max_discount_micros, e.min_order_micros,
           e.valido_de::timestamp at time zone e.fuso,
           (e.valido_ate + 1)::timestamp at time zone e.fuso,
           e.active, e.max_uses, e.uses_count, e.conditions, e.all_units, case when e.removido then now() end,
           e.source_version, e.source_updated_at
      from aceitos e
    on conflict (connected_account_id, external_id) do update
       set code = excluded.code, description = excluded.description, kind = excluded.kind, percent = excluded.percent,
           value_micros = excluded.value_micros, max_discount_micros = excluded.max_discount_micros,
           min_order_micros = excluded.min_order_micros, valid_from = excluded.valid_from, valid_until = excluded.valid_until,
           active = excluded.active, max_uses = excluded.max_uses, uses_count = excluded.uses_count,
           conditions = excluded.conditions, all_units = excluded.all_units,
           removed_at = case when excluded.removed_at is null then null else coalesce(liame.coupon.removed_at, excluded.removed_at) end,
           source_version = excluded.source_version, source_updated_at = excluded.source_updated_at
     where liame.coupon.source_version < excluded.source_version
    returning id, removed_at
    ),
    -- Cupom apagado na origem deixa de ligar a campanhas; o que já foi atribuído fica.
    desligados as (
      update liame.campaign_coupon cc set unlinked_at = now()
        from gravados g
       where cc.coupon_id = g.id and g.removed_at is not null and cc.unlinked_at is null
      returning cc.id
    )
    select g.id, null::text as recusado from gravados g
    union all
    select null, e.external_id from e where e.code <> upper(e.code)`);
  const ids: string[] = [];
  for (const l of r.rows) {
    if (l.id) ids.push(l.id);
    else if (l.recusado) recusados.push({ id: l.recusado, motivo: 'código fora das maiúsculas do banco' });
  }
  return { alterados: ids.length, ids, recusados };
}
