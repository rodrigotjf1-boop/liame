import type { PostMetrics, PostResponse } from '@liame/contracts';
import type { Tx } from '@liame/database';
import { type SQL, sql } from 'drizzle-orm';
import { pedeUmPostNovo } from '../actions/post-publicacao.js';
import { linkComRastreio } from '../links/construtor.js';
import { novaTentativa, situacaoDoPacote, situacaoDoPost } from './post-plano.js';

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
  metrics: Record<string, unknown> | null;
  metrics_status: string | null;
  metrics_read_at: Date | null;
};

const iso = (d: Date | string) => new Date(d).toISOString();
const isoOuNulo = (d: Date | string | null) => (d ? iso(d) : null);

/** Um número guardado: inteiro não negativo, ou nulo (o que veio fora do formato não passa para a tela). */
const numeroGuardado = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null);

/** Os números do canal como o contrato os mostra (A6, Z7, parte c); nulo antes da primeira leitura. */
function numerosDoCanal(m: Record<string, unknown> | null): PostMetrics | null {
  if (!m) return null;
  return {
    views: numeroGuardado(m.views),
    reach: numeroGuardado(m.reach),
    likes: numeroGuardado(m.likes),
    comments: numeroGuardado(m.comments),
    shares: numeroGuardado(m.shares),
    saves: numeroGuardado(m.saves),
    clicks: numeroGuardado(m.clicks),
    reactions: numeroGuardado(m.reactions),
  };
}

/** O fuso da empresa (o da Agenda e o da janela das 8h às 22h); São Paulo quando ela não tem um. */
export async function fusoDaEmpresa(tx: Tx, tenantId: string): Promise<string> {
  const r = await tx.execute<{ timezone: string | null }>(sql`select timezone from liame.organization where id = ${tenantId}`);
  return r.rows[0]?.timezone ?? 'America/Sao_Paulo';
}

/**
 * Os posts da empresa que casam com o filtro (sobre `liame.social_post p`), com os canais, numa consulta para os posts e
 * uma para os canais. `prefixoDaRecusa`: o começo do motivo do pedido recusado (do serviço das ações), que separa
 * "recusado" de "cancelado". `agora`: a hora em que se lê (até quando dá para "Tentar de novo" num canal, A6, Z5d).
 */
export async function lerPosts(tx: Tx, tenantId: string, filtro: SQL, prefixoDaRecusa: string, agora: Date = new Date()): Promise<PostResponse[]> {
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
    select ch.post_id, ch.channel, ch.connected_account_id, a.name as account_name, ch.body, ch.status, ch.permalink, ch.error, ch.published_at,
           ch.metrics, ch.metrics_status, ch.metrics_read_at
      from liame.social_post_channel ch
      left join liame.connected_account a on a.id = ch.connected_account_id
     where ch.tenant_id = ${tenantId} and ch.post_id in ${p.rows.map((x) => x.id)}
     order by ch.post_id, case ch.channel when 'instagram' then 0 else 1 end`);
  const canaisDo = new Map<string, LinhaDoCanal[]>();
  for (const l of c.rows) canaisDo.set(l.post_id, [...(canaisDo.get(l.post_id) ?? []), l]);
  return p.rows.map((l): PostResponse => {
    const canais = canaisDo.get(l.id) ?? [];
    const situacoes = canais.map((x) => x.status);
    // "Tentar de novo" (A6, Z5d; D-A6-54): em qual canal, e até quando; o pacote não tem.
    const tentativa =
      l.kind === 'post'
        ? novaTentativa(
            l.pedido_status,
            canais.map((x) => ({ canal: x.channel, situacao: x.status, publicadoEm: x.published_at ? new Date(x.published_at) : null, pedePostNovo: pedeUmPostNovo(x.error) })),
            agora,
          )
        : null;
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
        metrics: numerosDoCanal(x.metrics),
        metrics_status: x.metrics_status,
        metrics_read_at: isoOuNulo(x.metrics_read_at),
        retry_until: tentativa?.ok && tentativa.canal === x.channel ? tentativa.ate.toISOString() : null,
      })),
      // O link do post (A6, Z7; D-A6-46), montado como na criação (o mesmo endereço que está no fim do texto da Página).
      link:
        l.link_destino && l.link_origem && l.link_meio && l.link_codigo
          ? linkComRastreio(l.link_destino, { utmSource: l.link_origem, utmMedium: l.link_meio, utmCampaign: l.link_campanha, codigo: l.link_codigo })
          : null,
    };
  });
}
