import { z } from 'zod';

// A loja no mapa (plano da região, R1; `docs/plano-regiao.md`, aprovado em 11/11/2026; base de conhecimento §19): onde
// cada loja fica (o endereço, o código IBGE do município, a coordenada com a precisão dela), o raio e as áreas de
// entrega. É dado da EMPRESA (D-RG-2): fica na loja e nunca vai para o modelo de IA (D-A3-4). O endereço vem do Perfil
// da Empresa no Google ou do CEP digitado; o CEP é completado pelo ViaCEP e a coordenada vem do OpenStreetMap.
// Conferir o endereço e ler o do Perfil não gravam nada: só salvar grava, com a auditoria.

const Slug = z.string().regex(/^[a-z0-9_]+$/).max(60);
const Cep = z.string().regex(/^[0-9]{8}$/);
const Uf = z.string().regex(/^[A-Z]{2}$/);
const CodigoDoMunicipio = z.string().regex(/^[0-9]{7}$/);
const Latitude = z.number().min(-34).max(6);
const Longitude = z.number().min(-75).max(-28);

/** De onde veio a coordenada: o endereço inteiro, só o bairro ou só a cidade. */
export const LOCATION_PRECISIONS = ['endereco', 'bairro', 'cidade'] as const;
/** De onde veio o endereço: o Perfil da Empresa no Google ou o CEP digitado. */
export const LOCATION_SOURCES = ['perfil_google', 'cep'] as const;
/** O raio de entrega, em km, de meio em meio. */
export const DELIVERY_RADIUS_KM = { min: 1, max: 15, step: 0.5 } as const;
/** As áreas de entrega: até 20, como o Perfil do Google dá. */
export const DELIVERY_AREAS_MAX = 20;
/** A atribuição que acompanha toda coordenada (licença ODbL do OpenStreetMap). */
export const OSM_ATTRIBUTION = '© OpenStreetMap';

export const StoreAddress = z.strictObject({
  postal_code: Cep,
  /** Nula quando o CEP é geral do município e a pessoa ainda não informou a rua. */
  street: z.string().nullable(),
  number: z.string().nullable(),
  /** O complemento ("Loja 2", "fundos"), opcional. */
  complement: z.string().nullable(),
  district: z.string().nullable(),
  city: z.string(),
  state: Uf,
  /** O código IBGE do município (7 dígitos): a chave das fontes públicas da região. */
  ibge_city_code: CodigoDoMunicipio,
});
export type StoreAddress = z.infer<typeof StoreAddress>;

export const StoreCoordinates = z.strictObject({
  latitude: Latitude,
  longitude: Longitude,
  /** `endereco`, `bairro` ou `cidade`. */
  precision: Slug,
});
export type StoreCoordinates = z.infer<typeof StoreCoordinates>;

export const StoreLocation = z.strictObject({
  unit_id: z.uuid(),
  unit_name: z.string(),
  /** Nulo enquanto a loja não tem endereço. */
  address: StoreAddress.nullable(),
  /** Nula quando o OpenStreetMap não achou o lugar (o endereço vale do mesmo jeito). */
  coordinates: StoreCoordinates.nullable(),
  /** `perfil_google` ou `cep`; nulo sem endereço. */
  source: Slug.nullable(),
  delivery_radius_km: z.number().min(DELIVERY_RADIUS_KM.min).max(DELIVERY_RADIUS_KM.max).nullable(),
  delivery_areas: z.array(z.string()),
  /** Quem salvou por último e quando (nulo quando a pessoa saiu da empresa, ou ninguém salvou). */
  set_by: z.strictObject({ id: z.uuid(), name: z.string() }).nullable(),
  set_at: z.iso.datetime().nullable(),
  /** A loja nasceu no Liame (marca sem Regem, D-RG-17), e não pela conexão com o Regem. */
  created_here: z.boolean(),
  /** O Perfil da Empresa no Google desta loja (cada perfil vale para uma loja, D-RG-16); nulo sem perfil. */
  google_profile_account_id: z.uuid().nullable(),
});
export type StoreLocation = z.infer<typeof StoreLocation>;

export const StoreLocationsQuery = z.strictObject({ brand_id: z.uuid() });
export type StoreLocationsQuery = z.infer<typeof StoreLocationsQuery>;

export const StoreLocationsResponse = z.strictObject({
  brand_id: z.uuid(),
  /** `disponivel` ou `desligado_pela_liame` (a função `regiao` desta empresa). */
  availability: z.strictObject({ status: Slug }),
  stores: z.array(StoreLocation),
  /**
   * Os Perfis da Empresa no Google ligados à marca, para "Usar o endereço do Perfil do Google", com a loja de cada um
   * (nula quando o perfil ainda não é de loja nenhuma).
   */
  google_profiles: z.array(z.strictObject({ account_id: z.uuid(), name: z.string(), unit_id: z.uuid().nullable() })),
  /** A pessoa pode salvar (o Dono e o Administrador, como o dossiê). */
  can_edit: z.boolean(),
  /** A marca tem o Regem conectado: as lojas vêm dele. */
  has_regem: z.boolean(),
  /** A pessoa pode criar loja aqui (pode salvar e a marca não tem o Regem; D-RG-17). */
  can_create_store: z.boolean(),
  attribution: z.string(),
  generated_at: z.iso.datetime(),
});
export type StoreLocationsResponse = z.infer<typeof StoreLocationsResponse>;

