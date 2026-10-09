import { setTimeout as esperar } from 'node:timers/promises';
import type { Tx } from '@liame/database';
import { Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { canonicalJson, sha256 } from '../audit/audit.js';
import type { CredencialGuardada } from '../connections/oauth.js';
import { type ClienteConector, ErroConector } from '../connectors/cliente-http.js';
import { emMenorUnidade } from '../connectors/meta/verba.js';
import { soDigitos } from '../connectors/validacao.js';
import type { ApplyOptions, ApplyResult, Connector, PreparedRead, ReadResult, ResourceRef } from './connectors.js';
import { motivoDoCompartilhado, type OrcamentoDaCampanha, orcamentoCompartilhado } from './orcamento-compartilhado.js';
import { motivoDaRecusa } from './resposta-da-plataforma.js';
import type { ResourceState } from './tools.js';

// Escrita no Google Ads pelo Action Service (A5, Y2; base de conhecimento §3.1, reconferida em 08/10/2026): mudar a
// situação (ativar e pausar) de uma campanha e a verba diária dela. Só depois da aprovação de uma pessoa, com a flag
// `google_write` ligada para a conta. Desde a Y3 (09/10/2026) o conector está no registro e as ferramentas de verba,
// pausar e retomar campanha o aceitam; a flag nasce desligada para todos.
//
// O recurso é a campanha no Google: `resource_id` = `campanha:<id>`; `account_id` é a conta conectada no Liame. A
// campanha precisa estar na lista que o Liame leu dessa conta, e a leitura no Google é feita dentro dela.
//
// - No Google, a verba não mora na campanha: mora num ORÇAMENTO (`campaign_budget`), que a campanha aponta e que pode
//   servir a várias campanhas. O Liame só muda o orçamento diário que é de uma campanha só. Orçamento compartilhado
//   (criado para ser dividido, ou usado por mais de uma campanha) nunca é alterado (D-A5-4, critério A5-6): mudar a
//   verba de uma campanha mudaria a das outras sem ninguém pedir. O estado diz que é compartilhado e quantas dividem.
// - O estado é lido NO GOOGLE logo antes de planejar e de escrever. A versão sai do próprio estado (a situação, a
//   verba e qual é o orçamento).
// - Toda escrita passa antes pela validação do Google (`validateOnly`), que não muda nada e só devolve erros; a recusa
//   dela vira "recusado", com o motivo, e não se tenta de novo (critério A5-5).
// - Se alguém mudou a campanha desde o pedido, nada é sobrescrito. Se ela já está como o pedido queria, não há o que
//   fazer.
// - O limite de operações do Google é do projeto da Liame, para todas as empresas juntas. Por isso a escrita de cada
//   empresa tem uma cota diária própria, bem abaixo do total: esgotada, a ação espera (critério A5-7). O limite que o
//   próprio Google responder e a falha passageira sobem como `ErroConector`: quem executa adia, em vez de insistir.
// - O token de acesso é trocado na hora, a partir do que está no cofre, e nunca vai para log, estado ou auditoria.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROVIDER = 'google_ads';

/** Operações de escrita (e as leituras dela) que uma empresa pode fazer por dia no Google, de um total de 2.880 do projeto. */
export const OPERACOES_DE_ESCRITA_POR_DIA = 300;
/** O balde da cota diária por empresa: enche devagar, ao longo do dia. */
export const BALDE_DA_ESCRITA_GOOGLE = { capacidade: OPERACOES_DE_ESCRITA_POR_DIA, porSegundo: OPERACOES_DE_ESCRITA_POR_DIA / 86_400 };
/** Quantos nomes a tela do pedido recebe, no máximo, das outras campanhas que dividem a verba. */
export const CAMPANHAS_NA_VERBA_DIVIDIDA = 10;
/** O limite diário do Google não volta em um minuto: a ação espera pelo menos isto. */
const ESPERA_DO_LIMITE_DIARIO_MS = 60 * 60_000;

export type SituacaoDaCampanha = 'ativo' | 'pausado' | 'removido' | 'desconhecido';
const SITUACAO: Record<string, SituacaoDaCampanha> = { ENABLED: 'ativo', PAUSED: 'pausado', REMOVED: 'removido' };
const NO_GOOGLE: Partial<Record<SituacaoDaCampanha, string>> = { ativo: 'ENABLED', pausado: 'PAUSED' };

// O orçamento da campanha e o motivo de não mexer no compartilhado moram em `orcamento-compartilhado.ts` (o registro de
// ferramentas usa os mesmos); saem por aqui também, para quem já importava.
export { motivoDoCompartilhado, type OrcamentoDaCampanha };

/** O estado de uma campanha do Google, como o Action Service o guarda no pedido (os mesmos campos da Meta, mais o orçamento). */
export type EstadoDaCampanhaGoogle = {
  tipo: 'campanha';
  /** O id da campanha no Google. */
  id: string;
  nome: string;
  status: SituacaoDaCampanha;
  /** A situação de entrega que o Google informa (`primary_status`: ELIGIBLE, PAUSED, LIMITED…). */
  status_efetivo: string | null;
  /** A verba diária que é SÓ desta campanha, em micros; nula com orçamento compartilhado, de período ou sem orçamento. */
  daily_budget_micros: number | null;
  /** A verba de período (o total da campanha), em micros; não muda pelo Liame. */
  lifetime_budget_micros: number | null;
  moeda: string | null;
  orcamento: OrcamentoDaCampanha | null;
};

/** `campanha:123` → o id no Google (só dígitos: ele entra no caminho da URL e na consulta). */
export function campanhaDoRecurso(resourceId: string): string | null {
  const m = /^campanha:(\d{1,20})$/.exec(resourceId);
  return m ? m[1]! : null;
}

/**
 * A versão do estado, tirada dele mesmo: muda quando a situação, a verba ou o orçamento da campanha mudam (outro
 * orçamento, ou o mesmo passando a ser dividido), e só então. Cabe na coluna inteira do pedido e nunca é zero.
 */
export function versaoDaCampanha(e: Pick<EstadoDaCampanhaGoogle, 'status' | 'daily_budget_micros' | 'lifetime_budget_micros' | 'orcamento'>): number {
  const hash = sha256(
    canonicalJson({
      status: e.status,
      daily_budget_micros: e.daily_budget_micros,
      lifetime_budget_micros: e.lifetime_budget_micros,
      orcamento: e.orcamento ? { id: e.orcamento.id, compartilhado: e.orcamento.compartilhado, diario_micros: e.orcamento.diario_micros } : null,
    }),
  );
  return (Number.parseInt(hash.slice(0, 12), 16) % 2_147_483_646) + 1;
}

export type MudancaNoGoogle =
  /** A campanha já está como o pedido queria. */
  | { tipo: 'nada' }
  | { tipo: 'situacao'; status: string }
  | { tipo: 'verba'; orcamentoId: string; micros: number }
  | { tipo: 'invalida'; motivo: string };

/**
 * O que precisa mudar no Google para a campanha ficar como o pedido quer. Só a situação (ativa ou pausada) e a verba
 * diária do orçamento que é só dela mudam por aqui, uma coisa por pedido; o resto do estado desejado precisa ser igual
 * ao que o Google tem agora.
 */
export function mudancaPedida(atual: EstadoDaCampanhaGoogle, desejado: ResourceState): MudancaNoGoogle {
  if (desejado.tipo !== atual.tipo || desejado.id !== atual.id) return { tipo: 'invalida', motivo: 'O pedido não é desta campanha.' };
  const mudaSituacao = desejado.status !== atual.status;
  const mudaVerba = (desejado.daily_budget_micros ?? null) !== atual.daily_budget_micros;
  if ((desejado.lifetime_budget_micros ?? null) !== atual.lifetime_budget_micros) return { tipo: 'invalida', motivo: 'A verba de período não muda pelo Liame.' };
  if (!mudaSituacao && !mudaVerba) return { tipo: 'nada' };
  if (mudaSituacao && mudaVerba) return { tipo: 'invalida', motivo: 'Um pedido muda a situação ou a verba da campanha, não as duas de uma vez.' };

  if (mudaSituacao) {
    const alvo = typeof desejado.status === 'string' ? NO_GOOGLE[desejado.status as SituacaoDaCampanha] : undefined;
    if (!alvo) return { tipo: 'invalida', motivo: 'Pelo Liame, uma campanha só é ativada ou pausada.' };
    if (!NO_GOOGLE[atual.status]) return { tipo: 'invalida', motivo: 'A campanha foi removida no Google: não dá para mudar a situação dela.' };
    return { tipo: 'situacao', status: alvo };
  }

  // A verba. O orçamento compartilhado nunca é alterado, peça quem pedir (D-A5-4).
  if (atual.orcamento?.compartilhado) return { tipo: 'invalida', motivo: motivoDoCompartilhado(atual.orcamento) };
  if (!atual.orcamento || atual.daily_budget_micros === null) return { tipo: 'invalida', motivo: 'Esta campanha não tem verba diária própria: a verba dela é de período.' };
  const valor = desejado.daily_budget_micros;
  if (typeof valor !== 'number' || emMenorUnidade(valor, atual.moeda) === null) return { tipo: 'invalida', motivo: 'A verba diária precisa ser um valor positivo, sem fração de centavo.' };
  return { tipo: 'verba', orcamentoId: atual.orcamento.id, micros: valor };
}

/** O que a escrita precisa do resto do app; ligado na subida (API e worker). */
export type DependenciasDaEscritaGoogle = {
  lerSegredo: (tx: Tx, secretId: string) => Promise<string | null>;
  /** O cliente HTTP da escrita, com a cota diária por empresa. */
  cliente: () => ClienteConector;
  /** Endereço da Google Ads API (o oficial em produção). */
  googleAdsUrl: string;
  /** Troca o que está no cofre por um token de acesso curto (só na memória de quem vai chamar). */
  acesso: (refreshToken: string) => Promise<string>;
  /** A versão da API registrada para a capacidade (Capability Registry). */
  versao: (capacidade: 'entity_state' | 'entity_update') => Promise<string>;
  /** Quanto esperar para ler de novo quando a leitura depois da escrita ainda não mostra a mudança. */
  esperaDaConferenciaMs?: number;
  /** Quanto a leitura da hora do pedido espera o Google (há uma pessoa esperando). */
  tempoDaLeituraDoPedidoMs?: number;
};

/** A leitura da hora do pedido não espera o Google mais que isto: passou, a pessoa recebe "tente de novo", e nada é pedido. */
const TEMPO_DA_LEITURA_DO_PEDIDO_MS = 10_000;

type Conta = { id: string; tenant_id: string; external_id: string; currency: string | null; login_customer_id: string | null; credential_secret_id: string | null };
type LinhaDoGoogle = {
  campaign?: { id?: string | number; name?: string; status?: string; primaryStatus?: string; campaignBudget?: string };
  campaignBudget?: { id?: string | number; amountMicros?: string | number; totalAmountMicros?: string | number; explicitlyShared?: boolean; referenceCount?: string | number; period?: string };
};
type Lido = { estado: EstadoDaCampanhaGoogle; versao: number };
/** A parte do banco de uma leitura: a conta, a autorização dela e a campanha. Os tokens ficam só na memória de quem lê. */
type Preparada = PreparedRead & { conta: Conta; refreshToken: string; campanha: string; deps: DependenciasDaEscritaGoogle; accessToken?: string };

const recusado = (mensagem: string): ApplyResult => ({ ok: false, reason: 'recusado', mensagem });

const SEM_ACESSO = 'O Google recusou o acesso desta conta (a autorização foi revogada ou venceu). Conecte o Google de novo em Contas conectadas.';
const SEM_PERMISSAO = 'O Google recusou: o Liame não tem permissão para gerenciar as campanhas desta conta. Confira o acesso do usuário que autorizou à conta do Google Ads e conecte o Google de novo em Contas conectadas.';
const SUMIU = 'O Google não tem mais esta campanha nesta conta (foi removida, ou a conta foi desconectada). Nada foi mudado.';
const FORA_DO_AMBIENTE = 'A escrita no Google não está disponível neste ambiente.';

/**
 * A recusa definitiva do Google em palavras; nulo para o que é passageiro (limite, fora do ar): isso sobe para quem
 * executa adiar. `passo`: a leitura do estado antes de mudar, ou a mudança em si.
 */
export function recusaDoGoogle(err: unknown, passo: 'leitura' | 'escrita' = 'escrita'): string | null {
  if (!(err instanceof ErroConector)) return null;
  if (err.tipo === 'autenticacao') return SEM_ACESSO;
  if (err.tipo === 'permissao') return SEM_PERMISSAO;
  if (err.tipo !== 'definitivo') return null;
  // O texto do erro específico do Google, quando vem; senão, o do erro geral. Nenhum dos dois leva o token.
  const resposta = err.mensagemUsuario ?? err.message;
  // A recusa da mudança sai no formato que a resposta do pedido sabe separar (`resposta-da-plataforma.ts`).
  if (passo === 'escrita') return motivoDaRecusa('google_ads', resposta, err.subcodigo);
  const codigo = err.subcodigo ? ` (${err.subcodigo})` : '';
  return `O Google não deixou ler a campanha antes de mudar: ${resposta.replace(/[.!?]\s*$/, '')}${codigo}. Nada foi mudado.`;
}

/** O limite DIÁRIO de operações do projeto no Google (`QuotaError.RESOURCE_EXHAUSTED`): não volta em um minuto. */
function comEsperaDoLimiteDiario(err: unknown): unknown {
  if (!(err instanceof ErroConector) || err.tipo !== 'limite' || err.subcodigo !== 'quotaError.RESOURCE_EXHAUSTED') return err;
  return new ErroConector('limite', err.provider, err.message, err.status, Math.max(err.esperarMs ?? 0, ESPERA_DO_LIMITE_DIARIO_MS), err.codigoProvider, { subcodigo: err.subcodigo, mensagemUsuario: err.mensagemUsuario });
}

const inteiro = (v: string | number | undefined): number | null => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isSafeInteger(n) ? n : null;
};

