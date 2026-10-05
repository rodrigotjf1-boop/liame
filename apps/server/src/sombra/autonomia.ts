import type { ActionProposal, AutonomyMode, AutonomyThresholds, PolicyDocument, PolicyRule } from '@liame/contracts';
import { chooseMode, type LoadedPolicy, type ModoEscolhido } from '../policy/engine.js';
import { type AcaoSombra, PORTOES } from './regras.js';

// Autonomia das ações da sombra (A3, I13; `ai-architecture.md` §4.1 e §4.2; protótipo P7, aguardando aprovação). O
// modo de cada ação numa conta é uma regra de autonomia da política (o motor escolhe a mais específica; sem regra,
// Sombra). A promoção de Sombra para Sugerir é proposta pelo sistema quando os cinco portões passam e aprovada por
// uma pessoa; aprovar e voltar para Sombra publicam a versão seguinte da política da marca. Na A3 nada é
// executado: Sugerir quer dizer que a recomendação aparece na Atenção, e quem muda na plataforma é a pessoa.
// Funções puras.

/** A ação da política de cada ferramenta da sombra (os códigos das permissões). */
export const ACAO_DA_FERRAMENTA: Record<AcaoSombra, string> = {
  orcamento_reduzir: 'orcamento.reduzir',
  campanha_pausar: 'campanha.pausar',
  orcamento_aumentar: 'orcamento.aumentar',
};

/** A ferramenta que executará a ação quando houver execução (A4): é com ela que casa uma regra com `tool`. */
const FERRAMENTA_DE_EXECUCAO: Record<AcaoSombra, string> = {
  orcamento_reduzir: 'orcamento_ajustar',
  campanha_pausar: 'campanha_pausar',
  orcamento_aumentar: 'orcamento_ajustar',
};

/** Depois de uma recusa (ou da volta para Sombra), quantas decisões comparáveis a mais até a próxima proposta. */
export const AMOSTRA_DEPOIS_DA_RECUSA = 30;

/**
 * Os portões a mais da passagem de Sugerir para Aprovação (A4, X3; proposta D-A4-25, a calibrar no piloto): nos pedidos
 * decididos mais recentes que nasceram de uma recomendação dele, quantos se olham e quantos precisam ter sido aprovados.
 * Nenhum dos aprovados pode ter terminado em erro.
 */
export const PORTOES_DA_APROVACAO = { pedidos: 10, aprovados: 8 } as const;

/** Depois de uma recusa (ou de voltar de Aprovação para Sugerir), quantos pedidos decididos a mais até a próxima proposta. */
export const PEDIDOS_DEPOIS_DA_RECUSA = 10;

/** Os portões como a API os mostra (a fonte é `PORTOES`, das regras da sombra, e `PORTOES_DA_APROVACAO`). */
export const LIMIARES_DA_AUTONOMIA: AutonomyThresholds = {
  sample_size: PORTOES.amostra,
  agreement_min_pct: PORTOES.concordanciaPorMil / 10,
  worse_max_pct: PORTOES.pioraPorMil / 10,
  regret_max_micros: '0',
  confidence_min_pct: PORTOES.confiancaPorMil / 10,
  sample_after_rejection: AMOSTRA_DEPOIS_DA_RECUSA,
  approval_requests: PORTOES_DA_APROVACAO.pedidos,
  approval_min_approved: PORTOES_DA_APROVACAO.aprovados,
  requests_after_rejection: PEDIDOS_DEPOIS_DA_RECUSA,
};

export interface AlvoDaAcao {
  tool: AcaoSombra;
  brandId: string;
  provider: string;
  /** A conta conectada (o mesmo id que o Action Service usa). */
  accountId: string;
  /** Na recomendação de verba: a verba diária de agora e a recomendada, em micros. */
  valorAtualMicros?: number | null;
  valorMicros?: number | null;
}

/** A ação da sombra como uma proposta para o motor de políticas (só para saber o modo: nada é pedido). */
export function propostaDaAcao(a: AlvoDaAcao): ActionProposal {
  return {
    tool: FERRAMENTA_DE_EXECUCAO[a.tool],
    action: ACAO_DA_FERRAMENTA[a.tool],
    brand_id: a.brandId,
    provider: a.provider,
    account_id: a.accountId,
    risk_level: a.tool === 'campanha_pausar' ? 'R1' : 'R3',
    budget_impact: a.tool === 'orcamento_aumentar' ? 'increase' : 'decrease',
    value_micros: a.valorMicros ?? null,
    current_value_micros: a.valorAtualMicros ?? null,
    categories: [],
    recent_count: 0,
    // Quem decide aqui é o funcionário de IA: a regra do que uma pessoa pede (`actor: 'human'`) não casa.
    actor: 'agent',
  };
}

