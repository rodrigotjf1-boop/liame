import { diasDepois } from '../regiao/semana.js';
import type { JanelaDoRitmo } from './ritmo-plano.js';

// O horário do ritmo da semana (plano da região, R7, parte 2b; D-RG-61 e D-RG-104), sem banco e sem rede: com a janela
// aprovada, em que situação cada campanha deve estar agora e qual é o passo deste momento. A janela é a mesma em todos
// os dias da semana, no fuso da loja: de `de` até `ate`, e `ate` menor que `de` termina no dia seguinte. Cada dia da
// semana tem um "ligar" (no começo da janela dele) e um "pausar" (no fim); antes da primeira janela da semana, o pausar é
// o da véspera da semana (a campanha vinha ligada o dia todo). Depois que a última janela acaba, o horário não vale
// mais: a campanha fica ligada o dia todo ("soltar", como no fim da semana e quando alguém para o ritmo).

/** Os passos do horário: o da janela (ligar no começo, pausar no fim) e o que deixa ligado o dia todo. */
export type TipoDoHorario = 'ligar' | 'pausar';
export type TipoDaSituacao = TipoDoHorario | 'soltar';
export const TIPOS_DA_SITUACAO: readonly TipoDaSituacao[] = ['ligar', 'pausar', 'soltar'];

/** O que a janela pede agora: a situação, o passo e o dia a que ele pertence (o dia da janela). */
export interface MomentoDoHorario {
  status: 'ativo' | 'pausado';
  tipo: TipoDoHorario;
  dia: string;
}

const MINUTOS_NO_DIA = 24 * 60;
const minutosDoDia = (dia: string): number => Date.UTC(Number(dia.slice(0, 4)), Number(dia.slice(5, 7)) - 1, Number(dia.slice(8, 10))) / 60_000;
const minutosDaHora = (hora: string): number => Number(hora.slice(0, 2)) * 60 + Number(hora.slice(3, 5));

/**
 * O que a janela pede no instante dado (o dia e a hora no fuso da loja). Dentro da janela de um dia da semana: ligada,
 * o "ligar" daquele dia. Fora: pausada, o "pausar" da última janela que acabou (ou o da véspera da semana, antes da
 * primeira). Nulo antes da semana e depois que a última janela dela acabou: aí o horário não vale.
 */
export function momentoDoHorario(agora: { dia: string; hora: string }, semana: { de: string; ate: string }, janela: JanelaDoRitmo): MomentoDoHorario | null {
  const t = minutosDoDia(agora.dia) + minutosDaHora(agora.hora);
  const inicioDaSemana = minutosDoDia(semana.de);
  if (t < inicioDaSemana) return null;
  const de = minutosDaHora(janela.de);
  const duracao = (minutosDaHora(janela.ate) - de + MINUTOS_NO_DIA) % MINUTOS_NO_DIA;
  let ultimaQueAcabou: string | null = null;
  for (let dia = semana.de; dia <= semana.ate; dia = diasDepois(dia, 1)) {
    const comeco = minutosDoDia(dia) + de;
    const fim = comeco + duracao;
    if (t >= comeco && t < fim) return { status: 'ativo', tipo: 'ligar', dia };
    if (t >= fim) ultimaQueAcabou = dia;
  }
  // Depois que a janela do último dia acabou, o horário da semana terminou.
  if (ultimaQueAcabou === semana.ate) return null;
  return { status: 'pausado', tipo: 'pausar', dia: ultimaQueAcabou ?? diasDepois(semana.de, -1) };
}

/**
 * A situação em que o Liame deixou cada objeto, pelos passos de situação feitos (de todos os ritmos da marca, do mais
 * antigo ao mais novo): o último "pausar" feito deixa pausado; "ligar" e "soltar" deixam ligado. Sem passo de situação,
 * ligado (a campanha entra no ritmo ativa).
 */
export function situacaoDeixada(passosFeitos: ReadonlyArray<{ kind: string }>): 'ativo' | 'pausado' {
  const ultimo = [...passosFeitos].reverse().find((p) => (TIPOS_DA_SITUACAO as readonly string[]).includes(p.kind));
  return ultimo?.kind === 'pausar' ? 'pausado' : 'ativo';
}
