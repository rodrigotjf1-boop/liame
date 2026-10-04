import type { WeeklyReviewCampaign, WeeklyReviewChange } from '@liame/contracts';
import { dia, dinheiro, inteiro, razao } from '../ai/registro/formatos.js';
import { plataforma } from '../ai/registro/leituras.visoes.js';
import {
  ASSINATURA,
  AVISO_DA_DECISAO,
  AVISO_DA_LIA,
  type ConteudoDaRevisao,
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

// A versão em HTML do e-mail da revisão (desenho aprovado pelo dono em 04/10/2026). Escrita como e-mail: tabelas,
// estilo em cada elemento, sem folha de estilo de fora, sem script e sem fonte baixada. As barras são células de
// tabela (aparecem mesmo com as imagens bloqueadas) e cada uma leva o nome e o valor ao lado: nada depende só da
// cor. As únicas imagens são a marca e o rosto da LIA, servidas pelo próprio Liame, sem código de rastreio.
// Todo texto que vem de fora (nome de campanha, de marca, de conta) é escapado antes de entrar no HTML.

/** Os endereços das duas imagens do e-mail, no webapp do Liame (`APP_URL` + `/email/…`). */
export interface ImagensDoEmail {
  logo: string;
  lia: string;
}

/** A marca do topo como é mostrada (o arquivo tem o dobro, 368 × 150, para tela de alta densidade). */
const LOGO = { largura: 184, altura: 75 };

const NOITE = '#0B0D17';
const PAPEL = '#F4F2EC';
const VIOLETA = '#7B61FF';
const CIANO = '#2DD4DE';
const LAVANDA = '#A08FFF';
const PETROLEO = '#1BA8B8';
const AMBAR = '#FFC24B';
const TINTA = '#0B0D17';
const SUAVE = '#4B5066';
const LINHA = '#E4E0D6';
const CARTAO = '#F8F7F3';
const BOM = '#0A6C75';
const RUIM = '#B3261E';
const FONTE = "'Poppins','Segoe UI',Helvetica,Arial,sans-serif";
const MONO = "'JetBrains Mono',Consolas,'Courier New',monospace";

/** Fundo e tinta do selo de cada veredito e de cada risco: a palavra vai sempre junto. */
const COR_DO_VEREDITO: Record<string, [fundo: string, tinta: string]> = { lucro: ['#DDF3E8', '#17694A'], empata: ['#ECE8FF', '#4A35C8'], prejuizo: ['#FDE7E5', RUIM] };
const COR_DO_RISCO: Record<string, [fundo: string, tinta: string]> = { baixo: ['#DDF3E8', '#17694A'], medio: ['#FFF1CC', '#6B4A00'], alto: ['#FDE7E5', RUIM] };

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
/** Texto de fora dentro do HTML (conteúdo e atributo). */
export const escaparHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);
const e = escaparHtml;

const TABELA = 'role="presentation" cellpadding="0" cellspacing="0"';

const rotulo = (t: string, cor = SUAVE) =>
  `<p style="margin:0;font-family:${MONO};font-size:11px;line-height:16px;letter-spacing:1.2px;text-transform:uppercase;color:${cor};">${e(t)}</p>`;
const paragrafo = (html: string, cor = TINTA, extra = '') => `<p style="margin:0 0 10px 0;font-family:${FONTE};font-size:14px;line-height:22px;color:${cor};${extra}">${html}</p>`;
const nota = (t: string) => paragrafo(e(t), SUAVE, 'font-size:12.5px;line-height:19px;');
const secao = (titulo: string, miolo: string, topo = 28) =>
  `<tr><td style="padding:${topo}px 28px 0 28px;"><h2 style="margin:0 0 12px 0;font-family:${FONTE};font-size:17px;line-height:24px;font-weight:700;color:${TINTA};">${e(titulo)}</h2>${miolo}</td></tr>`;

