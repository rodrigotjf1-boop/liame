import type { BudgetMonthResponse } from '@liame/contracts';
import { plataforma } from '@/components/contas/textos';
import { diaMes, somarDias } from '@/components/resultados/textos';
import { reaisDeMicros } from '@/lib/formato';
import { naFrase } from './nomes';
import type { MesDaVerba } from './textos';

// Os desenhos da Verba do mês (mockups/prototipo-verba-graficos.html, aprovado pelo dono em 07/10/2026; caminho B, "uma
// pergunta, um desenho", já no ar em Resultados, no Resumo e na Revisão da semana). Muda só o cartão do mês: a barra do
// teto vira "O mês, dia a dia" (o gasto somado de cada dia, a previsão até o fim do mês e o teto, na mesma régua em
// reais, que começa no zero); a frase vira um selo com uma linha; e "Onde o gasto foi" mostra uma barra por
// plataforma. A conta é do servidor (`GET /v1/budget/month`): aqui só se escolhe o que desenhar e em que tamanho, e
// todo valor continua escrito ao lado do desenho. Funções puras.

type Verba = BudgetMonthResponse;

const REAL = 1_000_000;
const reais = (micros: number): string => reaisDeMicros(BigInt(Math.round(micros)));
/** A dica do desenho ("título|complemento"): reforça o valor, que também fica escrito na tela. */
const dica = (titulo: string, sub = ''): string => (sub ? `${titulo}|${sub}` : titulo);
const juntar = (itens: string[]): string => (itens.length <= 1 ? itens.join('') : `${itens.slice(0, -1).join(', ')} e ${itens.at(-1)}`);
/** Duas casas: as posições do desenho vão de 0 a 100. */
const p2 = (v: number): number => Math.round(v * 100) / 100;
const semana = new Intl.DateTimeFormat('pt-BR', { weekday: 'long', timeZone: 'UTC' });
const diaDaSemana = (dia: string): string => semana.format(new Date(`${dia}T00:00:00Z`));
const faltaLer = (provedores: string[]): string | null => (provedores.length ? `falta ler ${juntar(provedores.map((p) => naFrase(p).a))}` : null);

// ------------------------------------------------------------------ o selo do mês

export type VereditoDaVerba = {
  /** A classe do selo (`st--…`): verde quando cabe, âmbar perto do teto, vermelho quando passa, neutro sem teto. */
  classe: 'concluido' | 'aguardando' | 'perigo' | 'espera';
  rotulo: string;
  /** O que o selo quer dizer para quem pede mudança. Os números ficam no desenho e nos três quadros. */
  linha: string;
};

/** O mês cabe no teto, está perto, passa, já passou ou ainda não tem teto: a palavra e o que ela muda nos pedidos. */
export function vereditoDaVerba(v: Verba, mes: MesDaVerba): VereditoDaVerba {
  const teto = v.limits.month_micros;
  const sobra = v.remaining_micros;
  if (teto === null || sobra === null) return { classe: 'espera', rotulo: 'Sem teto', linha: 'Sem o teto do mês e o teto por campanha, o Liame só reduz verba e pausa.' };
  if (v.spend_micros > teto) return { classe: 'perigo', rotulo: 'Já passou do teto', linha: 'Aumentar e retomar ficam negados; o Liame não pausa nada sozinho.' };
  if (sobra < 0) return { classe: 'perigo', rotulo: 'Passa do teto', linha: 'Aumentar e retomar ficam negados; o Liame não pausa nada sozinho.' };
  if (sobra < teto * 0.02) return { classe: 'aguardando', rotulo: 'Perto do teto', linha: 'Aumento ou retomada que não couber fica negado.' };
  return { classe: 'concluido', rotulo: 'Cabe no teto', linha: `No ritmo dos últimos 7 dias, ${mes.nome} fecha abaixo do teto.` };
}

// ------------------------------------------------------------------ o mês, dia a dia

