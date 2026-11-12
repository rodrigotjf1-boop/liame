import { z } from 'zod';

// A campanha nova no Google, criada pausada (A5, Y9, parte 2; P45 pré-aprovado em 12/11/2026; D-A5-21 a D-A5-26). A peça
// aprovada em Criativos, com os textos nos tamanhos do Google e uma foto de Fotos, vira um pedido de criar uma campanha
// Performance Max no Google, pausada; ativar é outro pedido. Aqui ficam as partes puras: os limites do Google (lidos em
// 12/11/2026, base de conhecimento §3.1), a conferência dos textos, os recortes da foto, o estado que o pedido guarda (o
// que a pessoa aprova) e o plano da ferramenta `campanha_google_criar`. Sem rede e sem banco.

/** O recurso do pedido: `campanha_google:<id>`, a campanha nova do Google (`google_campaign_new`). */
export const recursoDaCampanhaGoogle = (id: string): string => `campanha_google:${id}`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** O id da campanha nova do Google no recurso do pedido, ou nulo quando o recurso é outro. */
export function campanhaGoogleDoRecurso(resourceId: string): string | null {
  const m = /^campanha_google:(.+)$/.exec(resourceId);
  return m && UUID.test(m[1]!) ? m[1]! : null;
}

/** Os limites do grupo de recursos da Performance Max (asset-requirements, lida em 12/11/2026). */
export const LIMITES_DO_GOOGLE = {
  titulo: 30,
  titulos: [3, 15],
  tituloLongo: 90,
  titulosLongos: [1, 5],
  descricao: 90,
  descricoes: [2, 5],
  nomeDaLoja: 25,
  /** A logo quadrada: pelo menos 128 × 128. */
  logoMinimo: 128,
} as const;

/** Os recortes da foto (D-A5-23): a deitada e a quadrada obrigatórias; a em pé só quando cabe. */
export const RECORTES = [
  { id: 'deitada', tipo: 'MARKETING_IMAGE', proporcao: 1.91, minLargura: 600, minAltura: 314, obrigatorio: true },
  { id: 'quadrada', tipo: 'SQUARE_MARKETING_IMAGE', proporcao: 1, minLargura: 300, minAltura: 300, obrigatorio: true },
  { id: 'em_pe', tipo: 'PORTRAIT_MARKETING_IMAGE', proporcao: 0.8, minLargura: 480, minAltura: 600, obrigatorio: false },
] as const;
export type IdDoRecorte = (typeof RECORTES)[number]['id'];

/** O maior pedaço da foto em cada proporção, pelo centro, e se ele alcança o mínimo do Google. Os mesmos números do P45. */
export function recortesDaFoto(largura: number, altura: number): { id: IdDoRecorte; largura: number; altura: number; ok: boolean; obrigatorio: boolean }[] {
  return RECORTES.map((r) => {
    const l = Math.min(largura, Math.round(altura * r.proporcao));
    const a = Math.round(l / r.proporcao);
    return { id: r.id, largura: l, altura: a, ok: l >= r.minLargura && a >= r.minAltura, obrigatorio: r.obrigatorio };
  });
}

/** O nome de cada recorte numa frase ("o recorte deitado"). */
const NOME_DO_RECORTE: Record<IdDoRecorte, string> = { deitada: 'deitado', quadrada: 'quadrado', em_pe: 'em pé' };

/** Por que a foto não serve (a pequena para um recorte obrigatório); nulo quando serve. As palavras do P45. */
export function motivoDaFotoPequena(largura: number, altura: number): string | null {
  const ruim = recortesDaFoto(largura, altura).find((r) => r.obrigatorio && !r.ok);
  if (!ruim) return null;
  const regra = RECORTES.find((r) => r.id === ruim.id)!;
  return `A foto é pequena para o recorte ${NOME_DO_RECORTE[ruim.id]}: o Google pede pelo menos ${regra.minLargura} × ${regra.minAltura}, e o maior recorte desta foto dá ${ruim.largura} × ${ruim.altura}. Use outra foto.`;
}

const tamanho = (t: string) => [...t].length;

/** Os textos do Google (D-A5-22) e o campo da recusa: as quantidades, os tamanhos e os repetidos. Nulo quando servem. */
export function motivoDosTextos(t: { titulos: string[]; titulosLongos: string[]; descricoes: string[] }): { campo: 'headlines' | 'long_headlines' | 'descriptions'; motivo: string } | null {
  const L = LIMITES_DO_GOOGLE;
  const grupos = [
    { campo: 'headlines' as const, itens: t.titulos, faixa: L.titulos, max: L.titulo, nome: ['título', 'títulos'] },
    { campo: 'long_headlines' as const, itens: t.titulosLongos, faixa: L.titulosLongos, max: L.tituloLongo, nome: ['título longo', 'títulos longos'] },
    { campo: 'descriptions' as const, itens: t.descricoes, faixa: L.descricoes, max: L.descricao, nome: ['descrição', 'descrições'] },
  ];
  for (const g of grupos) {
    const itens = g.itens.map((x) => x.trim());
    if (itens.some((x) => !x)) return { campo: g.campo, motivo: `Há ${g.nome[0]} vazio: escreva ou tire.` };
    if (itens.length < g.faixa[0]) return { campo: g.campo, motivo: `O Google pede pelo menos ${g.faixa[0]} ${g.faixa[0] === 1 ? g.nome[0] : g.nome[1]}.` };
    if (itens.length > g.faixa[1]) return { campo: g.campo, motivo: `O Google aceita até ${g.faixa[1]} ${g.nome[1]}.` };
    const longo = itens.find((x) => tamanho(x) > g.max);
    if (longo) return { campo: g.campo, motivo: `“${longo}” tem ${tamanho(longo)} caracteres: ${g.nome[0] === 'descrição' ? 'a descrição vai' : `o ${g.nome[0]} vai`} até ${g.max}.` };
    if (new Set(itens.map((x) => x.toLocaleLowerCase('pt-BR'))).size < itens.length) return { campo: g.campo, motivo: `Há ${g.nome[1]} repetidos: o Google recusa o mesmo texto duas vezes.` };
  }
  return null;
}

