import type { BudgetLimitsRequest, BudgetMonthChange, BudgetMonthResponse } from '@liame/contracts';
import { plataforma } from '@/components/contas/textos';
import { dataNoFuso, diaMes, type Frase, quandoNoFuso, somarDias, type Trecho } from '@/components/resultados/textos';
import { Fontes, type LinhaDeFonte, type Num, type Texto } from '@/components/resumo/textos';
import type { NomeIcone } from '@/components/ui/icone';
import type { Problema } from '@/lib/api';
import { reaisDeMicros } from '@/lib/formato';

// Regras e frases da tela Verba do mês (A4 · P9, aprovado em 05/10/2026; mockups/prototipo-anuncios.html). A conta é
// do servidor (`GET /v1/budget/month`): o gasto lido da Meta e do Google, o ritmo, a previsão, o que pesa hoje, os
// dois limites e o que o Liame mudou, conferido todo dia. Aqui os números viram as frases do protótipo; nada é
// calculado de novo, fora as porcentagens da barra, o dia em que a previsão passa do teto e a média por dia.
// Funções puras: o "agora" entra como parâmetro (LIC-006). Listas que crescem chegam como texto (V23): valor novo
// tem saída.

type Verba = BudgetMonthResponse;

/** Dinheiro da verba (micros em número inteiro) em reais, com centavos. */
const reais = (micros: number): string => reaisDeMicros(BigInt(Math.round(micros)));
const b = (t: string): Trecho => ({ t, b: true });
const maiuscula = (t: string): string => t.charAt(0).toLocaleUpperCase('pt-BR') + t.slice(1);
const plural = (n: number, um: string, varios: string): string => `${n} ${n === 1 ? um : varios}`;
const juntar = (itens: string[]): string => (itens.length <= 1 ? itens.join('') : `${itens.slice(0, -1).join(', ')} e ${itens.at(-1)}`);

const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

/** Como a frase chama cada plataforma de anúncio ("a Meta não foi lida", "o gasto do Google", "mudado na Meta"). */
type NaFrase = { nome: string; a: string; da: string; na: string; lida: string };
const NA_FRASE: Record<string, NaFrase> = {
  meta_ads: { nome: 'Meta', a: 'a Meta', da: 'da Meta', na: 'na Meta', lida: 'lida' },
  google_ads: { nome: 'Google', a: 'o Google', da: 'do Google', na: 'no Google', lida: 'lido' },
};
function naFrase(provider: string): NaFrase {
  const conhecida = NA_FRASE[provider];
  if (conhecida) return conhecida;
  const nome = plataforma(provider).nome;
  return { nome, a: nome, da: `de ${nome}`, na: `em ${nome}`, lida: 'lida' };
}

// ------------------------------------------------------------------ o mês

export type MesDaVerba = {
  /** "setembro". */
  nome: string;
  /** Até onde vai o gasto lido: "28/09". */
  ate: string;
  ultimoDia: number;
  /** "faltam 2 dias" ou "falta 1 dia" (contando hoje). */
  faltam: string;
  /** "outubro começa na quinta-feira, 01/10". */
  virada: string;
  /** Hoje é o dia 1: ainda não há dia inteiro deste mês para ler. */
  comecaHoje: boolean;
};

export function mesDaVerba(v: Verba): MesDaVerba {
  const mes = Number(v.period.slice(5, 7));
  const primeiroDoProximo = somarDias(v.month_end, 1);
  const semana = new Intl.DateTimeFormat('pt-BR', { weekday: 'long', timeZone: 'UTC' }).format(new Date(`${primeiroDoProximo}T00:00:00Z`));
  const no = semana === 'sábado' || semana === 'domingo' ? 'no' : 'na';
  return {
    nome: MESES[mes - 1] ?? v.period,
    ate: diaMes(v.through),
    ultimoDia: Number(v.month_end.slice(8, 10)),
    faltam: v.days_left === 1 ? 'falta 1 dia' : `faltam ${v.days_left} dias`,
    virada: `${MESES[mes % 12]} começa ${no} ${semana}, ${diaMes(primeiroDoProximo)}`,
    comecaHoje: v.through < v.month_start,
  };
}

/** O selo do topo: quando os números foram lidos, ou qual plataforma está sem a leitura de hoje. */
export function lidoDaVerba(v: Verba, agora: Date): string | null {
  if (!v.platforms.length) return null;
  const atrasada = v.platforms.find((p) => p.stale);
  if (atrasada) {
    const nome = naFrase(atrasada.provider).nome;
    return atrasada.last_success_at ? `${nome}: última leitura ${quandoNoFuso(atrasada.last_success_at, v.timezone, agora)}` : `${nome}: ainda sem leitura`;
  }
  const leituras = v.platforms.flatMap((p) => (p.last_success_at ? [p.last_success_at] : [])).sort();
  const ultima = leituras.at(-1);
  return ultima ? `Atualizado ${quandoNoFuso(ultima, v.timezone, agora)}` : null;
}

