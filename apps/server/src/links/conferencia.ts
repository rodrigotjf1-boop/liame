import type { RastreioLido } from '../connectors/tipos.js';
import { soDigitos } from '../connectors/validacao.js';
import { cardapioValido, codigoValido, dentroDoCardapio, type PlataformaDoLink } from './construtor.js';

// Conferência do rastreio (A2.5, F5; plano-a25 §3 e §11): para cada anúncio ativo lido pela A2, diz se ele
// leva o que o motor de atribuição usa (ADR-020): o código do link do Liame (`lk`) de um link desta campanha,
// ou os ids da campanha, do grupo ou do anúncio nos parâmetros da URL. Função pura, sem banco: o serviço
// monta a entrada e a Atenção do ciclo fechado (F9) usa o resultado ("anúncio ativo sem rastreio").

export type MotivoSemRastreio =
  /** Nenhum `lk` nem id de campanha, grupo ou anúncio. */
  | 'sem_parametros'
  /** Os parâmetros dinâmicos são os da outra plataforma (chaves duplas no Google, simples na Meta): ninguém os troca. */
  | 'parametros_de_outra_plataforma'
  /** `lk` que não é de nenhum link desta empresa, e nenhum id. */
  | 'link_desconhecido'
  /** `lk` de um link de outra campanha: o motor daria a venda a ela. */
  | 'link_de_outra_campanha'
  /** Id colado à mão que não é deste anúncio: a venda iria para outro. */
  | 'ids_de_outro_anuncio'
  /** O anúncio leva para fora do cardápio da loja: o pedido não chega com a origem. */
  | 'destino_fora_do_cardapio';

export type ResultadoConferencia =
  | { status: 'com_rastreio'; via: 'link' | 'ids' }
  | { status: 'sem_rastreio'; reason: MotivoSemRastreio; destino: string | null }
  /** `leitura_pendente`: o Liame ainda não leu o link; `sem_link`: formato de que o link não é lido (publicação existente, catálogo). */
  | { status: 'nao_verificavel'; reason: 'leitura_pendente' | 'sem_link' }
  /** O anúncio não leva a um site (abre o WhatsApp, o Messenger, um formulário…): link do cardápio não se aplica. */
  | { status: 'nao_se_aplica'; reason: 'mensagens' | 'sem_site' };

export type AnuncioParaConferir = {
  provider: PlataformaDoLink;
  /** Campanha do anúncio no Liame (para comparar com a do link). */
  campaignId: string;
  /** Ids na plataforma, para conferir id colado à mão. */
  externos: { campanha: string; grupo: string | null; anuncio: string };
  /** Meta: destino do conjunto (`destination_type`); nulo quando não lido. */
  destinoDoConjunto: string | null;
  /** O que o conector leu do link; nulo = ainda não leu. */
  rastreio: RastreioLido | null;
};

export type ContextoConferencia = {
  /** Links da empresa pelo código (`lk`) → campanha do link. */
  links: ReadonlyMap<string, { campaignId: string | null }>;
  /** Cardápios das lojas da marca (vazio: sem Regem conectado, o destino não é conferido). */
  cardapios: readonly string[];
};

/** Destinos da Meta que abrem conversa (base §2.1, `destination_type` do conjunto, referência conferida em 29/09/2026). */
const DESTINOS_MENSAGEM = new Set(['WHATSAPP', 'MESSENGER', 'INSTAGRAM_DIRECT', 'MESSAGING_MESSENGER_WHATSAPP', 'MESSAGING_INSTAGRAM_DIRECT_MESSENGER', 'MESSAGING_INSTAGRAM_DIRECT_MESSENGER_WHATSAPP', 'MESSAGING_INSTAGRAM_DIRECT_WHATSAPP']);
/**
 * Destinos que ficam na própria plataforma (app, formulário, publicação, perfil, live). Valor fora das duas
 * listas (WEBSITE, os automáticos e um que a Meta crie) é conferido pelo link: na dúvida, confere.
 */
const DESTINOS_SEM_SITE = new Set(['APP', 'FACEBOOK', 'ON_AD', 'ON_POST', 'ON_EVENT', 'ON_VIDEO', 'ON_PAGE', 'INSTAGRAM_PROFILE', 'FACEBOOK_PAGE', 'INSTAGRAM_PROFILE_AND_FACEBOOK_PAGE', 'INSTAGRAM_LIVE', 'FACEBOOK_LIVE', 'IMAGINE']);

