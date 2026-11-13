import { z } from 'zod';
import { REGRAS } from '../links/construtor.js';

// A campanha nova no Google, criada pausada (A5, Y9, parte 2; P45 pré-aprovado em 12/11/2026; D-A5-21 a D-A5-26). A peça
// aprovada em Criativos, com os textos nos tamanhos do Google e uma foto de Fotos, vira um pedido de criar uma campanha
// Performance Max no Google, pausada; ativar é outro pedido. Aqui ficam as partes puras: os limites do Google (lidos em
// 12/11/2026, base de conhecimento §3.1), a conferência dos textos, os recortes da foto, o estado que o pedido guarda (o
// que a pessoa aprova) e o plano da ferramenta `campanha_google_criar`. Sem rede e sem banco.

/** O recurso do pedido: `campanha_google:<id>`, a campanha nova do Google (`google_campaign_new`). */
export const recursoDaCampanhaGoogle = (id: string): string => `campanha_google:${id}`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** O id da campanha nova do Google no recurso do pedido, ou nulo quando o recurso é outro. */
export function campanhaGoogleDoRecurso(resourceId: string): string | null {
  const m = /^campanha_google:(.+)$/.exec(resourceId);
  return m && UUID.test(m[1]!) ? m[1]! : null;
}

/** Os limites do grupo de recursos da Performance Max (asset-requirements, lida em 12/11/2026). */
export const LIMITES_DO_GOOGLE = {
  titulo: 30,
  titulos: [3, 15],
  tituloLongo: 90,
  titulosLongos: [1, 5],
  descricao: 90,
  descricoes: [2, 5],
  nomeDaLoja: 25,
  /** A logo quadrada: pelo menos 128 × 128. */
  logoMinimo: 128,
} as const;

/** Os recortes da foto (D-A5-23): a deitada e a quadrada obrigatórias; a em pé só quando cabe. */
export const RECORTES = [
  { id: 'deitada', tipo: 'MARKETING_IMAGE', proporcao: 1.91, minLargura: 600, minAltura: 314, obrigatorio: true },
  { id: 'quadrada', tipo: 'SQUARE_MARKETING_IMAGE', proporcao: 1, minLargura: 300, minAltura: 300, obrigatorio: true },
  { id: 'em_pe', tipo: 'PORTRAIT_MARKETING_IMAGE', proporcao: 0.8, minLargura: 480, minAltura: 600, obrigatorio: false },
] as const;
export type IdDoRecorte = (typeof RECORTES)[number]['id'];

/** O maior pedaço da foto em cada proporção, pelo centro, e se ele alcança o mínimo do Google. Os mesmos números do P45. */
export function recortesDaFoto(largura: number, altura: number): { id: IdDoRecorte; largura: number; altura: number; ok: boolean; obrigatorio: boolean }[] {
  return RECORTES.map((r) => {
    const l = Math.min(largura, Math.round(altura * r.proporcao));
    const a = Math.round(l / r.proporcao);
    return { id: r.id, largura: l, altura: a, ok: l >= r.minLargura && a >= r.minAltura, obrigatorio: r.obrigatorio };
  });
}

/** O nome de cada recorte numa frase ("o recorte deitado"). */
const NOME_DO_RECORTE: Record<IdDoRecorte, string> = { deitada: 'deitado', quadrada: 'quadrado', em_pe: 'em pé' };

/** Por que a foto não serve (a pequena para um recorte obrigatório); nulo quando serve. As palavras do P45. */
export function motivoDaFotoPequena(largura: number, altura: number): string | null {
  const ruim = recortesDaFoto(largura, altura).find((r) => r.obrigatorio && !r.ok);
  if (!ruim) return null;
  const regra = RECORTES.find((r) => r.id === ruim.id)!;
  return `A foto é pequena para o recorte ${NOME_DO_RECORTE[ruim.id]}: o Google pede pelo menos ${regra.minLargura} × ${regra.minAltura}, e o maior recorte desta foto dá ${ruim.largura} × ${ruim.altura}. Use outra foto.`;
}

const tamanho = (t: string) => [...t].length;

