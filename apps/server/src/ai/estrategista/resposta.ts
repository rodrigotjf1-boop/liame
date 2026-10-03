import { type PlanBudget, PlanContent, type PlanKind } from '@liame/contracts';
import { z } from 'zod';
import { conferirTexto, normalizar } from '../../policy/texto.js';
import { menosDias } from '../../results/fora-do-normal.js';
import { conferirNumeros } from '../verificador-numeros.js';
import { contasDaVerba, propostaDoPlano, textosDoPlano } from './plano.js';

// O formato da resposta do Estrategista (A3, I11; protótipo P8): um schema por tipo de plano, o mais simples possível
// (texto, lista, opção, número), com as chaves em português, como o prompt fala. Os limites de tamanho e a conferência
// são nossos, depois que a resposta volta, já no formato do contrato (`PlanContent`). Recusado, o plano não vai para
// Aprovações: a demanda volta para a fila do Estrategista.

const Comum = {
  resumo: z.string(),
  porques: z.array(z.string()),
  risco: z.enum(['baixo', 'medio', 'alto']),
  risco_motivo: z.string(),
  fazer: z.array(z.string()),
  depois: z.string(),
};

export const OfertaDoEstrategista = z.strictObject({
  ...Comum,
  oferta: z.string(),
  dia: z.string(),
  inicio: z.string(),
  fim: z.string(),
  onde: z.string(),
  texto_do_anuncio: z.string(),
  cupom: z.string().nullable(),
  como_medir: z.string(),
});

export const PautaDoEstrategista = z.strictObject({ ...Comum, dias: z.array(z.strictObject({ dia: z.string(), item: z.string() })) });

export const NoventaDiasDoEstrategista = z.strictObject({
  ...Comum,
  objetivos: z.array(z.strictObject({ objetivo: z.string(), como_saber: z.string() })),
  meses: z.array(z.strictObject({ mes: z.string(), plano: z.string() })),
  verba_proposta: z.strictObject({ meta: z.number(), google: z.number() }),
  datas: z.array(z.strictObject({ dia: z.string(), nome: z.string(), o_que_fazer: z.string() })),
});

/** O schema que vai ao modelo, pelo tipo do plano. */
export const RESPOSTA_DO_TIPO = { oferta: OfertaDoEstrategista, pauta: PautaDoEstrategista, noventa_dias: NoventaDiasDoEstrategista } as const;

type Oferta = z.infer<typeof OfertaDoEstrategista>;
type Pauta = z.infer<typeof PautaDoEstrategista>;
type NoventaDias = z.infer<typeof NoventaDiasDoEstrategista>;

const limpo = (s: string) => s.trim();
const comum = (r: Oferta | Pauta | NoventaDias) => ({
  summary: limpo(r.resumo),
  reasons: r.porques.map(limpo),
  risk: r.risco,
  risk_reason: limpo(r.risco_motivo),
  to_do: r.fazer.map(limpo),
  after: limpo(r.depois),
});

/**
 * A resposta do modelo no formato do contrato. A verba de hoje é a do código, nunca a do modelo. Fora do formato (do
 * schema ou dos limites do contrato), volta o problema de cada campo, para o log.
 */
export function conteudoDaResposta(kind: PlanKind, bruto: unknown, hoje: PlanBudget['today']): { ok: true; content: PlanContent } | { ok: false; detalhe: string[] } {
  const problemas = (issues: Array<{ path: PropertyKey[]; code: string }>) => issues.slice(0, 8).map((i) => `${i.path.map(String).join('.') || '(raiz)'}: ${i.code}`);
  let candidato: unknown;
  if (kind === 'oferta') {
    const r = OfertaDoEstrategista.safeParse(bruto);
    if (!r.success) return { ok: false, detalhe: problemas(r.error.issues) };
    const cupom = r.data.cupom?.trim().toUpperCase();
    candidato = {
      kind,
      ...comum(r.data),
      offer: limpo(r.data.oferta),
      day: limpo(r.data.dia),
      starts_at: limpo(r.data.inicio),
      ends_at: limpo(r.data.fim),
      where: limpo(r.data.onde),
      ad_text: limpo(r.data.texto_do_anuncio),
      coupon_code: cupom ? cupom : null,
      how_to_measure: limpo(r.data.como_medir),
    };
  } else if (kind === 'pauta') {
    const r = PautaDoEstrategista.safeParse(bruto);
    if (!r.success) return { ok: false, detalhe: problemas(r.error.issues) };
    candidato = { kind, ...comum(r.data), days: r.data.dias.map((d) => ({ day: limpo(d.dia), item: limpo(d.item) })) };
  } else {
    const r = NoventaDiasDoEstrategista.safeParse(bruto);
    if (!r.success) return { ok: false, detalhe: problemas(r.error.issues) };
    candidato = {
      kind,
      ...comum(r.data),
      goals: r.data.objetivos.map((o) => ({ goal: limpo(o.objetivo), how_to_know: limpo(o.como_saber) })),
      months: r.data.meses.map((m) => ({ month: limpo(m.mes), plan: limpo(m.plano) })),
      budget: { today: hoje, proposal: { meta: r.data.verba_proposta.meta, google: r.data.verba_proposta.google } },
      dates: r.data.datas.map((d) => ({ day: limpo(d.dia), name: limpo(d.nome), what: limpo(d.o_que_fazer) })),
    };
  }
  const c = PlanContent.safeParse(candidato);
  if (!c.success) return { ok: false, detalhe: problemas(c.error.issues) };
  return { ok: true, content: c.data };
}

