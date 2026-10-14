import type { AppConfig } from '../config.js';
import type { ProviderId } from './tipos.js';

/** Os endereços oficiais das quatro APIs do Perfil da Empresa no Google (os padrões da configuração; base §3.3). */
export const PERFIL_GOOGLE_OFICIAL = {
  contas: 'https://mybusinessaccountmanagement.googleapis.com',
  lojas: 'https://mybusinessbusinessinformation.googleapis.com',
  avaliacoes: 'https://mybusiness.googleapis.com',
  numeros: 'https://businessprofileperformance.googleapis.com',
} as const;

/** O endereço oficial da API do Search Console (o padrão da configuração; base §3.3). */
export const SEARCH_CONSOLE_OFICIAL = 'https://searchconsole.googleapis.com';

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
    // O Perfil da Empresa no Google (A6, Z1) fala com quatro APIs, cada uma no endereço dela.
    google_business: [p.perfilGoogle.contas, p.perfilGoogle.lojas, p.perfilGoogle.avaliacoes, p.perfilGoogle.numeros],
    // O Search Console (A6, Z3): os sites e as buscas, na mesma API.
    search_console: [p.searchConsoleUrl],
  };
}
