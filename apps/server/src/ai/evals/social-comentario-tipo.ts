import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { type PedidoDeTipoDoComentario, RespostaDoTipo, TIPOS_DA_IA, tipoDaResposta } from '../social/comentario-tipo.js';
import type { Avaliacao } from './avaliar.js';

// Casos de eval do tipo do comentário pela IA (A6, Z11, parte 2d-4a; D-A6-87 e D-A6-101): dados versionados em
// `evals/social_comentario_tipo/casos.jsonl`. Cada caso é um comentário que a regra do Liame deixa sem tipo (o teste
// confere: o eval mede o que a IA recebe na produção), com a rede, a legenda do post, o @ da marca quando há e os tipos
// aceitos (o ambíguo de verdade aceita dois). O contexto e a mensagem são os da produção, e o avaliador também
// (`tipoDaResposta`, com a conferência da marcação). O grupo `injecao` não aceita falha nenhuma (`GRUPOS_SEM_FALHA`): o
// comentário que manda escolher um tipo não pode escolher por ele.

export const GRUPOS_DO_TIPO = ['pergunta', 'reclamacao', 'elogio', 'marcacao', 'ofensivo', 'golpe', 'nenhum', 'ironia', 'injecao'] as const;

export const CasoDoTipo = z.strictObject({
  id: z.string().regex(/^[a-z0-9-]{3,60}$/),
  grupo: z.enum(GRUPOS_DO_TIPO),
  descricao: z.string().min(10).max(300),
  rede: z.enum(['instagram', 'facebook']),
  legenda: z.string().max(2200),
  texto: z.string().min(1).max(1000),
  /** O @ da conta da marca no Instagram, sem o "@"; nulo na Página. */
  usuario_da_marca: z.string().min(1).max(30).nullable().default(null),
  espera: z.strictObject({
    /** Os tipos aceitos: um, ou dois no comentário ambíguo de verdade. */
    tipo: z.array(z.enum(TIPOS_DA_IA)).min(1).max(2),
  }),
  gravadas: z.strictObject({
    boa: z.unknown(),
    ruins: z.array(z.strictObject({ resposta: z.unknown(), falha: z.string().min(3) })).default([]),
  }),
});
export type CasoDoTipo = z.infer<typeof CasoDoTipo>;

/** Lê e valida o arquivo de casos; linha em branco e linha começando com `//` são ignoradas. */
export function carregarCasosDoTipo(caminho: string): CasoDoTipo[] {
  const casos: CasoDoTipo[] = [];
  readFileSync(caminho, 'utf8')
    .split('\n')
    .forEach((linha, i) => {
      const texto = linha.trim();
      if (!texto || texto.startsWith('//')) return;
      let bruto: unknown;
      try {
        bruto = JSON.parse(texto);
      } catch {
        throw new Error(`${caminho}, linha ${i + 1}: não é JSON`);
      }
      const r = CasoDoTipo.safeParse(bruto);
      if (!r.success) throw new Error(`${caminho}, linha ${i + 1}: ${r.error.issues.map((x) => `${x.path.join('.')}: ${x.message}`).join('; ')}`);
      casos.push(r.data);
    });
  const ids = casos.map((c) => c.id);
  const repetido = ids.find((id, i) => ids.indexOf(id) !== i);
  if (repetido) throw new Error(`${caminho}: caso repetido "${repetido}"`);
  return casos;
}

/** O pedido do caso como a produção o monta. */
export function pedidoDoCasoDoTipo(c: CasoDoTipo): PedidoDeTipoDoComentario {
  return { rede: c.rede, legenda: c.legenda, texto: c.texto, usuarioDaMarca: c.usuario_da_marca };
}

/** Avaliador determinístico: o formato, a conferência de produção (a marcação sem @ de outra pessoa) e os tipos aceitos. */
export function avaliarTipoDoComentario(caso: CasoDoTipo, bruto: unknown): Avaliacao {
  let valor = bruto;
  if (typeof bruto === 'string') {
    try {
      valor = JSON.parse(bruto);
    } catch {
      return { ok: false, falhas: ['formato: a resposta não é JSON'] };
    }
  }
  const lida = RespostaDoTipo.safeParse(valor);
  if (!lida.success) return { ok: false, falhas: [`formato: ${lida.error.issues.map((i) => `${i.path.join('.') || '(raiz)'}: ${i.message}`).join('; ')}`] };
  const { tipo, descarte } = tipoDaResposta(lida.data, { texto: caso.texto, usuarioDaMarca: caso.usuario_da_marca });
  const falhas: string[] = [];
  if (descarte) falhas.push(`descartado_${descarte}: o modelo disse "${lida.data.tipo}"`);
  if (!caso.espera.tipo.includes(tipo)) falhas.push(`tipo: veio "${tipo}", o caso aceita ${caso.espera.tipo.map((t) => `"${t}"`).join(' ou ')}`);
  return { ok: falhas.length === 0, falhas };
}
