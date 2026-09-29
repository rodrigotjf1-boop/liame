import { type Tx, uuidv7 } from '@liame/database';
import { sql } from 'drizzle-orm';

// Gravação dos pontos de contato (A2.5, F2; ADR-019 e ADR-020). Clique: captado pelo cardápio da loja e
// ligado ao pedido pelo id dele na origem (C3a). Conversa: aberta por anúncio de clique para WhatsApp
// (referral do RegemCast), ligada ao pedido pelo cliente pseudonimizado. Poucas instruções por lote, na
// transação de quem chama, sob a RLS da empresa. O telefone nunca chega aqui: só o índice cego.

/** De onde veio o campo: a URL do cardápio, o referral do RegemCast ou a resolução pela API do Google. */
export type OrigemCampo = 'url' | 'regemcast' | 'google_ads';

export type ToqueLido = {
  externalId: string;
  kind: 'clique' | 'conversa';
  occurredAt: string;
  /** Clique: o pedido que a sessão fechou (id na origem). */
  orderExternalId?: string | null;
  /** Conversa: índice cego do telefone de quem abriu a conversa. */
  customerPhoneIndex?: string | null;
  /** Plataforma declarada pela origem (o referral é sempre da Meta); sem ela, deduzida dos ids. */
  provider?: string | null;
  linkCode?: string | null;
  campaignExternalId?: string | null;
  adGroupExternalId?: string | null;
  adExternalId?: string | null;
  gclid?: string | null;
  gbraid?: string | null;
  wbraid?: string | null;
  fbclid?: string | null;
  ctwaClid?: string | null;
  utm?: { source?: string | null; medium?: string | null; campaign?: string | null; content?: string | null; term?: string | null };
  /** Origem dos campos lidos (padrão: `url` para clique, `regemcast` para conversa). */
  origem?: OrigemCampo;
};

export type ContextoToques = { tenantId: string; brandId: string; connectedAccountId: string };

const LOTE = 1000;
const INDICE = /^[0-9a-f]{64}$/;
const FONTES_META = new Set(['meta', 'facebook', 'fb', 'instagram', 'ig', 'msg', 'an', 'th', 'meta_ads']);
const FONTES_GOOGLE = new Set(['google', 'adwords', 'googleads', 'google_ads']);

/**
 * A plataforma do clique. Id de clique prova a plataforma (fbclid e ctwa_clid: Meta; gclid, gbraid e
 * wbraid: Google). Sem id de clique, o `utm_source` só vale junto com um id de campanha, grupo ou anúncio
 * (os parâmetros dinâmicos do link, F5): nome solto no UTM não é evidência (ADR-020).
 */
export function inferirProvider(t: ToqueLido): string | null {
  if (t.provider) return t.provider;
  if (t.fbclid || t.ctwaClid) return 'meta_ads';
  if (t.gclid || t.gbraid || t.wbraid) return 'google_ads';
  const temId = Boolean(t.campaignExternalId || t.adGroupExternalId || t.adExternalId);
  const fonte = t.utm?.source?.trim().toLowerCase();
  if (temId && fonte && FONTES_META.has(fonte)) return 'meta_ads';
  if (temId && fonte && FONTES_GOOGLE.has(fonte)) return 'google_ads';
  return null;
}

// Valor fora do formato vira ausente, nunca cortado: id cortado ligaria o pedido à campanha errada, e o
// parâmetro dinâmico que a plataforma não substituiu ("{{ad.id}}") não é id nenhum.
const ID_PLATAFORMA = /^\d{1,40}$/;
const CODIGO_LINK = /^[A-Za-z0-9]{6,32}$/;
const ID_CLIQUE = /^[\x21-\x7e]{1,1024}$/;

const CAMPOS = [
  ['linkCode', 'link_code', CODIGO_LINK],
  ['campaignExternalId', 'campaign_external_id', ID_PLATAFORMA],
  ['adGroupExternalId', 'ad_group_external_id', ID_PLATAFORMA],
  ['adExternalId', 'ad_external_id', ID_PLATAFORMA],
  ['gclid', 'gclid', ID_CLIQUE],
  ['gbraid', 'gbraid', ID_CLIQUE],
  ['wbraid', 'wbraid', ID_CLIQUE],
  ['fbclid', 'fbclid', ID_CLIQUE],
  ['ctwaClid', 'ctwa_clid', ID_CLIQUE],
] as const;

