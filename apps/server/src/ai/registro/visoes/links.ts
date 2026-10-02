import type { TrackingCheckResponse, TrackingLinkListResponse } from '@liame/contracts';
import { inteiro, soOQueExiste } from '../formatos.js';
import { plataforma } from '../leituras.visoes.js';

// Links de campanha e a conferência do rastreio dos anúncios para o modelo (rotas `GET /v1/links` e
// `GET /v1/links/tracking-check`). Sem endereços: o modelo não precisa deles, e link montado pelo
// modelo nunca volta para a tela (`ai-architecture.md` §6).

export const LINKS_MAXIMO = 40;
export const ANUNCIOS_MAXIMO = 20;

export function visaoDosLinks(lista: TrackingLinkListResponse, conferencia: TrackingCheckResponse) {
  const s = conferencia.summary;
  return {
    rastreio_dos_anuncios: {
      anuncios_ativos: inteiro(s.active_ads),
      com_rastreio: inteiro(s.with_tracking),
      sem_rastreio: inteiro(s.without_tracking),
      nao_verificados: inteiro(s.not_verifiable),
      fora_da_conferencia: inteiro(s.not_applicable),
    },
    anuncios_para_arrumar: conferencia.items.slice(0, ANUNCIOS_MAXIMO).map((i) => ({
      situacao: i.status,
      motivo: i.reason,
      plataforma: plataforma(i.provider),
      campanha: i.campaign.name,
      anuncio: i.ad.name,
      detalhe: i.detail,
      o_que_fazer: i.action,
    })),
    ...(conferencia.items.length > ANUNCIOS_MAXIMO ? { anuncios_fora_da_lista: conferencia.items.length - ANUNCIOS_MAXIMO } : {}),
    total_de_links: lista.items.length,
    links: lista.items.slice(0, LINKS_MAXIMO).map((l) =>
      soOQueExiste({
        nome: l.name,
        loja: l.unit?.name ?? null,
        plataforma: plataforma(l.provider),
        campanha: l.campaign?.name ?? null,
        situacao_da_campanha: l.campaign?.status ?? null,
        anuncio: l.ad?.name ?? 'todos os anúncios da campanha',
        pedidos_em_7_dias: inteiro(l.orders_7d),
      }),
    ),
  };
}
