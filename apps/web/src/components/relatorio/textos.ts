import type { MonthlyReport, MonthlyReportBudgetChange, MonthlyReportTeam } from '@liame/contracts';
import { custoNaTela, FICHAS, type Ficha, ehMembro } from '@/components/equipe/textos';
import type { AvisoSemIa } from '@/components/explicar/textos';
import { dataNoFuso, diaMes, horaNoFuso, nomesDe } from '@/components/resultados/textos';
import { avisoDaLeitura, diaEscrito } from '@/components/revisao/textos';
import type { PeriodoDoDesenho } from '@/components/revisao/graficos';
import { naFrase } from '@/components/verba/nomes';
import { oQueMudou } from '@/components/verba/textos';
import { inteiro, reaisDeMicros } from '@/lib/formato';

// Regras e frases do "Relatório do mês" (mockups/prototipo-relatorio-mes.html, P24 aprovado em 21/10/2026). O
// relatório vem pronto da API, como foi gerado no dia 1º de manhã: aqui nada é calculado, só escrito (o tamanho das
// barras está em `graficos.ts`). Valor que a tela ainda não conhece tem um caminho (V23).

const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

/** "setembro" de um dia do mês. */
export const nomeDoMes = (dia: string): string => MESES[Number(dia.slice(5, 7)) - 1] ?? dia.slice(5, 7);
/** "Setembro de 2026". */
export const mesEscrito = (dia: string): string => `${nomeDoMes(dia).replace(/^./, (c) => c.toUpperCase())} de ${dia.slice(0, 4)}`;
/** O mês da URL (`?mes=2026-09`) só vale no formato; o resto é ignorado (abre o relatório mais recente). */
export const mesValido = (s: string | null): string | null => (s && /^\d{4}-(0[1-9]|1[0-2])$/.test(s) ? s : null);

/** O mês que o relatório do dia 1º fecha: o anterior ao dia em que ele sai ("2026-11-01" → "2026-10-01"). */
export function mesQueFecha(dia: string): string {
  const [ano, mes] = [Number(dia.slice(0, 4)), Number(dia.slice(5, 7))];
  return mes === 1 ? `${ano - 1}-12-01` : `${ano}-${String(mes - 1).padStart(2, '0')}-01`;
}

/** "no domingo, 01/11" / "na quinta-feira, 01/10": o sábado e o domingo pedem "no" (V121). */
export function naData(dia: string): string {
  const escrito = diaEscrito(dia);
  return `${escrito.startsWith('sábado') || escrito.startsWith('domingo') ? 'no' : 'na'} ${escrito}`;
}

/** "no domingo, 01/11, às 05:10", no fuso da loja. */
export function noMomento(iso: string, fuso: string): string {
  const instante = new Date(iso);
  return `${naData(dataNoFuso(instante, fuso))}, às ${horaNoFuso(instante, fuso)}`;
}

/** O período dos desenhos do mês: setembro contra agosto. */
export function periodoDoMes(r: Pick<MonthlyReport, 'month' | 'previous_month'>): PeriodoDoDesenho {
  const [este, anterior] = [nomeDoMes(r.month.from), nomeDoMes(r.previous_month.from)];
  return {
    agora: `${diaMes(r.month.from)} a ${diaMes(r.month.to)}`,
    antes: `${diaMes(r.previous_month.from)} a ${diaMes(r.previous_month.to)}`,
    noAgora: `em ${este}`,
    noAntes: `em ${anterior}`,
    dicaAgora: este,
    dicaAntes: anterior,
    igual: 'igual ao mês anterior',
    noPeriodo: 'no mês',
  };
}

/**
 * A linha do envio por e-mail, como no protótipo: para quantas pessoas foi e quando; que ainda vai sair; ou por que
 * não saiu. Situação que a tela não conhece não vira frase.
 */
