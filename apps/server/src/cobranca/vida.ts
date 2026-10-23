// A vida da assinatura (A7, W1; Termos 10 e 11; `plano-a7.md` D-A7-6, D-A7-16, D-A7-17, D-A7-19 e D-A7-20 a D-A7-26),
// em funções puras: as datas, os dias de atraso e a situação que eles dão, a diferença da troca de plano e o prazo da
// desistência. As datas são dias do calendário da empresa (AAAA-MM-DD), sem fuso: quem chama converte o instante pelo
// fuso dela (`diaNoFuso`). São as contas do protótipo P26 (`datasDo` e `diferencaDoPlano`), com o vencimento preso ao
// último dia do mês curto (D-A7-21), que o protótipo não mostrava.

/** O 10º dia depois do vencimento: as ações dos funcionários de IA param (Termos 10.4; D-A7-6). */
export const DIA_DAS_ACOES_PARADAS = 10;
/** O 30º dia: a conta é suspensa (Termos 10.4). */
export const DIA_DA_SUSPENSAO = 30;
/** A fatura do período seguinte nasce 5 dias antes do vencimento: o e-mail do PIX leva o QR Code (D-A7-17). */
export const DIAS_DA_FATURA_ANTES = 5;
/** A desistência com a devolução integral: até o 7º dia depois do primeiro pagamento (Termos 11.1; D-A7-19). */
export const DIAS_PARA_DESISTIR = 7;
/** Sem o primeiro pagamento em 7 dias, o pedido de assinatura termina sozinho (D-A7-24). */
export const DIAS_PARA_O_PRIMEIRO_PAGAMENTO = 7;
/**
 * O mínimo de uma cobrança no meio de pagamento: R$ 5,00 no Asaas (base §18.5). A diferença de troca de plano abaixo
 * dele não vira cobrança: o plano muda na hora (D-A7-32).
 */
export const MINIMO_DA_COBRANCA_CENTAVOS = 500;

export type SituacaoPeloAtraso = 'ativa' | 'em_atraso' | 'acoes_paradas' | 'suspensa';

/**
 * As situações da assinatura paga e viva, as que o atraso dá: é a assinatura que conta na franquia de IA da empresa
 * (D-A7-26, `franquia.ts`).
 */
export const VIVAS_PAGAS: readonly SituacaoPeloAtraso[] = ['ativa', 'em_atraso', 'acoes_paradas', 'suspensa'];

const DIA_MS = 86_400_000;
const meioDia = (dia: string): number => Date.parse(`${dia}T12:00:00Z`);

/** O dia do calendário (AAAA-MM-DD) de um instante, no fuso da empresa. */
export function diaNoFuso(instante: Date, fuso: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: fuso, year: 'numeric', month: '2-digit', day: '2-digit' }).format(instante);
}

/** O dia tantos dias depois (antes, com `n` negativo): conta de calendário, sem fuso. */
export function somarDias(dia: string, n: number): string {
  return new Date(meioDia(dia) + n * DIA_MS).toISOString().slice(0, 10);
}

/** Quantos dias de `de` até `ate` (negativo quando `ate` vem antes). */
export function diasEntre(de: string, ate: string): number {
  return Math.round((meioDia(ate) - meioDia(de)) / DIA_MS);
}

/** O último dia do mês (de 1 a 12) do ano. */
function ultimoDiaDoMes(ano: number, mes: number): number {
  return new Date(Date.UTC(ano, mes, 0)).getUTCDate();
}

/** O dia do mês de uma data (de 1 a 31). */
export function diaDoMes(dia: string): number {
  return Number(dia.slice(8, 10));
}

/**
 * O vencimento seguinte: o mês seguinte, no dia do vencimento da assinatura (`diaDoVencimento`, o do primeiro
 * pagamento); no mês que não tem esse dia, o último dia do mês (31/01 → 28/02 → 31/03; D-A7-21).
 */
export function proximoVencimento(vencimento: string, diaDoVencimento: number): string {
  const ano0 = Number(vencimento.slice(0, 4));
  const mes0 = Number(vencimento.slice(5, 7));
  const ano = mes0 === 12 ? ano0 + 1 : ano0;
  const mes = mes0 === 12 ? 1 : mes0 + 1;
  const dia = Math.min(diaDoVencimento, ultimoDiaDoMes(ano, mes));
  return `${ano}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
}

/**
 * A situação pelo atraso da mensalidade mais antiga em aberto, contado no calendário da empresa (D-A7-22): no dia do
 * vencimento e antes, em dia; do 1º ao 9º dia depois, em atraso; do 10º ao 29º, as ações paradas; do 30º em diante,
 * suspensa (Termos 10.4). Sem mensalidade em aberto, em dia.
 */
export function situacaoPeloAtraso(vencimentoEmAberto: string | null, hoje: string): SituacaoPeloAtraso {
  if (vencimentoEmAberto === null) return 'ativa';
  const dias = diasEntre(vencimentoEmAberto, hoje);
  if (dias >= DIA_DA_SUSPENSAO) return 'suspensa';
  if (dias >= DIA_DAS_ACOES_PARADAS) return 'acoes_paradas';
  if (dias >= 1) return 'em_atraso';
  return 'ativa';
}

/** As datas dos próximos passos de uma mensalidade em atraso, para a tela e para o aviso (Termos 10.4). */
export function passosDoAtraso(vencimento: string): { acoesParamEm: string; suspendeEm: string } {
  return { acoesParamEm: somarDias(vencimento, DIA_DAS_ACOES_PARADAS), suspendeEm: somarDias(vencimento, DIA_DA_SUSPENSAO) };
}

/**
 * A diferença de hoje ao subir de plano, em centavos: a diferença de preço na proporção dos dias que faltam no período,
 * arredondada ao centavo (D-A7-16). Descer de plano não tem diferença: vale no período seguinte.
 */
export function diferencaDoPlano(precoAtual: number, precoNovo: number, diasQueFaltam: number, diasDoPeriodo: number): number {
  if (precoNovo <= precoAtual || diasQueFaltam <= 0 || diasDoPeriodo <= 0) return 0;
  return Math.round(((precoNovo - precoAtual) * Math.min(diasQueFaltam, diasDoPeriodo)) / diasDoPeriodo);
}

/** O último dia em que o Dono pode desistir com a devolução integral (o dia do pagamento conta como o dia zero). */
export function ultimoDiaParaDesistir(diaDoPrimeiroPagamento: string): string {
  return somarDias(diaDoPrimeiroPagamento, DIAS_PARA_DESISTIR);
}
