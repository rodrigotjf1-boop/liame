import { createHash } from 'node:crypto';
import { encode } from 'uqr';

// Construtor dos links de campanha (A2.5, F5; plano-a25 §3; protótipo P3 aprovado em 29/09/2026). Tudo aqui é
// puro: o serviço lê o banco e chama estas funções. O Liame não escreve na Meta nem no Google: monta o link do
// cardápio da loja com o código do Liame (`lk`) e os parâmetros que a pessoa cola no anúncio. Os nomes dos
// parâmetros são os que o cardápio do Regem capta (docs/integracoes/regem.md §4); a sintaxe de cada
// plataforma foi conferida na documentação oficial em 29/09/2026 (base §2.1 e §3.1).

export type PlataformaDoLink = 'meta_ads' | 'google_ads';

export const PLATAFORMAS_DO_LINK: readonly PlataformaDoLink[] = ['meta_ads', 'google_ads'];

type Regra = {
  /** Onde colar: `url_tags` ("Parâmetros de URL" do anúncio, na Meta) ou `final_url_suffix` ("Sufixo do URL final", no Google Ads). */
  campo: 'url_tags' | 'final_url_suffix';
  utmSource: string;
  utmMedium: string;
  /** Parâmetros que a plataforma troca na hora do clique (ids da campanha, do grupo e do anúncio). */
  dinamicos: readonly (readonly [string, string])[];
};

/**
 * Meta: `{{campaign.id}}`, `{{adset.id}}`, `{{ad.id}}` e `{{campaign.name}}` no campo `url_tags` do criativo.
 * Google Ads: ValueTrack `{campaignid}`, `{adgroupid}` e `{creative}` no sufixo do URL final (o `gclid` o
 * Google acrescenta sozinho com a codificação automática; o ValueTrack não tem o nome da campanha).
 */
export const REGRAS: Record<PlataformaDoLink, Regra> = {
  meta_ads: {
    campo: 'url_tags',
    utmSource: 'meta',
    utmMedium: 'paid',
    dinamicos: [
      ['utm_campaign', '{{campaign.name}}'],
      ['campaign_id', '{{campaign.id}}'],
      ['adset_id', '{{adset.id}}'],
      ['ad_id', '{{ad.id}}'],
    ],
  },
  google_ads: {
    campo: 'final_url_suffix',
    utmSource: 'google',
    utmMedium: 'cpc',
    dinamicos: [
      ['campaign_id', '{campaignid}'],
      ['adgroup_id', '{adgroupid}'],
      ['ad_id', '{creative}'],
    ],
  },
};

/** Parâmetros que o cardápio capta (regem.md §4): o destino não pode trazer nenhum deles. */
export const PARAMETROS_DE_RASTREIO = [
  'lk',
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_content',
  'utm_term',
  'campaign_id',
  'adset_id',
  'adgroup_id',
  'ad_id',
  'gclid',
  'gbraid',
  'wbraid',
  'fbclid',
] as const;

/** O texto que a pessoa cola no anúncio (sem o `?`, os parâmetros separados por `&`). */
export function parametrosParaColar(plataforma: PlataformaDoLink, codigo: string): string {
  const r = REGRAS[plataforma];
  // Sem codificar: as chaves dos parâmetros dinâmicos precisam chegar à plataforma como estão.
  return [`utm_source=${r.utmSource}`, `utm_medium=${r.utmMedium}`, ...r.dinamicos.map(([k, v]) => `${k}=${v}`), `lk=${codigo}`].join('&');
}

/**
 * O link com rastreio (bio, WhatsApp da loja, QR impresso): o destino com a origem, o meio, a campanha e o
 * `lk`. Sem parâmetro dinâmico: fora do anúncio, ninguém os trocaria. Os parâmetros do destino ficam como
 * estão, e o fragmento continua no fim.
 */
export function linkComRastreio(destino: string, p: { utmSource: string; utmMedium: string; utmCampaign: string | null; codigo: string }): string {
  const url = new URL(destino);
  const extra = new URLSearchParams({ utm_source: p.utmSource, utm_medium: p.utmMedium });
  if (p.utmCampaign) extra.set('utm_campaign', p.utmCampaign);
  extra.set('lk', p.codigo);
  url.search = url.search ? `${url.search}&${extra.toString()}` : `?${extra.toString()}`;
  return url.toString();
}

/** `utm_campaign` do link com rastreio: o nome da campanha em letras e números ("Busca “hambúrguer perto”" → "busca-hamburguer-perto"). */
export function slugCampanha(nome: string): string | null {
  const s = nome
    .slice(0, 300)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 100)
    .replace(/^-+|-+$/g, '');
  return s || null;
}

// ------------------------------------------------------------------ código do link (lk)

/** Base 32 de Crockford: sem I, L, O e U (não se confunde ao ler um QR impresso ou um print). */
const BASE32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const TAMANHO_CODIGO = 10;

/** O que define "o mesmo link": a empresa, a loja, a campanha, o anúncio (ou todos) e o destino. */
export type ChaveDoLink = { tenantId: string; unitId: string; campaignId: string; adId: string | null; destinationUrl: string };

/**
 * O `lk` sai da chave natural (SHA-256 em base 32, 50 bits): criar o mesmo link de novo dá o mesmo código, e
 * o índice único `(tenant_id, code)` que já existe (migration 0022) garante um link só, também com pedidos
 * simultâneos. `tentativa` resolve uma colisão (código igual de outra chave, chance de 1 em 2^50): a
 * sequência é a mesma a cada criação, então o reenvio encontra o mesmo link.
 */
