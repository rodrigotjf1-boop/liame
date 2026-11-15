import { generateText, NoObjectGeneratedError, Output } from 'ai';
import { problemaDasImagens } from '../imagens.js';
import type { ModelosIa } from '../modelos.js';
import { limparTexto } from '../sanitizar.js';
import { contextoDosCortes, mensagemDosCortes, PROMPT_SOCIAL_CORTES, RespostaDosCortes, TAREFA_SOCIAL_CORTES } from '../social/cortes.js';
import type { AlvoDoEval, RespostaDoEval } from './responder.js';
import { type CasoDosCortes, pedidoDoCasoDosCortes, quadrosDoCaso } from './social-cortes.js';

// Um caso de eval dos cortes num modelo de verdade: o MESMO prompt, o mesmo contexto (depois das instruções, como o gateway
// manda numa chamada única), a mesma mensagem (cada quadro com o vídeo e o segundo, entre as marcas) e o mesmo schema da
// produção, sem ferramenta nenhuma. As partes vão como o gateway as manda: o texto pela mesma limpeza de dado pessoal, a
// imagem como parte `image` da AI SDK, em JPEG, depois da mesma conferência das imagens (a tarefa da lista, a quantidade,
// os bytes e as medidas). Os quadros são os desenhados pelo eval (`quadrosDoCaso`). Não passa pelo gateway, como os outros
// evals: eval não é uso de empresa nenhuma; o custo sai no relatório do eval.

export async function responderCortes(modelos: ModelosIa, alvo: AlvoDoEval, caso: CasoDosCortes): Promise<RespostaDoEval> {
  const model = modelos.modelo(alvo.provider, alvo.model);
  if (!model) throw new Error(`eval: sem credencial para ${alvo.provider}`);
  if (!modelos.atendeARegiao(alvo.provider, alvo.model)) throw new Error(`eval: ${alvo.model} não aceita rodar só nos Estados Unidos (AI_INFERENCE_GEO=us)`);
  const providerOptions = modelos.opcoes(alvo.provider, alvo.model, alvo.effort ?? null);
  const pedido = pedidoDoCasoDosCortes(caso, await quadrosDoCaso(caso));
  const partes = mensagemDosCortes(pedido);
  const problema = problemaDasImagens(
    TAREFA_SOCIAL_CORTES,
    partes.flatMap((p) => (p.tipo === 'imagem' ? [p] : [])),
  );
  if (problema) throw new Error(`eval: ${problema}`);
  const content = partes.map((p) => (p.tipo === 'texto' ? { type: 'text' as const, text: limparTexto(p.texto).texto } : { type: 'file' as const, data: p.jpeg, mediaType: 'image/jpeg' }));
  try {
    const r = await generateText({
      model,
      instructions: modelos.sistema(alvo.provider, limparTexto(PROMPT_SOCIAL_CORTES.content).texto, limparTexto(contextoDosCortes(pedido)).texto, false),
      messages: [{ role: 'user', content }],
      output: Output.object({ schema: RespostaDosCortes }),
      maxOutputTokens: alvo.maxOutputTokens ?? 800,
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
