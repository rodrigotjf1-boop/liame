import type { AppConfig } from '../config.js';
import type { ProviderId } from './tipos.js';

/** Endereços liberados de cada plataforma para o cliente dos conectores (em produção, só os oficiais). */
export function enderecosDasPlataformas(p: AppConfig['plataformas']): Record<ProviderId, string[]> {
  return {
    meta_ads: [p.metaGraphUrl],
    google_ads: [p.googleAdsUrl],
    ga4: [p.ga4DataUrl, p.ga4AdminUrl],
  };
}
