import type { PostResponse } from '@liame/contracts';
import type { Tx } from '@liame/database';
import { type SQL, sql } from 'drizzle-orm';
import { linkComRastreio } from '../links/construtor.js';
import { situacaoDoPacote, situacaoDoPost } from './post-plano.js';

// A leitura dos posts como as telas os veem (a Agenda e o pedido em Aprovações, A6, Z5c): o post, os canais com a conta
// e a situação de cada um, e a situação do post pelo pedido. Fica à parte do serviço dos posts porque o serviço das
// ações também a usa (o serviço dos posts depende dele: a leitura não pode depender de volta).

type LinhaDoPost = {
  id: string;
  brand_id: string;
  kind: string;
  photo_id: string | null;
  crop_pos: number | null;
  publish_at: Date;
  action_id: string | null;
  created_at: Date;
  pedido_status: string | null;
  pedido_motivo: string | null;
  link_destino: string | null;
  link_origem: string | null;
  link_meio: string | null;
  link_campanha: string | null;
  link_codigo: string | null;
};
type LinhaDoCanal = {
  post_id: string;
  channel: string;
  connected_account_id: string | null;
  account_name: string | null;
  body: string;
  status: string;
  permalink: string | null;
  error: string | null;
  published_at: Date | null;
};

const iso = (d: Date | string) => new Date(d).toISOString();
const isoOuNulo = (d: Date | string | null) => (d ? iso(d) : null);

/** O fuso da empresa (o da Agenda e o da janela das 8h às 22h); São Paulo quando ela não tem um. */
export async function fusoDaEmpresa(tx: Tx, tenantId: string): Promise<string> {
  const r = await tx.execute<{ timezone: string | null }>(sql`select timezone from liame.organization where id = ${tenantId}`);
  return r.rows[0]?.timezone ?? 'America/Sao_Paulo';
}

/**
 * Os posts da empresa que casam com o filtro (sobre `liame.social_post p`), com os canais, numa consulta para os posts e
 * uma para os canais. `prefixoDaRecusa`: o começo do motivo do pedido recusado (do serviço das ações), que separa
 * "recusado" de "cancelado".
 */
export async function lerPosts(tx: Tx, tenantId: string, filtro: SQL, prefixoDaRecusa: string): Promise<PostResponse[]> {
  const p = await tx.execute<LinhaDoPost>(sql`
    select p.id, p.brand_id, p.kind, p.photo_id, p.crop_pos, p.publish_at, p.action_id, p.created_at, r.status as pedido_status, r.status_reason as pedido_motivo,
           tl.destination_url as link_destino, tl.utm_source as link_origem, tl.utm_medium as link_meio, tl.utm_campaign as link_campanha, tl.code as link_codigo
      from liame.social_post p
      left join liame.action_request r on r.id = p.action_id and r.tenant_id = p.tenant_id
      left join liame.tracking_link tl on tl.post_id = p.id and tl.tenant_id = p.tenant_id and tl.kind = 'post'
     where p.tenant_id = ${tenantId} and ${filtro}
     order by p.publish_at, p.id
     limit 500`);
  if (p.rows.length === 0) return [];
  const c = await tx.execute<LinhaDoCanal>(sql`
    select ch.post_id, ch.channel, ch.connected_account_id, a.name as account_name, ch.body, ch.status, ch.permalink, ch.error, ch.published_at
      from liame.social_post_channel ch
      left join liame.connected_account a on a.id = ch.connected_account_id
     where ch.tenant_id = ${tenantId} and ch.post_id in ${p.rows.map((x) => x.id)}
     order by ch.post_id, case ch.channel when 'instagram' then 0 else 1 end`);
  const canaisDo = new Map<string, LinhaDoCanal[]>();
  for (const l of c.rows) canaisDo.set(l.post_id, [...(canaisDo.get(l.post_id) ?? []), l]);
  return p.rows.map((l): PostResponse => {
    const canais = canaisDo.get(l.id) ?? [];
    const situacoes = canais.map((x) => x.status);
    return {
      id: l.id,
      brand_id: l.brand_id,
      kind: l.kind,
      photo_id: l.photo_id,
      crop_pos: l.crop_pos,
      publish_at: iso(l.publish_at),
      action_id: l.action_id,
      // O pacote não tem pedido: a situação é a dos canais dele (A6, Z8).
      status:
        l.kind === 'pacote'
          ? situacaoDoPacote(situacoes)
          : situacaoDoPost(l.pedido_status ? { status: l.pedido_status, status_reason: l.pedido_motivo } : null, situacoes, prefixoDaRecusa),
      created_at: iso(l.created_at),
      channels: canais.map((x) => ({
        channel: x.channel,
        account_id: x.connected_account_id,
        account_name: x.account_name,
        text: x.body,
        status: x.status,
        permalink: x.permalink,
        error: x.error,
        published_at: isoOuNulo(x.published_at),
      })),
      // O link do post (A6, Z7; D-A6-46), montado como na criação (o mesmo endereço que está no fim do texto da Página).
      link:
        l.link_destino && l.link_origem && l.link_meio && l.link_codigo
          ? linkComRastreio(l.link_destino, { utmSource: l.link_origem, utmMedium: l.link_meio, utmCampaign: l.link_campanha, codigo: l.link_codigo })
          : null,
    };
  });
}
