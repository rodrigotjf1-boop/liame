import { generateText, NoObjectGeneratedError, Output } from 'ai';
import { PROMPT_EXPLICAR_RESULTADOS } from '../explicar/prompt.js';
import { Explicacao } from '../explicar/resposta.js';
import type { Esforco, ModelosIa } from '../modelos.js';
import { limparTexto } from '../sanitizar.js';
import { contextoDoCaso } from './avaliar.js';
import type { CasoDeEval } from './casos.js';

// A chamada de um caso de eval a um modelo de verdade: o MESMO prompt, o mesmo formato de resposta e a
// mesma limpeza de dado pessoal de produção. Não passa pelo gateway de propósito: eval não é uso de
// empresa nenhuma (não há flag, teto nem livro de uso a consultar); o custo dele sai no relatório do eval.

export interface AlvoDoEval {
  provider: string;
  model: string;
  effort?: Esforco | null;
  maxOutputTokens?: number;
  timeoutMs?: number;
}

export interface RespostaDoEval {
  /** O JSON da explicação, ou o texto cru quando o modelo saiu do formato (o avaliador reprova por `formato`). */
  saida: string;
  tokens: { entrada: number; saida: number };
}

export async function responderExplicacao(modelos: ModelosIa, alvo: AlvoDoEval, caso: CasoDeEval): Promise<RespostaDoEval> {
  const model = modelos.modelo(alvo.provider, alvo.model);
  if (!model) throw new Error(`eval: sem credencial para ${alvo.provider}`);
  const providerOptions = modelos.opcoes(alvo.provider, alvo.effort ?? null);
  try {
    const r = await generateText({
      model,
      instructions: limparTexto(PROMPT_EXPLICAR_RESULTADOS.content).texto,
      messages: [{ role: 'user', content: limparTexto(JSON.stringify(contextoDoCaso(caso))).texto }],
      maxOutputTokens: alvo.maxOutputTokens ?? 2000,
      abortSignal: AbortSignal.timeout(alvo.timeoutMs ?? 60_000),
      maxRetries: 2,
      telemetry: { isEnabled: false },
      output: Output.object({ schema: Explicacao }),
      ...(providerOptions ? { providerOptions } : {}),
    });
    return { saida: JSON.stringify(r.output), tokens: { entrada: r.totalUsage.inputTokens ?? 0, saida: r.totalUsage.outputTokens ?? 0 } };
  } catch (err) {
    if (NoObjectGeneratedError.isInstance(err)) return { saida: err.text ?? '', tokens: { entrada: err.usage?.inputTokens ?? 0, saida: err.usage?.outputTokens ?? 0 } };
    throw err;
  }
}
