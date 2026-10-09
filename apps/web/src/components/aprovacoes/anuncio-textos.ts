import type { ActionResponse, BudgetMonthResponse } from '@liame/contracts';
import { plataforma } from '@/components/contas/textos';
import { diaMes, type Frase, type Trecho } from '@/components/resultados/textos';
import { Fontes, type LinhaDeFonte, type Texto } from '@/components/resumo/textos';
import type { NomeIcone } from '@/components/ui/icone';
import { horaDe, inteiro, quandoComHora, reaisDeMicros } from '@/lib/formato';
import { etiquetaDoDecidido, type PedidoApresentado, recusaDe, resultadoDe, type Risco } from './textos';

// O pedido de anúncio em Aprovações (A4 · X8; mockups/prototipo-anuncios.html, P9 aprovado em 05/10/2026): mudar a
// verba diária, pausar ou retomar uma campanha, um conjunto ou um anúncio, e a volta de cada um. O servidor manda o
// objeto, a situação e a verba de antes e de depois, a recomendação de que o pedido nasceu e a última tentativa de
// execução; aqui eles viram o título, a frase do Lite, o antes e depois, o porquê, o resultado, o caminho do pedido e
// o que se oferece depois (desfazer, pedir de novo). Funções puras: o "agora" entra como parâmetro.

type Acao = ActionResponse;
export type AcaoDeAnuncio = Acao & { target: NonNullable<Acao['target']>; from: NonNullable<Acao['from']>; to: NonNullable<Acao['to']> };
export type TipoDoAnuncio = 'verba' | 'pausar' | 'retomar';

/** O pedido é de um objeto de anúncio? (Os outros, como o cupom do Regem, seguem com os textos de sempre.) */
export function ehPedidoDeAnuncio(a: Acao): a is AcaoDeAnuncio {
  return Boolean(a.target && a.from && a.to);
}

const reais = (micros: number): string => reaisDeMicros(BigInt(Math.round(micros)));
const b = (t: string): Trecho => ({ t, b: true });
const maiuscula = (t: string): string => t.charAt(0).toLocaleUpperCase('pt-BR') + t.slice(1);
const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const ANDANDO = new Set(['aguardando_aprovacao', 'aprovada', 'executando']);

/** Como a frase chama a plataforma do pedido: "a Meta", "na Meta", "com a Meta", "à Meta", "ela". */
function naFrase(provider: string): { a: string; A: string; na: string; com: string; ao: string; ela: string } {
  if (provider === 'meta_ads') return { a: 'a Meta', A: 'A Meta', na: 'na Meta', com: 'com a Meta', ao: 'à Meta', ela: 'ela' };
  if (provider === 'google_ads') return { a: 'o Google', A: 'O Google', na: 'no Google', com: 'com o Google', ao: 'ao Google', ela: 'ele' };
  const nome = plataforma(provider).nome;
  return { a: nome, A: nome, na: `em ${nome}`, com: `com ${nome}`, ao: `a ${nome}`, ela: 'ela' };
}

/** Quem pediu: a pessoa, ou o funcionário de IA (no modo Aprovação). */
export function quemPediu(a: Pick<Acao, 'agent_key' | 'requested_by'>): { nome: string; funcionario: boolean } {
  if (!a.agent_key) return { nome: a.requested_by.name, funcionario: false };
  return { nome: a.agent_key === 'trafego' ? 'Gestor de tráfego' : 'Funcionário de IA', funcionario: true };
}

export function tipoDoAnuncio(a: AcaoDeAnuncio): TipoDoAnuncio {
  if (a.tool.endsWith('_pausar')) return 'pausar';
  if (a.tool.endsWith('_retomar')) return 'retomar';
  return 'verba';
}

/** Como o objeto entra numa frase: "a campanha “Smash em dobro”", "do conjunto “Noite · raio de 3 km”", "no anúncio". */
export function alvoNaFrase(a: AcaoDeAnuncio): { o: string; do: string; no: string; fem: boolean } {
  const nome = `“${a.target.name}”`;
  if (a.target.kind === 'campanha') return { o: `a campanha ${nome}`, do: `da campanha ${nome}`, no: 'na campanha', fem: true };
  const tipo = a.target.kind === 'anuncio' ? 'anúncio' : 'conjunto';
  return { o: `o ${tipo} ${nome}`, do: `do ${tipo} ${nome}`, no: `no ${tipo}`, fem: false };
}

