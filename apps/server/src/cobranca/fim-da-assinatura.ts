// O fim da assinatura (A7, W3, parte 4a; Termos 11.2; D-A7-106), em funções puras: em que situação cada marca da
// empresa está para o apagamento e, quando uma marca chega ao dia, se sai só ela, a empresa inteira ou se espera. Aprovado
// pelo dono em 03/11/2026: 30 dias depois do fim da assinatura paga, ou no 60º dia de atraso, se a marca segue sem
// assinatura paga, os dados dela são apagados; a empresa inteira, quando todas as marcas estão na mesma situação.

/**
 * A situação de uma marca (não arquivada) para o apagamento:
 * - `viva`: tem uma assinatura que não terminou, paga ou esperando o primeiro pagamento (uma assinatura nova suspende o
 *   apagamento enquanto espera; se não for paga, o apagamento volta para o dia que tinha);
 * - `devida`: a última assinatura paga terminou, o dia do apagamento chegou e o meio de pagamento não tem nada pendente;
 * - `esperando`: a última assinatura paga terminou, mas o dia ainda não chegou ou o meio de pagamento tem algo pendente
 *   (uma cobrança a cancelar, uma devolução em andamento);
 * - `sem_contrato`: nunca teve assinatura paga.
 */
export type SituacaoDaMarca = 'viva' | 'devida' | 'esperando' | 'sem_contrato';

export type DadosDaMarca = {
  /** Tem assinatura que não terminou. */
  viva: boolean;
  /** O dia do apagamento da última assinatura paga (AAAA-MM-DD), ou nulo se nunca houve assinatura paga. */
  apagarEm: string | null;
  /** O meio de pagamento ainda tem algo pendente nas faturas da marca. */
  pendenteNoMeio: boolean;
};

/** A situação da marca no dia `hoje` (AAAA-MM-DD, no calendário da empresa). */
export function situacaoDaMarca(m: DadosDaMarca, hoje: string): SituacaoDaMarca {
  if (m.viva) return 'viva';
  if (m.apagarEm === null) return 'sem_contrato';
  if (m.apagarEm > hoje || m.pendenteNoMeio) return 'esperando';
  return 'devida';
}

export type DecisaoDoApagamento = 'marca' | 'empresa' | 'esperar';

/**
 * Uma marca chegou ao dia: o que sai, pelas outras marcas (não arquivadas) da mesma empresa.
 * - alguma outra está viva: sai só esta marca;
 * - nenhuma viva, mas alguma ainda esperando o dia dela: espera, para a empresa sair inteira no último dia;
 * - todas as outras também devidas, ou sem contrato: sai a empresa inteira (o encerramento que já existe, com o
 *   certificado ao Dono).
 */
export function decidirApagamento(outras: readonly SituacaoDaMarca[]): DecisaoDoApagamento {
  if (outras.includes('viva')) return 'marca';
  if (outras.includes('esperando')) return 'esperar';
  return 'empresa';
}

/** O motivo do apagamento, como fica no certificado e na auditoria. */
export const MOTIVO_DO_APAGAMENTO = 'fim da assinatura';