export function codigoDoLink(chave: ChaveDoLink, tentativa = 0): string {
  const texto = ['liame-lk', 'v1', chave.tenantId, chave.unitId, chave.campaignId, chave.adId ?? '*', chave.destinationUrl, String(tentativa)].join('\n');
  const hash = createHash('sha256').update(texto, 'utf8').digest();
  let codigo = '';
  let acumulado = 0;
  let bits = 0;
  for (const byte of hash) {
    acumulado = (acumulado << 8) | byte;
    bits += 8;
    while (bits >= 5 && codigo.length < TAMANHO_CODIGO) {
      codigo += BASE32[(acumulado >>> (bits - 5)) & 31];
      bits -= 5;
    }
    acumulado &= (1 << bits) - 1;
    if (codigo.length === TAMANHO_CODIGO) break;
  }
  return codigo;
}

/** O formato que o cardápio e o motor aceitam para o `lk` (letras e números, de 6 a 32; migration 0022). */
export function codigoValido(v: string | null | undefined): v is string {
  if (typeof v !== 'string' || v.length < 6 || v.length > 32) return false;
  for (const c of v) {
    const ok = (c >= '0' && c <= '9') || (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z');
    if (!ok) return false;
  }
  return true;
}

// ------------------------------------------------------------------ destino (V33)

/** Teto do destino: o link com rastreio precisa caber num QR que se imprime. */
export const MAX_DESTINO = 1024;

/** Endereço do cardápio vindo do Regem (`cardapio_url` da rota `/loja`): só https, sem usuário nem senha. */
export function cardapioValido(v: unknown): URL | null {
  if (typeof v !== 'string' || !v || v.length > MAX_DESTINO) return null;
  let url: URL;
  try {
    url = new URL(v);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password || !url.hostname) return null;
  return url;
}

/** Mesma origem (esquema, host e porta, como o `new URL` normaliza) e caminho dentro do do cardápio. */
export function dentroDoCardapio(alvo: URL, cardapio: URL): boolean {
  if (alvo.origin !== cardapio.origin) return false;
  if (cardapio.pathname === '/') return true;
  const raiz = cardapio.pathname.endsWith('/') ? cardapio.pathname : `${cardapio.pathname}/`;
  return alvo.pathname === cardapio.pathname || alvo.pathname.startsWith(raiz);
}

export type MotivoDestino = 'invalido' | 'longo_demais' | 'esquema' | 'credenciais' | 'fora_do_cardapio' | 'parametro_de_rastreio';

/**
 * O destino do link só pode ser o cardápio da loja ou uma página dentro dele (V33, ERR-026, LIC-119): compara
 * a origem pelo `new URL()` e o caminho, nunca o começo do texto; recusa outro esquema que não https, usuário
 * ou senha na URL e destino que já traga parâmetro de rastreio (o link ficaria com dois valores). Devolve o
 * endereço normalizado.
 */
export function destinoNoCardapio(destino: string, cardapios: string[]): { ok: true; url: string } | { ok: false; motivo: MotivoDestino } {
  if (destino.length > MAX_DESTINO) return { ok: false, motivo: 'longo_demais' };
  let alvo: URL;
  try {
    alvo = new URL(destino.trim());
  } catch {
    return { ok: false, motivo: 'invalido' };
  }
  if (alvo.protocol !== 'https:') return { ok: false, motivo: 'esquema' };
  if (alvo.username || alvo.password) return { ok: false, motivo: 'credenciais' };
  const dentro = cardapios.some((c) => {
    const base = cardapioValido(c);
    return base !== null && dentroDoCardapio(alvo, base);
  });
  if (!dentro) return { ok: false, motivo: 'fora_do_cardapio' };
  for (const nome of alvo.searchParams.keys()) {
    if ((PARAMETROS_DE_RASTREIO as readonly string[]).includes(nome.toLowerCase())) return { ok: false, motivo: 'parametro_de_rastreio' };
  }
  const url = alvo.toString();
  return url.length > MAX_DESTINO ? { ok: false, motivo: 'longo_demais' } : { ok: true, url };
}

// ------------------------------------------------------------------ QR

/** Cores fixas: módulo escuro sobre fundo claro nos dois temas (o leitor de QR precisa disso; protótipo P3). */
const QR_FUNDO = '#FFFFFF';
const QR_TINTA = '#0B0D17';
/** Pixels por módulo no tamanho natural do SVG (a imagem escala sem perder nitidez). */
const QR_PIXEL = 8;

/**
 * QR do link com rastreio em SVG (material impresso): correção de erro M, margem de 4 módulos, sem texto da
 * pessoa dentro (só números e cores fixas). O front mostra e baixa o SVG, e desenha o PNG a partir dele.
 */
export function qrSvg(texto: string): string {
  const { data, size } = encode(texto, { ecc: 'M', border: 4 });
  let caminho = '';
  for (let y = 0; y < size; y++) {
    const linha = data[y] ?? [];
    for (let x = 0; x < size; ) {
      if (!linha[x]) {
        x++;
        continue;
      }
      let fim = x;
      while (fim < size && linha[fim]) fim++;
      caminho += `M${x} ${y}h${fim - x}v1h-${fim - x}z`;
      x = fim;
    }
  }
  const lado = size * QR_PIXEL;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${lado}" height="${lado}" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="${QR_FUNDO}"/><path d="${caminho}" fill="${QR_TINTA}"/></svg>`;
}