/** O que a tela precisa saber do mês para dizer quanto o pedido pesa até o fim dele e quais limites ele passou. */
export type MesDoPedido = { nome: string; faltam: number; tetoPorCampanha: number | null; passo: number | null; mudancasPorHora: number | null };

export function mesDoPedido(v: BudgetMonthResponse | null): MesDoPedido | null {
  if (!v) return null;
  const limite = v.rules.rate_limit;
  return {
    nome: MESES[Number(v.period.slice(5, 7)) - 1] ?? v.period,
    faltam: v.days_left,
    tetoPorCampanha: v.limits.campaign_daily_micros,
    passo: v.rules.change_percent_max,
    mudancasPorHora: limite && limite.window_minutes === 60 ? limite.max : null,
  };
}

// ------------------------------------------------------------------ o pedido em palavras

type Mudanca = [item: string, antes: string, depois: string];

export type TextosDoAnuncio = {
  tipo: TipoDoAnuncio;
  titulo: string;
  /** O que pesa na lista, ao lado do risco: "−R$ 4,00/dia", "para de gastar", "até R$ 18,00/dia". */
  impacto: string;
  /** O risco na tela segue a direção do dinheiro: o que sobe o gasto é médio; reduzir e pausar, baixo. */
  risco: Risco;
  /** A frase do Lite: o que acontece se a pessoa aprovar. */
  frase: Frase;
  /** O selo ao lado do risco: "Dá para desfazer" ou "É a volta de um pedido". */
  chip: string;
  mudancas: Mudanca[];
  /** "Risco e limites": o que o pedido faz com o gasto e os limites que ele passou. */
  doRisco: string;
  desfazer: string;
  /** O que está valendo depois de executado, e depois de desfeito. */
  feito: Frase;
  desfeito: string;
  depoisDeAprovar: string;
  /** "Desfazer cria um pedido novo para …". */
  volta: string;
};

const sinal = (micros: number): string => `${micros < 0 ? '−' : '+'}${reais(Math.abs(micros))}`;
const porcento = (de: number, para: number): string => `${para < de ? '−' : '+'}${inteiro(Math.round((Math.abs(para - de) / de) * 100))}%`;

