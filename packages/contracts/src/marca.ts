import { z } from 'zod';

// Minha marca (A3, I8; protótipo P6, aguardando aprovação): o dossiê da marca, que os funcionários de IA leem
// antes de escrever qualquer coisa. Ele é estruturado em nove partes (ordem da tela e do texto para o modelo),
// tem versões (cada vez que alguém salva, nasce uma; voltar a uma anterior é salvar outra) e não guarda dado
// pessoal de cliente (telefone, e-mail e documento são recusados ao salvar). As provas que o sistema calcula
// (como "mais de 500 pedidos por semana") não são guardadas: saem dos números na hora.
//
// O dossiê guardado é lido por este mesmo contrato: campo novo aqui nasce OPCIONAL ou com valor padrão, para a
// versão antiga continuar abrindo.

/** As nove partes, na ordem da tela e do texto para o modelo. */
export const DOSSIER_SECTIONS = ['identidade', 'voz', 'produtos', 'ofertas', 'provas', 'proibido', 'concorrentes', 'regiao', 'datas'] as const;
export const DossierSection = z.enum(DOSSIER_SECTIONS);
export type DossierSection = z.infer<typeof DossierSection>;

/** Versão do contrato do conteúdo: muda quando o formato guardado muda. */
export const DOSSIER_CONTENT_VERSION = 1;

const Texto = (max: number) => z.string().trim().max(max);
const Item = z.string().trim().min(1).max(160);
const ItemComMotivo = z.strictObject({ text: Item, why: Texto(200).default('') });

/** O dossiê inteiro. Parte vazia é parte não preenchida (a tela mostra "Ainda não preenchida"). */
export const BrandDossierContent = z.strictObject({
  identity: z
    .strictObject({
      /** O que a marca é, em uma frase. */
      summary: Texto(240).default(''),
      /** Para quem vende. */
      audience: Texto(240).default(''),
      /** O que a diferencia. */
      differentiator: Texto(240).default(''),
      /** Desde quando existe (ano), ou vazio. */
      since: z.union([z.string().regex(/^(19|20)\d{2}$/), z.literal('')]).default(''),
    })
    .default({ summary: '', audience: '', differentiator: '', since: '' }),
  voice: z
    .strictObject({
      /** Até quatro jeitos de falar ("Descontraída", "Direta"). */
      traits: z.array(z.string().trim().min(1).max(40)).max(4).default([]),
      /** Regras de escrita ("Frases curtas."). */
      rules: z.array(Item).max(10).default([]),
      /** Um exemplo de como sim e um de como não. */
      do_example: Texto(240).default(''),
      dont_example: Texto(240).default(''),
    })
    .default({ traits: [], rules: [], do_example: '', dont_example: '' }),
  products: z.strictObject({ items: z.array(Item).max(20).default([]) }).default({ items: [] }),
  offers: z.strictObject({ items: z.array(Item).max(20).default([]) }).default({ items: [] }),
  /** Provas informadas por uma pessoa (nota em plataforma, prêmio), cada uma com quem informou e quando. */
  proof: z.strictObject({ stated: z.array(ItemComMotivo).max(10).default([]) }).default({ stated: [] }),
  /** O que a marca nunca diz; somam-se às regras da Liame, que valem para todas as marcas e não saem. */
  forbidden: z.strictObject({ items: z.array(ItemComMotivo).max(30).default([]) }).default({ items: [] }),
  competitors: z.strictObject({ items: z.array(ItemComMotivo).max(10).default([]) }).default({ items: [] }),
  region: z
    .strictObject({
      /** Onde entrega (bairros ou distância; sem endereço de cliente). */
      area: Texto(240).default(''),
      /** Tem retirada no balcão. */
      pickup: z.boolean().default(false),
    })
    .default({ area: '', pickup: false }),
  seasonality: z.strictObject({ items: z.array(Item).max(12).default([]) }).default({ items: [] }),
});
export type BrandDossierContent = z.infer<typeof BrandDossierContent>;

export const DossierVersionSource = z.enum(['pessoa', 'sugestao', 'restaurada', 'mesclada']);
export type DossierVersionSource = z.infer<typeof DossierVersionSource>;

/** Quem salvou, quando, como e o que mudou. */
export const BrandDossierVersionMeta = z.strictObject({
  version: z.number().int().min(1),
  source: DossierVersionSource,
  /** A versão para a qual voltou, quando `source` é `restaurada`. */
  restored_from: z.number().int().min(1).nullable(),
  /** Nulo quando a pessoa saiu da empresa. */
  created_by: z.strictObject({ id: z.uuid(), name: z.string() }).nullable(),
  created_at: z.iso.datetime(),
  /** O que mudou sobre a versão anterior, em frases curtas ("O que não pode dizer: + gourmet"). */
  changes: z.array(z.string()),
});
export type BrandDossierVersionMeta = z.infer<typeof BrandDossierVersionMeta>;

export const BrandDossierQuery = z.strictObject({ brand_id: z.uuid() });
export type BrandDossierQuery = z.infer<typeof BrandDossierQuery>;

/** O número de uma versão, no caminho da rota. */
export const DossierVersionNumber = z.coerce.number().int().min(1).max(1_000_000);

/** Uma prova calculada pelo sistema (nunca digitada), com a fonte. */
export const SystemProof = z.strictObject({ text: z.string(), source: z.string() });
export type SystemProof = z.infer<typeof SystemProof>;

