import type { Tx } from '@liame/database';
import { sql } from 'drizzle-orm';
import { campanhaNovaDoRecurso } from '../campanhas/campanha-nova-plano.js';
import { campanhaNovaNaMetaConnector } from './campanha-nova-na-meta.js';
import { comentarioDoRecurso, comentarioNaPaginaConnector, comentarioNoInstagramConnector } from './comentario-na-rede.js';
import { directNoInstagramConnector, directNoMessengerConnector } from './direct-na-rede.js';
import { conversaDoRecurso } from './direct-plano.js';
import { googleAnunciosConnector } from './google-anuncios.js';
import { metaAnunciosConnector } from './meta-anuncios.js';
import { perfilAvaliacaoConnector } from './perfil-avaliacao.js';
import { postNaPaginaConnector, postNoInstagramConnector } from './post-publicacao.js';
import { regemCupomConnector } from './regem-cupom.js';
import { regemcastMensagemConnector } from './regemcast-mensagem.js';
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
  /**
   * O que o conector leu junto e que o pedido NÃO guarda (A6, Z2: o nome de quem fez a avaliação). Vai só para o plano
   * da ferramenta conferir; não entra no estado, no pedido nem na auditoria.
   */
  transient?: ResourceState;
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
   * Os nomes das outras campanhas que dividem a verba do objeto lido (A5, Y3), para a tela do pedido dizer com quem.
   * Só tem a plataforma em que a verba mora fora da campanha (o orçamento do Google Ads). É detalhe da tela: o que a
   * plataforma não responder a tempo volta como lista vazia, e o pedido segue.
   */
  sharedBudgetWith?(prepared: PreparedRead, state: ResourceState): Promise<string[]>;
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

/**
 * Dois conectores na mesma conta da rede (A6, Z11, parte 2): o do post e o do comentário, escolhidos pelo recurso do
 * pedido (`comentario:<id>` é do comentário; o resto, do post). O registro guarda um conector por provedor, e a conta do
 * Instagram e a da Página servem aos dois: assim, a trava por provedor e a flag de escrita do conector (`social_write`)
 * alcançam os dois, e o do post fica como estava. A flag própria do comentário é da ferramenta (`flag`).
 */
export class ConectorPorRecurso implements Connector {
  readonly provider: string;
  readonly writeFlag: string | null;
  readonly requiresSpendLimits: boolean;
  readonly needsWriteAuthorization?: boolean;

  constructor(
    private readonly doPost: Connector,
    private readonly doComentario: Connector,
    /** A conversa (`direct:<id>`): o Direct na conta do Instagram (A6, Z12, parte 2) e o Messenger na da Página (Z14). */
    private readonly doDirect: Connector | null = null,
  ) {
    this.provider = doPost.provider;
    this.writeFlag = doPost.writeFlag;
    this.requiresSpendLimits = doPost.requiresSpendLimits;
    if (doPost.needsWriteAuthorization !== undefined) this.needsWriteAuthorization = doPost.needsWriteAuthorization;
  }

  /** O conector do recurso: o do comentário para `comentario:<id>`, o do Direct para `direct:<id>`, o do post para o resto. */
  de(resourceId: string): Connector {
    if (comentarioDoRecurso(resourceId)) return this.doComentario;
    if (this.doDirect && conversaDoRecurso(resourceId)) return this.doDirect;
    return this.doPost;
  }

  read(tx: Tx, ref: ResourceRef): Promise<ReadResult | null> {
    return this.de(ref.resourceId).read(tx, ref);
  }

  apply(tx: Tx, ref: ResourceRef, desired: ResourceState, expectedVersion: number, options?: ApplyOptions): Promise<ApplyResult> {
    return this.de(ref.resourceId).apply(tx, ref, desired, expectedVersion, options);
  }
}

/**
 * A Meta de anúncios (A4): os objetos que já existem na Meta (`campanha:`, `conjunto:` e `anuncio:<id>`, verba e
 * situação) e a campanha nova do Liame (`campanha_nova:<id>`, X5), que o conector cria na Meta. A trava, a flag de
 * escrita (`meta_write`) e os limites são os do provedor; a leitura em duas partes (a do pedido de mudança) é só dos
 * objetos que já existem.
 */
