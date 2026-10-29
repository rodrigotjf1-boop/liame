import type { Tx } from '@liame/database';
import { sql } from 'drizzle-orm';
import { contaConectada } from '../connections/conectada.js';
import { FLAG_DOS_POSTS } from '../connectors/meta/publicacao.js';
import { type CanalDoPost, CANAIS_DO_POST, type EstadoDoPost, horaLocal, postDoRecurso, PROVEDOR_DO_CANAL, type SituacaoDoCanal } from '../posts/post-plano.js';
import type { ApplyResult, Connector, ReadResult, ResourceRef } from './connectors.js';
import type { ResourceState } from './tools.js';

// O post da marca pelo Action Service (A6, Z5b; `plano-a6.md` D-A6-3, D-A6-7 e D-A6-8): publicar o post que uma pessoa
// aprovou com o código do app, na hora marcada. Só com a flag de escrita `social_write` ligada, que nasce desligada: sem
// ela, nenhum pedido passa do trilho.
//
// O recurso é o post: `resource_id` = `post:<id do post no Liame>`; `account_id` é a conta do primeiro canal (o Instagram,
// quando ele está no post; senão, a Página), e o provedor do pedido é o dela (`instagram` ou `facebook_page`): a trava
// por conta vale para ela (decisão técnica D-A6-32).
//
// - O estado é o post como o Liame o guarda: a foto pelo resumo do arquivo (o que sai é o aprovado, A6-10), o recorte, a
//   hora (com a hora no fuso da empresa, que o plano confere com a janela das 8h às 22h) e cada canal com a conta, o texto
//   e a situação. A conta desligada da marca, ou de outra marca, vira nula: o plano recusa.
// - A versão é a do post (`social_post.version`), que sobe a cada mudança: o trilho confere antes de escrever.
// - A publicação nas redes (o contêiner do Instagram, a foto na Página) é a parte seguinte da Z5: por ora, a execução
//   recusa sem chamar rede nenhuma, e nada sai.

const NADA_SAI = 'A publicação nas redes ainda não está pronta nesta versão do Liame: o post não saiu.';

type LinhaDoPost = {
  id: string;
  brand_id: string;
  photo_id: string | null;
  photo_sha256: string;
  foto_pronta: boolean | null;
  crop_pos: number | null;
  publish_at: Date;
  version: number;
  fuso: string | null;
};
type LinhaDoCanal = { channel: string; conta: string | null; body: string; status: string };

const ehCanal = (c: string): c is CanalDoPost => (CANAIS_DO_POST as readonly string[]).includes(c);

/** O estado do post como o trilho o vê; nulo quando o post não é desta empresa (ou o recurso não é um post). */
export async function lerEstadoDoPost(tx: Tx, tenantId: string, resourceId: string): Promise<{ estado: EstadoDoPost; versao: number; marca: string } | null> {
  const id = postDoRecurso(resourceId);
  if (!id) return null;
  const p = await tx.execute<LinhaDoPost>(sql`
    select p.id, p.brand_id, p.photo_id, p.photo_sha256, (f.status = 'pronta' and f.removed_at is null and f.sha256 = p.photo_sha256) as foto_pronta,
           p.crop_pos, p.publish_at, p.version, o.timezone as fuso
      from liame.social_post p
      join liame.organization o on o.id = p.tenant_id
      left join liame.brand_photo f on f.id = p.photo_id
     where p.id = ${id} and p.tenant_id = ${tenantId}`);
  const post = p.rows[0];
  if (!post) return null;
  // A conta só vale se ainda está conectada (ligada e sem a recusa da plataforma: é o que vale para agir) à marca do
  // post, com o provedor do canal (a Página, o Instagram).
  const c = await tx.execute<LinhaDoCanal>(sql`
    select ch.channel, a.id as conta, ch.body, ch.status
      from liame.social_post_channel ch
      left join liame.connected_account a
        on a.id = ch.connected_account_id and ${contaConectada('a')} and a.brand_id = ${post.brand_id}
       and a.provider = case ch.channel when 'instagram' then ${PROVEDOR_DO_CANAL.instagram} else ${PROVEDOR_DO_CANAL.facebook} end
     where ch.post_id = ${id} and ch.tenant_id = ${tenantId}
     order by case ch.channel when 'instagram' then 0 else 1 end`);
  const fuso = post.fuso ?? 'America/Sao_Paulo';
  const hora = new Date(post.publish_at);
  const estado: EstadoDoPost = {
    post: post.id,
    foto: post.photo_id && post.foto_pronta ? { id: post.photo_id, sha256: post.photo_sha256 } : null,
    recorte: post.crop_pos,
    hora: hora.toISOString(),
    hora_local: horaLocal(hora, fuso),
    canais: c.rows.filter((l) => ehCanal(l.channel)).map((l) => ({ canal: l.channel as CanalDoPost, conta: l.conta, texto: l.body, situacao: l.status as SituacaoDoCanal })),
  };
  return { estado, versao: post.version, marca: post.brand_id };
}

export class PostPublicacaoConnector implements Connector {
  // O mesmo conector responde pelos dois provedores do post (o da conta do primeiro canal); ver o registro.
  constructor(readonly provider: string) {}
  readonly writeFlag = FLAG_DOS_POSTS;
  // Publicar um post não gasta verba de mídia.
  readonly requiresSpendLimits = false;

  async read(tx: Tx, ref: ResourceRef): Promise<ReadResult | null> {
    const lido = await lerEstadoDoPost(tx, ref.tenantId, ref.resourceId);
    if (!lido) return null;
    // A conta do pedido tem de ser a de um canal do post: o pedido de outra conta não é deste post.
    if (!lido.estado.canais.some((c) => c.conta === ref.accountId)) return null;
    return { state: lido.estado as unknown as ResourceState, version: lido.versao };
  }

  async apply(_tx: Tx, _ref: ResourceRef, _desired: ResourceState, _expectedVersion: number): Promise<ApplyResult> {
    return { ok: false, reason: 'recusado', mensagem: NADA_SAI };
  }
}

/** Um para cada provedor do pedido do post: o do Instagram e o da Página (a conta do primeiro canal). */
export const postNoInstagramConnector = new PostPublicacaoConnector(PROVEDOR_DO_CANAL.instagram);
export const postNaPaginaConnector = new PostPublicacaoConnector(PROVEDOR_DO_CANAL.facebook);