/** A linha do Google → o estado da campanha. Nulo quando a linha não é da campanha pedida. */
export function estadoDaLinha(linha: LinhaDoGoogle, campanha: string, moeda: string | null): EstadoDaCampanhaGoogle | null {
  const c = linha.campaign;
  if (!c || String(c.id ?? '') !== campanha) return null;
  const b = linha.campaignBudget;
  const orcamentoId = b?.id !== undefined && soDigitos(String(b.id)) ? String(b.id) : null;
  const diario = b && (b.period ?? 'DAILY') === 'DAILY' ? inteiro(b.amountMicros) : null;
  const total = b ? inteiro(b.totalAmountMicros) : null;
  const campanhas = b ? (inteiro(b.referenceCount) ?? 1) : 0;
  const orcamento: OrcamentoDaCampanha | null = orcamentoId
    ? { id: orcamentoId, compartilhado: b!.explicitlyShared === true || campanhas > 1, campanhas, diario_micros: diario !== null && diario > 0 ? diario : null }
    : null;
  return {
    tipo: 'campanha',
    id: campanha,
    nome: typeof c.name === 'string' ? c.name : '',
    status: SITUACAO[c.status ?? ''] ?? 'desconhecido',
    status_efetivo: typeof c.primaryStatus === 'string' ? c.primaryStatus : null,
    daily_budget_micros: orcamento && !orcamento.compartilhado ? orcamento.diario_micros : null,
    lifetime_budget_micros: total !== null && total > 0 ? total : null,
    moeda,
    orcamento,
  };
}

