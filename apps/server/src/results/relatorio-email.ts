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
export function emailDoRelatorio(r: ConteudoDoRelatorio, quem: QuemRecebe & { imagens: ImagensDoEmail }, agencia?: DaAgencia): EmailDoRelatorio {
  const moeda = r.currency;
  const mes = mesCurto(r.month);
  const comparado = r.totals.some((m) => m.before !== null);
  const gerado = quandoFoiGerado(r.generated_at, r.timezone);
  const linhas: string[] = [];
  const secao = (titulo: string) => linhas.push('', titulo.toUpperCase());

  if (agencia) linhas.push(...textoDaAgencia(agencia, mes, quem.marca), '');
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
  linhas.push('', agencia ? rodapeDaAgencia(agencia, quem.empresa) : porQueRecebe(quem), ASSINATURA);

  const pedidos = doTopo(r, 'pedidos_de_anuncios');
  const receita = doTopo(r, 'receita_confirmada');
  const subject = agencia
    ? `${agencia.nome}: o relatório de ${mes} da ${quem.marca}${agencia.versao > 1 ? ' (versão corrigida)' : ''}`
    : `Relatório de ${mes} da ${quem.marca}${pedidos && receita ? `: ${pedidos} ${pedidos === '1' ? 'pedido' : 'pedidos'} e ${receita} no caixa` : ''}`;
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
    ...(agencia ? { antes: htmlDaAgencia(agencia, mes, quem.marca), rodape: rodapeDaAgencia(agencia, quem.empresa) } : {}),
  });
  return { subject, text: linhas.join('\n'), html };
}

// ------------------------------------------------------------------ o relatório que a agência manda (A7, W7, parte 4a)

/**
 * O que a agência põe no relatório que manda ao cliente (D-A7-65 e D-A7-69): o nome e o logo no alto ("preparado por
 * Agência Fogo, com o Liame"), o comentário assinado por quem mandou e o rodapé que diz para onde vai a resposta. Os
 * números, a leitura e as partes são os do relatório do mês, sem mudança. O texto exato espera a aprovação do dono
 * (P29: "o texto exato do e-mail vem com a W7, para aprovar à parte").
 */
export interface DaAgencia {
  nome: string;
  /** O endereço público do logo (`/v1/agency-logos/…`); nulo sem logo. */
  logoUrl: string | null;
  logoLargura: number | null;
  logoAltura: number | null;
  comentario: string | null;
  /** Quem mandou ("Juliana Prado"); nulo quando saiu sozinho no dia 2. */
  assinatura: string | null;
  versao: number;
  /** A agência tem o e-mail de resposta confirmado: o "Responder" vai para ela. */
  responde: boolean;
  /** O primeiro nome de quem recebe, para o "Rodrigo, o relatório…". */
  primeiroNome: string;
}

/** As linhas do alto, no texto puro. */
function textoDaAgencia(a: DaAgencia, mes: string, marca: string): string[] {
  const linhas = [a.nome, `preparado por ${a.nome}, com o Liame`, '', `${a.primeiroNome}, o relatório de ${mes} da ${marca} está pronto.`];
  if (a.versao > 1) linhas.push(`Esta é uma versão corrigida do relatório que ${a.nome} mandou antes.`);
  if (a.comentario) linhas.push('', a.comentario, `— ${a.assinatura ?? a.nome}, ${a.nome}`);
  return linhas;
}

function rodapeDaAgencia(a: DaAgencia, empresa: string): string {
  const responder = a.responde ? ' Para responder, é só responder a este e-mail: a resposta vai para a agência.' : '';
  return `${a.nome} cuida da sua conta no Liame, com o acesso que você deu.${responder} Os dados da ${empresa} seguem os Termos de Uso e a Política de Privacidade do Liame.`;
}

/** O alto do relatório da agência no HTML: a marca, a saudação e o comentário (linhas da tabela do e-mail). */
function htmlDaAgencia(a: DaAgencia, mes: string, marca: string): string {
  const F = "'Poppins','Segoe UI',Arial,sans-serif";
  const logo =
    a.logoUrl && a.logoLargura && a.logoAltura
      ? `<td valign="middle" width="1" style="padding-right:12px;"><img src="${escaparHtml(a.logoUrl)}" width="${Math.round(a.logoLargura / 2)}" height="${Math.round(a.logoAltura / 2)}" alt="${escaparHtml(a.nome)}" style="display:block;border:0;max-height:48px;"></td>`
      : '';
  const marcaDaAgencia =
    '<tr><td style="padding:18px 28px 0 28px;"><table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#FFFFFF;border:1px solid #E5E1D7;border-radius:10px;"><tr><td style="padding:10px 14px;">' +
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>${logo}<td valign="middle" style="font-family:${F};">` +
    `<div style="font-size:15px;line-height:20px;font-weight:700;color:#0B0D17;">${escaparHtml(a.nome)}</div>` +
    `<div style="font-size:12px;line-height:18px;color:#4A5068;">preparado por ${escaparHtml(a.nome)}, com o Liame</div>` +
    '</td></tr></table></td></tr></table></td></tr>';
  const ola =
    `<tr><td style="padding:16px 28px 0 28px;font-family:${F};font-size:15px;line-height:23px;color:#0B0D17;">` +
    `${escaparHtml(`${a.primeiroNome}, o relatório de ${mes} da ${marca} está pronto.`)}` +
    (a.versao > 1 ? `<br><span style="color:#4A5068;">${escaparHtml(`Esta é uma versão corrigida do relatório que ${a.nome} mandou antes.`)}</span>` : '') +
    '</td></tr>';
  const comentario = a.comentario
    ? `<tr><td style="padding:14px 28px 0 28px;"><table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr><td style="padding:12px 16px;background:#FAF8F3;border-left:3px solid #009AAA;border-radius:0 8px 8px 0;font-family:${F};font-size:14.5px;line-height:22px;color:#0B0D17;">` +
      `${escaparHtml(a.comentario).replace(/\n/g, '<br>')}` +
      `<div style="margin-top:8px;font-size:12.5px;line-height:18px;color:#4A5068;">${escaparHtml(`${a.assinatura ?? a.nome}, ${a.nome}`)}</div>` +
      '</td></tr></table></td></tr>'
    : '';
  return marcaDaAgencia + ola + comentario;
}
