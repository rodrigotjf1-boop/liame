import type { CobrancaAsaas } from '../connectors/asaas/api-asaas.js';

// A releitura da cobrança no Asaas (A7, W2a, parte 2; `plano-a7.md` D-A7-28 a D-A7-30; `base-conhecimento.md` §18.5): o
// aviso do Asaas só marca a fatura para reler, e quem decide é esta conta, sobre o que a API devolve na hora (A7-2). Sem
// banco e sem rede: o worker lê, chama `decidirReleitura` e grava o que ela disser.

/** A cada quanto a cobrança é relida sem aviso: o aviso que se perdeu aparece no máximo um dia depois (D-A7-28). */
export const RELEITURA_DIARIA_MS = 24 * 3_600_000;

/**
 * O que conta como pago (D-A7-29): no PIX, `RECEIVED`; no cartão (W2b), `CONFIRMED`; e o `RECEIVED_IN_CASH`, que só
 * existe quando a própria distribuição confirma o recebimento no painel do Asaas.
 */
export const SITUACOES_PAGAS: ReadonlySet<string> = new Set(['RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH']);

/** O dinheiro voltou ou está em disputa: numa fatura em aberto do Liame, ninguém deveria ter feito isso. */
const SITUACOES_DE_ESTORNO: ReadonlySet<string> = new Set([
  'REFUNDED',
  'REFUND_REQUESTED',
  'REFUND_IN_PROGRESS',
  'CHARGEBACK_REQUESTED',
  'CHARGEBACK_DISPUTE',
  'AWAITING_CHARGEBACK_REVERSAL',
]);

/** A situação que o Liame grava quando ele mesmo removeu a cobrança no Asaas (o Asaas não tem uma: marca `deleted`). */
export const SITUACAO_REMOVIDA = 'DELETED';

/** O porquê, em código, de a releitura parar e chamar a distribuição (a coluna `charge_error`). */
export type ProblemaDaReleitura = 'valor_divergente' | 'referencia_divergente' | 'estornada_no_meio' | 'paga_apos_cancelar';

export type FaturaRelida = { id: string; status: string; amount_cents: string };

export type DecisaoDaReleitura =
  /** A fatura em aberto foi paga no Asaas: o pagamento entra pelo `pagarFatura`, com o dia que o Asaas informou. */
  | { acao: 'pagar'; pagoNoDia: string | null }
  /** Nada mudou: grava a situação e relê no dia seguinte (ou antes, se chegar um aviso). */
  | { acao: 'esperar' }
  /** A cobrança não vale mais para a fatura em aberto (removida no Asaas, ou com o valor de antes): sai, e nasce outra. */
  | { acao: 'refazer'; removerAntes: boolean }
  /** A fatura foi cancelada no Liame e a cobrança segue viva no Asaas: sai de lá, para ninguém pagar o que foi cancelado. */
  | { acao: 'remover' }
  /** A fatura cancelada já não tem cobrança viva: a fila acaba. */
  | { acao: 'encerrar' }
  /** Algo que só uma pessoa da distribuição resolve: grava o porquê e para de reler. */
  | { acao: 'parar'; problema: ProblemaDaReleitura };

/**
 * O que fazer com a fatura depois de ler a cobrança dela no Asaas. `cobranca` nula = o Asaas não a encontrou (404).
 * A situação que o Liame não conhece segue como "ainda não conferida" (V149): espera, nunca paga.
 */
export function decidirReleitura(fatura: FaturaRelida, cobranca: CobrancaAsaas | null): DecisaoDaReleitura {
  const viva = cobranca !== null && !cobranca.removida;
  const paga = viva && SITUACOES_PAGAS.has(cobranca.status);
  // A devolvida já teve o estorno feito conferido (W2a, parte 3b): o aviso que chega depois (`PAYMENT_REFUNDED`) só
  // encerra a fila. Antes, ela caía na regra da cancelada e parava com "paga depois de cancelar", um alarme falso.
  if (fatura.status === 'devolvida') return { acao: 'encerrar' };
  if (fatura.status === 'cancelada') {
    if (!viva) return { acao: 'encerrar' };
    if (paga || SITUACOES_DE_ESTORNO.has(cobranca.status)) return { acao: 'parar', problema: 'paga_apos_cancelar' };
    return { acao: 'remover' };
  }
  if (fatura.status !== 'aberta') return { acao: 'encerrar' };
  if (!viva) return { acao: 'refazer', removerAntes: false };
  if (cobranca.referencia !== fatura.id) return { acao: 'parar', problema: 'referencia_divergente' };
  if (SITUACOES_DE_ESTORNO.has(cobranca.status)) return { acao: 'parar', problema: 'estornada_no_meio' };
  const devido = Number(fatura.amount_cents);
  if (paga) return cobranca.valorCentavos >= devido ? { acao: 'pagar', pagoNoDia: cobranca.pagaNoDia } : { acao: 'parar', problema: 'valor_divergente' };
  // O valor da fatura mudou no Liame (a troca de plano reprecifica a mensalidade em aberto): a cobrança velha sai.
  if (cobranca.valorCentavos !== devido) return { acao: 'refazer', removerAntes: true };
  return { acao: 'esperar' };
}

/**
 * O instante do pagamento para o `pagarFatura`, que conta o dia no fuso da empresa (o dia do pagamento vira o dia do
 * vencimento, D-A7-21): meio-dia de São Paulo do dia que o Asaas informou (o mesmo dia em todos os fusos do Brasil),
 * nunca depois de agora; sem o dia, agora.
 */
export function pagoEmDaCobranca(pagoNoDia: string | null, agora: Date): Date {
  if (!pagoNoDia) return agora;
  const meioDia = new Date(`${pagoNoDia}T12:00:00-03:00`);
  if (Number.isNaN(meioDia.getTime())) return agora;
  return meioDia.getTime() < agora.getTime() ? meioDia : agora;
}