export function textosDoAnuncio(a: AcaoDeAnuncio, mes: MesDoPedido | null): TextosDoAnuncio {
  const tipo = tipoDoAnuncio(a);
  const alvo = alvoNaFrase(a);
  const p = naFrase(a.provider);
  const A = maiuscula(alvo.o);
  const daCampanha = a.target.kind !== 'campanha' && a.target.campaign ? `, da campanha “${a.target.campaign.name}”,` : '';
  const g = (palavra: string) => (alvo.fem ? `${palavra.slice(0, -1)}a` : palavra);
  const [pausado, ativo, apagado] = [g('pausado'), g('ativo'), g('apagado')];
  const ateOFim = (porDia: number) => (mes ? reais(Math.abs(porDia) * mes.faltam) : null);
  const [de, para] = [a.from.daily_micros, a.to.daily_micros];
  let t: TextosDoAnuncio;

  if (tipo === 'verba' && de !== null && para !== null) {
    const reduz = para < de;
    const fim = ateOFim(para - de);
    const r = a.recommendation;
    const motivo = !r ? '' : reduz ? ` Nos 7 dias até ${diaMes(r.window.to)}, a margem dos pedidos não pagou o anúncio.` : ` Nos 7 dias até ${diaMes(r.window.to)}, ela deu lucro folgado e gastou quase toda a verba.`;
    const limites = [mes?.passo ? `até ${String(mes.passo).replace('.', ',')}% por pedido` : null, mes?.tetoPorCampanha ? `o teto por campanha (${reais(mes.tetoPorCampanha)} por dia)` : 'o teto por campanha', 'a verba do mês'].filter(
      (x): x is string => x !== null,
    );
    t = {
      tipo,
      titulo: `${reduz ? 'Reduzir' : 'Aumentar'} a verba ${alvo.do}`,
      impacto: `${sinal(para - de)}/dia`,
      risco: reduz ? 'baixo' : 'medio',
      frase: [
        { t: `A verba diária ${alvo.do} ${reduz ? 'cai' : 'sobe'} de ` },
        b(reais(de)),
        { t: ' para ' },
        b(reais(para)),
        { t: ` (${porcento(de, para)}).${motivo}${reduz || !fim || !mes ? '' : ` Até o fim de ${mes.nome} são ${fim} a mais.`} Se você aprovar, o Liame confere ${p.com} e faz a mudança.` },
      ],
      chip: 'Dá para desfazer',
      mudancas: [['Verba diária', reais(de), reais(para)], ['Gasto por dia', '—', sinal(para - de)], ...(reduz || !fim || !mes ? [] : [[`Até o fim de ${mes.nome}`, '—', `+${fim}`] as Mudanca])],
      doRisco: reduz
        ? `Reduz o gasto.${mes?.passo ? ` Está dentro do limite de ${String(mes.passo).replace('.', ',')}% por pedido;` : ''} ${mes?.passo ? 'reduzir' : 'Reduzir'} não depende do teto por campanha nem da verba do mês.`
        : `Aumenta o gasto em ${reais(para - de)} por dia. O pedido passou pelos limites da empresa: ${limites.slice(0, -1).join(', ')} e ${limites.at(-1)}.`,
      desfazer: `Dá para desfazer: um pedido novo devolve a verba para ${reais(de)}, se ninguém mexer ${alvo.no} depois. Se alguém mexer, o Liame não passa por cima.`,
      feito: [{ t: `a verba ${alvo.do} está em ` }, b(reais(para)), { t: ' por dia' }],
      desfeito: `a verba ${alvo.do} voltou para ${reais(de)} por dia`,
      depoisDeAprovar: `O Liame faz a mudança ${p.na} em instantes.`,
      volta: `voltar a verba para ${reais(de)} por dia`,
    };
  } else if (tipo === 'retomar') {
    const verba = para ?? de;
    const fim = verba ? ateOFim(verba) : null;
    const gasto = verba
      ? `volta a aparecer e a gastar até ${reais(verba)} por dia.${fim && mes ? ` Até o fim de ${mes.nome} são até ${fim}.` : ''}`
      : 'volta a aparecer e a gastar dentro da verba que já existe: a verba não muda.';
    t = {
      tipo,
      titulo: `Retomar ${alvo.o}`,
      impacto: verba ? `até ${reais(verba)}/dia` : 'volta a gastar',
      risco: 'medio',
      frase: [{ t: `${A}${daCampanha} ${gasto} Se você aprovar, o Liame confere ${p.com} e retoma.` }],
      chip: 'Dá para desfazer',
      mudancas: [['Situação', pausado, ativo], ...(verba ? [['Verba diária', 'não gasta', `até ${reais(verba)}`] as Mudanca, ...(fim && mes ? [[`Até o fim de ${mes.nome}`, '—', `até ${fim}`] as Mudanca] : [])] : [])],
      doRisco: verba ? `Volta a gastar até ${reais(verba)} por dia. O pedido passou pela verba do mês.` : 'Volta a gastar, dentro da verba que já existe. Retomar só é aceito com o teto do mês definido.',
      desfazer: `Dá para desfazer: um pedido novo pausa de novo, se ninguém mexer ${alvo.no} depois.`,
      feito: [{ t: `${alvo.o} está ` }, b(ativo)],
      desfeito: `${alvo.o} voltou a ficar ${pausado}`,
      depoisDeAprovar: `O Liame retoma ${p.na} em instantes.`,
      volta: 'pausar de novo',
    };
  } else {
    // Pausar (e a mudança de verba sem os dois valores, que a tela não sabe desenhar: cai aqui só se o servidor mandar assim).
    const verba = de;
    t = {
      tipo: 'pausar',
      titulo: `Pausar ${alvo.o}`,
      impacto: 'para de gastar',
      risco: 'baixo',
      frase: [{ t: `${A}${daCampanha} para de aparecer e de gastar${verba ? ` (hoje ${reais(verba)} por dia)` : ''}. Fica ${pausado}, não ${apagado}: dá para retomar depois. Se você aprovar, o Liame confere ${p.com} e pausa.` }],
      chip: 'Dá para desfazer',
      mudancas: [['Situação', ativo, pausado], ...(verba ? [['Verba diária', reais(verba), 'não gasta'] as Mudanca] : [])],
      doRisco: 'Para o gasto. Pausar não depende do teto por campanha nem da verba do mês.',
      desfazer: `Dá para desfazer: um pedido novo retoma, se ninguém mexer ${alvo.no} depois.`,
      feito: [{ t: `${alvo.o} está ` }, b(pausado)],
      desfeito: `${alvo.o} voltou a ficar ${ativo}`,
      depoisDeAprovar: `O Liame pausa ${p.na} em instantes.`,
      volta: 'retomar',
    };
  }

  // A volta de um pedido: o título, a frase e os limites dizem que ela devolve o que estava antes.
  if (a.undoes) {
    const voltaDaVerba = t.tipo === 'verba' && de !== null && para !== null;
    const limites = [mes?.passo ? `do limite de ${String(mes.passo).replace('.', ',')}% por pedido` : null, 'do teto por campanha'].filter((x): x is string => x !== null);
    t = {
      ...t,
      titulo: voltaDaVerba ? `Desfazer: voltar a verba ${alvo.do} para ${reais(para)}` : `Desfazer: ${t.tipo === 'pausar' ? 'pausar de novo' : 'retomar'} ${alvo.o}`,
      frase: [
        ...(voltaDaVerba
          ? [{ t: `A verba diária ${alvo.do} volta de ` }, b(reais(de)), { t: ' para ' }, b(reais(para))]
          : [{ t: `${A}${daCampanha} volta a ficar ` }, b(t.tipo === 'pausar' ? pausado : ativo)]),
        { t: `, como estava antes do pedido que está sendo desfeito. Se você aprovar, o Liame confere ${p.com} e desfaz.` },
      ],
      chip: 'É a volta de um pedido',
      doRisco: `Devolve o que estava antes. A volta fica fora ${limites.join(' e ')}, mas conta na verba do mês${mes?.mudancasPorHora ? ` e no limite de ${mes.mudancasPorHora} mudanças de verba por hora` : ''}.`,
      desfazer: 'A volta não tem volta: para mudar de novo, faça um pedido novo.',
      depoisDeAprovar: `O Liame desfaz ${p.na} em instantes.`,
    };
  }
  return t;
}

