import { z } from 'zod';
import { conferirTexto, type RegraDeTexto } from '../../policy/texto.js';
import { conferirNumeros } from '../verificador-numeros.js';

// O formato da resposta da LIA na conversa (A3, I10; protótipo P5): blocos na ordem da leitura e, numa decisão
// grande, a reunião de decisão. O schema que vai ao fornecedor é o mais simples possível (lista, texto, opção);
// limites de tamanho e a conferência são nossos, depois que a resposta volta. Recusada, a resposta não aparece:
// a tela mostra o aviso do sistema.

export const VOZES_DA_REUNIAO = ['analista', 'estrategista', 'voz_contraria'] as const;

export const RespostaDaLia = z.strictObject({
  blocos: z.array(
    z.strictObject({
      tipo: z.enum(['paragrafo', 'item', 'risco', 'fazer']),
      texto: z.string(),
      risco: z.enum(['baixo', 'medio', 'alto']).nullable(),
    }),
  ),
  /** Só numa decisão grande (pausar campanha, mudar a verba): as vozes, com uma contrária, a recomendação e o risco. */
  reuniao: z
    .strictObject({
      pauta: z.string(),
      vozes: z.array(z.strictObject({ quem: z.enum(VOZES_DA_REUNIAO), texto: z.string() })),
      recomendacao: z.string(),
      risco: z.enum(['baixo', 'medio', 'alto']),
      risco_motivo: z.string(),
    })
    .nullable(),
});
export type RespostaDaLia = z.infer<typeof RespostaDaLia>;

export const LIMITES_DA_RESPOSTA = { blocos: 8, bloco: 700, total: 4000, pauta: 200, vozes: 4, voz: 600, recomendacao: 600, risco_motivo: 300 } as const;

/** Trechos que uma resposta nunca traz: a IA sugere, quem decide é a pessoa; e não manda ninguém a lugar nenhum. */
const PROIBIDOS = ['a ia decidiu', 'eu decidi', 'http://', 'https://', 'www.'];

/**
 * `vazia`, `longa`, `formato` (risco fora do lugar, reunião sem voz contrária), `trecho_proibido`, `compliance`
 * (regras de texto e o que a marca não diz), `numero_fora` (número que não está no que a LIA leu) e `dado_velho`
 * (número de uma leitura com fonte fora do dia).
 */
export type RecusaDaConversa = 'vazia' | 'longa' | 'formato' | 'trecho_proibido' | 'compliance' | 'numero_fora' | 'dado_velho';

export interface PermitidosNaConversa {
  /** Tudo de onde um número pode sair (leituras em dia, mensagens da pessoa, respostas já conferidas, contexto). */
  emDia: unknown;
  /** As leituras com alguma fonte fora do dia: número que só está nelas é recusado como `dado_velho`. */
  velhas: unknown;
  /** Nomes que vieram dos dados da empresa (campanha, conta, loja, cupom): citar um nome não é a IA falando de política. */
  nomes: string[];
  /** O que a marca nunca diz (dossiê, I8). */
  daMarca?: string[];
}

/** Os textos da resposta, na ordem da leitura: os blocos e, quando houver, a reunião. */
export const textosDaResposta = (r: RespostaDaLia): string[] => [
  ...r.blocos.map((b) => b.texto),
  ...(r.reuniao ? [r.reuniao.pauta, ...r.reuniao.vozes.map((v) => v.texto), r.reuniao.recomendacao, r.reuniao.risco_motivo] : []),
];

/** A reunião no formato: de 2 a 4 vozes, com uma contrária, e cada texto dentro do limite. Devolve o problema ou nulo. */
function problemaDaReuniao(r: NonNullable<RespostaDaLia['reuniao']>): RecusaDaConversa | null {
  const textos = [r.pauta, ...r.vozes.map((v) => v.texto), r.recomendacao, r.risco_motivo];
  if (textos.some((t) => !t.trim())) return 'vazia';
  if (r.vozes.length < 2 || r.vozes.length > LIMITES_DA_RESPOSTA.vozes || !r.vozes.some((v) => v.quem === 'voz_contraria')) return 'formato';
  if (
    r.pauta.length > LIMITES_DA_RESPOSTA.pauta ||
    r.vozes.some((v) => v.texto.length > LIMITES_DA_RESPOSTA.voz) ||
    r.recomendacao.length > LIMITES_DA_RESPOSTA.recomendacao ||
    r.risco_motivo.length > LIMITES_DA_RESPOSTA.risco_motivo
  ) {
    return 'longa';
  }
  return null;
}

/**
 * A resposta serve para a tela? Devolve o motivo da recusa (e o detalhe, para o log) ou nulo quando serve.
 * Melhor nenhuma resposta da LIA do que uma com número que o sistema não entregou (A3-5).
 */
export function conferirResposta(r: RespostaDaLia, permitidos: PermitidosNaConversa): { recusa: RecusaDaConversa; detalhe: string[]; regras?: RegraDeTexto[] } | null {
  const blocos = r.blocos.map((b) => b.texto);
  if (!r.blocos.length || blocos.some((t) => !t.trim())) return { recusa: 'vazia', detalhe: [] };
  if (r.blocos.length > LIMITES_DA_RESPOSTA.blocos || blocos.some((t) => t.length > LIMITES_DA_RESPOSTA.bloco) || blocos.join('').length > LIMITES_DA_RESPOSTA.total) {
    return { recusa: 'longa', detalhe: [] };
  }
  const riscos = r.blocos.filter((b) => b.tipo === 'risco');
  if (riscos.length > 1 || r.blocos.some((b) => (b.tipo === 'risco') !== (b.risco !== null))) return { recusa: 'formato', detalhe: ['risco fora do lugar'] };
  if (r.reuniao) {
    const problema = problemaDaReuniao(r.reuniao);
    if (problema) return { recusa: problema, detalhe: ['reunião'] };
  }
  const textos = textosDaResposta(r);
  const minusculo = textos.join(' ').toLowerCase();
  const achados = PROIBIDOS.filter((p) => minusculo.includes(p));
  if (achados.length) return { recusa: 'trecho_proibido', detalhe: achados };
  // Compliance (I9): o código decide antes de qualquer revisor de IA. O que a marca não diz (I8) vale igual.
  const regras = conferirTexto(textos, { ignorar: permitidos.nomes, daMarca: permitidos.daMarca });
  if (regras.length) return { recusa: 'compliance', detalhe: regras.map((x) => `${x.regra}: ${x.trecho}`), regras: [...new Set(regras.map((x) => x.regra))] };
  const numeros = conferirNumeros(textos, permitidos.emDia);
  if (!numeros.ok) {
    // O número está numa leitura com fonte atrasada: não é invenção, mas a LIA não analisa dado velho.
    const comAsVelhas = conferirNumeros(numeros.fora, [permitidos.emDia, permitidos.velhas]);
    return { recusa: comAsVelhas.ok ? 'dado_velho' : 'numero_fora', detalhe: numeros.fora };
  }
  return null;
}

/** A resposta como texto corrido, para o histórico que volta ao modelo na mensagem seguinte. */
export function respostaComoTexto(blocos: Array<{ tipo: string; texto: string; risco: string | null }>): string {
  return blocos
    .map((b) => (b.tipo === 'item' ? `- ${b.texto}` : b.tipo === 'fazer' ? `O que fazer: ${b.texto}` : b.tipo === 'risco' ? `Risco ${b.risco ?? ''}: ${b.texto}` : b.texto))
    .join('\n');
}
