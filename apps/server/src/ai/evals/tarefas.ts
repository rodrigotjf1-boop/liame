import type { ModelosIa } from '../modelos.js';
import { type Avaliacao, avaliarExplicacao } from './avaliar.js';
import { type CasoDeEval, carregarCasos } from './casos.js';
import { avaliarConversa, type CasoDaConversa, carregarCasosDaConversa } from './conversa.js';
import { avaliarPlano, type CasoDoPlano, carregarCasosDoPlano } from './plano.js';
import { type AlvoDoEval, type RespostaDoEval, responderExplicacao } from './responder.js';
import { responderConversa } from './responder-conversa.js';
import { responderPlano } from './responder-plano.js';

// As tarefas com eval (A3, I3, I10c e I11c): como ler os casos, qual é a saída gravada (a boa ou a primeira ruim), como
// avaliar e como chamar um modelo de verdade. Os arquivos do promptfoo (`evals/apoio`) escolhem pelo nome da tarefa.

export interface TarefaDeEval<C extends { id: string; grupo: string }> {
  carregar(caminho: string): C[];
  /** A saída gravada no caso: a boa, ou a primeira ruim (para provar que o portão reprova); sem ruim, a boa. */
  gravada(caso: C, qual: 'boa' | 'ruim'): unknown;
  avaliar(caso: C, saida: unknown): Avaliacao;
  responder(modelos: ModelosIa, alvo: AlvoDoEval, caso: C): Promise<RespostaDoEval>;
}

const explicar: TarefaDeEval<CasoDeEval> = {
  carregar: carregarCasos,
  gravada: (caso, qual) => (qual === 'ruim' ? (caso.gravadas.ruins[0]?.resposta ?? caso.gravadas.boa) : caso.gravadas.boa),
  avaliar: avaliarExplicacao,
  responder: responderExplicacao,
};

const conversa: TarefaDeEval<CasoDaConversa> = {
  carregar: carregarCasosDaConversa,
  gravada: (caso, qual) => {
    const ruim = qual === 'ruim' ? caso.gravadas.ruins[0] : undefined;
    return ruim ? { chamadas: ruim.chamadas, resposta: ruim.resposta } : caso.gravadas.boa;
  },
  avaliar: avaliarConversa,
  responder: responderConversa,
};

const plano: TarefaDeEval<CasoDoPlano> = {
  carregar: carregarCasosDoPlano,
  gravada: (caso, qual) => {
    const ruim = qual === 'ruim' ? caso.gravadas.ruins[0] : undefined;
    return ruim ? { chamadas: ruim.chamadas, resposta: ruim.resposta } : caso.gravadas.boa;
  },
  avaliar: avaliarPlano,
  responder: responderPlano,
};

export const TAREFAS: Record<string, TarefaDeEval<{ id: string; grupo: string }>> = {
  explicar_resultados: explicar as unknown as TarefaDeEval<{ id: string; grupo: string }>,
  conversa_lia: conversa as unknown as TarefaDeEval<{ id: string; grupo: string }>,
  estrategista_plano: plano as unknown as TarefaDeEval<{ id: string; grupo: string }>,
};
