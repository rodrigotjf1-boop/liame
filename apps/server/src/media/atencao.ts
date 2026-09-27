// "Atenção de mídia" (A2, G9; plano-a2 §2): regras simples e explicáveis sobre os dados da própria
// empresa. Cada regra devolve o motivo em linguagem de gente e o que fazer. Sem IA na A2.

export type Severidade = 'critica' | 'atencao' | 'info';

export type ItemAtencao = {
  kind: 'conta_desconectada' | 'conta_sem_permissao' | 'conta_com_erro' | 'dado_atrasado' | 'reconectar_em_breve' | 'gasto_fora_do_normal' | 'campanha_parou' | 'versao_api';
  severity: Severidade;
  title: string;
  detail: string;
  action: string;
  connected_account_id: string | null;
  campaign_id: string | null;
  provider: string | null;
};

const NOMES: Record<string, string> = { meta_ads: 'Meta Ads', google_ads: 'Google Ads', ga4: 'GA4' };
export const nomePlataforma = (p: string) => NOMES[p] ?? p;

const moeda = (valor: number, codigo: string | null) => {
  try {
    return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: codigo ?? 'BRL' }).format(valor);
  } catch {
    return valor.toFixed(2);
  }
};

const mediana = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/** Mínimo de dias com dado para comparar gasto (sem histórico, não há "normal"). */
const DIAS_MINIMOS = 7;
/** Gasto de ontem acima de 2× ou abaixo de 30% da mediana dos 14 dias anteriores. */
const ACIMA = 2;
const ABAIXO = 0.3;
/** Campanha com média de ao menos 100 impressões por dia na semana anterior. */
const MEDIA_MINIMA_IMPRESSOES = 100;

/**
 * Gasto fora do normal: ontem × mediana dos 14 dias anteriores da conta. Dia sem linha conta como zero
 * (a leitura grava o zero); conta sem histórico suficiente fica de fora.
 */
export function gastoForaDoNormal(
  conta: { id: string; name: string; provider: string; currency: string | null },
  gastoPorDia: Map<string, number>,
  ontem: string,
): ItemAtencao | null {
  const anteriores: number[] = [];
  const base = Date.parse(`${ontem}T00:00:00Z`);
  for (let i = 1; i <= 14; i++) {
    const dia = new Date(base - i * 86_400_000).toISOString().slice(0, 10);
    if (gastoPorDia.has(dia)) anteriores.push(gastoPorDia.get(dia)!);
  }
  if (anteriores.length < DIAS_MINIMOS) return null;
  const normal = mediana(anteriores);
  const valor = gastoPorDia.get(ontem) ?? 0;
  if (normal <= 0) return null;
  const alto = valor > normal * ACIMA;
  const baixo = valor < normal * ABAIXO;
  if (!alto && !baixo) return null;
  return {
    kind: 'gasto_fora_do_normal',
    severity: alto ? 'critica' : 'atencao',
    title: alto ? `Gasto alto ontem em ${conta.name}` : `Gasto baixo ontem em ${conta.name}`,
    detail: `${moeda(valor, conta.currency)} ontem; o normal dos últimos 14 dias é ${moeda(normal, conta.currency)} por dia (${nomePlataforma(conta.provider)}).`,
    action: alto ? 'Confira orçamentos e lances alterados recentemente.' : 'Confira se alguma campanha foi pausada, reprovada ou ficou sem saldo.',
    connected_account_id: conta.id,
    campaign_id: null,
    provider: conta.provider,
  };
}

/** Campanha ativa que entregava (média de 100+ impressões por dia na semana anterior) e ontem não entregou. */
export function campanhaParou(
  campanha: { id: string; name: string; connectedAccountId: string; provider: string },
  impressoesPorDia: Map<string, number>,
  ontem: string,
): ItemAtencao | null {
  const base = Date.parse(`${ontem}T00:00:00Z`);
  let soma = 0;
  for (let i = 1; i <= 7; i++) soma += impressoesPorDia.get(new Date(base - i * 86_400_000).toISOString().slice(0, 10)) ?? 0;
  const media = soma / 7;
  if (media < MEDIA_MINIMA_IMPRESSOES || (impressoesPorDia.get(ontem) ?? 0) > 0) return null;
  return {
    kind: 'campanha_parou',
    severity: 'critica',
    title: `A campanha "${campanha.name}" parou de entregar`,
    detail: `Nenhuma impressão ontem; na semana anterior eram ${Math.round(media).toLocaleString('pt-BR')} por dia em média (${nomePlataforma(campanha.provider)}).`,
    action: 'Veja na plataforma se há anúncio reprovado, orçamento esgotado ou forma de pagamento recusada.',
    connected_account_id: campanha.connectedAccountId,
    campaign_id: campanha.id,
    provider: campanha.provider,
  };
}

const ORDEM: Record<Severidade, number> = { critica: 0, atencao: 1, info: 2 };

/** Dentro da mesma gravidade: sem dado nenhum, depois dinheiro e entrega, depois o resto. */
const PRIORIDADE: ItemAtencao['kind'][] = [
  'conta_desconectada',
  'campanha_parou',
  'gasto_fora_do_normal',
  'conta_sem_permissao',
  'conta_com_erro',
  'dado_atrasado',
  'reconectar_em_breve',
  'versao_api',
];

/** Mais grave primeiro; na mesma gravidade, pela prioridade do tipo; no mesmo tipo, na ordem em que veio. */
export function ordenar(itens: ItemAtencao[]): ItemAtencao[] {
  return itens
    .map((item, i) => ({ item, i }))
    .sort((a, b) => ORDEM[a.item.severity] - ORDEM[b.item.severity] || PRIORIDADE.indexOf(a.item.kind) - PRIORIDADE.indexOf(b.item.kind) || a.i - b.i)
    .map((x) => x.item);
}
