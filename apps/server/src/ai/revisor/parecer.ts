import type { PlanContent } from '@liame/contracts';
import { z } from 'zod';
import type { RespostaDaLia } from '../conversa/resposta.js';
import { textosDoPlano } from '../estrategista/plano.js';
import type { Explicacao } from '../explicar/resposta.js';

// O que o revisor de IA recebe e o que ele devolve (A3, I9; D-A3-16). Recebe só o texto que a IA escreveu, em partes,
// na ordem da leitura: nenhum número do contexto, nenhum dado da empresa além do que já está no texto (que passou pela
// conferência do código). Devolve as categorias com problema; lista vazia quando o texto pode aparecer. O schema que
// vai ao fornecedor é o mais simples possível, e não tem campo para o revisor escrever: a categoria, e não um comentário,
// é o que fica guardado (D-A3-15). Funções puras.

export const CATEGORIAS_DO_REVISOR = ['tom', 'clareza', 'alegacao'] as const;
export type CategoriaDoRevisor = (typeof CATEGORIAS_DO_REVISOR)[number];

export const TIPOS_DE_TEXTO = ['explicacao', 'conversa', 'plano'] as const;
export type TipoDeTexto = (typeof TIPOS_DE_TEXTO)[number];

export const Parecer = z.strictObject({ problemas: z.array(z.enum(CATEGORIAS_DO_REVISOR)) });
export type Parecer = z.infer<typeof Parecer>;

export interface ParteDoTexto {
  /** O que é o trecho, nas palavras do prompt do revisor (`motivo`, `texto_do_anuncio`…). */
  parte: string;
  texto: string;
}

export interface TextoParaRevisar {
  tipo: TipoDeTexto;
  partes: ParteDoTexto[];
}

/** As categorias que o revisor apontou, sem repetir e na ordem do catálogo. */
export const categoriasDoParecer = (p: Parecer): CategoriaDoRevisor[] => CATEGORIAS_DO_REVISOR.filter((c) => p.problemas.includes(c));

/** A mensagem que vai ao revisor: o texto em JSON, e mais nada. */
export const mensagemDoRevisor = (t: TextoParaRevisar): string => JSON.stringify({ tipo: t.tipo, partes: t.partes });

const parte = (nome: string, texto: string): ParteDoTexto => ({ parte: nome, texto });

/** A explicação dos resultados ou de um aviso (Analista), e a leitura da revisão da semana (Relatórios). */
export function textoDaExplicacao(e: Explicacao): TextoParaRevisar {
  return {
    tipo: 'explicacao',
    partes: [parte('o_que_aconteceu', e.o_que_aconteceu), ...e.motivos.map((m) => parte('motivo', m)), parte('risco', e.risco_motivo), ...e.o_que_fazer.map((a) => parte('o_que_fazer', a))],
  };
}

/** A resposta da LIA numa conversa: os blocos e, numa decisão grande, a reunião de decisão. */
export function textoDaConversa(r: RespostaDaLia): TextoParaRevisar {
  const reuniao = r.reuniao
    ? [
        parte('reuniao_pauta', r.reuniao.pauta),
        ...r.reuniao.vozes.map((v) => parte(v.quem === 'voz_contraria' ? 'reuniao_voz_contraria' : `reuniao_voz_${v.quem}`, v.texto)),
        parte('reuniao_recomendacao', r.reuniao.recomendacao),
        parte('reuniao_risco', r.reuniao.risco_motivo),
      ]
    : [];
  return { tipo: 'conversa', partes: [...r.blocos.map((b) => parte(b.tipo, b.texto)), ...reuniao] };
}

/** O caminho de cada texto do plano (`textosDoPlano`), nas palavras do prompt do revisor. */
const PARTE_DO_PLANO: Array<[RegExp, string]> = [
  [/^summary$/, 'resumo'],
  [/^reasons\.\d+$/, 'porque'],
  [/^risk_reason$/, 'risco'],
  [/^to_do\.\d+$/, 'fazer'],
  [/^after$/, 'depois'],
  [/^goals\.\d+\.goal$/, 'objetivo'],
  [/^goals\.\d+\.how_to_know$/, 'como_saber'],
  [/^months\.\d+\.plan$/, 'plano_do_mes'],
  [/^dates\.\d+\.what$/, 'o_que_fazer_na_data'],
  [/^days\.\d+\.item$/, 'item_do_dia'],
  [/^offer$/, 'oferta'],
  [/^where$/, 'onde'],
  [/^ad_text$/, 'texto_do_anuncio'],
  [/^how_to_measure$/, 'como_medir'],
];
/** Rótulos que não são texto da IA para revisar: o nome do mês e o da data, que vêm do contexto e do calendário. */
const SEM_REVISAO = [/^months\.\d+\.month$/, /^dates\.\d+\.name$/];

/**
 * O plano do Estrategista: os textos na ordem da tela. O caminho que este mapa ainda não conhece (campo novo no
 * contrato) vai como `texto`: nada escrito pela IA fica sem revisão por falta de nome.
 */
export function textoDoPlano(c: PlanContent): TextoParaRevisar {
  return {
    tipo: 'plano',
    partes: textosDoPlano(c)
      .filter((x) => !SEM_REVISAO.some((r) => r.test(x.caminho)))
      .map((x) => parte(PARTE_DO_PLANO.find(([r]) => r.test(x.caminho))?.[1] ?? 'texto', x.texto)),
  };
}