/** Os textos do Google (D-A5-22) e o campo da recusa: as quantidades, os tamanhos e os repetidos. Nulo quando servem. */
export function motivoDosTextos(t: { titulos: string[]; titulosLongos: string[]; descricoes: string[] }): { campo: 'headlines' | 'long_headlines' | 'descriptions'; motivo: string } | null {
  const L = LIMITES_DO_GOOGLE;
  const grupos = [
    { campo: 'headlines' as const, itens: t.titulos, faixa: L.titulos, max: L.titulo, nome: ['título', 'títulos'] },
    { campo: 'long_headlines' as const, itens: t.titulosLongos, faixa: L.titulosLongos, max: L.tituloLongo, nome: ['título longo', 'títulos longos'] },
    { campo: 'descriptions' as const, itens: t.descricoes, faixa: L.descricoes, max: L.descricao, nome: ['descrição', 'descrições'] },
  ];
  for (const g of grupos) {
    const itens = g.itens.map((x) => x.trim());
    if (itens.some((x) => !x)) return { campo: g.campo, motivo: `Há ${g.nome[0]} vazio: escreva ou tire.` };
    if (itens.length < g.faixa[0]) return { campo: g.campo, motivo: `O Google pede pelo menos ${g.faixa[0]} ${g.faixa[0] === 1 ? g.nome[0] : g.nome[1]}.` };
    if (itens.length > g.faixa[1]) return { campo: g.campo, motivo: `O Google aceita até ${g.faixa[1]} ${g.nome[1]}.` };
    const longo = itens.find((x) => tamanho(x) > g.max);
    if (longo) return { campo: g.campo, motivo: `“${longo}” tem ${tamanho(longo)} caracteres: ${g.nome[0] === 'descrição' ? 'a descrição vai' : `o ${g.nome[0]} vai`} até ${g.max}.` };
    if (new Set(itens.map((x) => x.toLocaleLowerCase('pt-BR'))).size < itens.length) return { campo: g.campo, motivo: `Há ${g.nome[1]} repetidos: o Google recusa o mesmo texto duas vezes.` };
  }
  return null;
}

export const SituacaoDaCampanhaGoogle = z.enum(['pedida', 'criando', 'criada', 'nao_criada', 'cancelada']);
export type SituacaoDaCampanhaGoogle = z.infer<typeof SituacaoDaCampanhaGoogle>;

/**
 * O estado do pedido: o que a pessoa vê e aprova (a peça e os textos, a foto e os recortes, o nome e a logo da loja, a
 * loja e o raio, a verba, o fim e o destino). O plano e o hash dele saem daqui; o que existe no Google fica na linha da
 * campanha nova, fora do estado.
 */
export const EstadoDaCampanhaNovaNoGoogle = z.object({
  campanha: z.string().regex(UUID),
  marca: z.string().regex(UUID),
  nome: z.string().min(1).max(80),
  peca: z.object({ id: z.string().regex(UUID), versao: z.number().int().min(1) }),
  textos: z.object({
    titulos: z.array(z.string().min(1).max(LIMITES_DO_GOOGLE.titulo)).min(LIMITES_DO_GOOGLE.titulos[0]).max(LIMITES_DO_GOOGLE.titulos[1]),
    titulos_longos: z.array(z.string().min(1).max(LIMITES_DO_GOOGLE.tituloLongo)).min(LIMITES_DO_GOOGLE.titulosLongos[0]).max(LIMITES_DO_GOOGLE.titulosLongos[1]),
    descricoes: z.array(z.string().min(1).max(LIMITES_DO_GOOGLE.descricao)).min(LIMITES_DO_GOOGLE.descricoes[0]).max(LIMITES_DO_GOOGLE.descricoes[1]),
  }),
  /** A foto de Fotos (o arquivo, para o hash mudar se a foto mudar) e as medidas que dão os recortes. */
  foto: z.object({ id: z.string().regex(UUID), arquivo: z.string().min(1), largura: z.number().int().positive(), altura: z.number().int().positive() }),
  /** O nome da loja (até 25 caracteres) e a logo de Minha marca (a chave e o lado; quadrada). */
  loja_no_google: z.object({ nome: z.string().min(1).max(LIMITES_DO_GOOGLE.nomeDaLoja), logo: z.string().min(1), logo_lado: z.number().int().min(LIMITES_DO_GOOGLE.logoMinimo) }),
  conta: z.object({ id: z.string().regex(/^[0-9]{6,12}$/), nome: z.string() }),
  loja: z.object({ id: z.string().regex(UUID), nome: z.string(), latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180) }),
  raio_km: z.number().min(1).max(15),
  verba_diaria_micros: z.number().int().positive(),
  moeda: z.string().min(3).max(3),
  fim: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  fuso: z.string().min(1),
  link: z.string().url(),
  situacao: SituacaoDaCampanhaGoogle,
  ativa: z.boolean(),
});
export type EstadoDaCampanhaNovaNoGoogle = z.infer<typeof EstadoDaCampanhaNovaNoGoogle>;

