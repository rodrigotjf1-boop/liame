import { readFileSync } from 'node:fs';
import { ClosedLoopResponse } from '@liame/contracts';
import { z } from 'zod';
import { Explicacao } from '../explicar/resposta.js';

// Casos de eval (A3, I3; ADR-006 item 8): dados versionados em `evals/<tarefa>/casos.jsonl`, um caso por
// linha. Cada caso traz a resposta da rota (`ClosedLoopResponse`) do período e do anterior, como o código
// a entrega: o contexto que a IA recebe é montado pelo mesmo código de produção. O caso de um aviso da
// Atenção (I4) leva também o aviso. O que se espera é dito em regras que o avaliador confere sem modelo
// nenhum.

export const GRUPOS = ['referencia', 'numero', 'injecao', 'politica', 'dado_parcial'] as const;

const Resposta = z.unknown();

export const CasoDeEval = z.strictObject({
  id: z.string().regex(/^[a-z0-9-]{3,60}$/),
  /** `referencia` cenário do dia a dia · `numero` tenta a IA a fazer conta · `injecao` instrução escondida no dado · `politica` assunto proibido · `dado_parcial` falta dado. */
  grupo: z.enum(GRUPOS),
  descricao: z.string().min(10).max(300),
  atual: ClosedLoopResponse,
  anterior: ClosedLoopResponse.nullable(),
  /**
   * Só nos casos do "Explicar" de um aviso da Atenção (I4): o aviso como a tela o recebe (os textos são os
   * que as regras da Atenção escrevem) e o nome da campanha dele. `atual` e `anterior` são os resultados dos
   * 7 dias completos. O código de produção põe o aviso na frente do contexto.
   */
  aviso: z
    .strictObject({
      kind: z.string().regex(/^[a-z0-9_]+$/),
      severity: z.enum(['critica', 'atencao', 'info']),
      title: z.string().min(1),
      detail: z.string().min(1),
      action: z.string().min(1),
      provider: z.string().regex(/^[a-z0-9_]+$/).nullable(),
      campaign: z.string().min(1).nullable(),
    })
    .optional(),
  espera: z.strictObject({
    /** Riscos aceitos; sem a lista, qualquer um. */
    risco: z.array(z.enum(['baixo', 'medio', 'alto'])).min(1).optional(),
    /** Trechos que precisam aparecer (todos). */
    cita: z.array(z.string().min(1)).optional(),
    /** Basta um destes aparecer. */
    cita_um_de: z.array(z.string().min(1)).min(1).optional(),
    /** Trechos que não podem aparecer (sem diferenciar maiúsculas). */
    nao_cita: z.array(z.string().min(1)).optional(),
  }),
  /**
   * Respostas gravadas, para provar o avaliador sem gastar: a boa tem de passar; cada ruim tem de falhar
   * pelo motivo indicado. O modo gravado do eval (sem chave do fornecedor) responde com a boa.
   */
  gravadas: z.strictObject({
    boa: Explicacao,
    ruins: z.array(z.strictObject({ resposta: Resposta, falha: z.string().min(3) })).default([]),
  }),
});
export type CasoDeEval = z.infer<typeof CasoDeEval>;

/** Lê e valida o arquivo de casos; linha em branco e linha começando com `//` são ignoradas. */
export function carregarCasos(caminho: string): CasoDeEval[] {
  const linhas = readFileSync(caminho, 'utf8').split('\n');
  const casos: CasoDeEval[] = [];
  linhas.forEach((linha, i) => {
    const texto = linha.trim();
    if (!texto || texto.startsWith('//')) return;
    let bruto: unknown;
    try {
      bruto = JSON.parse(texto);
    } catch {
      throw new Error(`${caminho}, linha ${i + 1}: não é JSON`);
    }
    const r = CasoDeEval.safeParse(bruto);
    if (!r.success) throw new Error(`${caminho}, linha ${i + 1}: ${r.error.issues.map((x) => `${x.path.join('.')}: ${x.message}`).join('; ')}`);
    casos.push(r.data);
  });
  const ids = casos.map((c) => c.id);
  const repetido = ids.find((id, i) => ids.indexOf(id) !== i);
  if (repetido) throw new Error(`${caminho}: caso repetido "${repetido}"`);
  return casos;
}
