import type { Tx } from '@liame/database';
import { sql } from 'drizzle-orm';
import { canonicalJson, sha256 } from '../audit/audit.js';
import type { CredencialGuardada } from '../connections/oauth.js';
import { type ClienteConector, ErroConector } from '../connectors/cliente-http.js';
import { dispararCampanha, pausarCampanha, planejarDisparo } from '../connectors/regemcast/conector-regemcast.js';
import type { CampanhaRegemcast, PlanoDoDisparoRegemcast } from '../connectors/regemcast/contrato-regemcast.js';
import type { ApplyOptions, ApplyResult, Connector, PreparedRead, ReadResult, ResourceRef } from './connectors.js';
import { type EstadoDaMensagem, faseDaMensagem } from './mensagem-plano.js';
import type { ResourceState } from './tools.js';

// O pedido de mensagem de WhatsApp pelo Action Service (A5, Y5; `plano-a5.md` D-A5-10 a D-A5-13): disparar uma campanha
// que o Liame montou em rascunho no RegemCast, e pausar o que ainda não saiu. Só depois da aprovação de uma pessoa, com
// a flag `whatsapp_campaign` ligada. Nesta entrega o conector NÃO está no registro (`CONNECTORS`): nenhum pedido chega a
// ele. Fica pronto e desligado, como o do Google ficou na Y2.
//
// O recurso é a campanha no RegemCast: `resource_id` = `mensagem:<id>`; `account_id` é a conta conectada do RegemCast.
//
// - O estado é o PLANO DO DISPARO, lido no RegemCast na hora (`campanha_disparo_planejar`, que não muda nada): quantas
//   pessoas, o custo estimado (teto), o orçamento de mensagens, o que impede e a confirmação. É o que a pessoa aprova.
// - A versão sai do plano: enquanto a campanha é rascunho, muda quando a confirmação muda (o público, o custo, o
//   orçamento ou a situação mudaram). Se o plano mudou entre o pedido e a execução, nada é disparado: é "estado mudou",
//   e a pessoa pede de novo, vendo os números novos. O RegemCast confere a mesma coisa do lado dele.
// - Depois do disparo, a versão só diz a fase (em andamento, pausada, fim): os números andam sozinhos enquanto a
//   campanha sai, e isso não é "alguém mexeu".
// - O disparo e a pausa levam a chave de idempotência do RegemCast, tirada do próprio pedido: repetir a execução (o
//   worker que caiu no meio) não dispara de novo.
// - Mensagem enviada não volta. A volta possível é pausar o que ainda não saiu; quem retoma é uma pessoa, no RegemCast.
// - O token da conta sai do cofre só na hora de chamar e nunca vai para log, estado ou auditoria. Nenhum telefone e
//   nenhum nome de contato passam por aqui.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROVIDER = 'regemcast';
const PREFIXO = 'mensagem:';

/** A leitura da hora do pedido não espera o RegemCast mais que isto: passou, a pessoa recebe "tente de novo". */
const TEMPO_DA_LEITURA_DO_PEDIDO_MS = 10_000;

/** `mensagem:<id>` → o id da campanha no RegemCast. */
export function mensagemDoRecurso(resourceId: string): string | null {
  if (!resourceId.startsWith(PREFIXO)) return null;
  const id = resourceId.slice(PREFIXO.length);
  return UUID.test(id) ? id.toLowerCase() : null;
}

/**
 * A versão do estado, tirada dele mesmo. No rascunho, muda quando o plano muda (a confirmação, as pessoas, o custo ou o
 * "pode disparar"). Depois do disparo, só a fase conta. Cabe na coluna inteira do pedido e nunca é zero.
 */
export function versaoDaMensagem(e: Pick<EstadoDaMensagem, 'situacao' | 'confirmacao' | 'pessoas' | 'custo_centavos' | 'pode_disparar'>): number {
  const fase = faseDaMensagem(e.situacao);
  const base = fase === 'rascunho' ? { fase, confirmacao: e.confirmacao, pessoas: e.pessoas, custo_centavos: e.custo_centavos, pode_disparar: e.pode_disparar } : { fase };
  return (Number.parseInt(sha256(canonicalJson(base)).slice(0, 12), 16) % 2_147_483_646) + 1;
}

const daCampanha = (c: CampanhaRegemcast) => ({
  id: c.id,
  nome: c.nome,
  situacao: c.situacao,
  modelo: c.modelo,
  categoria: c.categoria,
  publico: c.publico,
  destinatarios: c.destinatarios,
  pessoas: c.naFila,
  enviadas: c.enviadas,
});