const valido = (v: string | null | undefined, formato: RegExp): string | null => {
  const s = v?.trim();
  if (!s || s.length > 1024) return null;
  // As três regex acima são ancoradas, de uma classe de caracteres só e com repetição limitada: tempo
  // linear, sem retrocesso catastrófico; o texto ainda passa pelo teto de 1.024 caracteres antes.
  return formato.test(s) ? s : null; // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos
};

const limpo = (v: string | null | undefined, max: number): string | null => {
  const s = v?.trim();
  return s ? s.slice(0, max) : null;
};

/** Grava os toques lidos. Devolve os ids dos toques que entraram ou mudaram (para recalcular a atribuição). */
export async function gravarToques(tx: Tx, ctx: ContextoToques, toques: ToqueLido[]): Promise<{ novos: number; alterados: string[] }> {
  const unicos = [...new Map(toques.map((t) => [t.externalId, t])).values()];
  let novos = 0;
  const alterados: string[] = [];
  for (let i = 0; i < unicos.length; i += LOTE) {
    const lote = unicos.slice(i, i + LOTE);

    const indices = [...new Set(lote.map((t) => (t.kind === 'conversa' ? (t.customerPhoneIndex ?? null) : null)).filter((x): x is string => x !== null))];
    if (indices.some((x) => !INDICE.test(x))) throw new Error('índice cego do telefone inválido');
    if (indices.length) {
      await tx.execute(sql`
        insert into liame.customer_ref (id, tenant_id, phone_index)
        select e.new_id, ${ctx.tenantId}, e.phone_index
          from jsonb_to_recordset(${JSON.stringify(indices.map((phone_index) => ({ phone_index, new_id: uuidv7() })))}::jsonb)
               as e(phone_index text, new_id uuid)
        on conflict (tenant_id, phone_index) where phone_index is not null do update set last_seen_at = now()`);
    }

    const linhas = lote.map((t) => {
      const origem: OrigemCampo = t.origem ?? (t.kind === 'conversa' ? 'regemcast' : 'url');
      const campos = Object.fromEntries(CAMPOS.map(([de, para, formato]) => [para, valido(t[de], formato)]));
      const provenance = Object.fromEntries(Object.entries(campos).filter(([, v]) => v !== null).map(([k]) => [k, origem]));
      // A plataforma sai só dos campos válidos: id descartado não prova nada.
      const validos: ToqueLido = { ...t, ...Object.fromEntries(CAMPOS.map(([de, para]) => [de, campos[para]])) };
      return {
        external_id: t.externalId,
        new_id: uuidv7(),
        kind: t.kind,
        occurred_at: t.occurredAt,
        order_external_id: t.kind === 'clique' ? (t.orderExternalId ?? null) : null,
        phone_index: t.kind === 'conversa' ? (t.customerPhoneIndex ?? null) : null,
        provider: inferirProvider(validos),
        ...campos,
        utm_source: limpo(t.utm?.source, 300),
        utm_medium: limpo(t.utm?.medium, 300),
        utm_campaign: limpo(t.utm?.campaign, 300),
        utm_content: limpo(t.utm?.content, 300),
        utm_term: limpo(t.utm?.term, 300),
        provenance,
      };
    });

    const r = await tx.execute<{ id: string; novo: boolean }>(sql`
      with e as (
        select * from jsonb_to_recordset(${JSON.stringify(linhas)}::jsonb) as e(
          external_id text, new_id uuid, kind text, occurred_at timestamptz, order_external_id text, phone_index text,
          provider text, link_code text, campaign_external_id text, ad_group_external_id text, ad_external_id text,
          gclid text, gbraid text, wbraid text, fbclid text, ctwa_clid text, utm_source text, utm_medium text,
          utm_campaign text, utm_content text, utm_term text, provenance jsonb)
      )
      insert into liame.touchpoint (
        id, tenant_id, brand_id, connected_account_id, external_id, kind, occurred_at, order_external_id, customer_ref_id,
        provider, link_code, campaign_external_id, ad_group_external_id, ad_external_id, gclid, gbraid, wbraid, fbclid,
        ctwa_clid, utm_source, utm_medium, utm_campaign, utm_content, utm_term, provenance)
      select e.new_id, ${ctx.tenantId}, ${ctx.brandId}, ${ctx.connectedAccountId}, e.external_id, e.kind, e.occurred_at,
             e.order_external_id, r.id, e.provider, e.link_code, e.campaign_external_id, e.ad_group_external_id, e.ad_external_id,
             e.gclid, e.gbraid, e.wbraid, e.fbclid, e.ctwa_clid, e.utm_source, e.utm_medium, e.utm_campaign, e.utm_content,
             e.utm_term, e.provenance
        from e
        left join liame.customer_ref r on r.tenant_id = ${ctx.tenantId} and r.phone_index = e.phone_index
      on conflict (connected_account_id, external_id) do update
         set kind = excluded.kind, occurred_at = excluded.occurred_at, order_external_id = excluded.order_external_id,
             customer_ref_id = excluded.customer_ref_id, provider = excluded.provider, link_code = excluded.link_code,
             campaign_external_id = excluded.campaign_external_id, ad_group_external_id = excluded.ad_group_external_id,
             ad_external_id = excluded.ad_external_id, gclid = excluded.gclid, gbraid = excluded.gbraid,
             wbraid = excluded.wbraid, fbclid = excluded.fbclid, ctwa_clid = excluded.ctwa_clid,
             utm_source = excluded.utm_source, utm_medium = excluded.utm_medium, utm_campaign = excluded.utm_campaign,
             utm_content = excluded.utm_content, utm_term = excluded.utm_term, provenance = excluded.provenance
       where (liame.touchpoint.kind, liame.touchpoint.occurred_at, liame.touchpoint.order_external_id, liame.touchpoint.customer_ref_id,
              liame.touchpoint.provider, liame.touchpoint.link_code, liame.touchpoint.campaign_external_id,
              liame.touchpoint.ad_group_external_id, liame.touchpoint.ad_external_id, liame.touchpoint.gclid, liame.touchpoint.gbraid,
              liame.touchpoint.wbraid, liame.touchpoint.fbclid, liame.touchpoint.ctwa_clid, liame.touchpoint.utm_source,
              liame.touchpoint.utm_medium, liame.touchpoint.utm_campaign, liame.touchpoint.utm_content, liame.touchpoint.utm_term)
             is distinct from
             (excluded.kind, excluded.occurred_at, excluded.order_external_id, excluded.customer_ref_id, excluded.provider,
              excluded.link_code, excluded.campaign_external_id, excluded.ad_group_external_id, excluded.ad_external_id,
              excluded.gclid, excluded.gbraid, excluded.wbraid, excluded.fbclid, excluded.ctwa_clid, excluded.utm_source,
              excluded.utm_medium, excluded.utm_campaign, excluded.utm_content, excluded.utm_term)
      returning id, (xmax = 0) as novo`);
    novos += r.rows.filter((x) => x.novo).length;
    alterados.push(...r.rows.map((x) => x.id));
  }
  return { novos, alterados };
}