export function envioDoRelatorio(email: MonthlyReport['email'], fuso: string): string | null {
  if (email.status === 'enviado' && email.sent_at) {
    return `Enviado por e-mail ${noMomento(email.sent_at, fuso)}, para ${email.recipients === 1 ? '1 pessoa' : `${inteiro(email.recipients)} pessoas`}.`;
  }
  if (email.status === 'pendente') return 'O e-mail deste relatório ainda não saiu: ele sai a partir das 07:00.';
  if (email.status === 'desligado') return 'O envio por e-mail não está ligado nesta empresa: o relatório fica só aqui.';
  if (email.status === 'sem_destinatario') return 'Ninguém recebeu por e-mail: na empresa, ninguém com o nível que recebe confirmou o e-mail.';
  if (email.status === 'falhou') return 'O envio por e-mail não chegou a ninguém: o relatório fica só aqui.';
  if (email.status === 'expirado') return 'O prazo do e-mail (até o dia 7) passou sem dar para enviar: o relatório fica só aqui.';
  return null;
}

/** A frase do topo da tela: fala do e-mail só quando a empresa o recebe. */
export function introDoRelatorio(email: MonthlyReport['email'] | null): string {
  const comEmail = email !== null && (email.status === 'enviado' || email.status === 'pendente');
  return `O mês que fechou: o que vendeu, cada semana, o que cada campanha trouxe no caixa, a verba, o que a equipe fez e o que fica para o mês seguinte. Sai no dia 1º de manhã${comEmail ? ', na tela e por e-mail' : ''}.`;
}

/** Por que a leitura do mês é a do sistema: o aviso da revisão, com os títulos do relatório (como no protótipo). */
export const avisoDaLeituraDoMes = (reading: MonthlyReport['reading']): AvisoSemIa | null =>
  avisoDaLeitura(reading, { atrasada: 'O relatório saiu sem a leitura da LIA', semIa: 'O relatório deste mês saiu sem a leitura da LIA' });

/** Não há mês anterior para comparar (o primeiro mês com as vendas conectadas): nenhum número do topo tem o "antes". */
export const semMesAnterior = (r: Pick<MonthlyReport, 'totals'>): boolean => r.totals.every((m) => m.before === null);

/** As semanas das pontas cortadas no mês, numa frase: "a de 01/09 a 06/09 começou na segunda-feira, 31/08…". */
export function notaDoCorte(weeks: MonthlyReport['weeks']): string | null {
  const partes: string[] = [];
  const primeira = weeks[0];
  const ultima = weeks.at(-1);
  if (primeira && primeira.week.from !== primeira.from) partes.push(`a de ${diaMes(primeira.from)} a ${diaMes(primeira.to)} começou ${naData(primeira.week.from)}`);
  if (ultima && ultima !== primeira && ultima.week.to !== ultima.to) partes.push(`a de ${diaMes(ultima.from)} a ${diaMes(ultima.to)} termina ${naData(ultima.week.to)}`);
  if (!partes.length) return null;
  return `As semanas das pontas estão cortadas no mês: ${partes.join(', e ')}. A revisão de cada uma tem a semana inteira.`;
}

// ------------------------------------------------------------------ a verba do mês

export type VerbaNaTela = {
  gasto: string;
  /** O teto do mês ("R$ 5.500,00"); nulo sem teto. */
  teto: string | null;
  /** "de R$ 5.500,00 · 81% do teto"; nulo sem teto. */
  doTeto: string | null;
  acima: boolean;
  /** A frase embaixo da barra: quanto sobrou ou quanto passou, e o que o Liame faz acima do teto. */
  frase: string | null;
  /** A largura da barra do gasto e a posição da marca do teto, na mesma régua (de 0 a 100); nulas sem teto. */
  barra: { gasto: number; teto: number } | null;
  /** O que o leitor de tela lê no lugar da barra. */
  falado: string | null;
  /** As plataformas cuja leitura não chegou ao fim do mês. */
  atrasadas: string | null;
};

const pct = (v: bigint, maior: bigint): number => (maior <= 0n ? 0 : Number((v * 10_000n) / maior) / 100);

