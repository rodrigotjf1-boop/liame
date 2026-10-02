import type { EntregaDeMidia } from '../../../media/media.service.js';
import { decimal, dia, dinheiroDecimal, soOQueExiste } from '../formatos.js';
import { plataforma } from '../leituras.visoes.js';

// Entrega de mídia para o modelo: por campanha e por dia, com as razões (CTR, custo por clique, custo por
// mil impressões) já calculadas pelo `MediaService`. O que depende de janela de atribuição (conversões,
// valor, ROAS) está nos resultados do ciclo fechado.

export function visaoDaEntrega(r: EntregaDeMidia) {
  return {
    periodo: { de: dia(r.from), ate: dia(r.to) },
    campanhas: r.campaigns.map((c) =>
      soOQueExiste({
        plataforma: plataforma(c.provider),
        campanha: c.name,
        situacao: c.status,
        investimento: dinheiroDecimal(c.spend, c.currency),
        impressoes: decimal(c.impressions),
        cliques: decimal(c.clicks),
        cliques_no_link: decimal(c.link_clicks),
        ctr: c.ctr_pct ? `${decimal(c.ctr_pct)}%` : null,
        custo_por_clique: dinheiroDecimal(c.cpc, c.currency),
        custo_por_mil_impressoes: dinheiroDecimal(c.cpm, c.currency),
      }),
    ),
    por_dia: r.days.map((d) => soOQueExiste({ dia: dia(d.date), investimento: dinheiroDecimal(d.spend, d.currency), impressoes: decimal(d.impressions), cliques: decimal(d.clicks) })),
  };
}
