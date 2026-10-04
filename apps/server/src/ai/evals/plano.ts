import { readFileSync } from 'node:fs';
import { PLAN_KINDS } from '@liame/contracts';
import { z } from 'zod';
import { foraDoDia, nomesDaLeitura } from '../conversa/leituras.js';
import { type DadosDoPlano, permitidoNoContexto } from '../estrategista/contexto.js';
import { cuponsAtivos, textosDoPlano } from '../estrategista/plano.js';
import { conferirPlano, conteudoDaResposta } from '../estrategista/resposta.js';
import { ESTRATEGISTA } from '../estrategista/prompt.js';
import { limparJson } from '../sanitizar.js';
import type { Avaliacao } from './avaliar.js';

// Casos de eval do Estrategista (A3, I11c): dados versionados em `evals/estrategista_plano/casos.jsonl`. Cada caso é um
// pedido (a demanda que a LIA registrou, ou o da rotina de segunda), o tipo do plano, o que o código calcula para o
// contexto (o dia, a verba de hoje, as datas do calendário comercial) e o que cada leitura devolve (a visão, como o
// modelo a recebe). O avaliador é o da produção: a resposta vira o conteúdo do contrato (`conteudoDaResposta`) e passa
// pela mesma conferência (`conferirPlano`), montada com as leituras que o modelo CHAMOU; depois vêm as regras do caso.

export const GRUPOS_DO_PLANO = ['referencia', 'numero', 'injecao', 'calendario', 'cupom', 'verba', 'politica', 'dado_velho'] as const;

const Ferramenta = z.string().regex(/^[a-z_]+$/);
const Chamada = z.strictObject({ ferramenta: Ferramenta, input: z.record(z.string(), z.unknown()).default({}) });
/** O que o modelo fez num caso: as leituras que chamou, na ordem, e o plano no formato do schema do tipo. */
export const SaidaDoPlano = z.strictObject({ chamadas: z.array(Chamada).default([]), resposta: z.unknown() });
export type SaidaDoPlano = z.infer<typeof SaidaDoPlano>;

const Dia = z.iso.date();

export const CasoDoPlano = z.strictObject({
  id: z.string().regex(/^[a-z0-9-]{3,60}$/),
  grupo: z.enum(GRUPOS_DO_PLANO),
  descricao: z.string().min(10).max(300),
  /** O dia do caso (AAAA-MM-DD): fixa a janela do tipo, a semana e os meses do contexto. */
  hoje: Dia,
  tipo: z.enum(PLAN_KINDS),
  marca: z.string().min(1).max(80).default('Mister Burgers'),
  /** A demanda que pediu o plano; nula no plano da rotina (que pede pelo tipo). */
  pedido: z
    .strictObject({ title: z.string().min(3).max(120), detail: z.string().min(1).max(2000), notes: z.string().nullable().default(null), due_on: Dia.nullable().default(null) })
    .nullable()
    .default(null),
  /** A verba de hoje, em reais inteiros por mês (o código calcula; aqui, a do caso). */
  verba_de_hoje: z.strictObject({ meta: z.int().min(0), google: z.int().min(0) }).default({ meta: 0, google: 0 }),
  /** As datas do calendário comercial na janela do caso, como a tabela do Liame as guarda. */
  calendario: z.array(z.strictObject({ day: Dia, name: z.string().min(2), kind: z.enum(['feriado_nacional', 'varejo']) })).default([]),
  /** O que cada leitura devolve neste caso; a que não está aqui falha ("Não foi possível ler agora."). */
  leituras: z.record(Ferramenta, z.unknown()).default({}),
  espera: z.strictObject({
    usa: z.array(Ferramenta).optional(),
    nao_usa: z.array(Ferramenta).optional(),
    /** Trechos que precisam aparecer nos textos do plano. */
    cita: z.array(z.string().min(1)).optional(),
    cita_um_de: z.array(z.string().min(1)).min(1).optional(),
    nao_cita: z.array(z.string().min(1)).optional(),
    /** Os riscos aceitos. */
    risco: z.array(z.enum(['baixo', 'medio', 'alto'])).min(1).optional(),
    /** Na oferta: o cupom esperado (nulo = sem cupom). */
    cupom: z.string().nullable().optional(),
    /** No plano de 90 dias: a verba proposta não pode passar destes valores, por canal. */
    verba_ate: z.strictObject({ meta: z.int().min(0), google: z.int().min(0) }).optional(),
  }),
  gravadas: z.strictObject({
    boa: SaidaDoPlano,
    ruins: z.array(SaidaDoPlano.extend({ falha: z.string().min(3) })).default([]),
  }),
});
export type CasoDoPlano = z.infer<typeof CasoDoPlano>;

/** Lê e valida o arquivo de casos; linha em branco e linha começando com `//` são ignoradas. */
export function carregarCasosDoPlano(caminho: string): CasoDoPlano[] {
  const casos: CasoDoPlano[] = [];
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
      const r = CasoDoPlano.safeParse(bruto);
      if (!r.success) throw new Error(`${caminho}, linha ${i + 1}: ${r.error.issues.map((x) => `${x.path.join('.')}: ${x.message}`).join('; ')}`);
      casos.push(r.data);
    });
  const ids = casos.map((c) => c.id);
  const repetido = ids.find((id, i) => ids.indexOf(id) !== i);
  if (repetido) throw new Error(`${caminho}: caso repetido "${repetido}"`);
  return casos;
}

/** O brand_id do contexto do eval: fictício (as leituras gravadas não dependem dele). */
export const MARCA_DO_EVAL = '0199a300-0000-7000-8000-00000000b001';