/** O pedido de anúncio no formato dos outros pedidos (a lista e os avisos usam só o título, o impacto e o "depois de aprovar"). */
export function anuncioApresentado(a: AcaoDeAnuncio, mes: MesDoPedido | null = null): PedidoApresentado {
  const t = textosDoAnuncio(a, mes);
  return { titulo: t.titulo, resumo: t.frase.map((x) => x.t).join(''), impacto: t.impacto, mudancas: t.mudancas, desfazer: t.desfazer, depoisDeAprovar: t.depoisDeAprovar };
}

/** "· pela recomendação do Gestor de tráfego" ou "· é a volta de outro pedido", no cabeçalho do pedido. */
export function origemDoAnuncio(a: Acao): string | null {
  if (a.undoes) return 'é a volta de outro pedido';
  return a.recommendation && !a.agent_key ? 'pela recomendação do Gestor de tráfego' : null;
}

// ------------------------------------------------------------------ o porquê (a recomendação de que o pedido nasceu)

export type PorqueDoAnuncio = {
  itens: Array<{ valor: Texto; rotulo: string; sub: Texto }>;
  /** A regra que recomendou, com a versão e a confiança. */
  regra: Texto;
  fontes: LinhaDeFonte[];
};

const REGRA: Record<string, (percent: number | null) => string> = {
  prejuizo: (pc) => `campanha em prejuízo nos últimos 7 dias pede uma redução${pc ? ` de ${pc}%` : ''} na verba`,
  prejuizo_forte: () => 'campanha com a margem conhecida abaixo da metade do que gastou nos últimos 7 dias pede a pausa',
  lucro_no_limite: (pc) => `campanha com lucro folgado (margem de pelo menos uma vez e meia o investido) e gasto de 80% ou mais da verba pede um aumento${pc ? ` de ${pc}%` : ''}`,
};

