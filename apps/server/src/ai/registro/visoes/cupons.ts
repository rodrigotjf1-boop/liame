import type { CouponItem, CouponListResponse } from '@liame/contracts';
import { dinheiro, inteiro, soOQueExiste } from '../formatos.js';
import { frescorDe, plataforma, quando } from '../leituras.visoes.js';

// Cupons de campanha para o modelo: os da rota `GET /v1/coupons`, formatados. Sem o nome de quem pediu
// ou recusou um cupom: pessoa da equipe não vai ao modelo (D-A3-4).

export const CUPONS_MAXIMO = 50;

function regra(c: CouponItem): string | null {
  if (c.kind === 'percentual' && c.percent !== null) return `${String(c.percent).replace('.', ',')}% de desconto`;
  if (c.kind === 'valor' && c.value_micros !== null) return `${dinheiro(c.value_micros)} de desconto`;
  if (c.kind === 'frete_gratis') return 'frete grátis';
  return null;
}

export function visaoDosCupons(r: CouponListResponse) {
  const fusoDaLoja = new Map(r.stores.map((s) => [s.connected_account_id, s.timezone]));
  const fuso = (conta: string) => fusoDaLoja.get(conta) ?? 'America/Sao_Paulo';
  return {
    lojas: r.stores.map((s) =>
      soOQueExiste({
        loja: s.unit?.name ?? s.store_name,
        plataforma_de_pedidos: s.order_platform,
        leitura_dos_cupons: frescorDe(s.coupons_freshness),
        ultima_leitura: quando(s.coupons_read_at, s.timezone),
        falha_na_leitura: s.coupons_error,
        liame_pode_criar_cupom_nesta_loja: s.can_create,
      }),
    ),
    total_de_cupons: r.items.length,
    cupons: r.items.slice(0, CUPONS_MAXIMO).map((c) =>
      soOQueExiste({
        codigo: c.code,
        origem: c.origin === 'regem' ? 'Regem' : (c.platform ?? 'outra plataforma'),
        regra: regra(c),
        pedido_minimo: c.min_order_micros && c.min_order_micros !== '0' ? dinheiro(c.min_order_micros) : null,
        desconto_maximo: dinheiro(c.max_discount_micros),
        situacao: c.expired ? 'vencido' : c.active ? 'ativo' : 'inativo',
        valido_ate: quando(c.valid_until, fuso(c.connected_account_id)),
        usos_em_7_dias: inteiro(c.uses_7d),
        receita_em_7_dias: dinheiro(c.revenue_7d_micros),
        campanha: c.link
          ? soOQueExiste({
              nome: c.link.campaign.name,
              plataforma: plataforma(c.link.campaign.provider),
              situacao: c.link.campaign.status,
              // Só o exclusivo prova de onde veio o pedido.
              exclusivo: c.link.exclusive,
              gasto_em_7_dias: dinheiro(c.link.campaign_spend_7d_micros),
            })
          : null,
      }),
    ),
    pedidos_de_criacao: r.requests.map((p) =>
      soOQueExiste({
        codigo: p.code,
        situacao: p.status,
        // O motivo da recusa traz o nome de quem recusou: fica de fora.
        motivo: p.status === 'recusada' ? null : p.status_reason,
        campanha: p.campaign?.name ?? null,
        exclusivo: p.exclusive,
        pedido_em: quando(p.requested_at, fuso(p.connected_account_id)),
      }),
    ),
    criar_cupom_pelo_liame: r.create_in_regem ? 'ligado' : 'desligado',
  };
}
