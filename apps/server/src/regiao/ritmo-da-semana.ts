import { VARIACAO_MAXIMA_DA_VERBA_PCT } from '../policy/engine.js';
import { diasDepois } from './semana.js';

// O ritmo da semana (plano da região, R7; protótipo aprovado pelo dono em 13/11/2026, D-RG-58 a D-RG-65): a verba de
// cada dia da semana que vem segue os pedidos da loja por dia da semana, a chuva prevista e as datas, sem gastar mais na
// semana. Aqui ficam as contas puras, sem rede e sem banco:
//   - o peso de cada dia (a parte da verba de hoje que o dia leva), entre 20% abaixo e 20% acima, mudando no máximo
//     perto de 10% de um dia para o outro, com os 7 dias somando no máximo 7 (D-RG-59 e D-RG-60);
//   - a verba de cada campanha em cada dia, em centavos inteiros, conferida pelos mesmos limites: cada mudança dentro
//     dos 10% da política da Liame (D-A4-6), nenhum dia acima do teto por campanha, a semana sem passar de 7 dias da
//     verba de hoje.
// A base diz por quê: escala de 20%, nunca 30% de uma vez (§7.1), e o limite de 10% por mudança é a política do Liame.

/** Cada dia fica entre 20% abaixo e 20% acima da verba de hoje (D-RG-60). */
export const FAIXA_DO_RITMO = { minimo: 0.8, maximo: 1.2 } as const;
/**
 * A mudança do peso de um dia para o outro: um pouco abaixo dos 10% da política, para o arredondamento ao centavo
 * nunca passar dela (com a verba mínima do ritmo, o centavo pesa menos de 0,2%).
 */
export const PASSO_DO_PESO = (VARIACAO_MAXIMA_DA_VERBA_PCT - 0.5) / 100;
/** O acréscimo da chuva prevista e o da data, em pontos do peso (D-RG-59: começam em 5 e se ajustam pelo caixa). */
export const ACRESCIMO_DA_CHUVA = 0.05;
export const ACRESCIMO_DA_DATA = 0.05;
/** A campanha com menos que isto por dia fica fora: o centavo pesaria demais nos limites. */
export const VERBA_MINIMA_NO_RITMO_MICROS = 10_000_000;
/**
 * Sem pedidos que bastem (ou sem o Regem), a referência do setor: mais peso de sexta a domingo (base §19.2), dita como
 * referência, nunca como número da loja. Do domingo (0) ao sábado (6); somam 7.
 */
export const PESOS_DO_SETOR: readonly number[] = [1.15, 0.875, 0.875, 0.875, 0.875, 1.15, 1.2];

const CENTAVO = 10_000;
/** As condições do CPTEC sem chuva (as mesmas que a tela desenha com sol ou nuvem); o resto é chuva. */
const SEM_CHUVA = new Set(['cl', 'ps', 'pn', 'vn', 'e', 'n', 'nv', 'g', 'ne', 'nd']);
export const chove = (condicao: string): boolean => !SEM_CHUVA.has(condicao);

/** O dia da semana de "AAAA-MM-DD" (0 = domingo). */
export function diaDaSemana(dia: string): number {
  return new Date(`${dia}T12:00:00Z`).getUTCDay();
}

/** A semana que vem: da próxima segunda (depois de hoje) ao domingo dela. */
export function semanaQueVem(hoje: string): { de: string; ate: string; dias: string[] } {
  const ateSegunda = (8 - diaDaSemana(hoje)) % 7 || 7;
  const dias = Array.from({ length: 7 }, (_, i) => diasDepois(hoje, ateSegunda + i));
  return { de: dias[0]!, ate: dias[6]!, dias };
}

export type PorqueDoDia =
  /** A parte dos pedidos da semana que cai neste dia da semana (a média de um dia é 14%). */
  | { kind: 'pedidos'; share_pct: number }
  /** Sem pedidos que bastem: a referência do setor. */
  | { kind: 'setor' }
  | { kind: 'chuva'; description: string; min: number; max: number }
  /** A data do dia, ou a do dia seguinte (`eve`: a véspera). */
  | { kind: 'data'; name: string; eve: boolean };

export interface DiaDoRitmo {
  day: string;
  weekday: number;
  /** A parte da verba de hoje que o dia leva (1 = igual a hoje). */
  weight: number;
  reasons: PorqueDoDia[];
}

export interface EntradaDoRitmo {
  dias: readonly string[];
  /** Os pedidos por dia da semana nas 4 semanas (0 = domingo); nulo sem pedidos que bastem. */
  pedidosPorDiaDaSemana: readonly number[] | null;
  previsao: ReadonlyArray<{ day: string; condition: string; description: string; min: number; max: number }>;
  /** As datas do calendário: feriado nacional, data do varejo e o prazo do salário. */
  datas: ReadonlyArray<{ day: string; name: string; kind: string }>;
}