// ------------------------------------------------------------------ as faixas do topo

export type AvisoDaVerba = {
  chave: string;
  tipo: 'atencao' | 'perigo';
  icone: NomeIcone;
  titulo: string;
  texto: string;
  /** O botão da faixa: abrir Contas conectadas ou as campanhas (Resultados). */
  acao: 'contas' | 'campanhas' | null;
};

/**
 * O dia do mês em que a previsão passa do teto, no ritmo de agora. Nulo quando as contas foram lidas até dias
 * diferentes (a previsão não anda igual em todas) ou quando a conta, ao centavo, não passa em dia nenhum.
 */
export function diaQuePassaDoTeto(v: Verba): number | null {
  const teto = v.limits.month_micros;
  if (teto === null || v.forecast_days !== v.days_left) return null;
  const porDia = v.daily_micros + v.pending_daily_micros;
  for (let k = 1; k <= v.days_left; k++) {
    if (v.spend_micros + porDia * k > teto) return Number(somarDias(v.through, k).slice(8, 10));
  }
  return null;
}

export function avisosDaVerba(v: Verba, agora: Date): AvisoDaVerba[] {
  const mes = mesDaVerba(v);
  const avisos: AvisoDaVerba[] = [];
  for (const p of v.platforms) {
    if (!p.stale) continue;
    const f = naFrase(p.provider);
    if (!p.last_success_at || !p.read_through) {
      avisos.push({
        chave: `leitura-${p.provider}`,
        tipo: 'atencao',
        icone: 'clock',
        titulo: `${maiuscula(f.a)} ainda não foi ${f.lida}`,
        texto: `Sem a primeira leitura, o gasto ${f.da} não entra na conta do mês. O Liame tenta ler sozinho; se continuar assim, confira a conexão.`,
        acao: 'contas',
      });
      continue;
    }
    // Os dias que a leitura não cobre: do dia seguinte ao último lido até ontem.
    const primeiro = somarDias(p.read_through, 1);
    const faltou = primeiro >= v.through ? `o dia ${Number(v.through.slice(8, 10))} entra` : `os dias de ${diaMes(primeiro)} a ${diaMes(v.through)} entram`;
    avisos.push({
      chave: `leitura-${p.provider}`,
      tipo: 'atencao',
      icone: 'clock',
      titulo: `${maiuscula(f.a)} não foi ${f.lida} hoje: a última leitura é de ${quandoNoFuso(p.last_success_at, v.timezone, agora)}`,
      texto:
        `O gasto ${f.da} abaixo vale até ${diaMes(p.read_through)}; ${faltou} na previsão pelo ritmo. O Liame tenta ler de novo sozinho.` +
        (p.provider === 'meta_ads' ? ' Enquanto isso, um pedido novo continua lendo a campanha na Meta na hora.' : ''),
      acao: 'contas',
    });
  }
  const teto = v.limits.month_micros;
  if (teto !== null && v.remaining_micros !== null && v.remaining_micros < 0) {
    const jaPassou = v.spend_micros > teto;
    const dia = diaQuePassaDoTeto(v);
    avisos.push({
      chave: 'acima-do-teto',
      tipo: 'perigo',
      icone: 'alert',
      titulo: jaPassou ? `${maiuscula(mes.nome)} já passou do teto` : `No ritmo atual, ${mes.nome} passa do teto${dia === null ? '' : ` no dia ${dia}`}`,
      texto: jaPassou
        ? `Foram ${reais(v.spend_micros)} até ${mes.ate}, e o teto é de ${reais(teto)}. Reduzir a verba de uma campanha ou pausar uma, o Liame sempre aceita; aumentar e retomar ficam negados. Você também pode subir o teto do mês.`
        : 'Para caber, reduza a verba de uma campanha ou pause uma (isso o Liame sempre aceita), ou suba o teto do mês.',
      acao: 'campanhas',
    });
  }
  for (const o of v.overspend) avisos.push({ chave: `gasto-${o.action_id}`, tipo: 'atencao', icone: 'alert', titulo: o.title, texto: `${o.detail} ${o.action}`, acao: null });
  return avisos;
}

// ------------------------------------------------------------------ o cartão do mês

const pctDe = (parte: number, todo: number): number => (todo > 0 ? Math.max(0, Math.min(100, Math.round((parte / todo) * 100))) : 0);

export type BarraDaVerba = { gasto: number; previsto: number; acima: boolean; rotulo: string; legendaPrevisto: string };

