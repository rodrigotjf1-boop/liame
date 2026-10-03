// Os testes do promptfoo desta tarefa: um por caso de `casos.jsonl`.
import { casosDa } from '../apoio/servidor.mjs';

const TAREFA = 'estrategista_plano';

export default async function testes() {
  return (await casosDa(TAREFA)).map((caso) => ({
    description: `${caso.grupo} · ${caso.id}: ${caso.descricao}`,
    vars: { tarefa: TAREFA, id: caso.id, grupo: caso.grupo },
    assert: [{ type: 'javascript', value: 'file://../apoio/conferir.mjs' }],
  }));
}