/** O modo da ação nesta conta, e a política de onde ele vem. */
export function modoDaAcao(policies: LoadedPolicy[], a: AlvoDaAcao): ModoEscolhido {
  return chooseMode(policies, propostaDaAcao(a));
}

/**
 * Na A3 nada é executado: qualquer modo acima de Sombra (o de uma promoção, ou o que a empresa escreveu na política)
 * mostra a recomendação na Atenção, e quem muda na plataforma é a pessoa.
 */
export const mostraNaAtencao = (mode: AutonomyMode): boolean => mode !== 'SHADOW';

/**
 * É a regra só desta ação nesta conta (sem outro seletor)? É ela que a promoção e a volta para Sombra trocam. Desde a
 * A4 a regra leva `actor: 'agent'` (é o modo do funcionário de IA, não o do pedido de uma pessoa); a escrita antes
 * disso, sem o ator, também é ela e sai na troca.
 */
function ehRegraDaConta(rule: PolicyRule, action: string, account: string): boolean {
  if (rule.type !== 'autonomy') return false;
  const { type: _tipo, mode: _modo, action: acao, account: conta, actor, ...outros } = rule;
  return acao === action && conta === account && (actor === undefined || actor === 'agent') && Object.values(outros).every((v) => v === undefined);
}

/**
 * O documento da política da marca com a regra desta ação nesta conta trocada pelo modo novo. As outras regras
 * ficam como estão, na mesma ordem; a regra nova vai no fim. Voltar para Sombra escreve Sombra (e não apaga a
 * regra): assim a regra da marca, mais específica, vence uma regra mais larga da empresa. A regra vale só para o
 * funcionário de IA (`actor: 'agent'`): voltar para Sombra não põe em sombra o que uma pessoa pede. Os três modos
 * da A4 passam por aqui: Sombra, Sugerir e Aprovação (D-A4-4).
 */
export function comRegraDaConta(doc: PolicyDocument | null, alvo: { action: string; account: string; mode: ModoDoFuncionario }): PolicyDocument {
  const regras = (doc?.rules ?? []).filter((r) => !ehRegraDaConta(r, alvo.action, alvo.account));
  return { rules: [...regras, { type: 'autonomy', action: alvo.action, actor: 'agent', account: alvo.account, mode: alvo.mode }] };
}

export type VezDaProposta = 'propor' | 'retirar' | 'encerrar' | 'nada';

/**
 * O que fazer com a proposta de uma conta e ação depois do retrato do dia:
 *  - `propor`: os cinco portões passam, o modo é Sombra, não há pendente e a amostra chegou à que a última recusa pediu;
 *  - `retirar`: há uma pendente, mas os portões deixaram de passar ou o modo já não é Sombra;
 *  - `encerrar`: a aprovada perdeu efeito (o modo voltou para Sombra por outro caminho, como a tela de políticas);
 *  - `nada`.
 */
export function vezDaProposta(
  retrato: { sampleSize: number; missing: string[] },
  modo: AutonomyMode,
  ultima: { status: string; nextSampleSize: number | null } | null,
): VezDaProposta {
  const passa = retrato.missing.length === 0;
  if (ultima?.status === 'pendente') return passa && modo === 'SHADOW' ? 'nada' : 'retirar';
  if (ultima?.status === 'aprovada') return modo === 'SHADOW' ? 'encerrar' : 'nada';
  if (!passa || modo !== 'SHADOW') return 'nada';
  if (ultima && ultima.nextSampleSize !== null && retrato.sampleSize < ultima.nextSampleSize) return 'nada';
  return 'propor';
}

/** Para ordenar: quantos portões a ação já passou (de 0 a 5). */
export const portoesQuePassaram = (missing: readonly string[]): number => 5 - new Set(missing).size;

// ------------------------------------------------------------ de Sugerir para Aprovação (A4, X3)

/** Os modos em que o funcionário de IA trabalha na A4 (D-A4-4), do que faz menos para o que faz mais. */
export const MODOS_DO_FUNCIONARIO = ['SHADOW', 'SUGGEST', 'APPROVAL'] as const;
export type ModoDoFuncionario = (typeof MODOS_DO_FUNCIONARIO)[number];

