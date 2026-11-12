import type { Tx } from '@liame/database';
import { Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { canonicalJson, sha256 } from '../audit/audit.js';
import { contaConectada } from '../connections/conectada.js';
import type { CredencialGuardada } from '../connections/oauth.js';
import { type ClienteConector, ErroConector } from '../connectors/cliente-http.js';
import type { AppConfig } from '../config.js';
import {
  dispararCampanha,
  pausarCampanha,
  PERMISSOES_DA_ESCRITA_PELO_CLIQUE,
  type PedidoPor,
  pedirDisparo,
  planejarDisparo,
  registrarAvisoNoRegemcast,
} from '../connectors/regemcast/conector-regemcast.js';
import { type CampanhaRegemcast, PEDIDO_EM_ABERTO, type PedidoDeAcaoRegemcast, type PlanoDoDisparoRegemcast } from '../connectors/regemcast/contrato-regemcast.js';
import {
  type AcessoAoRegemcast,
  comAcessoDaConta,
  type CredencialDaConta,
  credencialDaConta,
  ligacaoGrava,
  podeGravar,
  SO_LEITURA_PELA_AUTORIZACAO,
} from '../connectors/regemcast/credencial-da-conta.js';
import type { ApplyOptions, ApplyResult, Connector, PreparedRead, ReadResult, ResourceRef } from './connectors.js';
import { type EstadoDaMensagem, faseDaMensagem } from './mensagem-plano.js';
import type { RegraDoCupom } from './regem-cupom.js';
import type { ResourceState } from './tools.js';

// O pedido de mensagem de WhatsApp pelo Action Service (A5, Y5; `plano-a5.md` D-A5-10 a D-A5-13): disparar uma campanha
// que o Liame montou em rascunho no RegemCast, e pausar o que ainda não saiu. Só depois da aprovação de uma pessoa, com
// a flag `whatsapp_campaign` ligada. O conector está no registro (`CONNECTORS`) desde a parte 6 da Y5; sem a flag, que
// nasce desligada para todos, nenhum pedido passa do trilho.
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
// - O cupom da mensagem (D-A5-16; P15) nasce no Regem junto com o envio: depois da aprovação, ANTES do disparo. Se o
//   cupom não pode ser criado, nada é enviado: mensagem que cita um cupom que não existe é pior do que não enviar.

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
  /**
   * O cupom da mensagem, criado no Regem junto com o envio (D-A5-16). `conferir` não cria nada e devolve o motivo de
   * não poder criar, ou nulo; `criar` é idempotente (a mesma loja e a mesma regra devolvem o mesmo cupom). Sem isto,
   * a mensagem que leva cupom não sai.
   */
  cupom?: {
    conferir(tx: Tx, alvo: { tenantId: string; lojaId: string }): Promise<string | null>;
    criar(tx: Tx, alvo: { tenantId: string; lojaId: string; regra: RegraDoCupom }): Promise<{ ok: true; cupomId: string | null } | { ok: false; mensagem: string }>;
  };
  /**
   * Fixa as datas do cupom de um pedido no dia de hoje (o dia do envio, no fuso da loja do cupom), pelos mesmos dias
   * da regra, e devolve a regra que vale. Só fixa uma vez; grava numa transação à parte, que fica mesmo que a
   * execução caia depois: a nova tentativa cria o cupom com a mesma regra. Nulo quando o pedido não tem cupom.
   */
  fixarDatasDoCupom?: (alvo: { tenantId: string; pedidoId: string }) => Promise<RegraDoCupom | null>;
  /**
   * O aplicativo do Liame no DMS ID e o endereço do RegemCast: a conta ligada pela autorização por clique grava com o
   * token do DMS ID (Hub DMS F5, parte D). Sem isto, só a conta do token da distribuição grava.
   */
  config?: Pick<AppConfig, 'dmsId' | 'produtos' | 'apiUrl'>;
  /**
   * O segredo dos avisos de uma conexão (um por conexão, no cofre), criado na primeira vez; nulo sem a conexão ativa. É o
   * que a caixa de entrada confere no aviso assinado do RegemCast (`/v1/inbox/regemcast/<conexão>`).
   */
  segredoDaCaixa?: (tx: Tx, alvo: { tenantId: string; connectionId: string }) => Promise<string | null>;
  /** Desativa no Regem o cupom de uma mensagem que não vai sair (F5-5). Sem isto, a recusa pede para desativar à mão. */
  desativarCupom?: (tx: Tx, alvo: { tenantId: string; cupomId: string }) => Promise<{ ok: true } | { ok: false; mensagem: string }>;
};

