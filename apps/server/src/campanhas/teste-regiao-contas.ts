import type { BairroDaCampanha } from './bairros-da-campanha.js';

// As contas do teste de região (plano da região, R8; D-RG-81 e D-RG-82). Um bairro da área de entrega fica 14 dias sem
// anúncio nas campanhas que o Liame criou, e o caixa diz quanto o anúncio traz ali. Partes puras, sem rede e sem banco:
//   - quando o bairro pode ser testado (os pedidos dele e os bairros para comparar, D-RG-82);
//   - se um conjunto da Meta mostra anúncio no bairro, pelo público dele (`targeting`): é o que diz se uma campanha de
//     fora do Liame atrapalha o teste, e quais conjuntos do Liame o bairro precisa deixar. Na dúvida, alcança: um
//     formato de lugar que o Liame não sabe provar que fica longe do bairro conta como "mostra anúncio lá";
//   - o que o anúncio traz no bairro, em faixa de 95% (a razão das razões entre o bairro e os outros, antes e durante).

/** Os dias do teste, e as semanas de antes que entram na conta (D-RG-81). */
export const DIAS_DO_TESTE_DE_REGIAO = 14;
export const SEMANAS_DE_ANTES = 4;
/** O mínimo de pedidos por semana do bairro e de outros bairros para comparar (D-RG-82; de partida, ajustados pelo piloto). */
export const PEDIDOS_POR_SEMANA_MINIMOS = 15;
export const OUTROS_BAIRROS_MINIMOS = 3;

/** Os pedidos de entrega de um bairro no período de antes (as 4 semanas). */
export type PedidosDoBairro = { nome: string; pedidos: number };

/**
 * O que impede testar o bairro, pelos pedidos das 4 semanas de antes; nulo quando pode. `bairros`: os bairros com nome
 * nos pedidos da loja (sem "outros", sem "sem bairro" e sem retirada). O nome é comparado como a tela mostra.
 */
export function oQueImpedeOBairro(alvo: string, bairros: readonly PedidosDoBairro[], semanas = SEMANAS_DE_ANTES): string | null {
  const doAlvo = bairros.find((b) => b.nome === alvo);
  if (!doAlvo) return `${alvo} não aparece nos pedidos de entrega da loja nas últimas ${semanas} semanas: o teste precisa dos pedidos do bairro para comparar.`;
  const porSemana = doAlvo.pedidos / semanas;
  if (porSemana < PEDIDOS_POR_SEMANA_MINIMOS) {
    return `${alvo} teve ${arredondado(porSemana)} pedidos por semana nas últimas ${semanas} semanas; o teste pede pelo menos ${PEDIDOS_POR_SEMANA_MINIMOS}. Com menos, a conta não diz nada.`;
  }
  const outros = bairros.filter((b) => b.nome !== alvo && b.pedidos > 0).length;
  if (outros < OUTROS_BAIRROS_MINIMOS) {
    return `Há ${outros === 0 ? 'nenhum outro bairro' : outros === 1 ? '1 outro bairro' : `${outros} outros bairros`} com pedidos para comparar; o teste pede pelo menos ${OUTROS_BAIRROS_MINIMOS}.`;
  }
  return null;
}

const arredondado = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1).replace('.', ','));

// ------------------------------------------------------------ o conjunto alcança o bairro?

/** O bairro no mapa: o centro e o raio do círculo dele (D-RG-54) e a chave dele na Meta, quando a busca achou. */
export type BairroNoMapa = Pick<BairroDaCampanha, 'meta' | 'latitude' | 'longitude' | 'raio_km'>;

export type AlcanceDoConjunto = { alcanca: boolean; porque: string };