export function verbaNaTela(b: NonNullable<MonthlyReport['budget']>): VerbaNaTela {
  const gasto = BigInt(b.spend_micros);
  // "do Google Ads", "da Meta e do Google Ads": a preposição vem com o nome (V121), com os nomes do e-mail do mês.
  const atrasadas = b.missing.length
    ? `O gasto ${b.missing.map((p) => nomesDe(p).de).join(' e ')} vale até a última leitura, que não chegou ao fim do mês.`
    : null;
  if (b.limit_micros === null) return { gasto: reaisDeMicros(gasto), teto: null, doTeto: null, acima: false, frase: null, barra: null, falado: null, atrasadas };
  const teto = BigInt(b.limit_micros);
  const acima = gasto > teto;
  const maior = acima ? gasto : teto;
  const doTeto = teto > 0n ? Number((gasto * 100n + teto / 2n) / teto) : 0;
  const frase = acima
    ? `Passou do teto em ${reaisDeMicros(gasto - teto)}. Com o gasto acima do teto, o Liame não aprova aumento de verba nem retomada, e não pausa nada sozinho.`
    : `Ficou dentro do teto: sobraram ${reaisDeMicros(teto - gasto)}.`;
  return {
    gasto: reaisDeMicros(gasto),
    teto: reaisDeMicros(teto),
    doTeto: `de ${reaisDeMicros(teto)} · ${inteiro(doTeto)}% do teto`,
    acima,
    frase,
    barra: { gasto: pct(gasto, maior), teto: pct(teto, maior) },
    falado: `Gasto do mês: ${reaisDeMicros(gasto)}, ${inteiro(doTeto)}% do teto de ${reaisDeMicros(teto)}.`,
    atrasadas,
  };
}

const CONFERENCIA: Record<string, (a: string) => string> = {
  confere: (a) => `, e conferido com ${a}`,
  mudou: (a) => `; depois, ${a} mostrou outra situação`,
  acima: () => '; depois, gastou mais do que a verba permite',
};

/** Uma mudança do mês: o que mudou (como na Verba do mês) e quem aprovou, quando e como foi conferida. */
export function mudancaDoMes(m: MonthlyReportBudgetChange): { titulo: string; sub: string; icone: 'trend-up' | 'trend-down' | 'pause' | 'play' } {
  const estado = (x: MonthlyReportBudgetChange['from']) => ({ status: x.status, daily_micros: x.daily_micros === null ? null : Number(x.daily_micros) });
  const titulo = oQueMudou({ target: m.target, from: estado(m.from), to: estado(m.to) });
  const a = naFrase(m.provider).a;
  const quem = m.approved_by ? `Aprovado por ${m.approved_by.name} em ${diaMes(m.executed_on)}, com o código do app` : `Pedido por ${m.requested_by.name}, feito em ${diaMes(m.executed_on)}`;
  const conferencia = m.check ? (CONFERENCIA[m.check]?.(a) ?? '') : '';
  const sobe = m.to.daily_micros !== null && m.from.daily_micros !== null && BigInt(m.to.daily_micros) > BigInt(m.from.daily_micros);
  const desce = m.to.daily_micros !== null && m.from.daily_micros !== null && BigInt(m.to.daily_micros) < BigInt(m.from.daily_micros);
  const icone = sobe ? 'trend-up' : desce ? 'trend-down' : m.to.status === 'pausado' ? 'pause' : 'play';
  return { titulo, sub: `${quem}${conferencia}.`, icone };
}

// ------------------------------------------------------------------ o que a equipe fez

