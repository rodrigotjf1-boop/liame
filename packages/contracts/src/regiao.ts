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

// ------------------------------------------------------------------------------------------------------------------
// Sua região (plano da região, R2; P40): o retrato da região de uma loja, calculado pelo sistema com as fontes públicas
// (os bairros do Censo 2022 e as tabelas do IBGE por município), sem IA. Todo número leva a fonte e o período (§19.3);
// a renda do Censo é de 2022, sem correção (D-RG-20). Nada aqui é dado de pessoa.

export const RegionOverviewQuery = z.strictObject({ brand_id: z.uuid(), unit_id: z.uuid() });
export type RegionOverviewQuery = z.infer<typeof RegionOverviewQuery>;

/** Um número público com a fonte (o catálogo do código) e o período ("2022", "2026"). */
export const RegionNumber = z.strictObject({ value: z.number(), period: z.string(), source: Slug });
export type RegionNumber = z.infer<typeof RegionNumber>;

/** A leitura de uma fonte: `em_dia`, `lendo` (ainda não lida) ou `falhou` (com a próxima tentativa). */
export const RegionSourceStatus = z.strictObject({
  source: Slug,
  status: Slug,
  read_at: z.iso.datetime().nullable(),
  next_try_at: z.iso.datetime().nullable(),
});
export type RegionSourceStatus = z.infer<typeof RegionSourceStatus>;

/** Uma contagem de restaurantes (CNPJ da Receita): ativos por tipo de CNAE principal, abertos e baixados em 12 meses. */
export const RegionFoodCount = z.strictObject({
  active: z.number().int(),
  /** Restaurante (5611-2/01), lanchonete (5611-2/03), bar (5611-2/04 e /05) e comida para casa (5620-1/04). */
  restaurant: z.number().int(),
  snack: z.number().int(),
  bar: z.number().int(),
  home: z.number().int(),
  opened_12m: z.number().int(),
  closed_12m: z.number().int(),
});
export type RegionFoodCount = z.infer<typeof RegionFoodCount>;