/** A barra do teto: quanto do teto já foi gasto e até onde a previsão vai. Sem teto, não há barra. */
export function barraDaVerba(v: Verba): BarraDaVerba | null {
  const teto = v.limits.month_micros;
  if (teto === null) return null;
  const total = v.forecast_micros + v.pending_micros;
  const base = Math.max(teto, total);
  const acima = total > teto;
  const gasto = pctDe(v.spend_micros, base);
  const previsto = Math.max(gasto, pctDe(total, base));
  return {
    gasto,
    previsto,
    acima,
    rotulo: acima ? `Gasto até ontem: ${pctDe(v.spend_micros, teto)}% do teto. A previsão passa do teto.` : `Gasto até ontem: ${gasto}% do teto. Previsão de fechamento: ${previsto}% do teto.`,
    legendaPrevisto: `Previsto até o dia ${mesDaVerba(v).ultimoDia}`,
  };
}

/** A frase do dono: o mês cabe, está perto, passa do teto ou ainda não tem teto. */
export function fraseDaVerba(v: Verba): Frase {
  const mes = mesDaVerba(v);
  const teto = v.limits.month_micros;
  if (teto === null || v.remaining_micros === null) {
    return [b(`${maiuscula(mes.nome)} ainda não tem teto.`), { t: ` No ritmo dos últimos 7 dias, o mês fecha em ${reais(v.forecast_micros)}. Sem o teto do mês e o teto por campanha, o Liame só reduz verba e pausa.` }];
  }
  const total = reais(v.forecast_micros + v.pending_micros);
  const hoje = v.pending_micros > 0 ? `, já contando ${reais(v.pending_micros)} de aumentos pedidos ou feitos hoje` : '';
  const sobra = v.remaining_micros;
  if (sobra < 0) {
    return [b(`No ritmo atual, ${mes.nome} passa do teto em ${reais(-sobra)}.`), { t: ` O mês fecha em ${total}${hoje}, e o teto é de ${reais(teto)}. Aumentar e retomar ficam negados; o Liame não pausa nada sozinho.` }];
  }
  if (sobra < teto * 0.02) return [b(`${maiuscula(mes.nome)} está perto do teto:`), { t: ` sobram ${reais(sobra)}${hoje}. Aumento ou retomada que não couber fica negado.` }];
  return [b(`${maiuscula(mes.nome)} deve fechar dentro do teto.`), { t: ` No ritmo dos últimos 7 dias, o mês fecha em ${total} e sobram ${reais(sobra)}${hoje}.` }];
}

export type StatDaVerba = { rotulo: string; valor: Texto; sub: Texto; falta?: true };

export type HeroiDaVerba = {
  titulo: string;
  chip: string;
  numero: Num;
  sub: string;
  barra: BarraDaVerba | null;
  frase: Frase;
  stats: StatDaVerba[];
};

/** De onde vem o gasto do mês: as plataformas, o período e quando cada uma foi lida. */
export function fonteDoGasto(v: Verba, agora: Date): string {
  if (!v.platforms.length) return 'Liame · nenhuma conta de anúncio conectada';
  const alguemAtrasado = v.platforms.some((p) => p.stale);
  const nomes = juntar(v.platforms.map((p) => (alguemAtrasado && p.read_through ? `${plataforma(p.provider).nome} (até ${diaMes(p.read_through)})` : plataforma(p.provider).nome)));
  // "hoje, 06:12" → ["hoje", "06:12"]: com todas lidas no mesmo dia, o dia aparece uma vez só.
  const lidas = v.platforms.flatMap((p) => (p.last_success_at ? [quandoNoFuso(p.last_success_at, v.timezone, agora).split(', ')] : []));
  const dias = new Set(lidas.map((l) => l[0]));
  const lido = !lidas.length
    ? 'ainda sem leitura'
    : `lido ${dias.size === 1 ? `${lidas[0]![0]}, ${juntar(lidas.map((l) => l[1] ?? ''))}` : lidas.map((l) => l.join(', ')).join(', e ')}`;
  const periodo = alguemAtrasado || v.through < v.month_start ? 'gasto do mês' : `gasto de ${diaMes(v.month_start)} a ${diaMes(v.through)}`;
  return `${nomes} · ${periodo} · ${lido}`;
}