const CAMPOS =
  'campaign.id, campaign.name, campaign.status, campaign.primary_status, campaign.campaign_budget, campaign_budget.id, campaign_budget.amount_micros, campaign_budget.total_amount_micros, campaign_budget.explicitly_shared, campaign_budget.reference_count, campaign_budget.period';

export class GoogleAnunciosConnector implements Connector {
  readonly provider = PROVIDER;
  readonly writeFlag = 'google_write';
  readonly requiresSpendLimits = true;
  private readonly logger = new Logger('escrita-google');
  private deps: DependenciasDaEscritaGoogle | null = null;

  ligar(deps: DependenciasDaEscritaGoogle): void {
    this.deps = deps;
  }

  /** A conta conectada da empresa, se o Liame leu esta campanha dela. */
  private async conta(tx: Tx, ref: ResourceRef, campanha: string): Promise<Conta | null> {
    if (!UUID.test(ref.accountId)) return null;
    const r = await tx.execute<Conta>(sql`
      select a.id, a.tenant_id, a.external_id, a.currency, a.provider_attributes->>'login_customer_id' as login_customer_id, a.credential_secret_id
        from liame.connected_account a
       where a.id = ${ref.accountId} and a.tenant_id = ${ref.tenantId} and a.provider = ${PROVIDER} and a.disconnected_at is null`);
    const conta = r.rows[0];
    if (!conta || !soDigitos(conta.external_id)) return null;
    const conhecida = await tx.execute(sql`select 1 from liame.campaign where connected_account_id = ${conta.id} and tenant_id = ${ref.tenantId} and external_id = ${campanha}`);
    return conhecida.rows[0] ? conta : null;
  }

