import type { AttentionItem } from '@liame/contracts';
import { idDoCartaoDasVendas } from '@/components/contas/vendas-google';
import { quandoComHora } from '@/lib/formato';

// Regras e frases de "Atenção de mídia" (mockups/prototipo-contas.html). A gravidade e o tipo chegam
// como texto (V23): valor que a tela ainda não conhece cai em "Informação" e não ganha botão.

export type Gravidade = 'critica' | 'atencao' | 'info';
export const GRAVIDADES: Gravidade[] = ['critica', 'atencao', 'info'];

const ROTULOS: Record<Gravidade, { aviso: string; filtro: string }> = {
  critica: { aviso: 'Crítico', filtro: 'Críticos' },
  atencao: { aviso: 'Atenção', filtro: 'Atenção' },
  info: { aviso: 'Informação', filtro: 'Informação' },
};

export function gravidadeDe(severity: string): Gravidade {
  return severity === 'critica' || severity === 'atencao' ? severity : 'info';
}

export function rotuloDaGravidade(g: Gravidade): string {
  return ROTULOS[g].aviso;
}

export function rotuloDoFiltro(g: Gravidade | 'todas'): string {
  return g === 'todas' ? 'Todos' : ROTULOS[g].filtro;
}

/** Quantos avisos há de cada gravidade (e no total), para os filtros. */
export function contagemPorGravidade(itens: Pick<AttentionItem, 'severity'>[]): Record<Gravidade | 'todas', number> {
  const c = { todas: itens.length, critica: 0, atencao: 0, info: 0 };
  for (const i of itens) c[gravidadeDe(i.severity)]++;
  return c;
}

/** Número do menu: o que pede alguém agora (crítico e atenção; informação não conta). */
export function contadorDoMenu(itens: Pick<AttentionItem, 'severity'>[]): number {
  const c = contagemPorGravidade(itens);
  return c.critica + c.atencao;
}

/** ", 5 avisos" para quem ouve o menu (o número em si é decorativo). */
export function avisosFalados(n: number): string {
  return n === 1 ? ', 1 aviso' : `, ${n} avisos`;
}

/**
 * "O que fazer: confira…": a frase da API começa com maiúscula; depois dos dois-pontos, minúscula, como
 * no protótipo. Sigla ou nome próprio no começo ("GA4", "Liame") fica como está.
 */
export function oQueFazer(acao: string): string {
  if (/^\p{Lu}\p{Ll}/u.test(acao) && !/^(Liame|Meta|Google)\b/.test(acao)) return acao[0]!.toLocaleLowerCase('pt-BR') + acao.slice(1);
  return acao;
}

export type AcaoDoAviso = 'abrir-contas' | 'reconectar' | 'abrir-links' | 'abrir-cupons' | 'abrir-resultados' | 'abrir-verba';

/**
 * O botão de cada aviso, como no protótipo: conta desconectada leva a Contas; autorização vencendo reconecta.
 * Os avisos do ciclo fechado (F9) levam à tela onde se resolve: Links e cupons ou Resultados.
 */
export function acaoDoAviso(kind: string): AcaoDoAviso | null {
  if (kind === 'conta_desconectada' || kind === 'vendas_nao_conectadas') return 'abrir-contas';
  if (kind === 'reconectar_em_breve') return 'reconectar';
  if (kind === 'anuncio_sem_rastreio' || kind === 'plataforma_nao_informada') return 'abrir-links';
  if (kind === 'campanha_sem_cupom' || kind === 'cupom_sem_uso') return 'abrir-cupons';
  if (kind === 'campanha_sem_pedido' || kind === 'margem_desconhecida' || kind === 'plataforma_x_caixa' || kind === 'vendas_nao_medidas') return 'abrir-resultados';
  // Fora do normal (A3, I6): vendas, gasto da campanha e custo por pedido se conferem em Resultados.
  if (kind === 'vendas_fora_do_normal' || kind === 'gasto_da_campanha_fora_do_normal' || kind === 'custo_por_pedido_fora_do_normal') return 'abrir-resultados';
  // O que o Liame mudou e gastou mais do que a verba permite (A4, X4) se confere na Verba do mês.
  if (kind === 'gasto_acima_da_verba') return 'abrir-verba';
  return null;
}

/**
 * O aviso de que o envio das vendas ao Google parou (A5 · Y1; protótipo P14, parte B) abre Contas conectadas já no
 * cartão da conta. `rotulo` é o do botão na Atenção; `curto`, o do item no "Precisa de você" do Resumo.
 */
