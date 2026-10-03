import { z } from 'zod';
import { conferirTexto } from '../../policy/texto.js';
import { conferirNumeros } from '../verificador-numeros.js';

// O formato da resposta da LIA na conversa (A3, I10; protótipo P5): blocos na ordem da leitura. O schema que
// vai ao fornecedor é o mais simples possível (lista, texto, opção); limites de tamanho e a conferência são
// nossos, depois que a resposta volta. Recusada, a resposta não aparece: a tela mostra o aviso do sistema.

export const RespostaDaLia = z.strictObject({
  blocos: z.array(
    z.strictObject({
      tipo: z.enum(['paragrafo', 'item', 'risco', 'fazer']),
      texto: z.string(),
      risco: z.enum(['baixo', 'medio', 'alto']).nullable(),
    }),
  ),
});
export type RespostaDaLia = z.infer<typeof RespostaDaLia>;

export const LIMITES_DA_RESPOSTA = { blocos: 8, bloco: 700, total: 4000 } as const;

/** Trechos que uma resposta nunca traz: a IA sugere, quem decide é a pessoa; e não manda ninguém a lugar nenhum. */
const PROIBIDOS = ['a ia decidiu', 'eu decidi', 'http://', 'https://', 'www.'];

/**
 * `vazia`, `longa`, `formato` (risco fora do lugar), `trecho_proibido`, `compliance` (regras de texto e o que a
 * marca não diz), `numero_fora` (número que não está no que a LIA leu) e `dado_velho` (número de uma leitura com
 * fonte fora do dia).
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

/** Os textos dos blocos, na ordem. */
export const textosDaResposta = (r: RespostaDaLia): string[] => r.blocos.map((b) => b.texto);

/**
 * A resposta serve para a tela? Devolve o motivo da recusa (e o detalhe, para o log) ou nulo quando serve.
 * Melhor nenhuma resposta da LIA do que uma com número que o sistema não entregou (A3-5).
 */
export function conferirResposta(r: RespostaDaLia, permitidos: PermitidosNaConversa): { recusa: RecusaDaConversa; detalhe: string[] } | null {
  const textos = textosDaResposta(r);
  if (!r.blocos.length || textos.some((t) => !t.trim())) return { recusa: 'vazia', detalhe: [] };
  if (r.blocos.length > LIMITES_DA_RESPOSTA.blocos || textos.some((t) => t.length > LIMITES_DA_RESPOSTA.bloco) || textos.join('').length > LIMITES_DA_RESPOSTA.total) {
    return { recusa: 'longa', detalhe: [] };
  }
  const riscos = r.blocos.filter((b) => b.tipo === 'risco');
  if (riscos.length > 1 || r.blocos.some((b) => (b.tipo === 'risco') !== (b.risco !== null))) return { recusa: 'formato', detalhe: ['risco fora do lugar'] };
  const minusculo = textos.join(' ').toLowerCase();
  const achados = PROIBIDOS.filter((p) => minusculo.includes(p));
  if (achados.length) return { recusa: 'trecho_proibido', detalhe: achados };
  // Compliance (I9): o código decide antes de qualquer revisor de IA. O que a marca não diz (I8) vale igual.
  const regras = conferirTexto(textos, { ignorar: permitidos.nomes, daMarca: permitidos.daMarca });
  if (regras.length) return { recusa: 'compliance', detalhe: regras.map((x) => `${x.regra}: ${x.trecho}`) };
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
