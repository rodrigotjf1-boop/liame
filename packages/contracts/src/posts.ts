import { z } from 'zod';

// Os posts da marca (A6, Z5; protótipo P19, aprovado pelo dono em 21/10/2026): a foto das Fotos, os canais (o Instagram
// e a Página do Facebook, ligados à marca em Contas conectadas), o texto de cada canal e a hora. O post vira um pedido em
// Aprovações, como os outros: só sai com a aprovação de uma pessoa, com o código do app (D-A6-3), na hora marcada, que o
// Liame segura (D-A6-8). A aprovação vale para o conjunto: mudar o texto, a foto ou os canais é um post novo (D-A6-7).

/** Os canais onde o Liame publica nesta fase. */
export const POST_CHANNELS = ['instagram', 'facebook'] as const;
export const PostChannel = z.enum(POST_CHANNELS);
export type PostChannel = z.infer<typeof PostChannel>;

/**
 * Os canais do pacote pronto (A6, Z8; D-A6-12 e D-A6-25; P22): o Liame monta o texto, a foto e a hora, e quem publica é a
 * pessoa. Cada rede vira um pacote à parte, sem pedido em Aprovações.
 */
export const PACKAGE_CHANNELS = ['tiktok', 'youtube'] as const;
export const PackageChannel = z.enum(PACKAGE_CHANNELS);
export type PackageChannel = z.infer<typeof PackageChannel>;

/**
 * O limite do texto de cada canal: a legenda do Instagram até 2.200 caracteres; a Página, o do Liame; o TikTok, 2.200 (o
 * que vale em toda conta: a Central do TikTok não publica o número, e há contas com 4.000 [NC]); o YouTube, os 5.000 da
 * descrição (Central do YouTube, lida em 29/10/2026).
 */
export const POST_TEXT_LIMITS = { instagram: 2200, facebook: 10000, tiktok: 2200, youtube: 5000 } as const;

export const CreatePostRequest = z.strictObject({
  brand_id: z.uuid(),
  /** Uma foto pronta das Fotos da marca (D-A6-6: só a foto de verdade, como ela é). */
  photo_id: z.uuid(),
  /** A hora marcada, com o fuso. Entre 8h e 22h no fuso da empresa, depois de agora e até 60 dias. */
  publish_at: z.iso.datetime({ offset: true }),
  /**
   * A posição do recorte do Instagram (D-A6-21), de 0 a 100 ao longo do lado comprido da foto (0 = o começo, 50 = o
   * centro). Só quando o Instagram está entre os canais e a foto é mais alta que 4:5 ou mais larga que 1,91:1; ausente,
   * o recorte é no centro.
   */
  crop_pos: z.int().min(0).max(100).optional(),
  /**
   * De um a quatro canais, cada um com o texto dele (sem repetir o canal). Os do Liame (o Instagram e a Página) viram o
   * post com o pedido em Aprovações; os do pacote (o TikTok e o YouTube) viram um pacote para cada rede, pronto na Agenda,
   * sem pedido (D-A6-25).
   */
  channels: z
    .array(z.strictObject({ channel: z.enum([...POST_CHANNELS, ...PACKAGE_CHANNELS]), text: z.string().trim().min(1).max(10000) }))
    .min(1)
    .max(POST_CHANNELS.length + PACKAGE_CHANNELS.length),
});
export type CreatePostRequest = z.infer<typeof CreatePostRequest>;

/**
 * Mudar a hora de um post aprovado que ainda espera a hora (A6, Z5d; P19; D-A6-23 e D-A6-55): a hora nova (entre 8h e 22h
 * no fuso da empresa, depois de agora e até 60 dias) e o código do app de quem aprova de novo.
 */
export const ReschedulePostRequest = z.strictObject({
  publish_at: z.iso.datetime({ offset: true }),
  code: z.string().regex(/^\d{6}$/, { error: 'Digite os 6 números do app' }),
});
export type ReschedulePostRequest = z.infer<typeof ReschedulePostRequest>;

const numero = z.int().min(0).nullable();
/** Os números de um post num canal (A6, Z7, parte c). */
export const PostMetrics = z.strictObject({
  views: numero,
  reach: numero,
  likes: numero,
  comments: numero,
  shares: numero,
  saves: numero,
  clicks: numero,
  reactions: numero,
});
export type PostMetrics = z.infer<typeof PostMetrics>;