export function heroiDaVerba(v: Verba, fontes: Fontes, agora: Date): HeroiDaVerba {
  const mes = mesDaVerba(v);
  const teto = v.limits.month_micros;
  const fRitmo = `Liame · gasto de ${diaMes(somarDias(v.through, -6))} a ${diaMes(v.through)} ÷ 7 · calculado pelo sistema`;
  const fPrevisto = 'Liame · gasto até ontem + ritmo dos últimos 7 dias × dias que faltam · calculado pelo sistema';
  const numero = fontes.n(reais(v.spend_micros), fonteDoGasto(v, agora));
  const previsto = fontes.n(reais(v.forecast_micros), fPrevisto);
  const ritmo = fontes.n(reais(v.daily_micros), fRitmo);
  const sobra = v.remaining_micros;
  let sub: string;
  if (teto === null) sub = mes.comecaHoje ? `o mês começa hoje: o gasto de ${mes.nome} aparece a partir de amanhã` : `gastos em anúncios de ${diaMes(v.month_start)} a ${mes.ate}`;
  else sub = mes.comecaHoje ? `o mês começa hoje: a empresa pode gastar ${reais(teto)} em ${mes.nome}` : `gastos até ontem, de ${reais(teto)} que a empresa pode gastar em ${mes.nome}`;
  return {
    titulo: `${mes.nome} · gasto em anúncios`,
    chip: `${mes.faltam} · ${mes.virada}`,
    numero,
    sub,
    barra: barraDaVerba(v),
    frase: fraseDaVerba(v),
    stats: [
      {
        rotulo: 'Previsão de fechamento',
        valor: [{ num: previsto }],
        sub:
          v.forecast_days !== null
            ? [{ t: 'gasto até ontem + ' }, { num: ritmo }, { t: ` por dia × ${plural(v.forecast_days, 'dia', 'dias')}` }]
            : [{ t: 'o gasto lido de cada conta + ' }, { num: ritmo }, { t: ' por dia nos dias que a leitura não cobre' }],
      },
      {
        rotulo: 'Aumentos de hoje',
        valor: [{ t: v.pending_micros > 0 ? `+${reais(v.pending_micros)}` : reais(0) }],
        sub: [{ t: 'aumentos e retomadas pedidos ou feitos hoje, até o fim do mês' }],
      },
      teto === null || sobra === null
        ? { rotulo: 'Teto do mês', valor: [{ t: 'não definido' }], sub: [{ t: 'sem ele, o Liame só reduz e pausa' }], falta: true }
        : { rotulo: sobra < 0 ? 'Passa do teto' : 'Sobra', valor: [{ t: reais(Math.abs(sobra)) }], sub: [{ t: `teto de ${reais(teto)} por mês` }] },
    ],
  };
}

export type LinhaDaPlataforma = { provider: string; nome: string; classe: string; nota: string | null; gasto: string; ritmo: string; previsto: string };
export type PlataformasDaVerba = { legenda: string; linhas: LinhaDaPlataforma[]; total: { gasto: string; ritmo: string; previsto: string }; nota: string };

/** A tabela por plataforma (Pro, ou "Ver detalhes" no Lite), com o total. */
export function plataformasDaVerba(v: Verba): PlataformasDaVerba {
  return {
    legenda: `Gasto de ${mesDaVerba(v).nome} por plataforma: até ontem, ritmo por dia e previsão de fechamento`,
    linhas: v.platforms.map((p) => ({
      provider: p.provider,
      ...plataforma(p.provider),
      nota: p.provider === 'google_ads' ? 'só leitura: o Liame ainda não muda campanhas do Google' : null,
      gasto: reais(p.spend_micros),
      ritmo: reais(p.daily_micros),
      previsto: reais(p.forecast_micros),
    })),
    total: { gasto: reais(v.spend_micros), ritmo: reais(v.daily_micros), previsto: reais(v.forecast_micros) },
    nota: 'O teto conta tudo o que as contas conectadas gastam, e não só o que o Liame mudou. O ritmo é a média dos últimos 7 dias completos. A Meta e o Google são lidos uma vez por dia, de manhã: o gasto de hoje entra amanhã.',
  };
}

// ------------------------------------------------------------------ os limites da empresa

export type LimitesDaVerba = {
  definidos: boolean;
  mes: string | null;
  campanha: string | null;
  /** "Definidos por Rodrigo em 20/09." */
  quem: string | null;
  regras: string[];
  dicaDoMes: string;
  dicaDaCampanha: string;
};

