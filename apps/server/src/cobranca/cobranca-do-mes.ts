import { dinheiro } from '../ai/registro/formatos.js';

// A cobrança do mês por e-mail, com o PIX (A7; `plano-a7.md` D-A7-17 e D-A7-44): quem escolheu o PIX recebe, quando a
// fatura do período seguinte já tem a cobrança no Asaas (ela nasce 5 dias antes do vencimento), um e-mail só texto com o
// valor, o vencimento e o código do PIX para copiar e colar no app do banco, e o link de Plano e cobrança, onde está o
// QR Code. Vai a quem paga (o Dono e o Administrador com a cobrança liberada), uma vez por fatura e pessoa.

/** O dia do aviso da cobrança do mês na tabela das entregas (`billing_notice.day`): antes do vencimento. */
export const DIA_DA_COBRANCA_DO_MES = 0;

const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const dia = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;

export interface DadosDaCobrancaDoMes {
  marca: string;
  plano: string;
  /** O período que a mensalidade paga começa nele (o mês do nome) e o vencimento. */
  periodoComeca: string;
  vencimento: string;
  valorCents: string;
  /** O código "copia e cola" do PIX da cobrança no Asaas. */
  copiaECola: string;
  /** O endereço de Plano e cobrança da marca (o QR Code e o pagamento pela tela). */
  link: string;
}

/** O e-mail da cobrança do mês (só texto), com o espaço comum depois do "R$" (V63). */
export function emailDaCobrancaDoMes(d: DadosDaCobrancaDoMes): { subject: string; text: string } {
  const mes = MESES[Number(d.periodoComeca.slice(5, 7)) - 1] ?? 'este mês';
  const valor = dinheiro((BigInt(d.valorCents) * 10_000n).toString())!;
  return {
    subject: `Liame: a mensalidade de ${mes} da ${d.marca} vence em ${dia(d.vencimento)}`,
    text: [
      `A mensalidade de ${mes} da ${d.marca} (plano ${d.plano}), de ${valor}, vence em ${dia(d.vencimento)}.`,
      '',
      'Para pagar, copie o código do PIX abaixo e cole no app do seu banco (PIX copia e cola):',
      '',
      d.copiaECola,
      '',
      `Ou abra o QR Code em Plano e cobrança: ${d.link}`,
      '',
      'O pagamento confirma em segundos. Se já pagou, desconsidere este e-mail.',
    ].join('\n'),
  };
}
