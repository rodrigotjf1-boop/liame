import type { AttentionItem, ClosedLoopResponse, SourceFreshness, WeeklyReviewCampaign, WeeklyReviewChange } from '@liame/contracts';
import { dinheiro } from '../ai/registro/formatos.js';
import { diaNoFuso, menosDias } from './fora-do-normal.js';

// A revisão da semana (A3, I7; protótipo P4), em funções puras: qual é a semana fechada, o que mudou sobre a
// semana anterior e o que precisa de decisão. Os números são os da tela Resultados (`closedLoop`) nas duas
// semanas; aqui só se compara, em inteiros (micros, contagens, centésimos), sem ponto flutuante. A leitura
// em texto (da LIA ou do sistema) é do Explicar.

/** Versão do conteúdo guardado em `weekly_review.content` (contrato `WeeklyReview`). */
export const REVISAO_VERSAO = 1;
/** A revisão sai na segunda-feira, a partir desta hora, no fuso da loja (D-A3-7). */
export const HORA_DE_GERAR = 5;
/** Com a leitura de hoje ainda sem chegar, a revisão espera até esta hora; depois, sai com o que há. */
export const HORA_LIMITE = 9;
/** O e-mail não sai antes desta hora. */
export const HORA_DO_EMAIL = 7;
/** A revisão de uma semana só é gerada (ou enviada) enquanto a semana seguinte não acabou. */
export const DIAS_DE_VALIDADE = 7;
/** Variação mínima do ROAS de uma campanha para entrar em "melhorou" ou "piorou": 5%. */
export const MUDANCA_MINIMA_POR_MIL = 50n;
/** Quantas campanhas entram em cada lista, no máximo (as de maior investimento primeiro). */
export const CAMPANHAS_POR_LISTA = 3;
/** Quantos itens em "Precisa de decisão", no máximo. */
export const DECISOES_MAXIMO = 5;

const DIA_MS = 86_400_000;

/** 1 = segunda … 7 = domingo, de uma data AAAA-MM-DD. */
export function diaIso(dia: string): number {
  return new Date(`${dia}T00:00:00Z`).getUTCDay() || 7;
}

export const maisDias = (dia: string, n: number) => new Date(Date.parse(`${dia}T00:00:00Z`) + n * DIA_MS).toISOString().slice(0, 10);

/** A última semana fechada (de segunda a domingo) antes do dia dado: numa quarta, é a que acabou no domingo. */
export function semanaFechada(hoje: string): { from: string; to: string } {
  const domingo = menosDias(hoje, diaIso(hoje));
  return { from: menosDias(domingo, 6), to: domingo };
}

/** A semana logo antes de uma semana. */
export function semanaAnterior(semana: { from: string; to: string }): { from: string; to: string } {
  return { from: menosDias(semana.from, 7), to: menosDias(semana.from, 1) };
}

/** A segunda-feira em que a revisão de uma semana sai. */
export const diaDaRevisao = (semana: { from: string; to: string }) => maisDias(semana.to, 1);

/**
 * A segunda-feira em que sai a próxima revisão: hoje, se é segunda e a desta semana ainda não saiu; senão,
 * a segunda seguinte.
 */
export function proximaRevisao(hoje: string, ultimaSemanaComRevisao: string | null): string {
  const fechada = semanaFechada(hoje);
  const ehSegunda = diaIso(hoje) === 1;
  if (ehSegunda && ultimaSemanaComRevisao !== fechada.from) return hoje;
  return maisDias(hoje, 8 - diaIso(hoje));
}

/** A hora (0 a 23) de um instante no fuso dado. */
export function horaNoFuso(agora: Date, fuso: string): number {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone: fuso, hour: '2-digit', hourCycle: 'h23' }).format(agora));
}

/** A conta de anúncio já foi lida depois do fim da semana? Só essa leitura traz o domingo inteiro. */
const lidaDepoisDaSemana = (s: SourceFreshness, semana: { from: string; to: string }, fuso: string): boolean =>
  s.last_success_at !== null && diaNoFuso(s.last_success_at, fuso) >= diaDaRevisao(semana);

