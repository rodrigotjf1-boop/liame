import type { CampaignTopAd } from '@liame/contracts';
import type { Tx } from '@liame/database';
import { sql } from 'drizzle-orm';
import type { ArmazemDeImagens } from '../imagens/armazem.js';
import { GRUPO_DA_CAMPANHA, ORDEM_DO_GRUPO_DE_RECURSOS } from '../media/miniaturas.js';

// O anúncio que mais gastou em cada campanha no período (A3 · I14, parte 1; P44 aprovado em 11/11/2026; D-A3-29 a
// D-A3-33): a imagem para reconhecer a campanha em Resultados. A imagem é a cópia que o Liame guarda (a miniatura do
// criativo, copiada depois da sincronização); o endereço vale poucos minutos. Sem imagem: o anúncio de texto do Google,
// o anúncio reprovado ou removido na plataforma (D-A3-32), e a imagem que ainda não foi copiada.

/** O endereço de leitura da cópia vale 5 minutos (o bucket recusa mais de 10; ADR-021). */
const SEGUNDOS_DA_IMAGEM = 300;
/** As situações do anúncio que tiram a imagem (a Meta: `effective_status`; o Google: o anúncio removido). */
const FORA_DO_AR = new Set(['DISAPPROVED', 'DELETED', 'ARCHIVED', 'REMOVED']);

type Linha = {
  campaign_id: string;
  name: string;
  ad_externo: string;
  provider: string;
  provider_status: string | null;
  kind: string | null;
  thumbnail_key: string | null;
  thumbnail_width: number | null;
  thumbnail_height: number | null;
  conta_externa: string;
};

/** O tipo do anúncio pelo que a plataforma diz do criativo. */
export function tipoDoAnuncio(provider: string, kind: string | null): CampaignTopAd['kind'] {
  const k = (kind ?? '').toUpperCase();
  if (provider === 'google_ads') return k.includes('SEARCH') || k.includes('TEXT') ? 'texto' : 'imagem';
  return k === 'VIDEO' ? 'video' : 'imagem';
}

/** O anúncio no Gerenciador de Anúncios da Meta (a conta sem o prefixo `act_`); nulo fora da Meta. */
export function linkDoAnuncio(provider: string, contaExterna: string, anuncio: string): string | null {
  if (provider !== 'meta_ads') return null;
  const conta = contaExterna.replace(/^act_/, '');
  return `https://adsmanager.facebook.com/adsmanager/manage/ads?act=${encodeURIComponent(conta)}&selected_ad_ids=${encodeURIComponent(anuncio)}`;
}

/** O anúncio que mais gastou em cada campanha, de `de` a `ate`, na marca (a RLS da transação separa a empresa). */
export async function anunciosQueMaisGastaram(
  tx: Tx,
  armazem: ArmazemDeImagens | null,
  brandId: string,
  de: string,
  ate: string,
  campanhas: string[],
): Promise<Map<string, CampaignTopAd>> {
  const saida = new Map<string, CampaignTopAd>();
  if (!campanhas.length) return saida;
  const r = await tx.execute<Linha>(sql`
    with gasto as (
      select g.campaign_id, a.id as ad_id, sum(m.metric_value) as gasto
        from liame.metric_latest m
        join liame.ad a on a.connected_account_id = m.connected_account_id and a.external_id = m.external_entity_id
        join liame.ad_group g on g.id = a.ad_group_id
       where m.brand_id = ${brandId} and m.level = 'ad' and m.metric_name = 'spend'
         and m.metric_date between ${de}::date and ${ate}::date and g.campaign_id in ${campanhas}
       group by g.campaign_id, a.id
    )
    select distinct on (x.campaign_id) x.campaign_id, a.name, a.external_id as ad_externo, a.provider, a.provider_status,
           c.kind, c.thumbnail_key, c.thumbnail_width, c.thumbnail_height, ca.external_id as conta_externa
      from gasto x
      join liame.ad a on a.id = x.ad_id
      left join liame.creative c on c.id = a.creative_id
      join liame.connected_account ca on ca.id = a.connected_account_id
     where x.gasto > 0
     order by x.campaign_id, x.gasto desc, a.id`);
  const imagemDe = async (l: Pick<Linha, 'thumbnail_key' | 'thumbnail_width' | 'thumbnail_height'>): Promise<CampaignTopAd['image']> => {
    if (!l.thumbnail_key || !l.thumbnail_width || !l.thumbnail_height || !armazem?.disponivel) return null;
    try {
      return { url: await armazem.enderecoDeLeitura(l.thumbnail_key, SEGUNDOS_DA_IMAGEM), width: l.thumbnail_width, height: l.thumbnail_height };
    } catch {
      // Sem o endereço agora: o cartão mostra o quadro neutro, e os números seguem.
      return null;
    }
  };
  for (const l of r.rows) {
    const kind = tipoDoAnuncio(l.provider, l.kind);
    const offAir = FORA_DO_AR.has((l.provider_status ?? '').toUpperCase());
    const image = !offAir && kind !== 'texto' ? await imagemDe(l) : null;
    saida.set(l.campaign_id, { name: l.name, kind, off_air: offAir, image, manager_url: linkDoAnuncio(l.provider, l.conta_externa, l.ad_externo) });
  }

  // A Performance Max do Google (I14, parte 3) não tem anúncio com gasto: a imagem é a do grupo de recursos que mais
  // gastou em 30 dias (a mesma escolha da cópia). O grupo removido aparece "fora do ar", sem a imagem (D-A3-32).
  const semAnuncio = campanhas.filter((id) => !saida.has(id));
  if (!semAnuncio.length) return saida;
  const g = await tx.execute<{ campaign_id: string; name: string | null; situacao: string | null; thumbnail_key: string | null; thumbnail_width: number | null; thumbnail_height: number | null }>(sql`
    select distinct on (cp.id) cp.id as campaign_id, c.name, c.provider_attributes->>'situacao' as situacao, c.thumbnail_key, c.thumbnail_width, c.thumbnail_height
      from liame.campaign cp
      join liame.creative c on ${GRUPO_DA_CAMPANHA}
     where cp.id in ${semAnuncio}
     order by cp.id, ${ORDEM_DO_GRUPO_DE_RECURSOS}`);
  for (const l of g.rows) {
    const offAir = FORA_DO_AR.has((l.situacao ?? '').toUpperCase());
    saida.set(l.campaign_id, { name: l.name ?? 'Grupo de recursos', kind: 'imagem', off_air: offAir, image: offAir ? null : await imagemDe(l), manager_url: null });
  }
  return saida;
}
