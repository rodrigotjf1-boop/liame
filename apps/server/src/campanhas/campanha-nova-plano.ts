import { z } from 'zod';
import { REGRAS } from '../links/construtor.js';
import { BairroDaCampanha, bairrosEscritos, lugaresDoRaio, lugaresDosBairros, MAXIMO_DE_BAIRROS } from './bairros-da-campanha.js';

// A campanha nova na Meta, criada pausada (A4, X5, parte 1; P10 aprovado em 05/10/2026; D-A4-31, D-A4-35, D-A4-40 e
// D-A4-41). A peça de texto aprovada em Criativos, com a foto ou o vídeo da loja, vira um pedido de criar a campanha, o
// conjunto e o anúncio na Meta, tudo pausado; ativar é outro pedido. Aqui ficam as partes puras: o estado que o pedido
// guarda (o que a pessoa aprova), o plano da ferramenta `campanha_criar` e os parâmetros de cada objeto na Meta, pela
// referência oficial reconferida em 11/11/2026 (base de conhecimento §2.1). Sem rede e sem banco.

/** O recurso do pedido: `campanha_nova:<id>`, a campanha nova do Liame (`ad_campaign_new`). */
export const recursoDaCampanhaNova = (id: string): string => `campanha_nova:${id}`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** O id da campanha nova no recurso do pedido, ou nulo quando o recurso é outro. */
export function campanhaNovaDoRecurso(resourceId: string): string | null {
  const m = /^campanha_nova:(.+)$/.exec(resourceId);
  return m && UUID.test(m[1]!) ? m[1]! : null;
}

/**
 * Os objetivos: pedidos pelo cardápio, conversas no WhatsApp e, da R6 do plano da região (D-RG-48), ser conhecido no
 * raio (alcance) e seguidores no Instagram. Alcance e seguidores são do topo do funil: somados, até 25% do teto do mês.
 */
export const OBJETIVOS_DA_CAMPANHA_NOVA = ['cardapio', 'whatsapp', 'alcance', 'seguidores'] as const;
export type ObjetivoDaCampanhaNova = (typeof OBJETIVOS_DA_CAMPANHA_NOVA)[number];
/** Os objetivos do topo do funil, que dividem até 25% do teto do mês (D-RG-49). */
export const OBJETIVOS_DO_TOPO: readonly ObjetivoDaCampanhaNova[] = ['alcance', 'seguidores'];
export const PARTE_DO_TOPO_NO_MES = 0.25;
/** O objetivo que leva ao cardápio (o link é o do cardápio da loja). */
export const levaAoCardapio = (o: ObjetivoDaCampanhaNova): boolean => o === 'cardapio' || o === 'alcance';
/** A frequência do alcance (D-RG-51): no máximo 2 vezes por pessoa a cada 7 dias. */
export const FREQUENCIA_DO_ALCANCE = { event: 'IMPRESSIONS', interval_days: 7, max_frequency: 2 } as const;
/** Abaixo disto, a Meta não entrega bem no raio: o pedido não é criado (D-RG-50). */
export const PUBLICO_MINIMO_NO_RAIO = 1000;

export const SituacaoDaCampanhaNova = z.enum(['pedida', 'criando', 'criada', 'nao_criada', 'cancelada']);
export type SituacaoDaCampanhaNova = z.infer<typeof SituacaoDaCampanhaNova>;

/**
 * O estado do pedido: o que a pessoa vê e aprova (a peça, a mídia, quem assina, a loja e o raio, a verba e o fim). O
 * plano e o hash dele saem daqui; o que o Liame já criou na Meta fica na linha da campanha nova, fora do estado.
 */