function lista(itens: string[], marca = '•', cor = SUAVE): string {
  const linhas = itens
    .map(
      (i) =>
        `<tr><td width="18" valign="top" style="font-family:${FONTE};font-size:14px;line-height:22px;color:${cor};">${marca}</td>` +
        `<td style="font-family:${FONTE};font-size:14px;line-height:22px;color:${TINTA};padding-bottom:6px;">${e(i)}</td></tr>`,
    )
    .join('');
  return `<table ${TABELA} width="100%">${linhas}</table>`;
}

/** Subir é bom nos pedidos e na receita; no investimento, não é bom nem ruim. */
function tomDe(m: WeeklyReviewChange): string {
  if (m.kind === 'investimento' || !m.change_pct) return SUAVE;
  return m.change_pct.startsWith('+') ? BOM : m.change_pct.startsWith('-') ? RUIM : SUAVE;
}

function cartaoDoTotal(m: WeeklyReviewChange, moeda: string): string {
  const variacao = variacaoDe(m);
  const era = eraDe(m, moeda);
  // A seta diz a direção junto com a cor; variação zero ("0,0%") não leva seta.
  const seta = !variacao ? '' : variacao.startsWith('+') ? '▲ ' : variacao.startsWith('-') ? '▼ ' : '';
  const antes = [variacao ? `<span style="color:${tomDe(m)};font-weight:600;">${seta}${e(variacao)}</span>` : '', era ? e(era) : ''].filter(Boolean).join(' · ');
  return (
    `<td width="50%" valign="top" style="padding:6px;"><table ${TABELA} width="100%" style="background:${CARTAO};border:1px solid ${LINHA};border-radius:10px;">` +
    `<tr><td style="padding:14px 14px 12px 14px;">${rotulo(ROTULO[m.kind] ?? m.kind)}` +
    `<p class="lm-num" style="margin:6px 0 2px 0;font-family:${MONO};font-size:22px;line-height:28px;font-weight:600;color:${TINTA};">${e(valor(m, 'now', moeda))}</p>` +
    `<p style="margin:0;font-family:${FONTE};font-size:12.5px;line-height:18px;color:${SUAVE};">${antes || '&nbsp;'}</p>` +
    '</td></tr></table></td>'
  );
}

/** Os cartões dos números, dois por linha; com número ímpar, o último fica com a metade da linha. */
function cartoesDosTotais(totais: WeeklyReviewChange[], moeda: string): string {
  const linhas: string[] = [];
  for (let i = 0; i < totais.length; i += 2) {
    const par = totais.slice(i, i + 2).map((m) => cartaoDoTotal(m, moeda));
    if (par.length === 1) par.push('<td width="50%" style="padding:6px;">&nbsp;</td>');
    linhas.push(`<tr>${par.join('')}</tr>`);
  }
  return `<table ${TABELA} width="100%">${linhas.join('')}</table>`;
}

/** A barra de um valor contra o maior da tabela: de 1% (para o zero ainda aparecer) a 100% da largura. */
function barra(nome: string, micros: bigint, maior: bigint, cor: string, moeda: string): string {
  const pct = maior === 0n ? 0 : Number((micros * 100n + maior / 2n) / maior);
  const cheio = Math.min(100, Math.max(pct, 1));
  const vazio = 100 - cheio;
  const trilho =
    `<td width="${cheio}%" height="12" bgcolor="${cor}" style="background:${cor};border-radius:3px;font-size:0;line-height:0;">&nbsp;</td>` +
    (vazio ? `<td width="${vazio}%" height="12" style="font-size:0;line-height:0;">&nbsp;</td>` : '');
  return (
    '<tr>' +
    `<td width="74" style="padding:3px 8px 3px 0;font-family:${FONTE};font-size:12px;line-height:16px;color:${SUAVE};white-space:nowrap;">${e(nome)}</td>` +
    `<td style="padding:3px 0;"><table ${TABELA} width="100%"><tr>${trilho}</tr></table></td>` +
    `<td width="92" align="right" style="padding:3px 0 3px 8px;font-family:${MONO};font-size:12.5px;line-height:16px;color:${TINTA};white-space:nowrap;">${e(dinheiro(micros.toString(), moeda) ?? '')}</td>` +
    '</tr>'
  );
}

