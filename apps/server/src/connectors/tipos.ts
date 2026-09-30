import type { Db } from '@liame/database';
import { sql } from 'drizzle-orm';
import type { PontoMetrica } from '../media/metric-store.js';

// Interface comum dos conectores de LEITURA (arquitetura §6; a escrita, com execute/readState, entra na
// A4 pelo Action Service). Cada conector só traduz a plataforma para o modelo canônico (G1); cota,
// disjuntor e erros são do cliente HTTP (G2); gravar e agendar é da sincronização (G7).

/** Plataformas de anúncio e de análise (A2). */
export type ProviderMidia = 'meta_ads' | 'google_ads' | 'ga4';
/** Toda origem lida por um conector: as plataformas e os produtos DMS (A2.5). */
export type ProviderId = ProviderMidia | 'regem' | 'regemcast';

/** Credencial já decifrada do cofre, só na memória da chamada (nunca em log, API ou tela). */
export type Credencial = { accessToken: string };

export type ContaDescoberta = { externalId: string; name: string; currency: string | null; timezone: string | null; providerAttributes?: Record<string, unknown> };

export type StatusCanonico = 'ativa' | 'pausada' | 'arquivada' | 'removida' | 'desconhecida';

export type EntidadeLida = {
  externalId: string;
  name: string;
  status: StatusCanonico;
  providerStatus: string | null;
  parentExternalId?: string | null;
  providerAttributes?: Record<string, unknown>;
};

export type EntidadesLidas = {
  campaigns: (EntidadeLida & { objective?: string | null; dailyBudgetMicros?: number | null; lifetimeBudgetMicros?: number | null })[];
  adGroups: (EntidadeLida & { dailyBudgetMicros?: number | null })[];
  ads: (EntidadeLida & { creativeExternalId?: string | null })[];
  creatives: { externalId: string; name: string | null; kind: string | null; thumbnailUrl: string | null; providerAttributes?: Record<string, unknown> }[];
};

/** Um destino do anúncio (link do criativo na Meta, URL final no Google) com os parâmetros que só valem para ele. */
export type DestinoLido = { url: string; url_tags: string | null };

/** Nível do Google Ads de onde veio o sufixo ou o modelo que vale para o anúncio (o mais específico vence). */
export type NivelUrlGoogle = 'anuncio' | 'grupo' | 'campanha' | 'conta';

/**
 * O que o anúncio leva no link (A2.5, F5; base §2.1 e §3.1), guardado nos atributos do criativo (Meta) ou do
 * anúncio (Google) em `provider_attributes.rastreio`. Serve à conferência do rastreio: sem a chave, o
 * conector ainda não leu (ou a plataforma recusou os campos de URL).
 */
export type RastreioLido = {
  /** Meta: parâmetros de URL do criativo (`url_tags`). */
  url_tags: string | null;
  /** Para onde o anúncio leva. */
  destinos: DestinoLido[];
  /** Google: sufixo do URL final que vale para o anúncio e o nível de onde veio. */
  sufixo: string | null;
  sufixo_nivel: NivelUrlGoogle | null;
  /** Google: modelo de acompanhamento que vale para o anúncio e o nível de onde veio. */
  modelo: string | null;
  modelo_nivel: NivelUrlGoogle | null;
};

/** Teto dos textos de URL guardados (o que passa disso não é endereço de anúncio de verdade). */
export const MAX_URL_LIDA = 2048;
/** Destinos guardados por anúncio (carrossel tem até 10 cartões; criativo dinâmico, até 5 links). */
export const MAX_DESTINOS = 20;

/** Texto de URL lido da plataforma: aparado; vazio ou longo demais vira nulo (nunca cortado). */
export function textoDeUrl(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s && s.length <= MAX_URL_LIDA ? s : null;
}

/** Junta os destinos sem repetir, até o teto. */
export function juntarDestinos(lista: { url: unknown; urlTags?: unknown }[]): DestinoLido[] {
  const out: DestinoLido[] = [];
  for (const d of lista) {
    const url = textoDeUrl(d.url);
    if (!url) continue;
    const tags = textoDeUrl(d.urlTags);
    if (out.some((x) => x.url === url && x.url_tags === tags)) continue;
    out.push({ url, url_tags: tags });
    if (out.length === MAX_DESTINOS) break;
  }
  return out;
}

export type ContextoConta = {
  credencial: Credencial;
  externalId: string;
  timezone: string | null;
  currency: string | null;
  /** Google Ads: conta gerente pela qual o acesso passa (cabeçalho `login-customer-id`). */
  loginCustomerId?: string | null;
};

export interface ConectorLeitura {
  readonly provider: ProviderMidia;
  readonly apiVersion: string;
  /** Contas que a credencial alcança (para a pessoa escolher quais ligar a cada marca). */
  descobrirContas(credencial: Credencial): Promise<ContaDescoberta[]>;
  /** Campanhas, grupos, anúncios e criativos (GA4 não tem: devolve listas vazias). */
  lerEntidades(conta: ContextoConta): Promise<EntidadesLidas>;
  /** Métricas diárias da janela [inicio, fim] (datas no fuso da conta, AAAA-MM-DD). */
  lerMetricas(conta: ContextoConta, janela: { inicio: string; fim: string }): Promise<PontoMetrica[]>;
}

/** Versão de API registrada para a capacidade (Capability Registry): nunca espalhada no código. */
export async function versaoRegistrada(db: Db, provider: ProviderId, capability: string): Promise<string> {
  const r = await db.execute<{ api_version: string }>(sql`
    select api_version from liame.connector_capability where provider = ${provider} and capability = ${capability}`);
  const v = r.rows[0]?.api_version;
  if (!v) throw new Error(`capacidade ${provider}/${capability} fora do registro`);
  return v;
}
