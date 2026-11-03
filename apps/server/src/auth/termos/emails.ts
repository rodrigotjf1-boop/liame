import type { TermsChange, TermsDocument } from '@liame/contracts';

// Os e-mails dos Termos novos (A7, W14, parte 14c; D-A7-90; D-A7-103), em funções puras, com as frases do protótipo P35
// aprovado pelo dono em 02/11/2026: o aviso (no dia da versão nova), o lembrete (7 dias antes, só para quem não aceitou)
// e a retirada (para quem tinha recebido o aviso). Só texto, como os outros avisos do Liame.

/** Quantos dias antes do dia sai o lembrete. */
export const DIAS_DO_LEMBRETE = 7;

const NOME_DO_DOCUMENTO: Record<TermsDocument, string> = {
  termos: 'Termos de Uso',
  privacidade: 'Política de Privacidade',
  operador: 'Contrato de Tratamento de Dados',
};

/** AAAA-MM-DD → DD/MM/AAAA. */
const data = (dia: string) => `${dia.slice(8, 10)}/${dia.slice(5, 7)}/${dia.slice(0, 4)}`;

/** A véspera do dia (AAAA-MM-DD), em DD/MM/AAAA: até quando dá para cancelar sem multa (Termos 15). */
function vespera(dia: string): string {
  const d = new Date(`${dia}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return data(d.toISOString().slice(0, 10));
}

export interface DadosDoEmail {
  /** O primeiro nome de quem recebe. */
  nome: string;
  /** Quem recebe é Dono de alguma empresa: só ele cancela a assinatura. */
  dono: boolean;
  /** O dia em que a versão vale (AAAA-MM-DD, em Brasília). */
  valeEm: string;
  /** O dia do aviso (AAAA-MM-DD, em Brasília), para o e-mail da retirada. */
  avisoEm: string;
  /** Quantos dias faltam (o lembrete). */
  diasQueFaltam: number;
  mudancas: readonly TermsChange[];
  /** O endereço do Liame. */
  link: string;
}

const RODAPE = 'Você recebe este e-mail porque tem acesso ao Liame. Dúvidas: suporte@agencialiame.com.';

function naoConcorda(d: DadosDoEmail): string {
  return d.dono
    ? `Não concorda? Você pode cancelar a assinatura sem multa até ${vespera(d.valeEm)}, em Plano e cobrança.`
    : 'Não concorda? Fale com o Dono da empresa: só ele cancela a assinatura.';
}

/** O aviso, no dia da versão nova (D-A7-90). */
export function emailDoAviso(d: DadosDoEmail): { subject: string; text: string } {
  const linhas = d.mudancas.map((m) => `- ${m.title} (${NOME_DO_DOCUMENTO[m.document]} · ${m.section}): ${m.becomes}`);
  return {
    subject: `Os Termos do Liame mudam em ${data(d.valeEm)}`,
    text: [
      `Olá, ${d.nome}.`,
      `Os Termos de Uso e a Política de Privacidade do Liame mudam em ${data(d.valeEm)}. Até lá, valem os de hoje.`,
      ['O que muda:', ...linhas].join('\n'),
      'Nada muda para trás: o que já foi feito segue as regras de quando foi feito.',
      `Para ler os detalhes e aceitar, entre no Liame: a faixa no alto das telas leva ao que muda. Os textos inteiros estão no site do Liame.\n${d.link}`,
      naoConcorda(d),
      `Em ${data(d.valeEm)}, quem ainda não tiver aceitado vê a tela do aceite ao entrar, antes das outras.`,
      RODAPE,
    ].join('\n\n'),
  };
}

/** O lembrete, 7 dias antes do dia, só para quem ainda não aceitou (D-A7-90). */
export function emailDoLembrete(d: DadosDoEmail): { subject: string; text: string } {
  const faltam = d.diasQueFaltam <= 1 ? 'Falta 1 dia' : `Faltam ${d.diasQueFaltam} dias`;
  return {
    subject: `${faltam} para os Termos novos do Liame`,
    text: [
      `Olá, ${d.nome}.`,
      `Os Termos de Uso e a Política de Privacidade novos valem em ${data(d.valeEm)}, e você ainda não aceitou. Leva uns 2 minutos: entre no Liame e use a faixa no alto da tela.\n${d.link}`,
      'Se não aceitar até lá, você verá a tela do aceite ao entrar, antes das outras. A equipe de IA da empresa segue trabalhando.',
      naoConcorda(d),
      RODAPE,
    ].join('\n\n'),
  };
}

/** A retirada, para quem tinha recebido o aviso (D-A7-88). */
export function emailDaRetirada(d: DadosDoEmail): { subject: string; text: string } {
  return {
    subject: 'A mudança dos Termos do Liame foi cancelada',
    text: [
      `Olá, ${d.nome}.`,
      `A mudança dos Termos de Uso e da Política de Privacidade que avisamos em ${data(d.avisoEm)} não vai acontecer. Os Termos de hoje continuam valendo, e você não precisa fazer nada.`,
      'Se você já tinha aceitado a versão nova, esse aceite fica sem efeito. Quando houver outra mudança, avisamos de novo, com 30 dias.',
      RODAPE,
    ].join('\n\n'),
  };
}
