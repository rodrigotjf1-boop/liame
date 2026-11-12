import { type Db, withTenant } from '@liame/database';
import { Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type SharpDoPacote from 'sharp';
import { prefixoDaMarca } from '../fotos/conferencia.js';
import { carregarSharp } from '../fotos/processar.js';
import type { ArmazemDeImagens } from '../imagens/armazem.js';

// A cópia da miniatura do anúncio (A3 · I14, parte 1; P44 aprovado em 11/11/2026; D-A3-29 e D-A3-30). Em Resultados,
// cada campanha mostra a imagem do anúncio que mais gastou no período. O endereço que a Meta entrega expira: depois de
// cada sincronização da conta, o Liame copia para o armazenamento de imagens a miniatura do criativo que mais gastou em
// cada campanha (nos últimos 7 e 30 dias), só quando ainda não copiou ou quando a imagem mudou (o endereço sem a
// assinatura). Só baixa dos domínios da Meta, sem seguir redirecionamento, com teto de tamanho e de tempo.

type Sharp = typeof SharpDoPacote;
const logger = new Logger('miniaturas');

/** Os domínios de onde a Meta serve as imagens dos criativos. */
const DOMINIOS_DA_META = ['fbcdn.net', 'facebook.com', 'cdninstagram.com'];
/** O arquivo baixado: até 2 MB. */
export const LIMITE_DA_MINIATURA = 2 * 1024 * 1024;
/** A cópia guardada cabe em 480 × 480 (o cartão mostra até 120 px, em tela de alta densidade). */
const LADO = 480;
/** Quantas cópias por sincronização da conta, no máximo (o resto vai na seguinte). */
export const COPIAS_POR_VEZ = 30;

/** O endereço vale para baixar: HTTPS, num domínio da Meta. Nulo quando não vale. */
export function enderecoDaMeta(url: string | null | undefined): URL | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return null;
    const host = u.hostname.toLowerCase();
    return DOMINIOS_DA_META.some((d) => host === d || host.endsWith(`.${d}`)) ? u : null;
  } catch {
    return null;
  }
}

/** De onde veio a imagem: o endereço sem a assinatura (a Meta muda a assinatura a cada leitura, a imagem não). */
export function origemDaMiniatura(url: URL): string {
  return `${url.origin}${url.pathname}`;
}

/** A chave da cópia no armazenamento, no prefixo da marca (sai junto quando a marca ou a empresa é apagada). */
export function chaveDaMiniatura(tenantId: string, brandId: string, creativeId: string): string {
  return `${prefixoDaMarca(tenantId, brandId)}anuncio/${creativeId}.jpg`;
}

/** Baixa a miniatura (só da Meta, sem seguir redirecionamento, com teto de tamanho e de tempo). */
export async function baixarMiniatura(url: URL, buscar: typeof fetch = fetch, tempoMs = 15_000): Promise<Buffer> {
  if (!enderecoDaMeta(url.toString())) throw new Error('endereço fora da Meta');
  const r = await buscar(url, { redirect: 'error', signal: AbortSignal.timeout(tempoMs), headers: { 'user-agent': 'Liame/1.0 (+https://agencialiame.com)' } });
  if (!r.ok) throw new Error(`a Meta respondeu ${r.status}`);
  if (!(r.headers.get('content-type') ?? '').startsWith('image/')) throw new Error('a resposta não é uma imagem');
  if (Number(r.headers.get('content-length') ?? '0') > LIMITE_DA_MINIATURA) throw new Error('miniatura maior que o esperado');
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length === 0 || buf.length > LIMITE_DA_MINIATURA) throw new Error('miniatura vazia ou maior que o esperado');
  return buf;
}

