import { z } from 'zod';
import { Cnpj } from './auth.js';

// O DMS Graph no Liame (plano "recursos por produto", F4; protótipo aprovado pelo dono em 22/11/2026, que muda a D-A6-6):
// a empresa conecta o Graph e edita a luz, o fundo e o enquadramento de uma foto real. O produto não muda, a original
// fica, e a editada só entra em Fotos depois de uma pessoa conferir.

/** O pedido escrito pela pessoa, opcional: até este tanto de letras. */
export const FOTO_EDICAO_PEDIDO_MAX = 200;
/** O que o Graph aceita de proporção (não há 4:5). */
export const FOTO_EDICAO_ENQUADRAMENTOS = ['original', '1:1', '9:16', '16:9'] as const;

export const FotoEdicaoOpcoes = z.strictObject({
  light: z.boolean(),
  background: z.boolean(),
  framing: z.enum(FOTO_EDICAO_ENQUADRAMENTOS),
});
export type FotoEdicaoOpcoes = z.infer<typeof FotoEdicaoOpcoes>;

/** O que marca uma foto como editada: a tela mostra a etiqueta, e quem aprova vê o pedido e abre a original. */
export const BrandPhotoEdited = z.strictObject({
  /** A foto original; nulo se ela foi apagada depois. */
  from_id: z.uuid().nullable(),
  at: z.iso.datetime(),
  by: z.string().nullable(),
  options: FotoEdicaoOpcoes,
  prompt: z.string().nullable(),
});
export type BrandPhotoEdited = z.infer<typeof BrandPhotoEdited>;

const COMIDA =
  '(queijo|cheddar|bacon|carne|frango|hamb[uú]rguer|burger|p[aã]o|molho|salada|alface|tomate|cebola|picles|ovo|batata|fritas?|recheio|por[cç][aã]o|ingredientes?|comida|produto|prato|lanche|bebida|sobremesa)';
// O verbo antes da comida ("põe mais queijo") ou o tamanho e a aparência depois dela ("o hambúrguer maior").
const MUDA_PRODUTO = new RegExp(
  '\\b(mais|menos|maior|menor|dobr\\w*|tripl\\w*|aument\\w*|diminu\\w*|acrescent\\w*|adicion\\w*|coloc\\w*|inclu\\w*|p[oõ]e|p[oô]r|bot\\w*|troc\\w*|substitu\\w*|tir\\w*|remov\\w*)\\b[^.]{0,40}\\b' +
    COMIDA +
    '\\b|\\b' +
    COMIDA +
    '\\b[^.]{0,30}\\b(maior|maiores|menor|menores|gigante|dobrad\\w*|dupl[oa]|tripl[oa]|derretid\\w*|crocante|suculent\\w*|rechead\\w*)\\b',
  'i',
);
const ESCREVE = /\b(escrev\w*|texto|frase|legenda|pre[cç]os?|promo[cç][aã]o|desconto|oferta|logo|logotipo|letreiro|marca d.?[aá]gua)\b/i;
const PESSOA = /\b(pessoas?|gente|modelo|clientes?|mulher|homem|crian[cç]a|m[aã]os?|rosto)\b/i;

export type ProblemaDoPedidoDaFoto = { code: 'pedido-muda-produto' | 'pedido-texto-na-foto' | 'pedido-com-pessoa'; frase: string };

/**
 * O pedido óbvio que não pode ir, a mesma regra na tela e no servidor (V74). Não pega tudo: por isso a pessoa confere o
 * antes e depois, e quem aprova vê o pedido. O servidor manda ao Graph, antes do pedido, a regra fixa de não mudar o produto.
 */
export function problemaDoPedidoDaFoto(texto: string): ProblemaDoPedidoDaFoto | null {
  if (MUDA_PRODUTO.test(texto)) return { code: 'pedido-muda-produto', frase: 'Ele muda o produto. Peça só luz, fundo, cenário ou enquadramento.' };
  if (ESCREVE.test(texto)) return { code: 'pedido-texto-na-foto', frase: 'A foto não leva texto, preço nem logotipo. Para isso, use a legenda do post.' };
  if (PESSOA.test(texto)) return { code: 'pedido-com-pessoa', frase: 'A edição não coloca pessoas na foto.' };
  return null;
}