export const SituacaoDaCampanhaGoogle = z.enum(['pedida', 'criando', 'criada', 'nao_criada', 'cancelada']);
export type SituacaoDaCampanhaGoogle = z.infer<typeof SituacaoDaCampanhaGoogle>;

/**
 * O estado do pedido: o que a pessoa vê e aprova (a peça e os textos, a foto e os recortes, o nome e a logo da loja, a
 * loja e o raio, a verba, o fim e o destino). O plano e o hash dele saem daqui; o que existe no Google fica na linha da
 * campanha nova, fora do estado.
 */
export const EstadoDaCampanhaNovaNoGoogle = z.object({
  campanha: z.string().regex(UUID),
  marca: z.string().regex(UUID),
  nome: z.string().min(1).max(80),
  peca: z.object({ id: z.string().regex(UUID), versao: z.number().int().min(1) }),
  textos: z.object({
    titulos: z.array(z.string().min(1).max(LIMITES_DO_GOOGLE.titulo)).min(LIMITES_DO_GOOGLE.titulos[0]).max(LIMITES_DO_GOOGLE.titulos[1]),
    titulos_longos: z.array(z.string().min(1).max(LIMITES_DO_GOOGLE.tituloLongo)).min(LIMITES_DO_GOOGLE.titulosLongos[0]).max(LIMITES_DO_GOOGLE.titulosLongos[1]),
    descricoes: z.array(z.string().min(1).max(LIMITES_DO_GOOGLE.descricao)).min(LIMITES_DO_GOOGLE.descricoes[0]).max(LIMITES_DO_GOOGLE.descricoes[1]),
  }),
  /** A foto de Fotos (o arquivo, para o hash mudar se a foto mudar) e as medidas que dão os recortes. */
  foto: z.object({ id: z.string().regex(UUID), arquivo: z.string().min(1), largura: z.number().int().positive(), altura: z.number().int().positive() }),
  /** O nome da loja (até 25 caracteres) e a logo de Minha marca (a chave e o lado; quadrada). */
  loja_no_google: z.object({ nome: z.string().min(1).max(LIMITES_DO_GOOGLE.nomeDaLoja), logo: z.string().min(1), logo_lado: z.number().int().min(LIMITES_DO_GOOGLE.logoMinimo) }),
  conta: z.object({ id: z.string().regex(/^[0-9]{6,12}$/), nome: z.string() }),
  loja: z.object({ id: z.string().regex(UUID), nome: z.string(), latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180) }),
  raio_km: z.number().min(1).max(15),
  verba_diaria_micros: z.number().int().positive(),
  moeda: z.string().min(3).max(3),
  fim: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  fuso: z.string().min(1),
  link: z.string().url(),
  situacao: SituacaoDaCampanhaGoogle,
  ativa: z.boolean(),
});
export type EstadoDaCampanhaNovaNoGoogle = z.infer<typeof EstadoDaCampanhaNovaNoGoogle>;

export type PlanoDaCampanhaGoogle = { ok: true; desejado: EstadoDaCampanhaNovaNoGoogle } | { ok: false; motivo: string };

/**
 * O plano da ferramenta `campanha_google_criar`: a campanha nova pedida vira criada (pausada). O que já foi criado,
 * recusado ou cancelado não volta a ser pedido; os textos e a foto são conferidos de novo (o estado pode ter sido gravado
 * por outro caminho). Função pura.
 */
export function planoDaCampanhaGoogle(before: unknown): PlanoDaCampanhaGoogle {
  const lido = EstadoDaCampanhaNovaNoGoogle.safeParse(before);
  if (!lido.success) return { ok: false, motivo: 'Esta ferramenta é para uma campanha nova do Liame no Google.' };
  const e = lido.data;
  if (e.situacao === 'criada') return { ok: false, motivo: 'Esta campanha nova já foi criada no Google, pausada.' };
  if (e.situacao === 'cancelada') return { ok: false, motivo: 'Esta campanha nova foi cancelada.' };
  if (e.situacao === 'nao_criada') return { ok: false, motivo: 'Esta campanha nova não foi criada: peça de novo pela peça.' };
  const textos = motivoDosTextos({ titulos: e.textos.titulos, titulosLongos: e.textos.titulos_longos, descricoes: e.textos.descricoes });
  if (textos) return { ok: false, motivo: textos.motivo };
  const foto = motivoDaFotoPequena(e.foto.largura, e.foto.altura);
  if (foto) return { ok: false, motivo: foto };
  return { ok: true, desejado: { ...e, situacao: 'criada' } };
}