/** O plano do disparo do RegemCast → o estado da mensagem. */
export function estadoDoPlano(p: PlanoDoDisparoRegemcast): EstadoDaMensagem {
  return {
    tipo: 'mensagem',
    ...daCampanha(p.campanha),
    moeda: p.custo?.moeda ?? null,
    custo_centavos: p.custo?.aSairCentavos ?? null,
    pode_disparar: p.podeDisparar,
    impedimentos: p.impedimentos,
    confirmacao: p.confirmacao,
    orcamento: {
      definido: p.orcamento.definido,
      periodos: p.orcamento.periodos.map((x) => ({ periodo: x.periodo, rotulo: x.rotulo, teto_centavos: x.tetoCentavos, gasto_centavos: x.gastoCentavos, sinal: x.sinal })),
      aviso: p.orcamento.aviso,
    },
  };
}

export type MudancaNaMensagem =
  /** A mensagem já está como o pedido queria. */
  | { tipo: 'nada' }
  | { tipo: 'disparar' }
  | { tipo: 'pausar' }
  | { tipo: 'invalida'; motivo: string };

/** O que precisa acontecer no RegemCast para a mensagem ficar como o pedido quer: disparar o rascunho, ou pausar o que está saindo. */
export function mudancaPedida(atual: EstadoDaMensagem, desejado: ResourceState): MudancaNaMensagem {
  if (desejado.tipo !== 'mensagem' || desejado.id !== atual.id) return { tipo: 'invalida', motivo: 'O pedido não é desta mensagem.' };
  const quer = faseDaMensagem(desejado.situacao);
  const esta = faseDaMensagem(atual.situacao);
  if (quer === 'andamento') {
    // Já saiu (a tentativa anterior caiu depois de o RegemCast aceitar, ou uma pessoa disparou pela tela dele): nada a fazer.
    if (esta === 'andamento' || atual.situacao === 'concluida') return { tipo: 'nada' };
    if (esta === 'rascunho') return { tipo: 'disparar' };
    if (esta === 'pausada') return { tipo: 'invalida', motivo: 'Esta mensagem já foi enviada e está pausada. Quem retoma é uma pessoa, no RegemCast.' };
    return { tipo: 'invalida', motivo: 'Esta mensagem foi cancelada no RegemCast: não dá para enviar.' };
  }
  if (quer === 'pausada') {
    if (esta === 'pausada') return { tipo: 'nada' };
    if (esta === 'andamento') return { tipo: 'pausar' };
    if (esta === 'rascunho') return { tipo: 'invalida', motivo: 'Esta mensagem ainda não foi enviada: não há o que pausar.' };
    return { tipo: 'invalida', motivo: 'O envio desta mensagem já terminou: não há o que pausar.' };
  }
  return { tipo: 'invalida', motivo: 'Pelo Liame, uma mensagem só é enviada ou pausada.' };
}

/** O que a escrita precisa do resto do app; ligado na subida (API e worker). */
export type DependenciasDaEscritaRegemcast = {
  lerSegredo: (tx: Tx, secretId: string) => Promise<string | null>;
  /** O cliente HTTP do pedido de mensagem. Com o tempo limite, é o da leitura que tem uma pessoa esperando. */
  cliente: (tempoLimiteMs?: number) => ClienteConector;
  /** O endereço do RegemCast (`REGEMCAST_API_URL`); nulo quando o ambiente não o tem. */
  apiUrl: string | null;
  /** Quanto a leitura da hora do pedido espera o RegemCast (há uma pessoa esperando). */
  tempoDaLeituraDoPedidoMs?: number;
};

type Conta = { id: string; tenant_id: string; external_id: string; credential_secret_id: string | null };
type Lido = { estado: EstadoDaMensagem; versao: number };
/** A parte do banco de uma leitura: a conta e o token dela. O token fica só na memória de quem lê. */
type Preparada = PreparedRead & { conta: Conta; token: string; campanha: string; apiUrl: string; deps: DependenciasDaEscritaRegemcast };

const recusado = (mensagem: string): ApplyResult => ({ ok: false, reason: 'recusado', mensagem });

const SEM_ACESSO = 'O RegemCast recusou o acesso desta conta (a conexão foi desligada lá, ou não vale mais). Conecte o RegemCast de novo em Contas conectadas.';
const SEM_PERMISSAO = 'A conexão com o RegemCast não inclui enviar mensagens. Quem dá essa permissão é o dono da conta, no RegemCast.';
const SUMIU = 'Esta mensagem não está mais disponível nesta conta do RegemCast (a conta foi desconectada). Nada foi enviado.';
const FORA_DO_AMBIENTE = 'O envio de mensagens pelo RegemCast não está disponível neste ambiente.';

/**
 * A recusa definitiva do RegemCast em palavras; nulo para o que é passageiro (limite, fora do ar): isso sobe para quem
 * executa adiar. A frase do RegemCast vem depois do nome da ferramenta (`campanha_disparar: …`), sem telefone nem token.
 */
