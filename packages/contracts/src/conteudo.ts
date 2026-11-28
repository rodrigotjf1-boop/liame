import { z } from 'zod';

// O plano de conteúdo (`docs/plano-conteudo.md`, aprovado pelo dono em 28/11/2026; base de conhecimento §20). PC4, parte
// 1: o ranking dos produtos do cardápio do Regem, que o plano e as campanhas usam (seção 6.2). Agrupa pelo CÓDIGO do
// produto do Regem, nunca pelo nome escrito no pedido (cada canal escreve o mesmo produto de um jeito). Só leitura; só
// somas da loja, sem dado de pessoa.

const Slug = z.string().regex(/^[a-z0-9_]+$/).max(60);
const Dia = z.string().regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/);
const Micros = z.string().regex(/^-?[0-9]+$/);
const Quantidade = z.string().regex(/^[0-9]+(\.[0-9]+)?$/);

export const ContentProductsQuery = z.strictObject({
  brand_id: z.uuid(),
  /** Uma loja da marca; sem ela, a marca inteira. */
  unit_id: z.uuid().optional(),
});
export type ContentProductsQuery = z.infer<typeof ContentProductsQuery>;

export const ContentProduct = z.strictObject({
  /** A posição pelos pedidos (empate: a receita). */
  rank: z.number().int().min(1),
  /** O código do produto no Regem. */
  code: z.string().min(1).max(200),
  /** O nome do cadastro do Regem (o mais usado nos canais da própria loja); sem eles, o mais usado em qualquer canal. */
  name: z.string().max(300),
  /** Como os outros canais escrevem o mesmo produto (até 5). */
  other_names: z.array(z.string().max(300)).max(5),
  orders: z.number().int().min(0),
  quantity: Quantidade,
  /** A receita dos itens do produto (a soma das linhas, antes do estorno do pedido). */
  revenue_micros: Micros,
  previous: z.strictObject({ orders: z.number().int().min(0), quantity: Quantidade, revenue_micros: Micros }),
  /** `subindo`, `caindo`, `estavel` ou `novo` (sem venda nas 4 semanas antes). */
  trend: Slug,
  /** A variação dos pedidos contra as 4 semanas antes, em pontos percentuais; nula sem venda antes. */
  trend_percent: z.number().int().nullable(),
  /**
   * Receita menos custo, só com o custo do Regem em todas as linhas da janela; nula sem ele. O custo zero conta como
   * desconhecido (o Regem manda zero quando o produto não tem custo cadastrado).
   */
  margin_micros: Micros.nullable(),
  margin_percent: z.number().nullable(),
  /**
   * Onde a marca já mostrou o produto, pelo nome: as legendas das publicações lidas do Instagram (as mais novas, até
   * onde a leitura vai) e o produto e a descrição das fotos de Fotos.
   */
  seen: z.strictObject({ instagram_posts: z.number().int().min(0), last_post_at: z.string().nullable(), photos: z.number().int().min(0) }),
  /**
   * Os destaques, em ordem: `vende_bem_nunca_apareceu` (entre os 20% que mais vendem e sem post nem foto),
   * `margem_boa_pouca_venda` (a margem acima da mediana e os pedidos abaixo, com 5 ou mais produtos com custo) e
   * `subindo`.
   */
  highlights: z.array(Slug).max(10),
});
export type ContentProduct = z.infer<typeof ContentProduct>;

export const ContentProductsResponse = z.strictObject({
  brand_id: z.uuid(),
  unit_id: z.uuid().nullable(),
  /**
   * `disponivel`, `desligado_pela_liame` (a função `plano_conteudo` desta empresa), `sem_regem` (a marca sem o Regem
   * ligado: o Liame não tem os pedidos) ou `sem_permissao` (quem pergunta não vê Resultados, `vendas.ver`).
   */
  availability: z.strictObject({ status: Slug }),
  /**
   * Nulo fora de `disponivel`. Os pedidos confirmados nas 4 semanas completas até ontem, no fuso da loja (a marca
   * inteira: o fuso da primeira loja), contra as 4 semanas antes. `status`: `pronto`, `poucos_pedidos` (abaixo de
   * `minimum_orders`) ou `sem_pedidos`.
   */
  ranking: z
    .strictObject({
      status: Slug,
      from: Dia,
      to: Dia,
      previous_from: Dia,
      previous_to: Dia,
      days: z.number().int().min(1),
      minimum_orders: z.number().int().min(0),
      orders: z.number().int().min(0),
      /** Os que mais venderam, até 100. */
      products: z.array(ContentProduct).max(100),
      /** Quantos produtos venderam na janela. */
      products_total: z.number().int().min(0),
      /**
       * As linhas sem o código do produto que também não casam pelo nome com um código só (comuns na 99): os pedidos, a
       * receita e os nomes mais vendidos (até 10).
       */
      without_code: z.strictObject({ orders: z.number().int().min(0), revenue_micros: Micros, names: z.array(z.string().max(300)).max(10) }),
    })
    .nullable(),
  generated_at: z.string(),
});
export type ContentProductsResponse = z.infer<typeof ContentProductsResponse>;
