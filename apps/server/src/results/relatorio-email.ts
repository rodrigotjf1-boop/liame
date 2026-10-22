import type { MonthlyReportTeam, WeeklyReviewChange } from '@liame/contracts';
import { dia, dinheiro, inteiro, razao } from '../ai/registro/formatos.js';
import { comDe, plataforma } from '../ai/registro/leituras.visoes.js';
import { diaDaSemana } from './fora-do-normal.js';
import { type ConteudoDoRelatorio, mesAnterior, mesCurto, type VerbaDoMesGuardada } from './relatorio-mensal.js';
import { escaparHtml, htmlDoEmail, type ImagensDoEmail, secaoDeParagrafos } from './revisao-email-html.js';
import { ASSINATURA, AVISO_DA_LIA, eraDe, fonteAtrasada, porQueRecebe, type QuemRecebe, RISCO, ROTULO, texto, valor, variacaoDe, VEREDITO } from './revisao-email-partes.js';

// O e-mail do relatório do mês (A3, I7; protótipo P24, texto aprovado pelo dono em 21/10/2026, D-A3-20), no desenho do
// e-mail da revisão da semana (aprovado em 04/10/2026): a marca, os quatro números contra o mês anterior, a leitura do
// mês, as barras do que cada campanha investiu e trouxe no caixa, a verba e a equipe numa parte só (D-A3-22) e o botão
// para a tela. Os números são os do relatório guardado; a única conta é a do custo de IA em reais, pela cotação
// guardada com ele (D-A3-14). Sem dado pessoal além do nome de quem recebe o próprio e-mail.

export interface EmailDoRelatorio {
  subject: string;
  text: string;
  html: string;
}