function campanha(c: WeeklyReviewCampaign, maior: bigint, ultima: boolean, moeda: string): string {
  const cores = c.verdict ? COR_DO_VEREDITO[c.verdict] : undefined;
  const selo =
    c.verdict && cores
      ? `<span style="display:inline-block;margin-left:8px;padding:1px 8px;border-radius:999px;background:${cores[0]};color:${cores[1]};font-size:11.5px;line-height:18px;font-weight:600;white-space:nowrap;">${e(VEREDITO[c.verdict] ?? c.verdict)}</span>`
      : '';
  const roas = c.roas ? ` · ROAS no caixa ${e(razao(c.roas) ?? c.roas)}` : '';
  return (
    `<tr><td style="padding:12px 0;${ultima ? '' : `border-bottom:1px solid ${LINHA};`}">` +
    `<p style="margin:0 0 6px 0;font-family:${FONTE};font-size:14px;line-height:20px;font-weight:600;color:${TINTA};">${e(c.name)}` +
    ` <span style="font-weight:400;color:${SUAVE};">· ${e(plataforma(c.provider) ?? c.provider)}</span>${selo}</p>` +
    `<table ${TABELA} width="100%">${barra('Investido', BigInt(c.spend_micros), maior, VIOLETA, moeda)}${barra('No caixa', BigInt(c.revenue_micros), maior, PETROLEO, moeda)}</table>` +
    `<p style="margin:6px 0 0 0;font-family:${FONTE};font-size:12.5px;line-height:18px;color:${SUAVE};">${e(inteiro(c.orders) ?? '0')} ${c.orders === 1 ? 'pedido' : 'pedidos'}${roas}</p>` +
    '</td></tr>'
  );
}

function blocoDasCampanhas(r: ConteudoDaRevisao): string {
  if (!r.campaigns.length && !r.platform_only.length) return '';
  const moeda = r.currency;
  const maior = r.campaigns.reduce((m, c) => [BigInt(c.spend_micros), BigInt(c.revenue_micros)].reduce((a, v) => (v > a ? v : a), m), 0n);
  const quadrado = (cor: string) => `<span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${cor};"></span>`;
  const legenda = r.campaigns.length
    ? `<p style="margin:0 0 4px 0;font-family:${FONTE};font-size:12.5px;line-height:18px;color:${SUAVE};">${quadrado(VIOLETA)} Investido em anúncios &nbsp;&nbsp;${quadrado(PETROLEO)} Receita confirmada no caixa</p>`
    : '';
  const campanhas = r.campaigns.length ? `<table ${TABELA} width="100%">${r.campaigns.map((c, i) => campanha(c, maior, i === r.campaigns.length - 1, moeda)).join('')}</table>` : '';
  const soNaPlataforma = r.platform_only
    .map((p) => `${plataforma(p.provider) ?? p.provider}, sem campanha identificada: ${inteiro(p.orders)} ${p.orders === 1 ? 'pedido' : 'pedidos'}${p.revenue_micros ? `, ${dinheiro(p.revenue_micros, moeda)}` : ''} (conta no total).`)
    .map((linha) => paragrafo(e(linha), SUAVE, 'font-size:12.5px;line-height:19px;margin-top:8px;'))
    .join('');
  return secao('O que cada campanha trouxe no caixa', legenda + campanhas + soNaPlataforma);
}

