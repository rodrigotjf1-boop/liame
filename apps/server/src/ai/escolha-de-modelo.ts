import { custoMicros, type PrecoModelo, type TokensUsados } from './precos.js';

/**
 * A escolha do modelo no Pro (A3, I13; D-A3-12; protótipo P7, aprovado em 03/10/2026; D-A3-25 a D-A3-28): as regras puras.
 * O catálogo (`ai_model_option`) é por tarefa; a escolha (`ai_model_choice`) é por finalidade. Um modelo entra numa
 * finalidade só quando TODAS as tarefas ativas dela o oferecem (a regra do catálogo curado, `evals/README.md`).
 */

/** A função da escolha do modelo no Pro (D-A3-12): desligada, a tela não troca nada e o gateway fica no automático. */
export const FLAG_DA_ESCOLHA_DE_MODELO = 'escolha_de_modelo';

export const FINALIDADES = ['conversa', 'analise', 'texto'] as const;
export type Finalidade = (typeof FINALIDADES)[number];
export const ehFinalidade = (v: string): v is Finalidade => (FINALIDADES as readonly string[]).includes(v);

/** O que a tela mostra de cada finalidade. */
export const NOME_DA_FINALIDADE: Record<Finalidade, string> = {
  conversa: 'Conversa e atendimento',
  analise: 'Análise e decisão',
  texto: 'Textos',
};

/** Quem usa cada tarefa (o funcionário de Sua equipe), para a tela dizer quem muda com a troca. */
const QUEM_USA: Record<string, string> = {
  conversa_lia: 'LIA',
  explicar_resultados: 'Analista de dados',
  estrategista_plano: 'Estrategista',
  compliance_revisao: 'Compliance',
  pesquisador_pagina: 'Pesquisador',
  criativo_texto: 'Criativo',
  crm_mensagem: 'CRM',
  social_resposta: 'Social media',
};

/** Os funcionários das tarefas, sem repetir e na ordem das tarefas; a tarefa sem dono conhecido fica de fora. */
export function quemUsa(tarefas: readonly string[]): string[] {
  return [...new Set(tarefas.map((t) => QUEM_USA[t]).filter((q): q is string => Boolean(q)))];
}

/**
 * O nome do modelo para a tela, a partir do id da Anthropic (`claude-<família>-<maior>-<menor>`, com a data no fim ou
 * não): o Sonnet 5.5 vira "Claude Sonnet 5.5". O id que não segue o formato volta como está. Nenhum id fica escrito
 * aqui (a regra do `ai-custo.spec.ts`): o modelo vem sempre da rota ou do catálogo.
 */
export function nomeDoModelo(model: string): string {
  const m = /^claude-([a-z]+)-(\d{1,2})(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(model);
  if (!m) return model;
  const familia = m[1]!.charAt(0).toUpperCase() + m[1]!.slice(1);
  return `Claude ${familia} ${m[2]}${m[3] ? `.${m[3]}` : ''}`;
}

export type Opcao = { task: string; provider: string; model: string; label: string; speed: string; eval_score: string };

export type OpcaoDaFinalidade = { provider: string; model: string; label: string; speed: string; evalScore: string };

/**
 * Os modelos que a finalidade oferece: os que estão no catálogo de TODAS as tarefas dela (sem tarefa, nenhum). A nota é
 * a menor entre as tarefas (o pior caso). A ordem é a do nome.
 */
export function opcoesDaFinalidade(tarefas: readonly string[], catalogo: readonly Opcao[]): OpcaoDaFinalidade[] {
  if (!tarefas.length) return [];
  const porModelo = new Map<string, Opcao[]>();
  for (const o of catalogo) {
    if (!tarefas.includes(o.task)) continue;
    const k = `${o.provider}/${o.model}`;
    porModelo.set(k, [...(porModelo.get(k) ?? []), o]);
  }
  const ofertas: OpcaoDaFinalidade[] = [];
  for (const lista of porModelo.values()) {
    if (new Set(lista.map((o) => o.task)).size !== tarefas.length) continue;
    const pior = lista.reduce((a, b) => (Number(b.eval_score) < Number(a.eval_score) ? b : a));
    ofertas.push({ provider: pior.provider, model: pior.model, label: pior.label, speed: pior.speed, evalScore: pior.eval_score });
  }
  return ofertas.sort((a, b) => a.label.localeCompare(b.label, 'pt-BR'));
}

/** Tokens somados de um grupo de chamadas (por região de processamento). */
export type TokensDoGrupo = { geo: 'us' | 'global'; input: number; cacheRead: number; cacheWrite: number; output: number };

/**
 * Quanto as chamadas da janela teriam custado com um modelo, pela faixa comum do preço dele (D-A3-28). A faixa do prompt
 * longo depende do tamanho de CADA pedido, e aqui os tokens vêm somados: ela fica de fora, e a tela chama de estimativa.
 * Sem preço do modelo, nulo (a tela não mostra número inventado).
 */
export function estimarCusto(preco: PrecoModelo | undefined, grupos: readonly TokensDoGrupo[]): bigint | null {
  if (!preco) return null;
  const comum: PrecoModelo = { input: preco.input, output: preco.output, cacheRead: preco.cacheRead, cacheWrite5m: preco.cacheWrite5m, cacheWrite1h: preco.cacheWrite1h };
  return grupos.reduce((soma, g) => {
    const tokens: TokensUsados = { input: g.input, cacheRead: g.cacheRead, cacheWrite: g.cacheWrite, output: g.output, reasoning: 0 };
    return soma + custoMicros(comum, tokens, { geo: g.geo });
  }, 0n);
}