  /** A parte do banco: a conta conectada da empresa que conhece a campanha, com a autorização dela. Nulo quando não é desta empresa. */
  private async preparar(tx: Tx, ref: ResourceRef, deps: DependenciasDaEscritaGoogle): Promise<Preparada | null> {
    const campanha = campanhaDoRecurso(ref.resourceId);
    const conta = campanha ? await this.conta(tx, ref, campanha) : null;
    if (!campanha || !conta) return null;
    const guardada = conta.credential_secret_id ? await deps.lerSegredo(tx, conta.credential_secret_id) : null;
    const credencial = guardada ? (JSON.parse(guardada) as CredencialGuardada) : null;
    if (!credencial || credencial.tipo !== 'google') throw new ErroConector('autenticacao', PROVIDER, 'autorização revogada ou ausente');
    return { conector: PROVIDER, conta, refreshToken: credencial.refresh_token, campanha, deps };
  }

  /** O token curto desta leitura ou escrita: trocado uma vez e reaproveitado nas chamadas seguintes da mesma ação. */
  private async acesso(p: Preparada): Promise<string> {
    p.accessToken ??= await p.deps.acesso(p.refreshToken);
    return p.accessToken;
  }

  private async cabecalhos(p: Preparada): Promise<Record<string, string>> {
    return {
      authorization: `Bearer ${await this.acesso(p)}`,
      ...(soDigitos(p.conta.login_customer_id) ? { 'login-customer-id': p.conta.login_customer_id } : {}),
    };
  }