export function recusaDoRegemcast(err: unknown, passo: 'leitura' | 'disparo' | 'pausa'): string | null {
  if (!(err instanceof ErroConector)) return null;
  if (err.tipo === 'autenticacao') return SEM_ACESSO;
  if (err.tipo === 'permissao') return SEM_PERMISSAO;
  if (err.tipo !== 'definitivo') return null;
  const frase = err.message.replace(/^[a-z_]+:\s*/, '').replace(/[.!?]\s*$/, '');
  if (passo === 'leitura') return `O RegemCast não deixou ler o plano do envio: ${frase}. Nada foi enviado.`;
  if (passo === 'pausa') return `O RegemCast não pausou o envio: ${frase}.`;
  return `O RegemCast recusou o envio: ${frase}. Nada foi enviado.`;
}

export class RegemcastMensagemConnector implements Connector {
  readonly provider = PROVIDER;
  readonly writeFlag = 'whatsapp_campaign';
  // O dinheiro das mensagens não é verba de mídia: vale o teto de gasto do próprio RegemCast, e não soma à Verba do mês (D-A5-12).
  readonly requiresSpendLimits = false;
  private deps: DependenciasDaEscritaRegemcast | null = null;

  ligar(deps: DependenciasDaEscritaRegemcast): void {
    this.deps = deps;
  }

  /** A parte do banco: a conta do RegemCast da empresa e o token dela. Nulo quando a conta não é desta empresa. */
  private async preparar(tx: Tx, ref: ResourceRef, deps: DependenciasDaEscritaRegemcast): Promise<Preparada | null> {
    const campanha = mensagemDoRecurso(ref.resourceId);
    if (!campanha || !UUID.test(ref.accountId)) return null;
    const r = await tx.execute<Conta>(sql`
      select a.id, a.tenant_id, a.external_id, a.credential_secret_id
        from liame.connected_account a
       where a.id = ${ref.accountId} and a.tenant_id = ${ref.tenantId} and a.provider = ${PROVIDER} and a.disconnected_at is null`);
    const conta = r.rows[0];
    if (!conta) return null;
    if (!deps.apiUrl) throw new ErroConector('transitorio', PROVIDER, 'o endereço do RegemCast não está configurado');
    const guardada = conta.credential_secret_id ? await deps.lerSegredo(tx, conta.credential_secret_id) : null;
    const credencial = guardada ? (JSON.parse(guardada) as CredencialGuardada) : null;
    const token = credencial?.tipo === 'regemcast' ? credencial.lojas.find((l) => l.loja_id === conta.external_id)?.token : undefined;
    if (!token) throw new ErroConector('autenticacao', PROVIDER, 'autorização revogada ou sem o token desta conta');
    return { conector: PROVIDER, conta, token, campanha, apiUrl: deps.apiUrl, deps };
  }

  /** A chave da cota e do disjuntor: à parte da leitura das conversas e da tela Mensagens da mesma conta. */
  private acesso(p: Preparada): { token: string; contaChave: string } {
    return { token: p.token, contaChave: `pedido:${p.conta.external_id}` };
  }

  /** O plano do disparo, lido no RegemCast. Não muda nada lá. */
  private async lerPlano(p: Preparada, tempoLimiteMs?: number): Promise<Lido> {
    const plano = await planejarDisparo({ cliente: p.deps.cliente(tempoLimiteMs), apiUrl: p.apiUrl }, { ...this.acesso(p), id: p.campanha });
    const estado = estadoDoPlano(plano);
    return { estado, versao: versaoDaMensagem(estado) };
  }

  /** A leitura da hora do pedido, com o tempo curto de quem tem uma pessoa esperando. A do executor é a de `apply`. */
  async read(tx: Tx, ref: ResourceRef): Promise<ReadResult | null> {
    if (!this.deps) throw new Error('escrita no RegemCast: dependências não ligadas');
    const p = await this.preparar(tx, ref, this.deps);
    if (!p) return null;
    const lido = await this.lerPlano(p, this.deps.tempoDaLeituraDoPedidoMs ?? TEMPO_DA_LEITURA_DO_PEDIDO_MS);
    return { state: lido.estado, version: lido.versao };
  }

  /** A leitura da hora do pedido em duas partes: esta é a do banco (rápida, na transação de quem chama). */
  async prepareRead(tx: Tx, ref: ResourceRef): Promise<PreparedRead | null> {
    if (!this.deps) throw new Error('escrita no RegemCast: dependências não ligadas');
    return this.preparar(tx, ref, this.deps);
  }

