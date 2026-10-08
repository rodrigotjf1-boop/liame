import type { AttentionItem, WeeklyReview, WeeklyReviewChange } from '@liame/contracts';
import { acaoDoAviso } from '@/components/atencao/textos';
import type { AvisoSemIa } from '@/components/explicar/textos';
import { dataNoFuso, diaMes, horaNoFuso, type Veredito } from '@/components/resultados/textos';
import { inteiro, reaisDeMicros } from '@/lib/formato';

// Regras e frases da "Revisão da semana" (mockups/prototipo-explicar.html, P4 aprovado em 02/10/2026). A
// revisão vem pronta da API, como foi gerada na segunda-feira: aqui nada é calculado, só escrito. Valor que
// a tela ainda não conhece (tipo de mudança, veredito, situação do envio) tem um caminho (V23).
// Os números do topo, as campanhas e as mudanças desenhadas estão em `graficos.ts`.

/** "2.86" → "2,86" (o ROAS da revisão tem duas casas, como no protótipo); nulo vira travessão. */
export function razao(r: string | null): string {
  return r === null ? '—' : r.replace('.', ',');
}

/** "+12.8" → "+12,8%"; "0.0" → "0,0%". */
export function variacao(pct: string | null): string | null {
  return pct === null ? null : `${pct.replace('.', ',')}%`;
}

/** O valor de antes ou de agora, escrito pela unidade dele; sem valor, travessão. */
export function valorDe(m: WeeklyReviewChange, qual: 'before' | 'now'): string {
  const v = m[qual];
  if (v === null) return '—';
  if (m.unit === 'dinheiro') return reaisDeMicros(v);
  if (m.unit === 'razao') return razao(v);
  return inteiro(v);
}

export type Mudanca = { chave: string; nome: string; de: string; para: string; variacao: string | null };

const NOME_DA_MUDANCA: Record<string, string> = {
  pedidos_de_anuncios: 'Pedidos de anúncios',
  receita_confirmada: 'Receita confirmada',
  roas_confirmado: 'ROAS confirmado no caixa',
  pedidos_sem_origem: 'Pedidos sem origem',
  investimento: 'Investimento em anúncios',
};

/** Uma linha de "O que melhorou" ou "O que piorou": "Pedidos de anúncios: de 47 para 53 (+12,8%)". */
export function mudancaDe(m: WeeklyReviewChange): Mudanca {
  const nome = m.campaign ? `${m.campaign.name}: ROAS no caixa` : `${NOME_DA_MUDANCA[m.kind] ?? m.kind.replaceAll('_', ' ')}:`;
  return {
    chave: `${m.kind}-${m.campaign?.id ?? ''}`,
    nome,
    de: valorDe(m, 'before'),
    para: valorDe(m, 'now'),
    // No ROAS o protótipo mostra só os dois valores.
    variacao: m.unit === 'razao' ? null : variacao(m.change_pct),
  };
}

/** O selo do resultado de uma campanha na semana; veredito que a tela não conhece fica sem selo. */
export function vereditoDaSemana(verdict: string | null, pedidos: number, gastoMicros: string): Veredito | null {
  if (verdict === 'lucro') return { rotulo: 'Dá lucro', classe: 'bom' };
  if (verdict === 'empata') return { rotulo: 'Empata', classe: 'atencao' };
  if (verdict === 'prejuizo') return { rotulo: 'Dá prejuízo', classe: 'ruim' };
  if (verdict === null && pedidos > 0 && BigInt(gastoMicros) > 0n) return { rotulo: 'Margem incompleta', classe: 'incompleta' };
  return null;
}

/** Para onde leva o botão de um item de "Precisa de decisão": a tela onde se resolve (só navegação). */
export function destinoDaDecisao(d: Pick<AttentionItem, 'kind'>, pode: (permissao: string) => boolean): { href: string; rotulo: string } | null {
  if (d.kind === 'prejuizo_seguido') return { href: '/resultados', rotulo: 'Ver em Resultados' };
  if (acaoDoAviso(d.kind) === 'abrir-links') return { href: '/links', rotulo: 'Abrir Links e cupons' };
  // Os outros são avisos da Atenção: lá estão o motivo, a explicação e o botão de cada um.
  return pode('campanhas.ver') ? { href: '/atencao', rotulo: 'Ver na Atenção' } : null;
}

const DIAS = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];
/** "segunda-feira, 28/09" a partir de AAAA-MM-DD. */
export function diaEscrito(data: string): string {
  return `${DIAS[new Date(`${data}T00:00:00Z`).getUTCDay()]}, ${diaMes(data)}`;
}

/** "segunda-feira, 28/09, às 05:10", no fuso da loja. */
export function momentoEscrito(iso: string, fuso: string): string {
  const instante = new Date(iso);
  return `${diaEscrito(dataNoFuso(instante, fuso))}, às ${horaNoFuso(instante, fuso)}`;
}

/** "Semana de 21/09 a 27/09". */
export function semanaEscrita(week: { from: string; to: string }): string {
  return `Semana de ${diaMes(week.from)} a ${diaMes(week.to)}`;
}

/**
 * A linha do envio por e-mail: para quantas pessoas foi e quando; ou que ainda vai sair. Sem o envio ligado
 * para a empresa (ou sem ter para quem), a tela não fala de e-mail.
 */
export function envioDaRevisao(email: WeeklyReview['email'], fuso: string): string | null {
  if (email.status === 'enviado' && email.sent_at) {
    return `Enviada por e-mail na ${momentoEscrito(email.sent_at, fuso)}, para ${email.recipients === 1 ? '1 pessoa' : `${inteiro(email.recipients)} pessoas`}.`;
  }
  if (email.status === 'pendente') return 'O e-mail desta revisão sai a partir das 7h.';
  return null;
}

/** A frase do topo da tela: fala do e-mail só quando a empresa o recebe. */
export function introDaRevisao(email: WeeklyReview['email'] | null): string {
  const comEmail = email !== null && (email.status === 'enviado' || email.status === 'pendente');
  return `O que vendeu, o que cada campanha trouxe no caixa, o que mudou e o que precisa de decisão. Sai toda segunda-feira de manhã${comEmail ? ', na tela e por e-mail' : ''}.`;
}

/**
 * Por que a leitura da semana é a do sistema, como no protótipo: com fonte atrasada na geração, diz qual e
 * desde quando; nos outros casos, que a revisão saiu sem a leitura da LIA e que o resto está completo.
 * Nulo quando a leitura é da LIA.
 */
export function avisoDaLeitura(reading: WeeklyReview['reading']): AvisoSemIa | null {
  if (reading.source === 'lia') return null;
  if (reading.reason === 'dado_velho') {
    const fontes = reading.stale_sources.map((f) => `${f.platform ? `${f.platform} · ` : ''}${f.name}${f.last_read ? `, última leitura em ${f.last_read}` : ', ainda não lida'}`);
    const quais = fontes.length ? `uma fonte estava atrasada (${fontes.join('; ')})` : 'uma fonte estava atrasada';
    return { tom: 'atencao', icone: 'clock', titulo: 'A revisão saiu sem a leitura da LIA', texto: `Na hora de gerar, ${quais}. Os números abaixo valem até essa hora.`, acao: 'ver-conexao' };
  }
  return { tom: 'neutro', icone: 'info', titulo: 'A revisão desta semana saiu sem a leitura da LIA', texto: 'Os números, as listas e o resumo abaixo são do sistema e estão completos.', acao: null };
}