/** "R$ 2 mil", "R$ 5,5 mil", "R$ 1,2 mi", "R$ 500": o rótulo curto da régua (o valor inteiro está escrito na tela). */
export function reaisCurtos(micros: number): string {
  const v = micros / REAL;
  if (v >= 1_000_000) return `R$ ${(v / 1_000_000).toLocaleString('pt-BR', { maximumFractionDigits: 2 })} mi`;
  if (v >= 1000) return `R$ ${(v / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 2 })} mil`;
  const casas = Number.isInteger(v) ? 0 : 2;
  return `R$ ${v.toLocaleString('pt-BR', { minimumFractionDigits: casas, maximumFractionDigits: casas })}`;
}

/**
 * O passo da grade, em micros: o menor número "redondo" (1, 2, 2,5 ou 5 vezes uma potência de dez, em reais) que
 * deixa no máximo quatro linhas acima do zero. Nunca menos que R$ 1,00.
 */
export function passoDaGrade(topo: number): number {
  const minimo = topo / REAL / 4.2;
  if (!(minimo > 1)) return REAL;
  const base = 10 ** Math.floor(Math.log10(minimo));
  const fator = [1, 2, 2.5, 5].find((f) => f * base >= minimo) ?? 10;
  return fator * base * REAL;
}

export type AlvoDoDia = { x: number; largura: number; dica: string };

export type MesDesenhado = {
  /** O que quem ouve a tela escuta no lugar do desenho. */
  rotulo: string;
  /** `lido`: "Gasto até ontem", ou até o dia em que a leitura parou; nulo sem dia lido (não há linha cheia). */
  legenda: { lido: string | null; previsto: string; teto: string | null; acima: boolean };
  /** A largura da calha da régua, em px: a do rótulo mais comprido (letra de largura fixa) mais o respiro. */
  calha: number;
  /** A altura do teto no desenho (de 0, no alto, a 100); nulo sem teto. */
  teto: { y: number; dica: string } | null;
  grade: number[];
  eixo: Array<{ y: number; texto: string; doTeto: boolean }>;
  /** A linha do gasto somado, do zero ao último dia lido (`d` de um `path`); vazia sem dia lido. */
  fio: string;
  /** A linha da previsão, do último dia lido ao último dia do mês. */
  previsao: string;
  /** Os recortes das duas áreas (`clip-path`); o da área cheia é nulo sem dia lido. */
  areaLida: string | null;
  areaPrevista: string;
  /** Um alvo por dia do mês: o lido diz o gasto dele e o acumulado; o que falta, até onde o mês vai. */
  alvos: AlvoDoDia[];
  pontoLido: { x: number; y: number; acima: boolean; dica: string } | null;
  pontoPrevisto: { y: number; acima: boolean; dica: string };
  marcas: Array<{ x: number; texto: string }>;
};

/**
 * "O mês, dia a dia": o gasto somado de cada dia (cheio), a previsão até o fim do mês (tracejado e hachura) e o teto
 * (o traço escuro), numa régua só. Nulo quando a resposta não traz o gasto de cada dia (a tela fica com a barra do
 * teto). Sem dia inteiro lido (dia 1), o desenho é só a previsão.
 */