export function limitesDaVerba(v: Verba, agora: Date): LimitesDaVerba {
  const { month_micros: mes, campaign_daily_micros: campanha, set_by: por, set_at: em } = v.limits;
  const dia = em ? dataNoFuso(new Date(em), v.timezone) : null;
  const quando = dia === null ? null : dia === dataNoFuso(agora, v.timezone) ? 'hoje' : `em ${diaMes(dia)}${dia.slice(0, 4) === v.today.slice(0, 4) ? '' : `/${dia.slice(0, 4)}`}`;
  const regras = ['Nada muda na Meta sem a aprovação de uma pessoa, com o código do app.'];
  if (v.rules.change_percent_max !== null) regras.push(`Cada pedido muda no máximo ${String(v.rules.change_percent_max).replace('.', ',')}% da verba diária.`);
  if (v.rules.rate_limit) {
    const { max, window_minutes: janela } = v.rules.rate_limit;
    regras.push(`No máximo ${plural(max, 'mudança', 'mudanças')} de verba ${janela === 60 ? 'por hora' : `a cada ${janela} minutos`} na mesma campanha ou conjunto.`);
  }
  regras.push('A Meta confere antes, e o Liame não passa por cima do que alguém mudou lá.', 'O Liame não apaga nada na Meta e não mexe no limite de gastos da conta.');
  return {
    definidos: mes !== null && campanha !== null,
    mes: mes === null ? null : reais(mes),
    campanha: campanha === null ? null : `${reais(campanha)} por dia`,
    quem: quando === null ? null : por ? `Definidos por ${por.name} ${quando}.` : `Definidos ${quando}.`,
    regras,
    dicaDoMes: `Quanto a empresa pode gastar em anúncios por mês, somando a Meta e o Google. Em ${mesDaVerba(v).nome}, a previsão é de ${reais(v.forecast_micros)}.`,
    dicaDaCampanha:
      'A maior verba diária que um aumento pode deixar numa campanha ou num conjunto.' + (v.largest_daily_micros !== null ? ` Hoje a maior é de ${reais(v.largest_daily_micros)} por dia.` : ''),
  };
}

/** "5500" ou "5500,50" (sem ponto de milhar) para o campo do formulário. */
export function reaisParaOCampo(micros: number | null): string {
  if (micros === null) return '';
  const centavos = Math.round(micros / 10_000);
  const resto = centavos % 100;
  return resto ? `${Math.floor(centavos / 100)},${String(resto).padStart(2, '0')}` : String(Math.floor(centavos / 100));
}

const soDigitos = (s: string): boolean => s.length > 0 && [...s].every((c) => c >= '0' && c <= '9');

/**
 * O valor em reais que a pessoa digitou, em micros: "5.500,00", "5500", "80,5", "R$ 80". O ponto sozinho é milhar
 * quando separa grupos de três ("5.500" são cinco mil e quinhentos) e centavos nos outros casos ("80.5"). Nulo quando
 * não dá para ler um valor.
 */
export function reaisDigitados(texto: string): number | null {
  let t = [...texto.trim()].filter((c) => c !== ' ' && c !== String.fromCharCode(160)).join('');
  if (t.toUpperCase().startsWith('R$')) t = t.slice(2);
  if (!t || t.length > 14) return null;
  let inteiro = t;
  let centavos = '';
  const partes = t.split(',');
  if (partes.length > 2) return null;
  if (partes.length === 2) {
    inteiro = partes[0]!;
    centavos = partes[1]!;
    if (centavos.length < 1 || centavos.length > 2) return null;
    const grupos = inteiro.split('.');
    if (grupos.length > 1 && (grupos[0]!.length > 3 || grupos.slice(1).some((g) => g.length !== 3))) return null;
    inteiro = grupos.join('');
  } else {
    const grupos = t.split('.');
    if (grupos.length > 1) {
      if (grupos[0]!.length <= 3 && grupos.slice(1).every((g) => g.length === 3)) inteiro = grupos.join('');
      else if (grupos.length === 2 && grupos[1]!.length >= 1 && grupos[1]!.length <= 2) {
        inteiro = grupos[0]!;
        centavos = grupos[1]!;
      } else return null;
    }
  }
  if (!soDigitos(inteiro) || inteiro.length > 9 || (centavos !== '' && !soDigitos(centavos))) return null;
  return Number(inteiro) * 1_000_000 + Number(centavos.padEnd(2, '0')) * 10_000;
}

export type CampoDosLimites = 'mes' | 'campanha';
export type LimitesConferidos = { ok: true; corpo: BudgetLimitsRequest } | { ok: false; erro: string; campo: CampoDosLimites };

/** Confere o formulário dos limites antes de enviar: os dois valores, em reais, e o da campanha (por dia) dentro do mês. */
export function conferirLimites(campos: { mes: string; campanha: string }): LimitesConferidos {
  const mes = reaisDigitados(campos.mes);
  if (mes === null || mes < 1_000_000) return { ok: false, erro: 'Digite o teto do mês em reais, como 5.500,00.', campo: 'mes' };
  const campanha = reaisDigitados(campos.campanha);
  if (campanha === null || campanha < 1_000_000) return { ok: false, erro: 'Digite o teto por campanha em reais, como 80,00.', campo: 'campanha' };
  if (campanha > mes) return { ok: false, erro: 'O teto por campanha é por dia e não pode passar do teto do mês.', campo: 'campanha' };
  return { ok: true, corpo: { month_micros: mes, campaign_daily_micros: campanha } };
}