/** "no domingo, 01/11, às 05:10" / "na quinta-feira, 01/10, às 05:10": o sábado e o domingo pedem "no". */
export function quandoFoiGerado(geradoEm: string, fuso: string): string {
  const diaLocal = new Intl.DateTimeFormat('en-CA', { timeZone: fuso, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(geradoEm));
  const semana = diaDaSemana(diaLocal);
  const hora = new Date(geradoEm).toLocaleTimeString('pt-BR', { timeZone: fuso, hour: '2-digit', minute: '2-digit' });
  const artigo = semana === 'sábado' || semana === 'domingo' ? 'no' : 'na';
  return `${artigo} ${semana}, ${diaLocal.slice(8, 10)}/${diaLocal.slice(5, 7)}, às ${hora}`;
}

/** O custo de IA do mês em reais, pela cotação guardada com o relatório; sem cotação, em dólar. */
export function custoDeIaNoMes(t: MonthlyReportTeam): string {
  const usd = BigInt(t.ai.spent_usd_micros);
  if (!t.usd_brl) return dinheiro(usd.toString(), 'US$') ?? 'US$ 0,00';
  const reais = BigInt(Math.round(Number(usd) * Number(t.usd_brl.rate)));
  return dinheiro(reais.toString(), 'BRL') ?? 'R$ 0,00';
}

/** A parte "A verba e a equipe" (P24): o gasto contra o teto, as mudanças nas campanhas e o custo de IA do mês. */
export function verbaEEquipe(verba: VerbaDoMesGuardada | undefined, equipe: MonthlyReportTeam | undefined): string[] {
  const linhas: string[] = [];
  if (verba) {
    const gasto = dinheiro(verba.spend_micros, verba.currency);
    linhas.push(verba.limit_micros === null ? `${gasto} gastos no mês; a empresa não tem teto do mês.` : `${gasto} gastos de ${dinheiro(verba.limit_micros, verba.currency)} do teto do mês.`);
    const n = verba.changes.length;
    linhas.push(n === 0 ? 'Nenhuma mudança nas campanhas pelo Liame.' : `${inteiro(n)} ${n === 1 ? 'mudança aprovada' : 'mudanças aprovadas'} nas campanhas.`);
    // A conta cuja leitura não chegou ao último dia deixa o gasto incompleto: o e-mail diz qual.
    // A preposição vai com o nome de cada plataforma ("da Meta", "do Google Ads"): V121.
    if (verba.missing.length) linhas.push(`O gasto ${verba.missing.map((p) => comDe(plataforma(p) ?? p)).join(' e ')} vale até a última leitura, que não chegou ao fim do mês.`);
  }
  if (equipe) linhas.push(`Custo de IA no mês: ${custoDeIaNoMes(equipe)}.`);
  return linhas;
}

/** O número do topo que vai no assunto: o valor de agora, escrito como na tela. */
const doTopo = (r: ConteudoDoRelatorio, kind: string) => {
  const m = r.totals.find((x) => x.kind === kind);
  return m && m.now !== null ? valor(m, 'now', r.currency) : null;
};

/** A linha de um dos quatro números do topo: "Pedidos de anúncios: 53 (+12,8%; eram 47)". */
function linhaDoTotal(m: WeeklyReviewChange, moeda: string): string {
  const agora = valor(m, 'now', moeda);
  const era = eraDe(m, moeda);
  if (era === null) return `${ROTULO[m.kind] ?? m.kind}: ${agora}`;
  const variacao = variacaoDe(m);
  return `${ROTULO[m.kind] ?? m.kind}: ${agora} (${variacao ? `${variacao}; ` : ''}${era})`;
}

/**
 * O e-mail de uma pessoa: assunto, texto e HTML. `link` leva ao relatório na tela; `nivel` é o papel dela na empresa
 * (diz por que ela recebe); `imagens` são os endereços da marca e do rosto da LIA no próprio Liame. O que melhorou, o
 * que piorou e "Para o mês que vem" ficam na tela, como no protótipo do e-mail (P24).
 */
export function emailDoRelatorio(r: ConteudoDoRelatorio, quem: QuemRecebe & { imagens: ImagensDoEmail }): EmailDoRelatorio {
  const moeda = r.currency;
  const mes = mesCurto(r.month);
  const comparado = r.totals.some((m) => m.before !== null);
  const gerado = quandoFoiGerado(r.generated_at, r.timezone);
  const linhas: string[] = [];
  const secao = (titulo: string) => linhas.push('', titulo.toUpperCase());

  linhas.push(`Relatório de ${mes} da ${quem.marca}`);
  linhas.push(`De ${dia(r.month.from)} a ${dia(r.month.to)}${comparado ? `, comparado com ${mesCurto(mesAnterior(r.month))}` : ''}. Gerado ${gerado}.`);

  secao('Os números do mês');
  for (const m of r.totals) linhas.push(linhaDoTotal(m, moeda));

  const daLia = r.reading.source === 'lia';
  secao(daLia ? 'Leitura do mês, pela LIA (feito com IA)' : 'Leitura do mês, pelo sistema (sem IA)');
  const atrasada = fonteAtrasada(r);
  if (atrasada) linhas.push(atrasada, '');
  const e = r.reading.explanation;
  linhas.push(texto(e.what_happened));
  if (e.reasons.length) linhas.push('', 'Motivos:', ...e.reasons.map((m) => `- ${texto(m)}`));
  linhas.push('', `${RISCO[e.risk] ?? 'Risco médio'}: ${texto(e.risk_reason)}`);
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

  const verba = verbaEEquipe(r.budget, r.team);
  if (verba.length) {
    secao('A verba e a equipe');
    linhas.push(verba.join(' '));
  }

  linhas.push('', `Abrir o relatório no Liame: ${quem.link}`);
  linhas.push('', porQueRecebe(quem), ASSINATURA);

  const pedidos = doTopo(r, 'pedidos_de_anuncios');
  const receita = doTopo(r, 'receita_confirmada');
  const subject = `Relatório de ${mes} da ${quem.marca}${pedidos && receita ? `: ${pedidos} ${pedidos === '1' ? 'pedido' : 'pedidos'} e ${receita} no caixa` : ''}`;
  const periodoHtml =
    `De <b style="color:#0B0D17;">${escaparHtml(`${dia(r.month.from)} a ${dia(r.month.to)}`)}</b>` +
    `${comparado ? `, comparado com ${escaparHtml(mesCurto(mesAnterior(r.month)))}` : ''} · gerado ${escaparHtml(gerado)}.`;
  const html = htmlDoEmail({ ...r, improved: [], worsened: [], decisions: [] }, quem, quem.imagens, subject, {
    selo: ['Relatório', 'do mês'],
    leitura: 'Leitura do mês',
    periodoHtml,
    botao: 'Abrir o relatório no Liame',
    leituraAntes: true,
    extra: verba.length ? secaoDeParagrafos('A verba e a equipe', verba) : '',
  });
  return { subject, text: linhas.join('\n'), html };
}