export const EstadoDaCampanhaNova = z.object({
  campanha: z.string().regex(UUID),
  marca: z.string().regex(UUID),
  nome: z.string().min(1).max(80),
  objetivo: z.enum(OBJETIVOS_DA_CAMPANHA_NOVA),
  /** A peça aprovada; nula na campanha a partir de um Reels (A4, X5, parte 6; D-A4-46: o texto é a legenda do post). */
  peca: z
    .object({
      id: z.string().regex(UUID),
      versao: z.number().int().min(1),
      titulo: z.string().min(1).max(60),
      texto: z.string().min(1).max(400),
      botao: z.enum(['pedir_agora', 'ver_cardapio', 'enviar_mensagem']),
    })
    .nullable(),
  /**
   * A foto ou o vídeo de Fotos, ou o Reels já publicado (o id dele no Instagram e a legenda, como estão). A capa do Reels
   * fica de fora: o endereço dela vence, e o estado aprovado não pode mudar sozinho.
   */
  midia: z.union([
    z.object({ id: z.string().regex(UUID), tipo: z.enum(['foto', 'video']), arquivo: z.string().min(1) }),
    z.object({ id: z.string().regex(/^[0-9]{1,40}$/), tipo: z.literal('reels'), legenda: z.string().max(2200) }),
  ]),
  pagina: z.object({ id: z.string().min(1), nome: z.string() }),
  instagram: z.object({ id: z.string().min(1), nome: z.string() }).nullable(),
  /** A estimativa de público da Meta no raio quando a pessoa pediu (R6, D-RG-50); nula quando a Meta não estimou. */
  publico: z.object({ de: z.number().int().nonnegative(), ate: z.number().int().nonnegative() }).nullable().optional(),
  loja: z.object({ id: z.string().regex(UUID), nome: z.string(), latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180) }),
  /** O raio em volta da loja; nulo na campanha por bairros (R6, parte 3): um ou outro. */
  raio_km: z.number().min(1).max(15).nullable(),
  /** Os bairros da campanha por bairros (R6, parte 3; D-RG-53 e D-RG-54); ausente ou nulo na campanha com raio. */
  bairros: z.array(BairroDaCampanha).min(1).max(MAXIMO_DE_BAIRROS).nullable().optional(),
  verba_diaria_micros: z.number().int().positive(),
  moeda: z.string().min(3).max(3),
  fim: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  fuso: z.string().min(1),
  link: z.string().url().nullable(),
  situacao: SituacaoDaCampanhaNova,
  /** Ativada pelo Liame (A4, X5, parte 3): a campanha, o conjunto e o anúncio rodando na Meta. */
  ativa: z.boolean(),
});
export type EstadoDaCampanhaNova = z.infer<typeof EstadoDaCampanhaNova>;

export type PlanoDaCampanhaNova = { ok: true; desejado: EstadoDaCampanhaNova } | { ok: false; motivo: string };

/**
 * O plano da ferramenta `campanha_criar`: a campanha nova pedida vira criada (pausada). O que já foi criado, recusado
 * ou cancelado não volta a ser pedido. Função pura.
 */
export function planoDaCampanhaNova(before: unknown): PlanoDaCampanhaNova {
  const lido = EstadoDaCampanhaNova.safeParse(before);
  if (!lido.success) return { ok: false, motivo: 'Esta ferramenta é para uma campanha nova do Liame.' };
  const e = lido.data;
  if (e.situacao === 'criada') return { ok: false, motivo: 'Esta campanha nova já foi criada na Meta, pausada.' };
  if (e.situacao === 'cancelada') return { ok: false, motivo: 'Esta campanha nova foi cancelada.' };
  if (e.situacao === 'nao_criada') return { ok: false, motivo: 'Esta campanha nova não foi criada: peça de novo pela peça.' };
  if (levaAoCardapio(e.objetivo) !== (e.link !== null)) return { ok: false, motivo: 'O destino da campanha não bate com o objetivo.' };
  if ((e.raio_km === null) === !e.bairros?.length) return { ok: false, motivo: 'Quem vê a campanha é o raio em volta da loja ou os bairros: um dos dois.' };
  if (e.objetivo === 'seguidores' && !e.instagram) return { ok: false, motivo: 'Seguidores no Instagram pede o Instagram ligado à Página: conecte o Instagram da marca antes.' };
  // As duas origens (D-A4-46): a peça com a foto ou o vídeo de Fotos, ou o Reels sozinho (o texto é a legenda dele).
  const doReels = e.midia.tipo === 'reels';
  if (doReels !== (e.peca === null)) return { ok: false, motivo: 'A campanha nova tem a peça com a mídia de Fotos, ou só o Reels.' };
  if (doReels && !e.instagram) return { ok: false, motivo: 'O Reels é da conta do Instagram ligada à Página: conecte o Instagram da marca antes.' };
  return { ok: true, desejado: { ...e, situacao: 'criada' } };
}

/**
 * O plano de ativar (A4, X5, parte 3; D-A4-31): a campanha nova criada e pausada passa a rodar. Gasta a verba diária
 * depois da revisão da Meta; a volta é pausar. Função pura.
 */