/**
 * Os números da semana estão completos? Toda fonte dentro do prazo e, nas contas de anúncio, uma leitura
 * feita depois do fim da semana.
 */
export function semanaEmDia(fontes: SourceFreshness[], semana: { from: string; to: string }, fuso: string): boolean {
  return fontes.length > 0 && fontes.every((s) => s.freshness === 'fresh' && (s.dataset !== 'metricas' || lidaDepoisDaSemana(s, semana, fuso)));
}

/**
 * Os mesmos resultados, com a conta de anúncio que ainda não foi lida depois do fim da semana marcada como
 * atrasada: pelo prazo normal ela está "em dia", mas o domingo dela pode estar incompleto. É o que a
 * leitura da semana recebe quando a revisão sai sem esperar mais: com fonte atrasada, a LIA não é chamada.
 */
export function comAtrasoMarcado(atual: ClosedLoopResponse, semana: { from: string; to: string }, fuso: string): ClosedLoopResponse {
  return {
    ...atual,
    sources: atual.sources.map((s) => (s.dataset === 'metricas' && s.freshness === 'fresh' && !lidaDepoisDaSemana(s, semana, fuso) ? { ...s, freshness: 'delayed' } : s)),
  };
}

/** As fontes que a revisão precisa: as vendas (Regem) e pelo menos uma conta de anúncio. */
export function temAsFontes(fontes: SourceFreshness[]): boolean {
  return fontes.some((s) => s.provider === 'regem') && fontes.some((s) => s.dataset === 'metricas');
}

/** Houve o que revisar? Investimento ou pedido confirmado em alguma das duas semanas. */
export function temMovimento(atual: ClosedLoopResponse, anterior: ClosedLoopResponse | null): boolean {
  const de = (r: ClosedLoopResponse | null) => r !== null && (BigInt(r.totals.spend_micros) > 0n || r.totals.orders_confirmed > 0);
  return de(atual) || de(anterior);
}

// ------------------------------------------------------------ o que mudou

/** Variação com sinal e uma casa ("+12.8", "-34.2", "0.0"); nula quando não havia nada antes. */
export function variacaoPct(agora: bigint, antes: bigint): string | null {
  if (antes <= 0n) return null;
  const milesimos = (agora - antes) * 1000n;
  const negativo = milesimos < 0n;
  const absoluto = negativo ? -milesimos : milesimos;
  const decimos = (absoluto + antes / 2n) / antes;
  const texto = `${decimos / 10n}.${decimos % 10n}`;
  return decimos === 0n ? texto : `${negativo ? '-' : '+'}${texto}`;
}

/** "3.80" → 380n (centésimos); nulo fica nulo. */
const centesimos = (r: string | null): bigint | null => (r === null ? null : BigInt(r.replace('.', '')));

type Campanha = WeeklyReviewChange['campaign'];
const emDinheiro = (kind: string, agora: string, antes: string | null, campaign: Campanha = null): WeeklyReviewChange => ({
  kind,
  campaign,
  unit: 'dinheiro',
  before: antes,
  now: agora,
  change_pct: antes === null ? null : variacaoPct(BigInt(agora), BigInt(antes)),
});
const emContagem = (kind: string, agora: number, antes: number | null, campaign: Campanha = null): WeeklyReviewChange => ({
  kind,
  campaign,
  unit: 'contagem',
  before: antes === null ? null : String(antes),
  now: String(agora),
  change_pct: antes === null ? null : variacaoPct(BigInt(agora), BigInt(antes)),
});
const emRazao = (kind: string, agora: string | null, antes: string | null, campaign: Campanha = null): WeeklyReviewChange => {
  const [a, b] = [centesimos(agora), centesimos(antes)];
  return { kind, campaign, unit: 'razao', before: antes, now: agora, change_pct: a === null || b === null ? null : variacaoPct(a, b) };
};

/** Os quatro números do topo, cada um ao lado do da semana anterior. */
export function totaisDaSemana(atual: ClosedLoopResponse, anterior: ClosedLoopResponse | null): WeeklyReviewChange[] {
  const [t, a] = [atual.totals, anterior?.totals ?? null];
  return [
    emDinheiro('investimento', t.spend_micros, a?.spend_micros ?? null),
    emContagem('pedidos_de_anuncios', t.confirmed.orders, a?.confirmed.orders ?? null),
    emDinheiro('receita_confirmada', t.confirmed.revenue_micros, a?.confirmed.revenue_micros ?? null),
    emRazao('roas_confirmado', t.confirmed.roas, a?.confirmed.roas ?? null),
  ];
}