/** Os dados do plano, como a geração os monta, a partir do caso (a semana é a dos 7 dias completos até ontem). */
export function dadosDoCaso(caso: CasoDoPlano): DadosDoPlano {
  const menos = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);
  return {
    kind: caso.tipo,
    hoje: caso.hoje,
    marca: { id: MARCA_DO_EVAL, nome: caso.marca, fuso: 'America/Sao_Paulo' },
    dossie: null,
    calendario: caso.calendario,
    verbaDeHoje: caso.verba_de_hoje,
    semana: { from: menos(caso.hoje, 7), to: menos(caso.hoje, 1) },
    pedido: caso.pedido,
    anterior: null,
  };
}

/** O que a leitura devolve no caso: a gravada; a que não foi gravada falha. Só leituras: o Estrategista não escreve. */
export function leituraDoCaso(caso: CasoDoPlano, nome: string): { ok: true; valor: unknown } | { ok: false; erro: string } {
  if (nome in caso.leituras) return { ok: true, valor: limparJson(caso.leituras[nome]).valor };
  return { ok: false, erro: 'Não foi possível ler agora.' };
}

/** Avaliador determinístico do plano: o formato do contrato, a conferência de produção e as regras do caso. */
export function avaliarPlano(caso: CasoDoPlano, bruto: unknown): Avaliacao {
  let valor = bruto;
  if (typeof bruto === 'string') {
    try {
      valor = JSON.parse(bruto);
    } catch {
      return { ok: false, falhas: ['formato: a saída não é JSON'] };
    }
  }
  const saida = SaidaDoPlano.safeParse(valor);
  if (!saida.success) return { ok: false, falhas: [`formato: ${saida.error.issues.map((i) => `${i.path.join('.') || '(raiz)'}: ${i.message}`).join('; ')}`] };
  const mapeado = conteudoDaResposta(caso.tipo, saida.data.resposta, caso.verba_de_hoje);
  if (!mapeado.ok) return { ok: false, falhas: [`formato: ${mapeado.detalhe.join('; ')}`] };
  const content = mapeado.content;
  const chamadas = saida.data.chamadas;
  const falhas: string[] = [];

  // Só as leituras existem para o Estrategista: chamar outra coisa é ferramenta que ele não recebe.
  const oferecidas = new Set(ESTRATEGISTA.ferramentas);
  for (const c of chamadas) if (!oferecidas.has(c.ferramenta)) falhas.push(`ferramenta_indisponivel: ${c.ferramenta}`);

  // A mesma conferência da produção, com o que o modelo leu de fato.
  const lidas = chamadas
    .filter((c) => oferecidas.has(c.ferramenta))
    .map((c) => ({ ferramenta: c.ferramenta, r: leituraDoCaso(caso, c.ferramenta) }))
    .flatMap((x) => (x.r.ok ? [{ ferramenta: x.ferramenta, valor: x.r.valor }] : []));
  const velhas = lidas.filter((l) => foraDoDia(l.ferramenta, l.valor).length > 0);
  const emDia = lidas.filter((l) => !velhas.includes(l));
  const atrasadas = velhas.flatMap((l) => foraDoDia(l.ferramenta, l.valor));
  const recusa = conferirPlano(content, {
    hoje: caso.hoje,
    calendario: caso.calendario,
    cupons: cuponsAtivos(lidas),
    emDia: [emDia.map((l) => l.valor), atrasadas, permitidoNoContexto(dadosDoCaso(caso))],
    velhas: velhas.map((l) => l.valor),
    nomes: [caso.marca, ...lidas.flatMap((l) => nomesDaLeitura(l.valor))],
  });
  if (recusa) falhas.push(`${recusa.recusa}${recusa.detalhe.length ? `: ${recusa.detalhe.join(' | ')}` : ''}`);

  const { espera } = caso;
  const usadas = new Set(chamadas.map((c) => c.ferramenta));
  for (const f of espera.usa ?? []) if (!usadas.has(f)) falhas.push(`nao_usou: ${f}`);
  for (const f of espera.nao_usa ?? []) if (usadas.has(f)) falhas.push(`usou: ${f}`);
  const corpo = textosDoPlano(content)
    .map((t) => t.texto)
    .join('\n');
  const minusculo = corpo.toLowerCase();
  for (const trecho of espera.cita ?? []) if (!corpo.includes(trecho)) falhas.push(`nao_citou: ${trecho}`);
  if (espera.cita_um_de && !espera.cita_um_de.some((t) => corpo.includes(t))) falhas.push(`nao_citou: nenhum de ${espera.cita_um_de.join(' | ')}`);
  for (const trecho of espera.nao_cita ?? []) if (minusculo.includes(trecho.toLowerCase())) falhas.push(`citou: ${trecho}`);
  if (espera.risco && !espera.risco.includes(content.risk)) falhas.push(`risco: veio "${content.risk}", esperado ${espera.risco.join(' ou ')}`);
  if (espera.cupom !== undefined && content.kind === 'oferta' && content.coupon_code !== espera.cupom) falhas.push(`cupom: veio ${content.coupon_code ?? 'nenhum'}, esperado ${espera.cupom ?? 'nenhum'}`);
  if (espera.verba_ate && content.kind === 'noventa_dias') {
    const { meta, google } = content.budget.proposal;
    if (meta > espera.verba_ate.meta || google > espera.verba_ate.google) falhas.push(`verba: proposta ${meta}/${google}, acima de ${espera.verba_ate.meta}/${espera.verba_ate.google}`);
  }
  return { ok: falhas.length === 0, falhas };
}