export class ConectorDaMeta implements Connector {
  readonly provider: string;
  readonly writeFlag: string | null;
  readonly requiresSpendLimits: boolean;
  readonly needsWriteAuthorization?: boolean;

  constructor(
    private readonly dosObjetos: Connector,
    private readonly daCampanhaNova: Connector,
  ) {
    this.provider = dosObjetos.provider;
    this.writeFlag = dosObjetos.writeFlag;
    this.requiresSpendLimits = dosObjetos.requiresSpendLimits;
    if (dosObjetos.needsWriteAuthorization !== undefined) this.needsWriteAuthorization = dosObjetos.needsWriteAuthorization;
  }

  de(resourceId: string): Connector {
    return campanhaNovaDoRecurso(resourceId) ? this.daCampanhaNova : this.dosObjetos;
  }

  read(tx: Tx, ref: ResourceRef): Promise<ReadResult | null> {
    return this.de(ref.resourceId).read(tx, ref);
  }

  async prepareRead(tx: Tx, ref: ResourceRef): Promise<PreparedRead | null> {
    const c = this.de(ref.resourceId);
    return c.prepareRead ? c.prepareRead(tx, ref) : null;
  }

  async readPrepared(prepared: PreparedRead): Promise<ReadResult | null> {
    return this.dosObjetos.readPrepared ? this.dosObjetos.readPrepared(prepared) : null;
  }

  async sharedBudgetWith(prepared: PreparedRead, state: ResourceState): Promise<string[]> {
    return this.dosObjetos.sharedBudgetWith ? this.dosObjetos.sharedBudgetWith(prepared, state) : [];
  }

  apply(tx: Tx, ref: ResourceRef, desired: ResourceState, expectedVersion: number, options?: ApplyOptions): Promise<ApplyResult> {
    return this.de(ref.resourceId).apply(tx, ref, desired, expectedVersion, options);
  }
}

export const CONNECTORS: Record<string, Connector> = {
  sandbox: new SandboxConnector(),
  regem: regemCupomConnector,
  // A4, X5: a campanha nova (`campanha_nova:<id>`) pelo mesmo provedor; os objetos que já existem, como sempre.
  meta_ads: new ConectorDaMeta(metaAnunciosConnector, campanhaNovaNaMetaConnector),
  google_ads: googleAnunciosConnector,
  // A5, Y5: o pedido de mensagem de WhatsApp. Só com a flag de escrita `whatsapp_campaign` ligada para a empresa.
  regemcast: regemcastMensagemConnector,
  // A6, Z2: a resposta a uma avaliação do perfil no Google. Só com a flag de escrita `perfil_google_write` ligada.
  google_business: perfilAvaliacaoConnector,
  // A6, Z5b: o post da marca, pelo provedor da conta do primeiro canal (o Instagram ou a Página). Só com a flag de
  // escrita `social_write` ligada. O Instagram publica desde a parte 2; a Página é a parte 3 (o post com ela recusa).
  // A6, Z11, parte 2: o comentário de um post da marca (responder, ocultar e mostrar), na mesma conta, pelo recurso
  // `comentario:<id>`. Só com a flag do conector (`social_write`) e a da ferramenta (`comentarios_responder`) ligadas.
  // A6, Z12, parte 2: a resposta numa conversa do Direct, na mesma conta do Instagram, pelo recurso `direct:<id>`. Só com
  // a flag do conector (`social_write`) e a da ferramenta (`direct_responder`) ligadas.
  instagram: new ConectorPorRecurso(postNoInstagramConnector, comentarioNoInstagramConnector, directNoInstagramConnector),
  // A6, Z14, parte 2: a resposta numa conversa do Messenger, na conta da Página, pelo mesmo recurso `direct:<id>`.
  facebook_page: new ConectorPorRecurso(postNaPaginaConnector, comentarioNaPaginaConnector, directNoMessengerConnector),
};