export const PostChannelResponse = z.strictObject({
  /** `instagram` ou `facebook` (a lista pode crescer: o Threads e o Perfil no Google). */
  channel: z.string().regex(/^[a-z_]{2,30}$/),
  /** A conta ligada do canal e o nome dela; nulos quando ela foi desligada da marca depois. */
  account_id: z.uuid().nullable(),
  account_name: z.string().nullable(),
  text: z.string(),
  /**
   * `aguardando` (o pedido espera a aprovação ou a hora), `publicando`, `publicado`, `falhou`, `cancelado` ou `apagado`;
   * no pacote, `pronto` (espera a pessoa publicar), `publicado` (a pessoa marcou) ou `cancelado` (tirado da Agenda). A
   * lista pode crescer.
   */
  status: z.string().regex(/^[a-z_]{2,30}$/),
  /** O endereço do post publicado na rede. */
  permalink: z.string().nullable(),
  /** Por que não saiu neste canal, em palavras do Liame. */
  error: z.string().nullable(),
  published_at: z.iso.datetime().nullable(),
  /**
   * Os números do post neste canal, lidos da rede como apoio (A6, Z7, parte c; o resultado do post é o pedido pelo link
   * dele): as vezes em que foi visto, as pessoas que viram (estimado pela rede), as curtidas, os comentários, os
   * compartilhamentos, os salvos, os cliques e as reações. Nulo o que a rede não dá; o objeto inteiro, nulo antes da
   * primeira leitura.
   */
  metrics: PostMetrics.nullable(),
  /**
   * A situação da leitura: `lido`, `sem_dados` (a rede ainda não tem o número, ou não tem para este post: a Página com
   * menos de 100 curtidas), `sem_permissao` (a autorização não permite ler os números) ou `sem_conta` (a conta saiu da
   * marca ou a autorização venceu); nulo antes da primeira leitura. A lista pode crescer.
   */
  metrics_status: z.string().regex(/^[a-z_]{2,30}$/).nullable(),
  metrics_read_at: z.iso.datetime().nullable(),
  /**
   * Até quando dá para "Tentar de novo" neste canal (A6, Z5d; P19; D-A6-54: `POST /v1/posts/{id}/retry`): o post saiu no
   * outro canal e não neste, por um motivo que pode passar (a conta, a permissão, a rede fora do ar, uma trava), e faz
   * menos de 24 horas que ele saiu no outro. Nulo: não dá (o canal saiu ou ainda vai sair, o post não saiu em nenhum, o
   * prazo passou, ou o motivo pede um post novo: a foto recusada, o arquivo que sumiu, a foto grande demais para a Página,
   * a tentativa que não deu para conferir).
   */
  retry_until: z.iso.datetime().nullable(),
});
export type PostChannelResponse = z.infer<typeof PostChannelResponse>;

export const PostResponse = z.strictObject({
  id: z.uuid(),
  brand_id: z.uuid(),
  /**
   * `post` (o Liame publica, depois do pedido aprovado) ou `pacote` (o pacote pronto de uma rede, que a pessoa publica;
   * A6, Z8). A lista pode crescer.
   */
  kind: z.string().regex(/^[a-z_]{2,30}$/),
  /** A foto das Fotos; nula quando ela foi apagada depois (o post não sai). */
  photo_id: z.uuid().nullable(),
  crop_pos: z.int().min(0).max(100).nullable(),
  publish_at: z.iso.datetime(),
  /**
   * O pedido do post no trilho: o de publicar, que passou por Aprovações, ou, depois de um "Tentar de novo" (A6, Z5d), o
   * da nova tentativa, que é o mais novo e diz a situação. Nulo no pacote.
   */
  action_id: z.uuid().nullable(),
  /**
   * A situação do post: `esperando_aprovacao`, `agendado` (aprovado, espera a hora), `publicando`, `publicado`,
   * `em_parte` (saiu num canal e não no outro), `nao_saiu`, `cancelado`, `recusado` ou `expirado` (ninguém aprovou no
   * prazo); a do pacote: `pacote_pronto` (a pessoa publica), `pacote_publicado` (ela marcou "Publiquei") ou `cancelado`
   * (tirado da Agenda). A lista pode crescer.
   */
  status: z.string().regex(/^[a-z_]{2,30}$/),
  created_at: z.iso.datetime(),
  channels: z.array(PostChannelResponse),
  /**
   * O link do post (A6, Z7; D-A6-16 e D-A6-46): o cardápio da loja com o código só deste post. No post com a Página, ele
   * já está no fim do texto dela (D-A6-47); no pacote, é o link da bio. Nulo quando o post nasceu sem link (sem a
   * Página, ou a marca sem uma loja só com o cardápio ligado).
   */
  link: z.string().nullable(),
});
export type PostResponse = z.infer<typeof PostResponse>;

