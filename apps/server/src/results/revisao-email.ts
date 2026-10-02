import type { ExplanationSegment, WeeklyReview, WeeklyReviewChange } from '@liame/contracts';
import { dia, dinheiro, inteiro, razao } from '../ai/registro/formatos.js';
import { plataforma } from '../ai/registro/leituras.visoes.js';

// O e-mail da revisão da semana (A3, I7): os mesmos números da tela, em texto simples, como os outros
// e-mails do Liame. Nenhum número é calculado aqui: tudo vem da revisão guardada. Sem dado pessoal além do
// nome de quem recebe o próprio e-mail.

/** Quem recebe a revisão por e-mail (D-A3-7). */
export const NIVEIS_QUE_RECEBEM = ['dono', 'administrador', 'so_relatorios'] as const;
const NIVEL: Record<string, string> = { dono: 'Dono', administrador: 'Administrador', so_relatorios: 'Só relatórios por e-mail' };
const VEREDITO: Record<string, string> = { lucro: 'dá lucro', empata: 'empata', prejuizo: 'dá prejuízo' };
const RISCO: Record<string, string> = { baixo: 'Risco baixo', medio: 'Risco médio', alto: 'Risco alto' };
const SUPORTE = 'suporte@agencialiame.com';

/** O conteúdo guardado de uma revisão: o contrato sem o que vem das colunas (o id e o envio). */
export type ConteudoDaRevisao = Omit<WeeklyReview, 'id' | 'email'>;

const curto = (d: string) => (dia(d) ?? d).slice(0, 5);
const texto = (trechos: ExplanationSegment[]) => trechos.map((t) => t.text).join('');
/** "+12.8" → "+12,8%". */
const pct = (v: string | null) => (v === null ? null : `${v.replace('.', ',')}%`);

function valor(m: WeeklyReviewChange, qual: 'before' | 'now', moeda: string): string {
  const v = m[qual];
  if (v === null) return 'sem número';
  return m.unit === 'dinheiro' ? (dinheiro(v, moeda) ?? v) : m.unit === 'razao' ? (razao(v) ?? v) : (inteiro(v) ?? v);
}

const ROTULO: Record<string, string> = {
  investimento: 'Investido em anúncios',
  pedidos_de_anuncios: 'Pedidos de anúncios',
  receita_confirmada: 'Receita confirmada no caixa',
  roas_confirmado: 'ROAS confirmado no caixa',
  pedidos_sem_origem: 'Pedidos sem origem',
};

/** "Pedidos de anúncios: de 47 para 53 (+12,8%)" / "Combo sexta: ROAS no caixa de 4,02 para 4,25". */
export function linhaDaMudanca(m: WeeklyReviewChange, moeda: string): string {
  const nome = m.campaign ? `${m.campaign.name}: ROAS no caixa` : (ROTULO[m.kind] ?? m.kind);
  const variacao = m.unit === 'razao' ? null : pct(m.change_pct);
  return `${nome}${m.campaign ? '' : ':'} de ${valor(m, 'before', moeda)} para ${valor(m, 'now', moeda)}${variacao ? ` (${variacao})` : ''}`;
}

/** A linha de um dos quatro números do topo: "Pedidos de anúncios: 53 (+12,8%; eram 47)". */
function linhaDoTotal(m: WeeklyReviewChange, moeda: string): string {
  const agora = valor(m, 'now', moeda);
  if (m.before === null) return `${ROTULO[m.kind] ?? m.kind}: ${agora}`;
  const era = `${m.unit === 'contagem' && m.before !== '1' ? 'eram' : 'era'} ${valor(m, 'before', moeda)}`;
  const variacao = m.unit === 'razao' ? null : pct(m.change_pct);
  return `${ROTULO[m.kind] ?? m.kind}: ${agora} (${variacao ? `${variacao}; ` : ''}${era})`;
}

export interface EmailDaRevisao {
  subject: string;
  text: string;
}

/**
 * O e-mail de uma pessoa: assunto e texto. `link` leva à revisão na tela; `nivel` é o papel dela na empresa
 * (diz por que ela recebe).
 */
export function emailDaRevisao(r: ConteudoDaRevisao, quem: { marca: string; empresa: string; nivel: string; link: string }): EmailDaRevisao {
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
  if (r.reading.reason === 'dado_velho' && r.reading.stale_sources.length) {
    const fontes = r.reading.stale_sources.map((f) => `${f.platform ? `${f.platform} · ` : ''}${f.name}${f.last_read ? `, última leitura em ${f.last_read}` : ', ainda não lida'}`);
    linhas.push(`Na hora de gerar, uma fonte estava atrasada (${fontes.join('; ')}). Os números valem até essa hora.`, '');
  }
  const e = r.reading.explanation;
  linhas.push(texto(e.what_happened));
  if (e.reasons.length) linhas.push('', 'Motivos:', ...e.reasons.map((m) => `- ${texto(m)}`));
  linhas.push('', `${RISCO[e.risk] ?? 'Risco médio'}: ${texto(e.risk_reason)}`);
  if (e.what_to_do.length) linhas.push('', 'O que fazer:', ...e.what_to_do.map((m) => `- ${texto(m)}`));
  if (daLia) linhas.push('', 'A LIA é uma assistente de IA: ela só escreve. Os números são do sistema, conferidos antes de aparecer, e a decisão é sua.');

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
    linhas.push('O Liame aponta; quem decide é você. Nada muda nas campanhas por aqui.');
  }

  linhas.push('', `Ver a revisão completa: ${quem.link}`);
  linhas.push(
    '',
    `Você recebe este e-mail porque tem acesso à ${quem.empresa} no Liame como ${NIVEL[quem.nivel] ?? quem.nivel}. Para deixar de receber, escreva para ${SUPORTE}.`,
    'Liame · um produto DMS Tecnologias',
  );
  return { subject: `Liame: revisão da semana da ${quem.marca} (${curto(r.week.from)} a ${curto(r.week.to)})`, text: linhas.join('\n') };
}