/** O porquê do pedido que nasceu de uma recomendação: os números do retrato dela, cada um com a fonte. Nulo no pedido comum e na volta. */
export function porqueDoAnuncio(a: AcaoDeAnuncio): PorqueDoAnuncio | null {
  const r = a.recommendation;
  if (!r || a.undoes) return null;
  const fontes = new Fontes();
  const janela = `${diaMes(r.window.from)} a ${diaMes(r.window.to)}`;
  const nomeDaPlataforma = plataforma(a.provider).nome;
  const n = (micros: string | null, fonte: string) => (micros === null ? null : fontes.n(reaisDeMicros(micros), fonte));
  const gasto = n(r.spend_micros, `${nomeDaPlataforma} · gasto da campanha · ${janela}`);
  const receita = n(r.revenue_micros, `Regem · receita da campanha confirmada no caixa · ${janela}`);
  const margem = n(r.margin_known_micros, `Regem · margem dos pedidos com custo cadastrado · ${janela}`);
  const pedidos = r.orders === null ? null : fontes.n(inteiro(r.orders), `Regem · pedidos da campanha confirmados no caixa · ${janela}`);
  const verba = r.daily_budget_micros === null ? null : reaisDeMicros(r.daily_budget_micros);
  const daVerba: Texto = verba ? [{ t: `a verba é de ${verba} por dia` }] : [{ t: 'a verba não mora na campanha' }];
  const itens: PorqueDoAnuncio['itens'] = [];
  const sobe = r.tool === 'orcamento_aumentar';

  if (sobe && margem && gasto) itens.push({ valor: [{ num: margem }], rotulo: 'de margem conhecida', sub: [{ t: 'para ' }, { num: gasto }, { t: ' investidos em 7 dias' }] });
  else if (gasto) itens.push({ valor: [{ num: gasto }], rotulo: 'gastos em 7 dias', sub: daVerba });
  if (pedidos) itens.push({ valor: [{ num: pedidos }, { t: r.orders === 1 ? ' pedido' : ' pedidos' }], rotulo: r.orders === 1 ? 'confirmado no caixa' : 'confirmados no caixa', sub: receita ? [{ num: receita }, { t: ' de receita' }] : [] });
  if (sobe) {
    // Quanto da verba a campanha gastou na janela: o gasto de 7 dias sobre 7 vezes a verba diária.
    const [g, v] = [r.spend_micros === null ? null : BigInt(r.spend_micros), r.daily_budget_micros === null ? null : BigInt(r.daily_budget_micros)];
    if (g !== null && v !== null && v > 0n) {
      const uso = fontes.n(`${inteiro(Number((g * 100n + (v * 7n) / 2n) / (v * 7n)))}%`, 'Liame · gasto de 7 dias ÷ verba diária × 7 · calculado pelo sistema');
      itens.push({ valor: [{ num: uso }], rotulo: 'da verba foi gasta', sub: daVerba });
    }
  } else if (r.spend_micros !== null && r.margin_known_micros !== null && margem) {
    const falta = BigInt(r.spend_micros) - BigInt(r.margin_known_micros);
    if (falta > 0n) {
      const faltou = fontes.n(reaisDeMicros(falta), 'Liame · investimento − margem conhecida da campanha · calculado pelo sistema');
      itens.push({ valor: [{ num: faltou }], rotulo: 'faltaram para pagar o anúncio', sub: [{ t: 'a margem conhecida foi de ' }, { num: margem }] });
    }
  }
  const confianca = fontes.n(`${r.confidence_pct.replace('.', ',')}%`, 'Liame · confiança da recomendação (gasto observado e margem conhecida) · calculada pelo sistema');
  const descricao = REGRA[r.rule]?.(r.percent);
  return {
    itens,
    regra: [{ t: `Regra do Gestor de tráfego (versão ${r.rule_version})${descricao ? `: ${descricao}` : ''}. Confiança de ` }, { num: confianca }, { t: ': é evidência, não certeza.' }],
    fontes: fontes.lista,
  };
}

// ------------------------------------------------------------------ o que aconteceu com o pedido decidido

/** O que a tela oferece depois do resultado. */
export type DepoisDoAnuncio =
  | { tipo: 'nada' }
  /** Dá para desfazer (para quem opera campanhas), com a nota do que a volta faz. */
  | { tipo: 'desfazer'; nota: string }
  /** A volta já foi pedida e espera aprovação. */
  | { tipo: 'volta-pendente'; pedido: string }
  /** A volta foi executada. */
  | { tipo: 'volta-feita'; pedido: string }
  /** Não foi executado: dá para pedir de novo, pela gaveta. */
  | { tipo: 'pedir-de-novo'; rotulo: string; nota: string | null }
  | { tipo: 'nota'; texto: string };

export type ResultadoDoAnuncio = {
  tom: 'ok' | 'espera' | 'falha' | 'neutro';
  icone: NomeIcone;
  forte: string;
  texto: Frase;
  /** Só no Pro: o código que a plataforma mandou na recusa ("Código do Google"). */
  tecnico?: { rotulo: string; valor: string } | null;
  depois: DepoisDoAnuncio;
};

