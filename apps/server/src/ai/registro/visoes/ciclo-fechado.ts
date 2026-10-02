import type { ClosedLoopResponse, ConfirmedResult, PlatformReport } from '@liame/contracts';
import { decimal, dia, dinheiro, inteiro, porcento, razao, soOQueExiste } from '../formatos.js';
import { frescorDe, plataforma, quando } from '../leituras.visoes.js';

// Resultados do ciclo fechado para o modelo: o que a plataforma informa (com a janela dela) ao lado do
// que o caixa confirma (com o modelo de atribuição), nunca misturados. Os números são os da rota
// `GET /v1/results/closed-loop`, só formatados.

/** Campanhas entregues ao modelo, as de maior investimento primeiro. */
export const CAMPANHAS_MAXIMO = 20;

const RESULTADO: Record<string, string> = { lucro: 'lucro', empata: 'empata', prejuizo: 'prejuízo' };
const JANELA: Record<string, string> = {
  '7d_click': '7 dias depois do clique',
  '1d_click': '1 dia depois do clique',
  '1d_view': '1 dia depois da visualização',
  padrao: 'a janela de cada conversão (padrão da plataforma)',
};

const informado = (p: PlatformReport, moeda: string) =>
  soOQueExiste({
    investimento: dinheiro(p.spend_micros, moeda),
    valor_de_venda: dinheiro(p.value_micros, moeda),
    roas: razao(p.roas),
    janela: JANELA[p.window] ?? p.window,
    conversoes: decimal(p.conversions),
    conversas: decimal(p.conversations),
    custo_por_conversa: dinheiro(p.cost_per_conversation_micros, moeda),
  });

const confirmado = (c: ConfirmedResult, moeda: string) =>
  soOQueExiste({
    pedidos: inteiro(c.orders),
    receita: dinheiro(c.revenue_micros, moeda),
    roas: razao(c.roas),
    custo_por_pedido: dinheiro(c.cost_per_order_micros, moeda),
    margem_conhecida: dinheiro(c.margin_known_micros, moeda),
    parte_da_receita_com_margem_conhecida: porcento(c.margin_coverage_pct),
    resultado: c.verdict ? (RESULTADO[c.verdict] ?? c.verdict) : null,
  });

export function visaoDoCicloFechado(r: ClosedLoopResponse) {
  const moeda = r.currency;
  const fuso = r.period.timezone;
  const campanhas = [...r.campaigns].sort((a, b) => {
    const [ga, gb] = [BigInt(a.platform.spend_micros), BigInt(b.platform.spend_micros)];
    return ga === gb ? a.name.localeCompare(b.name) : gb > ga ? 1 : -1;
  });
  const t = r.totals;
  return {
    periodo: soOQueExiste({
      de: dia(r.period.from),
      ate: dia(r.period.to),
      fuso_da_loja: fuso,
      // Só aparece quando alguma conta de anúncio corta o dia em outro fuso.
      fusos_das_contas_de_anuncio: r.period.account_timezones.some((z) => z !== fuso) ? r.period.account_timezones : null,
    }),
    atribuicao: { modelo: r.model.key, janela_em_dias: r.model.window_days, conta_visualizacao: r.model.counts_views },
    totais: {
      investimento: dinheiro(t.spend_micros, moeda),
      pedidos_confirmados: inteiro(t.orders_confirmed),
      receita_confirmada: dinheiro(t.revenue_micros, moeda),
      com_origem_provada: confirmado(t.confirmed, moeda),
      sem_origem: soOQueExiste({ pedidos: inteiro(t.without_origin.orders), receita: dinheiro(t.without_origin.revenue_micros, moeda), parte_dos_pedidos_com_clique: porcento(t.without_origin.share_pct) }),
      canais_sem_clique: t.no_click_channels.map((c) => ({ canal: c.channel_group, pedidos: inteiro(c.orders), receita: dinheiro(c.revenue_micros, moeda) })),
      cancelados_depois: { pedidos: inteiro(t.cancelled.orders), receita: dinheiro(t.cancelled.revenue_micros, moeda) },
    },
    plataformas: r.platforms.map((p) => ({
      plataforma: plataforma(p.provider),
      plataforma_informa: informado(p.platform, moeda),
      caixa_confirma: confirmado(p.confirmed, moeda),
      pedidos_provados_so_na_plataforma: inteiro(p.platform_only_orders),
    })),
    campanhas: campanhas.slice(0, CAMPANHAS_MAXIMO).map((c) => ({
      plataforma: plataforma(c.provider),
      campanha: c.name,
      situacao: c.status,
      plataforma_informa: informado(c.platform, moeda),
      caixa_confirma: confirmado(c.confirmed, moeda),
    })),
    ...(campanhas.length > CAMPANHAS_MAXIMO ? { campanhas_fora_da_lista: campanhas.length - CAMPANHAS_MAXIMO } : {}),
    fontes: r.sources.map((s) =>
      soOQueExiste({ plataforma: plataforma(s.provider), conta: s.name, dados: s.dataset, frescor: frescorDe(s.freshness), ultima_leitura: quando(s.last_success_at, fuso), situacao: s.status }),
    ),
  };
}
