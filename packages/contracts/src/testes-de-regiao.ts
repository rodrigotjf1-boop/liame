import { z } from 'zod';
import { DistrictCode } from './campanhas-novas.js';
import { CreativeTestStatus } from './testes-de-criativo.js';

// O teste de região (plano da região, R8; protótipo dos testes aprovado pelo dono em 13/11/2026; D-RG-81 e D-RG-82). Um
// bairro da área de entrega fica 14 dias sem anúncio nas campanhas que o Liame criou, e o caixa diz quanto o anúncio
// traz ali. O pedido vai para Aprovações com o código do app; aprovar não muda nada na Meta.

/** Os dias do teste de região e as semanas de antes que entram na conta (D-RG-81). */
export const REGION_TEST_DAYS = 14;
export const REGION_TEST_WEEKS_BEFORE = 4;
/** O bairro do teste precisa de pelo menos estes pedidos por semana, e de pelo menos estes outros bairros para comparar (D-RG-82). */
export const REGION_TEST_MIN_WEEKLY_ORDERS = 15;
export const REGION_TEST_MIN_OTHER_DISTRICTS = 3;

export const CreateRegionTestRequest = z.strictObject({
  brand_id: z.uuid(),
  /** A loja: os pedidos por bairro são os dela, e o bairro é do município dela. */
  unit_id: z.uuid(),
  /** O bairro, pelo código do IBGE. */
  district_code: DistrictCode,
});
export type CreateRegionTestRequest = z.infer<typeof CreateRegionTestRequest>;

export const RegionTestAdSetStatus = z.enum(['a_tirar', 'tirado', 'devolvido', 'mexido', 'falhou']);

/**
 * O que o teste de região mostrou (D-RG-81 e D-RG-102): medido uma vez, depois do fim, pelos pedidos de entrega do caixa
 * (o Regem da loja), o bairro e os de comparar, nas 4 semanas de antes e nos dias do teste. São somas: nunca um pedido
 * nem um cliente. Ou vem a conta (`effect`), ou o motivo de não haver conta (`reason`).
 */
export const RegionTestResult = z.strictObject({
  /** Os dias do teste que entram na conta, no fuso da loja: os 14 dias; no teste que parou antes, até o último dia sem anúncio. */
  window: z.strictObject({ from: z.iso.date(), to: z.iso.date() }),
  /**
   * Os pedidos de entrega do bairro do teste e dos bairros de comparar, nas 4 semanas de antes e nos dias do teste. Os
   * do teste são nulos sem a leitura deles; o do bairro também quando ele ficou abaixo do mínimo que o Regem mostra.
   */
  orders: z.strictObject({ target_before: z.int(), others_before: z.int(), target_during: z.int().nullable(), others_during: z.int().nullable() }),
  /** Os bairros que ficaram na comparação: o bairro de comparar que, nos dias do teste, ficou abaixo do mínimo do Regem sai dos dois lados. */
  districts: z.array(z.string()),
  /**
   * A conta, por semana: o que o bairro teria feito seguindo os outros bairros (`expected_per_week`), o que ele fez sem
   * anúncio (`actual_per_week`), o que o anúncio traz ali (`brings_per_week`) e a faixa de 95% (`range`, nunca abaixo de
   * zero). `proven`: a faixa fica acima de zero. Nula quando não houve conta (o motivo em `reason`).
   */
  effect: z
    .strictObject({
      expected_per_week: z.number(),
      actual_per_week: z.number(),
      brings_per_week: z.number(),
      range: z.strictObject({ from: z.number(), to: z.number() }),
      proven: z.boolean(),
    })
    .nullable(),
  /**
   * Por que não houve conta, em código: `incompleto` (o teste parou antes dos 14 dias), `poucos_bairros` (menos de 3
   * bairros de comparar nos dois lados), `abaixo_do_minimo` (o bairro do teste ficou abaixo do mínimo que o Regem mostra),
   * `sem_conta` (faltou pedido em uma das quatro contagens) ou `sem_leitura` (o Regem não devolveu os pedidos até 7 dias
   * depois do fim). Nulo com `effect`. A lista pode crescer.
   */
  reason: z
    .string()
    .regex(/^[a-z_]{2,40}$/)
    .nullable(),
  /** Só com `reason` = `abaixo_do_minimo`: os pedidos por semana que o bairro faria seguindo os outros bairros. Nulo nos outros casos. */
  expected_per_week: z.number().nullable(),
  /** O mínimo de pedidos que o Regem usou para mostrar um bairro pelo nome nos dias do teste; nulo sem a leitura. */
  regem_minimum: z.int().nullable(),
  measured_at: z.iso.datetime(),
});
export type RegionTestResult = z.infer<typeof RegionTestResult>;

