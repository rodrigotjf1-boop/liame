import type { BillingInvoice, BillingPlan, BillingResponse, BrandSubscription } from '@liame/contracts';
import { dataDe, diaMesDe, ehMembro, FICHAS, mesDe } from '@/components/equipe/textos';
import { reaisDeMicros } from '@/lib/formato';

// Plano e cobrança (A7 · W5, parte 2; protótipo P26, aprovado em 22/10/2026). Os textos da tela, tirados da resposta da
// API: cada frase diz só o que o servidor faz hoje (V39). Ficam de fora, até o código que as sustenta existir: o cartão
// (W2b), o Pix Automático, as notas fiscais (W4), o e-mail com o QR Code do mês, a faixa no alto das telas (W5, parte 4)
// e o que acontece com os dados depois da suspensão (W3, parte 4).

/** O momento da assinatura, como o P26 desenha a tela (D-A7-22: os dias contam da mensalidade mais antiga em aberto). */
export type Momento = 'desligada' | 'sem' | 'terminou' | 'aguardando' | 'em-dia' | 'primeira' | 'cancelada' | 'atraso-1' | 'atraso-10' | 'atraso-30';

export function momentoDa(r: BillingResponse): Momento {
  if (!r.enabled) return 'desligada';
  const s = r.subscription;
  if (!s) return 'sem';
  if (s.status === 'encerrada') return 'terminou';
  if (s.status === 'aguardando_pagamento') return 'aguardando';
  if (s.status === 'suspensa') return 'atraso-30';
  if (s.status === 'acoes_paradas') return 'atraso-10';
  if (s.status === 'em_atraso') return 'atraso-1';
  if (s.cancel_at_period_end) return 'cancelada';
  if (s.withdraw_until && s.withdraw_until >= r.today) return 'primeira';
  return 'em-dia';
}

export const emAtraso = (m: Momento) => m === 'atraso-1' || m === 'atraso-10' || m === 'atraso-30';

/** "R$ 249,00" de "24900" (centavos em texto, sem ponto flutuante). */
export function reaisDeCentavos(centavos: string): string {
  return reaisDeMicros(BigInt(centavos) * 10_000n);
}

/** O dia do calendário somado de `n` dias, "2026-11-22" + 9 = "2026-12-01" (sem fuso: a conta é de datas). */
export function somarDias(dia: string, n: number): string {
  const [a, m, d] = dia.split('-').map(Number);
  return new Date(Date.UTC(a!, m! - 1, d! + n)).toISOString().slice(0, 10);
}

/** "novembro de 2026" de "2026-11-22". */
export function mesEAno(dia: string): string {
  return `${mesDe(dia)} de ${dia.slice(0, 4)}`;
}

const maiuscula = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);

/** O nome do funcionário de IA pela chave de Sua equipe; a chave que a tela não conhece aparece como veio. */
export function nomeDoFuncionario(chave: string): string {
  return ehMembro(chave) ? FICHAS[chave].nome : chave;
}

/** Os funcionários do plano, pelos nomes de Sua equipe, na ordem do plano. */
export function funcionariosDo(plano: BillingPlan): string[] {
  return plano.agents.map(nomeDoFuncionario);
}

/** "por PIX", "no cartão" ou "pelo Pix Automático". */
export function formaDoPagamento(forma: string | null): string {
  if (forma === 'cartao') return 'no cartão';
  if (forma === 'pix_automatico') return 'pelo Pix Automático';
  return 'por PIX';
}

/** A mensalidade em aberto mais antiga (a do atraso, ou a primeira, ou a do período seguinte que já nasceu). */
export function emAberto(invoices: BillingInvoice[]): BillingInvoice | null {
  const abertas = invoices.filter((f) => f.status === 'aberta').sort((a, b) => a.due_date.localeCompare(b.due_date));
  return abertas.find((f) => f.kind === 'mensalidade') ?? abertas[0] ?? null;
}

/** A última mensalidade paga (a mais nova). */
export function ultimaPaga(invoices: BillingInvoice[]): BillingInvoice | null {
  return invoices.filter((f) => f.kind === 'mensalidade' && (f.status === 'paga' || f.status === 'devolvida')).sort((a, b) => b.due_date.localeCompare(a.due_date))[0] ?? null;
}

