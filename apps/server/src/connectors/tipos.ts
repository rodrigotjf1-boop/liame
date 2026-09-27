import type { Db } from '@liame/database';
import { sql } from 'drizzle-orm';
import type { PontoMetrica } from '../media/metric-store.js';

// Interface comum dos conectores de LEITURA (arquitetura §6; a escrita, com execute/readState, entra na
// A4 pelo Action Service). Cada conector só traduz a plataforma para o modelo canônico (G1); cota,
// disjuntor e erros são do cliente HTTP (G2); gravar e agendar é da sincronização (G7).

export type ProviderId = 'meta_ads' | 'google_ads' | 'ga4';

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

export type ContextoConta = {
  credencial: Credencial;
  externalId: string;
  timezone: string | null;
  currency: string | null;
  /** Google Ads: conta gerente pela qual o acesso passa (cabeçalho `login-customer-id`). */
  loginCustomerId?: string | null;
};

export interface ConectorLeitura {
  readonly provider: ProviderId;
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