export const RegionTestResponse = z.strictObject({
  id: z.uuid(),
  brand_id: z.uuid(),
  unit_id: z.uuid(),
  name: z.string(),
  status: CreativeTestStatus,
  /** O bairro: o nome, se a Meta tem a chave dele (sem ela, vale o círculo no centro) e o raio do círculo. */
  district: z.strictObject({ code: z.string(), name: z.string(), meta: z.boolean(), radius_km: z.number() }),
  days: z.int(),
  /** Os pedidos de entrega por bairro nas 4 semanas de antes, como a pessoa viu: o bairro do teste e os de comparar. */
  weeks: z.strictObject({
    from: z.iso.date(),
    to: z.iso.date(),
    districts: z.array(z.strictObject({ name: z.string(), orders: z.int(), target: z.boolean() })),
  }),
  /** Os conjuntos das campanhas do Liame que mostram anúncio no bairro: é deles que o bairro sai no teste. */
  ad_sets: z.array(z.strictObject({ campaign_id: z.string(), ad_set_id: z.string(), name: z.string(), status: RegionTestAdSetStatus })),
  /** O pedido em Aprovações; nulo se o pedido foi apagado. */
  action_id: z.uuid().nullable(),
  /** O primeiro e o último dia sem anúncio no bairro, no fuso da loja; nulos antes de começar. */
  started_on: z.iso.date().nullable(),
  ended_on: z.iso.date().nullable(),
  error: z.string().nullable(),
  /** Por que o teste foi interrompido, quando foi. */
  reason: z.string().nullable(),
  /** O que o teste mostrou: nulo até a medida, que sai depois do fim, quando a leitura dos pedidos do Regem cobre os 14 dias. */
  result: RegionTestResult.nullable().optional(),
  created_at: z.iso.datetime(),
});
export type RegionTestResponse = z.infer<typeof RegionTestResponse>;

export const RegionTestListQuery = z.strictObject({ brand_id: z.uuid() });
export type RegionTestListQuery = z.infer<typeof RegionTestListQuery>;

/** Os testes de região da marca, do mais novo para o mais antigo (até 50): o que cada um mostrou fica guardado (D-RG-83, D-RG-97). */
export const RegionTestListResponse = z.strictObject({ items: z.array(RegionTestResponse) });
export type RegionTestListResponse = z.infer<typeof RegionTestListResponse>;

export const RegionTestOptionsQuery = z.strictObject({ brand_id: z.uuid() });
export type RegionTestOptionsQuery = z.infer<typeof RegionTestOptionsQuery>;

/** O que a tela precisa para oferecer o teste (R8): a função `teste_de_regiao` ligada e o teste vivo da marca (um por vez). */
export const RegionTestOptionsResponse = z.strictObject({
  enabled: z.boolean(),
  live: z.strictObject({ id: z.uuid(), kind: z.enum(['criativo', 'regiao']), name: z.string(), status: z.string() }).nullable(),
});
export type RegionTestOptionsResponse = z.infer<typeof RegionTestOptionsResponse>;