const limitar = (v: number, de: number, ate: number): number => Math.min(Math.max(v, de), ate);

// Os pesos em inteiros (décimos de milésimo), para a soma da semana e o passo de um dia para o outro não dependerem de
// ponto flutuante. A procura do caminho anda numa grade da faixa inteira, de 0,0005 em 0,0005 (o peso 1 está nela).
const ESCALA = 10_000;
const GRADE = 5;
const PESO_MINIMO = Math.round(FAIXA_DO_RITMO.minimo * ESCALA);
const PESOS_NA_GRADE = (Math.round(FAIXA_DO_RITMO.maximo * ESCALA) - PESO_MINIMO) / GRADE + 1;
/** O passo em milésimos: o dia vale de 90,5% a 109,5% do dia anterior. */
const SOBE = Math.round((1 + PASSO_DO_PESO) * 1000);
const DESCE = Math.round((1 - PASSO_DO_PESO) * 1000);
/** Para cada peso da grade, de quais pesos o dia anterior pode ter vindo (os dois crescem com o peso). */
const VEM_DE = new Int16Array(PESOS_NA_GRADE);
const VEM_ATE = new Int16Array(PESOS_NA_GRADE);
for (let k = 0; k < PESOS_NA_GRADE; k++) {
  const peso = PESO_MINIMO + k * GRADE;
  VEM_DE[k] = Math.max(0, Math.ceil((Math.ceil((peso * 1000) / SOBE) - PESO_MINIMO) / GRADE));
  VEM_ATE[k] = Math.min(PESOS_NA_GRADE - 1, Math.floor((Math.floor((peso * 1000) / DESCE) - PESO_MINIMO) / GRADE));
}

interface Memoria {
  custo: Float64Array;
  novo: Float64Array;
  veio: Int16Array[];
  fila: Int32Array;
}
const novaMemoria = (dias: number): Memoria => ({
  custo: new Float64Array(PESOS_NA_GRADE),
  novo: new Float64Array(PESOS_NA_GRADE),
  veio: Array.from({ length: dias }, () => new Int16Array(PESOS_NA_GRADE)),
  fila: new Int32Array(PESOS_NA_GRADE),
});

/**
 * Entre todos os caminhos que respeitam a faixa e o passo (o primeiro dia a partir da verba de hoje), o MAIS PERTO dos
 * alvos: a menor soma dos quadrados das diferenças. A conta é exata na grade: dia a dia, o menor desvio acumulado para
 * terminar o dia em cada peso (o mínimo do dia anterior numa janela que só anda para a frente), e a volta pelo caminho.
 * Olhar a semana inteira é o que faz a verba começar a subir ANTES do dia forte: aplicar o passo só de frente para
 * trás deixava a sexta forte, depois da quinta fraca, abaixo da terça. Devolve os pesos em décimos de milésimo.
 */
function caminho(alvos: readonly number[], m: Memoria): number[] {
  let { custo, novo } = m;
  alvos.forEach((alvo, i) => {
    const a = alvo * ESCALA;
    const veio = m.veio[i]!;
    let frente = 0;
    let fim = 0;
    let proximo = 0;
    for (let k = 0; k < PESOS_NA_GRADE; k++) {
      const peso = PESO_MINIMO + k * GRADE;
      let antes = Infinity;
      let origem = -1;
      if (i === 0) {
        // O primeiro dia parte da verba de hoje (peso 1).
        if (peso * 1000 <= ESCALA * SOBE && peso * 1000 >= ESCALA * DESCE) antes = 0;
      } else {
        // Entram na fila os pesos de ontem que passaram a caber; saem do fim os mais caros que o novo (nunca seriam o
        // mínimo) e da frente os que ficaram longe demais. O da frente é o mais barato de onde este peso pode vir.
        for (; proximo <= VEM_ATE[k]!; proximo++) {
          if (custo[proximo]! === Infinity) continue;
          while (fim > frente && custo[m.fila[fim - 1]!]! > custo[proximo]!) fim--;
          m.fila[fim++] = proximo;
        }
        while (fim > frente && m.fila[frente]! < VEM_DE[k]!) frente++;
        if (fim > frente) {
          origem = m.fila[frente]!;
          antes = custo[origem]!;
        }
      }
      novo[k] = antes === Infinity ? Infinity : antes + (peso - a) * (peso - a);
      veio[k] = origem;
    }
    [custo, novo] = [novo, custo];
  });
  let k = 0;
  for (let j = 1; j < PESOS_NA_GRADE; j++) if (custo[j]! < custo[k]!) k = j;
  const pesos = new Array<number>(alvos.length);
  for (let i = alvos.length - 1; i >= 0; i--) {
    pesos[i] = PESO_MINIMO + k * GRADE;
    k = m.veio[i]![k]!;
  }
  return pesos;
}

