// A imagem da Performance Max (A3 · I14, parte 3; P44 aprovado em 11/11/2026; D-A3-29). Na Performance Max não há
// anúncio em `ad_group_ad`: o que aparece para o cliente sai dos grupos de recursos (`asset_group`), com as imagens
// ligadas a cada um (`asset_group_asset`, a imagem em `asset.image_asset.full_size`). Cada grupo de recursos vira um
// criativo do Liame (o id com o prefixo `pmax:`, para não cruzar com o id de um anúncio), com a imagem que melhor cabe no
// cartão (a quadrada, depois a deitada, depois a em pé) e o gasto dos últimos 30 dias, para Resultados mostrar a do grupo
// que mais gastou. A leitura é a v25 (fields/v25/asset_group_asset, asset e asset_group, lidas em 12/11/2026).

/** O tipo do criativo do grupo de recursos (Resultados mostra a imagem: não é anúncio de texto). */
export const TIPO_DA_PERFORMANCE_MAX = 'PERFORMANCE_MAX';

/** As imagens do grupo de recursos, na ordem em que cabem no cartão. */
export const IMAGENS_DO_GRUPO = ['SQUARE_MARKETING_IMAGE', 'MARKETING_IMAGE', 'PORTRAIT_MARKETING_IMAGE'] as const;

/** As imagens dos grupos de recursos (o grupo removido vem também: ele sai da escolha e fica "fora do ar"). */
export const CONSULTA_DAS_IMAGENS = `SELECT campaign.id, asset_group.id, asset_group.name, asset_group.status, asset_group_asset.field_type, asset.id, asset.image_asset.full_size.url, asset.image_asset.full_size.width_pixels, asset.image_asset.full_size.height_pixels FROM asset_group_asset WHERE asset_group_asset.field_type IN (${IMAGENS_DO_GRUPO.map((t) => `'${t}'`).join(', ')}) AND asset_group_asset.status != 'REMOVED'`;

/** O gasto de cada grupo de recursos nos últimos 30 dias (para a imagem ser a do grupo que mais gastou). */
export const CONSULTA_DO_GASTO = 'SELECT asset_group.id, metrics.cost_micros FROM asset_group WHERE segments.date DURING LAST_30_DAYS';

export type LinhaDaImagem = {
  campaign?: { id?: string | number };
  assetGroup?: { id?: string | number; name?: string; status?: string };
  assetGroupAsset?: { fieldType?: string };
  asset?: { id?: string | number; imageAsset?: { fullSize?: { url?: string; widthPixels?: string | number; heightPixels?: string | number } } };
};
export type LinhaDoGasto = { assetGroup?: { id?: string | number }; metrics?: { costMicros?: string | number } };

export type CriativoDaPerformanceMax = {
  externalId: string;
  name: string | null;
  kind: string;
  thumbnailUrl: string | null;
  providerAttributes: {
    campanha: string;
    grupo_de_recursos: string;
    situacao: string | null;
    gasto_30d_micros: number | null;
    imagem: { tipo: string; largura: number | null; altura: number | null } | null;
  };
};

const numero = (v: string | number | undefined): number | null => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * Um criativo por grupo de recursos: a imagem que melhor cabe no cartão (a quadrada, a deitada, a em pé; no mesmo tipo,
 * a de menor id, para não trocar a cada leitura) e o gasto dos 30 dias (nulo sem a leitura do gasto; zero quando o
 * Google não traz a linha do grupo).
 */
export function criativosDaPerformanceMax(imagens: LinhaDaImagem[], gastos: LinhaDoGasto[] | null): CriativoDaPerformanceMax[] {
  const gastoPorGrupo = new Map<string, number>();
  for (const g of gastos ?? []) {
    const id = g.assetGroup?.id;
    if (id === undefined) continue;
    gastoPorGrupo.set(String(id), (gastoPorGrupo.get(String(id)) ?? 0) + (numero(g.metrics?.costMicros) ?? 0));
  }
  const porGrupo = new Map<string, { linha: LinhaDaImagem; ordem: number; asset: bigint }>();
  for (const l of imagens) {
    const grupo = l.assetGroup?.id;
    const campanha = l.campaign?.id;
    const url = l.asset?.imageAsset?.fullSize?.url;
    if (grupo === undefined || campanha === undefined || !url) continue;
    const ordem = IMAGENS_DO_GRUPO.indexOf((l.assetGroupAsset?.fieldType ?? '') as (typeof IMAGENS_DO_GRUPO)[number]);
    if (ordem < 0) continue;
    let asset = 0n;
    try {
      asset = BigInt(String(l.asset?.id ?? '0'));
    } catch {
      asset = 0n;
    }
    const atual = porGrupo.get(String(grupo));
    if (!atual || ordem < atual.ordem || (ordem === atual.ordem && asset < atual.asset)) porGrupo.set(String(grupo), { linha: l, ordem, asset });
  }
  return [...porGrupo.entries()]
    .map(([grupo, { linha: l }]) => {
      const imagem = l.asset!.imageAsset!.fullSize!;
      return {
        externalId: `pmax:${grupo}`,
        name: l.assetGroup?.name ?? null,
        kind: TIPO_DA_PERFORMANCE_MAX,
        thumbnailUrl: imagem.url!,
        providerAttributes: {
          campanha: String(l.campaign!.id),
          grupo_de_recursos: grupo,
          situacao: l.assetGroup?.status ?? null,
          gasto_30d_micros: gastos === null ? null : (gastoPorGrupo.get(grupo) ?? 0),
          imagem: { tipo: l.assetGroupAsset!.fieldType!, largura: numero(imagem.widthPixels), altura: numero(imagem.heightPixels) },
        },
      };
    })
    .sort((a, b) => a.externalId.localeCompare(b.externalId));
}