function blocoDaLeitura(r: ConteudoDaRevisao, imagens: ImagensDoEmail): string {
  const daLia = r.reading.source === 'lia';
  const x = r.reading.explanation;
  const titulo = (t: string, margem: string) => `<h2 style="margin:${margem};font-family:${FONTE};font-size:17px;line-height:22px;font-weight:700;color:${TINTA};">${t}</h2>`;
  const cabecalho = daLia
    ? `<table ${TABELA} style="margin:0 0 12px 0;"><tr>` +
      `<td width="44" valign="middle"><img src="${e(imagens.lia)}" width="36" height="36" alt="LIA" style="display:block;border:0;border-radius:9px;"></td>` +
      `<td valign="middle">${titulo('Leitura da semana, pela LIA', '0')}${rotulo('Feito com IA · números do sistema', '#4A35C8')}</td></tr></table>`
    : `${titulo('Leitura da semana', '0 0 4px 0')}<div style="margin:0 0 12px 0;">${rotulo('Pelo sistema · sem IA')}</div>`;
  const atrasada = fonteAtrasada(r);
  const [fundo, tinta] = COR_DO_RISCO[x.risk] ?? COR_DO_RISCO.medio!;
  const risco =
    `<table ${TABELA} style="margin:6px 0 12px 0;"><tr><td style="padding:8px 12px;background:${fundo};border-radius:8px;font-family:${FONTE};font-size:13.5px;line-height:20px;color:${tinta};">` +
    `<b>${e(RISCO[x.risk] ?? 'Risco médio')}:</b> ${e(texto(x.risk_reason))}</td></tr></table>`;
  return (
    '<tr><td style="padding:24px 28px 0 28px;">' +
    cabecalho +
    (atrasada ? paragrafo(e(atrasada), '#6B4A00', 'padding:8px 12px;background:#FFF1CC;border-radius:8px;font-size:13.5px;line-height:20px;') : '') +
    paragrafo(e(texto(x.what_happened))) +
    (x.reasons.length ? paragrafo('<b>Motivos</b>', TINTA, 'margin-bottom:4px;') + lista(x.reasons.map(texto)) : '') +
    risco +
    (x.what_to_do.length ? paragrafo('<b>O que fazer</b>', TINTA, 'margin-bottom:4px;') + lista(x.what_to_do.map(texto), '→', BOM) : '') +
    (daLia ? nota(AVISO_DA_LIA) : '') +
    '</td></tr>'
  );
}

function blocoDasDecisoes(r: ConteudoDaRevisao): string {
  if (!r.decisions.length) return '';
  const cartoes = r.decisions
    .map(
      (d) =>
        `<tr><td style="padding:0 0 10px 0;"><table ${TABELA} width="100%" style="background:#FFF8E6;border-left:4px solid ${AMBAR};border-radius:6px;">` +
        `<tr><td style="padding:12px 14px;"><p style="margin:0 0 2px 0;font-family:${FONTE};font-size:14px;line-height:20px;font-weight:600;color:${TINTA};">${e(d.title)}</p>` +
        `<p style="margin:0;font-family:${FONTE};font-size:13.5px;line-height:20px;color:${SUAVE};">${e(d.detail)}</p></td></tr></table></td></tr>`,
    )
    .join('');
  return secao('Precisa de decisão', `<table ${TABELA} width="100%">${cartoes}</table>${nota(AVISO_DA_DECISAO)}`, 18);
}

/** O texto que o programa de e-mail mostra ao lado do assunto: os números da semana numa linha. */
function resumoAoLadoDoAssunto(r: ConteudoDaRevisao): string {
  const partes: string[] = [];
  for (const m of r.totals) {
    if (m.now === null) continue;
    const v = valor(m, 'now', r.currency);
    if (m.kind === 'investimento') partes.push(`Investido ${v}`);
    else if (m.kind === 'pedidos_de_anuncios') partes.push(`${v} ${m.now === '1' ? 'pedido' : 'pedidos'}`);
    else if (m.kind === 'receita_confirmada') partes.push(`${v} confirmados no caixa`);
    else if (m.kind === 'roas_confirmado') partes.push(`ROAS ${v}`);
  }
  return partes.join(' · ');
}