/** O dia do pagamento, no calendário de quem vê (o horário do Brasil para as empresas daqui). */
export function diaDoPagamento(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** O nome da fatura na lista: "Novembro de 2026" (a mensalidade) ou "Diferença para o Completo" (a troca de plano). */
export function nomeDaFatura(f: BillingInvoice): string {
  if (f.kind === 'diferenca') return `Diferença para o ${f.plan_name}`;
  return maiuscula(mesEAno(f.period_start ?? f.due_date));
}

export type Tom = 'concluido' | 'aguardando' | 'perigo' | 'espera' | 'info';

/** A linha da fatura: o detalhe, a situação e o tom do selo. */
export function linhaDaFatura(f: BillingInvoice, hoje: string): { detalhe: string; selo: string; tom: Tom } {
  if (f.status === 'paga' && f.refund_requested_at) return { detalhe: `Paga em ${diaDoPagamento(f.paid_at ?? f.refund_requested_at)}; a devolução foi pedida em ${diaDoPagamento(f.refund_requested_at)}`, selo: 'Devolvendo', tom: 'espera' };
  if (f.status === 'paga') return { detalhe: `Paga em ${f.paid_at ? diaDoPagamento(f.paid_at) : diaMesDe(f.due_date)}, ${formaDoPagamento(f.paid_method)}`, selo: 'Paga', tom: 'concluido' };
  if (f.status === 'devolvida') return { detalhe: 'Devolvida', selo: 'Devolvida', tom: 'espera' };
  if (f.status === 'cancelada') return { detalhe: 'Não foi cobrada', selo: 'Cancelada', tom: 'espera' };
  if (f.due_date < hoje) {
    const dias = diasEntre(f.due_date, hoje);
    return { detalhe: `Venceu em ${diaMesDe(f.due_date)}`, selo: 'Vencida', tom: dias >= 10 ? 'perigo' : 'aguardando' };
  }
  return { detalhe: f.due_date === hoje ? 'Vence hoje' : `Vence em ${diaMesDe(f.due_date)}`, selo: 'Em aberto', tom: 'info' };
}

/** Dias entre dois dias do calendário (`ate` − `de`). */
export function diasEntre(de: string, ate: string): number {
  const [a1, m1, d1] = de.split('-').map(Number);
  const [a2, m2, d2] = ate.split('-').map(Number);
  return Math.round((Date.UTC(a2!, m2! - 1, d2!) - Date.UTC(a1!, m1! - 1, d1!)) / 86_400_000);
}

/** Um degrau do atraso: o dia e o que acontece nele. */
export type Degrau = { dia: string; oQue: string; tom?: 'agora' | 'perigo' };

/** O que a situação diz (o P26, com os dados da API). */
export interface TextoDaSituacao {
  tom: '' | 'atencao' | 'perigo';
  selos: Array<{ texto: string; tom: Tom }>;
  titulo: string;
  frase: string;
  nota: string | null;
  degraus: Degrau[];
  /** A lista do que continua e do que para (10º dia). */
  continua: Array<{ sim: boolean; texto: string }>;
  /** Mostra o botão de pagar a fatura em aberto (para quem paga). */
  pagar: boolean;
  /** Mostra o botão de exportar os dados (o Dono com a conta suspensa). */
  exportar: boolean;
}

export const VOLTA = 'Pagou, tudo volta na hora. Nenhum dado se perde.';

/**
 * A situação da assinatura (o cartão do alto da tela, P26), para o momento dado. `aberta`: a fatura em aberto mais
 * antiga; `paga`: a última mensalidade paga; `souDono`: quem vê é o Dono (as frases de "você" e de "o Dono").
 */
export function situacao(m: Momento, r: BillingResponse, o: { aberta: BillingInvoice | null; paga: BillingInvoice | null; souDono: boolean }): TextoDaSituacao {
  const s = r.subscription as BrandSubscription;
  const base: TextoDaSituacao = { tom: '', selos: [], titulo: '', frase: '', nota: null, degraus: [], continua: [], pagar: false, exportar: false };
  const preco = s ? reaisDeCentavos(s.plan.price_cents) : '';
  const forma = s ? formaDoPagamento(s.method) : '';
  const valorAberto = o.aberta ? reaisDeCentavos(o.aberta.amount_cents) : preco;
  switch (m) {
    case 'aguardando':
      return {
        ...base,
        tom: 'atencao',
        selos: [{ texto: 'Esperando o primeiro pagamento', tom: 'aguardando' }],
        titulo: 'Falta pagar a primeira mensalidade',
        frase: `O plano ${s.plan.name} começa quando a primeira mensalidade, de ${valorAberto}, for paga.${s.first_payment_until ? ` Sem o pagamento até ${diaMesDe(s.first_payment_until)}, o pedido termina sozinho.` : ''}`,
        pagar: Boolean(o.aberta) && r.can_pay,
      };
    case 'em-dia': {
      const pagaTxt = o.paga ? ` · a mensalidade de ${mesDe(o.paga.period_start ?? o.paga.due_date)} foi paga em ${o.paga.paid_at ? diaDoPagamento(o.paga.paid_at) : diaMesDe(o.paga.due_date)}, ${formaDoPagamento(o.paga.paid_method)}` : '';
      const proxima = s.period_end ? `A próxima cobrança é de ${preco} em ${diaMesDe(s.period_end)}, ${forma}.` : `A próxima cobrança é de ${preco}, ${forma}.`;
      const jaAberta = o.aberta ? ` A fatura de ${mesDe(o.aberta.period_start ?? o.aberta.due_date)} já está aberta: dá para pagar agora.` : '';
      return {
        ...base,
        selos: [{ texto: 'Em dia', tom: 'concluido' }],
        titulo: 'A assinatura está em dia',
        frase: `${proxima}${jaAberta}`,
        nota: `Plano ${s.plan.name}${pagaTxt}.`,
        pagar: Boolean(o.aberta) && r.can_pay,
      };
    }
    case 'primeira': {
      const quando = o.paga?.paid_at ? diaDoPagamento(o.paga.paid_at) : null;
      const ate = diaMesDe(s.withdraw_until as string);
      return {
        ...base,
        selos: [
          { texto: 'Em dia', tom: 'concluido' },
          { texto: 'Primeira contratação', tom: 'info' },
        ],
        titulo: 'A assinatura começou',
        frase: `A primeira mensalidade, de ${preco}, foi paga${quando ? ` em ${quando}` : ''}, ${o.paga ? formaDoPagamento(o.paga.paid_method) : forma}.${s.period_end ? ` A próxima é em ${diaMesDe(s.period_end)}, ${forma}.` : ''}`,
        nota: o.souDono ? `Até ${ate}, você pode desistir e receber de volta os ${preco}, sem multa.` : `Até ${ate}, o Dono pode desistir e receber de volta os ${preco}.`,
      };
    }
    case 'cancelada':
      return {
        ...base,
        selos: [{ texto: 'Cancelada', tom: 'espera' }],
        titulo: s.period_end ? `A assinatura termina em ${diaMesDe(s.period_end)}` : 'A assinatura foi cancelada',
        frase: s.period_end ? `A assinatura foi cancelada. Até ${diaMesDe(s.period_end)}, tudo funciona como hoje, e a mensalidade seguinte não é cobrada.` : 'A assinatura foi cancelada, e a mensalidade seguinte não é cobrada.',
        nota: o.souDono ? null : 'Só o Dono pode manter a assinatura.',
      };
    case 'atraso-1': {
      const od = s.overdue;
      const venc = od?.due_date ?? o.aberta?.due_date ?? r.today;
      const mes = mesDe(venc);
      const dias = od?.days ?? diasEntre(venc, r.today);
      const pagueAte = od ? somarDias(od.actions_stop_on, -1) : null;
      return {
        ...base,
        tom: 'atencao',
        selos: [{ texto: dias === 1 ? 'Em atraso há 1 dia' : `Em atraso há ${dias} dias`, tom: 'aguardando' }],
        titulo: `A mensalidade de ${mes} não foi paga`,
        frase: `Ela venceu em ${diaMesDe(venc)} (${valorAberto}).${pagueAte ? ` Pague até ${diaMesDe(pagueAte)} para os funcionários de IA continuarem trabalhando.` : ''}`,
        degraus: od
          ? [
              { dia: od.actions_stop_on, oQue: 'os funcionários de IA param', tom: 'agora' },
              { dia: od.suspends_on, oQue: 'a conta é suspensa: só o Dono entra' },
            ]
          : [],
        nota: VOLTA,
        pagar: r.can_pay && Boolean(o.aberta),
      };
    }
    case 'atraso-10': {
      const od = s.overdue;
      const venc = od?.due_date ?? o.aberta?.due_date ?? r.today;
      return {
        ...base,
        tom: 'perigo',
        selos: [{ texto: 'Ações paradas', tom: 'perigo' }],
        titulo: 'Os funcionários de IA estão parados',
        frase: `${od ? `Desde ${diaMesDe(od.actions_stop_on)}, por` : 'Por'} causa da mensalidade de ${mesDe(venc)} (${valorAberto}), que venceu em ${diaMesDe(venc)}.`,
        continua: [
          { sim: true, texto: 'Você e a equipe continuam entrando e vendo tudo.' },
          { sim: true, texto: 'Os anúncios seguem como estão: o Liame não pausa nenhum.' },
          { sim: false, texto: 'Os funcionários não fazem nada novo: nem propostas, nem posts, nem mensagens.' },
        ],
        degraus: od ? [{ dia: od.suspends_on, oQue: 'a conta é suspensa: só o Dono entra, para pagar ou exportar os dados', tom: 'perigo' }] : [],
        nota: VOLTA,
        pagar: r.can_pay && Boolean(o.aberta),
      };
    }
    case 'atraso-30': {
      const od = s.overdue;
      const venc = od?.due_date ?? o.aberta?.due_date ?? r.today;
      return {
        ...base,
        tom: 'perigo',
        selos: [{ texto: 'Conta suspensa', tom: 'perigo' }],
        titulo: 'A conta está suspensa',
        frase: `${od ? `Desde ${diaMesDe(od.suspends_on)}, só` : 'Só'} você entra, para pagar ou exportar os dados. A mensalidade em aberto é a de ${mesDe(venc)} (${valorAberto}).`,
        nota: 'Pagou, tudo volta na hora: a equipe entra de novo, e os funcionários voltam a trabalhar.',
        pagar: r.can_pay && Boolean(o.aberta),
        exportar: o.souDono,
      };
    }
    default:
      return base;
  }
}

/** O que diz a assinatura que terminou, pelo motivo (D-A7-19, D-A7-25). */
export function textoDoFim(s: BrandSubscription, invoices: BillingInvoice[]): string {
  const quando = s.ended_at ? diaDoPagamento(s.ended_at) : null;
  const em = quando ? ` em ${quando}` : '';
  if (s.end_reason === 'desistencia') {
    const devolvida = invoices.find((f) => f.status === 'devolvida' || f.refund_requested_at);
    const valor = devolvida ? reaisDeCentavos(devolvida.amount_cents) : reaisDeCentavos(s.plan.price_cents);
    const para = devolvida?.paid_method === 'cartao' ? 'pelo estorno no cartão' : 'para a conta que pagou o PIX';
    return devolvida?.status === 'devolvida' ? `A assinatura terminou${em}, na desistência. Os ${valor} voltaram ${para}.` : `A assinatura terminou${em}, na desistência. Os ${valor} estão voltando ${para}.`;
  }
  if (s.end_reason === 'nao_paga') return `O pedido de assinatura terminou${em}: a primeira mensalidade não foi paga em 7 dias.`;
  if (s.end_reason === 'cancelada') return `A assinatura terminou${em}, depois do cancelamento.`;
  return `A assinatura terminou${em}.`;
}

/** Uma linha do "Se a mensalidade atrasar" (P26), com o dia quando há atraso. */
export type Fase = { quando: string; dia: string | null; oQue: string; agora: boolean };

export function fases(m: Momento, s: BrandSubscription | null): Fase[] {
  const od = s?.overdue ?? null;
  const agora = m === 'atraso-1' ? 1 : m === 'atraso-10' ? 2 : m === 'atraso-30' ? 3 : -1;
  const linhas: Array<[string, string | null, string]> = [
    ['No vencimento', od?.due_date ?? null, 'A fatura vence. No PIX, ela aparece aqui cinco dias antes, com o QR Code.'],
    ['1º dia de atraso', od ? somarDias(od.due_date, 1) : null, 'Quem paga recebe um aviso por e-mail.'],
    ['10º dia', od?.actions_stop_on ?? null, 'Os funcionários de IA param. Ver e ler continuam, e nenhum anúncio é pausado pelo Liame.'],
    ['30º dia', od?.suspends_on ?? null, 'A conta é suspensa: só o Dono entra, para pagar ou exportar os dados.'],
  ];
  return linhas.map(([quando, dia, oQue], i) => ({ quando, dia, oQue, agora: i === agora }));
}

export { dataDe, diaMesDe };