type Conta = { id: string; tenant_id: string; external_id: string; credential_secret_id: string | null };
type Lido = { estado: EstadoDaMensagem; versao: number };
/** A parte do banco de uma leitura: a conta e a credencial dela. A credencial fica só na memória de quem lê. */
type Preparada = PreparedRead & { conta: Conta; credencial: CredencialDaConta; campanha: string; apiUrl: string; deps: DependenciasDaEscritaRegemcast };

/** A ferramenta do pedido ao destino (Hub DMS F5, parte D): a aprovação é de uma pessoa no RegemCast. */
export const FERRAMENTA_DO_PEDIDO_AO_DESTINO = 'mensagem_pedir_ao_destino';
/** A situação da mensagem no resultado do pedido ao destino: nada saiu ainda; uma pessoa aprova no RegemCast. */
export const SITUACAO_ESPERANDO_O_DESTINO = 'esperando_destino';
/** Quando a rotina lê o pedido aberto pela primeira vez (o aviso do destino, quando houver, adianta). */
export const PRIMEIRA_LEITURA_DO_PEDIDO_S = 300;

/** O motivo do pedido no destino, para a tela: o que quem recusou escreveu, ou o motivo do RegemCast. Nulo sem nenhum. */
export function motivoDoPedido(d: PedidoDeAcaoRegemcast['pedido']): string | null {
  const m = (d.motivo_da_recusa ?? d.motivo ?? '').replace(/\s+/g, ' ').trim();
  return m ? m.slice(0, 600) : null;
}
/** O que a pessoa lê quando a conta ligada pela autorização do dono tenta o disparo direto (pela ligação, só o pedido). */
const SO_PELO_PEDIDO_NO_DESTINO =
  'Esta conta do RegemCast foi ligada pela autorização do dono: o envio vai como pedido, aprovado por uma pessoa da conta no RegemCast. Nada foi enviado.';

const recusado = (mensagem: string): ApplyResult => ({ ok: false, reason: 'recusado', mensagem });

const SEM_ACESSO = 'O RegemCast recusou o acesso desta conta (a conexão foi desligada lá, ou não vale mais). Conecte o RegemCast de novo em Contas conectadas.';
const SEM_PERMISSAO = 'A conexão com o RegemCast não inclui enviar mensagens. Quem dá essa permissão é o dono da conta, no RegemCast.';
/** O código da recusa da conta ligada pela autorização do dono (só leitura, Hub DMS B1): ela tem frase própria. */
const SO_LEITURA = 'so-leitura';
const SUMIU = 'Esta mensagem não está mais disponível nesta conta do RegemCast (a conta foi desconectada). Nada foi enviado.';
const FORA_DO_AMBIENTE = 'O envio de mensagens pelo RegemCast não está disponível neste ambiente.';
const LOJA_SUMIU = 'A loja do cupom foi desconectada do Regem.';

/** O cupom que a mensagem leva e ainda não foi criado. */
type CupomPorCriar = { pedidoId: string; lojaId: string | null; codigo: string; regra: RegraDoCupom };

/**
 * A recusa definitiva do RegemCast em palavras; nulo para o que é passageiro (limite, fora do ar): isso sobe para quem
 * executa adiar. A frase do RegemCast vem depois do nome da ferramenta (`campanha_disparar: …`), sem telefone nem token.
 */
export function recusaDoRegemcast(err: unknown, passo: 'leitura' | 'disparo' | 'pausa' | 'pedido'): string | null {
  if (!(err instanceof ErroConector)) return null;
  if (err.tipo === 'autenticacao') return SEM_ACESSO;
  if (err.tipo === 'permissao') return err.codigoProvider === SO_LEITURA ? SO_LEITURA_PELA_AUTORIZACAO : SEM_PERMISSAO;
  if (err.tipo !== 'definitivo') return null;
  const frase = err.message.replace(/^[a-z_]+:\s*/, '').replace(/[.!?]\s*$/, '');
  if (passo === 'leitura') return `O RegemCast não deixou ler o plano do envio: ${frase}. Nada foi enviado.`;
  if (passo === 'pausa') return `O RegemCast não pausou o envio: ${frase}.`;
  if (passo === 'pedido') return `O RegemCast recusou o pedido de envio: ${frase}. Nada foi enviado.`;
  return `O RegemCast recusou o envio: ${frase}. Nada foi enviado.`;
}

