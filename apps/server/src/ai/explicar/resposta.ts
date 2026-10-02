import { z } from 'zod';
import { conferirTexto } from '../../policy/texto.js';
import { conferirNumeros } from '../verificador-numeros.js';
import { type ContextoDaExplicacao, nomesDoContexto } from './contexto.js';

// O formato da explicação (plano A3, I4; `ai-architecture.md` §8): o que aconteceu · motivos com números
// · risco · o que fazer. O schema que vai ao fornecedor é o mais simples possível (texto, lista, opção);
// os limites de tamanho e a conferência dos números são nossos, depois que a resposta volta.

export const Explicacao = z.strictObject({
  o_que_aconteceu: z.string(),
  motivos: z.array(z.string()),
  risco: z.enum(['baixo', 'medio', 'alto']),
  o_que_fazer: z.array(z.string()),
});
export type Explicacao = z.infer<typeof Explicacao>;

export const LIMITES = { o_que_aconteceu: 600, motivo: 300, motivos: 4, acao: 240, acoes: 3 } as const;

/** Trechos que uma explicação nunca traz: a IA explica e sugere, quem decide é a pessoa; e não manda ninguém a lugar nenhum. */
const PROIBIDOS = ['a ia decidiu', 'eu decidi', 'http://', 'https://', 'www.'];

/** `compliance`: as regras de texto do Policy Engine (político e eleitoral, promessa de resultado, categoria proibida, dado pessoal). */
export type Recusa = 'vazia' | 'longa' | 'numero_fora' | 'trecho_proibido' | 'compliance';

/**
 * A resposta da IA serve para a tela? Devolve o motivo da recusa (e, no caso dos números, quais), ou nulo
 * quando serve. Recusada, a tela mostra o texto sem IA: melhor nenhuma explicação da IA do que uma com
 * número que o sistema não calculou (A3-5).
 */
export function conferirExplicacao(e: Explicacao, contexto: ContextoDaExplicacao): { recusa: Recusa; detalhe: string[] } | null {
  const textos = [e.o_que_aconteceu, ...e.motivos, ...e.o_que_fazer];
  if (!e.o_que_aconteceu.trim() || !e.motivos.length || !e.o_que_fazer.length || textos.some((t) => !t.trim())) return { recusa: 'vazia', detalhe: [] };
  if (
    e.o_que_aconteceu.length > LIMITES.o_que_aconteceu ||
    e.motivos.length > LIMITES.motivos ||
    e.o_que_fazer.length > LIMITES.acoes ||
    e.motivos.some((m) => m.length > LIMITES.motivo) ||
    e.o_que_fazer.some((a) => a.length > LIMITES.acao)
  ) {
    return { recusa: 'longa', detalhe: [] };
  }
  const minusculo = textos.join(' ').toLowerCase();
  const achados = PROIBIDOS.filter((p) => minusculo.includes(p));
  if (achados.length) return { recusa: 'trecho_proibido', detalhe: achados };
  // Compliance (I9): o código decide antes de qualquer revisor de IA. O nome de uma campanha ou conta da
  // própria empresa pode ser citado; o que se confere é o que a IA escreveu em volta.
  const regras = conferirTexto(textos, { ignorar: nomesDoContexto(contexto) });
  if (regras.length) return { recusa: 'compliance', detalhe: regras.map((r) => `${r.regra}: ${r.trecho}`) };
  const numeros = conferirNumeros(textos, contexto);
  if (!numeros.ok) return { recusa: 'numero_fora', detalhe: numeros.fora };
  return null;
}