export function destinoDasVendasAoGoogle(item: { kind: string; connected_account_id: string | null }): { href: string; rotulo: string; curto: string } | null {
  if (item.kind !== 'vendas_google_sem_permissao' && item.kind !== 'vendas_google_recusadas') return null;
  const href = `/contas#${item.connected_account_id ? idDoCartaoDasVendas(item.connected_account_id) : 'vendas-google'}`;
  return item.kind === 'vendas_google_sem_permissao'
    ? { href, rotulo: 'Abrir Contas conectadas', curto: 'Autorizar' }
    : { href, rotulo: 'Ver o motivo em Contas conectadas', curto: 'Ver o motivo' };
}

/** Para onde leva o botão de tela (os de Contas e de reconectar têm o próprio tratamento). */
export function destinoDoAviso(acao: AcaoDoAviso): { href: string; rotulo: string } | null {
  if (acao === 'abrir-links') return { href: '/links', rotulo: 'Abrir Links e cupons' };
  if (acao === 'abrir-cupons') return { href: '/links#cupons', rotulo: 'Abrir os cupons' };
  if (acao === 'abrir-resultados') return { href: '/resultados', rotulo: 'Abrir Resultados' };
  if (acao === 'abrir-verba') return { href: '/verba', rotulo: 'Abrir a Verba do mês' };
  return null;
}

/**
 * A tela de destino é de quem vê as vendas (Links e cupons, Resultados)? A Verba do mês é de quem acompanha as
 * campanhas, como a própria Atenção: o botão dela não depende de ver as vendas.
 */
export function destinoPedeVendas(acao: AcaoDoAviso): boolean {
  return acao !== 'abrir-verba';
}

// ------------------------------------------------------------------ a recomendação do Gestor de tráfego (A4, X8)

/** A situação do cartão: aberta (dá para pedir e dispensar), com o pedido andando, com a mudança feita, ou só o texto. */
export type EstadoDaRecomendacao =
  | { tipo: 'aberta'; fazer: string; nota: string | null }
  | { tipo: 'pedida'; frase: string; pedido: string }
  | { tipo: 'feita'; frase: string; pedido: string }
  | { tipo: 'manual' };

export type RecomendacaoDoAviso = {
  id: string;
  /** O título sem o "Sugestão do Gestor de tráfego:" (quem recomenda já está no selo do cartão). */
  titulo: string;
  /** "Sugerir", ou "Aprovação" quando o pedido em andamento é dele. */
  modo: 'Sugerir' | 'Aprovação';
  estado: EstadoDaRecomendacao;
  /** O que a gaveta do pedido precisa para abrir já com a mudança recomendada; nulo quando não dá para pedir por aqui. */
  pedir: { campanha: { id: string; nome: string; provider: string }; acao: 'verba' | 'pausar'; valorMicros: number | null } | null;
};

const PREFIXO_DA_SUGESTAO = 'Sugestão do Gestor de tráfego: ';
const ANDANDO = new Set(['aguardando_aprovacao', 'aprovada', 'executando']);
/** "hoje, às 06:31", "ontem, às 06:31", "05/10, às 06:31". */
const quandoFalado = (iso: string, agora: Date): string => quandoComHora(iso, agora).replace(', ', ', às ');
const aPlataforma = (provider: string | null): string => (provider === 'meta_ads' ? 'a Meta' : provider === 'google_ads' ? 'o Google' : 'a plataforma');
const naPlataforma = (provider: string | null): string => (provider === 'meta_ads' ? 'na Meta' : provider === 'google_ads' ? 'no Google' : 'na plataforma');

/**
 * O cartão da recomendação (protótipo P9): o que ele diz e o que oferece, conforme o que o servidor mandou. Aberta e
 * com o pedido pronto, "Pedir esta mudança" e "Agora não"; com um pedido dela andando, quem pediu e "Ver o pedido";
 * executada, o que foi feito; sem como pedir por aqui (quem só lê, escrita desligada, plataforma que o Liame só lê),
 * fica o texto do aviso. `eu`: quem está na tela, para dizer "Você pediu". Nulo quando o aviso não é uma sugestão dele.
 */