/** A recusa do servidor ao salvar os limites, em palavras, e o campo a que ela se refere (quando há). */
export function erroAoSalvarLimites(p: Problema): { erro: string; campo: CampoDosLimites | null } {
  const doCampo = p.errors?.[0];
  if (doCampo) return { erro: doCampo.message, campo: doCampo.path.includes('month') ? 'mes' : doCampo.path.includes('campaign') ? 'campanha' : null };
  if (p.status === 403) return { erro: 'Só o Dono e o Administrador mudam os limites.', campo: null };
  const texto = p.detail ?? p.title;
  return { erro: p.status >= 500 && p.trace_id ? `${texto} Código de rastreio: ${p.trace_id}` : texto, campo: null };
}

// ------------------------------------------------------------------ o que o Liame mudou

export type SituacaoDaMudanca = 'ok' | 'mudou' | 'acima' | 'trocada' | 'espera' | 'outra';

export type LinhaDaMudanca = {
  id: string;
  quando: string;
  /** "Smash em dobro: verba de R$ 44,00 para R$ 40,00", "Conjunto “Noite · quem já pediu” pausado". */
  oque: string;
  /** "pedido de Rodrigo", "pedido do Gestor de tráfego", com a campanha do conjunto ou do anúncio. */
  dequem: string;
  /** O que a plataforma informa hoje. */
  informa: string;
  /** "R$ 39,97 por dia", "não gastou", "sai amanhã". */
  gasto: string;
  /** "média de 10 dias". */
  media: string | null;
  situacao: SituacaoDaMudanca;
  rotulo: string;
  icone: NomeIcone;
  nota: string | null;
};

const artigoDo = (tipo: string): string => (tipo === 'campanha' ? 'a' : 'o');
/** "pausado" → "pausada" quando o objeto é a campanha. */
const comGenero = (palavra: string, tipo: string): string => (palavra.endsWith('o') ? palavra.slice(0, -1) + artigoDo(tipo) : palavra);

/** O objeto numa linha: a campanha pelo nome; o conjunto e o anúncio com o tipo e o nome entre aspas. */
function alvoDaMudanca(m: BudgetMonthChange): string {
  if (m.target.kind === 'campanha') return m.target.name;
  return `${m.target.kind === 'anuncio' ? 'Anúncio' : 'Conjunto'} “${m.target.name}”`;
}

const mudouAVerba = (m: BudgetMonthChange): boolean => m.to.daily_micros !== null && m.from.daily_micros !== m.to.daily_micros;

/** Uma mudança numa linha: a verba de um valor para outro, ou o objeto pausado ou retomado. */
export function oQueMudou(m: BudgetMonthChange): string {
  const alvo = alvoDaMudanca(m);
  if (mudouAVerba(m)) return m.from.daily_micros === null ? `${alvo}: verba de ${reais(m.to.daily_micros!)}` : `${alvo}: verba de ${reais(m.from.daily_micros)} para ${reais(m.to.daily_micros!)}`;
  return `${alvo} ${comGenero(m.to.status === 'pausado' ? 'pausado' : 'retomado', m.target.kind)}`;
}

/** A situação que a plataforma informa, com o gênero do objeto: "pausada", "ativo", "fora da conta". */
function situacaoEscrita(status: string | null, tipo: string): string {
  if (status === null) return 'fora da conta';
  if (status === 'desconhecido') return 'não informado';
  return comGenero(status, tipo);
}

const DE_QUEM_IA: Record<string, string> = { trafego: 'do Gestor de tráfego' };

function notaDaMudanca(m: BudgetMonthChange, v: Pick<Verba, 'today' | 'timezone'>, situacao: SituacaoDaMudanca): string | null {
  const na = naFrase(m.provider).na;
  const o = artigoDo(m.target.kind);
  if (m.superseded_by) {
    const dia = dataNoFuso(new Date(m.superseded_by.executed_at), v.timezone);
    return `O Liame mudou de novo ${dia === v.today ? 'hoje' : `em ${diaMes(dia)}`}: vale o pedido mais recente.`;
  }
  const c = m.check;
  if (!c) return situacao === 'espera' ? 'A conferência roda depois da leitura da manhã.' : null;
  if (c.status === 'mudou') {
    return c.informed_status === null
      ? `Não está mais na lista da conta ${na} (o Liame viu em ${diaMes(c.since)}): foi arquivad${o} ou apagad${o} por lá.`
      : `Alguém mudou ${na} (o Liame viu em ${diaMes(c.since)}). Não é erro: quem mexe ${na} manda. O Liame só não desfaz mais este pedido.`;
  }
  if (c.status === 'acima') {
    const semana = somarDias(c.window.from, 6) === c.window.to;
    const periodo = semana ? `Na semana de ${diaMes(c.window.from)} a ${diaMes(c.window.to)}` : `De ${diaMes(c.window.from)} a ${diaMes(c.window.to)}`;
    if (m.to.status === 'pausado') return `${periodo} gastou ${reais(c.window_spend_micros)}, depois de pausad${o} pelo Liame.`;
    if (c.window_allowed_micros === null) return `${periodo} gastou ${reais(c.window_spend_micros)}.`;
    if (semana && m.to.daily_micros !== null && c.window_allowed_micros === m.to.daily_micros * 7) {
      return `${periodo} gastou ${reais(c.window_spend_micros)}; com ${reais(m.to.daily_micros)} por dia, a semana iria até ${reais(c.window_allowed_micros)}.`;
    }
    return `${periodo} gastou ${reais(c.window_spend_micros)}; com a verba de cada dia, iria até ${reais(c.window_allowed_micros)}.`;
  }
  return null;
}