/** Os um ou dois números de cada funcionário que o protótipo mostra, pela ordem em que importam. */
const PRINCIPAIS: Record<string, Array<[chave: string, texto: (n: number) => string]>> = {
  lia: [['respostas', (n) => (n === 1 ? 'resposta na Conversa' : 'respostas na Conversa')], ['demandas', (n) => (n === 1 ? 'virou demanda' : 'viraram demanda')]],
  analista: [['explicacoes', (n) => (n === 1 ? 'explicação' : 'explicações')], ['fez_sentido', (n) => (n === 1 ? 'fez sentido para quem leu' : 'fizeram sentido para quem leu')]],
  relatorios: [['revisoes', (n) => (n === 1 ? 'revisão da semana' : 'revisões da semana')], ['com_leitura_da_ia', () => 'com a leitura da LIA']],
  estrategista: [['planos_aprovados', (n) => (n === 1 ? 'plano aprovado' : 'planos aprovados')]],
  pesquisador: [['paginas_lidas', (n) => (n === 1 ? 'página lida' : 'páginas lidas')], ['sugestoes', (n) => (n === 1 ? 'sugestão para Minha marca' : 'sugestões para Minha marca')]],
  criativo: [['pecas_escritas', (n) => (n === 1 ? 'peça feita' : 'peças feitas')], ['pecas_aprovadas', (n) => (n === 1 ? 'aprovada' : 'aprovadas')]],
  crm: [['mensagens_propostas', (n) => (n === 1 ? 'mensagem proposta' : 'mensagens propostas')], ['mensagens_enviadas', (n) => (n === 1 ? 'enviada' : 'enviadas')]],
  social: [['respostas_propostas', (n) => (n === 1 ? 'resposta sugerida' : 'respostas sugeridas')], ['respostas_aprovadas', (n) => (n === 1 ? 'aprovada e enviada ao Google' : 'aprovadas e enviadas ao Google')]],
  trafego: [['recomendacoes', (n) => (n === 1 ? 'recomendação' : 'recomendações')], ['mesma_direcao', () => 'na mesma direção do que a equipe fez']],
  compliance: [['textos_barrados', (n) => (n === 1 ? 'texto barrado antes de aparecer' : 'textos barrados antes de aparecer')], ['textos_conferidos', (n) => (n === 1 ? 'texto conferido' : 'textos conferidos')]],
};

/**
 * O Social media no mês em que ele propôs post (A6 · Z6, os posts): os posts primeiro, e as respostas sugeridas quando
 * houve. No mês sem post, a lista de sempre (as respostas), para quem só tem as respostas ligadas não ler "0 posts".
 */
const SOCIAL_COM_POSTS: Array<[chave: string, texto: (n: number) => string]> = [
  ['posts_propostos', (n) => (n === 1 ? 'post proposto' : 'posts propostos')],
  ['posts_publicados', (n) => (n === 1 ? 'aprovado e publicado' : 'aprovados e publicados')],
  ['respostas_propostas', (n) => (n === 1 ? 'resposta sugerida' : 'respostas sugeridas')],
];

export type MembroDoMes = { chave: string; nome: string; cargo: string; icone: Ficha['icone']; feito: Array<{ valor: string; texto: string }> };

/** Quem trabalhou no mês, com os números que o protótipo mostra (só os acima de zero, menos o primeiro). */
export function equipeDoMes(t: MonthlyReportTeam): MembroDoMes[] {
  return t.members.flatMap((m) => {
    if (!ehMembro(m.key)) return [];
    const ficha = FICHAS[m.key];
    const valores = new Map(m.stats.map((s) => [s.key, Number(s.value)]));
    const lista = m.key === 'social' && (valores.get('posts_propostos') ?? 0) > 0 ? SOCIAL_COM_POSTS : (PRINCIPAIS[m.key] ?? []);
    const feito = lista
      .filter(([chave], i) => valores.has(chave) && (i === 0 || (valores.get(chave) ?? 0) > 0))
      .map(([chave, texto]) => {
        const n = valores.get(chave) ?? 0;
        return { valor: inteiro(n), texto: texto(n) };
      });
    return feito.length ? [{ chave: m.key, nome: ficha.nome, cargo: ficha.cargo, icone: ficha.icone, feito }] : [];
  });
}

/** O custo de IA do mês, em reais pela cotação guardada (ou em dólar sem ela), e quanto ele é do teto do mês. */
export function custoDoMes(t: MonthlyReportTeam): { valor: string; doTeto: string | null } {
  const valor = custoNaTela(t.ai.spent_usd_micros, t.usd_brl);
  const [gasto, teto] = [BigInt(t.ai.spent_usd_micros), BigInt(t.ai.ceiling_usd_micros)];
  // A porcentagem é a do dólar, a moeda do teto; o reais é só para a tela (D-A3-14).
  const doTeto = teto > 0n ? `${inteiro(Number((gasto * 100n + teto / 2n) / teto))}%` : null;
  return { valor, doTeto };
}