export function planoDeAtivar(before: unknown): PlanoDaCampanhaNova {
  const lido = EstadoDaCampanhaNova.safeParse(before);
  if (!lido.success) return { ok: false, motivo: 'Esta ferramenta é para uma campanha nova do Liame.' };
  const e = lido.data;
  if (e.situacao !== 'criada') return { ok: false, motivo: 'A campanha nova ainda não foi criada na Meta: ative depois que ela existir, pausada.' };
  if (e.ativa) return { ok: false, motivo: 'Esta campanha nova já está ativa.' };
  return { ok: true, desejado: { ...e, ativa: true } };
}

/** O plano de pausar (a volta de ativar): a campanha nova ativa para de rodar e de gastar. Função pura. */
export function planoDePausar(before: unknown): PlanoDaCampanhaNova {
  const lido = EstadoDaCampanhaNova.safeParse(before);
  if (!lido.success) return { ok: false, motivo: 'Esta ferramenta é para uma campanha nova do Liame.' };
  const e = lido.data;
  if (e.situacao !== 'criada' || !e.ativa) return { ok: false, motivo: 'Esta campanha nova não está ativa: não há o que pausar.' };
  return { ok: true, desejado: { ...e, ativa: false } };
}

// ------------------------------------------------------------ os objetos na Meta (D-A4-40)

/** As melhorias automáticas do criativo, todas desligadas (D-A4-31): a lista do guia oficial, lida em 11/11/2026. */
export const MELHORIAS_DO_CRIATIVO = [
  'adapt_to_placement',
  'add_text_overlay',
  'creative_stickers',
  'description_automation',
  'enhance_cta',
  'image_animation',
  'image_background_gen',
  'image_brightness_and_contrast',
  'image_templates',
  'image_text_translation',
  'image_touchups',
  'image_uncrop',
  'inline_comment',
  'media_type_automation',
  'pac_relaxation',
  'product_extensions',
  'reveal_details_over_time',
  'text_optimizations',
  'text_translation',
  'translate_voiceover',
  'video_auto_crop',
  'video_filtering',
  'video_uncrop',
] as const;

/** Os parâmetros que a Meta recebe (os valores compostos já em JSON, como a Graph API lê da consulta). */
export type ParametrosDaMeta = Record<string, string>;

/**
 * A campanha (`POST /act_{id}/campaigns`): o objetivo de cada destino, sem categoria especial, sem verba própria (ela
 * fica no conjunto, sem dividir entre conjuntos) e pausada. "Pedidos pelo cardápio" é Tráfego (vendas pediria o pixel);
 * "conversas no WhatsApp" é Engajamento.
 */
export function parametrosDaCampanha(e: EstadoDaCampanhaNova): ParametrosDaMeta {
  return {
    name: e.nome,
    objective: OBJETIVO_NA_META[e.objetivo],
    status: 'PAUSED',
    buying_type: 'AUCTION',
    special_ad_categories: JSON.stringify([]),
    is_adset_budget_sharing_enabled: 'false',
  };
}

/**
 * O objetivo de cada destino na Meta (a tabela de objetivos da referência da campanha, lida em 13/11/2026): cardápio é
 * Tráfego; WhatsApp, Engajamento; alcance, Reconhecimento (REACH no conjunto); seguidores, Tráfego com o destino no
 * perfil do Instagram (a combinação conferida pela Meta antes de criar, `validate_only`).
 */
export const OBJETIVO_NA_META: Record<ObjetivoDaCampanhaNova, string> = {
  cardapio: 'OUTCOME_TRAFFIC',
  whatsapp: 'OUTCOME_ENGAGEMENT',
  alcance: 'OUTCOME_AWARENESS',
  seguidores: 'OUTCOME_TRAFFIC',
};
/** O que o conjunto otimiza em cada objetivo. */
export const OTIMIZACAO_NA_META: Record<ObjetivoDaCampanhaNova, string> = {
  cardapio: 'LINK_CLICKS',
  whatsapp: 'CONVERSATIONS',
  alcance: 'REACH',
  seguidores: 'VISIT_INSTAGRAM_PROFILE',
};

