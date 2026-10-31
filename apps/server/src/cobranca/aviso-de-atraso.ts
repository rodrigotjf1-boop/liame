import { dinheiro } from '../ai/registro/formatos.js';
import { DIA_DA_SUSPENSAO, DIA_DAS_ACOES_PARADAS, diasEntre, passosDoAtraso, somarDias } from './vida.js';

// O aviso do atraso por e-mail (A7, W3, parte 2; `plano-a7.md` D-A7-6, D-A7-15 e D-A7-39; Termos 10.4), em funções
// puras: em que dia de atraso cada aviso vai e o texto de cada um, com as frases do protótipo P26 (a faixa do atraso).
// Vai a quem paga (o Dono e o Administrador com a cobrança liberada), nunca ao resto da equipe.

/** Os dias de atraso em que o aviso vai (D-A7-15): o 1º, o 7º, o 10º (as ações param) e o 30º (a conta é suspensa). */
export const DIAS_DO_AVISO = [1, 7, DIA_DAS_ACOES_PARADAS, DIA_DA_SUSPENSAO] as const;
export type DiaDoAviso = (typeof DIAS_DO_AVISO)[number];

/** Quantas vezes o envio a uma pessoa é tentado antes de desistir (a falha fica gravada, sem o endereço). */
export const TENTATIVAS_DO_AVISO = 3;

/**
 * O aviso que vale para tantos dias de atraso: o do maior dia já alcançado (com o worker parado no 7º, o do 7º vai no
 * 8º; os anteriores que passaram não vão mais). Antes do 1º dia, nenhum.
 */
export function avisoDoDia(diasDeAtraso: number): DiaDoAviso | null {
  let aviso: DiaDoAviso | null = null;
  for (const d of DIAS_DO_AVISO) if (diasDeAtraso >= d) aviso = d;
  return aviso;
}

const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const dia = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;

export interface DadosDoAviso {
  aviso: DiaDoAviso;
  /** O nome da marca da assinatura (a mensalidade é por marca). */
  marca: string;
  /** O vencimento da mensalidade mais antiga em aberto (AAAA-MM-DD, no calendário da empresa). */
  vencimento: string;
  /** O valor dela, em centavos. */
  valorCents: string;
  /** O endereço da tela Plano e cobrança da marca, onde se paga. */
  link: string;
}

/**
 * O e-mail do aviso, só texto, em português. O assunto diz o que aconteceu; o corpo diz o que vem depois, com as
 * datas, e onde pagar. Os anúncios não são pausados pelo Liame (D-A7-6), e pagou, tudo volta na hora.
 */
export function emailDoAviso(d: DadosDoAviso): { subject: string; text: string } {
  const { acoesParamEm, suspendeEm } = passosDoAtraso(d.vencimento);
  const pagueAte = somarDias(acoesParamEm, -1);
  const mes = MESES[Number(d.vencimento.slice(5, 7)) - 1] ?? 'do mês';
  const valor = dinheiro((BigInt(d.valorCents) * 10_000n).toString())!;
  const daMensalidade = `a mensalidade de ${mes} da marca ${d.marca} (${valor}), que venceu em ${dia(d.vencimento)}`;
  const pagar = `Para pagar, abra Plano e cobrança no Liame: ${d.link}`;
  const jaPagou = 'Se você já pagou, pode desconsiderar este e-mail: a confirmação do PIX leva alguns minutos.';
  const volta = 'Pagou, tudo volta na hora.';
  switch (d.aviso) {
    case 1:
    case 7: {
      const faltam = diasEntre(somarDias(d.vencimento, d.aviso), acoesParamEm);
      return {
        subject: d.aviso === 1 ? `Liame: a mensalidade de ${d.marca} venceu em ${dia(d.vencimento)}` : `Liame: faltam ${faltam} dias para os funcionários de IA de ${d.marca} pararem`,
        text: [
          `Ainda não recebemos ${daMensalidade}.`,
          `Pague até ${dia(pagueAte)} para os funcionários de IA continuarem trabalhando. Em ${dia(acoesParamEm)}, eles param; em ${dia(suspendeEm)}, a conta é suspensa, e só o Dono entra, para pagar ou exportar os dados.`,
          pagar,
          jaPagou,
        ].join('\n\n'),
      };
    }
    case DIA_DAS_ACOES_PARADAS:
      return {
        subject: `Liame: os funcionários de IA de ${d.marca} estão parados`,
        text: [
          `Desde ${dia(acoesParamEm)}, os funcionários de IA de ${d.marca} não fazem nada novo, por causa d${daMensalidade}.`,
          'Você e a equipe continuam entrando e vendo tudo, e os anúncios seguem como estão: o Liame não pausa nenhum.',
          `Em ${dia(suspendeEm)}, a conta é suspensa, e só o Dono entra, para pagar ou exportar os dados. ${volta}`,
          pagar,
        ].join('\n\n'),
      };
    case DIA_DA_SUSPENSAO:
      return {
        subject: `Liame: a conta de ${d.marca} está suspensa`,
        text: [
          `Desde ${dia(suspendeEm)}, só o Dono entra, para pagar ou exportar os dados. O que está em aberto é ${daMensalidade}.`,
          `${volta} A equipe entra de novo, e os funcionários de IA voltam a trabalhar.`,
          pagar,
        ].join('\n\n'),
      };
  }
}