  /** A chave da cota e do disjuntor da escrita: por empresa, à parte da leitura diária da conta. */
  private chave(p: Preparada): string {
    return `escrita:${p.conta.tenant_id}`;
  }

  /** Lê a campanha no Google, com o orçamento dela. Nulo quando o Google não a tem nesta conta. */
  private async lerNoGoogle(p: Preparada, tempoLimiteMs?: number): Promise<Lido | null> {
    const versao = await p.deps.versao('entity_state');
    try {
      const r = await p.deps.cliente().requisitar<Array<{ results?: LinhaDoGoogle[] }> | null>({
        provider: PROVIDER,
        conta: this.chave(p),
        url: `${p.deps.googleAdsUrl}/${versao}/customers/${p.conta.external_id}/googleAds:searchStream`,
        metodo: 'POST',
        corpo: { query: `SELECT ${CAMPOS} FROM campaign WHERE campaign.id = ${p.campanha}` },
        endpoint: 'entity_state',
        apiVersion: versao,
        cabecalhos: await this.cabecalhos(p),
        ...(tempoLimiteMs ? { tempoLimiteMs } : {}),
      });
      const linhas = Array.isArray(r.corpo) ? r.corpo.flatMap((lote) => lote.results ?? []) : [];
      for (const linha of linhas) {
        const estado = estadoDaLinha(linha, p.campanha, p.conta.currency);
        if (estado) return { estado, versao: versaoDaCampanha(estado) };
      }
      return null;
    } catch (err) {
      throw comEsperaDoLimiteDiario(err);
    }
  }

  /** A leitura da hora do pedido, com o tempo curto de quem tem uma pessoa esperando. A do executor é a de `apply`. */
  async read(tx: Tx, ref: ResourceRef): Promise<ReadResult | null> {
    // Sem as dependências ligadas (erro de montagem do app), não há o que ler: melhor estourar do que dizer "não existe".
    if (!this.deps) throw new Error('escrita no Google: dependências não ligadas');
    const p = await this.preparar(tx, ref, this.deps);
    const lido = p ? await this.lerNoGoogle(p, this.deps.tempoDaLeituraDoPedidoMs ?? TEMPO_DA_LEITURA_DO_PEDIDO_MS) : null;
    return lido ? { state: lido.estado, version: lido.versao } : null;
  }

  /** A leitura da hora do pedido em duas partes: esta é a do banco (rápida, na transação de quem chama). */
  async prepareRead(tx: Tx, ref: ResourceRef): Promise<PreparedRead | null> {
    if (!this.deps) throw new Error('escrita no Google: dependências não ligadas');
    return this.preparar(tx, ref, this.deps);
  }