/** O perfil do Instagram (o destino dos seguidores): pelo nome da conta, sem o @. */
export function perfilDoInstagram(nome: string): string | null {
  const t = nome.trim();
  const usuario = t.startsWith('@') ? t.slice(1) : t;
  return usuario.length >= 1 && usuario.length <= 30 && [...usuario].every((c) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c === '.' || c === '_')
    ? `https://www.instagram.com/${usuario}/`
    : null;
}

/** A verba diária na menor unidade da moeda (centavos), ou nulo quando ela tem fração de centavo. */
export function verbaNaMenorUnidade(micros: number): number | null {
  if (!Number.isSafeInteger(micros) || micros <= 0 || micros % 10_000 !== 0) return null;
  return micros / 10_000;
}

/** Quanto o relógio do fuso está à frente de UTC (negativo no Brasil) naquele instante, em milissegundos. */
function deslocamentoDoFuso(instante: Date, fuso: string): number {
  const partes = new Intl.DateTimeFormat('en-US', {
    timeZone: fuso,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instante);
  const p = Object.fromEntries(partes.map((x) => [x.type, x.value]));
  const comoUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
  return comoUtc - Math.floor(instante.getTime() / 1000) * 1000;
}

/** O fim do dia `AAAA-MM-DD` no fuso da empresa (23:59:59 de lá), em UTC (ISO). */
export function fimDoDia(dia: string, fuso: string): string {
  const alvo = Date.parse(`${dia}T23:59:59Z`);
  return new Date(alvo - deslocamentoDoFuso(new Date(alvo), fuso)).toISOString();
}

/**
 * Os lugares de quem vê (`geo_locations`): o raio em volta da loja, em quilômetros, ou os bairros (os da Meta pela chave
 * e um círculo no centro de cada um dos outros; R6, parte 3, D-RG-54).
 */
export function lugaresDaCampanha(e: EstadoDaCampanhaNova): Record<string, unknown> {
  if (e.raio_km !== null) return lugaresDoRaio(e.loja.latitude, e.loja.longitude, e.raio_km);
  if (!e.bairros?.length) throw new Error('a campanha nova sem o raio e sem os bairros');
  return lugaresDosBairros(e.bairros);
}

/**
 * O conjunto (`POST /act_{id}/adsets`): a verba diária, o lance de menor custo sem limite, o raio em volta da loja em
 * quilômetros (o padrão da Meta é milha), 18 anos ou mais, sem o público ampliado da Meta, o posicionamento automático
 * e pausado. O WhatsApp leva o destino e a Página promovida.
 */
export function parametrosDoConjunto(e: EstadoDaCampanhaNova, campanhaId: string): ParametrosDaMeta {
  const verba = verbaNaMenorUnidade(e.verba_diaria_micros);
  if (verba === null) throw new Error('verba diária com fração de centavo');
  const targeting = {
    geo_locations: lugaresDaCampanha(e),
    age_min: 18,
    targeting_automation: { advantage_audience: 0 },
  };
  return {
    name: e.raio_km !== null ? `${e.nome} · ${e.raio_km.toLocaleString('pt-BR')} km` : `${e.nome} · ${bairrosEscritos(e.bairros?.length ?? 0)}`,
    campaign_id: campanhaId,
    status: 'PAUSED',
    daily_budget: String(verba),
    bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
    billing_event: 'IMPRESSIONS',
    optimization_goal: OTIMIZACAO_NA_META[e.objetivo],
    targeting: JSON.stringify(targeting),
    ...(e.objetivo === 'whatsapp' ? { destination_type: 'WHATSAPP', promoted_object: JSON.stringify({ page_id: e.pagina.id }) } : {}),
    // Alcance: a frequência limitada (D-RG-51; a Meta só aceita com REACH) e a Página promovida, como na tabela.
    ...(e.objetivo === 'alcance' ? { frequency_control_specs: JSON.stringify([FREQUENCIA_DO_ALCANCE]), promoted_object: JSON.stringify({ page_id: e.pagina.id }) } : {}),
    ...(e.objetivo === 'seguidores' ? { destination_type: 'INSTAGRAM_PROFILE' } : {}),
    ...(e.fim ? { end_time: fimDoDia(e.fim, e.fuso) } : {}),
  };
}

/** O rastreio do Liame nos parâmetros de URL do anúncio (o mesmo dos links de campanha, F5): a origem, o meio e os ids. */
export function rastreioDoAnuncio(): string {
  const r = REGRAS.meta_ads;
  return [`utm_source=${r.utmSource}`, `utm_medium=${r.utmMedium}`, ...r.dinamicos.map(([k, v]) => `${k}=${v}`)].join('&');
}

/**
 * A mídia do criativo: a foto pelo endereço assinado do armazenamento (a Meta a guarda na biblioteca da conta); o vídeo
 * pelo id que a Meta deu, com a capa pelo endereço assinado.
 */
export type MidiaNaMeta = { tipo: 'foto'; imagem: string } | { tipo: 'video'; videoId: string; capa: string } | { tipo: 'reels'; id: string };

/** O link do WhatsApp no anúncio que abre a conversa (o exemplo oficial do clique para o WhatsApp). */
export const LINK_DO_WHATSAPP = 'https://api.whatsapp.com/send';

/**
 * O criativo (`POST /act_{id}/adcreatives`): em nome da Página (e da conta do Instagram dela), o texto principal e o
 * título da peça, a foto ou o vídeo com a capa, o botão do destino (o link do botão é o mesmo do criativo), o rastreio
 * do Liame e todas as melhorias automáticas desligadas.
 */
export function parametrosDoCriativo(e: EstadoDaCampanhaNova, midia: MidiaNaMeta): ParametrosDaMeta {
  const perfil = e.objetivo === 'seguidores' ? perfilDoInstagram(e.instagram?.nome ?? '') : null;
  if (e.objetivo === 'seguidores' && !perfil) throw new Error('o perfil do Instagram ligado à Página não tem um nome válido');
  const link = levaAoCardapio(e.objetivo) ? e.link! : e.objetivo === 'seguidores' ? perfil! : LINK_DO_WHATSAPP;
  const botao = levaAoCardapio(e.objetivo)
    ? { type: 'ORDER_NOW', value: { link } }
    : e.objetivo === 'seguidores'
      ? { type: 'VIEW_INSTAGRAM_PROFILE', value: { link } }
      : { type: 'WHATSAPP_MESSAGE', value: { app_destination: 'WHATSAPP', link } };
  const melhorias = Object.fromEntries(MELHORIAS_DO_CRIATIVO.map((m) => [m, { enroll_status: 'OPT_OUT' }]));
  // O Reels já publicado (A4, X5, parte 6; D-A4-46): o próprio post, pela referência "Use Posts as Instagram Ads" (lida
  // em 12/11/2026): a Página (`object_id`), a conta do Instagram e o id do post; o Liame põe só o botão e o rastreio.
  if (midia.tipo === 'reels') {
    if (!e.instagram) throw new Error('o Reels precisa da conta do Instagram ligada à Página');
    return {
      name: `${e.nome} · criativo`,
      object_id: e.pagina.id,
      instagram_user_id: e.instagram.id,
      source_instagram_media_id: midia.id,
      call_to_action: JSON.stringify(botao),
      degrees_of_freedom_spec: JSON.stringify({ creative_features_spec: melhorias }),
      ...(levaAoCardapio(e.objetivo) ? { url_tags: rastreioDoAnuncio() } : {}),
    };
  }
  if (!e.peca) throw new Error('a foto ou o vídeo de Fotos vai com a peça aprovada');
  const spec: Record<string, unknown> = { page_id: e.pagina.id };
  if (e.instagram) spec.instagram_user_id = e.instagram.id;
  if (midia.tipo === 'foto') {
    spec.link_data = { link, message: e.peca.texto, name: e.peca.titulo, picture: midia.imagem, call_to_action: botao };
  } else {
    spec.video_data = { video_id: midia.videoId, image_url: midia.capa, message: e.peca.texto, title: e.peca.titulo, call_to_action: botao };
  }
  return {
    name: `${e.nome} · criativo`,
    object_story_spec: JSON.stringify(spec),
    degrees_of_freedom_spec: JSON.stringify({ creative_features_spec: melhorias }),
    ...(levaAoCardapio(e.objetivo) ? { url_tags: rastreioDoAnuncio() } : {}),
  };
}

/** O anúncio (`POST /act_{id}/ads`): o conjunto, o criativo e pausado. */
export function parametrosDoAnuncio(e: EstadoDaCampanhaNova, conjuntoId: string, criativoId: string): ParametrosDaMeta {
  return { name: `${e.nome} · anúncio`, adset_id: conjuntoId, creative: JSON.stringify({ creative_id: criativoId }), status: 'PAUSED' };
}