export const DmsGraphQuota = z.strictObject({ used: z.int().min(0), total: z.int().min(0) });
export type DmsGraphQuota = z.infer<typeof DmsGraphQuota>;

export const DmsGraphSituation = z.strictObject({
  /** A função `dms_graph_fotos` está ligada para a empresa e o servidor está configurado. Falso: a tela não mostra nada. */
  enabled: z.boolean(),
  /** Quem pede pode conectar e desligar (`contas.conectar`). */
  can_connect: z.boolean(),
  /** Quem pede pode editar foto (`fotos.enviar`). */
  can_edit: z.boolean(),
  company_has_cnpj: z.boolean(),
  link: z
    .strictObject({
      account_name: z.string().nullable(),
      connected_at: z.iso.datetime(),
      connected_by: z.string().nullable(),
      permissions: z.array(z.string()),
      last_used_at: z.iso.datetime().nullable(),
    })
    .nullable(),
  /** O acesso foi tirado do lado do Graph: quando. A tela avisa e oferece conectar de novo. */
  revoked_by_graph_at: z.iso.datetime().nullable(),
  /** A franquia de imagem da empresa no mês; nula quando o Graph não respondeu agora. */
  quota: DmsGraphQuota.nullable(),
});
export type DmsGraphSituation = z.infer<typeof DmsGraphSituation>;

export const DmsGraphStartResponse = z.strictObject({ authorize_url: z.url() });
export type DmsGraphStartResponse = z.infer<typeof DmsGraphStartResponse>;

/** O que o Graph devolveu ao navegador na volta, tal como veio. */
export const DmsGraphCallbackRequest = z.strictObject({
  code: z.string().max(400).optional(),
  state: z.string().max(200).optional(),
  iss: z.string().max(200).optional(),
  error: z.string().max(100).optional(),
});
export type DmsGraphCallbackRequest = z.infer<typeof DmsGraphCallbackRequest>;

export const DmsGraphCallbackResponse = z.strictObject({
  connected: z.boolean(),
  account_name: z.string().nullable(),
});
export type DmsGraphCallbackResponse = z.infer<typeof DmsGraphCallbackResponse>;

export const DmsGraphCnpjRequest = z.strictObject({ cnpj: Cnpj });
export type DmsGraphCnpjRequest = z.infer<typeof DmsGraphCnpjRequest>;

export const CreateBrandPhotoEditRequest = z.strictObject({
  light: z.boolean(),
  background: z.boolean(),
  framing: z.enum(FOTO_EDICAO_ENQUADRAMENTOS),
  prompt: z.string().trim().max(FOTO_EDICAO_PEDIDO_MAX).optional(),
  /** Gerada pela tela a cada tentativa: repetir com a mesma não gasta de novo; "Fazer outra versão" manda outra. */
  key: z.uuid(),
});
export type CreateBrandPhotoEditRequest = z.infer<typeof CreateBrandPhotoEditRequest>;

export const BrandPhotoEditPreview = z.strictObject({
  id: z.uuid(),
  source_id: z.uuid(),
  url: z.url(),
  width: z.int().min(1),
  height: z.int().min(1),
  bytes: z.int().min(1),
  urls_expire_at: z.iso.datetime(),
  quota: DmsGraphQuota.nullable(),
});
export type BrandPhotoEditPreview = z.infer<typeof BrandPhotoEditPreview>;

export const SaveBrandPhotoEditRequest = z.strictObject({
  /** A pessoa conferiu que o produto continua igual ao que a loja entrega. */
  confirmed: z.literal(true),
});
export type SaveBrandPhotoEditRequest = z.infer<typeof SaveBrandPhotoEditRequest>;
