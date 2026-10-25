import type { AvisoConfigurado, CorrecaoDoAviso } from '../connectors/asaas/api-asaas.js';
import { API_PREFIX } from '../setup-constants.js';

// O aviso do Liame no Asaas (A7, W2a, parte 3a; D-A7-28 e D-A7-33; `base-conhecimento.md` §18.5): o próprio Liame cria o
// webhook dele pela API, com o envio em sequência, e uma vez por dia confere se ele segue como deve (ligado, com a fila
// andando, com o token, no endereço da API e com os eventos que a releitura usa). Sem banco e sem rede: o worker lista os
// avisos da conta, chama `planoDoAviso` e faz o que ele disser.

/** O nome do aviso do Liame na conta do Asaas: é por ele (ou pelo endereço) que o Liame reconhece o seu. */
export const NOME_DO_AVISO = 'Liame';

/** A rota que recebe o aviso (`inbox/aviso-do-asaas.controller.ts`). */
export const CAMINHO_DO_AVISO = `/${API_PREFIX}/billing/asaas/webhook`;

/** O envio em sequência (criar webhook pela API, 13/10/2026): a ordem dos eventos fica. */
export const ENVIO_EM_SEQUENCIA = 'SEQUENTIALLY';

/**
 * Os eventos que mudam o que a releitura decide (`cobranca/releitura.ts`; eventos do `POST /v3/webhooks`, 08/09/2026): a
 * cobrança paga (no PIX, `RECEIVED`; no cartão, `CONFIRMED`), mudada, removida ou restaurada no painel, o recebimento em
 * dinheiro desfeito, os estornos (a devolução da parte 3b) e as disputas do cartão (W2b). Ficam de fora a cobrança criada
 * (quem cria é o Liame), a vencida (o atraso conta pelo relógio do Liame, W3) e os de boleto, checkout, análise de risco,
 * antecipação, negativação e divisão, que o Liame não usa. O aviso é só sinal (D-A7-28): o evento a mais custa uma
 * releitura, e o que falta é coberto pela releitura diária.
 */
export const EVENTOS_DO_AVISO: readonly string[] = [
  'PAYMENT_CONFIRMED',
  'PAYMENT_RECEIVED',
  'PAYMENT_UPDATED',
  'PAYMENT_DELETED',
  'PAYMENT_RESTORED',
  'PAYMENT_RECEIVED_IN_CASH_UNDONE',
  'PAYMENT_REFUNDED',
  'PAYMENT_PARTIALLY_REFUNDED',
  'PAYMENT_REFUND_IN_PROGRESS',
  'PAYMENT_REFUND_DENIED',
  'PAYMENT_CHARGEBACK_REQUESTED',
  'PAYMENT_CHARGEBACK_DISPUTE',
  'PAYMENT_AWAITING_CHARGEBACK_REVERSAL',
];

/** O endereço público do aviso: a origem da API (`API_URL`) com a rota. */
export function enderecoDoAviso(apiUrl: string): string {
  return `${new URL(apiUrl).origin}${CAMINHO_DO_AVISO}`;
}

/** O que estava fora do lugar no aviso do Liame, em código (para o log). */
export type MotivoDoAviso = 'fila_parada' | 'desligado' | 'sem_token' | 'endereco' | 'nome' | 'envio' | 'eventos';

export type PlanoDoAviso = {
  /** Os avisos do Liame a mais (o mesmo nome ou o mesmo endereço): saem, e fica um só. */
  remover: string[];
} & (
  /** A conta não tem o aviso do Liame: nasce. */
  | { acao: 'criar' }
  /** O aviso existe e está como deve. */
  | { acao: 'em_dia'; id: string }
  /** O aviso existe com algo fora do lugar: o `PUT` corrige (e leva o token). */
  | { acao: 'corrigir'; id: string; correcao: CorrecaoDoAviso; motivos: MotivoDoAviso[] }
);

/** O mesmo endereço, comparado pela forma normalizada (V33), nunca pelo texto cru. */
function mesmoEndereco(a: string, b: string): boolean {
  try {
    return new URL(a).href === new URL(b).href;
  } catch {
    return false;
  }
}

const mesmosEventos = (a: readonly string[], b: readonly string[]): boolean => {
  const x = new Set(a);
  const y = new Set(b);
  return x.size === y.size && [...x].every((e) => y.has(e));
};

/**
 * O que fazer com os avisos da conta. O do Liame é o que tem o nome dele ou o endereço da rota: o endereço que mudou (a API
 * em outro domínio) volta ao certo, e o repetido (dois workers criando ao mesmo tempo) sai. Fica o que já está no endereço
 * certo, ligado e com a fila andando; depois, o do endereço certo; depois, o primeiro da lista.
 */
export function planoDoAviso(avisos: readonly AvisoConfigurado[], url: string): PlanoDoAviso {
  const doLiame = avisos.filter((a) => a.nome === NOME_DO_AVISO || mesmoEndereco(a.url, url));
  if (doLiame.length === 0) return { acao: 'criar', remover: [] };
  const fica =
    doLiame.find((a) => mesmoEndereco(a.url, url) && a.ligado && !a.filaParada) ?? doLiame.find((a) => mesmoEndereco(a.url, url)) ?? doLiame[0]!;
  const remover = doLiame.filter((a) => a.id !== fica.id).map((a) => a.id);

  const correcao: CorrecaoDoAviso = {};
  const motivos: MotivoDoAviso[] = [];
  if (fica.filaParada) {
    correcao.interrupted = false;
    motivos.push('fila_parada');
  }
  if (!fica.ligado) {
    correcao.enabled = true;
    motivos.push('desligado');
  }
  // O token vai em toda correção (`atualizarAviso`): sem ele, basta corrigir.
  if (!fica.autenticado) motivos.push('sem_token');
  if (!mesmoEndereco(fica.url, url)) {
    correcao.url = url;
    motivos.push('endereco');
  }
  if (fica.nome !== NOME_DO_AVISO) {
    correcao.name = NOME_DO_AVISO;
    motivos.push('nome');
  }
  if (fica.envio !== ENVIO_EM_SEQUENCIA) {
    correcao.sendType = ENVIO_EM_SEQUENCIA;
    motivos.push('envio');
  }
  if (!mesmosEventos(fica.eventos, EVENTOS_DO_AVISO)) {
    correcao.events = [...EVENTOS_DO_AVISO];
    motivos.push('eventos');
  }
  return motivos.length === 0 ? { acao: 'em_dia', id: fica.id, remover } : { acao: 'corrigir', id: fica.id, correcao, motivos, remover };
}
