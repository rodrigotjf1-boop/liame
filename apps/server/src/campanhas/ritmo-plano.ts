import { z } from 'zod';
import { problemasDaVerba } from '../regiao/ritmo-da-semana.js';

// O ritmo da semana como pedido (plano da região, R7, parte 1b; protótipo aprovado pelo dono em 13/11/2026, D-RG-58 a
// D-RG-65). O Gestor de tráfego monta a tabela da semana (os 7 dias e a verba de cada campanha em cada dia) e pede em
// Aprovações; a pessoa aprova uma vez, com o código do app. Aqui ficam as partes puras: o estado que o pedido guarda (o
// que a pessoa vê e aprova), o recurso do pedido e o plano da ferramenta `ritmo_da_semana`. Aprovar não muda nada na
// Meta: o ritmo passa a "aprovado", e cada dia sai depois como um passo próprio pelo trilho de ações. Sem rede e sem
// banco.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DIA = /^\d{4}-\d{2}-\d{2}$/;
/** O objeto na Meta como o trilho o chama: a campanha ou o conjunto onde a verba diária mora. */
const RECURSO_DA_VERBA = /^(campanha|conjunto):\d{1,25}$/;

/** O recurso do pedido: `ritmo:<id>`, o ritmo da semana do Liame (`budget_rhythm`). */
export const recursoDoRitmo = (id: string): string => `ritmo:${id}`;

/** O id do ritmo no recurso do pedido, ou nulo quando o recurso é outro. */
export function ritmoDoRecurso(resourceId: string): string | null {
  const prefixo = recursoDoRitmo('');
  if (!resourceId.startsWith(prefixo)) return null;
  const id = resourceId.slice(prefixo.length);
  return UUID.test(id) ? id : null;
}

/** Até quantas campanhas entram num ritmo (o resto fica fora, com o motivo). */
export const CAMPANHAS_NO_RITMO = 30;

export const SituacaoDoRitmo = z.enum(['pedido', 'aprovado', 'parado', 'encerrado', 'cancelado']);
export type SituacaoDoRitmo = z.infer<typeof SituacaoDoRitmo>;

/** O porquê do peso de um dia, como a prévia o devolve (os campos que não são do tipo vêm nulos). */
const PorqueDoDia = z.object({
  kind: z.enum(['pedidos', 'setor', 'chuva', 'data']),
  share_pct: z.number().int().min(0).max(100).nullable(),
  text: z.string().max(200).nullable(),
  min: z.number().int().nullable(),
  max: z.number().int().nullable(),
  eve: z.boolean().nullable(),
});

/**
 * O estado do pedido: o que a pessoa vê e aprova. A semana (segunda a domingo), de onde veio o peso, os 7 dias com o
 * peso e os porquês, e cada campanha com a verba de hoje e a de cada dia. O plano e o hash dele saem daqui.
 */
export const EstadoDoRitmo = z.object({
  ritmo: z.string().regex(UUID),
  marca: z.string().regex(UUID),
  loja: z.object({ id: z.string().regex(UUID), nome: z.string().min(1).max(200) }),
  semana: z.object({ de: z.string().regex(DIA), ate: z.string().regex(DIA) }),
  fonte: z.enum(['loja', 'setor']),
  dias: z
    .array(z.object({ dia: z.string().regex(DIA), dia_da_semana: z.number().int().min(0).max(6), peso: z.number().min(0.5).max(1.5), porques: z.array(PorqueDoDia).max(8) }))
    .length(7),
  campanhas: z
    .array(
      z.object({
        recurso: z.string().regex(RECURSO_DA_VERBA),
        nome: z.string().min(1).max(300),
        base_micros: z.number().int().positive(),
        dias_micros: z.array(z.number().int().positive()).length(7),
      }),
    )
    .min(1)
    .max(CAMPANHAS_NO_RITMO),
  /** As campanhas que ficaram fora, com o porquê (a verba pequena, acima do teto…): só para a pessoa ver. */
  fora: z.array(z.object({ nome: z.string().max(300), motivo: z.string().max(60) })).max(50),
  /** O teto por campanha da empresa quando o ritmo foi montado; nulo sem teto. */
  teto_micros: z.number().int().positive().nullable(),
  moeda: z.string().min(3).max(3),
  situacao: SituacaoDoRitmo,
});
export type EstadoDoRitmo = z.infer<typeof EstadoDoRitmo>;

export type PlanoDoRitmo = { ok: true; desejado: EstadoDoRitmo } | { ok: false; motivo: string };

/**
 * O plano da ferramenta `ritmo_da_semana`: o ritmo pedido passa a aprovado. O que já foi decidido não volta a ser
 * pedido, e a tabela é conferida de novo pelos limites do dinheiro (cada mudança em até 10%, a faixa, o teto por
 * campanha e a semana sem gastar mais): um estado adulterado não vira plano. Função pura.
 */
export function planoDoRitmo(before: unknown): PlanoDoRitmo {
  const lido = EstadoDoRitmo.safeParse(before);
  if (!lido.success) return { ok: false, motivo: 'Esta ferramenta é para um ritmo da semana do Liame.' };
  const e = lido.data;
  if (e.situacao !== 'pedido') return { ok: false, motivo: MOTIVO_DA_SITUACAO[e.situacao] };
  for (const c of e.campanhas) {
    const problemas = problemasDaVerba(c.base_micros, c.dias_micros, e.teto_micros);
    if (problemas.length) return { ok: false, motivo: `A verba da campanha "${c.nome}" sai dos limites do ritmo (${problemas[0]}).` };
  }
  return { ok: true, desejado: { ...e, situacao: 'aprovado' } };
}

const MOTIVO_DA_SITUACAO: Record<Exclude<SituacaoDoRitmo, 'pedido'>, string> = {
  aprovado: 'Este ritmo já foi aprovado.',
  parado: 'Este ritmo foi parado. O Gestor de tráfego monta outro na semana que vem.',
  encerrado: 'A semana deste ritmo já acabou.',
  cancelado: 'Este ritmo foi cancelado.',
};

/** A verba da semana com o ritmo e a que a semana gastaria sem ele (7 dias da verba de hoje), em micros. */
export function somasDoRitmo(e: Pick<EstadoDoRitmo, 'campanhas'>): { comRitmo: number; semRitmo: number } {
  return {
    comRitmo: e.campanhas.reduce((s, c) => s + c.dias_micros.reduce((t, v) => t + v, 0), 0),
    semRitmo: e.campanhas.reduce((s, c) => s + c.base_micros * 7, 0),
  };
}
