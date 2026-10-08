import { menosDias } from '../results/fora-do-normal.js';

// A verba do mês (A4, X4; `plano-a4.md` D-A4-19). O teto do mês que a empresa define é o teto de TUDO o que as contas
// de anúncio conectadas gastam no mês (Meta e Google), e não a soma do que o Liame reservou. O pedido que faz o gasto
// subir só passa se couber:
//
//   gasto lido no mês + ritmo dos 7 dias mais recentes × dias que a leitura ainda não cobre
//   + aumentos e retomadas pedidos ou feitos hoje (o ritmo ainda não os mostra) × dias que faltam
//   + o que o pedido acrescenta por dia × dias que faltam  ≤  teto do mês
//
// Reduzir e pausar passam sempre. Com o mês acima do teto, o Liame nega aumento e retomada e não pausa nada sozinho.
// Aqui fica só a conta, em funções puras: quem lê o banco é o `BudgetService`. Dinheiro em micros, com BigInt; o gasto
// e o ritmo de cada conta são arredondados ao centavo, para as parcelas somarem o total que a tela mostra.

const DIA_MS = 86_400_000;
const CENTAVO = 10_000n;

/** As plataformas cujo gasto entra na conta do mês: as que o Liame lê por dia. */
export const PLATAFORMAS_DE_ANUNCIO: readonly string[] = ['meta_ads', 'google_ads'];

/** Dias de `de` até `ate` (AAAA-MM-DD); negativo quando `ate` vem antes. */
export const diasEntre = (de: string, ate: string): number => Math.round((Date.parse(`${ate}T00:00:00Z`) - Date.parse(`${de}T00:00:00Z`)) / DIA_MS);

/** Ao centavo mais próximo, metade para cima (valores que não são negativos). */
export const aoCentavo = (micros: bigint): bigint => ((micros + CENTAVO / 2n) / CENTAVO) * CENTAVO;

export interface MesCorrente {
  /** `2026-10`. */
  periodo: string;
  inicio: string;
  fim: string;
  hoje: string;
  ontem: string;
  /** De hoje ao fim do mês, contando hoje: os dias em que um aumento de agora ainda pesa. */
  diasQueFaltam: number;
}

/** O mês de um dia (AAAA-MM-DD, já no fuso da empresa). */
export function mesDe(hoje: string): MesCorrente {
  const [ano, mes] = [Number(hoje.slice(0, 4)), Number(hoje.slice(5, 7))];
  // O dia zero do mês seguinte é o último deste.
  const fim = new Date(Date.UTC(ano, mes, 0)).toISOString().slice(0, 10);
  return { periodo: hoje.slice(0, 7), inicio: `${hoje.slice(0, 7)}-01`, fim, hoje, ontem: menosDias(hoje, 1), diasQueFaltam: diasEntre(hoje, fim) + 1 };
}

/** "outubro", a partir do período (`2026-10`). */
export const nomeDoMes = (periodo: string): string => new Intl.DateTimeFormat('pt-BR', { month: 'long', timeZone: 'UTC' }).format(new Date(`${periodo}-01T00:00:00Z`));

export interface ContaDeAnuncio {
  id: string;
  provider: string;
  /**
   * O último dia inteiro que a leitura da conta cobre: a véspera do dia da última leitura boa (hoje só tem dado
   * amanhã). Nulo se a conta nunca foi lida.
   */
  lidoAte: string | null;
  /** A última leitura boa das métricas. */
  lidoEm: Date | null;
  /** O gasto de cada dia, em micros. */
  gastoPorDia: ReadonlyMap<string, bigint>;
}

export interface LinhaDeGasto {
  /** Do primeiro dia do mês até o último dia lido. */
  gasto: bigint;
  /** A média dos 7 dias inteiros que terminam no último dia lido. */
  ritmo: bigint;
  /** O gasto mais o ritmo vezes os dias previstos. */
  previsto: bigint;
}

export interface LinhaDaConta extends LinhaDeGasto {
  id: string;
  provider: string;
  lidoAte: string | null;
  lidoEm: Date | null;
  /** Os dias que entram pelo ritmo: do dia seguinte ao último lido até o fim do mês. */
  diasPrevistos: number;
  /** A leitura de hoje ainda não chegou (ou a conta nunca foi lida): o gasto vale até `lidoAte`. */
  atrasada: boolean;
}