function destinoSemLink(d: string | null): 'mensagens' | 'sem_site' | null {
  if (!d) return null;
  if (DESTINOS_MENSAGEM.has(d)) return 'mensagens';
  return DESTINOS_SEM_SITE.has(d) ? 'sem_site' : null;
}

/**
 * Tipo de destino da campanha pelos conjuntos dela: `site` (algum leva a um site ou a destino desconhecido),
 * `mensagens` (todos abrem conversa), `outro` (todos ficam na plataforma) ou `desconhecido` (não lido).
 */
export function tipoDeDestino(destinos: readonly (string | null)[]): 'site' | 'mensagens' | 'outro' | 'desconhecido' {
  const conhecidos = destinos.filter((d): d is string => Boolean(d));
  if (!conhecidos.length) return 'desconhecido';
  const tipos = conhecidos.map(destinoSemLink);
  if (tipos.some((t) => t === null)) return 'site';
  return tipos.every((t) => t === 'mensagens') ? 'mensagens' : 'outro';
}

const HOSTS_MENSAGEM = ['wa.me', 'm.me', 'ig.me'];
const DOMINIOS_MENSAGEM = ['whatsapp.com', 'messenger.com'];

function comoUrl(texto: string): URL | null {
  try {
    const u = new URL(texto);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u : null;
  } catch {
    return null;
  }
}

function abreConversa(u: URL): boolean {
  const host = u.hostname.toLowerCase();
  return HOSTS_MENSAGEM.includes(host) || DOMINIOS_MENSAGEM.some((d) => host === d || host.endsWith(`.${d}`));
}

/**
 * Parâmetros de um texto `a=1&b=2` (sem o `?`); a última ocorrência de cada nome vence, como no `url_tags` da
 * Meta. O nome fica como veio: o cardápio lê `lk` e `campaign_id`, e `LK` não é captado.
 */
function juntar(alvo: Map<string, string>, texto: string | null): void {
  if (!texto) return;
  for (const [k, v] of new URLSearchParams(texto.startsWith('?') || texto.startsWith('&') ? texto.slice(1) : texto)) alvo.set(k, v.trim());
}

/**
 * Os parâmetros que chegam à página: os do próprio destino e os que a plataforma acrescenta. Meta: `url_tags`
 * do criativo e o do link do criativo dinâmico ("substituem ou são acrescentados"). Google: o sufixo do URL
 * final e, quando o modelo de acompanhamento começa por `{lpurl}`, o que vem depois dele.
 */
function parametros(provider: PlataformaDoLink, rastreio: RastreioLido, destino: URL | null, tagsDoDestino: string | null): Map<string, string> {
  const p = new Map<string, string>();
  if (destino) for (const [k, v] of destino.searchParams) if (!p.has(k)) p.set(k, v.trim());
  if (provider === 'meta_ads') {
    juntar(p, rastreio.url_tags);
    juntar(p, tagsDoDestino);
  } else {
    juntar(p, rastreio.sufixo);
    const modelo = rastreio.modelo?.trim() ?? '';
    if (modelo.toLowerCase().startsWith('{lpurl}')) juntar(p, modelo.slice('{lpurl}'.length));
  }
  return p;
}

/** Parâmetro dinâmico de cada plataforma por nível (a Meta chama o grupo de conjunto; os dois nomes valem). */
const MACROS: Record<PlataformaDoLink, { campanha: string; grupo: string; anuncio: string }> = {
  meta_ads: { campanha: '{{campaign.id}}', grupo: '{{adset.id}}', anuncio: '{{ad.id}}' },
  google_ads: { campanha: '{campaignid}', grupo: '{adgroupid}', anuncio: '{creative}' },
};

type Classe = 'dinamico' | 'literal_ok' | 'literal_errado' | 'outra_plataforma' | 'ausente';

/**
 * O parâmetro dinâmico só conta escrito exatamente como a documentação da plataforma (é o que ela troca no
 * clique); o da outra plataforma é reconhecido em qualquer caixa, só para dizer o motivo.
 */
