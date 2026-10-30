import { z } from 'zod';
import { bebidasAlcoolicas, gratisForaDasFontes, temLink, valoresForaDaOferta } from '../../policy/anuncio.js';
import { conferirTexto, normalizar, type RegraDeTexto } from '../../policy/texto.js';
import { type CanalDoPost, CANAIS_DO_POST, LIMITE_DO_TEXTO } from '../../posts/post-plano.js';
import { temDadoPessoal, temMarcaDeRemocao } from '../sanitizar.js';
import { conferirNumeros } from '../verificador-numeros.js';

// O post que o Social media escreve e a conferência dele (A6, Z6, os posts, parte 1; D-A6-58 a D-A6-60; P21). O modelo
// escolhe uma das Fotos da marca (pela referência curta) e escreve o texto de cada canal do post. O código confere tudo
// antes de qualquer pessoa ver: a foto tem de ser da lista (o Liame não cria imagem nem usa foto de fora, P21), cada
// canal pedido tem o texto dele, e cada texto passa pelas regras do post (o link é do sistema; o link da bio só no
// Instagram e só quando há link; poucas hashtags; "grátis", desconto e preço só se o item da pauta ou a marca dizem), as
// da Liame e das plataformas, as da marca e o número que não está no item, no dia nem no dossiê. O que barra não vira
// pedido (o dia da pauta fica sem a proposta, e a pessoa faz o post à mão); o tamanho acima do recomendado e o
// Instagram que não diz onde pedir só avisam. Funções puras.

/** O schema que vai ao modelo: o mais simples possível; os canais e os limites são conferidos aqui, depois. */
export const RespostaDoPost = z.strictObject({
  /** A referência da foto escolhida (F1, F2…), ou nula quando nenhuma combina com o item. */
  foto: z.string().nullable(),
  /** Por que nenhuma foto combina (vazio quando há foto). */
  sem_foto: z.string(),
  textos: z.array(z.strictObject({ canal: z.string(), texto: z.string() })),
});
export type RespostaDoPost = z.infer<typeof RespostaDoPost>;

/** Do que a conferência parte: o item e o dia, o que a marca afirma, não diz e não cita, os canais, o link e as fotos. */
export interface BaseDoPost {
  item: string;
  /** O dia do post, como foi ao modelo ("sábado, 31/10/2026"): os números dele podem aparecer no texto. */
  dia: string;
  /** O que a marca afirma de si (`fatosDoDossie`): os produtos, as ofertas e os preços que o texto pode citar. */
  fatos: string;
  proibidas: string[];
  concorrentes: string[];
  canais: CanalDoPost[];
  link: boolean;
  /** As referências das fotos que foram ao modelo. */
  fotos: string[];
}

/**
 * O tamanho. O recomendado é um post que se lê sem "ver mais" (escolha do Liame, não regra da rede): acima, avisa. O
 * teto é o da legenda do Instagram (2.200, base §2.2); na Página, o do Liame para o texto da IA (2.000, bem abaixo do
 * limite do post, D-A6-34): acima, o post não segue.
 */
export const TAMANHO_RECOMENDADO_DO_POST: Record<CanalDoPost, number> = { instagram: 600, facebook: 600 };
export const TAMANHO_MAXIMO_DO_POST: Record<CanalDoPost, number> = { instagram: LIMITE_DO_TEXTO.instagram, facebook: 2000 };
/** Hashtags no texto, no máximo (a rede aceita mais; o post de restaurante não precisa). */
export const HASHTAGS_NO_MAXIMO = 5;

export const ITENS_DA_CONFERENCIA_DO_POST = ['regras_do_post', 'regras_da_liame', 'regras_da_marca', 'numeros', 'chamada', 'tamanho'] as const;
export type ItemDaConferenciaDoPost = (typeof ITENS_DA_CONFERENCIA_DO_POST)[number];
export type SituacaoDaConferenciaDoPost = 'passou' | 'aviso' | 'barrou';

export type TipoDeAchadoDoPost =
  | 'link_escrito'
  | 'link_da_bio_na_pagina'
  | 'link_que_nao_existe'
  | 'hashtags_demais'
  | 'gratis_fora'
  | 'promocao_fora'
  | 'valor_fora'
  | Exclude<RegraDeTexto, 'regra_da_marca'>
  | 'bebida_alcoolica'
  | 'concorrente'
  | 'regra_da_marca'
  | 'numero_fora'
  | 'sem_onde_pedir'
  | 'acima_do_recomendado';

