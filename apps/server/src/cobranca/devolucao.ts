import type { CobrancaAsaas } from '../connectors/asaas/api-asaas.js';
import { SITUACOES_PAGAS } from './releitura.js';

// A devolução na desistência em 7 dias (A7, W2a, parte 3b; Termos 11.1; `plano-a7.md` D-A7-19, D-A7-29 e D-A7-35 a
// D-A7-37; `base-conhecimento.md` §18.5). A desistência marca a devolução pedida nas faturas pagas (W1) e as põe na fila
// da releitura; a rotina relê a cobrança no Asaas e esta conta decide: pedir o estorno, esperar o que está em andamento,
// concluir (o estorno feito, `DONE`) ou parar para uma pessoa da distribuição. Sem banco e sem rede.
//
// O estorno só é pedido quando a cobrança, lida na hora, não tem estorno feito nem em andamento: a API não tem chave de
// idempotência, não diz o que acontece ao pedir de novo e, no PIX, aceita mais de um estorno até o total. Assim, a
// resposta que se perdeu (o Asaas estornou e a conexão caiu) aparece na leitura seguinte, e nada sai duas vezes.

/** O texto do estorno no Asaas (até 500 letras). */
export const DESCRICAO_DO_ESTORNO = 'Liame · desistência em 7 dias (Termos de Uso, 11.1): devolução integral';

/** O estorno feito: o único que conta como devolvido (estornos, 04/08/2026; D-A7-29). */
const FEITO = 'DONE';
/** O estorno cancelado: o valor não volta (estornos, 04/08/2026). */
const CANCELADO = 'CANCELLED';
/**
 * O estorno que espera alguém fora do Liame: a autorização de uma ação crítica na conta do Asaas (o token por SMS ou pelo
 * app; Security, lida em 29/10/2026) ou a do pagador. Ninguém no Liame resolve: a rotina chama a distribuição.
 */
export const ESPERAM_AUTORIZACAO: ReadonlySet<string> = new Set(['AWAITING_CRITICAL_ACTION_AUTHORIZATION', 'AWAITING_CUSTOMER_EXTERNAL_AUTHORIZATION']);
/** A cobrança com o estorno pedido ou em andamento no Asaas, mesmo antes de o estorno aparecer na lista. */
const COBRANCA_EM_ESTORNO: ReadonlySet<string> = new Set(['REFUND_REQUESTED', 'REFUND_IN_PROGRESS']);
/** A cobrança estornada (a situação dela; eventos para cobranças, 27/10/2026). */
const COBRANCA_ESTORNADA = 'REFUNDED';
/** A disputa do cartão: o dinheiro pode voltar por outro caminho, e ninguém pede estorno no meio dela. */
const EM_DISPUTA: ReadonlySet<string> = new Set(['CHARGEBACK_REQUESTED', 'CHARGEBACK_DISPUTE', 'AWAITING_CHARGEBACK_REVERSAL']);

/** O porquê, em código, de a devolução parar e chamar a distribuição (a coluna `charge_error`). */
export type ProblemaDaDevolucao =
  /** A fatura paga não tem a cobrança no Asaas, ou o Asaas não a encontra mais: a devolução é à mão. */
  | 'devolucao_sem_cobranca'
  /** A cobrança no Asaas não está paga, embora a fatura do Liame esteja: alguém confere antes de devolver. */
  | 'devolucao_sem_pagamento'
  /** A cobrança está em disputa no cartão. */
  | 'devolucao_em_disputa'
  /** O Asaas cancelou o estorno: pedir de novo sem saber por quê poderia repetir o cancelamento para sempre. */
  | 'devolucao_cancelada';

export type DecisaoDaDevolucao =
  /** Pedir o estorno: integral (`valorCentavos` nulo) ou o que falta, se parte já voltou. */
  | { acao: 'pedir'; valorCentavos: number | null }
  /** Há estorno em andamento: espera o aviso, ou a releitura. `autorizacao`: ele espera alguém fora do Liame. */
  | { acao: 'esperar'; autorizacao: boolean }
  /** O estorno está feito: a fatura vira devolvida. */
  | { acao: 'concluir' }
  /** Algo que só uma pessoa da distribuição resolve: grava o porquê e para. */
  | { acao: 'parar'; problema: ProblemaDaDevolucao };

/** Quanto já voltou: a soma dos estornos feitos. */
export function devolvidoCentavos(cobranca: Pick<CobrancaAsaas, 'estornos'>): number {
  return cobranca.estornos.filter((e) => e.situacao === FEITO).reduce((t, e) => t + e.valorCentavos, 0);
}

/**
 * O que fazer com a fatura de devolução pedida, depois de ler a cobrança dela no Asaas. `cobranca` nula = o Asaas não a
 * encontrou (404). O estorno de situação que o Liame não conhece conta como em andamento (V149): espera, nunca pede de novo.
 */
export function decidirDevolucao(cobranca: CobrancaAsaas | null): DecisaoDaDevolucao {
  if (!cobranca || cobranca.removida) return { acao: 'parar', problema: 'devolucao_sem_cobranca' };
  const devolvido = devolvidoCentavos(cobranca);
  if (cobranca.status === COBRANCA_ESTORNADA || devolvido >= cobranca.valorCentavos) return { acao: 'concluir' };
  const emAndamento = cobranca.estornos.filter((e) => e.situacao !== FEITO && e.situacao !== CANCELADO);
  if (emAndamento.length > 0 || COBRANCA_EM_ESTORNO.has(cobranca.status)) {
    return { acao: 'esperar', autorizacao: emAndamento.some((e) => ESPERAM_AUTORIZACAO.has(e.situacao)) };
  }
  if (EM_DISPUTA.has(cobranca.status)) return { acao: 'parar', problema: 'devolucao_em_disputa' };
  if (cobranca.estornos.some((e) => e.situacao === CANCELADO)) return { acao: 'parar', problema: 'devolucao_cancelada' };
  if (!SITUACOES_PAGAS.has(cobranca.status)) return { acao: 'parar', problema: 'devolucao_sem_pagamento' };
  // Devolução de 100% (D-A7-19): a cobrança inteira, ou o que falta dela se parte já voltou.
  return { acao: 'pedir', valorCentavos: devolvido > 0 ? cobranca.valorCentavos - devolvido : null };
}