function classificar(valor: string | undefined, provider: PlataformaDoLink, nivel: 'campanha' | 'grupo' | 'anuncio', proprio: string | null): Classe {
  const v = valor?.trim();
  if (!v) return 'ausente';
  if (v === MACROS[provider][nivel]) return 'dinamico';
  const outra: PlataformaDoLink = provider === 'meta_ads' ? 'google_ads' : 'meta_ads';
  if (Object.values(MACROS[outra]).some((m) => m.toLowerCase() === v.toLowerCase())) return 'outra_plataforma';
  if (soDigitos(v, 40)) return proprio !== null && v === proprio ? 'literal_ok' : 'literal_errado';
  return 'ausente';
}

function avaliar(p: Map<string, string>, a: AnuncioParaConferir, ctx: ContextoConferencia, destino: string | null): ResultadoConferencia {
  // 1. O link do Liame vence os ids no motor (ADR-020): lk de outra campanha leva a venda para ela.
  const lk = p.get('lk');
  let lkDesconhecido = false;
  if (codigoValido(lk)) {
    // Link sem campanha (a campanha saiu da conta): o motor passa aos ids, como com um código desconhecido.
    const campanhaDoLink = ctx.links.get(lk)?.campaignId ?? null;
    if (campanhaDoLink) {
      return campanhaDoLink === a.campaignId ? { status: 'com_rastreio', via: 'link' } : { status: 'sem_rastreio', reason: 'link_de_outra_campanha', destino };
    }
    lkDesconhecido = true;
  }
  // 2. Ids da campanha, do grupo ou do anúncio: basta um que o motor resolva.
  const classes = [
    classificar(p.get('campaign_id'), a.provider, 'campanha', a.externos.campanha),
    classificar(p.get('adset_id') ?? p.get('adgroup_id'), a.provider, 'grupo', a.externos.grupo),
    classificar(p.get('ad_id'), a.provider, 'anuncio', a.externos.anuncio),
  ];
  if (classes.includes('literal_errado')) return { status: 'sem_rastreio', reason: 'ids_de_outro_anuncio', destino };
  if (classes.includes('dinamico') || classes.includes('literal_ok')) return { status: 'com_rastreio', via: 'ids' };
  if (classes.includes('outra_plataforma')) return { status: 'sem_rastreio', reason: 'parametros_de_outra_plataforma', destino };
  return { status: 'sem_rastreio', reason: lkDesconhecido ? 'link_desconhecido' : 'sem_parametros', destino };
}

type DestinoConferido = { url: URL | null; url_tags: string | null };

/** Confere um anúncio ativo: todo destino dele precisa chegar ao cardápio com o rastreio. */
export function conferirAnuncio(a: AnuncioParaConferir, ctx: ContextoConferencia): ResultadoConferencia {
  const semLink = a.provider === 'meta_ads' ? destinoSemLink(a.destinoDoConjunto) : null;
  if (semLink) return { status: 'nao_se_aplica', reason: semLink };
  const r = a.rastreio;
  if (!r) return { status: 'nao_verificavel', reason: 'leitura_pendente' };

  const lidos: DestinoConferido[] = r.destinos.map((d) => ({ url: comoUrl(d.url), url_tags: d.url_tags }));
  const conversa = lidos.filter((d) => d.url !== null && abreConversa(d.url));
  const sites = lidos.filter((d): d is { url: URL; url_tags: string | null } => d.url !== null && !abreConversa(d.url));
  if (!sites.length) {
    if (conversa.length) return { status: 'nao_se_aplica', reason: 'mensagens' };
    // Meta com parâmetros de URL e sem o link (anúncio de publicação existente): confere só os parâmetros.
    if (a.provider === 'meta_ads' && r.url_tags) return avaliar(parametros(a.provider, r, null, null), a, ctx, null);
    return { status: 'nao_verificavel', reason: 'sem_link' };
  }

  const cardapios = ctx.cardapios.map((c) => cardapioValido(c)).filter((c): c is URL => c !== null);
  let via: 'link' | 'ids' = 'ids';
  for (const d of sites) {
    if (cardapios.length && !cardapios.some((c) => dentroDoCardapio(d.url, c))) {
      return { status: 'sem_rastreio', reason: 'destino_fora_do_cardapio', destino: d.url.toString() };
    }
    const resultado = avaliar(parametros(a.provider, r, d.url, d.url_tags), a, ctx, d.url.toString());
    if (resultado.status !== 'com_rastreio') return resultado;
    if (resultado.via === 'link') via = 'link';
  }
  return { status: 'com_rastreio', via };
}