/** O e-mail em HTML: o mesmo conteúdo da versão em texto. `assunto` vira o título do documento. */
export function htmlDaRevisao(r: ConteudoDaRevisao, quem: QuemRecebe, imagens: ImagensDoEmail, assunto: string): string {
  const moeda = r.currency;
  const comparada = r.totals.some((m) => m.before !== null);
  const periodo =
    `Semana de <b style="color:${TINTA};">${e(`${dia(r.week.from)} a ${dia(r.week.to)}`)}</b>` +
    (comparada ? `, comparada com ${e(`${dia(r.previous_week.from)} a ${dia(r.previous_week.to)}`)}.` : '.');
  const corpo =
    `<div lang="pt-BR" style="background:${PAPEL};padding:24px 12px;">` +
    `<div style="display:none;max-height:0;overflow:hidden;font-size:1px;line-height:1px;color:${PAPEL};">${e(resumoAoLadoDoAssunto(r))}</div>` +
    `<table ${TABELA} align="center" width="100%" style="max-width:600px;margin:0 auto;background:#FFFFFF;border:1px solid ${LINHA};border-radius:14px;overflow:hidden;">` +
    // o topo com a marca
    `<tr><td style="background:${NOITE};padding:20px 28px;"><table ${TABELA} width="100%"><tr>` +
    `<td valign="middle"><img src="${e(imagens.logo)}" width="${LOGO.largura}" height="${LOGO.altura}" alt="Liame" style="display:block;border:0;font-family:${FONTE};font-size:20px;font-weight:700;color:#FFFFFF;"></td>` +
    `<td valign="middle" align="right" style="font-family:${MONO};font-size:11px;line-height:16px;letter-spacing:1.2px;text-transform:uppercase;color:${LAVANDA};">Revisão<br>da semana</td>` +
    '</tr></table></td></tr>' +
    `<tr><td height="4" style="height:4px;font-size:0;line-height:0;background:${CIANO};">&nbsp;</td></tr>` +
    // a marca da empresa e a semana
    '<tr><td style="padding:26px 28px 0 28px;">' +
    `<h1 style="margin:0 0 6px 0;font-family:${FONTE};font-size:24px;line-height:30px;font-weight:700;color:${TINTA};">${e(quem.marca)}</h1>` +
    `<p style="margin:0;font-family:${FONTE};font-size:14px;line-height:22px;color:${SUAVE};">${periodo}</p>` +
    '</td></tr>' +
    // os números da semana
    `<tr><td style="padding:16px 22px 0 22px;">${cartoesDosTotais(r.totals, moeda)}</td></tr>` +
    blocoDasCampanhas(r) +
    blocoDaLeitura(r, imagens) +
    (r.improved.length ? secao('O que melhorou', lista(r.improved.map((m) => linhaDaMudanca(m, moeda)), '▲', BOM), 18) : '') +
    (r.worsened.length ? secao('O que piorou', lista(r.worsened.map((m) => linhaDaMudanca(m, moeda)), '▼', RUIM), 14) : '') +
    blocoDasDecisoes(r) +
    // o botão
    `<tr><td align="center" style="padding:22px 28px 6px 28px;"><table ${TABELA}><tr>` +
    `<td bgcolor="${CIANO}" style="background:${CIANO};border-radius:10px;"><a href="${e(quem.link)}" style="display:inline-block;padding:13px 26px;font-family:${FONTE};font-size:15px;line-height:20px;font-weight:600;color:${NOITE};text-decoration:none;">Abrir a revisão no Liame</a></td>` +
    '</tr></table></td></tr>' +
    // o rodapé
    `<tr><td style="padding:22px 28px 26px 28px;"><table ${TABELA} width="100%" style="border-top:1px solid ${LINHA};"><tr><td style="padding-top:16px;font-family:${FONTE};font-size:12px;line-height:19px;color:${SUAVE};">` +
    `${e(porQueRecebe(quem))}<br><b style="color:${TINTA};">Liame</b> · ${e(ASSINATURA.replace('Liame · ', ''))}` +
    '</td></tr></table></td></tr>' +
    '</table></div>';
  // A única regra fora dos elementos: em tela estreita, o número grande encolhe para caber sem quebrar.
  const estilo = '<style>@media (max-width:480px){.lm-num{font-size:18px!important;line-height:24px!important;white-space:nowrap!important}}</style>';
  return (
    '<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
    `<meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light"><title>${e(assunto)}</title>${estilo}</head>` +
    `<body style="margin:0;padding:0;background:${PAPEL};">${corpo}</body></html>`
  );
}
