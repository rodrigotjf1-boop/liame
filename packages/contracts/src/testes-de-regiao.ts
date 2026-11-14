import { z } from 'zod';
import { DistrictCode } from './campanhas-novas.js';
import { CreativeTestStatus } from './testes-de-criativo.js';

// O teste de região (plano da região, R8; protótipo dos testes aprovado pelo dono em 13/11/2026; D-RG-81 e D-RG-82). Um
// bairro da área de entrega fica 14 dias sem anúncio nas campanhas que o Liame criou, e o caixa diz quanto o anúncio
// traz ali. O pedido vai para Aprovações com o código do app; aprovar não muda nada na Meta.

/** Os dias do teste de região e as semanas de antes que entram na conta (D-RG-81). */
export const REGION_TEST_DAYS = 14;
export const REGION_TEST_WEEKS_BEFORE = 4;

export const CreateRegionTestRequest = z.strictObject({
  brand_id: z.uuid(),
  /** A loja: os pedidos por bairro são os dela, e o bairro é do município dela. */
  unit_id: z.uuid(),
  /** O bairro, pelo código do IBGE. */
  district_code: DistrictCode,
});
export type CreateRegionTestRequest = z.infer<typeof CreateRegionTestRequest>;

export const RegionTestAdSetStatus = z.enum(['a_tirar', 'tirado', 'devolvido', 'mexido', 'falhou']);

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
  created_at: z.iso.datetime(),
});
export type RegionTestResponse = z.infer<typeof RegionTestResponse>;