export function mesDesenhado(v: Verba, mes: MesDaVerba): MesDesenhado | null {
  if (!v.days) return null;
  const fim = mes.ultimoDia;
  const dias = v.days.slice(0, fim);
  const n = dias.length;
  const teto = v.limits.month_micros;
  const gasto = v.spend_micros;
  const total = v.forecast_micros + v.pending_micros;
  const topo = Math.max(teto ?? 0, total, gasto) * 1.1 || REAL;
  const x = (d: number): number => p2((d / fim) * 100);
  const y = (micros: number): number => p2(100 - (micros / topo) * 100);
  const yT = teto === null ? null : y(teto);

  let soma = 0;
  const lidos = dias.map((d, i) => {
    soma += d.spend_micros;
    return { ...d, soma, x: x(i + 1), y: y(soma) };
  });
  const [xN, yN, yF] = [x(n), y(gasto), y(total)];
  const pontos: Array<[number, number]> = [[0, 100], ...lidos.map((d): [number, number] => [d.x, d.y])];
  const recorte = (pts: Array<[number, number]>): string => `polygon(${pts.map(([px, py]) => `${px}% ${py}%`).join(',')})`;

  // A grade e os rótulos da régua; o rótulo que ficaria em cima do teto dá lugar ao do teto.
  const passo = passoDaGrade(topo);
  const linhas: number[] = [];
  for (let m = passo; m < topo * 0.96; m += passo) linhas.push(m);
  const perto = (m: number): boolean => yT !== null && Math.abs(y(m) - yT) < 12;
  const eixo = [
    { y: 100, texto: 'R$ 0', doTeto: false },
    ...linhas.filter((m) => !perto(m)).map((m) => ({ y: y(m), texto: reaisCurtos(m), doTeto: false })),
    ...(teto === null || yT === null ? [] : [{ y: yT, texto: reaisCurtos(teto), doTeto: true }]),
  ];

  // A previsão anda igual todo dia quando todas as contas foram lidas até ontem: aí o valor de cada dia é exato.
  const restam = fim - n || 1;
  const exata = v.forecast_days === v.days_left && restam === v.days_left;
  const porDia = v.daily_micros + v.pending_daily_micros;
  const ultimoLido = n ? somarDias(v.month_start, n - 1) : null;
  const alvos: AlvoDoDia[] = Array.from({ length: fim }, (_, i) => {
    const dia = somarDias(v.month_start, i);
    const lido = lidos[i];
    let texto: string;
    if (lido) {
      const falta = faltaLer(lido.missing);
      texto = dica(`${reais(lido.spend_micros)} em ${diaMes(dia)}`, `${diaDaSemana(dia)}${falta ? ` · ${falta}` : ''} · ${reais(lido.soma)} no mês até aqui`);
    } else {
      const k = i + 1 - n;
      const ate = i + 1 === fim ? total : exata ? gasto + porDia * k : gasto + ((total - gasto) * k) / restam;
      const cerca = exata || i + 1 === fim ? '' : 'cerca de ';
      texto = dica(`${cerca}${reais(ate)} até ${diaMes(dia)}`, exata ? `previsto, se o ritmo de ${reais(porDia)} por dia continuar` : 'previsto pelo ritmo dos últimos 7 dias');
    }
    return { x: x(i), largura: p2(100 / fim), dica: texto };
  });

  const acimaLido = teto !== null && gasto > teto;
  const acimaPrev = teto !== null && total > teto;
  const maior = lidos.reduce<(typeof lidos)[number] | null>((a, d) => (a === null || d.spend_micros > a.spend_micros ? d : a), null);
  const mm = v.month_start.slice(5, 7);
  const rotulo = [
    `Gasto de ${mes.nome}, dia a dia, em reais.`,
    ultimoLido ? `Até ${diaMes(ultimoLido)}, ${reais(gasto)}.` : 'Ainda não há dia inteiro lido neste mês.',
    `Previsto até o dia ${fim}: ${reais(total)}.`,
    teto === null ? 'O mês ainda não tem teto.' : `Teto do mês: ${reais(teto)}.`,
    ...(maior && maior.spend_micros > 0 ? [`O dia de maior gasto foi ${diaMes(maior.day)}, com ${reais(maior.spend_micros)}.`] : []),
  ].join(' ');

  return {
    rotulo,
    legenda: {
      lido: ultimoLido === null ? null : ultimoLido === v.through ? 'Gasto até ontem' : `Gasto até ${diaMes(ultimoLido)}`,
      previsto: `Previsto até o dia ${fim}`,
      teto: teto === null ? null : reais(teto),
      acima: acimaLido || acimaPrev,
    },
    calha: Math.max(...eixo.map((e) => e.texto.length)) * 6 + 12,
    teto: teto === null || yT === null ? null : { y: yT, dica: dica(reais(teto), 'teto do mês') },
    grade: linhas.map(y),
    eixo,
    fio: n ? `M${pontos.map(([px, py]) => `${px} ${py}`).join('L')}` : '',
    previsao: `M${xN} ${yN}L100 ${yF}`,
    areaLida: n ? recorte([...pontos, [xN, 100]]) : null,
    areaPrevista: recorte([
      [xN, yN],
      [100, yF],
      [100, 100],
      [xN, 100],
    ]),
    alvos,
    pontoLido: ultimoLido ? { x: xN, y: yN, acima: acimaLido, dica: dica(reais(gasto), `gastos até ${diaMes(ultimoLido)}`) } : null,
    pontoPrevisto: { y: yF, acima: acimaPrev, dica: dica(reais(total), `previsto até ${diaMes(v.month_end)}`) },
    marcas: [{ x: 0, texto: `01/${mm}` }, ...[10, 20].filter((d) => d < fim - 4).map((d) => ({ x: x(d - 0.5), texto: String(d) })), { x: 100, texto: `${fim}/${mm}` }],
  };
}

