// Provider do promptfoo para as tarefas do Liame. O "prompt" que o promptfoo manda é só o id do caso: o
// prompt de verdade, o contexto e o formato da resposta são os do servidor (os mesmos de produção).
import { alvo, casoDa, servidor, tarefaDe } from './servidor.mjs';

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
    const tarefa = await tarefaDe(this.tarefa);
    const a = alvo();
    if (!a) {
      // Modo gravado: a saída boa do caso. Com EVAL_GRAVADO=ruim, a primeira ruim (para provar que o portão reprova).
      const resposta = tarefa.gravada(caso, process.env.EVAL_GRAVADO === 'ruim' ? 'ruim' : 'boa');
      return { output: typeof resposta === 'string' ? resposta : JSON.stringify(resposta), tokenUsage: { total: 0, prompt: 0, completion: 0 } };
    }
    const { loadConfig, ModelosIa } = await servidor();
    modelos ??= new ModelosIa(loadConfig());
    try {
      const r = await tarefa.responder(modelos, a, caso);
      // `cached`: a parte da entrada lida do cache de prompt. A parte escrita no cache vai em `metadata` (o promptfoo não a soma).
      return {
        output: r.saida,
        tokenUsage: { total: r.tokens.entrada + r.tokens.saida, prompt: r.tokens.entrada, completion: r.tokens.saida, cached: r.tokens.lidoDoCache ?? 0 },
        metadata: { escritoNoCache: r.tokens.escritoNoCache ?? 0 },
      };
    } catch (err) {
      // Só o nome e o código: a mensagem do fornecedor pode repetir o que foi enviado.
      return { error: `chamada ao modelo falhou: ${err?.name ?? 'erro'}${err?.statusCode ? ` (HTTP ${err.statusCode})` : ''}` };
    }
  }
}