const SITUACAO: Record<SituacaoDaMudanca, { rotulo: (na: string, status: string) => string; icone: NomeIcone }> = {
  ok: { rotulo: () => 'Confere', icone: 'check' },
  mudou: { rotulo: (na) => `Mudado ${na}`, icone: 'pencil' },
  acima: { rotulo: () => 'Gastou a mais', icone: 'alert' },
  trocada: { rotulo: () => 'Trocada por outro pedido', icone: 'history' },
  espera: { rotulo: () => 'Esperando a leitura', icone: 'clock' },
  // Um resultado que a tela ainda não conhece aparece como veio: não vira "confere" nem "gastou a mais".
  outra: { rotulo: (_na, status) => maiuscula(status.replaceAll('_', ' ')), icone: 'info' },
};

/** A situação de uma mudança: a de hoje confere (o Liame leu de novo ao escrever); a de antes espera a conferência do dia. */
function situacaoDa(m: BudgetMonthChange, hoje: string): SituacaoDaMudanca {
  if (m.superseded_by) return 'trocada';
  const c = m.check;
  if (!c) return m.executed_on >= hoje ? 'ok' : 'espera';
  if (c.status === 'mudou') return 'mudou';
  if (c.status === 'acima') return 'acima';
  return c.status === 'confere' ? 'ok' : 'outra';
}

export function linhaDaMudanca(m: BudgetMonthChange, v: Pick<Verba, 'today' | 'timezone'>): LinhaDaMudanca {
  const c = m.check;
  const situacao = situacaoDa(m, v.today);
  const pedido = m.undoes ? 'pedido de volta' : 'pedido';
  const quem = m.agent_key ? (DE_QUEM_IA[m.agent_key] ?? 'de um funcionário de IA') : `de ${m.requested_by.name}`;
  // A mudança que outro pedido trocou deixou de ser conferida: o que a plataforma informa e o gasto já são do pedido novo.
  const valendo = situacao !== 'trocada';
  // O que a plataforma informa: sem conferência ainda, vale o que o Liame deixou (ele leu de novo ao escrever).
  const verba = mudouAVerba(m);
  let informa: string;
  if (!valendo) informa = '—';
  else if (!c) informa = verba ? reais(m.to.daily_micros!) : situacaoEscrita(m.to.status, m.target.kind);
  else if (c.informed_status === null) informa = 'fora da conta';
  else if (verba) informa = c.informed_daily_micros !== null ? reais(c.informed_daily_micros) : 'sem verba própria';
  else informa = situacaoEscrita(c.informed_status, m.target.kind);
  // O gasto depois da mudança: a média dos dias inteiros depois dela. O primeiro dia inteiro só é lido no dia seguinte.
  const dias = valendo && c ? c.days_after : 0;
  const gastou = c?.spend_after_micros ?? 0;
  let gasto: string;
  if (!valendo || situacao === 'espera') gasto = '—';
  else if (dias === 0) gasto = 'sai amanhã';
  else gasto = gastou === 0 ? 'não gastou' : `${reais(Math.round(gastou / dias / 10_000) * 10_000)} por dia`;
  return {
    id: m.action_id,
    quando: m.executed_on === v.today ? 'hoje' : `${diaMes(m.executed_on)}${m.executed_on.slice(0, 4) === v.today.slice(0, 4) ? '' : `/${m.executed_on.slice(0, 4)}`}`,
    oque: oQueMudou(m),
    dequem: `${pedido} ${quem}${m.target.campaign_name ? ` · campanha ${m.target.campaign_name}` : ''}`,
    informa,
    gasto,
    media: dias > 0 ? `média de ${plural(dias, 'dia', 'dias')}` : null,
    situacao,
    rotulo: SITUACAO[situacao].rotulo(naFrase(m.provider).na, c?.status ?? ''),
    icone: SITUACAO[situacao].icone,
    nota: notaDaMudanca(m, v, situacao),
  };
}