/** A conta de uma conta de anúncio no mês. Só vale o que a leitura cobre, e nunca além de ontem. */
export function linhaDaConta(c: ContaDeAnuncio, mes: MesCorrente): LinhaDaConta {
  const ate = c.lidoAte === null ? null : c.lidoAte < mes.ontem ? c.lidoAte : mes.ontem;
  let gasto = 0n;
  let seteDias = 0n;
  if (ate !== null) {
    const antesDosSete = menosDias(ate, 7);
    for (const [dia, valor] of c.gastoPorDia) {
      if (dia > ate) continue;
      if (dia >= mes.inicio) gasto += valor;
      if (dia > antesDosSete) seteDias += valor;
    }
  }
  const ritmo = aoCentavo(seteDias / 7n);
  // O que a leitura não cobre entra pelo ritmo. Com a conta parada desde antes do mês, o mês inteiro é previsão.
  const vespera = menosDias(mes.inicio, 1);
  const diasPrevistos = diasEntre(ate === null || ate < vespera ? vespera : ate, mes.fim);
  const lido = aoCentavo(gasto);
  return {
    id: c.id,
    provider: c.provider,
    lidoAte: ate,
    lidoEm: c.lidoEm,
    gasto: lido,
    ritmo,
    previsto: lido + ritmo * BigInt(diasPrevistos),
    diasPrevistos,
    atrasada: ate === null || ate < mes.ontem,
  };
}

export interface LinhaDaPlataforma extends LinhaDeGasto {
  provider: string;
  contas: number;
  /** O mais antigo entre as contas; nulo se alguma nunca foi lida. */
  lidoAte: string | null;
  lidoEm: Date | null;
  /** Nulo quando as contas foram lidas até dias diferentes. */
  diasPrevistos: number | null;
  atrasada: boolean;
}

/** O mesmo número em todas, ou nulo. */
const emComum = (valores: number[]): number | null => (valores.length > 0 && valores.every((v) => v === valores[0]) ? valores[0]! : null);

function linhaDaPlataforma(provider: string, contas: LinhaDaConta[]): LinhaDaPlataforma {
  const nuncaLida = contas.some((c) => c.lidoAte === null || c.lidoEm === null);
  return {
    provider,
    contas: contas.length,
    gasto: contas.reduce((s, c) => s + c.gasto, 0n),
    ritmo: contas.reduce((s, c) => s + c.ritmo, 0n),
    previsto: contas.reduce((s, c) => s + c.previsto, 0n),
    lidoAte: nuncaLida ? null : contas.map((c) => c.lidoAte!).sort()[0]!,
    lidoEm: nuncaLida ? null : contas.map((c) => c.lidoEm!).sort((a, b) => a.getTime() - b.getTime())[0]!,
    diasPrevistos: emComum(contas.map((c) => c.diasPrevistos)),
    atrasada: contas.some((c) => c.atrasada),
  };
}

export interface DiaDeGasto {
  dia: string;
  /** O gasto do dia nas contas que a leitura cobre naquele dia, ao centavo. */
  gasto: bigint;
  /** As plataformas com alguma conta que a leitura não cobre neste dia: o gasto delas entra na previsão, pelo ritmo. */
  faltam: string[];
}

/** Na ordem das plataformas conhecidas; uma que não está na lista vai depois, pelo nome. */
const naOrdem = (a: string, b: string): number => {
  const [ia, ib] = [PLATAFORMAS_DE_ANUNCIO.indexOf(a), PLATAFORMAS_DE_ANUNCIO.indexOf(b)];
  return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
};

/**
 * O gasto de cada dia do mês, do primeiro dia ao último que alguma conta cobre (o desenho "o mês, dia a dia"). Cada
 * conta entra até o último dia lido dela, como na conta do mês. O que vai ao centavo é o acumulado de cada conta, e
 * não cada dia: o gasto do dia é a diferença entre dois acumulados, e a soma dos dias é o gasto do mês que a tela
 * mostra. Sem dia inteiro lido neste mês (dia 1, ou nenhuma conta lida), a lista vem vazia.
 */
export function gastoDeCadaDia(contas: readonly ContaDeAnuncio[], mes: MesCorrente): DiaDeGasto[] {
  const linhas = contas.map((c) => ({ c, ate: c.lidoAte === null ? null : c.lidoAte < mes.ontem ? c.lidoAte : mes.ontem, somado: 0n }));
  const ultimo = linhas
    .flatMap((l) => (l.ate !== null && l.ate >= mes.inicio ? [l.ate] : []))
    .sort()
    .at(-1);
  if (!ultimo) return [];
  const dias: DiaDeGasto[] = [];
  let antes = 0n;
  for (let dia = mes.inicio; dia <= ultimo; dia = menosDias(dia, -1)) {
    const faltam = new Set<string>();
    let acumulado = 0n;
    for (const l of linhas) {
      if (l.ate !== null && dia <= l.ate) l.somado += l.c.gastoPorDia.get(dia) ?? 0n;
      else faltam.add(l.c.provider);
      acumulado += aoCentavo(l.somado);
    }
    dias.push({ dia, gasto: acumulado - antes, faltam: [...faltam].sort(naOrdem) });
    antes = acumulado;
  }
  return dias;
}