export type PlanoDaCampanhaGoogle = { ok: true; desejado: EstadoDaCampanhaNovaNoGoogle } | { ok: false; motivo: string };

/**
 * O plano da ferramenta `campanha_google_criar`: a campanha nova pedida vira criada (pausada). O que já foi criado,
 * recusado ou cancelado não volta a ser pedido; os textos e a foto são conferidos de novo (o estado pode ter sido gravado
 * por outro caminho). Função pura.
 */
export function planoDaCampanhaGoogle(before: unknown): PlanoDaCampanhaGoogle {
  const lido = EstadoDaCampanhaNovaNoGoogle.safeParse(before);
  if (!lido.success) return { ok: false, motivo: 'Esta ferramenta é para uma campanha nova do Liame no Google.' };
  const e = lido.data;
  if (e.situacao === 'criada') return { ok: false, motivo: 'Esta campanha nova já foi criada no Google, pausada.' };
  if (e.situacao === 'cancelada') return { ok: false, motivo: 'Esta campanha nova foi cancelada.' };
  if (e.situacao === 'nao_criada') return { ok: false, motivo: 'Esta campanha nova não foi criada: peça de novo pela peça.' };
  const textos = motivoDosTextos({ titulos: e.textos.titulos, titulosLongos: e.textos.titulos_longos, descricoes: e.textos.descricoes });
  if (textos) return { ok: false, motivo: textos.motivo };
  const foto = motivoDaFotoPequena(e.foto.largura, e.foto.altura);
  if (foto) return { ok: false, motivo: foto };
  return { ok: true, desejado: { ...e, situacao: 'criada' } };
}

/**
 * O plano de ativar a campanha nova no Google (Y9, parte 5a; D-A5-32): a criada e pausada passa a rodar e a gastar a
 * verba diária. Só a criada; a ativa não é ativada de novo. Função pura.
 */
export function planoDeAtivarNoGoogle(before: unknown): PlanoDaCampanhaGoogle {
  const lido = EstadoDaCampanhaNovaNoGoogle.safeParse(before);
  if (!lido.success) return { ok: false, motivo: 'Esta ferramenta é para uma campanha nova do Liame no Google.' };
  const e = lido.data;
  if (e.situacao !== 'criada') return { ok: false, motivo: 'A campanha nova ainda não foi criada no Google: ative depois que ela existir, pausada.' };
  if (e.ativa) return { ok: false, motivo: 'Esta campanha nova já está ativa.' };
  return { ok: true, desejado: { ...e, ativa: true } };
}

/** O plano de pausar (a volta de ativar): a campanha nova ativa para de rodar e de gastar. Função pura. */
export function planoDePausarNoGoogle(before: unknown): PlanoDaCampanhaGoogle {
  const lido = EstadoDaCampanhaNovaNoGoogle.safeParse(before);
  if (!lido.success) return { ok: false, motivo: 'Esta ferramenta é para uma campanha nova do Liame no Google.' };
  const e = lido.data;
  if (e.situacao !== 'criada' || !e.ativa) return { ok: false, motivo: 'Esta campanha nova não está ativa: não há o que pausar.' };
  return { ok: true, desejado: { ...e, ativa: false } };
}

// ------------------------------------------------------------------ a criação no Google (Y9, parte 3; D-A5-27, D-A5-28)

/** A marca do Liame no nome da campanha: `(Liame 0123456789ab)`, com os 12 últimos dígitos do id (a parte aleatória). */
export function marcaDoLiame(campanha: string): string {
  return `(Liame ${campanha.replace(/-/g, '').slice(-12).toLowerCase()})`;
}

/**
 * O nome da campanha no Google: o da pessoa e, no fim, a marca do Liame. O nome é único na conta (o Google recusa o
 * repetido), e é por ele que a tentativa seguinte acha a campanha que o Google criou quando a resposta se perdeu.
 */
export function nomeNoGoogle(e: Pick<EstadoDaCampanhaNovaNoGoogle, 'nome' | 'campanha'>): string {
  return `${e.nome} ${marcaDoLiame(e.campanha)}`;
}

