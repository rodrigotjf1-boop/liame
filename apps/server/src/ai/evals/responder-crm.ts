import { generateText, NoObjectGeneratedError, Output } from 'ai';
import { contextoDoCrm, mensagemDoCrm } from '../crm/contexto.js';
import { RespostaDoCrm } from '../crm/mensagem.js';
import { PROMPT_CRM_MENSAGEM } from '../crm/prompt.js';
import type { ModelosIa } from '../modelos.js';
import { limparTexto } from '../sanitizar.js';
import { type CasoDoCrm, pedidoDoCasoDoCrm } from './crm.js';
import type { AlvoDoEval, RespostaDoEval } from './responder.js';

// Um caso de eval do funcionário de CRM e mensageria num modelo de verdade: o MESMO prompt, o mesmo contexto (depois
// das instruções, como o gateway manda numa chamada única), a mesma mensagem (a oferta, o público e o cupom entre as
// marcas) e o mesmo schema da produção, sem ferramenta nenhuma e com a mesma limpeza de dado pessoal. Não passa pelo
// gateway, como os outros evals: eval não é uso de empresa nenhuma; o custo sai no relatório do eval.

export async function responderMensagem(modelos: ModelosIa, alvo: AlvoDoEval, caso: CasoDoCrm): Promise<RespostaDoEval> {
  const model = modelos.modelo(alvo.provider, alvo.model);
  if (!model) throw new Error(`eval: sem credencial para ${alvo.provider}`);
  if (!modelos.atendeARegiao(alvo.provider, alvo.model)) throw new Error(`eval: ${alvo.model} não aceita rodar só nos Estados Unidos (AI_INFERENCE_GEO=us)`);
  const providerOptions = modelos.opcoes(alvo.provider, alvo.model, alvo.effort ?? null);
  const pedido = pedidoDoCasoDoCrm(caso);
  try {
    const r = await generateText({
      model,
      instructions: modelos.sistema(alvo.provider, limparTexto(PROMPT_CRM_MENSAGEM.content).texto, limparTexto(contextoDoCrm(pedido)).texto, false),
      messages: [{ role: 'user', content: limparTexto(mensagemDoCrm(pedido)).texto }],
      output: Output.object({ schema: RespostaDoCrm }),
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