export interface ContaDoMes extends LinhaDeGasto {
  mes: MesCorrente;
  plataformas: LinhaDaPlataforma[];
  /** O gasto de cada dia do mês, até o último dia que alguma conta cobre; a soma é `gasto`. */
  dias: DiaDeGasto[];
  /** Os dias previstos pelo ritmo, quando são os mesmos em todas as contas. */
  diasPrevistos: number | null;
  /** Aumentos e retomadas pedidos ou feitos hoje: quanto somam por dia, e até o fim do mês. */
  pesamPorDia: bigint;
  pesam: bigint;
  teto: bigint | null;
  /** Teto − previsão − o que pesa hoje. Negativo quando o mês passa do teto; nulo sem teto. */
  sobra: bigint | null;
}

/**
 * A conta do mês. `pesamPorDia`: a soma do que cada aumento ou retomada pedido (esperando aprovação ou execução) ou
 * executado hoje acrescenta por dia. O que foi executado antes de hoje já aparece, em parte, no ritmo.
 */
export function contaDoMes(e: { hoje: string; contas: readonly ContaDeAnuncio[]; pesamPorDia: bigint; teto: bigint | null }): ContaDoMes {
  const mes = mesDe(e.hoje);
  const linhas = e.contas.map((c) => linhaDaConta(c, mes));
  const provedores = [...new Set(linhas.map((l) => l.provider))].sort(naOrdem);
  const plataformas = provedores.map((p) => linhaDaPlataforma(p, linhas.filter((l) => l.provider === p)));
  const previsto = plataformas.reduce((s, p) => s + p.previsto, 0n);
  const pesam = e.pesamPorDia * BigInt(mes.diasQueFaltam);
  return {
    mes,
    plataformas,
    dias: gastoDeCadaDia(e.contas, mes),
    gasto: plataformas.reduce((s, p) => s + p.gasto, 0n),
    ritmo: plataformas.reduce((s, p) => s + p.ritmo, 0n),
    previsto,
    diasPrevistos: emComum(linhas.map((l) => l.diasPrevistos)),
    pesamPorDia: e.pesamPorDia,
    pesam,
    teto: e.teto,
    sobra: e.teto === null ? null : e.teto - previsto - pesam,
  };
}

export interface CabeNoMes {
  cabe: boolean;
  /** O que o pedido acrescenta até o fim do mês. */
  acrescenta: bigint;
}

/** O pedido que faz o gasto subir cabe no que sobra do mês? Sem teto, quem decide é a regra dos limites da empresa. */
export function cabeNoMes(c: ContaDoMes, porDiaMicros: bigint): CabeNoMes {
  const acrescenta = porDiaMicros * BigInt(c.mes.diasQueFaltam);
  return { cabe: c.sobra === null || acrescenta <= c.sobra, acrescenta };
}

/**
 * Por que o pedido não cabe, com os números que decidem: o que ele acrescenta, o que sobra, a previsão e o teto.
 * `reais` formata o valor; `deQuem`: "da empresa" ou "da marca" (o teto que negou).
 */
export function fraseDeNaoCaber(c: ContaDoMes, acrescenta: bigint, reais: (micros: bigint) => string, deQuem: string): string {
  if (c.teto === null || c.sobra === null) return 'A empresa ainda não definiu o teto do mês.';
  const mes = nomeDoMes(c.mes.periodo);
  const comHoje = c.pesam > 0n ? `, mais ${reais(c.pesam)} de aumentos pedidos ou feitos hoje` : '';
  const conta = `No ritmo atual, ${mes} fecha em ${reais(c.previsto)}${comHoje}, e o teto ${deQuem} é de ${reais(c.teto)}.`;
  if (c.sobra < 0n) return `Não cabe na verba de ${mes}: o mês já passa do teto em ${reais(-c.sobra)}. ${conta}`;
  return `Não cabe na verba de ${mes}: o pedido acrescenta ${reais(acrescenta)} até o fim do mês, e sobram ${reais(c.sobra)}. ${conta}`;
}