/** O tamanho que vai ao Google de cada recorte (o recomendado; o recorte menor vai como está). */
export const TAMANHO_NO_GOOGLE: Record<IdDoRecorte, { largura: number; altura: number }> = {
  deitada: { largura: 1200, altura: 628 },
  quadrada: { largura: 1200, altura: 1200 },
  em_pe: { largura: 960, altura: 1200 },
};
/** O lado da logo quadrada no Google (o recomendado); a logo menor vai no lado dela. */
export const LADO_DA_LOGO_NO_GOOGLE = 1200;

export type TipoDoRecorte = (typeof RECORTES)[number]['tipo'];
export type AreaDoRecorteNoGoogle = { id: IdDoRecorte; tipo: TipoDoRecorte; left: number; top: number; width: number; height: number; saida: { largura: number; altura: number } };

/**
 * As áreas da foto que vão ao Google: o maior pedaço de cada proporção, pelo centro (os números de `recortesDaFoto`, os
 * mesmos do P45), e o tamanho de saída (o recomendado, quando o pedaço é maior). Só os que alcançam o mínimo: o em pé
 * fica de fora quando não cabe; um obrigatório que não cabe também (quem chama recusa antes, por `motivoDaFotoPequena`).
 */
export function areasDosRecortes(largura: number, altura: number): AreaDoRecorteNoGoogle[] {
  return recortesDaFoto(largura, altura)
    .filter((r) => r.ok)
    .map((r) => {
      const alvo = TAMANHO_NO_GOOGLE[r.id];
      return {
        id: r.id,
        tipo: RECORTES.find((x) => x.id === r.id)!.tipo,
        left: Math.floor((largura - r.largura) / 2),
        top: Math.floor((altura - r.altura) / 2),
        width: r.largura,
        height: r.altura,
        saida: r.largura > alvo.largura ? alvo : { largura: r.largura, altura: r.altura },
      };
    });
}

/** As imagens prontas para o Google, em base64: os recortes da foto (o em pé, quando cabe) e a logo quadrada. */
export type ImagensDoGoogle = { recortes: { id: IdDoRecorte; tipo: TipoDoRecorte; base64: string }[]; logo: string };

/**
 * A automação de recursos da Performance Max que o Liame desliga (D-A5-27): o Google não escreve textos (vai ao ar o que
 * a pessoa aprovou e o Compliance conferiu), não troca o destino pelo resto do site (o link é o do cardápio, com o
 * rastreio), não mexe na foto e não gera versões de vídeo. Os quatro nascem ligados na Performance Max
 * (AssetAutomationTypeEnum da v25, lido em 12/11/2026).
 */
export const AUTOMACOES_DESLIGADAS = ['TEXT_ASSET_AUTOMATION', 'FINAL_URL_EXPANSION_TEXT_ASSET_AUTOMATION', 'GENERATE_IMAGE_ENHANCEMENT', 'GENERATE_ENHANCED_YOUTUBE_VIDEOS'] as const;

/** O idioma da campanha: português (`languageConstants/1014`); na Performance Max vale para os canais fora da Pesquisa. */
export const IDIOMA_PORTUGUES = 'languageConstants/1014';

/**
 * O rastreio do Liame no sufixo do URL final da campanha (D-A5-26, D-A5-29): a origem, o meio e o id da campanha (o
 * ValueTrack `{campaignid}`, que o Google troca no clique). A Performance Max não tem grupo de anúncios nem anúncio: o
 * id da campanha é o que liga a venda a ela (a conferência dos links aceita o id da campanha sozinho).
 */
export function rastreioDaPerformanceMax(): string {
  const r = REGRAS.google_ads;
  const campanha = r.dinamicos.find(([k]) => k === 'campaign_id')!;
  return [`utm_source=${r.utmSource}`, `utm_medium=${r.utmMedium}`, `${campanha[0]}=${campanha[1]}`].join('&');
}

export type OperacaoDoGoogle = Record<string, { create: Record<string, unknown> }>;

/**
 * Quem vê o anúncio pelo local (D-A5-34): só quem está ou costuma estar no raio (`PRESENCE`). O padrão do Google é
 * `PRESENCE_OR_INTEREST`, que soma quem só mostrou interesse pelo lugar (pesquisou, visitou, leu sobre ele); para uma loja
 * que entrega num raio, e para a frase da tela ("quem está num raio de X km em volta da loja"), vale só a presença.
 * Campo e valores: `campaign.geo_target_type_setting.positive_geo_target_type`, na página oficial de segmentação por local.
 */