export const RegionOverviewResponse = z.strictObject({
  brand_id: z.uuid(),
  unit_id: z.uuid(),
  /** `disponivel` ou `desligado_pela_liame`. */
  availability: z.strictObject({ status: Slug }),
  /** `sem_endereco` (a loja não está no mapa), `lendo` (as fontes ainda não foram lidas), `pronto` ou `parcial` (alguma fonte falhou). */
  status: Slug,
  /** O bairro do Censo da loja: `achado`, `nao_achado` (o nome do CEP não casou com o do Censo), `sem_bairro` ou `lendo`. */
  district_status: Slug,
  district: z
    .strictObject({
      code: z.string(),
      name: z.string(),
      population: z.number().int().nullable(),
      area_km2: z.number().nullable(),
      /** Pessoas por km², a conta do sistema com o Censo. */
      density: z.number().nullable(),
      /** A renda do responsável pelo domicílio, em reais de 2022 (mediana e média). */
      head_income_median: z.number().nullable(),
      head_income_mean: z.number().nullable(),
      /** A mesma renda corrigida pelo IPCA até o mês de `ipca.to` (nula sem o IPCA lido). */
      head_income_median_today: z.number().nullable(),
      head_income_mean_today: z.number().nullable(),
      /** Onde o bairro fica entre os bairros do município com renda: acima de quantos por cento, de quantos, e a mediana deles. */
      income_rank: z.strictObject({ above_pct: z.number().int(), districts: z.number().int(), typical_median: z.number() }).nullable(),
    })
    .nullable(),
  /** A correção pelo IPCA (número-índice, Brasil): de julho de 2022 (o mês do Censo) até o mês mais novo ("2026-09"). */
  ipca: z.strictObject({ from: z.string(), to: z.string(), factor: z.number() }).nullable(),
  /** As áreas de entrega que casaram com bairros do Censo do município, e a gente somada nelas. */
  delivery_area: z.strictObject({ matched: z.number().int(), total: z.number().int(), population: z.number().int().nullable() }),
  city: z
    .strictObject({
      code: z.string(),
      name: z.string(),
      state: z.string(),
      population: RegionNumber.nullable(),
      density: RegionNumber.nullable(),
      population_estimate: RegionNumber.nullable(),
      income_pc_median: RegionNumber.nullable(),
      income_pc_mean: RegionNumber.nullable(),
      restaurants: RegionNumber.nullable(),
      /** Restaurantes por 10 mil habitantes (a estimativa mais nova, ou o Censo). */
      restaurants_per_10k: z.number().nullable(),
      /** A região metropolitana da PNAD e do IPCA (código "UF01"), nula fora dela. */
      rm_code: z.string().nullable(),
      /** A renda domiciliar per capita recente (PNAD Contínua, anual): da UF e da RM. */
      income_pc_uf: RegionNumber.nullable(),
      income_pc_rm: RegionNumber.nullable(),
      /** A renda do trabalho na capital (PNAD Contínua, trimestral): a média dos trimestres mais novos (até 4). */
      work_income_capital: z.strictObject({ value: z.number(), period: z.string(), quarters: z.number().int(), source: Slug }).nullable(),
      /** O Pix do município (Banco Central): pessoas que pagaram e o valor pago por pessoa física no mês mais novo e no mesmo mês do ano anterior. */
      pix: z
        .strictObject({ period: z.string(), payers: z.number(), value: z.number(), payers_prev_year: z.number().nullable(), value_prev_year: z.number().nullable() })
        .nullable(),
      /** A inflação de comer fora em 12 meses (IPCA): no lugar (RM ou município que o IPCA cobre) e no Brasil. */
      food_away_inflation: z
        .strictObject({
          scope: Slug,
          period: z.string(),
          away: z.number().nullable(),
          meal: z.number().nullable(),
          snack: z.number().nullable(),
          brasil: z.strictObject({ away: z.number().nullable(), meal: z.number().nullable(), snack: z.number().nullable() }).nullable(),
        })
        .nullable(),
    })
    .nullable(),
  /**
   * Os restaurantes pelo CNPJ da Receita (R2, parte 4), no mês mais novo lido por inteiro (`period`, "2026-10"):
   * ativos por tipo de CNAE principal, os que abriram desde `since` ("2025-10") e os que deram baixa no mesmo período.
   * Nulo enquanto o primeiro mês não terminou de ser lido.
   */
  food_places: z
    .strictObject({
      period: z.string(),
      since: z.string(),
      city: RegionFoodCount.extend({
        /** Ativos por 10 mil habitantes (a estimativa mais nova da população, ou o Censo). */
        per_10k: z.number().nullable(),
        /** Quantos por cento dos ativos informaram um bairro que o Censo conhece (o resto não entra na conta do bairro). */
        district_coverage_pct: z.number().int().nullable(),
      }),
      /** O bairro da loja (o do Censo), com ativos por km²; nulo sem o bairro achado. */
      district: RegionFoodCount.extend({ per_km2: z.number().nullable() }).nullable(),
      /** A área do CEP da loja (os 5 primeiros dígitos); nula sem o CEP. */
      postal: RegionFoodCount.extend({ prefix: z.string() }).nullable(),
      /** As áreas de entrega que casaram com bairros do Censo, somadas; nula sem nenhuma. */
      delivery_area: RegionFoodCount.extend({ matched: z.number().int() }).nullable(),
    })
    .nullable(),
  /**
   * A semana que vem (R2, parte 5): a previsão do tempo por dia do município (CPTEC/INPE, pela BrasilAPI; nula se o
   * CPTEC não tem a cidade ou ainda não foi lida) e as datas dos próximos 45 dias (os feriados nacionais e as datas do
   * varejo do calendário do Liame, e o prazo do salário, conta do sistema). Nula sem a loja no mapa.
   */
  week_ahead: z
    .strictObject({
      weather: z
        .strictObject({
          read_at: z.iso.datetime(),
          days: z.array(
            z.strictObject({
              day: z.string(),
              /** O código da condição no CPTEC ("c", "pn", "ps"…) e o texto dela. */
              condition: z.string(),
              description: z.string(),
              min: z.number().int(),
              max: z.number().int(),
            }),
          ),
        })
        .nullable(),
      dates: z.array(z.strictObject({ day: z.string(), name: z.string(), kind: Slug, source: z.string() })),
    })
    .nullable(),
  /** A referência do setor (D-RG-9): números divulgados à imprensa, com a fonte; nunca o número da loja. */
  sector_references: z.array(z.strictObject({ text: z.string(), source: z.string(), extra: z.string().nullable(), as_of: z.string() })),
  /**
   * A demanda da loja (R3, parte 1): `disponivel`, `sem_endereco` (a loja fora do mapa), `sem_regem` (a marca não tem o Regem ligado: o Liame não lê os
   * pedidos) ou `sem_permissao` (quem pergunta não vê Resultados, `vendas.ver`: os números de venda não vêm).
   */
  store_demand_status: Slug,
  /**
   * Os pedidos confirmados da loja nas 4 semanas completas até ontem (no fuso da loja), pelas regras de Resultados:
   * a receita líquida (sem o estorno), o tíquete médio, o cliente novo × de volta (`unknown`: o pedido sem cliente, como
   * o de marketplace), os pedidos por dia da semana (0 = domingo) e por hora (a hora em que o cliente pediu), e o pico.
   * `status`: `pronto`, `poucos_pedidos` (abaixo de `minimum_orders`: sem dia, hora e pico) ou `sem_pedidos`. Nula fora
   * de `disponivel`.
   */
  store_demand: z
    .strictObject({
      status: Slug,
      from: z.string(),
      to: z.string(),
      days: z.number().int(),
      minimum_orders: z.number().int(),
      orders: z.number().int(),
      revenue_micros: z.string(),
      ticket_micros: z.string().nullable(),
      previous: z.strictObject({ orders: z.number().int(), revenue_micros: z.string(), ticket_micros: z.string().nullable() }),
      customers: z.strictObject({ new: z.number().int(), returning: z.number().int(), unknown: z.number().int() }),
      by_weekday: z.array(z.strictObject({ weekday: z.number().int(), orders: z.number().int(), revenue_micros: z.string() })),
      by_hour: z.array(z.strictObject({ hour: z.number().int(), orders: z.number().int() })),
      peak: z.strictObject({ weekday: z.number().int(), hour: z.number().int(), orders: z.number().int() }).nullable(),
    })
    .nullable(),
  /**
   * A mídia na região (R4; D-RG-32 a D-RG-35): `disponivel`, `sem_conta` (a marca sem conta de anúncio da Meta ou do
   * Google conectada) ou `sem_permissao` (quem pergunta não vê Resultados, `vendas.ver`).
   */
  paid_media_status: Slug,
  /**
   * Os anúncios da marca nas 4 semanas completas até ontem (no fuso de cada conta), sem dinheiro (D-RG-33): os cliques e
   * as impressões por hora (Meta e Google somados), o bloco de até 4 horas com mais cliques e quanto dos cliques cai no
   * bloco mais forte dos pedidos da loja (nulo sem a demanda pronta), e, só do Google, as cidades com mais cliques (até 8;
   * a Meta só informa o estado, que o Liame não lê). `accounts`: as contas que entram, com a última leitura (nula: ainda
   * lendo). `cities_status`: `disponivel`, `sem_google` ou `lendo`. Nula fora de `disponivel`.
   */
  paid_media: z
    .strictObject({
      from: z.string(),
      to: z.string(),
      accounts: z.array(z.strictObject({ provider: Slug, name: z.string(), read_at: z.string().nullable() })),
      clicks: z.number().int(),
      impressions: z.number().int(),
      by_hour: z.array(z.strictObject({ hour: z.number().int(), clicks: z.number().int(), impressions: z.number().int() })),
      ad_block: z.strictObject({ from_hour: z.number().int(), to_hour: z.number().int(), clicks_pct: z.number().int() }).nullable(),
      orders_block: z.strictObject({ from_hour: z.number().int(), to_hour: z.number().int(), clicks_pct: z.number().int() }).nullable(),
      cities_status: Slug,
      cities: z.array(z.strictObject({ id: z.string(), name: z.string(), full_name: z.string(), clicks: z.number().int(), impressions: z.number().int(), clicks_pct: z.number().int() })),
      /**
       * Os cliques por bairro (R4, os bairros; D-RG-44 e D-RG-45), só do Google: o local mais específico de quem viu
       * e clicou, no município da loja (`city`, com `city_clicks` cliques). `located`: os cliques com o bairro ou o
       * CEP; `few`: menos de 10, pouco para tirar conclusão. `items` (até 12): o bairro (o nome do Censo, quando casa)
       * ou o CEP (5 dígitos, sem traduzir), os cliques, se está na área de entrega (nulo: o CEP, ou a loja sem a área)
       * e o papel do bairro em `order_districts` (nunca para o de fora da área). Nula sem conta do Google.
       */
      districts: z
        .strictObject({
          city: z.string(),
          city_clicks: z.number().int(),
          located: z.number().int(),
          few: z.boolean(),
          items: z.array(z.strictObject({ name: z.string(), kind: Slug, clicks: z.number().int(), in_delivery_area: z.boolean().nullable(), role: Slug.nullable() })),
        })
        .nullable(),
      /**
       * Os cliques de fora da área de entrega (D-RG-46), só do Google: os de outros municípios (`other_cities`) e os
       * de bairros localizados fora da área (`outside_districts`, com até 3 nomes); o CEP e o clique só com a cidade
       * da loja nunca contam como fora. `has_area`: a loja tem a área de entrega (sem ela, só os outros municípios).
       * Nula sem clique do Google.
       */
      outside_area: z
        .strictObject({
          clicks: z.number().int(),
          pct: z.number().int(),
          other_cities: z.number().int(),
          outside_districts: z.number().int(),
          outside_names: z.array(z.string()),
          has_area: z.boolean(),
        })
        .nullable(),
    })
    .nullable(),
  /**
   * Os pedidos por bairro (R3, parte 2; D-RG-36 a D-RG-39): `disponivel`, `sem_endereco`, `sem_regem`, `sem_permissao`
   * (quem pergunta não vê Resultados) ou `lendo` (a primeira leitura do Regem ainda não veio).
   */
  order_districts_status: Slug,
  /**
   * Os pedidos de entrega confirmados por bairro, das 4 semanas completas até ontem, que o Regem manda somados (o bairro
   * com menos de `minimum` pedidos vem em `others`, sem o nome), com a gente do bairro no Censo (o mesmo município da
   * loja) e os pedidos por mil moradores; os bairros da área de entrega sem o mínimo entram com `orders` nulo. `role`
   * (`atacar`, `defender` ou `manter`) só com pelo menos 3 bairros com gente conhecida (`comparable`). Nula fora de
   * `disponivel`.
   */
  order_districts: z
    .strictObject({
      from: z.string(),
      to: z.string(),
      minimum: z.number().int(),
      read_at: z.string(),
      comparable: z.boolean(),
      districts: z.array(
        z.strictObject({
          name: z.string(),
          orders: z.number().int().nullable(),
          population: z.number().int().nullable(),
          per_1000: z.number().nullable(),
          role: Slug.nullable(),
          in_delivery_area: z.boolean(),
        }),
      ),
      others: z.strictObject({ districts: z.number().int(), orders: z.number().int() }),
      without_district: z.number().int(),
      pickup: z.number().int(),
      delivery_orders: z.number().int(),
    })
    .nullable(),
  /**
   * O público nas redes (R4, parte 3; D-RG-40 a D-RG-43): `disponivel`, `sem_endereco`, `sem_redes` (a marca sem o
   * Instagram nem a Página conectados) ou `lendo` (conectados, a primeira leitura ainda não veio). Não são números de
   * venda: quem vê Sua região vê (D-RG-42).
   */
  social_audience_status: Slug,
  /**
   * Os números da conta do Instagram e da Página da marca, das 4 semanas completas até ontem da última leitura (uma por
   * dia, a rotina `regiao-publico`): os seguidores agora, quem seguiu e quem deixou de seguir (no Instagram, só a partir
   * de 100 seguidores), a mudança na janela (quem seguiu menos quem saiu; sem isso, pela série que o Liame guarda), os
   * toques nos botões do perfil (Instagram) e as visitas (Página). Do Instagram, as cidades dos seguidores (as 5 maiores,
   * relidas uma vez por semana; `followers_pct` sobre os seguidores; `store_city`: o município da loja); `cities_status`:
   * `disponivel`, `poucos_seguidores` (menos de 100) ou `lendo`. A Página não informa mais a cidade (a Meta tirou em
   * 2025). Cada rede nula quando não está conectada. Nula fora de `disponivel`.
   */
  social_audience: z
    .strictObject({
      from: z.string(),
      to: z.string(),
      instagram: z
        .strictObject({
          name: z.string(),
          read_at: z.string(),
          followers: z.number().int().nullable(),
          follows: z.number().int().nullable(),
          unfollows: z.number().int().nullable(),
          followers_change: z.number().int().nullable(),
          taps: z.strictObject({ total: z.number().int(), directions: z.number().int(), call: z.number().int(), message: z.number().int(), other: z.number().int() }).nullable(),
          cities_status: Slug,
          cities: z.array(z.strictObject({ name: z.string(), full_name: z.string(), followers: z.number().int(), followers_pct: z.number().int().nullable(), store_city: z.boolean() })),
        })
        .nullable(),
      page: z
        .strictObject({
          name: z.string(),
          read_at: z.string(),
          followers: z.number().int().nullable(),
          follows: z.number().int().nullable(),
          unfollows: z.number().int().nullable(),
          followers_change: z.number().int().nullable(),
          views: z.number().int().nullable(),
        })
        .nullable(),
    })
    .nullable(),
  sources: z.array(RegionSourceStatus),
  generated_at: z.iso.datetime(),
});
export type RegionOverviewResponse = z.infer<typeof RegionOverviewResponse>;