export interface AchadoDoPost {
  tipo: TipoDeAchadoDoPost;
  /** O trecho que casou (a palavra, o número como foi escrito, a contagem); nunca um dado pessoal. */
  trecho: string;
}

export interface ItemConferidoDoPost {
  item: ItemDaConferenciaDoPost;
  situacao: SituacaoDaConferenciaDoPost;
  achados: AchadoDoPost[];
}

export interface ConferenciaDoTexto {
  situacao: SituacaoDaConferenciaDoPost;
  itens: ItemConferidoDoPost[];
  caracteres: number;
}

/** Os caracteres como a pessoa conta: uma letra com acento vale um. */
export const caracteres = (t: string): number => Array.from(t).length;

/** O link da bio (do Instagram), escrito de qualquer jeito: "link da bio", "link na bio", "link na minha bio". */
const LINK_DA_BIO = /(?<![a-z0-9])links? (?:da|na|do|no) (?:nossa |minha )?(?:bio|perfil)(?![a-z0-9])/;
/** A palavra "link", solta. */
const LINK_SOLTO = /(?<![a-z0-9])links?(?![a-z0-9])/;
/** Desconto e promoção: só quando o item da pauta ou a marca dizem (como o "grátis", CONAR art. 27). Cada uma é uma família. */
const PROMOCAO: Array<[string, RegExp]> = [
  ['desconto', /(?<![a-z0-9])(descontos?|abatimentos?)(?![a-z0-9])/g],
  ['promocao', /(?<![a-z0-9])(promocao|promocoes|promo|promocional|promocionais|liquidacao|queima de estoque)(?![a-z0-9])/g],
  ['metade', /(?<![a-z0-9])(metade do preco|pela metade|leve 2 pague 1|leve dois pague um|compre 1 leve 2|compre um leve dois)(?![a-z0-9])/g],
];
/** As hashtags de um texto. */
const HASHTAG = /#[\p{L}\p{N}_]+/gu;

/**
 * O texto sem o dia do post escrito curto ("30/10", e não o começo de "30/10/2026", que o verificador já reconhece
 * inteiro), do dia como foi ao modelo ("sexta-feira, 30/10/2026"). Sem data no dia, o texto como está.
 */
function semODiaCurto(texto: string, dia: string): string {
  const m = /(\d{2})\/(\d{2})\/\d{4}/.exec(dia);
  if (!m) return texto;
  const curto = `${m[1]}/${m[2]}`;
  const digito = (c: string | undefined) => c !== undefined && c >= '0' && c <= '9';
  let saida = '';
  let de = 0;
  for (let i = texto.indexOf(curto); i >= 0; i = texto.indexOf(curto, i + 1)) {
    const depois = i + curto.length;
    if (digito(texto[i - 1]) || digito(texto[depois]) || (texto[depois] === '/' && digito(texto[depois + 1]))) continue;
    saida += `${texto.slice(de, i)} `;
    de = depois;
  }
  return saida + texto.slice(de);
}

/** As palavras de desconto e promoção do texto que as fontes (o item e a marca) não dizem. */
function promocaoForaDasFontes(texto: string, fontes: string[]): string[] {
  const fonte = normalizar(fontes.join('\n'));
  const ditas = new Set(PROMOCAO.filter(([, f]) => [...fonte.matchAll(f)].length > 0).map(([familia]) => familia));
  const t = normalizar(texto);
  return PROMOCAO.filter(([familia]) => !ditas.has(familia)).flatMap(([, f]) => [...new Set([...t.matchAll(f)].map((m) => m[1]!))]);
}

/**
 * Confere o texto de um canal contra a base do post. O número precisa estar no item, no dia ou nos fatos da marca: o
 * funcionário não inventa preço, prazo nem horário; o preço e o percentual, só como valor comercial que o item ou a
 * marca escrevem.
 */