/**
 * O que vem depois de "recusou na conferência. Nada mudou.": o que a plataforma respondeu, entre aspas e nas palavras
 * dela (o Google escreve em inglês; protótipo P13), com o código dela para o Pro. O motivo que é uma frase do Liame
 * (a autorização venceu, a campanha sumiu) sai sem aspas. A resposta de antes de 09/10/2026 não separava as duas
 * coisas (`provider_reply` não vinha): o motivo sai inteiro entre aspas, como sempre saiu.
 */
function respostaDaRecusa(a: AcaoDeAnuncio, p: ReturnType<typeof naFrase>): Pick<ResultadoDoAnuncio, 'texto' | 'tecnico'> {
  const resposta = a.execution?.provider_reply;
  if (resposta === undefined) return { texto: a.status_reason ? [{ t: ` O que ${p.a} respondeu: “${a.status_reason}”` }] : [], tecnico: null };
  if (resposta === null) return { texto: a.status_reason ? [{ t: ` ${maiuscula(a.status_reason)}` }] : [], tecnico: null };
  const emIngles = a.provider === 'google_ads' ? ', em inglês, como ele escreve' : '';
  return {
    texto: [{ t: ` O que ${p.a} respondeu${emIngles}: “${resposta.text}”` }],
    tecnico: resposta.code ? { rotulo: `Código ${a.provider === 'google_ads' ? 'do Google' : 'da plataforma'}`, valor: resposta.code } : null,
  };
}

const BLOQUEIO: Array<[comeco: string, texto: string]> = [
  ['trava ativa', 'há uma trava ativa na empresa'],
  ['sem aprovação válida', 'a aprovação deixou de valer para o plano atual'],
  ['escrita em ', 'a função de mudar anúncios está desligada para esta conta'],
];

function aprovadoPor(a: Acao): string {
  const aprovacao = [...a.approvals].reverse().find((x) => x.current_plan && x.sufficient) ?? a.approvals.at(-1) ?? null;
  return aprovacao ? `Aprovado por ${aprovacao.approver_name} às ${horaDe(aprovacao.created_at)}` : 'Aprovado pela política (dentro dos limites)';
}

