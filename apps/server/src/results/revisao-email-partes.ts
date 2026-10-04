import type { ExplanationSegment, WeeklyReview, WeeklyReviewChange } from '@liame/contracts';
import { dia, dinheiro, inteiro, razao } from '../ai/registro/formatos.js';
import { ATENDIMENTO } from '../suporte.js';

// O que a versão em texto e a versão em HTML do e-mail da revisão têm em comum: os rótulos e a forma de
// escrever cada número. Nenhum número é calculado aqui: tudo vem da revisão guardada.

/** O conteúdo guardado de uma revisão: o contrato sem o que vem das colunas (o id e o envio). */
export type ConteudoDaRevisao = Omit<WeeklyReview, 'id' | 'email'>;

/** Para quem é o e-mail: a marca, a empresa, o nível da pessoa (diz por que ela recebe) e o endereço da revisão na tela. */
export interface QuemRecebe {
  marca: string;
  empresa: string;
  nivel: string;
  link: string;
}

export const NIVEL: Record<string, string> = { dono: 'Dono', administrador: 'Administrador', so_relatorios: 'Só relatórios por e-mail' };
export const VEREDITO: Record<string, string> = { lucro: 'dá lucro', empata: 'empata', prejuizo: 'dá prejuízo' };
export const RISCO: Record<string, string> = { baixo: 'Risco baixo', medio: 'Risco médio', alto: 'Risco alto' };
export const SUPORTE = ATENDIMENTO.email;
export const AVISO_DA_LIA = 'A LIA é uma assistente de IA: ela só escreve. Os números são do sistema, conferidos antes de aparecer, e a decisão é sua.';
export const AVISO_DA_DECISAO = 'O Liame aponta; quem decide é você. Nada muda nas campanhas por aqui.';

export const ROTULO: Record<string, string> = {
  investimento: 'Investido em anúncios',
  pedidos_de_anuncios: 'Pedidos de anúncios',
  receita_confirmada: 'Receita confirmada no caixa',
  roas_confirmado: 'ROAS confirmado no caixa',
  pedidos_sem_origem: 'Pedidos sem origem',
};

/** "21/09" a partir do dia. */
export const curto = (d: string) => (dia(d) ?? d).slice(0, 5);
export const texto = (trechos: ExplanationSegment[]) => trechos.map((t) => t.text).join('');
/** "+12.8" → "+12,8%". */
export const pct = (v: string | null) => (v === null ? null : `${v.replace('.', ',')}%`);

export function valor(m: WeeklyReviewChange, qual: 'before' | 'now', moeda: string): string {
  const v = m[qual];
  if (v === null) return 'sem número';
  return m.unit === 'dinheiro' ? (dinheiro(v, moeda) ?? v) : m.unit === 'razao' ? (razao(v) ?? v) : (inteiro(v) ?? v);
}

/** A variação que aparece ao lado do número: a razão (ROAS) não leva porcentagem. */
export const variacaoDe = (m: WeeklyReviewChange) => (m.unit === 'razao' ? null : pct(m.change_pct));

/** "era R$ 1.180,00" / "eram 47"; nulo quando não havia o que comparar. */
export function eraDe(m: WeeklyReviewChange, moeda: string): string | null {
  if (m.before === null) return null;
  return `${m.unit === 'contagem' && m.before !== '1' ? 'eram' : 'era'} ${valor(m, 'before', moeda)}`;
}

/** "Pedidos de anúncios: de 47 para 53 (+12,8%)" / "Combo sexta: ROAS no caixa de 4,02 para 4,25". */
export function linhaDaMudanca(m: WeeklyReviewChange, moeda: string): string {
  const nome = m.campaign ? `${m.campaign.name}: ROAS no caixa` : (ROTULO[m.kind] ?? m.kind);
  const variacao = variacaoDe(m);
  return `${nome}${m.campaign ? '' : ':'} de ${valor(m, 'before', moeda)} para ${valor(m, 'now', moeda)}${variacao ? ` (${variacao})` : ''}`;
}

/** A frase da fonte atrasada na hora de gerar; nula quando a leitura não saiu com dado velho. */
export function fonteAtrasada(r: ConteudoDaRevisao): string | null {
  if (r.reading.reason !== 'dado_velho' || !r.reading.stale_sources.length) return null;
  const fontes = r.reading.stale_sources.map((f) => `${f.platform ? `${f.platform} · ` : ''}${f.name}${f.last_read ? `, última leitura em ${f.last_read}` : ', ainda não lida'}`);
  return `Na hora de gerar, uma fonte estava atrasada (${fontes.join('; ')}). Os números valem até essa hora.`;
}

/** Por que a pessoa recebe o e-mail, e como deixar de receber. */
export const porQueRecebe = (quem: QuemRecebe) =>
  `Você recebe este e-mail porque tem acesso à ${quem.empresa} no Liame como ${NIVEL[quem.nivel] ?? quem.nivel}. Para deixar de receber, escreva para ${SUPORTE}.`;
export const ASSINATURA = 'Liame · um produto DMS Tecnologias';
