import { generateText, NoObjectGeneratedError, Output } from 'ai';
import { LeituraDaPagina, mensagemDaPagina } from '../pesquisador/leitura.js';
import { PROMPT_PESQUISADOR } from '../pesquisador/prompt.js';
import type { ModelosIa } from '../modelos.js';
import { limparTexto } from '../sanitizar.js';
import type { CasoDaPagina } from './pagina.js';
import type { AlvoDoEval, RespostaDoEval } from './responder.js';

// Um caso de eval do Pesquisador num modelo de verdade: o MESMO prompt, a mesma mensagem (a página entre as marcas) e o
// mesmo schema da produção, sem ferramenta nenhuma e com a mesma limpeza de dado pessoal. Não passa pelo gateway, como
// os outros evals: eval não é uso de empresa nenhuma; o custo sai no relatório do eval.

export async function responderLeitura(modelos: ModelosIa, alvo: AlvoDoEval, caso: CasoDaPagina): Promise<RespostaDoEval> {
  const model = modelos.modelo(alvo.provider, alvo.model);
  if (!model) throw new Error(`eval: sem credencial para ${alvo.provider}`);
  if (!modelos.atendeARegiao(alvo.provider, alvo.model)) throw new Error(`eval: ${alvo.model} não aceita rodar só nos Estados Unidos (AI_INFERENCE_GEO=us)`);
  const providerOptions = modelos.opcoes(alvo.provider, alvo.model, alvo.effort ?? null);
  const mensagem = mensagemDaPagina({ tipo: caso.tipo, host: caso.host, titulo: caso.titulo, descricao: caso.descricao_da_pagina, texto: caso.texto });
  try {
    const r = await generateText({
      model,
      instructions: PROMPT_PESQUISADOR.content,
      messages: [{ role: 'user', content: limparTexto(mensagem).texto }],
      output: Output.object({ schema: LeituraDaPagina }),
      maxOutputTokens: alvo.maxOutputTokens ?? 2000,
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