/** O resultado do pedido que já saiu da fila: recusado, esperando a plataforma, recusado por ela, mudado por alguém, executado ou desfeito. */
export function resultadoDoAnuncio(a: AcaoDeAnuncio, t: TextosDoAnuncio): ResultadoDoAnuncio {
  const p = naFrase(a.provider);
  const alvo = alvoNaFrase(a);
  const aprov = aprovadoPor(a);
  const x = a.execution ?? null;

  if (recusaDe(a) || a.status === 'cancelada' || a.status === 'expirada') {
    return { tom: 'falha', icone: 'x', forte: '', texto: [{ t: resultadoDe(a).texto }], depois: { tipo: 'nada' } };
  }
  if (a.status === 'aprovada' || a.status === 'executando') {
    if (a.next_attempt_at) {
      const motivo = a.status_reason ?? `${p.a} pediu para esperar`;
      return { tom: 'espera', icone: 'clock', forte: `${aprov}. Ainda não foi executado:`, texto: [{ t: ` ${motivo}. O Liame tenta de novo às ${horaDe(a.next_attempt_at)}, sem insistir antes.` }], depois: { tipo: 'nada' } };
    }
    return { tom: 'espera', icone: 'clock', forte: `${aprov}.`, texto: [{ t: ` ${t.depoisDeAprovar}` }], depois: { tipo: 'nada' } };
  }
  if (a.status === 'falhou') {
    if (x?.status === 'estado_mudou') {
      const [era, agora] = [a.from.daily_micros, x.observed?.daily_micros ?? null];
      const oque = t.tipo === 'verba' && era !== null && agora !== null && agora !== era ? `A verba agora é de ${reais(agora)} (era de ${reais(era)} quando o pedido foi feito).` : 'Não está mais como quando o pedido foi feito.';
      return {
        tom: 'falha',
        icone: 'x',
        forte: `${aprov}, mas não foi executado: alguém mexeu ${alvo.no} ${p.na} depois do pedido.`,
        texto: [{ t: ` ${oque} O Liame não passa por cima do que uma pessoa mudou. Nada mudou.` }],
        depois: { tipo: 'pedir-de-novo', rotulo: t.tipo === 'verba' ? 'Pedir de novo, a partir do valor de agora' : 'Pedir de novo', nota: null },
      };
    }
    if (x?.status === 'bloqueada') {
      const motivo = BLOQUEIO.find(([comeco]) => a.status_reason?.startsWith(comeco))?.[1] ?? a.status_reason ?? 'a execução foi barrada';
      return { tom: 'falha', icone: 'x', forte: `${aprov}, mas não foi executado:`, texto: [{ t: ` ${motivo}. Nada mudou.` }], depois: { tipo: 'nada' } };
    }
    if (x?.status === 'falhou' && a.attempts > 0) {
      // Esperou a plataforma vezes demais: o próprio motivo diz para conferir o objeto antes de pedir de novo.
      return { tom: 'falha', icone: 'x', forte: `${aprov}, mas a execução foi encerrada depois de esperar ${p.a}.`, texto: [{ t: ` ${maiuscula(a.status_reason ?? 'A plataforma não respondeu a tempo.')}` }], depois: { tipo: 'pedir-de-novo', rotulo: 'Pedir de novo', nota: null } };
    }
    if (x?.status === 'falhou') {
      return {
        tom: 'falha',
        icone: 'x',
        forte: `${aprov}, mas ${p.a} recusou na conferência. Nada mudou.`,
        ...respostaDaRecusa(a, p),
        depois: { tipo: 'pedir-de-novo', rotulo: 'Pedir de novo', nota: `O Liame pede ${p.ao} que valide a mudança antes de escrever. Quando ${p.ela} recusa, nada é escrito e o pedido não é repetido.` },
      };
    }
    return { tom: 'falha', icone: 'x', forte: '', texto: [{ t: resultadoDe(a).texto }], depois: { tipo: 'nada' } };
  }
  // Executado.
  const volta = a.undone_by ?? null;
  if (volta?.status === 'executada') {
    return { tom: 'neutro', icone: 'undo', forte: 'Desfeito', texto: [{ t: ` por um pedido novo: ${t.desfeito}.` }], depois: { tipo: 'volta-feita', pedido: volta.id } };
  }
  const quando = horaDe(x?.finished_at ?? a.updated_at);
  if (x?.no_write) {
    return {
      tom: 'ok',
      icone: 'check',
      forte: `${aprov} e conferido às ${quando}.`,
      texto: [{ t: ` ${maiuscula(alvo.o)} já estava como o pedido queria: o Liame não precisou mudar nada.` }],
      depois: { tipo: 'nota', texto: 'Como o Liame não mudou nada, não há o que desfazer por aqui.' },
    };
  }
  let depois: DepoisDoAnuncio;
  if (a.undoes) depois = { tipo: 'nota', texto: t.desfazer };
  else if (volta && ANDANDO.has(volta.status)) depois = { tipo: 'volta-pendente', pedido: volta.id };
  else depois = { tipo: 'desfazer', nota: t.desfazer };
  return { tom: 'ok', icone: 'check', forte: `${aprov} e executado às ${quando}.`, texto: [{ t: ` ${p.A} confirmou: ` }, ...t.feito, { t: '.' }], depois };
}

/** As colunas do "antes e depois" dizem o tempo certo: o que espera compara agora e depois; o executado, antes e depois; o que não foi executado, como era e o que o pedido queria. */
export function colunasDoAnuncio(a: AcaoDeAnuncio): { rotulo: string; legenda: string; colunas: [string, string] } {
  const p = naFrase(a.provider);
  if (a.status === 'executada') return { rotulo: 'Antes e depois', legenda: `O que mudou ${p.na}`, colunas: ['Antes', 'Depois'] };
  if (a.status === 'falhou' || a.status === 'cancelada' || a.status === 'expirada') return { rotulo: 'O que o pedido queria', legenda: 'Como era quando foi pedido e o que o pedido queria', colunas: ['Era', 'Pedido'] };
  return { rotulo: 'Antes e depois', legenda: `O que muda ${p.na} se o pedido for aprovado`, colunas: ['Agora', 'Depois'] };
}

// ------------------------------------------------------------------ o caminho do pedido

export type PassoDoPedido = { situacao: 'ok' | 'espera' | 'falha' | 'depois'; titulo: string; sub: string | null };