// ------------------------------------------------------------------ texto do aviso

const NOME: Record<PlataformaDoLink, string> = { meta_ads: 'Meta', google_ads: 'Google Ads' };

export type TextoDoAviso = { title: string; detail: string; action: string };

function hostDe(destino: string | null): string {
  if (!destino) return 'outro endereço';
  try {
    return new URL(destino).hostname;
  } catch {
    return 'outro endereço';
  }
}

/**
 * O aviso em linguagem de gente (protótipo P3; padrão da Atenção de mídia): título, o motivo e o que fazer.
 * O Liame não mexe no anúncio: a ação é sempre colar ou trocar os parâmetros na plataforma.
 */
export function textoDoAviso(anuncio: string, provider: PlataformaDoLink, r: Exclude<ResultadoConferencia, { status: 'com_rastreio' } | { status: 'nao_se_aplica' }>): TextoDoAviso {
  const meta = provider === 'meta_ads';
  const onde = meta ? 'no campo "Parâmetros de URL" do anúncio' : 'no campo "Sufixo do URL final" (do anúncio, do grupo, da campanha ou da conta)';
  const colar = `Copie os parâmetros de um link desta campanha em Links e cupons e cole ${onde}.`;
  if (r.status === 'nao_verificavel') {
    return r.reason === 'leitura_pendente'
      ? { title: `Ainda não conferimos o anúncio "${anuncio}"`, detail: `O Liame ainda não leu o link deste anúncio; a conferência entra na próxima leitura do ${NOME[provider]}.`, action: 'Nada a fazer agora.' }
      : {
          title: `Não deu para conferir o anúncio "${anuncio}"`,
          detail: meta ? 'O anúncio usa uma publicação ou um formato de que o Liame não lê o link.' : 'O anúncio não tem URL final que o Liame leia (Performance Max, ligação ou app).',
          action: `Confira no ${NOME[provider]} se o link do anúncio leva os parâmetros do Liame.`,
        };
  }
  const titulo = `O anúncio "${anuncio}" está sem o rastreio do Liame`;
  switch (r.reason) {
    case 'sem_parametros':
      return {
        title: titulo,
        detail: meta ? 'O link do anúncio não tem os parâmetros do Liame: as vendas dele ficam sem origem.' : 'O URL final deste anúncio está sem o sufixo com os parâmetros do Liame: as vendas dele ficam sem a campanha.',
        action: colar,
      };
    case 'parametros_de_outra_plataforma':
      return {
        title: titulo,
        detail: meta
          ? 'Os parâmetros do anúncio são os do Google Ads (com chaves simples): a Meta não troca esses valores, e as vendas ficam sem origem.'
          : 'Os parâmetros do anúncio são os da Meta (com chaves duplas): o Google Ads não troca esses valores, e as vendas ficam sem a campanha.',
        action: `Troque pelos parâmetros do ${NOME[provider]} do link desta campanha, em Links e cupons.`,
      };
    case 'link_desconhecido':
      return { title: titulo, detail: 'O anúncio leva um código lk que não é de nenhum link desta empresa: as vendas dele ficam sem origem.', action: colar };
    case 'link_de_outra_campanha':
      return {
        title: `O anúncio "${anuncio}" leva o link de outra campanha`,
        detail: 'O código lk do anúncio é de um link de outra campanha: as vendas dele iriam para a campanha errada.',
        action: `Troque pelos parâmetros do link desta campanha, em Links e cupons.`,
      };
    case 'ids_de_outro_anuncio':
      return {
        title: `O anúncio "${anuncio}" leva os números de outro anúncio`,
        detail: 'Os números de campanha, grupo ou anúncio colados no link são de outro anúncio: as vendas iriam para a campanha errada.',
        action: colar,
      };
    case 'destino_fora_do_cardapio':
      return {
        title: `O anúncio "${anuncio}" leva para fora do cardápio da loja`,
        detail: `O anúncio leva para ${hostDe(r.destino)}, fora do cardápio da loja: o pedido não chega com a origem.`,
        action: `Troque o destino do anúncio no ${NOME[provider]} pelo cardápio da loja, com os parâmetros do link desta campanha.`,
      };
  }
}