export type MudancasDaVerba = {
  titulo: string;
  sub: string;
  legenda: string;
  /** O título da coluna do que a plataforma informa: "A Meta informa hoje". */
  colunaInforma: string;
  linhas: LinhaDaMudanca[];
  /** A lista traz mudança de antes do mês que continua valendo e sendo conferida. */
  deAntes: string | null;
  nota: string;
  vazio: { titulo: string; texto: string };
};

export function mudancasDaVerba(v: Verba): MudancasDaVerba {
  const mes = mesDaVerba(v).nome;
  // Hoje o Liame só muda campanhas da Meta; com outra plataforma na lista, a frase fala "a plataforma".
  const provedores = [...new Set(v.changes.map((m) => m.provider))];
  const quem = provedores.length <= 1 ? naFrase(provedores[0] ?? 'meta_ads').a : 'a plataforma';
  return {
    titulo: `O que o Liame mudou em ${mes}`,
    sub: `Cada mudança, conferida todo dia com o que ${quem} informa e com o que ela gastou.`,
    legenda: `Mudanças feitas pelo Liame em ${mes}: o que mudou, o que ${quem} informa hoje, o gasto por dia depois e a situação`,
    colunaInforma: `${maiuscula(quem)} informa hoje`,
    linhas: v.changes.map((m) => linhaDaMudanca(m, v)),
    deAntes: v.changes.some((m) => m.executed_on < v.month_start) ? `A lista traz também as mudanças de antes de ${mes} que continuam valendo: o Liame confere cada uma por 35 dias.` : null,
    nota: `A verba diária é uma média: ${quem} pode gastar mais num dia e menos em outros. Por isso o Liame confere a semana inteira, contra 7 vezes a verba diária, e avisa quando ela passa.`,
    vazio: {
      titulo: `O Liame não mudou nada em ${mes}`,
      texto: 'Quando um pedido de mudança de verba, de pausa ou de retomada for aprovado e executado, ele aparece aqui, conferido todo dia.',
    },
  };
}

// ------------------------------------------------------------------ a tela inteira

export type TelaDaVerba = {
  mes: MesDaVerba;
  lido: string | null;
  avisos: AvisoDaVerba[];
  heroi: HeroiDaVerba;
  plataformas: PlataformasDaVerba;
  limites: LimitesDaVerba;
  mudancas: MudancasDaVerba;
  fontes: LinhaDeFonte[];
  /** Nenhuma conta de anúncio conectada: a tela explica e leva a Contas conectadas. */
  semContas: boolean;
};

export function telaDaVerba(v: Verba, agora: Date): TelaDaVerba {
  const fontes = new Fontes();
  const heroi = heroiDaVerba(v, fontes, agora);
  const semContas = v.platforms.length === 0;
  return {
    mes: mesDaVerba(v),
    lido: lidoDaVerba(v, agora),
    avisos: avisosDaVerba(v, agora),
    heroi,
    plataformas: plataformasDaVerba(v),
    limites: limitesDaVerba(v, agora),
    mudancas: mudancasDaVerba(v),
    // Sem conta conectada, o cartão do mês não aparece: não há número na tela para dizer de onde veio.
    fontes: semContas ? [] : fontes.lista,
    semContas,
  };
}

// ------------------------------------------------------------------ o cartão do Resumo

export type VerbaNoResumo = {
  titulo: string;
  sub: string;
  barra: BarraDaVerba | null;
  frase: Frase;
  /** Sem o teto, o botão leva a definir os limites (para quem pode); com ele, à tela Verba do mês. */
  semTeto: boolean;
};

/**
 * O cartão da verba no Resumo (a página inicial do Lite): a mesma conta, numa frase, com a barra do teto. A verba é
 * da empresa: com mais de uma marca, o cartão diz que soma todas (o Resumo é de uma marca só).
 */
export function verbaNoResumo(v: Verba, variasMarcas = false): VerbaNoResumo {
  const mes = mesDaVerba(v);
  const teto = v.limits.month_micros;
  const todas = variasMarcas ? ' Soma as contas de anúncio de todas as marcas da empresa.' : '';
  if (teto === null) {
    return {
      titulo: `Verba de ${mes.nome}`,
      sub: `O teto que você define. O Liame não aprova nada que passe dele.${todas}`,
      barra: null,
      frase: [
        b('Você ainda não definiu o teto do mês.'),
        { t: ` Até ontem foram ${reais(v.spend_micros)} em anúncios; no ritmo atual, ${mes.nome} fecha em ${reais(v.forecast_micros)}. Sem o teto, o Liame só reduz verba e pausa.` },
      ],
      semTeto: true,
    };
  }
  return { titulo: `Verba de ${mes.nome}`, sub: `Até ontem, ${reais(v.spend_micros)} de ${reais(teto)}.${todas}`, barra: barraDaVerba(v), frase: fraseDaVerba(v), semTeto: false };
}