/** Para onde o número foi: compara os valores, não a porcentagem (de zero para doze também é subir). */
function direcao(m: WeeklyReviewChange): 'subiu' | 'caiu' | 'igual' {
  if (m.before === null || m.now === null) return 'igual';
  const [agora, antes] = [BigInt(m.now), BigInt(m.before)];
  return agora > antes ? 'subiu' : agora < antes ? 'caiu' : 'igual';
}

/**
 * "O que melhorou" e "O que piorou" sobre a semana anterior: pedidos de anúncios e receita confirmada que
 * subiram ou caíram; o ROAS no caixa das campanhas que mudou pelo menos 5% (as de maior investimento
 * primeiro, até três por lista); e os pedidos sem origem (subir é piorar). Sem semana anterior, nada.
 */
export function oQueMudou(atual: ClosedLoopResponse, anterior: ClosedLoopResponse | null): { improved: WeeklyReviewChange[]; worsened: WeeklyReviewChange[] } {
  const improved: WeeklyReviewChange[] = [];
  const worsened: WeeklyReviewChange[] = [];
  if (!anterior || !temMovimento(anterior, null)) return { improved, worsened };

  const [pedidos, receita] = [
    emContagem('pedidos_de_anuncios', atual.totals.confirmed.orders, anterior.totals.confirmed.orders),
    emDinheiro('receita_confirmada', atual.totals.confirmed.revenue_micros, anterior.totals.confirmed.revenue_micros),
  ];
  for (const m of [pedidos, receita]) {
    const para = direcao(m);
    if (para === 'subiu') improved.push(m);
    else if (para === 'caiu') worsened.push(m);
  }

  const antes = new Map(anterior.campaigns.map((c) => [c.campaign_id, c]));
  const campanhas = [...atual.campaigns].sort((x, y) => {
    const [gx, gy] = [BigInt(x.platform.spend_micros), BigInt(y.platform.spend_micros)];
    return gx === gy ? x.name.localeCompare(y.name) : gy > gx ? 1 : -1;
  });
  const [melhores, piores]: [WeeklyReviewChange[], WeeklyReviewChange[]] = [[], []];
  for (const c of campanhas) {
    const [agora, era] = [centesimos(c.confirmed.roas), centesimos(antes.get(c.campaign_id)?.confirmed.roas ?? null)];
    if (agora === null || era === null || era <= 0n) continue;
    const diferenca = agora - era;
    if ((diferenca < 0n ? -diferenca : diferenca) * 1000n < MUDANCA_MINIMA_POR_MIL * era) continue;
    const m = emRazao('roas_da_campanha', c.confirmed.roas, antes.get(c.campaign_id)!.confirmed.roas, { id: c.campaign_id, name: c.name, provider: c.provider });
    (diferenca > 0n ? melhores : piores).push(m);
  }
  improved.push(...melhores.slice(0, CAMPANHAS_POR_LISTA));
  worsened.push(...piores.slice(0, CAMPANHAS_POR_LISTA));

  // Pedido sem origem é venda que não dá para ligar a campanha nenhuma: subir é piorar.
  const semOrigem = emContagem('pedidos_sem_origem', atual.totals.without_origin.orders, anterior.totals.without_origin.orders);
  const para = direcao(semOrigem);
  if (para === 'caiu') improved.push(semOrigem);
  else if (para === 'subiu') worsened.push(semOrigem);
  return { improved, worsened };
}

// ------------------------------------------------------------ a tabela das campanhas