/** A distância entre dois pontos, em km (a fórmula de haversine, com a Terra de 6.371 km). */
export function distanciaKm(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }): number {
  const rad = (g: number) => (g * Math.PI) / 180;
  const dLat = rad(b.latitude - a.latitude);
  const dLon = rad(b.longitude - a.longitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

const MILHA_EM_KM = 1.609344;
/** Os formatos de lugar que o Liame lê; qualquer outro com conteúdo (cidade, estado, país, CEP, lugar…) conta como alcança. */
const CONHECIDOS = new Set(['custom_locations', 'neighborhoods', 'location_types']);

type Circulo = { latitude: number; longitude: number; raioKm: number };

/** Os círculos (`custom_locations`) de um bloco de lugares; nulo quando algum não pode ser lido. */
function circulos(lugares: Record<string, unknown>): Circulo[] | null {
  const lista = lugares.custom_locations;
  if (lista === undefined) return [];
  if (!Array.isArray(lista)) return null;
  const saida: Circulo[] = [];
  for (const item of lista.slice(0, 500)) {
    const c = (item ?? {}) as Record<string, unknown>;
    const [lat, lon, raio] = [Number(c.latitude), Number(c.longitude), Number(c.radius)];
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(raio) || raio <= 0) return null;
    const unidade = c.distance_unit === 'kilometer' ? 1 : c.distance_unit === 'mile' || c.distance_unit === undefined ? MILHA_EM_KM : null;
    if (unidade === null) return null;
    saida.push({ latitude: lat, longitude: lon, raioKm: raio * unidade });
  }
  return saida;
}

/** As chaves de bairro (`neighborhoods`) de um bloco de lugares; nulo quando a lista não pode ser lida. */
function chavesDeBairro(lugares: Record<string, unknown>): string[] | null {
  const lista = lugares.neighborhoods;
  if (lista === undefined) return [];
  if (!Array.isArray(lista)) return null;
  const chaves: string[] = [];
  for (const item of lista.slice(0, 500)) {
    const chave = (item ?? {}) as { key?: unknown };
    if (typeof chave.key !== 'string' && typeof chave.key !== 'number') return null;
    chaves.push(String(chave.key));
  }
  return chaves;
}

const temConteudo = (v: unknown) => (Array.isArray(v) ? v.length > 0 : v !== undefined && v !== null && v !== '');

/**
 * O conjunto mostra anúncio no bairro, pelo público dele (`targeting` como a Meta devolve)? Alcança quando um círculo
 * encosta no círculo do bairro, quando a chave do bairro está nos bairros dele, ou quando ele usa um lugar que o Liame
 * não sabe medir (cidade, estado, país, CEP, mercado…) — a menos que o bairro esteja nos lugares de fora dele (pela chave,
 * ou dentro de um círculo de fora). Sem a chave do bairro na Meta, um conjunto por bairros conta como alcança.
 */
export function conjuntoAlcancaOBairro(targeting: unknown, bairro: BairroNoMapa): AlcanceDoConjunto {
  const t = targeting && typeof targeting === 'object' ? (targeting as Record<string, unknown>) : null;
  const geo = t?.geo_locations && typeof t.geo_locations === 'object' ? (t.geo_locations as Record<string, unknown>) : null;
  if (!geo) return { alcanca: true, porque: 'o público não diz os lugares' };

  // Os lugares de fora: o bairro excluído pela chave, ou inteiro dentro de um círculo excluído.
  const fora = t?.excluded_geo_locations && typeof t.excluded_geo_locations === 'object' ? (t.excluded_geo_locations as Record<string, unknown>) : null;
  if (fora) {
    const chavesFora = chavesDeBairro(fora) ?? [];
    if (bairro.meta && chavesFora.includes(bairro.meta)) return { alcanca: false, porque: 'o bairro está nos lugares de fora' };
    const circulosFora = circulos(fora) ?? [];
    if (circulosFora.some((c) => distanciaKm(c, bairro) + bairro.raio_km <= c.raioKm)) return { alcanca: false, porque: 'o bairro está dentro de um lugar de fora' };
  }

  for (const [chave, valor] of Object.entries(geo)) {
    if (!CONHECIDOS.has(chave) && temConteudo(valor)) return { alcanca: true, porque: `o público usa um lugar que o Liame não mede (${chave})` };
  }
  const deCirculo = circulos(geo);
  const deBairro = chavesDeBairro(geo);
  if (deCirculo === null || deBairro === null) return { alcanca: true, porque: 'um lugar do público não pôde ser lido' };
  if (deCirculo.some((c) => distanciaKm(c, bairro) <= c.raioKm + bairro.raio_km)) return { alcanca: true, porque: 'um círculo do público encosta no bairro' };
  if (deBairro.length) {
    if (!bairro.meta) return { alcanca: true, porque: 'o público usa bairros da Meta, e o bairro não tem a chave dela' };
    if (deBairro.includes(bairro.meta)) return { alcanca: true, porque: 'o bairro está nos bairros do público' };
  }
  if (!deCirculo.length && !deBairro.length) return { alcanca: true, porque: 'o público não diz os lugares' };
  return { alcanca: false, porque: 'os lugares do público ficam longe do bairro' };
}

// ------------------------------------------------------------ o que o anúncio traz no bairro

export type PedidosDoTeste = {
  /** Os pedidos do bairro e dos outros bairros nas semanas de antes e nos dias do teste. */
  alvoAntes: number;
  outrosAntes: number;
  alvoDurante: number;
  outrosDurante: number;
  semanasAntes?: number;
  diasDurante?: number;
};

export type EfeitoDoBairro = {
  /** Os pedidos por semana que o bairro teria feito seguindo os outros, e os que fez sem anúncio. */
  esperadoPorSemana: number;
  feitoPorSemana: number;
  /** O que o anúncio traz por semana: a melhor estimativa e a faixa de 95% (de, até; nunca abaixo de zero). */
  trazPorSemana: number;
  faixa: { de: number; ate: number };
  /** A faixa fica acima de zero: dá para dizer que o anúncio traz pedido ali. */
  provou: boolean;
};

const Z_95 = 1.959964;

/**
 * O que o anúncio traz no bairro (D-RG-81, a conta da seção 2.5 do desenho): o bairro teria seguido os outros bairros,
 * então o esperado no teste é o de antes vezes a variação dos outros. A diferença para o que ele fez é o que o anúncio
 * traz. A faixa sai da razão das razões (o bairro sobre os outros, no teste sobre antes), com o erro das quatro contagens
 * (o logaritmo da razão tem variância 1/a + 1/b + 1/c + 1/d). Nula quando alguma contagem é zero: não há conta.
 */
export function efeitoDoBairro(p: PedidosDoTeste): EfeitoDoBairro | null {
  const semanasAntes = p.semanasAntes ?? SEMANAS_DE_ANTES;
  const semanasDurante = (p.diasDurante ?? DIAS_DO_TESTE_DE_REGIAO) / 7;
  const { alvoAntes: a, outrosAntes: b, alvoDurante: c, outrosDurante: d } = p;
  if ([a, b, c, d].some((n) => !Number.isFinite(n) || n <= 0) || semanasAntes <= 0 || semanasDurante <= 0) return null;
  const esperado = a * (d / b);
  const razao = c / esperado;
  const erro = Z_95 * Math.sqrt(1 / a + 1 / b + 1 / c + 1 / d);
  const [razaoBaixa, razaoAlta] = [razao * Math.exp(-erro), razao * Math.exp(erro)];
  const porSemana = (n: number) => n / semanasDurante;
  const traz = porSemana(esperado - c);
  // A razão alta dá o menor efeito; a baixa, o maior.
  const de = Math.max(0, porSemana(esperado * (1 - razaoAlta)));
  const ate = Math.max(0, porSemana(esperado * (1 - razaoBaixa)));
  return {
    esperadoPorSemana: porSemana(esperado),
    feitoPorSemana: porSemana(c),
    trazPorSemana: Math.max(0, traz),
    faixa: { de, ate },
    provou: razaoAlta < 1,
  };
}
