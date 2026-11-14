import { z } from 'zod';
import { DistrictCode, NEW_CAMPAIGN_DISTRICTS_MAX } from './campanhas-novas.js';

// O teste de criativo (plano da região, R8; protótipo dos testes aprovado pelo dono em 13/11/2026; D-RG-76 a D-RG-80 e
// D-RG-91). Duas peças aprovadas em Criativos rodam lado a lado numa campanha de teste da Meta: dois conjuntos iguais (o
// mesmo público, a mesma verba, o mesmo objetivo), um anúncio em cada um, e um cupom do Regem para cada criativo, com o
// mesmo desconto. Quem decide é o caixa: os pedidos confirmados de cada criativo.

/** O mínimo e o máximo de dias do teste (D-RG-79). O Liame olha o teste só ao fim de cada semana inteira (D-RG-91). */
export const CREATIVE_TEST_DAYS = { min: 7, max: 28 } as const;
/** A verba mínima do teste inteiro: R$ 10,00 por dia para cada criativo (D-RG-78). */
export const CREATIVE_TEST_MIN_DAILY_BUDGET_MICROS = 20_000_000;

export const CREATIVE_TEST_STATUSES = ['pedido', 'criando', 'pronto', 'rodando', 'terminado', 'encerrado', 'interrompido', 'cancelado'] as const;
/**
 * `pedido` (espera a aprovação em Aprovações), `criando` (aprovado: a campanha de teste e os cupons estão sendo
 * criados), `pronto` (tudo criado e pausado: o teste começa quando a campanha for ativada), `rodando`, `terminado`
 * (chegou ao fim, com ou sem vencedor), `encerrado` (uma pessoa encerrou antes), `interrompido` (mexeram por fora ou a
 * plataforma recusou: o Liame não conclui) ou `cancelado` (o pedido foi recusado ou expirou, ou a campanha não foi criada).
 */
export const CreativeTestStatus = z.enum(CREATIVE_TEST_STATUSES);
export type CreativeTestStatus = z.infer<typeof CreativeTestStatus>;

export const CREATIVE_TEST_COUPON_STATUSES = ['a_criar', 'pedido', 'criado', 'falhou'] as const;
export const CreativeTestCouponStatus = z.enum(CREATIVE_TEST_COUPON_STATUSES);

/** O código do cupom de um criativo: de 4 a 20 letras maiúsculas ou números, sem espaço (como o cupom de campanha). */
export const CreativeTestCouponCode = z.string().regex(/^[A-Z0-9]{4,20}$/, 'De 4 a 20 letras maiúsculas ou números, sem espaço');

/** O desconto dos dois cupons, o mesmo nos dois (D-RG-77): em % ou em valor fixo, com o pedido mínimo, quando há. */
export const CreativeTestDiscount = z
  .strictObject({
    kind: z.enum(['percentual', 'valor']),
    /** Só no percentual: de 1 a 100, inteiro. */
    percent: z.int().min(1).max(100).optional(),
    /** Só no valor fixo, em centavos. */
    value_cents: z.int().min(1).max(100_000_000).optional(),
    min_order_cents: z.int().min(0).max(100_000_000).default(0),
  })
  .refine((d) => (d.kind === 'percentual') === (d.percent !== undefined), { error: 'O percentual vai no desconto em %, e só nele.', path: ['percent'] })
  .refine((d) => (d.kind === 'valor') === (d.value_cents !== undefined), { error: 'O valor vai no desconto de valor fixo, e só nele.', path: ['value_cents'] });
export type CreativeTestDiscount = z.infer<typeof CreativeTestDiscount>;

const CreativeTestArmRequest = z.strictObject({
  /** Uma peça aprovada em Criativos; vai a versão atual dela. */
  piece_id: z.uuid(),
  /** Uma foto ou um vídeo pronto de Fotos, da marca. */
  media_id: z.uuid(),
  /** O cupom deste criativo: o Liame cria no Regem depois da aprovação, e o código vai no fim do texto do anúncio. */
  coupon_code: CreativeTestCouponCode,
});

export const CreateCreativeTestRequest = z
  .strictObject({
    brand_id: z.uuid(),
    /** A loja: o ponto dela precisa estar no endereço, e o cardápio online precisa ser o dela. */
    unit_id: z.uuid(),
    /** O nome do teste. A campanha na Meta sai como "Teste · <nome>". */
    name: z.string().trim().min(1).max(60),
    /** Os dois criativos, A e B, nesta ordem. Só o criativo muda entre eles. */
    arms: z.array(CreativeTestArmRequest).length(2),
    discount: CreativeTestDiscount,
    /** O raio em volta da loja, de 1 a 15 km, em passos de 0,5 km. Ou o raio, ou os bairros (`districts`). */
    radius_km: z
      .number()
      .min(1)
      .max(15)
      .refine((v) => Number.isInteger(v * 2), 'o raio vai em passos de 0,5 km')
      .optional(),
    /** Os bairros do município da loja, pelo código do IBGE, de 1 a 20, sem repetir (como na campanha nova). */
    districts: z
      .array(DistrictCode)
      .min(1)
      .max(NEW_CAMPAIGN_DISTRICTS_MAX)
      .refine((l) => new Set(l).size === l.length, 'o mesmo bairro duas vezes')
      .optional(),
    /** A verba diária do teste INTEIRO, em micros (R$ 40,00 = 40000000): metade para cada criativo, com a metade exata em centavos. */
    daily_budget_micros: z.int().min(CREATIVE_TEST_MIN_DAILY_BUDGET_MICROS).max(100_000_000_000),
  })
  .refine((b) => (b.radius_km === undefined) !== (b.districts === undefined), { error: 'Mande o raio em volta da loja ou os bairros: um dos dois.' })
  .refine((b) => b.arms.length !== 2 || b.arms[0]!.coupon_code !== b.arms[1]!.coupon_code, { error: 'Cada criativo tem o seu cupom: os dois códigos não podem ser iguais.', path: ['arms'] })
  .refine((b) => b.arms.length !== 2 || b.arms[0]!.piece_id !== b.arms[1]!.piece_id || b.arms[0]!.media_id !== b.arms[1]!.media_id, {
    error: 'Os dois criativos são iguais: escolha outra peça ou outra foto para o segundo.',
    path: ['arms'],
  });
