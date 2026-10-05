import { numerosDe } from '../ai/verificador-numeros.js';
import { normalizar } from './texto.js';

// Regras de texto que valem para o que vai a público num anúncio (A4, X6; `plano-a4.md` D-A4-28 e D-A4-29). As regras
// gerais (política, promessa de resultado, categoria proibida, dado pessoal) seguem em `texto.ts` e valem aqui também.
// Estas são conservadoras de propósito: o que elas barram não vai para a Meta, e a pessoa escreve de outro jeito. Base:
// `base-conhecimento.md` §6.2 (Código do CONAR: art. 27 §3º, preço e redução de preço; §4º, "grátis"; Anexo "F", item
// 2; Anexos "A", "P" e "T", bebida alcoólica; CDC, art. 37). Funções puras.

/** Muda junto com qualquer lista abaixo. */
export const REGRAS_DE_ANUNCIO_VERSAO = 1;

// As regex abaixo rodam sobre o texto normalizado (minúsculas, sem acento, espaços simples). São de alternativas
// literais, sem repetição aninhada: tempo linear no tamanho do texto.

/**
 * Bebida alcoólica. O anúncio que a cita leva cláusula de advertência em qualquer meio (inclusive o de bar e
 * restaurante) e não pode ter apelo imperativo de consumo nem oferta exagerada de unidades (CONAR, Anexos "A", "P" e
 * "T"). Nesta fase o Criativo não escreve esse anúncio. A lista pega também o prato que leva a bebida no nome
 * ("risoto ao vinho"): fica de fora por ora, e a pessoa escreve esse anúncio por conta própria.
 */
const ALCOOL =
  /(?<![a-z0-9])(bebidas? alcoolicas?|cervejas?|chopes?|chopps?|vinhos?|espumantes?|champanhes?|champagnes?|proseccos?|caipirinhas?|caipiroskas?|drinks?|drinques?|whiskys?|whiskeys?|uisques?|vodcas?|vodkas?|gins?|cachacas?|tequilas?|licor(?:es)?|conhaques?|long necks?|open bar|sangrias?|mojitos?|margaritas?|negronis?|aperol|heineken|budweiser|brahma|skol|itaipava|amstel|eisenbahn|spaten|stella artois|smirnoff|absolut|tanqueray|bacardi|campari|jagermeister)(?![a-z0-9])/g;

/** "Grátis" e o que quer dizer o mesmo (CONAR, art. 27 §4º): só quando a oferta diz. Cada grupo é uma família. */
const GRATIS: Array<[string, RegExp]> = [
  ['gratis', /(?<![a-z0-9])(gratis|gratuit[oa]s?|de graca)(?![a-z0-9])/g],
  ['cortesia', /(?<![a-z0-9])(cortesias?|por conta da casa)(?![a-z0-9])/g],
  ['brinde', /(?<![a-z0-9])(brindes?)(?![a-z0-9])/g],
];

/** Endereço de site no texto: o destino do anúncio é o do rastreio do Liame, nunca um link escrito na peça. */
const LINK = /https?:|www\.|\.(?:com|net|org|br|app|io|me)(?:\/|\b)/i;

/** As bebidas alcoólicas citadas num texto (sem repetir), como foram reconhecidas. */
export function bebidasAlcoolicas(texto: string): string[] {
  return [...new Set([...normalizar(texto).matchAll(ALCOOL)].map((m) => m[1]!))];
}

/** As palavras de "grátis" de um texto, cada uma com a família dela. */
export function palavrasDeGratis(texto: string): Array<{ familia: string; trecho: string }> {
  const t = normalizar(texto);
  return GRATIS.flatMap(([familia, formato]) => [...new Set([...t.matchAll(formato)].map((m) => m[1]!))].map((trecho) => ({ familia, trecho })));
}

/** As palavras de "grátis" do texto que as fontes (a oferta e o dossiê) não dizem. */
export function gratisForaDasFontes(texto: string, fontes: string[]): string[] {
  const ditas = new Set(fontes.flatMap(palavrasDeGratis).map((p) => p.familia));
  return palavrasDeGratis(texto)
    .filter((p) => !ditas.has(p.familia))
    .map((p) => p.trecho);
}

export const temLink = (texto: string): boolean => LINK.test(texto);

/** Um número como aparece num texto (o mesmo formato do verificador de números). */
const NUMERO = /\d[\d.,]*\d|\d/g;

/**
 * Os valores comerciais de um texto, como foram escritos: dinheiro ("R$ 34,90", "34,90 reais", "34,90") e percentual
 * ("20%", "20 por cento"). São o que só a oferta pode dizer: o resto dos números (quantidade, hora, ano) tem regra à parte.
 * O número com duas casas depois da vírgula conta como dinheiro mesmo sem o "R$" ("por 34,90"): é como o preço é escrito
 * no dia a dia. Uma nota escrita assim ("4,85") cai na mesma regra; com uma casa ("4,8"), não.
 */
export function valoresComerciais(texto: string): string[] {
  const valores: string[] = [];
  for (const m of texto.matchAll(NUMERO)) {
    const bruto = m[0];
    const antes = texto.slice(Math.max(0, m.index - 4), m.index);
    const depois = texto.slice(m.index + bruto.length, m.index + bruto.length + 12);
    const dinheiro = /R\$\s?$/i.test(antes) || /^\s?(?:reais|real)(?![a-zà-ÿ])/i.test(depois) || /,\d{2}$/.test(bruto);
    const percentual = /^\s?(?:%|por cento)/i.test(depois);
    if (dinheiro || percentual) valores.push(bruto);
  }
  return valores;
}

const forma = (valor: string): string => numerosDe(valor)[0] ?? '';

/**
 * Os valores comerciais do texto que a oferta não traz como valor comercial (o mesmo valor, em qualquer formato
 * equivalente). O "19" de "das 19h às 22h" não autoriza "R$ 19": a oferta precisa escrever o preço como preço.
 */
export function valoresForaDaOferta(texto: string, oferta: string): string[] {
  const daOferta = new Set(valoresComerciais(oferta).map(forma));
  return valoresComerciais(texto).filter((v) => !daOferta.has(forma(v)));
}