/** Conferir um endereço pelo CEP (e o número e a rua, quando a pessoa já informou): não grava nada. */
export const AddressLookupRequest = z.strictObject({
  brand_id: z.uuid(),
  /** Com ou sem o hífen ("21615-000" ou "21615000"). */
  postal_code: z.string().trim().min(8).max(9),
  number: z.string().trim().max(20).optional(),
  /** Só quando o CEP é geral do município (o ViaCEP não dá a rua). */
  street: z.string().trim().max(200).optional(),
});
export type AddressLookupRequest = z.infer<typeof AddressLookupRequest>;

export const AddressLookupResponse = z.strictObject({
  address: StoreAddress,
  coordinates: StoreCoordinates.nullable(),
  /** `achada` ou `nao_achada` (o OpenStreetMap não achou nem a cidade, ou não respondeu: o endereço vale do mesmo jeito). */
  coordinates_status: Slug,
  /** O CEP é geral do município: falta a rua. */
  needs_street: z.boolean(),
  attribution: z.string(),
});
export type AddressLookupResponse = z.infer<typeof AddressLookupResponse>;

/** O endereço e as áreas de entrega de um Perfil da Empresa no Google ligado à marca, lidos agora: não grava nada. */
export const GoogleProfileAddressRequest = z.strictObject({
  brand_id: z.uuid(),
  /** A conta do Perfil (`google_profiles[].account_id` da lista). */
  account_id: z.uuid(),
});
export type GoogleProfileAddressRequest = z.infer<typeof GoogleProfileAddressRequest>;

export const GoogleProfileAddressResponse = z.strictObject({
  profile_name: z.string(),
  /** Nulo quando o perfil não mostra endereço (só atende na casa do cliente) ou o CEP dele não foi achado. */
  address: StoreAddress.nullable(),
  coordinates: StoreCoordinates.nullable(),
  coordinates_status: Slug,
  /** As áreas de entrega do perfil (até 20), como o Google dá. */
  delivery_areas: z.array(z.string()),
  needs_street: z.boolean(),
  attribution: z.string(),
});
export type GoogleProfileAddressResponse = z.infer<typeof GoogleProfileAddressResponse>;

export const SaveStoreLocationRequest = z.strictObject({
  address: z.strictObject({
    postal_code: Cep,
    street: z.string().trim().min(1).max(200).nullable(),
    number: z.string().trim().min(1).max(20).nullable(),
    /** Opcional ("Loja 2", "fundos"). */
    complement: z.string().trim().min(1).max(60).nullable().optional(),
    district: z.string().trim().min(1).max(120).nullable(),
    city: z.string().trim().min(1).max(120),
    state: Uf,
    ibge_city_code: CodigoDoMunicipio,
  }),
  /** A coordenada que a conferência devolveu (nula quando ela não achou). */
  coordinates: z.strictObject({ latitude: Latitude, longitude: Longitude, precision: z.enum(LOCATION_PRECISIONS) }).nullable(),
  source: z.enum(LOCATION_SOURCES),
  /**
   * Com `source` `perfil_google`: o Perfil do Google escolhido (`google_profiles[].account_id`). Ele passa a ser desta
   * loja; o perfil que já é de outra loja volta 409.
   */
  google_profile_account_id: z.uuid().nullable().optional(),
  delivery_radius_km: z.number().min(DELIVERY_RADIUS_KM.min).max(DELIVERY_RADIUS_KM.max).multipleOf(DELIVERY_RADIUS_KM.step),
  delivery_areas: z.array(z.string().trim().min(1).max(80)).max(DELIVERY_AREAS_MAX),
});
export type SaveStoreLocationRequest = z.infer<typeof SaveStoreLocationRequest>;

export const SaveStoreLocationResponse = z.strictObject({ store: StoreLocation });
export type SaveStoreLocationResponse = z.infer<typeof SaveStoreLocationResponse>;

/** As lojas que uma marca pode criar aqui (a marca sem o Regem, D-RG-17). */
export const STORES_PER_BRAND_MAX = 50;

/** Criar a loja ao pôr no mapa (a marca sem o Regem, D-RG-17): o nome e o mesmo corpo de salvar. */
export const CreateStoreRequest = SaveStoreLocationRequest.extend({
  brand_id: z.uuid(),
  /** O nome do Perfil do Google ou, sem perfil, "Loja" e o bairro. O Regem conectado depois se liga à loja de mesmo nome. */
  name: z.string().trim().min(1).max(80),
});
export type CreateStoreRequest = z.infer<typeof CreateStoreRequest>;
