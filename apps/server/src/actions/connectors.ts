import type { Tx } from '@liame/database';
import { sql } from 'drizzle-orm';
import { googleAnunciosConnector } from './google-anuncios.js';
import { metaAnunciosConnector } from './meta-anuncios.js';
import { regemCupomConnector } from './regem-cupom.js';
import type { ResourceState } from './tools.js';

// Connectors (arquitetura §6): um por provedor, com a mesma interface. Na A1 só existia o sandbox
// (no próprio banco). O primeiro de verdade é o do Regem (A2.5, F6 parte 2): criar cupom de campanha.
// O da Meta chegou na A4 (X1): situação e verba diária de campanha, conjunto e anúncio; as ferramentas de
// anúncio o usam desde a X2. Todos passam pelo mesmo Action Service.
//
// O do Google Ads (`google-anuncios.ts`, A5 · Y2) entrou neste registro na Y3 (09/10/2026), com as ferramentas que o
// aceitam (verba, pausar e retomar CAMPANHA) e atrás da flag `google_write`, que nasce desligada: sem ela, o pedido é
// recusado antes de qualquer chamada ao Google, e a tela não oferece o botão. Com o registro, para quem tem conta do
// Google conectada, a maior verba diária da Verba do mês passa a contar as campanhas do Google (o teto por campanha
// vale nas duas plataformas) e a Autonomia diz "escrita desligada" no lugar de "plataforma sem escrita".

export interface ResourceRef {
  tenantId: string;
  accountId: string;
  resourceId: string;
}

export interface ReadResult {
  state: ResourceState;
  version: number;
}

/** O que a parte do banco de uma leitura deixa pronto para a parte da plataforma. Opaco para quem chama: só o conector sabe abrir. */
export type PreparedRead = { readonly conector: string };

export type ApplyResult =
  | { ok: true; state: ResourceState; version: number }
  /** O recurso mudou desde o pedido: não sobrescreve (ADR-007, compensação). */
  | { ok: false; reason: 'estado-mudou'; current: ReadResult }
  /** O provedor recusou de vez (regra inválida, código em uso, sem permissão): repetir não resolve. */
  | { ok: false; reason: 'recusado'; mensagem: string };

/** `validateOnly`: só confere se dá para aplicar. `requestedBy`: quem pediu a ação (o connector não decide por ele; só registra). */
export type ApplyOptions = { validateOnly?: boolean; requestedBy?: string | null };

export interface Connector {
  readonly provider: string;
  /** Flag de escrita do provedor (ADR-012); nula = sem flag (sandbox). */
  readonly writeFlag: string | null;
  /**
   * O provedor gasta dinheiro de mídia de verdade (A4, D-A4-6): aumentar verba ou voltar a gastar nele só com os
   * limites que a empresa define (o teto por ação e o envelope do mês). Sem eles, o pedido é negado.
   */
  readonly requiresSpendLimits: boolean;
  /**
   * A escrita pede uma autorização própria da plataforma, além da de leitura (na Meta, a configuração de login que
   * também pede para gerenciar anúncios): a conexão feita só para ler precisa ser refeita antes de o Liame mudar algo.
   * Sem isto, a mesma autorização cobre ler e mudar (no Google Ads, o escopo é um só).
   */
  readonly needsWriteAuthorization?: boolean;
  read(tx: Tx, ref: ResourceRef): Promise<ReadResult | null>;
  /**
   * A mesma leitura em duas partes, para quem não quer segurar a transação enquanto espera a plataforma (a rota
   * `@SemTransacao` das opções do pedido): `prepareRead` faz a parte do banco (a conta, a autorização, o objeto
   * conhecido) e `readPrepared` chama a plataforma, sem transação. Só o conector de plataforma tem as duas.
   */
  prepareRead?(tx: Tx, ref: ResourceRef): Promise<PreparedRead | null>;
  readPrepared?(prepared: PreparedRead): Promise<ReadResult | null>;
  /**
   * Aplica o estado desejado se a versão ainda for a esperada (concorrência otimista). O que é passageiro (limite de
   * uso da plataforma, fora do ar) sobe como `ErroConector`: quem executa adia a ação, em vez de insistir.
   */
  apply(tx: Tx, ref: ResourceRef, desired: ResourceState, expectedVersion: number, options?: ApplyOptions): Promise<ApplyResult>;
}

export class SandboxConnector implements Connector {
  readonly provider = 'sandbox';
  readonly writeFlag = null;
  readonly requiresSpendLimits = false;

  async read(tx: Tx, ref: ResourceRef): Promise<ReadResult | null> {
    const r = await tx.execute<{ state: ResourceState; version: number }>(sql`
      select state, version from liame.sandbox_resource
       where tenant_id = ${ref.tenantId} and account_id = ${ref.accountId} and resource_id = ${ref.resourceId}`);
    return r.rows[0] ?? null;
  }

  async apply(tx: Tx, ref: ResourceRef, desired: ResourceState, expectedVersion: number, options: ApplyOptions = {}): Promise<ApplyResult> {
    const current = await this.read(tx, ref);
    if (!current || current.version !== expectedVersion) {
      return { ok: false, reason: 'estado-mudou', current: current ?? { state: {}, version: 0 } };
    }
    if (options.validateOnly) return { ok: true, state: desired, version: current.version };
    const r = await tx.execute<{ version: number }>(sql`
      update liame.sandbox_resource set state = ${JSON.stringify(desired)}::jsonb, version = version + 1, updated_at = now()
       where tenant_id = ${ref.tenantId} and account_id = ${ref.accountId} and resource_id = ${ref.resourceId} and version = ${expectedVersion}
       returning version`);
    const row = r.rows[0];
    if (!row) return { ok: false, reason: 'estado-mudou', current: (await this.read(tx, ref)) ?? { state: {}, version: 0 } };
    return { ok: true, state: desired, version: row.version };
  }
}

export const CONNECTORS: Record<string, Connector> = {
  sandbox: new SandboxConnector(),
  regem: regemCupomConnector,
  meta_ads: metaAnunciosConnector,
  google_ads: googleAnunciosConnector,
};
