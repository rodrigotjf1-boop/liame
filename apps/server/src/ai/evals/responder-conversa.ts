import { dynamicTool, generateText, isStepCount, NoObjectGeneratedError, Output, type ToolSet } from 'ai';
import { contextoDoPedido } from '../conversa/contexto.js';
import { PROPOR_CUPOM } from '../conversa/cupom.defs.js';
import { ABRIR_DEMANDA } from '../conversa/demanda.defs.js';
import { PROMPT_CONVERSA_LIA } from '../conversa/prompt.js';
import { RespostaDaLia } from '../conversa/resposta.js';
import type { ModelosIa } from '../modelos.js';
import { LEITURAS } from '../registro/leituras.defs.js';
import { limparJson, limparTexto } from '../sanitizar.js';
import { type CasoDaConversa, ferramentasDoPapel, resultadoDaFerramenta } from './conversa.js';
import type { AlvoDoEval, RespostaDoEval } from './responder.js';

// Um caso de eval da Conversa num modelo de verdade: o MESMO prompt, o mesmo contexto do pedido (com o dia do caso),
// as mesmas ferramentas que o nível da pessoa recebe e o mesmo formato de resposta da produção, com a mesma limpeza de
// dado pessoal. As leituras devolvem o que o caso gravou e as escritas são simuladas (sem banco). Não passa pelo
// gateway, como o eval do Explicar: eval não é uso de empresa nenhuma; o custo sai no relatório do eval.

/** Rodadas do laço, como na conversa. */
const RODADAS = 5;
/** O brand_id do contexto do eval: fictício (as leituras gravadas não dependem dele). */
const MARCA_DO_EVAL = '0199a300-0000-7000-8000-00000000b001';

export async function responderConversa(modelos: ModelosIa, alvo: AlvoDoEval, caso: CasoDaConversa): Promise<RespostaDoEval> {
  const model = modelos.modelo(alvo.provider, alvo.model);
  if (!model) throw new Error(`eval: sem credencial para ${alvo.provider}`);
  if (!modelos.atendeARegiao(alvo.provider, alvo.model)) throw new Error(`eval: ${alvo.model} não aceita rodar só nos Estados Unidos (AI_INFERENCE_GEO=us)`);
  // Como a conversa em produção: o laço usa o cache de prompt, e o contexto vai depois das instruções.
  const providerOptions = modelos.opcoes(alvo.provider, alvo.model, alvo.effort ?? null, { cache: true });
  const oferecidas = new Set(ferramentasDoPapel(caso.papel));
  const chamadas: Array<{ ferramenta: string; input: Record<string, unknown> }> = [];
  const tools: ToolSet = Object.fromEntries(
    [...LEITURAS, ABRIR_DEMANDA, PROPOR_CUPOM]
      .filter((d) => oferecidas.has(d.name))
      .map((d) => [
        d.name,
        dynamicTool({
          description: d.description,
          inputSchema: d.input,
          execute: async (input) => {
            const i = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
            chamadas.push({ ferramenta: d.name, input: i });
            const r = resultadoDaFerramenta(caso, d.name, i);
            return r.ok ? limparJson(r.valor).valor : { erro: r.erro };
          },
        }),
      ]),
  );
  const contexto = contextoDoPedido({ hoje: caso.hoje, marca: { id: MARCA_DO_EVAL, nome: caso.marca, fuso: 'America/Sao_Paulo' }, quem: { roleKey: caso.papel }, dossie: null });
  const messages = [
    ...caso.historico.map((h) => ({ role: h.de === 'pessoa' ? ('user' as const) : ('assistant' as const), content: limparTexto(h.texto).texto })),
    { role: 'user' as const, content: limparTexto(caso.mensagem).texto },
  ];
  try {
    const r = await generateText({
      model,
      instructions: modelos.sistema(alvo.provider, limparTexto(PROMPT_CONVERSA_LIA.content).texto, limparTexto(contexto).texto, true),
      messages,
      tools,
      stopWhen: isStepCount(RODADAS),
      output: Output.object({ schema: RespostaDaLia }),
      maxOutputTokens: alvo.maxOutputTokens ?? 3000,
      abortSignal: AbortSignal.timeout(alvo.timeoutMs ?? 120_000),
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