export function conferirTextoDoPost(texto: string, canal: CanalDoPost, base: BaseDoPost): ConferenciaDoTexto {
  const post: AchadoDoPost[] = [];
  const liame: AchadoDoPost[] = [];
  const marca: AchadoDoPost[] = [];
  const numeros: AchadoDoPost[] = [];
  const chamada: AchadoDoPost[] = [];
  const tamanho: AchadoDoPost[] = [];
  const normal = normalizar(texto);
  const fontes = [base.item, base.fatos];

  // As regras do post: o link é do sistema (D-A6-46), o link da bio só no Instagram e só quando há link (D-A6-22).
  if (temLink(texto)) post.push({ tipo: 'link_escrito', trecho: 'endereço de site no texto' });
  if (canal === 'facebook' && LINK_DA_BIO.test(normal)) post.push({ tipo: 'link_da_bio_na_pagina', trecho: 'link da bio' });
  else if (!base.link && LINK_SOLTO.test(normal)) post.push({ tipo: 'link_que_nao_existe', trecho: 'link' });
  const hashtags = texto.match(HASHTAG)?.length ?? 0;
  if (hashtags > HASHTAGS_NO_MAXIMO) post.push({ tipo: 'hashtags_demais', trecho: `${hashtags} de ${HASHTAGS_NO_MAXIMO}` });
  for (const trecho of gratisForaDasFontes(texto, fontes)) post.push({ tipo: 'gratis_fora', trecho });
  for (const trecho of promocaoForaDasFontes(texto, fontes)) post.push({ tipo: 'promocao_fora', trecho });
  for (const trecho of new Set(valoresForaDaOferta(texto, fontes.join('\n')))) post.push({ tipo: 'valor_fora', trecho });

  // As regras da Liame e das plataformas: as de todo texto, a bebida alcoólica e o concorrente.
  const doTexto = conferirTexto(texto);
  for (const a of doTexto) if (a.regra !== 'regra_da_marca') liame.push({ tipo: a.regra, trecho: a.trecho });
  // O que sai do gateway já vem limpo: o dado pessoal chega como a marca da limpeza ("[telefone]").
  if (temMarcaDeRemocao(texto) && !doTexto.some((a) => a.regra === 'dado_pessoal')) liame.push({ tipo: 'dado_pessoal', trecho: 'dado pessoal no texto' });
  for (const trecho of bebidasAlcoolicas(texto)) liame.push({ tipo: 'bebida_alcoolica', trecho });
  for (const a of conferirTexto(texto, { daMarca: base.concorrentes })) if (a.regra === 'regra_da_marca') liame.push({ tipo: 'concorrente', trecho: a.trecho });

  // O que a marca nunca diz.
  for (const a of conferirTexto(texto, { daMarca: base.proibidas })) if (a.regra === 'regra_da_marca') marca.push({ tipo: 'regra_da_marca', trecho: a.trecho });
  // O número fora do item, do dia e dos fatos da marca. A hashtag não conta como texto, e o dia do post escrito curto
  // ("30/10") vale como o dia: o verificador só reconhece a data inteira, e liberar o "30" e o "10" soltos deixaria
  // passar "30 minutos".
  const semODia = semODiaCurto(texto.replace(HASHTAG, ' '), base.dia);
  for (const trecho of new Set(conferirNumeros(semODia, [...fontes, base.dia]).fora)) numeros.push({ tipo: 'numero_fora', trecho });

  // A chamada: com o link, o Instagram diz onde pedir (o link da bio). Só avisa.
  if (canal === 'instagram' && base.link && !LINK_DA_BIO.test(normal)) chamada.push({ tipo: 'sem_onde_pedir', trecho: 'link da bio' });
  const n = caracteres(texto);
  if (n > TAMANHO_RECOMENDADO_DO_POST[canal]) tamanho.push({ tipo: 'acima_do_recomendado', trecho: `${n} de ${TAMANHO_RECOMENDADO_DO_POST[canal]}` });

  const item = (nome: ItemDaConferenciaDoPost, achados: AchadoDoPost[], comAchado: SituacaoDaConferenciaDoPost): ItemConferidoDoPost => ({
    item: nome,
    situacao: achados.length ? comAchado : 'passou',
    achados,
  });
  const itens = [
    item('regras_do_post', post, 'barrou'),
    item('regras_da_liame', liame, 'barrou'),
    item('regras_da_marca', marca, 'barrou'),
    item('numeros', numeros, 'barrou'),
    item('chamada', chamada, 'aviso'),
    item('tamanho', tamanho, 'aviso'),
  ];
  return { situacao: piorDe(itens.map((i) => i.situacao)), itens, caracteres: n };
}