/** O caminho do pedido que foi aprovado: quem pediu, quem aprovou e o que aconteceu na plataforma. Vazio no recusado, no cancelado e no expirado. */
export function caminhoDoAnuncio(a: AcaoDeAnuncio, agora: Date): PassoDoPedido[] {
  if (recusaDe(a) || a.status === 'cancelada' || a.status === 'expirada' || a.status === 'aguardando_aprovacao' || a.status === 'sombra') return [];
  const p = naFrase(a.provider);
  const x = a.execution ?? null;
  const aprovacao = [...a.approvals].reverse().find((y) => y.current_plan && y.sufficient) ?? a.approvals.at(-1) ?? null;
  const passos: PassoDoPedido[] = [
    { situacao: 'ok', titulo: `Pedido por ${quemPediu(a).nome}`, sub: quandoComHora(a.created_at, agora) },
    aprovacao ? { situacao: 'ok', titulo: `Aprovado por ${aprovacao.approver_name}, com o código do app`, sub: quandoComHora(aprovacao.created_at, agora) } : { situacao: 'ok', titulo: 'Aprovado pela política', sub: null },
  ];
  const fim = x ? quandoComHora(x.finished_at, agora) : null;
  const semEscrever = fim ? `${fim} · nada foi escrito` : 'nada foi escrito';
  const faltam: PassoDoPedido[] = [
    { situacao: 'depois', titulo: `Mudança ${p.na}`, sub: null },
    { situacao: 'depois', titulo: 'Leitura de conferência', sub: null },
  ];
  if (a.status === 'aprovada' || a.status === 'executando') {
    if (a.next_attempt_at) {
      const espera = `${a.status_reason ?? 'a plataforma pediu para esperar'}; ${a.attempts}ª espera. O Liame tenta de novo às ${horaDe(a.next_attempt_at)}`;
      return [...passos, { situacao: 'espera', titulo: `${p.A} pediu para esperar`, sub: espera }, ...faltam];
    }
    return [...passos, { situacao: 'espera', titulo: `Conferindo ${p.com}…`, sub: `o Liame lê o que está valendo e pede que ${p.a} valide a mudança` }, ...faltam];
  }
  if (a.status === 'falhou') {
    if (x?.status === 'estado_mudou') return [...passos, { situacao: 'falha', titulo: `O que está ${p.na} mudou depois do pedido`, sub: semEscrever }];
    if (x?.status === 'bloqueada') return [...passos, { situacao: 'falha', titulo: 'A execução foi barrada', sub: semEscrever }];
    if (x?.status === 'falhou' && a.attempts > 0) return [...passos, { situacao: 'falha', titulo: `${p.A} não respondeu a tempo`, sub: fim }];
    return [...passos, { situacao: 'falha', titulo: `${p.A} recusou na conferência`, sub: semEscrever }];
  }
  if (x?.no_write) return [...passos, { situacao: 'ok', titulo: `Conferido ${p.com}: já estava como o pedido`, sub: fim }];
  return [...passos, { situacao: 'ok', titulo: `${p.A} validou a mudança`, sub: fim }, { situacao: 'ok', titulo: `Mudança feita ${p.na}`, sub: fim }, { situacao: 'ok', titulo: 'Leitura de conferência: está como o pedido', sub: fim }];
}

/** A segunda linha do pedido de anúncio decidido, na lista. */
export function etiquetaDoAnuncio(a: AcaoDeAnuncio): string {
  if (a.status === 'executada' && a.undone_by?.status === 'executada') return 'Desfeito';
  // "Esperando a Meta", "O Google recusou" (P13); a plataforma que a tela ainda não conhece sai como "a plataforma".
  const conhecida = a.provider === 'meta_ads' || a.provider === 'google_ads' ? naFrase(a.provider) : null;
  if ((a.status === 'aprovada' || a.status === 'executando') && a.next_attempt_at) return `Esperando ${conhecida?.a ?? 'a plataforma'}`;
  if (a.status === 'falhou' && a.execution?.status === 'falhou' && a.attempts === 0) return `${conhecida?.A ?? 'A plataforma'} recusou`;
  return etiquetaDoDecidido(a);
}

/** A recusa do servidor ao desfazer, em palavras; `naoDa`: alguém mexeu depois (a tela mostra o aviso e oferece um pedido novo). */
export function erroAoDesfazer(problema: { code: string; detail?: string; title: string }, a: AcaoDeAnuncio): { texto: string; naoDa: boolean } {
  const alvo = alvoNaFrase(a);
  const p = naFrase(a.provider);
  if (problema.code === 'estado-mudou') return { texto: `alguém mexeu ${alvo.no} ${p.na} depois. O Liame não passa por cima do que uma pessoa mudou. Para mudar de novo, faça um pedido novo.`, naoDa: true };
  if (problema.code === 'acao-duplicada') return { texto: 'A volta deste pedido já foi pedida.', naoDa: false };
  return { texto: problema.detail ?? problema.title, naoDa: false };
}
