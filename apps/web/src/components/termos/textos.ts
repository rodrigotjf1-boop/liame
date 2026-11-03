import type { TermsDocument, TermsVersionInfo } from '@liame/contracts';

// As frases dos Termos novos (A7, W14, parte 14d; P35 aprovado pelo dono em 02/11/2026; D-A7-90 a D-A7-93): a faixa no
// alto das telas, a gaveta "O que muda" e a tela do aceite no dia. Funções puras, testadas em `test/termos.spec.ts`.

export const NOME_DO_DOCUMENTO: Record<TermsDocument, string> = {
  termos: 'Termos de Uso',
  privacidade: 'Política de Privacidade',
  operador: 'Contrato de Tratamento de Dados',
};

/** Nos últimos 7 dias antes do dia, a faixa fica âmbar e conta os dias (D-A7-90). */
export const DIAS_DA_FAIXA_AMBAR = 7;

/** AAAA-MM-DD → DD/MM/AAAA. */
export const dataBr = (dia: string): string => `${dia.slice(8, 10)}/${dia.slice(5, 7)}/${dia.slice(0, 4)}`;

/** Hoje (AAAA-MM-DD) no fuso de Brasília, o mesmo do dia em que a versão vale. */
export function hojeEmBrasilia(agora: Date = new Date()): string {
  const partes = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(agora);
  const v = (t: string) => partes.find((p) => p.type === t)?.value ?? '';
  return `${v('year')}-${v('month')}-${v('day')}`;
}

/** Quantos dias do calendário de `hoje` até `dia` (os dois AAAA-MM-DD). */
export function diasAte(dia: string, hoje: string): number {
  return Math.round((Date.parse(`${dia}T12:00:00Z`) - Date.parse(`${hoje}T12:00:00Z`)) / 86_400_000);
}

/** A véspera do dia, em DD/MM/AAAA: até quando o Dono cancela sem multa (Termos 15). */
export function vespera(dia: string): string {
  const d = new Date(`${dia}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return dataBr(d.toISOString().slice(0, 10));
}

const mudancas = (n: number) => (n === 1 ? '1 mudança' : `${n} mudanças`);

/** A faixa no alto das telas, durante o aviso, até a pessoa aceitar (D-A7-90). */
export function faixaDosTermos(v: TermsVersionInfo, hoje: string): { tipo: 'acao' | 'atencao'; titulo: string; texto: string } {
  const faltam = diasAte(v.effective_on, hoje);
  if (faltam <= DIAS_DA_FAIXA_AMBAR) {
    return {
      tipo: 'atencao',
      titulo: faltam <= 1 ? 'Falta 1 dia para os Termos novos' : `Faltam ${faltam} dias para os Termos novos`,
      texto: `Em ${dataBr(v.effective_on)}, quem não aceitou vê só a tela do aceite até aceitar. São ${mudancas(v.changes.length)}.`,
    };
  }
  return {
    tipo: 'acao',
    titulo: `Os Termos de Uso e a Política de Privacidade mudam em ${dataBr(v.effective_on)}`,
    texto: `São ${mudancas(v.changes.length)}. Até lá, valem os de hoje.`,
  };
}

/** O dia, na gaveta: antes, a partir de quando vale; no dia, desde quando. */
export function quandoVale(v: TermsVersionInfo, noDia: boolean): string {
  return noDia ? `Valem desde ${dataBr(v.effective_on)}.` : `Valem a partir de ${dataBr(v.effective_on)}. Até lá, valem os de hoje.`;
}

/** A frase do que se aceita, junto do botão (D-A7-92). */
export function fraseDoAceite(v: TermsVersionInfo, noDia: boolean): string {
  return `Ao aceitar, você concorda com os Termos de Uso e a Política de Privacidade que valem ${noDia ? 'desde' : 'a partir de'} ${dataBr(v.effective_on)}.`;
}

/** Para quem não concorda (D-A7-91): o Dono cancela sem multa; os outros falam com o Dono. */
export function naoConcorda(v: TermsVersionInfo, dono: boolean, noDia: boolean): string {
  if (!dono) return 'Não concorda? Fale com o Dono da empresa: só ele cancela a assinatura.';
  return noDia
    ? 'Não concorda? Você pode cancelar a assinatura em Plano e cobrança, sem multa; vale no fim do período pago, e os dados ficam para exportar.'
    : `Não concorda? Você pode cancelar sem multa até ${vespera(v.effective_on)}, em Plano e cobrança (Termos 15). Até lá, a empresa segue com os Termos de hoje.`;
}

/** O título da tela do aceite, no dia (D-A7-93). */
export const tituloDaTelaDoDia = (v: TermsVersionInfo): string => `Os Termos novos valem desde ${dataBr(v.effective_on)}`;

/** No dia, o Dono em Plano e cobrança (a única tela que abre sem o aceite): a faixa diz o que dá para fazer ali. */
export function faixaDoDiaNaCobranca(v: TermsVersionInfo): { titulo: string; texto: string } {
  return {
    titulo: tituloDaTelaDoDia(v),
    texto: 'Para voltar às outras telas, aceite. Aqui você pode cancelar a assinatura, sem multa, e exportar os dados.',
  };
}

/** A seção de cada mudança: "Termos de Uso · 4". */
export const secaoDaMudanca = (m: TermsVersionInfo['changes'][number]): string => `${NOME_DO_DOCUMENTO[m.document]} · ${m.section}`;
