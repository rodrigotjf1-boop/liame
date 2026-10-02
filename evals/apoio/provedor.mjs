// Provider do promptfoo para as tarefas do Liame. O "prompt" que o promptfoo manda é só o id do caso: o
// prompt de verdade, o contexto e o formato da resposta são os do servidor (os mesmos de produção).
import { alvo, casoDa, servidor } from './servidor.mjs';

let modelos;

export default class ProvedorLiame {
  constructor(options = {}) {
    this.tarefa = options.config?.tarefa;
    if (!this.tarefa) throw new Error('evals: o provider precisa de config.tarefa');
  }

  id() {
    const a = alvo();
    return `liame:${this.tarefa}:${a ? `${a.provider}/${a.model}` : 'gravado'}`;
  }

  async callApi(_prompt, context) {
    const caso = await casoDa(this.tarefa, context?.vars?.id);
    const a = alvo();
    if (!a) {
      // Modo gravado: a resposta boa do caso. Com EVAL_GRAVADO=ruim, a primeira ruim (para provar que o portão reprova).
      const ruim = process.env.EVAL_GRAVADO === 'ruim' ? caso.gravadas.ruins[0]?.resposta : undefined;
      const resposta = ruim === undefined ? caso.gravadas.boa : ruim;
      return { output: typeof resposta === 'string' ? resposta : JSON.stringify(resposta), tokenUsage: { total: 0, prompt: 0, completion: 0 } };
    }
    const { loadConfig, ModelosIa, responderExplicacao } = await servidor();
    modelos ??= new ModelosIa(loadConfig());
    try {
      const r = await responderExplicacao(modelos, a, caso);
      return { output: r.saida, tokenUsage: { total: r.tokens.entrada + r.tokens.saida, prompt: r.tokens.entrada, completion: r.tokens.saida } };
    } catch (err) {
      // Só o nome e o código: a mensagem do fornecedor pode repetir o que foi enviado.
      return { error: `chamada ao modelo falhou: ${err?.name ?? 'erro'}${err?.statusCode ? ` (HTTP ${err.statusCode})` : ''}` };
    }
  }
}
