import type { WeeklyReviewChange } from '@liame/contracts';
import { dia, dinheiro, inteiro, razao } from '../ai/registro/formatos.js';
import { plataforma } from '../ai/registro/leituras.visoes.js';
import { htmlDaRevisao, type ImagensDoEmail } from './revisao-email-html.js';
import {
  ASSINATURA,
  AVISO_DA_DECISAO,
  AVISO_DA_LIA,
  type ConteudoDaRevisao,
  curto,
  eraDe,
  fonteAtrasada,
  linhaDaMudanca,
  porQueRecebe,
  type QuemRecebe,
  RISCO,
  ROTULO,
  texto,
  valor,
  variacaoDe,
  VEREDITO,
} from './revisao-email-partes.js';

// O e-mail da revisão da semana (A3, I7): os mesmos números da tela, em duas versões da mesma mensagem. A de
// texto simples é a de sempre; a de HTML (aprovada pelo dono em 04/10/2026) leva a marca, os quatro números em
// destaque e as barras do que cada campanha investiu e trouxe no caixa. Nenhum número é calculado aqui: tudo
// vem da revisão guardada. Sem dado pessoal além do nome de quem recebe o próprio e-mail.

/** Quem recebe a revisão por e-mail (D-A3-7). */
export const NIVEIS_QUE_RECEBEM = ['dono', 'administrador', 'so_relatorios'] as const;

export { type ConteudoDaRevisao, linhaDaMudanca } from './revisao-email-partes.js';
export type { ImagensDoEmail } from './revisao-email-html.js';

/** A linha de um dos quatro números do topo: "Pedidos de anúncios: 53 (+12,8%; eram 47)". */
function linhaDoTotal(m: WeeklyReviewChange, moeda: string): string {
  const agora = valor(m, 'now', moeda);
  const era = eraDe(m, moeda);
  if (era === null) return `${ROTULO[m.kind] ?? m.kind}: ${agora}`;
  const variacao = variacaoDe(m);
  return `${ROTULO[m.kind] ?? m.kind}: ${agora} (${variacao ? `${variacao}; ` : ''}${era})`;
}

export interface EmailDaRevisao {
  subject: string;
  text: string;
  /** A mesma mensagem com a marca, os números em destaque e as barras por campanha. */
  html: string;
}

/**
 * O e-mail de uma pessoa: assunto, texto e HTML. `link` leva à revisão na tela; `nivel` é o papel dela na
 * empresa (diz por que ela recebe); `imagens` são os endereços da marca e do rosto da LIA no próprio Liame.
 */
export function emailDaRevisao(r: ConteudoDaRevisao, quem: QuemRecebe & { imagens: ImagensDoEmail }): EmailDaRevisao {
  const moeda = r.currency;
  const linhas: string[] = [];
  const secao = (titulo: string) => linhas.push('', titulo.toUpperCase());

  linhas.push(`Revisão da semana da ${quem.marca}`);
  // Sem nada na semana anterior não houve comparação: o e-mail não diz que houve.
  const comparada = r.totals.some((m) => m.before !== null);
  linhas.push(`De ${dia(r.week.from)} a ${dia(r.week.to)}${comparada ? `, comparada com ${dia(r.previous_week.from)} a ${dia(r.previous_week.to)}` : ''}.`);

  secao('Os números da semana');
  for (const m of r.totals) linhas.push(linhaDoTotal(m, moeda));

  const daLia = r.reading.source === 'lia';
  secao(daLia ? 'Leitura da semana, pela LIA (feito com IA)' : 'Leitura da semana, pelo sistema (sem IA)');
  const atrasada = fonteAtrasada(r);
  if (atrasada) linhas.push(atrasada, '');
  const e = r.reading.explanation;
  linhas.push(texto(e.what_happened));
  if (e.reasons.length) linhas.push('', 'Motivos:', ...e.reasons.map((m) => `- ${texto(m)}`));
  linhas.push('', `${RISCO[e.risk] ?? 'Risco médio'}: ${texto(e.risk_reason)}`);
  if (e.what_to_do.length) linhas.push('', 'O que fazer:', ...e.what_to_do.map((m) => `- ${texto(m)}`));
  if (daLia) linhas.push('', AVISO_DA_LIA);

  if (r.campaigns.length || r.platform_only.length) {
    secao('O que cada campanha trouxe no caixa');
    for (const c of r.campaigns) {
      const resultado = c.verdict ? ` · ${VEREDITO[c.verdict] ?? c.verdict}` : '';
      const roas = c.roas ? `, ROAS ${razao(c.roas)}` : '';
      linhas.push(`- ${c.name} (${plataforma(c.provider)}): ${dinheiro(c.spend_micros, moeda)} investidos, ${inteiro(c.orders)} pedido(s), ${dinheiro(c.revenue_micros, moeda)} de receita${roas}${resultado}`);
    }
    for (const p of r.platform_only) {
      linhas.push(`- ${plataforma(p.provider)}, sem campanha identificada: ${inteiro(p.orders)} pedido(s)${p.revenue_micros ? `, ${dinheiro(p.revenue_micros, moeda)}` : ''} (conta no total)`);
    }
  }

  if (r.improved.length) {
    secao('O que melhorou');
    linhas.push(...r.improved.map((m) => `- ${linhaDaMudanca(m, moeda)}`));
  }
  if (r.worsened.length) {
    secao('O que piorou');
    linhas.push(...r.worsened.map((m) => `- ${linhaDaMudanca(m, moeda)}`));
  }
  if (r.decisions.length) {
    secao('Precisa de decisão');
    linhas.push(...r.decisions.map((d) => `- ${d.title}. ${d.detail}`));
    linhas.push(AVISO_DA_DECISAO);
  }

  linhas.push('', `Ver a revisão completa: ${quem.link}`);
  linhas.push('', porQueRecebe(quem), ASSINATURA);
  const subject = `Liame: revisão da semana da ${quem.marca} (${curto(r.week.from)} a ${curto(r.week.to)})`;
  return { subject, text: linhas.join('\n'), html: htmlDaRevisao(r, quem, quem.imagens, subject) };
}
