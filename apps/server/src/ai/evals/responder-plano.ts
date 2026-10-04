import { dynamicTool, generateText, isStepCount, NoObjectGeneratedError, Output, type ToolSet } from 'ai';
import type { z } from 'zod';
import { contextoDoPlano, mensagemDoPlano } from '../estrategista/contexto.js';
import { ESTRATEGISTA, PROMPT_ESTRATEGISTA } from '../estrategista/prompt.js';
import { RESPOSTA_DO_TIPO } from '../estrategista/resposta.js';
import type { ModelosIa } from '../modelos.js';
import { LEITURAS } from '../registro/leituras.defs.js';
import { limparJson, limparTexto } from '../sanitizar.js';
import { type CasoDoPlano, dadosDoCaso, leituraDoCaso } from './plano.js';
import type { AlvoDoEval, RespostaDoEval } from './responder.js';

// Um caso de eval do Estrategista num modelo de verdade: o MESMO prompt, o mesmo contexto do plano (com o dia, a verba
// de hoje e o calendário do caso), as mesmas leituras que a rotina do sistema recebe e o mesmo schema do tipo pedido,
// com a mesma limpeza de dado pessoal. As leituras devolvem o que o caso gravou. Não passa pelo gateway, como os outros
// evals: eval não é uso de empresa nenhuma; o custo sai no relatório do eval.

/** Rodadas do laço, como na geração do plano. */
const RODADAS = 6;

export async function responderPlano(modelos: ModelosIa, alvo: AlvoDoEval, caso: CasoDoPlano): Promise<RespostaDoEval> {
  const model = modelos.modelo(alvo.provider, alvo.model);
  if (!model) throw new Error(`eval: sem credencial para ${alvo.provider}`);
  if (!modelos.atendeARegiao(alvo.provider, alvo.model)) throw new Error(`eval: ${alvo.model} não aceita rodar só nos Estados Unidos (AI_INFERENCE_GEO=us)`);
  // Como o Estrategista em produção: o laço usa o cache de prompt, e o contexto vai depois das instruções.
  const providerOptions = modelos.opcoes(alvo.provider, alvo.model, alvo.effort ?? null, { cache: true });
  const chamadas: Array<{ ferramenta: string; input: Record<string, unknown> }> = [];
  const tools: ToolSet = Object.fromEntries(
    LEITURAS.filter((d) => ESTRATEGISTA.ferramentas.includes(d.name)).map((d) => [
      d.name,
      dynamicTool({
        description: d.description,
        inputSchema: d.input,
        execute: async (input) => {
          const i = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
          chamadas.push({ ferramenta: d.name, input: i });
          const r = leituraDoCaso(caso, d.name);
          return r.ok ? limparJson(r.valor).valor : { erro: r.erro };
        },
      }),
    ]),
  );
  const dados = dadosDoCaso(caso);
  // O schema do tipo pedido, como na geração (o gateway recebe o mesmo, sem o tipo fixo).
  const schema: z.ZodType<unknown> = RESPOSTA_DO_TIPO[caso.tipo];
  try {
    const r = await generateText({
      model,
      instructions: modelos.sistema(alvo.provider, limparTexto(PROMPT_ESTRATEGISTA.content).texto, limparTexto(contextoDoPlano(dados)).texto, true),
      messages: [{ role: 'user', content: limparTexto(mensagemDoPlano(dados)).texto }],
      tools,
      stopWhen: isStepCount(RODADAS),
      output: Output.object({ schema }),
      maxOutputTokens: alvo.maxOutputTokens ?? 4000,
      abortSignal: AbortSignal.timeout(alvo.timeoutMs ?? 180_000),
      maxRetries: 2,
      telemetry: { isEnabled: false },
      ...(providerOptions ? { providerOptions } : {}),
    });
    return {
      saida: JSON.stringify({ chamadas, resposta: r.output }),
      tokens: {
        entrada: r.totalUsage.inputTokens ?? 0,
        saida: r.totalUsage.outputTokens ?? 0,
        lidoDoCache: r.totalUsage.inputTokenDetails?.cacheReadTokens ?? 0,
        escritoNoCache: r.totalUsage.inputTokenDetails?.cacheWriteTokens ?? 0,
      },
    };
  } catch (err) {
    // Fora do formato: o avaliador reprova por `formato`, com o que o modelo escreveu.
    if (NoObjectGeneratedError.isInstance(err)) {
      return { saida: JSON.stringify({ chamadas, resposta: err.text ?? '' }), tokens: { entrada: err.usage?.inputTokens ?? 0, saida: err.usage?.outputTokens ?? 0 } };
    }
    throw err;
  }
}