/** O caminho mais perto dos alvos dentro da faixa e do passo, sem olhar a soma da semana (os pesos, 1 = a verba de hoje). */
export function caminhoMaisPerto(alvos: readonly number[]): number[] {
  return caminho(alvos, novaMemoria(alvos.length)).map((v) => v / ESCALA);
}

/**
 * O peso de cada dia da semana. O pedido de cada dia é a parte dos pedidos daquele dia da semana sobre a média (ou a
 * referência do setor), mais o acréscimo da chuva prevista e o da data. Depois os limites: a faixa, o passo e a soma.
 * Os pesos são o caminho mais perto dos pedidos entre os que cabem na faixa e no passo; todos os pedidos sobem ou
 * descem juntos (a mesma constante) até a semana somar 7: o que sobe num dia desce em outro.
 */
export function pesosDaSemana(e: EntradaDoRitmo): DiaDoRitmo[] {
  const total = e.pedidosPorDiaDaSemana ? e.pedidosPorDiaDaSemana.reduce((s, n) => s + n, 0) : 0;
  const daLoja = e.pedidosPorDiaDaSemana !== null && total > 0;
  const dias = e.dias.map((day) => {
    const weekday = diaDaSemana(day);
    const reasons: PorqueDoDia[] = [];
    let pedido: number;
    if (daLoja) {
      const parte = e.pedidosPorDiaDaSemana![weekday]! / total;
      pedido = parte * 7;
      reasons.push({ kind: 'pedidos', share_pct: Math.round(parte * 100) });
    } else {
      pedido = PESOS_DO_SETOR[weekday]!;
      reasons.push({ kind: 'setor' });
    }
    const tempo = e.previsao.find((p) => p.day === day);
    if (tempo && chove(tempo.condition)) {
      pedido += ACRESCIMO_DA_CHUVA;
      reasons.push({ kind: 'chuva', description: tempo.description, min: tempo.min, max: tempo.max });
    }
    // A data do dia e a véspera de feriado ou de data do varejo (o prazo do salário vale só no dia).
    const amanha = diasDepois(day, 1);
    const doDia = e.datas.filter((d) => d.day === day);
    const daVespera = e.datas.filter((d) => d.day === amanha && d.kind !== 'salario');
    if (doDia.length || daVespera.length) {
      pedido += ACRESCIMO_DA_DATA;
      for (const d of doDia) reasons.push({ kind: 'data', name: d.name, eve: false });
      for (const d of daVespera) reasons.push({ kind: 'data', name: d.name, eve: true });
    }
    return { day, weekday, pedido, reasons };
  });
  const pedidos = dias.map((d) => d.pedido);
  const semana = pedidos.length * ESCALA;
  // A soma cai quando `c` sobe (o caminho mais perto de alvos menores soma menos). No menor `c` todos os dias pedem o
  // máximo da faixa, e a semana passa de 7; no maior, todos pedem menos que o mínimo, e a semana fica abaixo de 7
  // (quando quase todos os pedidos caem num dia só, os outros dias sobem até a semana usar a verba inteira). A procura
  // aperta os dois lados: o último caminho que passa de 7 (`acima`) e o primeiro que cabe (`cabe`).
  const memoria = novaMemoria(pedidos.length);
  const com = (c: number): { pesos: number[]; soma: number } => {
    const pesos = caminho(
      pedidos.map((r) => r - c),
      memoria,
    );
    return { pesos, soma: pesos.reduce((t, v) => t + v, 0) };
  };
  let de = Math.min(-0.6, Math.min(...pedidos) - FAIXA_DO_RITMO.maximo);
  let ate = Math.max(0.6, ...pedidos);
  let acima = com(de);
  let cabe = com(ate);
  for (let i = 0; i < 30; i++) {
    const meio = (de + ate) / 2;
    const tentativa = com(meio);
    if (tentativa.soma <= semana) {
      ate = meio;
      cabe = tentativa;
    } else {
      de = meio;
      acima = tentativa;
    }
  }
  // A grade não fecha a semana em 7 exatos, e a verba inteira é para ser usada. Os limites são retas: a mistura dos dois
  // caminhos, na proporção que soma 7, também cabe na faixa e no passo. Ela é arredondada para baixo e o passo é
  // conferido de novo em inteiros (a partir da verba de hoje). Esse acerto pode subir um dia em um décimo de milésimo:
  // se a semana passar de 7, a mistura mira um pouco abaixo (com um décimo de milésimo de folga por dia, sempre cabe).
  const mistura = (folga: number): number[] => {
    const parte = acima.soma > semana ? Math.max(0, (semana - folga - cabe.soma) / (acima.soma - cabe.soma)) : 0;
    let antes = ESCALA;
    return cabe.pesos.map((v, i) => {
      const peso = limitar(Math.floor(v + parte * (acima.pesos[i]! - v) + 1e-9), Math.ceil((antes * DESCE) / 1000), Math.floor((antes * SOBE) / 1000));
      antes = peso;
      return peso;
    });
  };
  const pesos = [0, 2, 4, pedidos.length].map(mistura).find((m) => m.reduce((t, v) => t + v, 0) <= semana) ?? cabe.pesos;
  return dias.map((d, i) => ({ day: d.day, weekday: d.weekday, weight: pesos[i]! / ESCALA, reasons: d.reasons }));
}