export function recomendacaoDoAviso(item: AttentionItem, eu: string | null, agora: Date): RecomendacaoDoAviso | null {
  const r = item.recommendation;
  if (!r) return null;
  const titulo = item.title.startsWith(PREFIXO_DA_SUGESTAO) ? item.title.charAt(PREFIXO_DA_SUGESTAO.length).toLocaleUpperCase('pt-BR') + item.title.slice(PREFIXO_DA_SUGESTAO.length + 1) : item.title;
  const verba = r.request?.params.daily_budget_micros;
  const pedir =
    r.request && item.campaign_id
      ? {
          campanha: { id: item.campaign_id, nome: r.campaign_name, provider: r.request.provider },
          acao: r.request.tool === 'campanha_pausar' ? ('pausar' as const) : ('verba' as const),
          valorMicros: typeof verba === 'number' ? verba : null,
        }
      : null;
  const a = r.action;
  const doGestor = Boolean(a?.agent_key);
  const base = { id: r.id, titulo, pedir };

  if (a && ANDANDO.has(a.status)) {
    const quem = doGestor ? `O Gestor de tráfego pediu esta mudança ${quandoFalado(a.created_at, agora)}.` : a.requested_by === eu ? 'Você pediu esta mudança.' : 'Esta mudança já foi pedida.';
    const situacao =
      a.status === 'aguardando_aprovacao'
        ? `O pedido espera a aprovação com o código do app; nada mudou ${naPlataforma(item.provider)}.`
        : 'O pedido foi aprovado, e o Liame executa em instantes.';
    return { ...base, modo: doGestor ? 'Aprovação' : 'Sugerir', estado: { tipo: 'pedida', frase: `${quem} ${situacao}`, pedido: a.id } };
  }
  if (a?.status === 'executada') {
    return { ...base, modo: doGestor ? 'Aprovação' : 'Sugerir', estado: { tipo: 'feita', frase: 'O pedido desta mudança foi aprovado e executado pelo Liame.', pedido: a.id } };
  }
  if (!pedir) return { ...base, modo: 'Sugerir', estado: { tipo: 'manual' } };
  // O pedido que não foi adiante, ou a tentativa dele que não deu certo: a pessoa ainda pode pedir.
  let nota: string | null = null;
  if (a?.status === 'cancelada') nota = 'O último pedido desta mudança foi recusado ou cancelado.';
  else if (a?.status === 'expirada') nota = 'O último pedido desta mudança expirou sem aprovação.';
  else if (a?.status === 'falhou') nota = 'O último pedido desta mudança foi aprovado, mas não foi executado.';
  else if (r.not_requested) nota = `O Gestor de tráfego tentou pedir esta mudança ${quandoFalado(r.not_requested.at, agora)} e não conseguiu: ${r.not_requested.detail}`;
  return {
    ...base,
    modo: 'Sugerir',
    estado: { tipo: 'aberta', fazer: `se concordar, peça a mudança. Ela ainda passa pela aprovação com o código do app, e ${aPlataforma(item.provider)} confere antes.`, nota },
  };
}

/** O aviso depois do "Agora não" (protótipo P9). */
export const AVISO_DE_DISPENSADA = 'Certo. O Gestor de tráfego registra que você não quis esta mudança.';

/** A recusa do servidor ao dispensar, em palavras; `recarregar`: a lista mudou por baixo. */
export function erroAoDispensar(p: { code: string; detail?: string; title: string }): { texto: string; recarregar: boolean } {
  if (p.code === 'recomendacao-ja-pedida') return { texto: 'Esta mudança já foi pedida: para não seguir com ela, recuse ou cancele o pedido em Aprovações.', recarregar: true };
  if (p.code === 'recomendacao-encerrada' || p.code === 'nao-encontrado') return { texto: 'Esta recomendação não está mais em aberto.', recarregar: true };
  return { texto: p.detail ?? p.title, recarregar: false };
}

const PESO: Record<Gravidade, number> = { critica: 0, atencao: 1, info: 2 };

/**
 * Os avisos de mídia e os do ciclo fechado numa lista só: mais grave primeiro; na mesma gravidade, os de mídia
 * antes (cada API já manda os dela na ordem).
 */
export function juntarAvisos<T extends Pick<AttentionItem, 'severity'>>(midia: T[], ciclo: T[]): T[] {
  return [...midia, ...ciclo]
    .map((item, i) => ({ item, i }))
    .sort((a, b) => PESO[gravidadeDe(a.item.severity)] - PESO[gravidadeDe(b.item.severity)] || a.i - b.i)
    .map((x) => x.item);
}
