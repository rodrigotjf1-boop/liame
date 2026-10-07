import { ErroConector } from '../connectors/cliente-http.js';
import { AppProblem } from '../errors/problems.js';

// A leitura de um objeto na plataforma, na hora (A4): quem pede uma ação e quem abre a gaveta do pedido leem o estado
// que está valendo. A leitura é uma chamada de verdade e pode falhar; cada falha vira um problema que a pessoa entende,
// com as mesmas palavras nos dois lugares, em vez de um erro interno.

/** Como a pessoa chama cada provedor, na frase. */
export const PLATAFORMA: Record<string, string> = { meta_ads: 'A Meta', regem: 'O Regem' };

/** A falha do conector em palavras. O que não é falha do conector (um defeito nosso) devolve nulo, e quem chama deixa subir. */
export function problemaDaLeitura(provider: string, err: unknown): AppProblem | null {
  if (!(err instanceof ErroConector)) return null;
  const quem = PLATAFORMA[provider] ?? 'A plataforma';
  if (err.tipo === 'autenticacao') {
    return new AppProblem(409, 'conta-desconectada', 'Conecte a conta de novo', `${quem} recusou o acesso desta conta (a autorização foi revogada ou venceu). Conecte de novo em Contas conectadas.`);
  }
  if (err.tipo === 'permissao') {
    return new AppProblem(409, 'sem-permissao-na-plataforma', 'Falta permissão na plataforma', `${quem} não deu ao Liame a permissão para ler este objeto. Conecte a conta de novo em Contas conectadas.`);
  }
  if (err.tipo === 'definitivo') {
    return new AppProblem(422, 'plataforma-recusou', 'A plataforma recusou a leitura', `${quem} não deixou ler o objeto: ${err.mensagemUsuario ?? err.message}`);
  }
  // Limite de uso, fora do ar ou muitas falhas seguidas: nada foi pedido; é tentar de novo daqui a pouco.
  return new AppProblem(502, 'plataforma-indisponivel', 'A plataforma não respondeu', `${quem} não respondeu agora, ou pediu para esperar. Nada foi pedido: tente de novo em alguns minutos.`);
}

/** O objeto (ou a conta) não existe para esta empresa, ou a plataforma não o tem mais. */
export const recursoNaoEncontrado = (): AppProblem => new AppProblem(404, 'recurso-nao-encontrado', 'Recurso não encontrado', 'A conta ou o recurso não existe no provedor.');
