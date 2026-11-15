import { CAMINHO_DA_COBRANCA } from './aviso-de-atraso.js';
import { DIA_DO_APAGAMENTO_NO_ATRASO, somarDias } from './vida.js';

// O aviso do apagamento por e-mail (A7, W3, parte 4b; `plano-a7.md` D-A7-106 e D-A7-107; Termos 11.2), em funções puras:
// quando cada aviso vai e o texto. Apagar não tem volta: 7 dias antes e na véspera do dia do apagamento, quem paga (o
// Dono e o Administrador com a cobrança liberada) recebe um e-mail com o dia, o que sai e o que fazer (exportar os dados;
// assinar de novo ou pagar o que está em aberto). Vale para a assinatura que terminou (o dia gravado no fim) e para a que
// segue suspensa (o 60º dia de atraso, quando ela termina e os dados saem no mesmo dia).

export { CAMINHO_DA_COBRANCA };

/** Os avisos antes do apagamento, em dias: 7 dias antes e a véspera. */
export const AVISOS_DO_APAGAMENTO = [7, 1] as const;
export type AvisoDoApagamento = (typeof AVISOS_DO_APAGAMENTO)[number];

/** Quantas vezes o envio a uma pessoa é tentado antes de desistir (a falha fica gravada, sem o endereço). */
export const TENTATIVAS_DO_AVISO_DO_APAGAMENTO = 3;

/**
 * O aviso que vale com tantos dias até o apagamento: a véspera (1 dia antes) e o de 7 dias (de 7 a 2 dias antes: com o
 * worker parado no 7º, ele vai no 6º). No dia, nenhum: o apagamento roda. Mais de 7 dias, ainda nenhum.
 */
export function avisoDoApagamento(diasAte: number): AvisoDoApagamento | null {
  if (diasAte === 1) return 1;
  if (diasAte >= 2 && diasAte <= 7) return 7;
  return null;
}

/** O dia em que a assinatura em atraso termina e os dados saem: o 60º dia de atraso da mensalidade mais antiga. */
export function apagamentoPeloAtraso(vencimentoMaisAntigo: string): string {
  return somarDias(vencimentoMaisAntigo, DIA_DO_APAGAMENTO_NO_ATRASO);
}

const dia = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;

export interface DadosDoAvisoDoApagamento {
  aviso: AvisoDoApagamento;
  /** O nome da marca da assinatura. */
  marca: string;
  /** O dia do apagamento (AAAA-MM-DD, no calendário da empresa). */
  apagaEm: string;
  /** O que sai: só a marca (outra marca da empresa segue com assinatura) ou a empresa inteira. */
  alcance: 'marca' | 'empresa';
  /** Por quê: a assinatura terminou, ou segue suspensa por uma mensalidade em aberto. */
  motivo: 'terminou' | 'atraso';
  /** O endereço da tela Plano e cobrança da marca. */
  link: string;
}

/**
 * O e-mail do aviso do apagamento, só texto, em português. O assunto diz o dia; o corpo diz por quê, o que sai, que não tem
 * volta, como levar os dados e como evitar (assinar de novo, ou pagar o que está em aberto).
 */
export function emailDoAvisoDoApagamento(d: DadosDoAvisoDoApagamento): { subject: string; text: string } {
  const quando = d.aviso === 1 ? `Amanhã, ${dia(d.apagaEm)}` : `Em ${dia(d.apagaEm)}`;
  const oQue =
    d.alcance === 'marca'
      ? `todos os dados da marca ${d.marca} no Liame. As outras marcas da empresa continuam como estão`
      : `a conta da empresa inteira, com todos os dados, porque ${d.marca} é a última marca dela com assinatura. O Dono recebe o certificado da exclusão por e-mail`;
  const porque =
    d.motivo === 'terminou'
      ? `A assinatura da marca ${d.marca} terminou. Pelos Termos (11.2), os dados ficam guardados por 30 dias depois do fim, para você levar.`
      : `A mensalidade da marca ${d.marca} está em aberto há quase 60 dias, e a conta segue suspensa. Pelos Termos (11.2), no 60º dia de atraso a assinatura termina, e os dados são apagados no mesmo dia.`;
  const evitar =
    d.motivo === 'terminou'
      ? 'Para continuar com o Liame, assine de novo na mesma tela: com a assinatura nova, nada é apagado enquanto ela espera o primeiro pagamento.'
      : 'Para não perder nada, pague a mensalidade em aberto na mesma tela: tudo volta na hora, a equipe entra de novo, e os funcionários de IA voltam a trabalhar.';
  return {
    subject: d.aviso === 1 ? `Liame: amanhã, os dados de ${d.marca} são apagados` : `Liame: os dados de ${d.marca} serão apagados em ${dia(d.apagaEm)}`,
    text: [
      porque,
      `${quando}, o Liame apaga ${oQue}. Apagar não tem volta.`,
      `Para levar os dados antes disso, o Dono usa "Exportar os dados" em Plano e cobrança: ${d.link}`,
      evitar,
    ].join('\n\n'),
  };
}