const piorDe = (s: SituacaoDaConferenciaDoPost[]): SituacaoDaConferenciaDoPost => (s.includes('barrou') ? 'barrou' : s.includes('aviso') ? 'aviso' : 'passou');

/** O post como o código o aceita: a foto da lista, o texto de cada canal e a conferência de cada texto. */
export interface PostConferido {
  /** A referência da foto escolhida (uma das que foram ao modelo). */
  foto: string;
  textos: Array<{ canal: CanalDoPost; texto: string; conferencia: ConferenciaDoTexto }>;
  /** A pior situação entre os textos: com um texto barrado, o post não vira pedido. */
  situacao: SituacaoDaConferenciaDoPost;
}

/**
 * Por que a resposta do modelo nem chegou à conferência: nenhuma foto combina (com o porquê dele), a foto fora da lista,
 * um canal do post sem texto, um canal que o post não tem, o texto vazio, longo demais ou com dado pessoal.
 */
export type DescarteDoPost = 'sem_foto' | 'foto_fora_da_lista' | 'canal_faltando' | 'canal_a_mais' | 'vazio' | 'longo' | 'dado_pessoal';

/** Os espaços arrumados, mantendo as quebras de linha do post (no máximo uma linha em branco seguida). */
export const arrumarTextoDoPost = (t: string): string =>
  t
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

/** O porquê de não ter foto, como o modelo escreveu, numa linha só e curto (vai para a ficha, nunca para o post). */
export const PORQUE_SEM_FOTO_MAXIMO = 200;

export type PostDaResposta = { ok: true; post: PostConferido } | { ok: false; descarte: DescarteDoPost; porque?: string };

/** O que o código faz com a resposta do modelo: a foto da lista, um texto por canal do post, e cada texto conferido. */
export function postDaResposta(r: RespostaDoPost, base: BaseDoPost): PostDaResposta {
  const foto = r.foto?.trim() ?? '';
  if (!foto) return { ok: false, descarte: 'sem_foto', porque: r.sem_foto.replace(/\s+/g, ' ').trim().slice(0, PORQUE_SEM_FOTO_MAXIMO) };
  if (!base.fotos.includes(foto)) return { ok: false, descarte: 'foto_fora_da_lista' };
  const porCanal = new Map<string, string>();
  for (const t of r.textos) {
    const canal = t.canal.trim().toLowerCase();
    if (!(base.canais as string[]).includes(canal) || porCanal.has(canal)) return { ok: false, descarte: 'canal_a_mais' };
    porCanal.set(canal, arrumarTextoDoPost(t.texto));
  }
  const textos: PostConferido['textos'] = [];
  for (const canal of CANAIS_DO_POST.filter((c) => base.canais.includes(c))) {
    const texto = porCanal.get(canal);
    if (texto === undefined) return { ok: false, descarte: 'canal_faltando' };
    if (!texto) return { ok: false, descarte: 'vazio' };
    if (caracteres(texto) > TAMANHO_MAXIMO_DO_POST[canal]) return { ok: false, descarte: 'longo' };
    if (temDadoPessoal(texto)) return { ok: false, descarte: 'dado_pessoal' };
    textos.push({ canal, texto, conferencia: conferirTextoDoPost(texto, canal, base) });
  }
  return { ok: true, post: { foto, textos, situacao: piorDe(textos.map((t) => t.conferencia.situacao)) } };
}

/** Sinais de estilo que o prompt pede e a conferência não barra (não são regra do post): servem ao eval. */
export function estiloDoPost(canal: CanalDoPost, texto: string): string[] {
  const sinais: string[] = [];
  if (canal === 'facebook' && (texto.match(HASHTAG)?.length ?? 0) > 0) sinais.push('hashtag_na_pagina');
  if ((texto.match(/\p{Extended_Pictographic}/gu)?.length ?? 0) > 3) sinais.push('emojis_demais');
  if (/[A-ZÀ-Ú]{12,}/u.test(texto.replace(/\s/g, ''))) sinais.push('caixa_alta');
  return sinais;
}
