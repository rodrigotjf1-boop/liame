import { generateText, NoObjectGeneratedError, Output } from 'ai';
import type { ModelosIa } from '../modelos.js';
import { mensagemDoRevisor, Parecer } from '../revisor/parecer.js';
import { PROMPT_REVISOR } from '../revisor/prompt.js';
import { limparTexto } from '../sanitizar.js';
import type { AlvoDoEval, RespostaDoEval } from './responder.js';
import { type CasoDoRevisor, textoDoCaso } from './revisor.js';

// Um caso de eval do revisor num modelo de verdade: o MESMO prompt, a mesma mensagem (o texto em JSON) e o mesmo schema
// da produção, sem ferramenta nenhuma e com a mesma limpeza de dado pessoal. Não passa pelo gateway, como os outros
// evals: eval não é uso de empresa nenhuma; o custo sai no relatório do eval.

export async function responderParecer(modelos: ModelosIa, alvo: AlvoDoEval, caso: CasoDoRevisor): Promise<RespostaDoEval> {
  const model = modelos.modelo(alvo.provider, alvo.model);
  if (!model) throw new Error(`eval: sem credencial para ${alvo.provider}`);
  const providerOptions = modelos.opcoes(alvo.provider, alvo.effort ?? null);
  try {
    const r = await generateText({
      model,
      instructions: PROMPT_REVISOR.content,
      messages: [{ role: 'user', content: limparTexto(mensagemDoRevisor(textoDoCaso(caso))).texto }],
      output: Output.object({ schema: Parecer }),
      // O parecer é curto; o limite deixa folga para o raciocínio do modelo, que conta na saída.
      maxOutputTokens: alvo.maxOutputTokens ?? 2000,
      abortSignal: AbortSignal.timeout(alvo.timeoutMs ?? 60_000),
      maxRetries: 2,
      telemetry: { isEnabled: false },
      ...(providerOptions ? { providerOptions } : {}),
    });
    return { saida: JSON.stringify(r.output), tokens: { entrada: r.totalUsage.inputTokens ?? 0, saida: r.totalUsage.outputTokens ?? 0 } };
  } catch (err) {
    // Fora do formato: o avaliador reprova por `formato`, com o que o modelo escreveu.
    if (NoObjectGeneratedError.isInstance(err)) return { saida: err.text ?? '', tokens: { entrada: err.usage?.inputTokens ?? 0, saida: err.usage?.outputTokens ?? 0 } };
    throw err;
  }
}
