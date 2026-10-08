import type { AppConfig } from '../config.js';
import type { ProviderId } from './tipos.js';

/** Endereços liberados de cada plataforma para o cliente dos conectores (em produção, só os oficiais). */
export function enderecosDasPlataformas(p: AppConfig['plataformas'], produtos?: AppConfig['produtos']): Record<ProviderId, string[]> {
  return {
    meta_ads: [p.metaGraphUrl],
    // O Google Ads e a Data Manager API (as vendas confirmadas, A5 · Y1) são do mesmo provider, com a mesma credencial.
    google_ads: [p.googleAdsUrl, p.dataManagerUrl],
    ga4: [p.ga4DataUrl, p.ga4AdminUrl],
    // Produtos DMS (A2.5): o endereço é da distribuição, nunca informado pelo usuário (V33).
    regem: produtos ? [produtos.regemApiUrl] : [],
    regemcast: produtos?.regemcastApiUrl ? [produtos.regemcastApiUrl] : [],
  };
}
