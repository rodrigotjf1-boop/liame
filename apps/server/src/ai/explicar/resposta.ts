import { z } from 'zod';
import { conferirTexto } from '../../policy/texto.js';
import { conferirNumeros } from '../verificador-numeros.js';
import { type ContextoComAviso, nomesDoContexto } from './contexto.js';

// O formato da explicação (plano A3, I4; `ai-architecture.md` §8; protótipo P4): o que aconteceu · motivos
// com números · risco, com a frase que diz por quê · o que fazer. O schema que vai ao fornecedor é o mais
// simples possível (texto, lista, opção); os limites de tamanho e a conferência dos números são nossos,
// depois que a resposta volta. A ordem dos campos é a da tela.

export const Explicacao = z.strictObject({
  o_que_aconteceu: z.string(),
  motivos: z.array(z.string()),
  risco: z.enum(['baixo', 'medio', 'alto']),
  /** Por que o risco é esse, numa frase que a tela mostra ao lado do selo ("Risco médio"): começa em minúscula. */
  risco_motivo: z.string(),
  o_que_fazer: z.array(z.string()),
});
export type Explicacao = z.infer<typeof Explicacao>;

export const LIMITES = { o_que_aconteceu: 600, motivo: 300, motivos: 4, risco_motivo: 240, acao: 240, acoes: 3 } as const;

/** Trechos que uma explicação nunca traz: a IA explica e sugere, quem decide é a pessoa; e não manda ninguém a lugar nenhum. */
const PROIBIDOS = ['a ia decidiu', 'eu decidi', 'http://', 'https://', 'www.'];

/**
 * `compliance`: as regras de texto do Policy Engine (político e eleitoral, promessa de resultado, categoria
 * proibida, dado pessoal). `risco`: a resposta diz risco baixo para um aviso crítico.
 */
export type Recusa = 'vazia' | 'longa' | 'numero_fora' | 'trecho_proibido' | 'compliance' | 'risco';

/**
 * A resposta da IA serve para a tela? Devolve o motivo da recusa (e, no caso dos números, quais), ou nulo
 * quando serve. Recusada, a tela mostra o texto sem IA: melhor nenhuma explicação da IA do que uma com
 * número que o sistema não calculou (A3-5).
 */
export function conferirExplicacao(e: Explicacao, contexto: ContextoComAviso): { recusa: Recusa; detalhe: string[] } | null {
  const textos = [e.o_que_aconteceu, ...e.motivos, e.risco_motivo, ...e.o_que_fazer];
  if (!e.motivos.length || !e.o_que_fazer.length || textos.some((t) => !t.trim())) return { recusa: 'vazia', detalhe: [] };
  if (
    e.o_que_aconteceu.length > LIMITES.o_que_aconteceu ||
    e.motivos.length > LIMITES.motivos ||
    e.o_que_fazer.length > LIMITES.acoes ||
    e.motivos.some((m) => m.length > LIMITES.motivo) ||
    e.risco_motivo.length > LIMITES.risco_motivo ||
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
  // O aviso crítico já foi classificado pelas regras da Atenção: a explicação não o rebaixa.
  if (contexto.aviso?.gravidade === 'critica' && e.risco === 'baixo') return { recusa: 'risco', detalhe: ['aviso crítico com risco baixo'] };
  return null;
}