export type CreateCreativeTestRequest = z.infer<typeof CreateCreativeTestRequest>;

const CreativeTestArm = z.strictObject({
  letter: z.enum(['A', 'B']),
  piece_id: z.uuid(),
  piece_version: z.int().min(1),
  media_id: z.uuid(),
  title: z.string(),
  /** O texto que sai no anúncio: o da peça com a linha do cupom no fim. */
  ad_text: z.string(),
  coupon_code: z.string(),
  coupon_status: CreativeTestCouponStatus,
  /** O que o Liame já criou na Meta para este criativo; nulos antes da criação. */
  meta: z.strictObject({ adset_id: z.string().nullable(), ad_id: z.string().nullable() }),
});

const CreativeTestArmNumbers = z.strictObject({
  letter: z.enum(['A', 'B']),
  /** Os pedidos confirmados no caixa, pelo cupom ou pelo link do criativo, do primeiro dia até a última olhada. */
  orders: z.int(),
  revenue_micros: z.int(),
  /** O gasto e os cliques no link do anúncio no mesmo período; nulos enquanto a leitura da Meta não trouxe o anúncio. */
  spend_micros: z.int().nullable(),
  link_clicks: z.int().nullable(),
});

/**
 * O que o teste mostrou até a última olhada. O Liame olha só ao fim de cada semana inteira (os dias 7, 14, 21 e 28) e
 * não espia no meio (D-RG-79 e D-RG-91): entre uma olhada e outra, os números ficam os da última.
 */
export const CreativeTestResult = z.strictObject({
  /** Cada olhada: o dia, os pedidos de cada criativo até ele e a chance de a diferença ser acaso (de 0 a 1). */
  looks: z.array(z.strictObject({ day: z.int(), orders_a: z.int(), orders_b: z.int(), chance: z.number() })),
  /** `ainda_nao` (a diferença cabe no acaso), `venceu` ou `sem_vencedor` (chegou ao último dia sem vencedor). */
  verdict: z.enum(['ainda_nao', 'venceu', 'sem_vencedor']),
  winner: z.enum(['A', 'B']).nullable(),
  arms: z.array(CreativeTestArmNumbers).length(2),
});
export type CreativeTestResult = z.infer<typeof CreativeTestResult>;

export const CreativeTestResponse = z.strictObject({
  id: z.uuid(),
  brand_id: z.uuid(),
  unit_id: z.uuid(),
  name: z.string(),
  status: CreativeTestStatus,
  /** A campanha de teste ativada pelo Liame: os dois anúncios no ar. */
  active: z.boolean(),
  arms: z.array(CreativeTestArm).length(2),
  discount: z.strictObject({
    kind: z.enum(['percentual', 'valor']),
    percent: z.int().nullable(),
    value_cents: z.int().nullable(),
    min_order_cents: z.int(),
    /** Até quando os dois cupons valem, no fuso da loja. */
    valid_until: z.iso.date(),
  }),
  radius_km: z.number().nullable(),
  districts: z.array(z.strictObject({ code: z.string(), name: z.string(), meta: z.boolean(), radius_km: z.number() })).nullable(),
  /** A verba diária do teste inteiro; cada criativo leva a metade. */
  daily_budget_micros: z.int(),
  min_days: z.int(),
  max_days: z.int(),
  /** O cardápio online da loja, para onde os dois anúncios levam. */
  link: z.string(),
  /** O pedido "criar a campanha de teste" em Aprovações; nulo se o pedido foi apagado. */
  action_id: z.uuid().nullable(),
  /** O pedido de ativar que espera decisão, quando há. */
  pending_action_id: z.uuid().nullable(),
  /** O primeiro dia inteiro com os dois criativos no ar, e o último dia do teste, no fuso da loja. */
  started_on: z.iso.date().nullable(),
  ended_on: z.iso.date().nullable(),
  /** Por que a campanha de teste não foi criada, quando não foi. */
  error: z.string().nullable(),
  /** Por que o teste foi interrompido (mexeram por fora, um cupom não foi criado), quando foi. */
  reason: z.string().nullable(),
  /** O que o teste mostrou até a última olhada; nulo antes da primeira (o dia 7). */
  result: CreativeTestResult.nullable(),
  meta: z.strictObject({ account_id: z.string().nullable(), campaign_id: z.string().nullable() }),
  created_at: z.iso.datetime(),
});
export type CreativeTestResponse = z.infer<typeof CreativeTestResponse>;

export const CreativeTestListQuery = z.strictObject({ brand_id: z.uuid() });
export type CreativeTestListQuery = z.infer<typeof CreativeTestListQuery>;

/** Os testes da marca, do mais novo para o mais antigo (até 50): o que foi testado e o que cada um mostrou (D-RG-83). */
export const CreativeTestListResponse = z.strictObject({ items: z.array(CreativeTestResponse) });
export type CreativeTestListResponse = z.infer<typeof CreativeTestListResponse>;