// ---------------------------------------------------------------- o ritmo da semana (R7, parte 1; D-RG-58 a D-RG-60)

export const RegionRhythmQuery = z.strictObject({ brand_id: z.uuid(), unit_id: z.uuid() });
export type RegionRhythmQuery = z.infer<typeof RegionRhythmQuery>;

/** O porquê do peso de um dia. Os campos que não são do tipo vêm nulos. */
export const RegionRhythmReason = z.strictObject({
  /** `pedidos` (a parte dos pedidos da loja neste dia da semana), `setor` (a referência do setor), `chuva` ou `data`. */
  kind: Slug,
  /** Em `pedidos`: a parte dos pedidos da semana que cai neste dia (a média de um dia é 14). */
  share_pct: z.int().nullable(),
  /** Em `chuva`, a previsão como o CPTEC escreve; em `data`, o nome da data. */
  text: z.string().nullable(),
  /** Em `chuva`: a mínima e a máxima previstas. */
  min: z.int().nullable(),
  max: z.int().nullable(),
  /** Em `data`: é a véspera (a data é do dia seguinte). */
  eve: z.boolean().nullable(),
});
export type RegionRhythmReason = z.infer<typeof RegionRhythmReason>;

/**
 * O ritmo da semana que vem, como o Gestor de tráfego o montaria (R7; a prévia: nada é pedido nem executado). A verba de
 * cada dia segue os pedidos da loja por dia da semana (ou a referência do setor), a chuva prevista e as datas, com os
 * limites: cada dia entre 20% abaixo e 20% acima da verba de hoje, até 10% de mudança de um dia para o outro, nenhum dia
 * acima do teto por campanha, e a semana sem gastar mais do que gastaria sem o ritmo. `status`: `pronto`, `desligado`
 * (a função da região), `sem_endereco` (a loja fora do mapa), `sem_permissao` (quem pergunta não vê Resultados) ou
 * `sem_campanhas` (nenhuma campanha ativa da Meta com verba diária própria que caiba nas regras).
 */