/** Regrava a miniatura em JPEG, sobre fundo branco, cabendo em 480 × 480, sem os metadados. */
export async function regravarMiniatura(entrada: Buffer, carregar: () => Promise<Sharp> = carregarSharp): Promise<{ bytes: Buffer; largura: number; altura: number }> {
  const sharp = await carregar();
  const r = await sharp(entrada, { failOn: 'error', limitInputPixels: 4000 * 4000 })
    .rotate()
    .resize({ width: LADO, height: LADO, fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#ffffff' })
    .jpeg({ quality: 82, mozjpeg: true })
    .toBuffer({ resolveWithObject: true });
  return { bytes: r.data, largura: r.info.width, altura: r.info.height };
}

type Candidata = { id: string; brand_id: string; thumbnail_url: string; thumbnail_source: string | null };

/**
 * Copia as miniaturas que faltam da conta: o criativo que mais gastou em cada campanha nos últimos 7 e 30 dias, na
 * Meta, cuja imagem ainda não foi copiada ou mudou. Nunca derruba a sincronização: o que falha fica para a seguinte.
 */
export async function copiarMiniaturas(opcoes: {
  db: Db;
  armazem: ArmazemDeImagens;
  contaId: string;
  tenantId: string;
  agora?: Date;
  buscar?: typeof fetch;
  carregar?: () => Promise<Sharp>;
}): Promise<{ copiadas: number; falhas: number }> {
  const { db, armazem, contaId, tenantId, agora = new Date(), buscar = fetch, carregar = carregarSharp } = opcoes;
  if (!armazem.disponivel) return { copiadas: 0, falhas: 0 };
  const dia = agora.toISOString().slice(0, 10);
  const candidatas = await withTenant(db, tenantId, async (tx) => {
    const r = await tx.execute<Candidata>(sql`
      with gasto as (
        select a.creative_id, g.campaign_id,
               sum(m.metric_value) filter (where m.metric_date >= ${dia}::date - 7) as g7,
               sum(m.metric_value) as g30
          from liame.metric_latest m
          join liame.ad a on a.connected_account_id = m.connected_account_id and a.external_id = m.external_entity_id
          join liame.ad_group g on g.id = a.ad_group_id
         where m.connected_account_id = ${contaId} and m.level = 'ad' and m.metric_name = 'spend'
           and m.metric_date >= ${dia}::date - 30 and a.creative_id is not null and g.campaign_id is not null
         group by a.creative_id, g.campaign_id
      ),
      escolhidos as (
        (select distinct on (campaign_id) creative_id from gasto where g30 > 0 order by campaign_id, g30 desc, creative_id)
        union
        (select distinct on (campaign_id) creative_id from gasto where g7 > 0 order by campaign_id, g7 desc, creative_id)
      )
      select c.id, ca.brand_id, c.thumbnail_url, c.thumbnail_source
        from escolhidos e
        join liame.creative c on c.id = e.creative_id
        join liame.connected_account ca on ca.id = c.connected_account_id
       where c.provider = 'meta_ads' and c.thumbnail_url is not null
       order by c.id`);
    return r.rows;
  });

  let copiadas = 0;
  let falhas = 0;
  for (const c of candidatas) {
    if (copiadas + falhas >= COPIAS_POR_VEZ) break;
    const url = enderecoDaMeta(c.thumbnail_url);
    if (!url) continue;
    const origem = origemDaMiniatura(url);
    if (c.thumbnail_source === origem) continue;
    try {
      const imagem = await regravarMiniatura(await baixarMiniatura(url, buscar), carregar);
      const chave = chaveDaMiniatura(tenantId, c.brand_id, c.id);
      await armazem.gravar(chave, imagem.bytes);
      await withTenant(db, tenantId, (tx) =>
        tx.execute(sql`
          update liame.creative
             set thumbnail_key = ${chave}, thumbnail_source = ${origem}, thumbnail_width = ${imagem.largura}, thumbnail_height = ${imagem.altura},
                 thumbnail_copied_at = now()
           where id = ${c.id}`),
      );
      copiadas++;
    } catch (err) {
      falhas++;
      logger.warn(`criativo ${c.id}: a miniatura não foi copiada (${err instanceof Error ? err.message : String(err)}); fica para a próxima sincronização`);
    }
  }
  return { copiadas, falhas };
}
