import { generateText, NoObjectGeneratedError, Output } from 'ai';
import type { ModelosIa } from '../modelos.js';
import { limparTexto } from '../sanitizar.js';
import { RespostaDoPost } from '../social/post.js';
import { contextoDoPost, mensagemDoPost } from '../social/post-contexto.js';
import { PROMPT_SOCIAL_POST } from '../social/prompt.js';
import type { AlvoDoEval, RespostaDoEval } from './responder.js';
import { type CasoDoPost, pedidoDoCasoDoPost } from './social-post.js';

// Um caso de eval dos posts do Social media num modelo de verdade: o MESMO prompt, o mesmo contexto (depois das
// instruções, como o gateway manda numa chamada única), a mesma mensagem (o item da pauta entre as marcas) e o mesmo
// schema da produção, sem ferramenta nenhuma e com a mesma limpeza de dado pessoal. Não passa pelo gateway, como os
// outros evals: eval não é uso de empresa nenhuma; o custo sai no relatório do eval.

export async function responderPost(modelos: ModelosIa, alvo: AlvoDoEval, caso: CasoDoPost): Promise<RespostaDoEval> {
  const model = modelos.modelo(alvo.provider, alvo.model);
  if (!model) throw new Error(`eval: sem credencial para ${alvo.provider}`);
  if (!modelos.atendeARegiao(alvo.provider, alvo.model)) throw new Error(`eval: ${alvo.model} não aceita rodar só nos Estados Unidos (AI_INFERENCE_GEO=us)`);
  const providerOptions = modelos.opcoes(alvo.provider, alvo.model, alvo.effort ?? null);
  const pedido = pedidoDoCasoDoPost(caso);
  try {
    const r = await generateText({
      model,
      instructions: modelos.sistema(alvo.provider, limparTexto(PROMPT_SOCIAL_POST.content).texto, limparTexto(contextoDoPost(pedido)).texto, false),
      messages: [{ role: 'user', content: limparTexto(mensagemDoPost(pedido)).texto }],
      output: Output.object({ schema: RespostaDoPost }),
      maxOutputTokens: alvo.maxOutputTokens ?? 1500,
      abortSignal: AbortSignal.timeout(alvo.timeoutMs ?? 120_000),
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