export const DossierSectionStatus = z.strictObject({
  section: DossierSection,
  /** `confirmada`: tem conteúdo salvo por uma pessoa; `vazia`: nada ainda; `sugestao`: há sugestão esperando conferência. */
  status: z.enum(['confirmada', 'vazia', 'sugestao']),
});
export type DossierSectionStatus = z.infer<typeof DossierSectionStatus>;

export const BrandDossierResponse = z.strictObject({
  brand_id: z.uuid(),
  brand_name: z.string(),
  /** Nulo quando ninguém salvou ainda (o conteúdo vem vazio). */
  version: BrandDossierVersionMeta.nullable(),
  content: BrandDossierContent,
  system_proof: z.array(SystemProof),
  sections: z.array(DossierSectionStatus),
  /** O texto que os funcionários de IA leem, em ordem fixa, e o hash dele (muda só quando o texto muda). */
  model_text: z.string(),
  model_text_hash: z.string().regex(/^[0-9a-f]{64}$/),
  /** A pessoa pode salvar, voltar a uma versão e usar sugestão (o dono e o administrador). */
  can_edit: z.boolean(),
  generated_at: z.iso.datetime(),
});
export type BrandDossierResponse = z.infer<typeof BrandDossierResponse>;

export const SaveBrandDossierRequest = z.strictObject({
  brand_id: z.uuid(),
  /** A versão que a pessoa abriu (0 quando o dossiê estava vazio). Se outra pessoa salvou depois, volta 409. */
  base_version: z.number().int().min(0),
  content: BrandDossierContent,
  /** A pessoa juntou as duas versões depois de um 409 (a versão nasce como `mesclada`). */
  merged: z.boolean().optional(),
});
export type SaveBrandDossierRequest = z.infer<typeof SaveBrandDossierRequest>;

export const BrandDossierVersionListResponse = z.strictObject({
  items: z.array(BrandDossierVersionMeta),
});
export type BrandDossierVersionListResponse = z.infer<typeof BrandDossierVersionListResponse>;

export const BrandDossierVersionResponse = z.strictObject({
  meta: BrandDossierVersionMeta,
  content: BrandDossierContent,
});
export type BrandDossierVersionResponse = z.infer<typeof BrandDossierVersionResponse>;

export const RestoreBrandDossierRequest = z.strictObject({
  brand_id: z.uuid(),
  /** A versão para a qual voltar. */
  version: z.number().int().min(1),
  /** A versão atual que a pessoa estava vendo. */
  base_version: z.number().int().min(1),
});
export type RestoreBrandDossierRequest = z.infer<typeof RestoreBrandDossierRequest>;

/** Testar uma frase nas regras da Liame e nas da marca, sem IA. */
export const CheckBrandPhraseRequest = z.strictObject({
  brand_id: z.uuid(),
  text: z.string().trim().min(1).max(2000),
  /** A lista que a pessoa está editando e ainda não salvou; sem ela, vale a da versão atual. */
  forbidden: z.array(Item).max(30).optional(),
});
export type CheckBrandPhraseRequest = z.infer<typeof CheckBrandPhraseRequest>;

export const BrandPhraseHit = z.strictObject({
  /** De quem é a regra: da Liame (valem para todas as marcas) ou da marca. */
  owner: z.enum(['liame', 'marca']),
  /** `politico_eleitoral`, `promessa_de_resultado`, `categoria_proibida`, `dado_pessoal` ou `regra_da_marca`. */
  rule: z.string().regex(/^[a-z_]+$/),
  /** O que bateu: a frase da marca ou o nome da regra da Liame (nunca o dado pessoal em si). */
  text: z.string(),
  why: z.string().nullable(),
});
export type BrandPhraseHit = z.infer<typeof BrandPhraseHit>;
export const CheckBrandPhraseResponse = z.strictObject({
  ok: z.boolean(),
  hits: z.array(BrandPhraseHit),
});
export type CheckBrandPhraseResponse = z.infer<typeof CheckBrandPhraseResponse>;

/** Um item de uma sugestão: incluir, tirar ou trocar, com o porquê (números do sistema, com a fonte). */
export const BrandDossierSuggestionItem = z.strictObject({
  op: z.enum(['incluir', 'tirar', 'trocar']),
  text: z.string().min(1).max(160),
  /** O texto atual, quando é troca. */
  before: z.string().max(160).nullable(),
  why: z.string().max(240),
});
export type BrandDossierSuggestionItem = z.infer<typeof BrandDossierSuggestionItem>;

export const BrandDossierSuggestion = z.strictObject({
  id: z.uuid(),
  section: DossierSection,
  /** Quem sugeriu: o sistema (pelas vendas e cupons, sem IA), a LIA ou o Pesquisador. */
  source: z.enum(['sistema', 'lia', 'pesquisador']),
  items: z.array(BrandDossierSuggestionItem),
  based_on_version: z.number().int().min(0),
  created_at: z.iso.datetime(),
});
export type BrandDossierSuggestion = z.infer<typeof BrandDossierSuggestion>;

export const BrandDossierSuggestionListResponse = z.strictObject({
  items: z.array(BrandDossierSuggestion),
});
export type BrandDossierSuggestionListResponse = z.infer<typeof BrandDossierSuggestionListResponse>;

export const UseBrandDossierSuggestionRequest = z.strictObject({
  /** A versão que a pessoa estava vendo. */
  base_version: z.number().int().min(0),
  /** As posições dos itens marcados (pelo menos um). */
  items: z.array(z.number().int().min(0).max(19)).min(1).max(20),
});
export type UseBrandDossierSuggestionRequest = z.infer<typeof UseBrandDossierSuggestionRequest>;
