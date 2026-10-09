import { createHmac } from 'node:crypto';
import { setTimeout as esperar } from 'node:timers/promises';
import type { Tx } from '@liame/database';
import { Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { canonicalJson, sha256 } from '../audit/audit.js';
import type { CredencialGuardada } from '../connections/oauth.js';
import { type ClienteConector, ErroConector } from '../connectors/cliente-http.js';
import { emMenorUnidade, orcamentoEmMicros } from '../connectors/meta/verba.js';
import type { ApplyOptions, ApplyResult, Connector, PreparedRead, ReadResult, ResourceRef } from './connectors.js';
import { motivoDaRecusa } from './resposta-da-plataforma.js';
import type { ResourceState } from './tools.js';

// Escrita na Meta pelo Action Service (A4, X1; base de conhecimento §2.1, conferida em 04/10/2026): mudar a situação
// (ativar e pausar) de uma campanha, de um conjunto ou de um anúncio, e a verba diária de uma campanha ou de um
// conjunto. Só depois da aprovação de uma pessoa, com a flag `meta_write` ligada para a conta.
//
// O recurso é o objeto na Meta: `resource_id` = `campanha:<id>`, `conjunto:<id>` ou `anuncio:<id>`; `account_id` é a
// conta conectada no Liame. O objeto precisa estar na lista que o Liame leu dessa conta, e a Meta precisa confirmar
// que ele é dela.
//
// - O estado é lido NA META logo antes de planejar e de escrever. A versão sai do próprio estado (situação e verba):
//   o `updated_time` da Meta não muda quando a verba muda, então não serve para saber se alguém mexeu.
// - Toda escrita passa antes pela validação da Meta (`execution_options=["validate_only"]`), que não muda nada; a
//   recusa dela vira "recusado", com o motivo, e não se tenta de novo.
// - Se alguém mudou o objeto desde o pedido, nada é sobrescrito. Se ele já está como o pedido queria, não há o que
//   fazer (é o que acontece quando uma tentativa caiu depois de a Meta ter aceitado).
// - Limite de uso da conta e falha passageira sobem como `ErroConector`: quem executa adia, em vez de insistir.
// - O token da empresa sai do cofre só na hora de chamar e nunca vai para log, estado ou auditoria.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROVIDER = 'meta_ads';

export type TipoDeObjeto = 'campanha' | 'conjunto' | 'anuncio';
type Objeto = { tipo: TipoDeObjeto; externalId: string };

/** Os campos pedidos à Meta, por tipo. A conta dona vem junto, para conferir que o objeto é da conta do pedido. */
const CAMPOS: Record<TipoDeObjeto, string> = {
  campanha: 'id,name,status,effective_status,daily_budget,lifetime_budget,account_id',
  conjunto: 'id,name,status,effective_status,daily_budget,lifetime_budget,account_id',
  anuncio: 'id,name,status,effective_status,account_id',
};

export type SituacaoDoObjeto = 'ativo' | 'pausado' | 'arquivado' | 'removido' | 'desconhecido';
const SITUACAO: Record<string, SituacaoDoObjeto> = { ACTIVE: 'ativo', PAUSED: 'pausado', ARCHIVED: 'arquivado', DELETED: 'removido' };
const NA_META: Partial<Record<SituacaoDoObjeto, string>> = { ativo: 'ACTIVE', pausado: 'PAUSED' };

/** O estado de um objeto de anúncio, como o Action Service o guarda no pedido. */
export type EstadoDoObjeto = {
  tipo: TipoDeObjeto;
  /** O id do objeto na Meta. */
  id: string;
  nome: string;
  /** A situação que alguém configurou no objeto. */
  status: SituacaoDoObjeto;
  /** A situação de entrega que a Meta informa (o pai pausado pausa o filho: `CAMPAIGN_PAUSED`, `ADSET_PAUSED`…). */
  status_efetivo: string | null;
  /** A verba diária neste nível, em micros da moeda da conta; nula quando a verba não mora aqui. */
  daily_budget_micros: number | null;
  lifetime_budget_micros: number | null;
  moeda: string | null;
};

/** `campanha:123` → o tipo e o id na Meta (só dígitos: o id entra no caminho da URL). */
export function objetoDoRecurso(resourceId: string): Objeto | null {
  const m = /^(campanha|conjunto|anuncio):(\d{1,25})$/.exec(resourceId);
  return m ? { tipo: m[1] as TipoDeObjeto, externalId: m[2]! } : null;
}

/**
 * A versão do estado, tirada dele mesmo: muda quando a situação ou a verba mudam, e só então. Cabe na coluna inteira
 * do pedido (`before_version`) e nunca é zero.
 */
export function versaoDoEstado(e: Pick<EstadoDoObjeto, 'status' | 'daily_budget_micros' | 'lifetime_budget_micros'>): number {
  const hash = sha256(canonicalJson({ status: e.status, daily_budget_micros: e.daily_budget_micros, lifetime_budget_micros: e.lifetime_budget_micros }));
  return (Number.parseInt(hash.slice(0, 12), 16) % 2_147_483_646) + 1;
}

// A conta da verba mora em `connectors/meta/verba.ts`; sai por aqui também, para quem já importava.
export { emMenorUnidade };

export type Mudanca =
  /** O objeto já está como o pedido queria. */
  | { tipo: 'nada' }
  | { tipo: 'mudar'; params: Record<string, string> }
  | { tipo: 'invalida'; motivo: string };

/**
 * O que precisa mudar na Meta para o objeto ficar como o pedido quer. Só a situação (ativo ou pausado) e a verba
 * diária mudam por aqui; o resto do estado desejado precisa ser igual ao que a Meta tem agora.
 */
export function mudancaPedida(atual: EstadoDoObjeto, desejado: ResourceState): Mudanca {
  const params: Record<string, string> = {};
  if (desejado.tipo !== atual.tipo || desejado.id !== atual.id) return { tipo: 'invalida', motivo: 'O pedido não é deste objeto.' };

  if (desejado.status !== atual.status) {
    const alvo = typeof desejado.status === 'string' ? NA_META[desejado.status as SituacaoDoObjeto] : undefined;
    if (!alvo) return { tipo: 'invalida', motivo: 'Pelo Liame, um objeto de anúncio só é ativado ou pausado.' };
    if (!NA_META[atual.status]) return { tipo: 'invalida', motivo: 'O objeto foi arquivado ou removido na Meta: não dá para mudar a situação dele.' };
    params.status = alvo;
  }

  if ((desejado.daily_budget_micros ?? null) !== atual.daily_budget_micros) {
    if (atual.tipo === 'anuncio') return { tipo: 'invalida', motivo: 'Anúncio não tem verba própria: a verba fica na campanha ou no conjunto.' };
    if (atual.daily_budget_micros === null) return { tipo: 'invalida', motivo: 'Este objeto não tem verba diária: a verba fica em outro nível, ou é de período.' };
    const valor = typeof desejado.daily_budget_micros === 'number' ? emMenorUnidade(desejado.daily_budget_micros, atual.moeda) : null;
    if (valor === null) return { tipo: 'invalida', motivo: 'A verba diária precisa ser um valor positivo, sem fração de centavo.' };
    params.daily_budget = String(valor);
  }

  if ((desejado.lifetime_budget_micros ?? null) !== atual.lifetime_budget_micros) return { tipo: 'invalida', motivo: 'A verba de período não muda pelo Liame.' };
  return Object.keys(params).length ? { tipo: 'mudar', params } : { tipo: 'nada' };
}

/** Uso da conta na Meta (o maior percentual dos cabeçalhos) a partir do qual a escrita espera, em vez de arriscar o bloqueio. */
export const USO_PARA_ESPERAR_PCT = 90;
const ESPERA_COM_USO_ALTO_MS = 5 * 60_000;

/** O que a escrita precisa do resto do app; ligado na subida (API e worker). */
export type DependenciasDaEscritaMeta = {
  lerSegredo: (tx: Tx, secretId: string) => Promise<string | null>;
  cliente: () => ClienteConector;
  /** Endereço da Graph API (o oficial em produção). */
  graphUrl: string;
  appSecret: string | null;
  /** A versão da API registrada para a capacidade (Capability Registry). */
  versao: (capacidade: 'entity_state' | 'entity_update') => Promise<string>;
  /** Quanto esperar para ler de novo quando a leitura depois da escrita ainda não mostra a mudança. */
  esperaDaConferenciaMs?: number;
  /** Quanto a leitura da hora do pedido espera a Meta (há uma pessoa esperando, com a transação da requisição aberta). */
  tempoDaLeituraDoPedidoMs?: number;
};

/** A leitura da hora do pedido não espera a Meta mais que isto: passou, a pessoa recebe "tente de novo", e nada é pedido. */
const TEMPO_DA_LEITURA_DO_PEDIDO_MS = 10_000;

type Conta = { id: string; external_id: string; currency: string | null; credential_secret_id: string | null };
type ObjetoNaMeta = { id?: string; name?: string; status?: string; effective_status?: string; daily_budget?: string; lifetime_budget?: string; account_id?: string };
type Lido = { estado: EstadoDoObjeto; versao: number; usoPct: number; esperarMs: number };
type Alvo = { lido: Lido; conta: Conta; token: string; objeto: Objeto; deps: DependenciasDaEscritaMeta };
/** A parte do banco de uma leitura: a conta, a autorização dela e o objeto. O token fica só na memória de quem lê. */
type Preparada = PreparedRead & { conta: Conta; token: string; objeto: Objeto; deps: DependenciasDaEscritaMeta };

const recusado = (mensagem: string): ApplyResult => ({ ok: false, reason: 'recusado', mensagem });

const SEM_ACESSO = 'A Meta recusou o acesso desta conta (a autorização foi revogada ou venceu). Conecte a Meta de novo em Contas conectadas.';
const SEM_PERMISSAO =
  'A Meta recusou: o Liame não tem permissão para gerenciar os anúncios desta conta. Conecte a Meta de novo em Contas conectadas e confirme a permissão de gerenciar anúncios.';
const SUMIU = 'A Meta não tem mais este objeto nesta conta (foi apagado, ou a conta foi desconectada). Nada foi mudado.';
const FORA_DO_AMBIENTE = 'A escrita na Meta não está disponível neste ambiente.';

/**
 * A recusa definitiva da Meta em palavras; nulo para o que é passageiro (limite, fora do ar): isso sobe para quem
 * executa adiar. `passo`: a leitura do estado antes de mudar, ou a mudança em si.
 */
export function recusaDaMeta(err: unknown, passo: 'leitura' | 'escrita' = 'escrita'): string | null {
  if (!(err instanceof ErroConector)) return null;
  if (err.tipo === 'autenticacao') return SEM_ACESSO;
  if (err.tipo === 'permissao') return SEM_PERMISSAO;
  if (err.tipo !== 'definitivo') return null;
  // O texto que a Meta escreve para a pessoa, quando vem; senão, a mensagem do erro. Nenhum dos dois leva o token.
  const motivo = err.mensagemUsuario ?? err.message;
  // A recusa da mudança sai no formato que a resposta do pedido sabe separar (`resposta-da-plataforma.ts`).
  return passo === 'leitura' ? `A Meta não deixou ler o objeto antes de mudar: ${motivo.replace(/[.!?]\s*$/, '')}. Nada foi mudado.` : motivoDaRecusa('meta_ads', motivo);
}

/**
 * "O objeto não existe, ou não pode ser carregado": a Meta responde com o erro 100 e o subcódigo 33 ("Unsupported get
 * request. Object with ID … does not exist…"). Para nós, o objeto sumiu. Outro erro definitivo na leitura (um campo
 * que a versão da API não tem mais, por exemplo) não é sumiço: sobe com o motivo.
 */
function objetoSumiu(err: unknown): boolean {
  return err instanceof ErroConector && err.tipo === 'definitivo' && err.codigoProvider === '100' && (err.subcodigo === '33' || /^Unsupported (get|post) request/i.test(err.message));
}

/** A verba que mora neste nível: zero (a Meta devolve "0" quando a verba é de outro nível) é "não tem". */
const verba = (valor: string | undefined, moeda: string | null): number | null => {
  const micros = orcamentoEmMicros(valor, moeda);
  return micros !== null && micros > 0 ? micros : null;
};

export class MetaAnunciosConnector implements Connector {
  readonly provider = PROVIDER;
  readonly writeFlag = 'meta_write';
  readonly requiresSpendLimits = true;
  /** Gerenciar anúncios é outra configuração do login da Meta: a conexão só de leitura precisa ser refeita. */
  readonly needsWriteAuthorization = true;
  private readonly logger = new Logger('escrita-meta');
  private deps: DependenciasDaEscritaMeta | null = null;

  ligar(deps: DependenciasDaEscritaMeta): void {
    this.deps = deps;
  }

  /** A conta conectada da empresa, se o Liame leu este objeto dela. */
  private async conta(tx: Tx, ref: ResourceRef, objeto: Objeto): Promise<Conta | null> {
    if (!UUID.test(ref.accountId)) return null;
    const r = await tx.execute<Conta>(sql`
      select a.id, a.external_id, a.currency, a.credential_secret_id
        from liame.connected_account a
       where a.id = ${ref.accountId} and a.tenant_id = ${ref.tenantId} and a.provider = ${PROVIDER} and a.disconnected_at is null`);
    const conta = r.rows[0];
    if (!conta) return null;
    const onde = sql`connected_account_id = ${conta.id} and tenant_id = ${ref.tenantId} and external_id = ${objeto.externalId}`;
    const conhecido =
      objeto.tipo === 'campanha'
        ? await tx.execute(sql`select 1 from liame.campaign where ${onde}`)
        : objeto.tipo === 'conjunto'
          ? await tx.execute(sql`select 1 from liame.ad_group where ${onde}`)
          : await tx.execute(sql`select 1 from liame.ad where ${onde}`);
    return conhecido.rows[0] ? conta : null;
  }

  private async token(tx: Tx, conta: Conta, deps: DependenciasDaEscritaMeta): Promise<string> {
    const guardada = conta.credential_secret_id ? await deps.lerSegredo(tx, conta.credential_secret_id) : null;
    const credencial = guardada ? (JSON.parse(guardada) as CredencialGuardada) : null;
    if (!credencial || credencial.tipo !== 'meta') throw new ErroConector('autenticacao', PROVIDER, 'autorização revogada ou ausente');
    return credencial.access_token;
  }

  private endereco(deps: DependenciasDaEscritaMeta, versao: string, id: string, token: string, params: Record<string, string>): string {
    const query = new URLSearchParams(params);
    if (deps.appSecret) query.set('appsecret_proof', createHmac('sha256', deps.appSecret).update(token).digest('hex'));
    return `${deps.graphUrl}/${versao}/${id}?${query.toString()}`;
  }

  /** Lê o objeto na Meta. Nulo quando a Meta não o tem (ou não o mostra) nesta conta. */
  private async lerNaMeta(deps: DependenciasDaEscritaMeta, conta: Conta, token: string, objeto: Objeto, tempoLimiteMs?: number): Promise<Lido | null> {
    const versao = await deps.versao('entity_state');
    let o: ObjetoNaMeta;
    let usoPct = 0;
    let esperarMs = 0;
    try {
      const r = await deps.cliente().requisitar<ObjetoNaMeta | null>({
        provider: PROVIDER,
        conta: conta.external_id,
        url: this.endereco(deps, versao, objeto.externalId, token, { fields: CAMPOS[objeto.tipo] }),
        endpoint: 'entity_state',
        apiVersion: versao,
        cabecalhos: { authorization: `Bearer ${token}` },
        ...(tempoLimiteMs ? { tempoLimiteMs } : {}),
      });
      o = r.corpo ?? {};
      usoPct = r.uso?.maiorPct ?? 0;
      esperarMs = r.uso?.esperarMs ?? 0;
    } catch (err) {
      if (objetoSumiu(err)) return null;
      throw err;
    }
    // A Meta devolve a conta dona sem o `act_`: tem de ser a conta do pedido.
    if (o.id !== objeto.externalId || `act_${o.account_id ?? ''}` !== conta.external_id) return null;
    const estado: EstadoDoObjeto = {
      tipo: objeto.tipo,
      id: objeto.externalId,
      nome: typeof o.name === 'string' ? o.name : '',
      status: SITUACAO[o.status ?? ''] ?? 'desconhecido',
      status_efetivo: o.effective_status ?? null,
      daily_budget_micros: objeto.tipo === 'anuncio' ? null : verba(o.daily_budget, conta.currency),
      lifetime_budget_micros: objeto.tipo === 'anuncio' ? null : verba(o.lifetime_budget, conta.currency),
      moeda: conta.currency,
    };
    return { estado, versao: versaoDoEstado(estado), usoPct, esperarMs };
  }

  /** A parte do banco: a conta conectada da empresa que conhece o objeto, com a autorização dela. Nulo quando não é desta empresa. */
  private async preparar(tx: Tx, ref: ResourceRef, deps: DependenciasDaEscritaMeta): Promise<Preparada | null> {
    const objeto = objetoDoRecurso(ref.resourceId);
    const conta = objeto ? await this.conta(tx, ref, objeto) : null;
    if (!objeto || !conta) return null;
    return { conector: PROVIDER, conta, token: await this.token(tx, conta, deps), objeto, deps };
  }

  /** O objeto do pedido, lido na Meta com o token da empresa. Nulo quando a conta ou o objeto não é desta empresa, ou sumiu. */
  private async alvo(tx: Tx, ref: ResourceRef, deps: DependenciasDaEscritaMeta, tempoLimiteMs?: number): Promise<Alvo | null> {
    const p = await this.preparar(tx, ref, deps);
    if (!p) return null;
    const lido = await this.lerNaMeta(deps, p.conta, p.token, p.objeto, tempoLimiteMs);
    return lido ? { lido, conta: p.conta, token: p.token, objeto: p.objeto, deps } : null;
  }

  /** A leitura da hora do pedido, com o tempo curto de quem tem uma pessoa esperando. A do executor é a de `apply`. */
  async read(tx: Tx, ref: ResourceRef): Promise<ReadResult | null> {
    // Sem as dependências ligadas (erro de montagem do app), não há o que ler: melhor estourar do que dizer "não existe".
    if (!this.deps) throw new Error('escrita na Meta: dependências não ligadas');
    const alvo = await this.alvo(tx, ref, this.deps, this.deps.tempoDaLeituraDoPedidoMs ?? TEMPO_DA_LEITURA_DO_PEDIDO_MS);
    return alvo ? { state: alvo.lido.estado, version: alvo.lido.versao } : null;
  }

  /** A leitura da hora do pedido em duas partes: esta é a do banco (rápida, na transação de quem chama). */
  async prepareRead(tx: Tx, ref: ResourceRef): Promise<PreparedRead | null> {
    if (!this.deps) throw new Error('escrita na Meta: dependências não ligadas');
    return this.preparar(tx, ref, this.deps);
  }

  /** E esta, a da Meta: sem transação aberta, com o mesmo tempo curto de quem tem uma pessoa esperando. */
  async readPrepared(prepared: PreparedRead): Promise<ReadResult | null> {
    if (prepared.conector !== PROVIDER) throw new Error('escrita na Meta: leitura preparada por outro conector');
    const p = prepared as Preparada;
    const lido = await this.lerNaMeta(p.deps, p.conta, p.token, p.objeto, p.deps.tempoDaLeituraDoPedidoMs ?? TEMPO_DA_LEITURA_DO_PEDIDO_MS);
    return lido ? { state: lido.estado, version: lido.versao } : null;
  }

  async apply(tx: Tx, ref: ResourceRef, desired: ResourceState, expectedVersion: number, options: ApplyOptions = {}): Promise<ApplyResult> {
    if (!this.deps) return recusado(FORA_DO_AMBIENTE);
    let alvo: Alvo | null;
    try {
      alvo = await this.alvo(tx, ref, this.deps);
    } catch (err) {
      const motivo = recusaDaMeta(err, 'leitura');
      if (motivo) return recusado(motivo);
      throw err;
    }
    if (!alvo) return recusado(SUMIU);
    const { lido, conta, token, objeto, deps } = alvo;

    const mudanca = mudancaPedida(lido.estado, desired);
    // Já está como o pedido queria (a tentativa anterior caiu depois de a Meta aceitar, ou alguém fez o mesmo): nada a escrever.
    if (mudanca.tipo === 'nada') return { ok: true, state: { ...lido.estado, conferido: true, sem_escrita: true }, version: lido.versao };
    // Alguém mexeu no objeto desde o pedido: a mudança humana vence, nada é sobrescrito.
    if (lido.versao !== expectedVersion) return { ok: false, reason: 'estado-mudou', current: { state: lido.estado, version: lido.versao } };
    if (mudanca.tipo === 'invalida') return recusado(mudanca.motivo);

    // Perto do limite de uso da conta, a escrita espera: passar do limite bloqueia a conta inteira por um tempo.
    if (lido.usoPct >= USO_PARA_ESPERAR_PCT) {
      throw new ErroConector('limite', PROVIDER, `uso da conta na Meta em ${Math.round(lido.usoPct)}%`, null, Math.max(lido.esperarMs, ESPERA_COM_USO_ALTO_MS), 'uso_alto');
    }

    const versao = await deps.versao('entity_update');
    const params = options.validateOnly ? { ...mudanca.params, execution_options: JSON.stringify(['validate_only']) } : mudanca.params;
    try {
      const resposta = await deps.cliente().requisitar<{ success?: boolean } | null>({
        provider: PROVIDER,
        conta: conta.external_id,
        url: this.endereco(deps, versao, objeto.externalId, token, params),
        metodo: 'POST',
        endpoint: 'entity_update',
        apiVersion: versao,
        cabecalhos: { authorization: `Bearer ${token}` },
        // Na conta de pontos da Meta, a escrita vale 3 e a leitura 1.
        custo: 3,
      });
      if (resposta.corpo?.success !== true) return recusado('A Meta não confirmou a mudança. Nada foi dado como feito: confira o objeto na Meta.');
    } catch (err) {
      const motivo = recusaDaMeta(err);
      if (motivo) return recusado(motivo);
      throw err;
    }
    if (options.validateOnly) return { ok: true, state: desired, version: lido.versao };

    // Confere depois: lê de novo e compara com o pedido. A Meta já aceitou; se a leitura ainda não mostra, fica anotado.
    const depois = await this.conferir(deps, conta, token, objeto, desired);
    if (!depois.conferido) this.logger.warn(`ação em ${objeto.tipo} ${objeto.externalId}: a Meta aceitou, mas a leitura depois não confirmou a mudança`);
    // A versão em que a ação deixa o objeto: é com ela que a volta confere se alguém mexeu depois. Sem a confirmação da
    // leitura, vale a do estado pedido (a Meta aceitou a escrita), e não a de uma leitura atrasada.
    const aceito = { ...lido.estado, status: desired.status as SituacaoDoObjeto, daily_budget_micros: (desired.daily_budget_micros ?? null) as number | null };
    return { ok: true, state: { ...depois.estado, conferido: depois.conferido }, version: versaoDoEstado(depois.conferido ? depois.estado : aceito) };
  }

  /** Lê depois da escrita, até duas vezes. Falha de leitura aqui não desfaz nada: a mudança foi aceita. */
  private async conferir(deps: DependenciasDaEscritaMeta, conta: Conta, token: string, objeto: Objeto, desired: ResourceState): Promise<{ estado: EstadoDoObjeto; conferido: boolean }> {
    let ultimo: EstadoDoObjeto | null = null;
    for (let tentativa = 0; tentativa < 2; tentativa++) {
      if (tentativa > 0) await esperar(deps.esperaDaConferenciaMs ?? 1_500);
      try {
        const lido = await this.lerNaMeta(deps, conta, token, objeto);
        if (lido) {
          ultimo = lido.estado;
          if (mudancaPedida(lido.estado, desired).tipo === 'nada') return { estado: lido.estado, conferido: true };
        }
      } catch (err) {
        if (!(err instanceof ErroConector)) throw err;
      }
    }
    // Sem a confirmação, o resultado guarda o que foi lido por último (ou o pedido, se nem deu para ler).
    return { estado: ultimo ?? (desired as EstadoDoObjeto), conferido: false };
  }
}

export const metaAnunciosConnector = new MetaAnunciosConnector();