export class RegemcastMensagemConnector implements Connector {
  readonly provider = PROVIDER;
  private readonly logger = new Logger('regemcast-mensagem');
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
    const r = await tx.execute<Conta & { conectada: boolean }>(sql`
      select a.id, a.tenant_id, a.external_id, a.credential_secret_id, ${contaConectada('a')} as conectada
        from liame.connected_account a
       where a.id = ${ref.accountId} and a.tenant_id = ${ref.tenantId} and a.provider = ${PROVIDER} and a.disconnected_at is null`);
    const linha = r.rows[0];
    if (!linha) return null;
    const { conectada, ...conta } = linha;
    if (!deps.apiUrl) throw new ErroConector('transitorio', PROVIDER, 'o endereço do RegemCast não está configurado');
    // A conta que o RegemCast recusou (401) não é usada: o pedido diz "conecte o RegemCast de novo" (achado A2 do Hub DMS).
    const guardada = conta.credential_secret_id && conectada ? await deps.lerSegredo(tx, conta.credential_secret_id) : null;
    const credencial = credencialDaConta(guardada ? (JSON.parse(guardada) as CredencialGuardada) : null, conta.external_id);
    if (!credencial) throw new ErroConector('autenticacao', PROVIDER, 'autorização revogada ou sem a credencial desta conta');
    // A conta ligada pela autorização do dono (Hub DMS, B1) lia só, até a F5. Na parte D, ela grava quando o dono ligou
    // as opcionais de gravar no RegemCast (o plano, o pedido e a pausa pedem `campanhas.disparar`) e o ambiente tem o
    // aplicativo do Liame no DMS ID; a flag da ferramenta e a da escrita são do trilho. O disparo direto, ela não faz
    // (`apply` recusa: pela ligação, só o pedido ao destino).
    const ligacaoDaParteD = ligacaoGrava(credencial, ['campanhas.disparar']) && Boolean(deps.config?.dmsId);
    if (!podeGravar(credencial) && !ligacaoDaParteD) {
      throw new ErroConector('permissao', PROVIDER, 'a conta foi ligada pela autorização do dono, que só libera leitura', null, null, SO_LEITURA);
    }
    return { conector: PROVIDER, conta, credencial, campanha, apiUrl: deps.apiUrl, deps };
  }

  /**
   * Chama o RegemCast com o acesso da conta: pelo token, direto; pela ligação, com o token do DMS ID das permissões de
   * gravar (à parte do das leituras). A chave da cota e do disjuntor fica à parte da leitura das conversas e da tela
   * Mensagens da mesma conta.
   */
  private chamar<T>(p: Preparada, fn: (a: AcessoAoRegemcast) => Promise<T>): Promise<T> {
    const contaChave = `pedido:${p.conta.external_id}`;
    if (p.credencial.via === 'token') return fn({ token: p.credencial.token, contaChave });
    if (!p.deps.config) throw new ErroConector('definitivo', PROVIDER, 'a ligação do RegemCast pede o aplicativo do Liame no DMS ID');
    return comAcessoDaConta(p.credencial, p.deps.config, contaChave, fn, PERMISSOES_DA_ESCRITA_PELO_CLIQUE);
  }

  /** O plano do disparo, lido no RegemCast. Não muda nada lá. */
  private async lerPlano(p: Preparada, tempoLimiteMs?: number): Promise<Lido> {
    const plano = await this.chamar(p, (a) => planejarDisparo({ cliente: p.deps.cliente(tempoLimiteMs), apiUrl: p.apiUrl }, { ...a, id: p.campanha }));
    const estado = estadoDoPlano(plano);
    return { estado, versao: versaoDaMensagem(estado) };
  }

  /** O cupom desta mensagem que ainda falta criar (do retrato do pedido); nulo quando ela não leva cupom, ou ele já nasceu. */
  private async cupomPorCriar(tx: Tx, p: Preparada): Promise<CupomPorCriar | null> {
    const r = await tx.execute<{ id: string; coupon_account_id: string | null; coupon_code: string | null; coupon_rule: RegraDoCupom | null; coupon_created_at: string | null }>(sql`
      select id, coupon_account_id, coupon_code, coupon_rule, coupon_created_at
        from liame.message_request
       where tenant_id = ${p.conta.tenant_id} and connected_account_id = ${p.conta.id} and campaign_id = ${p.campanha}`);
    const linha = r.rows[0];
    if (!linha?.coupon_code || !linha.coupon_rule || linha.coupon_created_at) return null;
    return { pedidoId: linha.id, lojaId: linha.coupon_account_id, codigo: linha.coupon_code, regra: linha.coupon_rule };
  }

  /**
   * Quem pediu, como o destino compara (F5-3): o funcionário de IA vai como agente; a pessoa, pelo resumo do e-mail
   * (SHA-256 do e-mail sem espaços e em minúsculas), nunca o e-mail. A pessoa sem e-mail legível: nulo (não se pede).
   */
  private async quemPediu(tx: Tx, options: ApplyOptions): Promise<PedidoPor | null> {
    if (options.actorType !== 'human') return { tipo: 'agente' };
    if (!options.requestedBy) return null;
    const r = await tx.execute<{ email: string }>(sql`select email from liame.app_user where id = ${options.requestedBy}`);
    const email = r.rows[0]?.email;
    return email ? { tipo: 'pessoa', pessoa: sha256(email.trim().toLowerCase()) } : null;
  }

  /**
   * O cupom que nasceu para a mensagem e não vai ser usado (o RegemCast recusou o pedido): desativado no Regem agora
   * (F5-5). Devolve o complemento da frase de recusa: o que foi feito, ou o "desative-o lá" de quando não deu.
   */
  private async desfazerCupom(tx: Tx, p: Preparada, cupom: CupomPorCriar | null, seNaoDer: string): Promise<string> {
    if (!cupom) return '';
    const r = await tx.execute<{ coupon_id: string | null }>(sql`
      select coupon_id from liame.message_request where id = ${cupom.pedidoId} and tenant_id = ${p.conta.tenant_id}`);
    const cupomId = r.rows[0]?.coupon_id;
    if (!cupomId || !p.deps.desativarCupom) return seNaoDer;
    const feito = await p.deps.desativarCupom(tx, { tenantId: p.conta.tenant_id, cupomId });
    if (!feito.ok) return seNaoDer;
    await tx.execute(sql`update liame.message_request set coupon_deactivated_at = now(), updated_at = now() where id = ${cupom.pedidoId} and tenant_id = ${p.conta.tenant_id}`);
    return ` O cupom ${cupom.codigo}, que tinha sido criado, foi desativado no Regem.`;
  }

  /**
   * Registra o aviso assinado do RegemCast para a conexão desta conta: a caixa `{API_URL}/v1/inbox/regemcast/<conexão>`
   * com o segredo dela (criado na primeira vez). Registrar de novo é idempotente lá e religa o aviso pausado. A falha só
   * vai para o log (o motivo, sem segredo): o pedido segue, e a leitura cobre o aviso que não vier.
   */
  private async registrarAviso(tx: Tx, p: Preparada, ctx: { cliente: ClienteConector; apiUrl: string }): Promise<void> {
    const apiPublica = p.deps.config?.apiUrl;
    if (!apiPublica || !p.deps.segredoDaCaixa) return;
    try {
      const r = await tx.execute<{ connection_id: string | null }>(sql`select connection_id from liame.connected_account where id = ${p.conta.id} and tenant_id = ${p.conta.tenant_id}`);
      const connectionId = r.rows[0]?.connection_id;
      if (!connectionId) return;
      // Num ponto de salvamento: a falha do cofre não estraga a transação do pedido.
      const segredoDaCaixa = p.deps.segredoDaCaixa;
      const segredo = await tx.transaction((sp) => segredoDaCaixa(sp as Tx, { tenantId: p.conta.tenant_id, connectionId }));
      if (!segredo) return;
      const url = `${apiPublica.replace(/\/+$/, '')}/v1/inbox/regemcast/${connectionId}`;
      await this.chamar(p, (a) => registrarAvisoNoRegemcast(ctx, { ...a, url, segredo }));
    } catch (err) {
      const motivo = err instanceof ErroConector ? `${err.tipo}${err.codigoProvider ? `:${err.codigoProvider}` : ''}: ${err.message}` : err instanceof Error ? err.name : 'erro';
      this.logger.warn(`conta ${p.conta.id}: o aviso do RegemCast não foi registrado (${motivo}); a leitura do pedido cobre`);
    }
  }

  /**
   * O pedido ao destino (Hub DMS F5, parte D; F5-9): com o cupom já criado, PEDE o disparo ao RegemCast. Nada sai agora;
   * uma pessoa da conta aprova lá. O pedido fica na mensagem (`destination_*`), e a rotina `pedidos-no-destino` o
   * acompanha. A chave sai do pedido (a conta, a campanha e o plano): a mesma execução repetida devolve o mesmo pedido.
   */
  private async pedirAoDestino(
    tx: Tx,
    p: Preparada,
    lido: Lido,
    a: { confirmacao: string; cupom: CupomPorCriar | null; cupomCriado: string; options: ApplyOptions },
  ): Promise<ApplyResult> {
    const pedidoPor = await this.quemPediu(tx, a.options);
    if (!pedidoPor) return recusado(`Não deu para saber quem pediu o envio, e o RegemCast precisa disso para quem pediu não aprovar o próprio pedido. Nada foi enviado.${await this.desfazerCupom(tx, p, a.cupom, a.cupomCriado)}`);
    const chave = `liame:pedido:${sha256(canonicalJson([p.conta.id, p.campanha, a.confirmacao])).slice(0, 48)}`;
    const ctx = { cliente: p.deps.cliente(), apiUrl: p.apiUrl };
    // O aviso assinado (`acao.alterada`): registrado antes do pedido, para a primeira mudança já chegar. Não segura o
    // pedido: sem ele, a rotina lê o pedido de 5 em 5 minutos (F5-7, "pela consulta se o aviso não chegar").
    await this.registrarAviso(tx, p, ctx);
    const cupom = a.cupom ? { codigo: a.cupom.codigo, ...(a.cupom.regra.nome ? { descricao: a.cupom.regra.nome.slice(0, 200) } : {}) } : undefined;
    let feito: PedidoDeAcaoRegemcast;
    try {
      feito = await this.chamar(p, (ac) => pedirDisparo(ctx, { ...ac, chave, id: p.campanha, confirmacao: a.confirmacao, pedidoPor, ...(cupom ? { cupom } : {}) }));
    } catch (err) {
      const motivo = recusaDoRegemcast(err, 'pedido');
      if (motivo) return recusado(`${motivo}${await this.desfazerCupom(tx, p, a.cupom, a.cupomCriado)}`);
      throw err;
    }
    const d = feito.pedido;
    const aberto = PEDIDO_EM_ABERTO.includes(d.situacao);
    // Aberto: a rotina lê de novo daqui a pouco (o aviso do destino adianta). Já final (a mesma chave devolveu um pedido
    // decidido): a rotina trata agora (o cupom de quem não saiu).
    await tx.execute(sql`
      update liame.message_request
         set destination_request_id = ${d.id}, destination_status = ${d.situacao}, destination_expires_at = ${d.vence_em}::timestamptz,
             destination_url = ${d.tela ?? null}, destination_reason = ${motivoDoPedido(d)},
             destination_requested_at = coalesce(destination_requested_at, now()), destination_checked_at = now(),
             destination_next_check_at = ${aberto ? sql`now() + ${`${PRIMEIRA_LEITURA_DO_PEDIDO_S} seconds`}::interval` : sql`now()`}, updated_at = now()
       where tenant_id = ${p.conta.tenant_id} and connected_account_id = ${p.conta.id} and campaign_id = ${p.campanha}`);
    const estado: EstadoDaMensagem = { ...lido.estado, situacao: SITUACAO_ESPERANDO_O_DESTINO, pode_disparar: false, impedimentos: [], confirmacao: null };
    return { ok: true, state: estado, version: versaoDaMensagem(estado) };
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
      const peloDestino = options.tool === FERRAMENTA_DO_PEDIDO_AO_DESTINO;
      // Pela ligação do clique, o disparo direto não existe (o RegemCast também o recusa): só o pedido ao destino.
      if (!peloDestino && p.credencial.via !== 'token') return recusado(SO_PELO_PEDIDO_NO_DESTINO);
      const confirmacao = lido.estado.confirmacao;
      // Sem a confirmação não há disparo; e ela precisa ser a do plano que a pessoa aprovou.
      if (!lido.estado.pode_disparar || !confirmacao) return recusado(`O RegemCast não deixa enviar agora: ${lido.estado.impedimentos.join(' ') || 'o plano do envio veio sem a confirmação'}`);
      if (desired.confirmacao !== confirmacao) return { ok: false, reason: 'estado-mudou', current: { state: lido.estado, version: lido.versao } };
      // O cupom da mensagem: conferido na validação e de novo na hora, e criado ANTES do disparo. Sem o cupom, nada sai.
      const cupom = await this.cupomPorCriar(tx, p);
      if (cupom) {
        const motivo = !p.deps.cupom ? 'A criação de cupom no Regem não está disponível neste ambiente.' : !cupom.lojaId ? LOJA_SUMIU : await p.deps.cupom.conferir(tx, { tenantId: p.conta.tenant_id, lojaId: cupom.lojaId });
        if (motivo) return recusado(`O cupom ${cupom.codigo} desta mensagem não pode ser criado no Regem. ${motivo} Nada foi enviado.`);
      }
      if (options.validateOnly) return { ok: true, state: desired, version: lido.versao };
      let cupomCriado = '';
      if (cupom && cupom.lojaId && p.deps.cupom) {
        // O cupom vale por tantos dias, contando o dia do envio: as datas são fixadas agora, uma vez, e gravadas à
        // parte ANTES de o cupom ser criado. A chave de idempotência do Regem sai da regra: a nova tentativa (em outro
        // dia, inclusive) precisa levar as mesmas datas, ou o Regem recusaria o código como já usado.
        const regra = (await p.deps.fixarDatasDoCupom?.({ tenantId: p.conta.tenant_id, pedidoId: cupom.pedidoId })) ?? cupom.regra;
        const nascido = await p.deps.cupom.criar(tx, { tenantId: p.conta.tenant_id, lojaId: cupom.lojaId, regra });
        if (!nascido.ok) return recusado(`O cupom ${cupom.codigo} desta mensagem não foi criado no Regem. ${nascido.mensagem} Nada foi enviado.`);
        await tx.execute(sql`
          update liame.message_request set coupon_id = ${nascido.cupomId}, coupon_created_at = now(), updated_at = now()
           where id = ${cupom.pedidoId} and tenant_id = ${p.conta.tenant_id}`);
        // Se o RegemCast recusar o disparo agora, o cupom já existe: a recusa diz isso.
        cupomCriado = ` O cupom ${cupom.codigo} já foi criado no Regem: se a mensagem não for enviada, desative-o lá.`;
      }
      if (peloDestino) return this.pedirAoDestino(tx, p, lido, { confirmacao, cupom, cupomCriado, options });
      try {
        // A chave sai do pedido (a conta, a campanha e o plano aprovado): a mesma execução repetida não dispara de novo.
        const chave = `liame:disparo:${sha256(canonicalJson([p.conta.id, p.campanha, confirmacao])).slice(0, 48)}`;
        const feito = await this.chamar(p, (a) => dispararCampanha(ctx, { ...a, chave, id: p.campanha, confirmacao }));
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
        if (motivo) return recusado(`${motivo}${cupomCriado}`);
        throw err;
      }
    }

    // Pausar: segura o que ainda não saiu.
    if (options.validateOnly) return { ok: true, state: desired, version: lido.versao };
    try {
      // A fila anda enquanto a campanha sai: a chave leva o tamanho dela, para uma segunda pausa (depois de alguém
      // retomar no RegemCast) não cair na resposta guardada da primeira.
      const chave = `liame:pausa:${sha256(canonicalJson([p.conta.id, p.campanha, lido.estado.pessoas, lido.estado.enviadas])).slice(0, 48)}`;
      const feito = await this.chamar(p, (a) => pausarCampanha(ctx, { ...a, chave, id: p.campanha }));
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
