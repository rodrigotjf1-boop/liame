import { generateText, NoObjectGeneratedError, Output } from 'ai';
import type { ModelosIa } from '../modelos.js';
import { limparTexto } from '../sanitizar.js';
import { contextoDoTipo, mensagemDoTipo, RespostaDoTipo } from '../social/comentario-tipo.js';
import { PROMPT_SOCIAL_COMENTARIO_TIPO } from '../social/prompt.js';
import type { AlvoDoEval, RespostaDoEval } from './responder.js';
import { type CasoDoTipo, pedidoDoCasoDoTipo } from './social-comentario-tipo.js';

// Um caso de eval do tipo do comentário num modelo de verdade (A6, Z11, parte 2d-4a): o MESMO prompt, o mesmo contexto
// (depois das instruções, como o gateway manda numa chamada única), a mesma mensagem (o comentário entre as marcas, sem
// o @ de ninguém) e o mesmo schema da produção, sem ferramenta e com a mesma limpeza de dado pessoal. Não passa pelo
// gateway, como os outros evals: eval não é uso de empresa nenhuma; o custo sai no relatório do eval. Só roda na rodada
// paga, que é decisão do dono.

export async function responderTipoDoComentario(modelos: ModelosIa, alvo: AlvoDoEval, caso: CasoDoTipo): Promise<RespostaDoEval> {
  const model = modelos.modelo(alvo.provider, alvo.model);
  if (!model) throw new Error(`eval: sem credencial para ${alvo.provider}`);
  if (!modelos.atendeARegiao(alvo.provider, alvo.model)) throw new Error(`eval: ${alvo.model} não aceita rodar só nos Estados Unidos (AI_INFERENCE_GEO=us)`);
  const providerOptions = modelos.opcoes(alvo.provider, alvo.model, alvo.effort ?? null);
  const pedido = pedidoDoCasoDoTipo(caso);
  try {
    const r = await generateText({
      model,
      instructions: modelos.sistema(alvo.provider, limparTexto(PROMPT_SOCIAL_COMENTARIO_TIPO.content).texto, limparTexto(contextoDoTipo(pedido)).texto, false),
      messages: [{ role: 'user', content: limparTexto(mensagemDoTipo(pedido)).texto }],
      output: Output.object({ schema: RespostaDoTipo }),
      maxOutputTokens: alvo.maxOutputTokens ?? 300,
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