export type DiaLido = { dia: string; semana: string; falta: string | null; gasto: string; soma: string };
export type DiasLidos = { legenda: string; linhas: DiaLido[] };

/** A tabela do desenho: o gasto de cada dia lido e o que o mês somava até ali. Nula sem dia para mostrar. */
export function diasLidos(v: Verba, mes: MesDaVerba): DiasLidos | null {
  if (!v.days?.length) return null;
  let soma = 0;
  return {
    legenda: `Gasto em anúncios em cada dia de ${mes.nome} e o que o mês somava até ali`,
    linhas: v.days.map((d) => {
      soma += d.spend_micros;
      return { dia: diaMes(d.day), semana: diaDaSemana(d.day), falta: faltaLer(d.missing), gasto: reais(d.spend_micros), soma: reais(soma) };
    }),
  };
}

// ------------------------------------------------------------------ onde o gasto foi

export type PlataformaDesenhada = {
  provider: string;
  nome: string;
  classe: string;
  /** A largura da barra cheia (o gasto lido), de 0 a 100 na régua comum a todas as plataformas. */
  gasto: number;
  /** A largura da hachura: o que a previsão soma ao gasto. */
  aMais: number;
  valor: string;
  /** "68% do gasto"; nulo enquanto o mês não tem gasto. */
  parte: string | null;
  rotulo: string;
  dicaGasto: string;
  dicaPrevisto: string;
};

/** Uma barra por plataforma, na mesma régua (que começa no zero): cheio até o último dia lido, hachura a previsão. */
export function ondeOGastoFoi(v: Verba, mes: MesDaVerba): PlataformaDesenhada[] {
  const maior = Math.max(0, ...v.platforms.map((p) => Math.max(p.forecast_micros, p.spend_micros)));
  return v.platforms.map((p) => {
    const { nome, classe } = plataforma(p.provider);
    const parte = v.spend_micros > 0 ? `${Math.round((p.spend_micros / v.spend_micros) * 100)}% do gasto` : null;
    const ate = p.read_through ? `até ${diaMes(p.read_through)}` : 'ainda sem leitura';
    return {
      provider: p.provider,
      nome,
      classe,
      gasto: maior ? p2((p.spend_micros / maior) * 100) : 0,
      aMais: maior ? p2((Math.max(0, p.forecast_micros - p.spend_micros) / maior) * 100) : 0,
      valor: reais(p.spend_micros),
      parte,
      rotulo: `${nome}: ${reais(p.spend_micros)} ${ate}${parte ? `, ${parte} do mês` : ''}. Previsão de fechamento: ${reais(p.forecast_micros)}.`,
      dicaGasto: dica(reais(p.spend_micros), `${nome} · gasto ${ate}`),
      dicaPrevisto: dica(reais(p.forecast_micros), `${nome} · previsto até o dia ${mes.ultimoDia}`),
    };
  });
}

// ------------------------------------------------------------------ tudo junto

export type DesenhosDaVerba = {
  veredito: VereditoDaVerba;
  /** Nulo quando a resposta não traz o gasto de cada dia: a tela fica com a barra do teto. */
  mes: MesDesenhado | null;
  dias: DiasLidos | null;
  onde: PlataformaDesenhada[];
};

export function desenhosDaVerba(v: Verba, mes: MesDaVerba): DesenhosDaVerba {
  return { veredito: vereditoDaVerba(v, mes), mes: mesDesenhado(v, mes), dias: diasLidos(v, mes), onde: ondeOGastoFoi(v, mes) };
}