export const RegionRhythmResponse = z.strictObject({
  status: Slug,
  /** A semana que vem, de segunda a domingo; nula fora de `pronto` e `sem_campanhas`. */
  week: z.strictObject({ from: z.string(), to: z.string() }).nullable(),
  /** De onde vem o peso: `loja` (os pedidos dela) ou `setor` (a referência, sem pedidos que bastem). */
  source: Slug.nullable(),
  days: z.array(
    z.strictObject({
      day: z.string(),
      /** 0 = domingo. */
      weekday: z.int(),
      /** A parte da verba de hoje que o dia leva (1 = igual a hoje). */
      weight: z.number(),
      /** A verba do dia, somadas as campanhas do ritmo, em micros. */
      total_micros: z.int(),
      reasons: z.array(RegionRhythmReason),
    }),
  ),
  /** As campanhas que entram: as ativas da Meta com verba diária própria (na campanha ou no conjunto). */
  campaigns: z.array(
    z.strictObject({
      id: z.uuid(),
      /** `campanha` ou `conjunto`: onde a verba diária mora. */
      level: Slug,
      name: z.string(),
      base_micros: z.int(),
      /** A verba de cada dia, na ordem de `days`. */
      days_micros: z.array(z.int()),
      week_micros: z.int(),
    }),
  ),
  /** As que ficam fora, com o porquê: `verba_pequena`, `fracao_de_centavo`, `acima_do_teto` ou `fora_dos_limites`. */
  out: z.array(z.strictObject({ name: z.string(), reason: Slug })),
  /** A verba de hoje por dia, somadas as campanhas do ritmo; a da semana sem o ritmo (7 dias) e a da semana com ele. */
  base_micros: z.int(),
  base_week_micros: z.int(),
  week_micros: z.int(),
  /** O horário dos pedidos (o mesmo do plano de mídia, D-RG-29): o bloco e quando os anúncios começam; nulo sem ele. */
  hours: z.strictObject({ source: Slug, from: z.string(), to: z.string(), ads_from: z.string() }).nullable(),
  generated_at: z.iso.datetime(),
});
export type RegionRhythmResponse = z.infer<typeof RegionRhythmResponse>;
