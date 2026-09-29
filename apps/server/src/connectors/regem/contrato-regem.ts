import { z } from 'zod';

// Contrato Regem → Liame, versão 1 (docs/integracoes/regem.md e cupons.md; ADR-019). A resposta é
// conferida campo a campo: o que foge do contrato vira erro definitivo do conector, nunca dado torto no
// banco. Dinheiro em centavos inteiros; instantes ISO 8601; datas AAAA-MM-DD no fuso da loja.

const Instante = z.iso.datetime({ offset: true });
const Data = z.iso.date();
const Centavos = z.number().int().min(0).max(900_000_000_000_000);
const Id = z.string().min(1).max(100);
/** A versão do recurso só cresce; número inteiro (até 2^53) ou texto de dígitos. */
const Versao = z.union([z.number().int().min(0), z.string().regex(/^\d{1,19}$/)]).transform((v) => BigInt(v));
const Texto = (max: number) => z.string().max(max);

export const LojaRegem = z.object({
  loja_id: Id,
  loja_nome: Texto(300).min(1),
  empresa_nome: Texto(300).nullable().optional(),
  fuso: Texto(64).min(1),
  moeda: z.string().regex(/^[A-Z]{3}$/),
  escopos: z.array(z.string().regex(/^[a-z_.]+$/)).max(50),
  /** Endereço público do cardápio online da loja (destino dos links de campanha, F5). */
  cardapio_url: z.url().max(2048).nullable().optional(),
});
export type LojaRegem = z.infer<typeof LojaRegem>;

/** Troca do código pelo token (C1b): um token por loja autorizada. */
export const TokensRegem = z.object({
  lojas: z
    .array(
      LojaRegem.extend({
        token: z.string().regex(/^rgm_it_[A-Za-z0-9_-]{20,200}$/),
      }),
    )
    .min(1)
    .max(200),
});
export type TokensRegem = z.infer<typeof TokensRegem>;

const GrupoCanal = z.enum(['cardapio', 'whatsapp', 'presencial', 'marketplace', 'outro']);

const ItemPedido = z.object({
  id: Id,
  produto_id: Id.nullable().optional(),
  nome: Texto(300).min(1),
  quantidade: z.union([z.string().regex(/^\d{1,10}(\.\d{1,3})?$/), z.number().min(0)]).transform((v) => String(v)),
  receita_centavos: Centavos,
  custo_centavos: Centavos.nullable(),
});

const OrigemPedido = z.object({
  capturado_em: Instante,
  lk: Texto(1024).nullable().optional(),
  utm_source: Texto(1024).nullable().optional(),
  utm_medium: Texto(1024).nullable().optional(),
  utm_campaign: Texto(1024).nullable().optional(),
  utm_content: Texto(1024).nullable().optional(),
  utm_term: Texto(1024).nullable().optional(),
  campaign_id: Texto(1024).nullable().optional(),
  adset_id: Texto(1024).nullable().optional(),
  adgroup_id: Texto(1024).nullable().optional(),
  ad_id: Texto(1024).nullable().optional(),
  gclid: Texto(1024).nullable().optional(),
  gbraid: Texto(1024).nullable().optional(),
  wbraid: Texto(1024).nullable().optional(),
  fbclid: Texto(1024).nullable().optional(),
});
export type OrigemPedido = z.infer<typeof OrigemPedido>;

export const PedidoRegem = z.object({
  id: Id,
  versao: Versao,
  atualizado_em: Instante,
  canal: z.string().regex(/^[a-z0-9_]{1,40}$/),
  grupo_canal: GrupoCanal,
  /** `removido`: a venda deixou de existir sozinha (comanda que virou parte de um pedido); sai das contas. */
  situacao: z.enum(['confirmado', 'cancelado', 'removido']),
  moeda: z.string().regex(/^[A-Z]{3}$/),
  fuso: Texto(64).min(1),
  receita_centavos: Centavos,
  desconto_loja_centavos: Centavos,
  estornado_centavos: Centavos,
  cupom: Texto(60).nullable(),
  cliente: z
    .object({
      id: Id,
      telefone: Texto(40).nullable(),
      novo: z.boolean().nullable().optional(),
    })
    .nullable(),
  criado_em: Instante.nullable().optional(),
  confirmado_em: Instante,
  /** O instante que o Painel do Regem usa para pôr a venda no dia (a receita do dia bate por ele). */
  faturado_em: Instante.nullable().optional(),
  cancelado_em: Instante.nullable(),
  itens: z.array(ItemPedido).max(1000),
  origem: OrigemPedido.nullable().optional(),
});
export type PedidoRegem = z.infer<typeof PedidoRegem>;

export const ClienteAnonimizado = z.object({
  id: Id,
  anonimizado_em: Instante,
  versao: Versao,
  atualizado_em: Instante,
});

export const CupomRegem = z.object({
  id: Id,
  versao: Versao,
  atualizado_em: Instante,
  codigo: Texto(60).min(1),
  nome: Texto(300).nullable().optional(),
  tipo: z.enum(['percentual', 'valor', 'frete_gratis', 'outro']),
  percentual: z.string().regex(/^\d{1,3}(\.\d{1,2})?$/).nullable().optional(),
  valor_centavos: Centavos.nullable().optional(),
  teto_desconto_centavos: Centavos.nullable().optional(),
  pedido_minimo_centavos: Centavos.nullable().optional(),
  valido_de: Data.nullable().optional(),
  valido_ate: Data.nullable().optional(),
  fuso: Texto(64).min(1),
  ativo: z.boolean(),
  max_usos: z.number().int().min(0).nullable().optional(),
  usos: z.number().int().min(0),
  condicoes: z.record(z.string(), z.unknown()).optional(),
  todas_as_lojas: z.boolean().optional(),
  /** Lápide: o cupom foi apagado na origem. */
  removido: z.boolean().optional(),
});
export type CupomRegem = z.infer<typeof CupomRegem>;

export const UsoCupomRegem = z.object({
  id: Id,
  versao: Versao,
  atualizado_em: Instante,
  cupom_id: Id,
  codigo: Texto(60).min(1),
  pedido_id: Id.nullable(),
  usado_em: Instante,
  desconto_centavos: Centavos.nullable().optional(),
  removido: z.boolean().optional(),
});

/** Página com cursor (contrato de cupons §2). */
export const pagina = <T extends z.ZodType>(item: T) =>
  z.object({
    itens: z.array(item).max(500),
    proximo_cursor: z.string().max(2000).nullable(),
    tem_mais: z.boolean(),
  });