  /** E esta, a do RegemCast: sem transação aberta. */
  async readPrepared(prepared: PreparedRead): Promise<ReadResult | null> {
    if (prepared.conector !== PROVIDER) throw new Error('escrita no RegemCast: leitura preparada por outro conector');
    const p = prepared as Preparada;
    const lido = await this.lerPlano(p, p.deps.tempoDaLeituraDoPedidoMs ?? TEMPO_DA_LEITURA_DO_PEDIDO_MS);
    return { state: lido.estado, version: lido.versao };
  }

  async apply(tx: Tx, ref: ResourceRef, desired: ResourceState, expectedVersion: number, options: ApplyOptions = {}): Promise<ApplyResult> {
    if (!this.deps) return recusado(FORA_DO_AMBIENTE);
    let p: Preparada | null;
    let lido: Lido | null;
    try {
      p = await this.preparar(tx, ref, this.deps);
      lido = p ? await this.lerPlano(p) : null;
    } catch (err) {
      const motivo = recusaDoRegemcast(err, 'leitura');
      if (motivo) return recusado(motivo);
      throw err;
    }
    if (!p || !lido) return recusado(SUMIU);

    const mudanca = mudancaPedida(lido.estado, desired);
    // Já está como o pedido queria: nada a escrever (a tentativa anterior caiu depois de o RegemCast aceitar).
    if (mudanca.tipo === 'nada') return { ok: true, state: { ...lido.estado, sem_escrita: true }, version: lido.versao };
    // O plano mudou desde o pedido (o público, o custo, o orçamento), ou alguém mexeu na campanha: nada é enviado.
    if (lido.versao !== expectedVersion) return { ok: false, reason: 'estado-mudou', current: { state: lido.estado, version: lido.versao } };
    if (mudanca.tipo === 'invalida') return recusado(mudanca.motivo);

    const ctx = { cliente: p.deps.cliente(), apiUrl: p.apiUrl };
    if (mudanca.tipo === 'disparar') {
      const confirmacao = lido.estado.confirmacao;
      // Sem a confirmação não há disparo; e ela precisa ser a do plano que a pessoa aprovou.
      if (!lido.estado.pode_disparar || !confirmacao) return recusado(`O RegemCast não deixa enviar agora: ${lido.estado.impedimentos.join(' ') || 'o plano do envio veio sem a confirmação'}`);
      if (desired.confirmacao !== confirmacao) return { ok: false, reason: 'estado-mudou', current: { state: lido.estado, version: lido.versao } };
      if (options.validateOnly) return { ok: true, state: desired, version: lido.versao };
      try {
        // A chave sai do pedido (a conta, a campanha e o plano aprovado): a mesma execução repetida não dispara de novo.
        const chave = `liame:disparo:${sha256(canonicalJson([p.conta.id, p.campanha, confirmacao])).slice(0, 48)}`;
        const feito = await dispararCampanha(ctx, { ...this.acesso(p), chave, id: p.campanha, confirmacao });
        const estado: EstadoDaMensagem = {
          ...lido.estado,
          ...daCampanha(feito.campanha),
          moeda: feito.custo?.moeda ?? lido.estado.moeda,
          custo_centavos: feito.custo?.aSairCentavos ?? lido.estado.custo_centavos,
          pode_disparar: false,
          impedimentos: [],
          confirmacao: null,
        };
        // O RegemCast aceitou o disparo: a mensagem está em andamento, mesmo que a resposta ainda diga outra coisa.
        if (faseDaMensagem(estado.situacao) !== 'andamento' && estado.situacao !== 'concluida') estado.situacao = 'enviando';
        return { ok: true, state: estado, version: versaoDaMensagem(estado) };
      } catch (err) {
        const motivo = recusaDoRegemcast(err, 'disparo');
        if (motivo) return recusado(motivo);
        throw err;
      }
    }

    // Pausar: segura o que ainda não saiu.
    if (options.validateOnly) return { ok: true, state: desired, version: lido.versao };
    try {
      // A fila anda enquanto a campanha sai: a chave leva o tamanho dela, para uma segunda pausa (depois de alguém
      // retomar no RegemCast) não cair na resposta guardada da primeira.
      const chave = `liame:pausa:${sha256(canonicalJson([p.conta.id, p.campanha, lido.estado.pessoas, lido.estado.enviadas])).slice(0, 48)}`;
      const feito = await pausarCampanha(ctx, { ...this.acesso(p), chave, id: p.campanha });
      const estado: EstadoDaMensagem = { ...lido.estado, ...daCampanha(feito.campanha), pode_disparar: false, impedimentos: [], confirmacao: null };
      if (faseDaMensagem(estado.situacao) !== 'pausada') estado.situacao = 'pausada';
      return { ok: true, state: estado, version: versaoDaMensagem(estado) };
    } catch (err) {
      const motivo = recusaDoRegemcast(err, 'pausa');
      if (motivo) return recusado(motivo);
      throw err;
    }
  }
}

export const regemcastMensagemConnector = new RegemcastMensagemConnector();