/**
 * O `gclid` resolvido pela API do Google (`click_view`, um dia por consulta, até 90 dias) completa o
 * clique com a campanha, o grupo e o anúncio. A proveniência passa a dizer `google_ads` nesses campos: o
 * que veio da API do Google nunca segue para outra plataforma de anúncio (Uso Limitado, ADR-019 item 9).
 */
export async function completarCliqueGoogle(
  tx: Tx,
  resolvidos: { touchpointId: string; campaignExternalId: string; adGroupExternalId: string | null; adExternalId: string | null }[],
): Promise<number> {
  if (!resolvidos.length) return 0;
  const r = await tx.execute<{ id: string }>(sql`
    with e as (
      select * from jsonb_to_recordset(${JSON.stringify(
        resolvidos.map((x) => ({ id: x.touchpointId, c: x.campaignExternalId, g: x.adGroupExternalId, a: x.adExternalId })),
      )}::jsonb) as e(id uuid, c text, g text, a text)
    )
    update liame.touchpoint t
       set campaign_external_id = e.c, ad_group_external_id = coalesce(e.g, t.ad_group_external_id),
           ad_external_id = coalesce(e.a, t.ad_external_id), provider = coalesce(t.provider, 'google_ads'),
           provenance = t.provenance || jsonb_strip_nulls(jsonb_build_object(
             'campaign_external_id', 'google_ads',
             'ad_group_external_id', case when e.g is not null then 'google_ads' end,
             'ad_external_id', case when e.a is not null then 'google_ads' end))
      from e
     where t.id = e.id and t.kind = 'clique' and t.gclid is not null and t.campaign_external_id is null
    returning t.id`);
  return r.rows.length;
}