/**
 * Voltar um passo (proposta D-A4-27): de Aprovação para Sugerir; de qualquer outro modo acima de Sombra, para Sombra
 * (o que valia antes da A4, e o que acontece com um modo que a empresa escreveu na política por conta própria).
 */
export const umPassoAtras = (modo: AutonomyMode): ModoDoFuncionario => (modo === 'APPROVAL' ? 'SUGGEST' : 'SHADOW');

/**
 * O desfecho de um pedido que nasceu de uma recomendação, para os portões da Aprovação: uma pessoa aprovou (e a
 * execução deu certo ou ainda vai acontecer), aprovou e a execução terminou em erro, recusou, ou ninguém decidiu no
 * prazo. Nulo: ainda esperando, ou retirado por quem pediu (não é uma decisão sobre a recomendação, e não conta).
 */
export type DesfechoDoPedido = 'aprovado' | 'aprovado_com_erro' | 'recusado' | 'expirado';

export function desfechoDoPedido(p: { status: string; recusado: boolean }): DesfechoDoPedido | null {
  if (p.status === 'aprovada' || p.status === 'executando' || p.status === 'executada') return 'aprovado';
  if (p.status === 'falhou') return 'aprovado_com_erro';
  if (p.status === 'expirada') return 'expirado';
  if (p.status === 'cancelada' && p.recusado) return 'recusado';
  return null;
}

export interface ProntidaoDaAprovacao {
  /** Quantos pedidos decididos entraram na conta (os mais recentes, até `PORTOES_DA_APROVACAO.pedidos`). */
  sampleSize: number;
  /** Quantos deles uma pessoa aprovou (inclui os que depois terminaram em erro). */
  approved: number;
  /** Quantos dos aprovados terminaram em erro. */
  failed: number;
  /** O que falta: `pedidos` (amostra), `aprovacao` (aprovados de menos) e `erro` (um aprovado terminou em erro); vazio = passou. */
  missing: string[];
}

/** Os portões da Aprovação, a partir dos desfechos dos pedidos decididos, do mais novo para o mais antigo. */
export function prontidaoDaAprovacao(desfechos: readonly DesfechoDoPedido[]): ProntidaoDaAprovacao {
  const recentes = desfechos.slice(0, PORTOES_DA_APROVACAO.pedidos);
  const failed = recentes.filter((d) => d === 'aprovado_com_erro').length;
  const approved = recentes.filter((d) => d === 'aprovado').length + failed;
  const missing: string[] = [];
  if (recentes.length < PORTOES_DA_APROVACAO.pedidos) missing.push('pedidos');
  if (approved < PORTOES_DA_APROVACAO.aprovados) missing.push('aprovacao');
  if (failed > 0) missing.push('erro');
  return { sampleSize: recentes.length, approved, failed, missing };
}

/**
 * O que fazer com a proposta de Sugerir para Aprovação de uma conta e ação:
 *  - `propor`: o modo Aprovação está disponível ali (a flag e a escrita ligadas, numa plataforma que o Liame escreve),
 *    os cinco portões da sombra passam, os da Aprovação também, o modo é Sugerir, não há pendente e os pedidos
 *    decididos chegaram ao número que a última recusa pediu;
 *  - `retirar`: há uma pendente, mas algo disso deixou de valer;
 *  - `encerrar`: a aprovada perdeu efeito (o modo saiu de Aprovação por outro caminho, como a tela de políticas);
 *  - `nada`.
 */
export function vezDaPropostaDeAprovacao(
  p: { disponivel: boolean; passamOsCinco: boolean; pedidos: ProntidaoDaAprovacao; decididos: number },
  modo: AutonomyMode,
  ultima: { status: string; nextRequestCount: number | null } | null,
): VezDaProposta {
  const passa = p.disponivel && p.passamOsCinco && p.pedidos.missing.length === 0;
  if (ultima?.status === 'pendente') return passa && modo === 'SUGGEST' ? 'nada' : 'retirar';
  if (ultima?.status === 'aprovada') return modo === 'APPROVAL' ? 'nada' : 'encerrar';
  if (!passa || modo !== 'SUGGEST') return 'nada';
  if (ultima && ultima.nextRequestCount !== null && p.decididos < ultima.nextRequestCount) return 'nada';
  return 'propor';
}
