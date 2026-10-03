// Ponte entre os arquivos do promptfoo e o servidor COMPILADO (`pnpm build` antes): os casos, o avaliador e a
// chamada ao modelo são os de `apps/server/src/ai/evals`, os mesmos que os testes cobrem. Aqui não há regra.
import { fileURLToPath, pathToFileURL } from 'node:url';

const raiz = new URL('../../', import.meta.url);
const dist = new URL('apps/server/dist/ai/evals/index.js', raiz);

let carregado;
/** O módulo de evals do servidor; erro claro quando falta o build. */
export async function servidor() {
  if (!carregado) {
    try {
      carregado = await import(pathToFileURL(fileURLToPath(dist)).href);
    } catch (err) {
      throw new Error(`evals: não achei ${fileURLToPath(dist)}. Rode "pnpm build" antes. (${err instanceof Error ? err.message : String(err)})`);
    }
  }
  return carregado;
}

/** A tarefa do servidor (como ler os casos, a saída gravada, avaliar e chamar o modelo). */
export async function tarefaDe(nome) {
  const { TAREFAS } = await servidor();
  const t = TAREFAS[nome];
  if (!t) throw new Error(`evals: tarefa "${nome}" não existe no servidor (veja apps/server/src/ai/evals/tarefas.ts)`);
  return t;
}

const casosPorTarefa = new Map();
/** Os casos de uma tarefa (`evals/<tarefa>/casos.jsonl`), lidos uma vez, pelo formato daquela tarefa. */
export async function casosDa(tarefa) {
  if (!casosPorTarefa.has(tarefa)) {
    const t = await tarefaDe(tarefa);
    casosPorTarefa.set(tarefa, t.carregar(fileURLToPath(new URL(`evals/${tarefa}/casos.jsonl`, raiz))));
  }
  return casosPorTarefa.get(tarefa);
}

export async function casoDa(tarefa, id) {
  const caso = (await casosDa(tarefa)).find((c) => c.id === id);
  if (!caso) throw new Error(`evals: caso "${id}" não existe em ${tarefa}`);
  return caso;
}

/**
 * O modelo em avaliação, de `EVAL_MODEL` (`fornecedor/modelo`). Sem a variável, o eval roda no modo gravado:
 * cada caso responde com a resposta boa gravada nele, o que prova o caminho e o avaliador sem gastar.
 */
export function alvo() {
  const bruto = process.env.EVAL_MODEL?.trim();
  if (!bruto) return null;
  const barra = bruto.indexOf('/');
  if (barra < 1 || barra === bruto.length - 1) throw new Error('evals: EVAL_MODEL no formato fornecedor/modelo');
  const effort = process.env.EVAL_EFFORT?.trim() || null;
  return { provider: bruto.slice(0, barra), model: bruto.slice(barra + 1), effort };
}