  /** E esta, a do Google: sem transação aberta, com o mesmo tempo curto de quem tem uma pessoa esperando. */
  async readPrepared(prepared: PreparedRead): Promise<ReadResult | null> {
    if (prepared.conector !== PROVIDER) throw new Error('escrita no Google: leitura preparada por outro conector');
    const p = prepared as Preparada;
    const lido = await this.lerNoGoogle(p, p.deps.tempoDaLeituraDoPedidoMs ?? TEMPO_DA_LEITURA_DO_PEDIDO_MS);
    return lido ? { state: lido.estado, version: lido.versao } : null;
  }

  /**
   * As outras campanhas que usam o mesmo orçamento, pelo nome (base de conhecimento §3.1: `campaign.campaign_budget`
   * aceita filtro). Sem transação, com o tempo curto de quem tem uma pessoa esperando, e só quando o orçamento é
   * dividido. É detalhe da tela: se o Google não responder, a lista volta vazia, e a pessoa ainda lê quantas dividem
   * (o número veio com a campanha).
   */
  async sharedBudgetWith(prepared: PreparedRead, state: ResourceState): Promise<string[]> {
    if (prepared.conector !== PROVIDER) throw new Error('escrita no Google: leitura preparada por outro conector');
    const p = prepared as Preparada;
    const orcamento = orcamentoCompartilhado(state);
    if (!orcamento || !soDigitos(orcamento.id)) return [];
    const versao = await p.deps.versao('entity_state');
    // O id da conta, o do orçamento e o da campanha são só dígitos (conferidos): entram na consulta sem risco.
    const consulta =
      `SELECT campaign.id, campaign.name FROM campaign WHERE campaign.campaign_budget = 'customers/${p.conta.external_id}/campaignBudgets/${orcamento.id}'` +
      ` AND campaign.status != 'REMOVED' AND campaign.id != ${p.campanha} ORDER BY campaign.name LIMIT ${CAMPANHAS_NA_VERBA_DIVIDIDA}`;
    try {
      const r = await p.deps.cliente().requisitar<Array<{ results?: LinhaDoGoogle[] }> | null>({
        provider: PROVIDER,
        conta: this.chave(p),
        url: `${p.deps.googleAdsUrl}/${versao}/customers/${p.conta.external_id}/googleAds:searchStream`,
        metodo: 'POST',
        corpo: { query: consulta },
        endpoint: 'entity_state',
        apiVersion: versao,
        cabecalhos: await this.cabecalhos(p),
        tempoLimiteMs: p.deps.tempoDaLeituraDoPedidoMs ?? TEMPO_DA_LEITURA_DO_PEDIDO_MS,
      });
      const linhas = Array.isArray(r.corpo) ? r.corpo.flatMap((lote) => lote.results ?? []) : [];
      const nomes = linhas.flatMap((l) => (typeof l.campaign?.name === 'string' && l.campaign.name.trim() && String(l.campaign.id ?? '') !== p.campanha ? [l.campaign.name.trim()] : []));
      return nomes.slice(0, CAMPANHAS_NA_VERBA_DIVIDIDA);
    } catch (err) {
      if (!(err instanceof ErroConector)) throw err;
      this.logger.warn(`campanha ${p.campanha}: o Google não disse com quem a verba é dividida (${err.tipo}); o pedido segue sem os nomes`);
      return [];
    }
  }