/** Uma versão do plano como o modelo a lê (a anterior, na nova análise): as chaves do schema dele. A verba de hoje fica no contexto. */
export function respostaDoConteudo(c: PlanContent): Record<string, unknown> {
  const base = { resumo: c.summary, porques: c.reasons, risco: c.risk, risco_motivo: c.risk_reason, fazer: c.to_do, depois: c.after };
  switch (c.kind) {
    case 'oferta':
      return {
        ...base,
        oferta: c.offer,
        dia: c.day,
        inicio: c.starts_at,
        fim: c.ends_at,
        onde: c.where,
        texto_do_anuncio: c.ad_text,
        cupom: c.coupon_code,
        como_medir: c.how_to_measure,
      };
    case 'pauta':
      return { ...base, dias: c.days.map((d) => ({ dia: d.day, item: d.item })) };
    case 'noventa_dias':
      return {
        ...base,
        objetivos: c.goals.map((g) => ({ objetivo: g.goal, como_saber: g.how_to_know })),
        meses: c.months.map((m) => ({ mes: m.month, plano: m.plan })),
        verba_proposta: c.budget.proposal,
        datas: c.dates.map((d) => ({ dia: d.day, nome: d.name, o_que_fazer: d.what })),
      };
  }
}

/** Dias à frente que cada tipo de plano pode usar (a oferta começa amanhã; a pauta e o plano de 90 dias, hoje). */
export const JANELA_DO_TIPO: Record<PlanKind, number> = { oferta: 60, pauta: 14, noventa_dias: 92 };

/** Trechos que um plano do Estrategista nunca traz: a IA propõe, quem decide é a pessoa; e não manda ninguém a lugar nenhum. */
const PROIBIDOS = ['a ia decidiu', 'eu decidi', 'http://', 'https://', 'www.'];

/**
 * `formato` (o fim da oferta antes do começo, dias da pauta fora de ordem), `fora_da_janela` (dia antes de amanhã ou
 * depois do prazo do tipo), `data_fora_do_calendario` (data comemorativa que não está na tabela do Liame),
 * `cupom_desconhecido` (cupom que não está nos cupons lidos), `trecho_proibido`, `compliance` (regras de texto e o que
 * a marca não diz), `numero_fora` (número que não está no que o Estrategista leu) e `dado_velho` (número de uma leitura
 * com fonte fora do dia).
 */
export type RecusaDoPlano = 'formato' | 'fora_da_janela' | 'data_fora_do_calendario' | 'cupom_desconhecido' | 'trecho_proibido' | 'compliance' | 'numero_fora' | 'dado_velho';

export interface PermitidosNoPlano {
  /** Hoje, no fuso da loja (AAAA-MM-DD). */
  hoje: string;
  /** O calendário comercial que o contexto trouxe. */
  calendario: Array<{ day: string; name: string }>;
  /** Os códigos dos cupons que existem, das leituras de cupons desta geração. */
  cupons: string[];
  /** Tudo de onde um número pode sair (leituras em dia, o pedido, a versão anterior, o contexto). */
  emDia: unknown;
  /** As leituras com alguma fonte fora do dia. */
  velhas: unknown;
  /** Nomes que vieram dos dados da empresa: citar um nome não é a IA falando de política. */
  nomes: string[];
  /** O que a marca nunca diz (dossiê, I8). */
  daMarca?: string[];
}

const igual = (a: string, b: string) => normalizar(a).trim() === normalizar(b).trim();

/** Os campos que não dependem de quem escreveu: o horário da oferta e a ordem dos dias da pauta. */
function problemaDosCampos(c: PlanContent): string | null {
  if (c.kind === 'oferta' && c.ends_at <= c.starts_at) return 'a oferta termina antes de começar';
  if (c.kind === 'pauta' && c.days.some((d, i) => i > 0 && d.day <= c.days[i - 1]!.day)) return 'os dias da pauta fora de ordem ou repetidos';
  return null;
}

