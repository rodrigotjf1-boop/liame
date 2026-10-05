import { menosDias } from '../results/fora-do-normal.js';
import { aoCentavo, diasEntre } from './verba-do-mes.js';

// A conferência do gasto de cada mudança (A4, X4 parte 2; `plano-a4.md` D-A4-24 e critério A4-8). Todo dia, depois da
// leitura da plataforma, cada mudança que o Liame fez e que continua valendo é conferida em três pontas:
//
//   execução (o que o Liame deixou)  →  informado (o que a plataforma mostra na leitura do dia)  →  gasto real
//
// - Se a plataforma mostra outra situação ou outra verba, alguém mudou lá depois: não é erro (quem mexe na plataforma
//   manda), e a mudança deixa de ser conferida pelo gasto.
// - O gasto é conferido pela SEMANA, não pelo dia: a verba diária é uma média, e a plataforma gasta mais num dia e
//   menos em outro (base de conhecimento §2.1). Compara-se o gasto dos 7 dias inteiros até ontem com a soma da verba
//   de cada um desses dias (a de antes da mudança nos dias de antes, a de depois nos dias de depois, e a maior das
//   duas no dia da mudança).
// - O objeto pausado não pode gastar nos dias inteiros depois da pausa.
// - Onde a verba não mora no objeto (anúncio, conjunto com a verba na campanha), não há com o que comparar.
//
// Funções puras: quem lê o banco e grava a conferência é a rotina do worker (`worker/conferencia-do-gasto.ts`).

/** Quantos dias inteiros a conferência olha. */
export const DIAS_DA_CONFERENCIA = 7;
/** Por quantos dias depois de executada uma mudança segue sendo conferida. */
export const DIAS_CONFERINDO = 35;

export type SituacaoDoObjeto = 'ativo' | 'pausado';

/** A situação e a verba diária de um objeto de anúncio (a verba é nula quando não mora nele). */
export interface EstadoConferido {
  status: string;
  verbaDiaria: bigint | null;
}

export interface MudancaParaConferir {
  /** O dia em que o Liame executou a mudança, no fuso da conta de anúncio. */
  executadaEm: string;
  /** Como o objeto estava logo antes (o estado lido na plataforma na hora do pedido). */
  antes: EstadoConferido;
  /** Como o Liame deixou. */
  depois: { status: SituacaoDoObjeto; verbaDiaria: bigint | null };
}

export interface LeituraDoDia {
  /** O dia da conferência, no fuso da conta. */
  hoje: string;
  /** Como a leitura de hoje mostra o objeto; nulo se ele saiu da lista da conta. */
  informado: EstadoConferido | null;
  /** O gasto do objeto em cada dia, em micros. */
  gastoPorDia: ReadonlyMap<string, bigint>;
}

export type ResultadoDaConferencia = 'confere' | 'mudou' | 'acima';

export interface Conferencia {
  status: ResultadoDaConferencia;
  /** Os dias comparados: os 7 inteiros até ontem ou, quando só parte deles tem verba conhecida, essa parte. */
  janela: { de: string; ate: string };
  /** O gasto nesses dias, ao centavo. */
  gasto: bigint;
  /** O que a verba permite nesses dias; nulo quando a verba não mora no objeto (não há com o que comparar). */
  permitido: bigint | null;
  /** Os dias inteiros depois do dia da mudança, até ontem, e o gasto neles (para a média "depois da mudança"). */
  diasDepois: number;
  gastoDepois: bigint;
}

/** A verba que vale num dia com o objeto neste estado: zero se não está ativo; nula se a verba não mora nele. */
const verbaDoEstado = (e: EstadoConferido): bigint | null => (e.status === 'ativo' ? e.verbaDiaria : 0n);

/** O que a verba permite gastar num dia; nulo quando não dá para saber. */
function permitidoNoDia(m: MudancaParaConferir, dia: string): bigint | null {
  if (dia > m.executadaEm) return verbaDoEstado(m.depois);
  if (dia < m.executadaEm) return verbaDoEstado(m.antes);
  // No dia da mudança valeram as duas verbas, cada uma por uma parte do dia: conta a maior.
  const [antes, depois] = [verbaDoEstado(m.antes), verbaDoEstado(m.depois)];
  if (antes === null || depois === null) return null;
  return antes > depois ? antes : depois;
}

/** A plataforma mostra o objeto como o Liame deixou? A verba só é comparada quando mora no objeto. */
export function estaComoFicou(depois: MudancaParaConferir['depois'], informado: EstadoConferido | null): boolean {
  if (!informado || informado.status !== depois.status) return false;
  return depois.verbaDiaria === null || informado.verbaDiaria === depois.verbaDiaria;
}