export const SO_QUEM_ESTA_NO_LOCAL = 'PRESENCE';

/**
 * A operação de ativar ou pausar a campanha (`campaigns:mutate`). Ativar acerta também o local para "só quem está": a
 * campanha criada antes da D-A5-34 nasceu com o padrão do Google, e não pode começar a gastar com ele. Pausar muda só a
 * situação (não pode falhar por outro motivo). Função pura.
 */
export function operacaoDeAtivarOuPausar(recurso: string, ativar: boolean): { updateMask: string; update: Record<string, unknown> } {
  return ativar
    ? {
        updateMask: 'status,geo_target_type_setting.positive_geo_target_type',
        update: { resourceName: recurso, status: 'ENABLED', geoTargetTypeSetting: { positiveGeoTargetType: SO_QUEM_ESTA_NO_LOCAL } },
      }
    : { updateMask: 'status', update: { resourceName: recurso, status: 'PAUSED' } };
}

/**
 * A criação inteira numa requisição só (`googleAds:mutate`; a Performance Max pede o grupo de recursos com todos os
 * recursos dele, e as regras da marca pedem o nome da loja e a logo, na mesma requisição): o orçamento diário só desta
 * campanha; a campanha PAUSADA (Maximizar conversões, regras da marca, a automação desligada, o rastreio, o fim); o raio em volta da
 * loja e o idioma; os textos e as imagens; o nome e a logo da loja na campanha; o grupo de recursos com o link e os
 * recursos dele. Os ids negativos são os provisórios da requisição, e o Google cria tudo ou nada. Função pura.
 */
export function operacoesDaCriacao(e: EstadoDaCampanhaNovaNoGoogle, imagens: ImagensDoGoogle): OperacaoDoGoogle[] {
  const cliente = `customers/${e.conta.id}`;
  let proximo = -1;
  const provisorio = (tipo: string) => `${cliente}/${tipo}/${proximo--}`;
  const orcamento = provisorio('campaignBudgets');
  const campanha = provisorio('campaigns');
  const grupo = provisorio('assetGroups');
  const nome = nomeNoGoogle(e);
  const marca = marcaDoLiame(e.campanha);
  const ops: OperacaoDoGoogle[] = [];

  ops.push({ campaignBudgetOperation: { create: { resourceName: orcamento, name: `Verba · ${nome}`, amountMicros: String(e.verba_diaria_micros), deliveryMethod: 'STANDARD', explicitlyShared: false } } });
  ops.push({
    campaignOperation: {
      create: {
        resourceName: campanha,
        name: nome,
        advertisingChannelType: 'PERFORMANCE_MAX',
        status: 'PAUSED',
        geoTargetTypeSetting: { positiveGeoTargetType: SO_QUEM_ESTA_NO_LOCAL },
        campaignBudget: orcamento,
        maximizeConversions: {},
        brandGuidelinesEnabled: true,
        containsEuPoliticalAdvertising: 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING',
        assetAutomationSettings: AUTOMACOES_DESLIGADAS.map((tipo) => ({ assetAutomationType: tipo, assetAutomationStatus: 'OPTED_OUT' })),
        finalUrlSuffix: rastreioDaPerformanceMax(),
        ...(e.fim ? { endDateTime: `${e.fim} 23:59:59` } : {}),
      },
    },
  });
  ops.push({
    campaignCriterionOperation: {
      create: {
        campaign: campanha,
        proximity: {
          geoPoint: { latitudeInMicroDegrees: Math.round(e.loja.latitude * 1e6), longitudeInMicroDegrees: Math.round(e.loja.longitude * 1e6) },
          radius: e.raio_km,
          radiusUnits: 'KILOMETERS',
        },
      },
    },
  });
  ops.push({ campaignCriterionOperation: { create: { campaign: campanha, language: { languageConstant: IDIOMA_PORTUGUES } } } });

  // Um recurso de texto por texto diferente: o mesmo texto em dois papéis (um título igual ao nome da loja) usa o mesmo.
  const textos = new Map<string, string>();
  const texto = (t: string): string => {
    const ja = textos.get(t);
    if (ja) return ja;
    const recurso = provisorio('assets');
    textos.set(t, recurso);
    ops.push({ assetOperation: { create: { resourceName: recurso, textAsset: { text: t } } } });
    return recurso;
  };
  const imagem = (base64: string, qual: string): string => {
    const recurso = provisorio('assets');
    ops.push({ assetOperation: { create: { resourceName: recurso, name: `${qual} ${marca}`, imageAsset: { data: base64 } } } });
    return recurso;
  };

  const doGrupo: { asset: string; fieldType: string }[] = [
    ...e.textos.titulos.map((t) => ({ asset: texto(t), fieldType: 'HEADLINE' })),
    ...e.textos.titulos_longos.map((t) => ({ asset: texto(t), fieldType: 'LONG_HEADLINE' })),
    ...e.textos.descricoes.map((t) => ({ asset: texto(t), fieldType: 'DESCRIPTION' })),
    ...imagens.recortes.map((r) => ({ asset: imagem(r.base64, `Foto ${NOME_DO_RECORTE[r.id]}`), fieldType: r.tipo })),
  ];
  const nomeDaLoja = texto(e.loja_no_google.nome);
  const logo = imagem(imagens.logo, 'Logo');
  ops.push({ campaignAssetOperation: { create: { campaign: campanha, asset: nomeDaLoja, fieldType: 'BUSINESS_NAME' } } });
  ops.push({ campaignAssetOperation: { create: { campaign: campanha, asset: logo, fieldType: 'LOGO' } } });
  ops.push({ assetGroupOperation: { create: { resourceName: grupo, name: e.nome, campaign: campanha, finalUrls: [e.link], status: 'ENABLED' } } });
  for (const d of doGrupo) ops.push({ assetGroupAssetOperation: { create: { assetGroup: grupo, asset: d.asset, fieldType: d.fieldType } } });
  return ops;
}