/**
 * O plano serve para Aprovações? Devolve o motivo da recusa (e o detalhe, para o log) ou nulo quando serve. Melhor
 * nenhum plano do que um com número que o sistema não entregou ou com data que não está no calendário (A3-5).
 */
export function conferirPlano(c: PlanContent, p: PermitidosNoPlano): { recusa: RecusaDoPlano; detalhe: string[] } | null {
  const campos = problemaDosCampos(c);
  if (campos) return { recusa: 'formato', detalhe: [campos] };
  const amanha = menosDias(p.hoje, -1);
  const ultimo = menosDias(p.hoje, -JANELA_DO_TIPO[c.kind]);
  const fora = (d: string, desde: string) => d < desde || d > ultimo;
  if (c.kind === 'oferta') {
    if (fora(c.day, amanha)) return { recusa: 'fora_da_janela', detalhe: [c.day] };
    if (c.coupon_code && !p.cupons.includes(c.coupon_code)) return { recusa: 'cupom_desconhecido', detalhe: [c.coupon_code] };
  }
  if (c.kind === 'pauta') {
    const longe = c.days.filter((d) => fora(d.day, p.hoje)).map((d) => d.day);
    if (longe.length) return { recusa: 'fora_da_janela', detalhe: longe };
  }
  if (c.kind === 'noventa_dias') {
    const longe = c.dates.filter((d) => fora(d.day, p.hoje)).map((d) => d.day);
    if (longe.length) return { recusa: 'fora_da_janela', detalhe: longe };
    const inventadas = c.dates.filter((d) => !p.calendario.some((x) => x.day === d.day && igual(x.name, d.name))).map((d) => `${d.day} ${d.name}`);
    if (inventadas.length) return { recusa: 'data_fora_do_calendario', detalhe: inventadas };
  }
  const textos = textosDoPlano(c).map((x) => x.texto);
  const minusculo = textos.join(' ').toLowerCase();
  const achados = PROIBIDOS.filter((x) => minusculo.includes(x));
  if (achados.length) return { recusa: 'trecho_proibido', detalhe: achados };
  // Compliance (I9): o código decide antes de qualquer revisor de IA. O que a marca não diz (I8) vale igual.
  const regras = conferirTexto(textos, { ignorar: p.nomes, daMarca: p.daMarca });
  if (regras.length) return { recusa: 'compliance', detalhe: regras.map((x) => `${x.regra}: ${x.trecho}`) };
  // O que o plano propõe nos campos e as contas da verba (feitas pelo código) também podem aparecer nos textos.
  const doPlano = [propostaDoPlano(c), c.kind === 'noventa_dias' ? contasDaVerba(c.budget) : []];
  const numeros = conferirNumeros(textos, [p.emDia, doPlano]);
  if (!numeros.ok) {
    // O número está numa leitura com fonte atrasada: não é invenção, mas o Estrategista não planeja com dado velho.
    const comAsVelhas = conferirNumeros(numeros.fora, [p.emDia, doPlano, p.velhas]);
    return { recusa: comAsVelhas.ok ? 'dado_velho' : 'numero_fora', detalhe: numeros.fora };
  }
  return null;
}

/** Como a tela diz cada regra do Compliance (protótipo P8, as mesmas palavras de Minha marca). */
const REGRA_EM_PALAVRAS: Record<string, string> = {
  politico_eleitoral: 'conteúdo político ou eleitoral (regra da Liame)',
  promessa_de_resultado: 'promessa de resultado (regra da Liame)',
  categoria_proibida: 'categoria que as plataformas proíbem (regra da Liame)',
  dado_pessoal: 'dado pessoal no texto',
  texto_longo: 'texto longo demais para conferir',
};

/**
 * A versão que uma pessoa editou: os campos (horário, ordem dos dias) e o Compliance com o que a marca não diz (o
 * texto do anúncio vai para a rua). Número e data são dela: não passam pela conferência do Estrategista. Devolve cada
 * problema em palavras, para a tela; vazio quando a versão serve.
 */
export function conferirEdicao(c: PlanContent, p: { nomes: string[]; daMarca?: string[] }): string[] {
  const campos = problemaDosCampos(c);
  if (campos) return [campos];
  return conferirTexto(
    textosDoPlano(c).map((x) => x.texto),
    { ignorar: p.nomes, daMarca: p.daMarca },
  ).map((x) => (x.regra === 'regra_da_marca' ? `"${x.trecho}" (o que a marca não diz, em Minha marca)` : (REGRA_EM_PALAVRAS[x.regra] ?? x.regra)));
}
