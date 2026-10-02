// Assert do promptfoo: passa a resposta do modelo pelo avaliador determinístico do servidor. O motivo de cada
// reprovação (número fora do contexto, risco errado, trecho proibido…) vai para o relatório.
import { casoDa, servidor } from './servidor.mjs';

export default async function conferir(output, context) {
  const { avaliarExplicacao } = await servidor();
  const caso = await casoDa(context.vars.tarefa, context.vars.id);
  const a = avaliarExplicacao(caso, output);
  return { pass: a.ok, score: a.ok ? 1 : 0, reason: a.ok ? 'ok' : a.falhas.join('; ') };
}
