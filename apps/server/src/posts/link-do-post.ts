import { type Tx, uuidv7 } from '@liame/database';
import { sql } from 'drizzle-orm';
import { contaConectada } from '../connections/conectada.js';
import { cardapioValido, codigoDoPost, linkComRastreio, TAMANHO_CODIGO } from '../links/construtor.js';

// O link do post (A6, Z7, parte a; D-A6-16 e as decisões técnicas D-A6-46 a D-A6-48): um link com rastreio do contrato
// que já existe (`tracking_link`), marcado como de post e preso a ele, com o código só dele. O destino é o cardápio do
// Regem da loja da marca, quando ela tem uma loja só com o cardápio ligado. Na Página, o link vai no fim do texto, já
// na criação (D-A6-47); no pacote, é o link da bio. O motor de atribuição não conta o clique nele como anúncio (D-A6-48).

/** Por que o post nasce sem link: nenhuma loja da marca com o cardápio ligado, ou mais de uma (a escolha não existe). */
export type SemLinkDoPost = 'sem_cardapio' | 'varias_lojas';

export type DestinoDoPost = { ok: true; unitId: string; url: string } | { ok: false; motivo: SemLinkDoPost };

/** A origem e o meio do link do post em cada rede (o `utm_source`; o meio é sempre `social`). */
const ORIGEM_DO_LINK: Record<string, string> = { facebook: 'facebook', tiktok: 'tiktok', youtube: 'youtube' };
export const MEIO_DO_LINK_DO_POST = 'social';
export const CAMPANHA_DO_LINK_DO_POST = 'post';

/** As redes em que o post leva o link: a Página (no fim do texto) e os pacotes (a bio). O Instagram não (D-A6-22). */
export const CANAIS_COM_LINK: readonly string[] = Object.keys(ORIGEM_DO_LINK);

/** Quantas vezes tentar um código novo, na colisão rara com o de outro link (como nos links de campanha). */
const TENTATIVAS = 4;

/**
 * O cardápio da loja da marca para o link do post: o das contas do Regem ligadas a uma loja, com o cardápio válido,
 * como na criação dos links de campanha. Uma loja só: o cardápio dela (o da conexão mais recente). Nenhuma, ou mais de
 * uma: o porquê.
 */
export async function destinoDoPost(tx: Tx, tenantId: string, brandId: string): Promise<DestinoDoPost> {
  const r = await tx.execute<{ unit_id: string; url: string | null }>(sql`
    select a.unit_id, a.provider_attributes->>'cardapio_url' as url from liame.connected_account a
     where a.tenant_id = ${tenantId} and a.brand_id = ${brandId} and a.provider = 'regem' and a.unit_id is not null and ${contaConectada('a')}
     order by a.connected_at desc, a.id`);
  const usaveis = r.rows.filter((l) => cardapioValido(l.url) !== null);
  const lojas = [...new Set(usaveis.map((l) => l.unit_id))];
  if (lojas.length === 0) return { ok: false, motivo: 'sem_cardapio' };
  if (lojas.length > 1) return { ok: false, motivo: 'varias_lojas' };
  return { ok: true, unitId: lojas[0]!, url: cardapioValido(usaveis[0]!.url)!.toString() };
}

/** O link com rastreio do post, montado do destino, da rede e do código (o mesmo que a Agenda mostra). */
export function enderecoDoLinkDoPost(destino: string, canal: string, codigo: string): string {
  return linkComRastreio(destino, { utmSource: ORIGEM_DO_LINK[canal] ?? canal, utmMedium: MEIO_DO_LINK_DO_POST, utmCampaign: CAMPANHA_DO_LINK_DO_POST, codigo });
}

/** Quantos caracteres o link do post ocupa no texto (o código tem sempre o mesmo tamanho), com a linha em branco antes. */
export function tamanhoNoTexto(destino: string, canal: string): number {
  return SEPARADOR.length + enderecoDoLinkDoPost(destino, canal, '0'.repeat(TAMANHO_CODIGO)).length;
}

/** O que vem antes do link, no fim do texto da Página: uma linha em branco. */
export const SEPARADOR = '\n\n';

/**
 * Cria o link do post (na transação do post), com o código só dele, e devolve o endereço. O índice único do código
 * por empresa e o do post (migration 0091) garantem um link só; a colisão rara de código tenta o seguinte.
 */
export async function criarLinkDoPost(
  tx: Tx,
  p: { tenantId: string; brandId: string; postId: string; canal: string; destino: { unitId: string; url: string }; nome: string; userId: string },
): Promise<string> {
  for (let tentativa = 0; tentativa < TENTATIVAS; tentativa++) {
    const codigo = codigoDoPost(p.tenantId, p.postId, tentativa);
    const novo = await tx.execute<{ id: string }>(sql`
      insert into liame.tracking_link (id, tenant_id, brand_id, unit_id, code, name, provider, kind, post_id,
                                       destination_url, utm_source, utm_medium, utm_campaign, created_by)
      values (${uuidv7()}, ${p.tenantId}, ${p.brandId}, ${p.destino.unitId}, ${codigo}, ${p.nome.slice(0, 200)}, ${ORIGEM_DO_LINK[p.canal] ?? p.canal}, 'post', ${p.postId},
              ${p.destino.url}, ${ORIGEM_DO_LINK[p.canal] ?? p.canal}, ${MEIO_DO_LINK_DO_POST}, ${CAMPANHA_DO_LINK_DO_POST}, ${p.userId})
      on conflict (tenant_id, code) do nothing
      returning id`);
    if (novo.rows[0]) return enderecoDoLinkDoPost(p.destino.url, p.canal, codigo);
  }
  throw new Error('link do post: o código colidiu em todas as tentativas');
}