/** As campanhas com investimento ou pedido na semana, a de maior investimento primeiro. */
export function campanhasDaSemana(atual: ClosedLoopResponse): WeeklyReviewCampaign[] {
  return atual.campaigns
    .filter((c) => BigInt(c.platform.spend_micros) > 0n || c.confirmed.orders > 0)
    .sort((x, y) => {
      const [gx, gy] = [BigInt(x.platform.spend_micros), BigInt(y.platform.spend_micros)];
      return gx === gy ? x.name.localeCompare(y.name) : gy > gx ? 1 : -1;
    })
    .map((c) => ({
      campaign_id: c.campaign_id,
      provider: c.provider,
      name: c.name,
      status: c.status,
      spend_micros: c.platform.spend_micros,
      orders: c.confirmed.orders,
      revenue_micros: c.confirmed.revenue_micros,
      roas: c.confirmed.roas,
      verdict: c.confirmed.verdict,
    }));
}

/**
 * Pedidos provados só na plataforma (id de clique sem a campanha): contam no total da plataforma, fora das
 * campanhas. A receita deles é a da plataforma menos a das campanhas dela; nula se a conta não fecha.
 */
export function soNaPlataforma(atual: ClosedLoopResponse): Array<{ provider: string; orders: number; revenue_micros: string | null }> {
  return atual.platforms
    .filter((p) => p.platform_only_orders > 0)
    .map((p) => {
      const dasCampanhas = atual.campaigns.filter((c) => c.provider === p.provider).reduce((s, c) => s + BigInt(c.confirmed.revenue_micros), 0n);
      const resto = BigInt(p.confirmed.revenue_micros) - dasCampanhas;
      return { provider: p.provider, orders: p.platform_only_orders, revenue_micros: resto >= 0n ? resto.toString() : null };
    });
}

// ------------------------------------------------------------ o que precisa de decisão

const GRAVIDADE = ['critica', 'atencao'];

/**
 * "Precisa de decisão": a campanha que deu prejuízo nesta semana e na anterior (pela regra do veredito da
 * tela Resultados) e os avisos críticos e de atenção que estavam ativos na geração, os mais graves
 * primeiro. O Liame aponta; quem decide é a pessoa.
 */
export function precisaDeDecisao(atual: ClosedLoopResponse, anterior: ClosedLoopResponse | null, avisos: AttentionItem[], brandId: string): AttentionItem[] {
  const antes = new Map((anterior?.campaigns ?? []).map((c) => [c.campaign_id, c]));
  const naOrdem = new Map(campanhasDaSemana(atual).map((c, i) => [c.campaign_id, i]));
  const emPrejuizo = atual.campaigns
    .filter((c) => naOrdem.has(c.campaign_id) && c.confirmed.verdict === 'prejuizo' && antes.get(c.campaign_id)?.confirmed.verdict === 'prejuizo')
    .sort((x, y) => naOrdem.get(x.campaign_id)! - naOrdem.get(y.campaign_id)!)
    .map((c): AttentionItem => {
      // O prejuízo é pela margem, não pela receita: a receita pode passar do investimento e a margem dos
      // pedidos (preço menos custo) não pagar o anúncio. O texto diz quanto faltou, como a tela Resultados.
      const investido = BigInt(c.platform.spend_micros);
      const margem = c.confirmed.margin_known_micros === null ? null : BigInt(c.confirmed.margin_known_micros);
      const valores = `${dinheiro(c.confirmed.revenue_micros, atual.currency)} de receita para ${dinheiro(c.platform.spend_micros, atual.currency)} investidos na semana`;
      return {
        kind: 'prejuizo_seguido',
        severity: 'atencao',
        title: `${c.name} deu prejuízo nas duas últimas semanas`,
        detail:
          margem !== null && margem < investido
            ? `Faltaram ${dinheiro((investido - margem).toString(), atual.currency)} para a margem dos pedidos pagar o anúncio: ${valores}.`
            : `${valores}.`,
        action: 'Veja a campanha em Resultados e decida se ela continua como está.',
        connected_account_id: null,
        campaign_id: c.campaign_id,
        provider: c.provider,
        brand_id: brandId,
      };
    });
  const ordem = (i: AttentionItem) => GRAVIDADE.indexOf(i.severity);
  const ativos = avisos.filter((i) => GRAVIDADE.includes(i.severity)).sort((a, b) => ordem(a) - ordem(b));
  return [...emPrejuizo, ...ativos].slice(0, DECISOES_MAXIMO);
}