export type VerbaDoRitmo = { ok: true; dias: number[] } | { ok: false; motivo: 'verba_pequena' | 'fracao_de_centavo' | 'acima_do_teto' | 'fora_dos_limites' };

/**
 * A verba de uma campanha em cada dia do ritmo, em micros, a partir da verba de hoje: centavos inteiros (para baixo),
 * cada mudança dentro dos 10% da política (a partir da verba de hoje), nenhum dia acima do teto por campanha. A campanha
 * que não cabe nas regras fica fora do ritmo, com o motivo.
 */
export function verbaDoRitmo(baseMicros: number, pesos: readonly number[], tetoMicros: number | null): VerbaDoRitmo {
  if (!Number.isInteger(baseMicros) || baseMicros % CENTAVO !== 0) return { ok: false, motivo: 'fracao_de_centavo' };
  if (baseMicros < VERBA_MINIMA_NO_RITMO_MICROS) return { ok: false, motivo: 'verba_pequena' };
  if (tetoMicros !== null && baseMicros > tetoMicros) return { ok: false, motivo: 'acima_do_teto' };
  const base = baseMicros / CENTAVO;
  const teto = tetoMicros === null ? null : Math.floor(tetoMicros / CENTAVO);
  let antes = base;
  const dias = pesos.map((p) => {
    // Os limites em inteiros (centavos × 100), para o arredondamento não depender de ponto flutuante.
    let v = limitar(Math.floor(base * p), Math.ceil((antes * (100 - VARIACAO_MAXIMA_DA_VERBA_PCT)) / 100), Math.floor((antes * (100 + VARIACAO_MAXIMA_DA_VERBA_PCT)) / 100));
    if (teto !== null) v = Math.min(v, teto);
    antes = v;
    return v * CENTAVO;
  });
  return problemasDaVerba(baseMicros, dias, tetoMicros).length ? { ok: false, motivo: 'fora_dos_limites' } : { ok: true, dias };
}

/**
 * O que a verba de uma campanha no ritmo desrespeita (vazio: nada): a mudança de um dia para o outro acima dos 10% da
 * política, o dia fora da faixa, acima do teto por campanha, ou a semana acima de 7 dias da verba de hoje. É a mesma
 * conferência antes de propor e antes de executar cada passo.
 */
export function problemasDaVerba(baseMicros: number, dias: readonly number[], tetoMicros: number | null): string[] {
  const problemas: string[] = [];
  let antes = baseMicros;
  dias.forEach((v, i) => {
    if (!Number.isInteger(v) || v % CENTAVO !== 0) problemas.push(`dia ${i + 1}: fração de centavo`);
    // A conta em inteiros (micros × 100), para o limite exato não depender de ponto flutuante.
    if (Math.abs(v - antes) * 100 > antes * VARIACAO_MAXIMA_DA_VERBA_PCT) problemas.push(`dia ${i + 1}: muda mais de ${VARIACAO_MAXIMA_DA_VERBA_PCT}%`);
    // A faixa também em inteiros (× 10); o centavo de folga embaixo é o do arredondamento para baixo.
    const [minimo, maximo] = [Math.round(FAIXA_DO_RITMO.minimo * 10), Math.round(FAIXA_DO_RITMO.maximo * 10)];
    if (v * 10 < baseMicros * minimo - CENTAVO * 10 || v * 10 > baseMicros * maximo) problemas.push(`dia ${i + 1}: fora da faixa`);
    if (tetoMicros !== null && v > tetoMicros) problemas.push(`dia ${i + 1}: acima do teto por campanha`);
    antes = v;
  });
  if (dias.reduce((s, v) => s + v, 0) > baseMicros * dias.length) problemas.push('a semana gasta mais do que sem o ritmo');
  return problemas;
}