  async apply(tx: Tx, ref: ResourceRef, desired: ResourceState, expectedVersion: number, options: ApplyOptions = {}): Promise<ApplyResult> {
    if (!this.deps) return recusado(FORA_DO_AMBIENTE);
    let p: Preparada | null;
    let lido: Lido | null;
    try {
      p = await this.preparar(tx, ref, this.deps);
      lido = p ? await this.lerNoGoogle(p) : null;
    } catch (err) {
      const motivo = recusaDoGoogle(err, 'leitura');
      if (motivo) return recusado(motivo);
      throw err;
    }
    if (!p || !lido) return recusado(SUMIU);

    const mudanca = mudancaPedida(lido.estado, desired);
    // Já está como o pedido queria (a tentativa anterior caiu depois de o Google aceitar, ou alguém fez o mesmo): nada a escrever.
    if (mudanca.tipo === 'nada') return { ok: true, state: { ...lido.estado, conferido: true, sem_escrita: true }, version: lido.versao };
    // Alguém mexeu na campanha desde o pedido: a mudança humana vence, nada é sobrescrito.
    if (lido.versao !== expectedVersion) return { ok: false, reason: 'estado-mudou', current: { state: lido.estado, version: lido.versao } };
    if (mudanca.tipo === 'invalida') return recusado(mudanca.motivo);

    const versao = await p.deps.versao('entity_update');
    const cliente = `customers/${p.conta.external_id}`;
    const pedido =
      mudanca.tipo === 'situacao'
        ? { recurso: 'campaigns', operacao: { updateMask: 'status', update: { resourceName: `${cliente}/campaigns/${p.campanha}`, status: mudanca.status } } }
        : { recurso: 'campaignBudgets', operacao: { updateMask: 'amount_micros', update: { resourceName: `${cliente}/campaignBudgets/${mudanca.orcamentoId}`, amountMicros: String(mudanca.micros) } } };
    try {
      const resposta = await p.deps.cliente().requisitar<{ results?: Array<{ resourceName?: string }> } | null>({
        provider: PROVIDER,
        conta: this.chave(p),
        url: `${p.deps.googleAdsUrl}/${versao}/${cliente}/${pedido.recurso}:mutate`,
        metodo: 'POST',
        corpo: { operations: [pedido.operacao], validateOnly: options.validateOnly === true },
        endpoint: options.validateOnly ? 'entity_update (validação)' : 'entity_update',
        apiVersion: versao,
        cabecalhos: await this.cabecalhos(p),
      });
      // A validação só devolve erros: sem erro, passou. A escrita de verdade devolve o recurso mudado.
      if (!options.validateOnly && resposta.corpo?.results?.[0]?.resourceName !== pedido.operacao.update.resourceName) {
        return recusado('O Google não confirmou a mudança. Nada foi dado como feito: confira a campanha no Google Ads.');
      }
    } catch (err) {
      const motivo = recusaDoGoogle(err);
      if (motivo) return recusado(motivo);
      throw comEsperaDoLimiteDiario(err);
    }
    if (options.validateOnly) return { ok: true, state: desired, version: lido.versao };

    // Confere depois: lê de novo e compara com o pedido. O Google já aceitou; se a leitura ainda não mostra, fica anotado.
    const depois = await this.conferir(p, desired);
    if (!depois.conferido) this.logger.warn(`ação na campanha ${p.campanha}: o Google aceitou, mas a leitura depois não confirmou a mudança`);
    // A versão em que a ação deixa a campanha: é com ela que a volta confere se alguém mexeu depois. Sem a confirmação da
    // leitura, vale a do estado pedido (o Google aceitou a escrita), e não a de uma leitura atrasada.
    const aceito: EstadoDaCampanhaGoogle =
      mudanca.tipo === 'situacao'
        ? { ...lido.estado, status: desired.status as SituacaoDaCampanha }
        : { ...lido.estado, daily_budget_micros: mudanca.micros, orcamento: { ...lido.estado.orcamento!, diario_micros: mudanca.micros } };
    return { ok: true, state: { ...depois.estado, conferido: depois.conferido }, version: versaoDaCampanha(depois.conferido ? depois.estado : aceito) };
  }

  /** Lê depois da escrita, até duas vezes. Falha de leitura aqui não desfaz nada: a mudança foi aceita. */
  private async conferir(p: Preparada, desired: ResourceState): Promise<{ estado: EstadoDaCampanhaGoogle; conferido: boolean }> {
    let ultimo: EstadoDaCampanhaGoogle | null = null;
    for (let tentativa = 0; tentativa < 2; tentativa++) {
      if (tentativa > 0) await esperar(p.deps.esperaDaConferenciaMs ?? 1_500);
      try {
        const lido = await this.lerNoGoogle(p);
        if (lido) {
          ultimo = lido.estado;
          if (mudancaPedida(lido.estado, desired).tipo === 'nada') return { estado: lido.estado, conferido: true };
        }
      } catch (err) {
        if (!(err instanceof ErroConector)) throw err;
      }
    }
    // Sem a confirmação, o resultado guarda o que foi lido por último (ou o pedido, se nem deu para ler).
    return { estado: ultimo ?? (desired as EstadoDaCampanhaGoogle), conferido: false };
  }
}

export const googleAnunciosConnector = new GoogleAnunciosConnector();