/** Os posts da marca num período (a Agenda): de `from` a `to`, os dois dias inclusive, até 62 dias. */
export const PostListQuery = z.strictObject({ brand_id: z.uuid(), from: z.iso.date(), to: z.iso.date() });
export type PostListQuery = z.infer<typeof PostListQuery>;

/** As contas conectadas à marca num canal (a Página, o Instagram), para o novo post escolher e a Agenda dizer o que falta. */
export const PostChannelAccounts = z.strictObject({
  channel: PostChannel,
  /** As contas conectadas (ligadas e sem a recusa da plataforma); o post pede uma só por canal (D-A6-36). */
  accounts: z.array(z.strictObject({ id: z.uuid(), name: z.string() })),
});
export type PostChannelAccounts = z.infer<typeof PostChannelAccounts>;

export const PostListResponse = z.strictObject({
  /** A função dos posts (`social_write`) ligada para a empresa; desligada, a lista vem vazia. */
  enabled: z.boolean(),
  /** O fuso da empresa: os dias da Agenda e a janela das 8h às 22h são nele. */
  timezone: z.string().min(1).max(64),
  /** As contas conectadas à marca em cada canal do post; vazio com a função desligada. */
  channels: z.array(PostChannelAccounts),
  items: z.array(PostResponse),
  /**
   * Se o post novo da marca ganha o link do post (D-A6-46): `ok`, ou o porquê de não ganhar, em `reason`:
   * `sem_cardapio` (nenhuma loja da marca com o cardápio do Regem ligado) ou `varias_lojas` (mais de uma; a escolha da
   * loja ainda não existe). A lista pode crescer.
   */
  post_link: z.strictObject({ ok: z.boolean(), reason: z.string().regex(/^[a-z_]{2,30}$/).nullable() }),
  /**
   * A pauta da semana nos dias do período (A6, Z5d, parte 5; D-A6-20 e D-A6-56): o item de cada dia, do plano de pauta do
   * Estrategista aprovado mais novo que cobre o dia (`plan_id`). Só para quem vê os planos (`planos.ver`); vazia sem
   * eles e com a função desligada.
   */
  pauta: z.array(z.strictObject({ day: z.iso.date(), item: z.string(), plan_id: z.uuid() })),
  /**
   * As datas do calendário comercial do Liame no período (D-A6-20): feriados nacionais e datas do varejo, as mesmas que o
   * Estrategista usa. `kind`: `feriado_nacional` ou `varejo` (a lista pode crescer). Vazia com a função desligada.
   */
  dates: z.array(z.strictObject({ day: z.iso.date(), name: z.string(), kind: z.string().regex(/^[a-z_]{2,30}$/) })),
});
export type PostListResponse = z.infer<typeof PostListResponse>;

/**
 * A foto do pacote pronto para baixar (A6, Z8; P22, o passo "Baixe a foto"): a cópia que o Liame guarda, em JPEG, sem os
 * dados do celular. O endereço vale poucos minutos e baixa como arquivo (D-A6-43).
 */
export const PostPhotoResponse = z.strictObject({
  url: z.string().min(1),
  /** O nome do arquivo: `liame-<rede>-<dia>.jpg`, o dia da hora marcada no fuso da empresa. */
  filename: z.string().regex(/^[a-z0-9-]{1,80}\.jpg$/),
  expires_at: z.iso.datetime(),
});
export type PostPhotoResponse = z.infer<typeof PostPhotoResponse>;
