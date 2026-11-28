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
   * onde a leitura vai). `photos` é só informação: as fotos de Fotos com o produto escrito (o material que existe); a
   * foto só conta como aparição quando estiver etiquetada e tiver saído em post (D-PC-35, com a PC3).
   */
  seen: z.strictObject({ instagram_posts: z.number().int().min(0), last_post_at: z.string().nullable(), photos: z.number().int().min(0) }),
  /**
   * Os destaques, em ordem: `vende_bem_nunca_apareceu` (entre os 20% que mais vendem e sem legenda de post; D-PC-35),
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
       * As linhas sem o código do produto do Regem, fora do ranking (D-PC-35; comuns na 99): os pedidos, a receita e os
       * nomes mais vendidos (até 10).
       */
      without_code: z.strictObject({ orders: z.number().int().min(0), revenue_micros: Micros, names: z.array(z.string().max(300)).max(10) }),
    })
    .nullable(),
  generated_at: z.string(),
});
export type ContentProductsResponse = z.infer<typeof ContentProductsResponse>;

// PC4, parte 2: as datas e as tendências do período (seção 6.3; D-PC-10 e D-PC-18). O calendário comercial do Liame e os
// eventos do Pulso, o produto da DMS que lê as fontes públicas (os feriados do estado e da cidade, os dias de comida, os
// jogos, as estreias), e o "Em alta" do Pulso (só assunto com manchete de portal brasileiro). Só leitura.

export const ContentDatesQuery = z.strictObject({
  brand_id: z.uuid(),
  /** Uma loja da marca (o município dela); sem ela, a primeira loja da marca com o município. */
  unit_id: z.uuid().optional(),
  /** O primeiro dia; sem ele, hoje (no fuso da loja). */
  from: Dia.optional(),
  /** O último dia; sem ele, 30 dias depois do primeiro. Até 62 dias no período. */
  to: Dia.optional(),
});
export type ContentDatesQuery = z.infer<typeof ContentDatesQuery>;

export const ContentDate = z.strictObject({
  day: Dia,
  end_day: Dia,
  /** A hora (HH:MM, no fuso do evento) do evento com hora, como o jogo; nula no evento do dia inteiro. */
  time: z.string().regex(/^[0-9]{2}:[0-9]{2}$/).nullable(),
  name: z.string().max(300),
  /**
   * `feriado_nacional` e `varejo` (o calendário do Liame, com a lei ou a regra); `feriado`, `ponto_facultativo`, `comida`
   * (o dia de comida), `comemorativa`, `dinheiro`, `jogo`, `estreia` e `tv` (o Pulso).
   */
  kind: Slug,
  /** `nacional`, `uf` ou `municipio`. */
  scope: Slug,
  source: z.strictObject({ name: z.string().max(300), url: z.string().max(2000).nullable() }),
  /** `liame` (o calendário comercial) ou `pulso`. */
  origin: Slug,
  /** O tema do dia de comida (`hamburguer`, `pizza`...); nulo nos outros. */
  food_theme: Slug.nullable(),
  /** O dia de comida combina com o cardápio da marca (o tema aparece nos nomes dos produtos ou em Minha marca). */
  menu_match: z.boolean(),
});
export type ContentDate = z.infer<typeof ContentDate>;

export const ContentTrend = z.strictObject({
  title: z.string().max(500),
  /** A nota do Pulso, de 0 a 100. */
  score: z.number().min(0).max(100),
  /** A faixa da nota no Pulso. */
  band: Slug,
  /** `do_tema` (um tema que a DMS vigia) ou `em_alta` (o que o Brasil ou o estado está lendo). */
  pile: Slug,
  /** `nacional`, `uf` ou `municipio`. */
  scope: Slug,
  /** Até 3 manchetes de portal brasileiro: só o título, o endereço e a fonte. */
  headlines: z.array(z.strictObject({ title: z.string().max(500), url: z.string().max(2000), source: z.string().max(200).nullable() })).max(3),
});
export type ContentTrend = z.infer<typeof ContentTrend>;

export const ContentDatesResponse = z.strictObject({
  brand_id: z.uuid(),
  unit_id: z.uuid().nullable(),
  /** `disponivel` ou `desligado_pela_liame` (a função `plano_conteudo` desta empresa). */
  availability: z.strictObject({ status: Slug }),
  from: Dia,
  to: Dia,
  /** O município da loja (o código IBGE, da loja no mapa); nulo sem loja no mapa. */
  municipality: z.strictObject({ ibge_code: z.string().regex(/^[0-9]{7}$/), name: z.string().max(200).nullable(), state: z.string().max(2).nullable() }).nullable(),
  /**
   * A situação do Pulso nesta resposta: `em_dia`, `desligado` (o Liame ainda não está ligado ao Pulso), `sem_municipio`
   * (a loja não está no mapa: só as datas nacionais do Liame) ou `falhou` (o Pulso não respondeu agora: só as do Liame).
   */
  pulse_status: Slug,
  dates: z.array(ContentDate).max(500),
  /** Os assuntos em alta no Brasil e no estado da loja, até 10; vazio fora de `em_dia`. */
  trends: z.array(ContentTrend).max(10),
  generated_at: z.string(),
});
export type ContentDatesResponse = z.infer<typeof ContentDatesResponse>;
