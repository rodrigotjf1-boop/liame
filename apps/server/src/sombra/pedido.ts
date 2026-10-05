import { SEM_DECIMAIS } from '../connectors/meta/verba.js';
import { ACAO_DA_FERRAMENTA } from './autonomia.js';
import type { AcaoSombra } from './regras.js';

// O pedido que nasce de uma recomendação (A4, X3; `plano-a4.md` §3). Em Sugerir, a recomendação do Gestor de tráfego
// aparece na Atenção e a pessoa pede a mudança pelo Liame; o pedido passa pelo mesmo trilho de qualquer outro
// (política, limites da empresa, aprovação com o código do app, validação na plataforma) e fica ligado à recomendação.
// Aqui fica só a conta: qual pedido corresponde a uma recomendação, e se um pedido confere com ela. Funções puras.

/** As plataformas em que o Liame muda campanha por pedido (a escrita no Google chega na A5). */
const PLATAFORMAS_COM_PEDIDO: readonly string[] = ['meta_ads'];

/** O menor valor de verba diária que um pedido aceita (o mesmo das ferramentas: 1 unidade da moeda). */
const VERBA_MINIMA_MICROS = 1_000_000n;

export type SentidoDaVerba = 'reduzir' | 'aumentar';

/**
 * A verba diária depois de mudar `percent` por cento, na menor unidade da moeda da conta (centavos no real). O
 * arredondamento vai sempre para o lado da verba de agora: a mudança nunca passa do percentual recomendado, que é o
 * limite por pedido da política. Nulo quando não há o que pedir (sem verba, percentual fora de 1 a 99, ou o
 * arredondamento não muda nada).
 */
export function verbaRecomendada(atualMicros: bigint | null, percent: number | null, sentido: SentidoDaVerba, moeda: string | null): bigint | null {
  if (atualMicros === null || atualMicros <= 0n || percent === null || !Number.isInteger(percent) || percent < 1 || percent > 99) return null;
  const unidade = moeda && SEM_DECIMAIS.has(moeda) ? 1_000_000n : 10_000n;
  const vezesCem = atualMicros * BigInt(sentido === 'reduzir' ? 100 - percent : 100 + percent);
  const passo = unidade * 100n;
  const nova = (sentido === 'reduzir' ? (vezesCem + passo - 1n) / passo : vezesCem / passo) * unidade;
  if (nova === atualMicros || nova < VERBA_MINIMA_MICROS || nova > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return nova;
}

export interface RecomendacaoParaPedir {
  tool: AcaoSombra;
  provider: string;
  /** O id da campanha na plataforma. */
  campanhaExterna: string;
  /** A verba diária que a campanha tem agora, em micros; nula quando a verba não mora na campanha. */
  verbaDiariaMicros: bigint | null;
  /** Só nas de verba: quanto a regra recomendou mudar, em porcento. */
  percent: number | null;
  /** A moeda da conta de anúncio. */
  moeda: string | null;
}

/** O que vai no corpo de `POST /v1/actions` (com a conta e a plataforma, que quem chama já tem). */
export interface PedidoDaRecomendacao {
  tool: string;
  resource_id: string;
  params: Record<string, unknown>;
}

/** O objeto do pedido de uma recomendação: a campanha, pelo id dela na plataforma. Nulo se o id não serve de recurso. */
export const recursoDaCampanha = (campanhaExterna: string): string | null => (/^\d{1,25}$/.test(campanhaExterna) ? `campanha:${campanhaExterna}` : null);

/**
 * O pedido que corresponde à recomendação, ou nulo quando não dá para pedir por aqui: a plataforma não é escrita pelo
 * Liame, a campanha não tem verba diária própria, ou a conta da verba não muda nada.
 */
export function pedidoDaRecomendacao(r: RecomendacaoParaPedir): PedidoDaRecomendacao | null {
  if (!PLATAFORMAS_COM_PEDIDO.includes(r.provider)) return null;
  const recurso = recursoDaCampanha(r.campanhaExterna);
  if (!recurso) return null;
  if (r.tool === 'campanha_pausar') return { tool: 'campanha_pausar', resource_id: recurso, params: {} };
  const nova = verbaRecomendada(r.verbaDiariaMicros, r.percent, r.tool === 'orcamento_reduzir' ? 'reduzir' : 'aumentar', r.moeda);
  return nova === null ? null : { tool: 'orcamento_ajustar', resource_id: recurso, params: { daily_budget_micros: Number(nova) } };
}

/** O que a recomendação e o pedido têm de ter em comum para o pedido ficar ligado a ela. */
export interface RecomendacaoDoPedido {
  tool: AcaoSombra;
  status: string;
  provider: string;
  connectedAccountId: string;
  campanhaExterna: string;
}

export type FalhaDaLigacao = { codigo: 'recomendacao-encerrada' | 'recomendacao-nao-confere'; detalhe: string };

const O_QUE_E: Record<AcaoSombra, string> = {
  campanha_pausar: 'pausar a campanha',
  orcamento_reduzir: 'reduzir a verba',
  orcamento_aumentar: 'aumentar a verba',
};

/**
 * O alvo do pedido é o da recomendação? Ela precisa estar em aberto e ser da mesma conta e da mesma campanha. Confere-se
 * antes de ler a plataforma: pedido que não é da recomendação não gasta chamada. Nulo = confere.
 */
export function alvoDaRecomendacao(r: RecomendacaoDoPedido, pedido: { provider: string; accountId: string; resourceId: string }): FalhaDaLigacao | null {
  if (r.status !== 'aberta') {
    return { codigo: 'recomendacao-encerrada', detalhe: 'Esta recomendação já foi avaliada ou saiu da lista. Se a mudança ainda fizer sentido, peça sem ela.' };
  }
  if (r.provider !== pedido.provider || r.connectedAccountId !== pedido.accountId || recursoDaCampanha(r.campanhaExterna) !== pedido.resourceId) {
    return { codigo: 'recomendacao-nao-confere', detalhe: 'O pedido não é da campanha desta recomendação.' };
  }
  return null;
}

/**
 * O pedido vai na direção da recomendação? `acaoDoPlano` é a ação que a ferramenta planejou com o estado lido na
 * plataforma (`orcamento.reduzir`, `campanha.pausar`…). O valor pode ser outro: a pessoa ajusta, dentro dos limites da
 * política. Nulo = confere.
 */
export function direcaoDaRecomendacao(tool: AcaoSombra, acaoDoPlano: string): FalhaDaLigacao | null {
  if (ACAO_DA_FERRAMENTA[tool] === acaoDoPlano) return null;
  return { codigo: 'recomendacao-nao-confere', detalhe: `A recomendação é de ${O_QUE_E[tool]}, e este pedido faz outra coisa. Peça sem ligar à recomendação.` };
}