/** Os ids do que o Google criou: o orçamento, a campanha e o grupo de recursos. */
export type IdsNoGoogle = { orcamento: string; campanha: string; grupo: string };

function idDoRecurso(nome: unknown, tipo: string): string | null {
  const m = typeof nome === 'string' ? new RegExp(`^customers/\\d+/${tipo}/(\\d+)$`).exec(nome) : null;
  return m ? m[1]! : null;
}

/** Os ids na resposta da criação (`mutateOperationResponses`, uma por operação). Nulo quando falta algum. */
export function idsDaCriacao(corpo: unknown): IdsNoGoogle | null {
  const respostas = (corpo as { mutateOperationResponses?: unknown } | null)?.mutateOperationResponses;
  if (!Array.isArray(respostas)) return null;
  const achar = (campo: string, tipo: string): string | null => {
    for (const r of respostas as Record<string, { resourceName?: unknown } | undefined>[]) {
      const id = idDoRecurso(r?.[campo]?.resourceName, tipo);
      if (id) return id;
    }
    return null;
  };
  const orcamento = achar('campaignBudgetResult', 'campaignBudgets');
  const campanha = achar('campaignResult', 'campaigns');
  const grupo = achar('assetGroupResult', 'assetGroups');
  return orcamento && campanha && grupo ? { orcamento, campanha, grupo } : null;
}

/**
 * A procura da campanha que uma tentativa anterior pode ter criado (a resposta se perdeu): pelo nome, que termina na
 * marca do Liame. A marca só tem letras, números, espaço e parênteses: nada que o LIKE do GAQL leia como curinga.
 */
export function consultaDaCampanhaCriada(campanha: string): string {
  return `SELECT campaign.id, campaign.campaign_budget, asset_group.id FROM asset_group WHERE campaign.name LIKE '%${marcaDoLiame(campanha)}' AND campaign.status != 'REMOVED'`;
}

/** Os ids da campanha achada pela procura; nulo quando o Google não a tem. */
export function idsDaProcura(corpo: unknown): IdsNoGoogle | null {
  type Linha = { campaign?: { id?: unknown; campaignBudget?: unknown }; assetGroup?: { id?: unknown } };
  const linhas = Array.isArray(corpo) ? (corpo as { results?: Linha[] }[]).flatMap((l) => l?.results ?? []) : [];
  for (const l of linhas) {
    const campanha = String(l.campaign?.id ?? '');
    const grupo = String(l.assetGroup?.id ?? '');
    const orcamento = idDoRecurso(l.campaign?.campaignBudget, 'campaignBudgets');
    if (/^\d+$/.test(campanha) && /^\d+$/.test(grupo) && orcamento) return { orcamento, campanha, grupo };
  }
  return null;
}