/** A conferência de uma mudança num dia. */
export function conferir(m: MudancaParaConferir, l: LeituraDoDia): Conferencia {
  const ontem = menosDias(l.hoje, 1);
  const dias: string[] = [];
  for (let n = DIAS_DA_CONFERENCIA; n >= 1; n--) dias.push(menosDias(l.hoje, n));
  const gastoEm = (dia: string) => l.gastoPorDia.get(dia) ?? 0n;

  // Os dias com verba conhecida, do mais recente para trás, enquanto forem seguidos: é sobre eles que se compara.
  let primeiro = dias.length;
  while (primeiro > 0 && permitidoNoDia(m, dias[primeiro - 1]!) !== null) primeiro -= 1;
  const comparados = dias.slice(primeiro);
  const olhados = comparados.length ? comparados : dias;
  const gasto = aoCentavo(olhados.reduce((s, d) => s + gastoEm(d), 0n));
  const permitido = comparados.length ? comparados.reduce((s, d) => s + permitidoNoDia(m, d)!, 0n) : null;

  const diasDepois = Math.max(0, diasEntre(m.executadaEm, ontem));
  let gastoDepois = 0n;
  for (let n = 1; n <= diasDepois; n++) gastoDepois += gastoEm(menosDias(l.hoje, n));

  const status: ResultadoDaConferencia = !estaComoFicou(m.depois, l.informado) ? 'mudou' : permitido !== null && gasto > permitido ? 'acima' : 'confere';
  return { status, janela: { de: olhados[0]!, ate: olhados.at(-1)! }, gasto, permitido, diasDepois, gastoDepois: aoCentavo(gastoDepois) };
}

/** Como a leitura diária guarda a situação (`ativa`, `pausada`…) → como o pedido de ação a escreve (`ativo`, `pausado`…). */
const SITUACAO_DA_LEITURA: Record<string, string> = { ativa: 'ativo', pausada: 'pausado', arquivada: 'arquivado', removida: 'removido', desconhecida: 'desconhecido' };
export const situacaoDaLeitura = (status: string): string => SITUACAO_DA_LEITURA[status] ?? 'desconhecido';

/** A verba da leitura: a plataforma manda zero quando a verba fica em outro nível, e isso é "não mora aqui". */
export const verbaDaLeitura = (micros: bigint | number | string | null | undefined): bigint | null => {
  if (micros === null || micros === undefined) return null;
  const v = BigInt(micros);
  return v > 0n ? v : null;
};

// ------------------------------------------------------------------ o aviso de quem gastou a mais

export interface GastoAcima {
  tipo: string;
  nome: string;
  /** O dia em que o Liame executou a mudança. */
  executadaEm: string;
  depois: { status: string; verbaDiaria: bigint | null };
  janela: { de: string; ate: string };
  gasto: bigint;
  permitido: bigint;
}

const ALVO: Record<string, { o: string; ele: string; pausado: string }> = {
  campanha: { o: 'A campanha', ele: 'ela', pausado: 'pausada' },
  conjunto: { o: 'O conjunto', ele: 'ele', pausado: 'pausado' },
  anuncio: { o: 'O anúncio', ele: 'ele', pausado: 'pausado' },
};
/** "26/09", a partir de AAAA-MM-DD. */
const diaMes = (dia: string) => `${dia.slice(8, 10)}/${dia.slice(5, 7)}`;
/** Como a pessoa chama a plataforma de anúncio, na frase ("Veja na Meta…"). */
export const nomeDaPlataforma = (provider: string): string => ({ meta_ads: 'Meta', google_ads: 'Google Ads' })[provider] ?? 'plataforma';

/**
 * O aviso de uma mudança cuja conferência deu "acima": o que houve, com os números que decidem (o gasto dos dias
 * comparados e o que a verba permitia neles), e onde olhar. `reais` formata o valor; `plataforma`: "Meta".
 */
export function textoDoGastoAcima(g: GastoAcima, reais: (micros: bigint) => string, plataforma: string): { title: string; detail: string; action: string } {
  const alvo = ALVO[g.tipo] ?? ALVO.anuncio!;
  const quem = `${alvo.o} "${g.nome}"`;
  const dias = diasEntre(g.janela.de, g.janela.ate) + 1;
  const periodo = dias === DIAS_DA_CONFERENCIA ? `Na semana de ${diaMes(g.janela.de)} a ${diaMes(g.janela.ate)}` : `De ${diaMes(g.janela.de)} a ${diaMes(g.janela.ate)}`;
  const soDepois = g.janela.de > g.executadaEm;
  if (g.depois.status === 'pausado') {
    return {
      title: `${quem} gastou depois de ${alvo.pausado} pelo Liame`,
      detail: soDepois
        ? `${periodo}, depois da pausa de ${diaMes(g.executadaEm)}, ${alvo.ele} gastou ${reais(g.gasto)}.`
        : `${periodo}, ${alvo.ele} gastou ${reais(g.gasto)}. Com a pausa de ${diaMes(g.executadaEm)}, esses dias iriam até ${reais(g.permitido)}.`,
      action: `Veja na ${plataforma} se ${alvo.ele} voltou a rodar nesses dias.`,
    };
  }
  const verba = g.depois.verbaDiaria === null ? null : reais(g.depois.verbaDiaria);
  const limite = soDepois && verba ? `Com a verba de ${verba} por dia que o Liame deixou` : `Com a verba que valia em cada um desses dias (o Liame mudou em ${diaMes(g.executadaEm)}${verba ? `; hoje são ${verba} por dia` : ''})`;
  return {
    title: `${quem} gastou mais do que a verba permite`,
    detail: `${periodo}, ${alvo.ele} gastou ${reais(g.gasto)}. ${limite}, ${dias === DIAS_DA_CONFERENCIA ? 'a semana iria' : 'esses dias iriam'} até ${reais(g.permitido)}.`,
    action: g.tipo === 'campanha' ? `Veja na ${plataforma} se a verba foi mudada por lá ou se há um conjunto com verba própria.` : `Veja na ${plataforma} se a verba foi mudada por lá.`,
  };
}
