import { createHmac, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { idNumericoDeMentira } from './id-de-mentira.js';

// O Instagram de mentira para os testes do post (A6 · Z5b, parte 2). Segue as páginas oficiais lidas em 29/10/2026 (base
// §2.2: `developers.facebook.com/docs/instagram-platform/content-publishing` e a referência do
// `content_publishing_limit`, v26.0):
//   - `POST /{v}/{ig}/media` com `image_url` e `caption` (corpo JSON, como o exemplo da página) → `{"id": contêiner}`; a
//     Meta busca a imagem na hora ("We will cURL your image using the passed in URL");
//   - `GET /{v}/{contêiner}?fields=status_code` → `FINISHED`, `IN_PROGRESS`, `ERROR`, `EXPIRED` ou `PUBLISHED`;
//   - `POST /{v}/{ig}/media_publish` com `creation_id` → `{"id": post}`;
//   - `GET /{v}/{ig}/content_publishing_limit?fields=quota_usage,config` → `quota_usage` e `config.quota_total`, na
//     lista `data`;
//   - `GET /{v}/{ig}/media?fields=id,caption,timestamp,permalink` → os posts, do mais novo ao mais antigo, com a data
//     no formato do Instagram (`+0000`, sem os dois-pontos);
//   - `GET /{v}/{post}?fields=permalink`.
// O que a documentação NÃO diz vira o PIOR caso aqui (V125; base §2.2, [NC]): publicar duas vezes o mesmo contêiner cria
// DOIS posts (o teste prova que o Liame nunca faz isso), e publicar o contêiner que ainda não está pronto responde o erro
// 9007 ("a mídia ainda não está pronta").
//
// A Página do Facebook (parte 3), pelas páginas oficiais lidas em 29/10/2026 (`…/reference/page/photos/`,
// `…/reference/photo/` e o "Get a Page access token" das Pages API, v26.0):
//   - `GET /{v}/me/accounts?fields=id,access_token,tasks`, com o token da autorização → cada Página com o token dela e as
//     tarefas de quem autorizou;
//   - `POST /{v}/{página}/photos` com `url` e `caption`, com o token da Página de quem tem `CREATE_CONTENT` → `{"id",
//     "post_id"}`; a Página busca a imagem pelo endereço (o pior caso: na hora, como o Instagram);
//   - `GET /{v}/{página}/photos?type=uploaded&fields=id,name,created_time,link,page_story_id` (o `name` é a legenda; a
//     leitura pede a tarefa `MODERATE`: sem ela, a recusa de permissão, código 200);
//   - `GET /{v}/{post}?fields=permalink_url`.
// Publicar a mesma foto duas vezes cria dois posts (a documentação não fala em evitar a repetição: o pior caso).
//
// Apagar das redes (A6, Z5d, parte 6), pelas páginas oficiais lidas em 30/10/2026 (`…/instagram-graph-api/reference/
// ig-media` e `…/docs/pages-api/posts`, v26.0):
//   - `DELETE /{v}/{ig-media-id}`, com `instagram_basic` e `instagram_manage_contents` → `{"success": true, "deleted_id"}`;
//     sem a permissão, a recusa (#10);
//   - `DELETE /{v}/{page_post_id}`, com o token da Página → `{"success": true}`. A página não diz qual tarefa apagar pede
//     (fala em `CREATE_CONTENT`, `MANAGE` e `MODERATE` para os posts em geral): aqui, a de publicar, `CREATE_CONTENT`;
//   - o que não existe (já apagado direto na rede): o código 100 com o subcódigo 33, como qualquer objeto que a Meta não acha.
//
// "Do seu Instagram" (A6, Z10, parte 5), pela referência do objeto de mídia lida em 07/11/2026 (`…/instagram-platform/
// reference/instagram-media`): a lista devolve só os campos pedidos em `fields`; `media_type` (`IMAGE`, `VIDEO`,
// `CAROUSEL_ALBUM`) e `media_product_type` (`FEED`, `REELS`, `STORY`, `AD`); `thumbnail_url` só no vídeo; e o pior caso
// do que pode faltar (V125): `media_url` não vem no vídeo com áudio protegido ou licenciado (a música do Instagram), e
// `like_count` não vem quando a conta esconde as curtidas. O post publicado fora do Liame entra por `publicadoForaDoLiame`.
//
// Comentários (A6, Z11, parte 1), pelas páginas oficiais lidas em 07/11/2026 (base §2.2):
//   - Instagram, `GET /{v}/{ig-media-id}/comments` (`…/instagram-graph-api/reference/ig-media/comments` e `…/ig-comment`):
//     até 50 por consulta, do mais novo para o mais velho, só os de primeiro nível; as respostas pelo campo `replies`
//     (`replies.limit(n){…}`); `username`, `from` (`id` e `username`), `like_count` e `hidden`; sem a permissão
//     `instagram_manage_comments`, a recusa (#10). O oculto volta com `hidden: true` (a referência tem o campo);
//   - Página, `GET /{v}/{page-id}/posts` (`…/graph-api/reference/page/feed`): até 100, com o agendado e o rascunho
//     (`is_published`), pelo token da Página de quem pode CREATE_CONTENT, MANAGE ou MODERATE; e `GET /{v}/{page-post-id}/
//     comments` (`…/docs/pages-api/comments-mentions`), pelo token da Página de quem pode MODERATE (sem a tarefa, a recusa
//     #200); `filter=stream` traz todos os níveis, com o `parent`; sem ele, só os de primeiro nível. A documentação não diz
//     quando o `from` vem: o pior caso (V125, [NC]) é não vir para quem comentou (`paginaDevolveQuemComentou`); o da
//     própria Página vem.

export const TOKEN_DO_INSTAGRAM = `token-do-instagram-${randomBytes(6).toString('hex')}`;
export const SEGREDO_DO_APP = `segredo-do-app-${randomBytes(6).toString('hex')}`;
/** O token que a lista das Páginas devolve para a Página da marca (é com ele que a foto é publicada). */
export const TOKEN_DA_PAGINA = `token-da-pagina-${randomBytes(6).toString('hex')}`;
/** O id do app do Liame na Meta, como o dono da conversa o devolve (Z12, parte 2: o Conversation Routing). */
export const APP_DA_META = '1234567890123';

const objetoDe = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});

export type FotoNaPagina = { id: string; pagina: string; name: string; created_time: string; link: string; page_story_id: string; imagem: Buffer | null };

export type PostNoInstagram = {
  id: string;
  caption: string;
  timestamp: string;
  permalink: string;
  conteiner: string;
  imagem: Buffer | null;
  /** Os campos da lista de "Do seu Instagram" (A6, Z10, parte 5). Sem eles: a foto do feed, com o arquivo. */
  media_type?: 'IMAGE' | 'VIDEO' | 'CAROUSEL_ALBUM';
  media_product_type?: 'FEED' | 'REELS' | 'STORY' | 'AD';
  /** Nulo: a Meta não manda (o vídeo com música do Instagram). */
  media_url?: string | null;
  thumbnail_url?: string | null;
  /** Nulo: a conta esconde as curtidas (o campo não vem). */
  like_count?: number | null;
  comments_count?: number;
};

/** O que se pode dizer de um post publicado fora do Liame (A6, Z10, parte 5). */
export type PostForaDoLiame = Partial<Pick<PostNoInstagram, 'caption' | 'media_type' | 'media_product_type' | 'media_url' | 'thumbnail_url' | 'like_count' | 'comments_count'>> & {
  /** Há quantas horas saiu. */
  horas?: number;
};
/**
 * O contêiner do post: a foto (`image_url`) ou, no Reels (A6, Z10), o vídeo (`video_url`), com a capa (`cover_url` ou
 * `thumb_offset`) e `share_to_feed`, como o pedido chegou.
 */
export type Conteiner = {
  id: string;
  ig: string;
  caption: string;
  imagem: Buffer | null;
  endereco: string;
  status: string;
  tipo: 'foto' | 'REELS' | 'STORY';
  capa?: string | null;
  quadro?: string | null;
  noFeed?: string | null;
  /** No Story (A6, Z13): o vídeo (`video_url`) ou a foto (`image_url`). */
  storyVideo?: boolean;
};
/**
 * O vídeo na Página (A6, Z10): o Reels (o começo, o envio pelo `rupload` e o fim) ou o vídeo comum. `fase`: enviando (o
 * Reels antes do arquivo), processando, publicado ou erro.
 */
export type VideoNaPagina = {
  id: string;
  pagina: string;
  tipo: 'reels' | 'video' | 'story';
  description: string;
  created_time: string;
  arquivo: Buffer | null;
  fase: 'enviando' | 'processando' | 'publicado' | 'erro';
};
export type ChamadaNoInstagram = { metodo: string; caminho: string; params: Record<string, string>; corpo: Record<string, unknown> | null; cabecalhos?: Record<string, string> };
export type FalhaCombinada = { status: number; corpo: unknown };
/** Um comentário numa mídia do Instagram (A6, Z11), com as respostas. `deId`: o IGSID de quem comentou. */
export type ComentarioNoInstagram = {
  id: string;
  text: string;
  timestamp: string;
  username: string;
  deId: string;
  like_count: number;
  hidden: boolean;
  respostas: ComentarioNoInstagram[];
};
/** Um Story publicado (A6, Z13): no Instagram, pelo contêiner; na Página, com a mídia (a foto sem post ou o vídeo). */
export type StoryNaMeta = { id: string; onde: string; post_id: string; media_id: string; media_type: 'photo' | 'video'; creation_time: string; url: string; imagem: Buffer | null };
/** Um post de uma Página (A6, Z11). */
export type PostNaPagina = { id: string; pagina: string; message: string; created_time: string; permalink_url: string; full_picture: string | null; is_published: boolean };
/** Um comentário num post da Página (A6, Z11). `deId` e `nome`: quem comentou (o id da Página, se foi ela). */
export type ComentarioNaPagina = {
  id: string;
  message: string;
  created_time: string;
  deId: string;
  nome: string;
  like_count: number;
  comment_count: number;
  is_hidden: boolean;
  parent: string | null;
};

/** Um id numérico como os da Meta, único a cada execução (V156) e nunca repetido no mesmo milissegundo (ERR-236). */
const idDaMeta = (): string => idNumericoDeMentira(17);

/** A data no formato do Instagram: `2026-10-29T19:00:00+0000`. */
const dataDoInstagram = (d: Date): string => `${d.toISOString().slice(0, 19)}+0000`;

/** Uma mensagem do Direct (A6, Z12): da marca ou da pessoa, o texto, o tipo do anexo e o story. */
export type MensagemNoDirect = { id: string; created_time: string; daMarca: boolean; texto: string; anexo?: string; story?: 'reply_to' | 'mention' };
/** Uma conversa do Direct, como a Página a guarda: a pessoa e as mensagens, da mais velha para a mais nova. */
/** `canal`: o Direct do Instagram ou o Messenger da Página (A6, Z14); no Messenger a pessoa vem com o nome, sem @. */
export type ConversaNoDirect = {
  id: string;
  pagina: string;
  canal: 'instagram' | 'messenger';
  updated_time: string;
  pessoa: { id: string; username?: string; name?: string };
  mensagens: MensagemNoDirect[];
};

export class InstagramDeMentira {
  readonly conteineres = new Map<string, Conteiner>();
  readonly posts: PostNoInstagram[] = [];
  readonly chamadas: ChamadaNoInstagram[] = [];
  /** O que apareceu de errado no pedido (o token na URL, sem a prova do segredo do app, token errado). */
  readonly defeitos: string[] = [];
  /** A situação com que o contêiner nasce. */
  situacaoAoCriar = 'FINISHED';
  /** Quantos posts o app já publicou nas últimas 24 horas, e o máximo. */
  cota = { usados: 0, total: 50 };
  /** O que a Meta responde às próximas chamadas a este caminho final (`media`, `media_publish`, …), na ordem. */
  falhas = new Map<string, FalhaCombinada[]>();
  /** A próxima publicação acontece, mas a resposta não chega (a Meta responde 503 depois de publicar). */
  perderARespostaDaPublicacao = false;
  /** Como buscar a imagem pelo endereço (o armazenamento dos testes). Nulo: a imagem não está lá. */
  buscarImagem: (endereco: string) => Buffer | null = () => null;
  /** As Páginas que a autorização alcança, com as tarefas de quem autorizou em cada uma. */
  readonly paginas = new Map<string, string[]>();
  readonly fotosNaPagina: FotoNaPagina[] = [];
  /** A próxima foto na Página sai, mas a resposta não chega (a Meta responde 503 depois de publicar). */
  perderARespostaDaFoto = false;
  /**
   * Os números de cada post (A6, Z7, parte c), pelo id do objeto (a mídia do Instagram ou o post da Página): a lista
   * `data` da resposta de `GET /{id}/insights`, como a Meta a manda. Sem números, a lista vem vazia (não zero).
   */
  readonly numeros = new Map<string, unknown[]>();
  /** A autorização sem a permissão de ler os números do Instagram (`instagram_manage_insights`): a recusa (#10). */
  semPermissaoDeNumeros = false;
  /** A autorização sem a permissão de apagar no Instagram (`instagram_manage_contents`): a recusa (#10). */
  semPermissaoDeApagar = false;
  /** Os vídeos das Páginas (A6, Z10): o Reels e o vídeo comum. */
  readonly videosNaPagina: VideoNaPagina[] = [];
  /** Como o vídeo da Página fica logo depois do fim do Reels, ou da chegada do vídeo comum. */
  videoDaPaginaAoTerminar: 'processando' | 'publicado' | 'erro' = 'publicado';
  /** O próximo vídeo comum na Página nasce, mas a resposta não chega (a Meta responde 503 depois de criar). */
  perderARespostaDoVideo = false;
  /** O que a Página responde ao fim do Reels (um código de recusa do vídeo, como o 1363040 da proporção). */
  recusaDoReels: { codigo: number; mensagem: string } | null = null;
  /** Os Stories publicados (A6, Z13): os do Instagram e os das Páginas, o mais novo primeiro. */
  readonly stories: StoryNaMeta[] = [];
  /** As fotos enviadas à Página sem post (`published=false`), à espera do Story. */
  readonly fotosSemPost: FotoNaPagina[] = [];
  /** O próximo Story da Página sai, mas a resposta não chega (a Meta responde 503 depois de publicar). */
  perderARespostaDoStory = false;
  /** Os comentários de cada mídia do Instagram, do mais novo para o mais velho (A6, Z11). */
  readonly comentariosNoInstagram = new Map<string, ComentarioNoInstagram[]>();
  /** A autorização sem a permissão de ler os comentários do Instagram (`instagram_manage_comments`): a recusa (#10). */
  semPermissaoDeComentarios = false;
  /** Os posts das Páginas (A6, Z11), do mais novo para o mais velho. */
  readonly postsNaPagina: PostNaPagina[] = [];
  /** Os comentários de cada post da Página, do mais velho para o mais novo (a ordem do `filter=stream`). */
  readonly comentariosNaPagina = new Map<string, ComentarioNaPagina[]>();
  /** A Página manda o `from` de quem comentou (o pior caso, V125: não manda). */
  paginaDevolveQuemComentou = false;
  /** A próxima resposta a um comentário sai, mas a volta não chega (a Meta responde 503 depois de criar; Z11, parte 2). */
  perderARespostaDoComentario = false;
  /** A autorização sem a permissão de moderar os comentários (responder, ocultar e apagar): a recusa (#10). */
  semPermissaoDeModerar = false;
  /** As conversas do Direct de cada Página (A6, Z12), a mais nova primeiro na lista que a Meta devolve. */
  readonly conversasDoDirect: ConversaNoDirect[] = [];
  /** A autorização sem a permissão de mensagens (`instagram_manage_messages`): a recusa (#10). */
  semPermissaoDeMensagens = false;
  /** O app dono das conversas (o Conversation Routing): nulo = nenhum dono informado (a Meta não diz). */
  donoDasConversas: string | null = null;
  /** A próxima mensagem sai, mas a resposta não chega (a Meta responde 503 depois de mandar; Z12, parte 2). */
  perderARespostaDaMensagem = false;
  /** O @ da conta do Instagram dos testes (o `empresaComCanais` liga a conta como `@casabrasa`). */
  usuarioDaConta = 'casabrasa';
  base = '';
  /** O endereço do envio do vídeo à Página (o `rupload` de mentira, no mesmo servidor). */
  rupload = '';
  private servidor: Server | null = null;

  async ligar(): Promise<void> {
    const servidor = createServer((req, res) => {
      const pedacos: Buffer[] = [];
      req.on('data', (p: Buffer) => pedacos.push(p));
      req.on('end', () => {
        const r = this.responder(req, Buffer.concat(pedacos).toString('utf8'));
        if (res.destroyed) return;
        res.writeHead(r.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(r.corpo));
      });
    });
    await new Promise<void>((ok) => servidor.listen(0, '127.0.0.1', ok));
    this.servidor = servidor;
    this.base = `http://127.0.0.1:${(servidor.address() as AddressInfo).port}/graph`;
    this.rupload = `http://127.0.0.1:${(servidor.address() as AddressInfo).port}/rupload`;
  }

  async desligar(): Promise<void> {
    const servidor = this.servidor;
    if (servidor) await new Promise((ok) => servidor.close(ok));
  }

  /** Volta ao normal entre os testes. */
  normalizar(): void {
    this.situacaoAoCriar = 'FINISHED';
    this.cota = { usados: 0, total: 50 };
    this.falhas.clear();
    this.perderARespostaDaPublicacao = false;
    this.perderARespostaDaFoto = false;
    this.semPermissaoDeNumeros = false;
    this.semPermissaoDeApagar = false;
    this.videoDaPaginaAoTerminar = 'publicado';
    this.perderARespostaDoVideo = false;
    this.recusaDoReels = null;
    this.perderARespostaDoStory = false;
    this.semPermissaoDeComentarios = false;
    this.paginaDevolveQuemComentou = false;
    this.perderARespostaDoComentario = false;
    this.semPermissaoDeModerar = false;
    this.semPermissaoDeMensagens = false;
    this.donoDasConversas = null;
    this.perderARespostaDaMensagem = false;
    this.chamadas.length = 0;
    this.defeitos.length = 0;
  }

  /** Os vídeos publicados (ou não) numa Página. */
  videosDe(pagina: string): VideoNaPagina[] {
    return this.videosNaPagina.filter((v) => v.pagina === pagina);
  }

  /**
   * Um post que a loja publicou direto no Instagram, fora do Liame ("Do seu Instagram", A6, Z10, parte 5): entra na
   * lista da conta como o mais novo, com o id e o endereço da Meta. Devolve o id.
   */
  publicadoForaDoLiame(ig: string, o: PostForaDoLiame = {}): string {
    const conteiner: Conteiner = { id: idDaMeta(), ig, caption: o.caption ?? '', imagem: null, endereco: '', status: 'PUBLISHED', tipo: o.media_product_type === 'REELS' ? 'REELS' : 'foto' };
    this.conteineres.set(conteiner.id, conteiner);
    const { horas, ...campos } = o;
    const p: PostNoInstagram = {
      id: idDaMeta(),
      caption: o.caption ?? '',
      timestamp: dataDoInstagram(new Date(Date.now() - (horas ?? 1) * 3_600_000)),
      permalink: `https://www.instagram.com/p/${randomBytes(5).toString('hex')}/`,
      conteiner: conteiner.id,
      imagem: null,
      ...campos,
    };
    // A lista vem do mais novo ao mais antigo.
    const i = this.posts.findIndex((x) => x.timestamp < p.timestamp);
    if (i < 0) this.posts.push(p);
    else this.posts.splice(i, 0, p);
    return p.id;
  }

  /** Um comentário de outra pessoa (ou da marca, com o `deId` da conta) numa mídia do Instagram, o mais novo. Devolve o id. */
  comentouNoInstagram(media: string, o: { texto: string; usuario?: string; deId?: string; horas?: number; curtidas?: number; oculto?: boolean }): string {
    const c: ComentarioNoInstagram = {
      id: idDaMeta(),
      text: o.texto,
      timestamp: dataDoInstagram(new Date(Date.now() - (o.horas ?? 1) * 3_600_000)),
      username: o.usuario ?? `cliente${randomBytes(3).toString('hex')}`,
      deId: o.deId ?? idDaMeta(),
      like_count: o.curtidas ?? 0,
      hidden: o.oculto ?? false,
      respostas: [],
    };
    const lista = this.comentariosNoInstagram.get(media) ?? [];
    lista.unshift(c);
    this.comentariosNoInstagram.set(media, lista);
    return c.id;
  }

  /** Uma resposta a um comentário do Instagram (a mais nova fica por último). Devolve o id. */
  respondeuNoInstagram(media: string, comentario: string, o: { texto: string; usuario: string; deId: string }): string {
    const pai = (this.comentariosNoInstagram.get(media) ?? []).find((c) => c.id === comentario);
    if (!pai) throw new Error('comentário do Instagram de mentira não encontrado');
    const r: ComentarioNoInstagram = { id: idDaMeta(), text: o.texto, timestamp: dataDoInstagram(new Date()), username: o.usuario, deId: o.deId, like_count: 0, hidden: false, respostas: [] };
    pai.respostas.push(r);
    return r.id;
  }

  /** Um post publicado (ou agendado) numa Página, há `horas`. Devolve o id (`{página}_{post}`). */
  postouNaPagina(pagina: string, o: { message?: string; horas?: number; publicado?: boolean } = {}): string {
    const id = `${pagina}_${idDaMeta()}`;
    const p: PostNaPagina = {
      id,
      pagina,
      message: o.message ?? '',
      created_time: dataDoInstagram(new Date(Date.now() - (o.horas ?? 1) * 3_600_000)),
      permalink_url: `https://www.facebook.com/${pagina}/posts/${id.split('_')[1]}`,
      full_picture: `https://scontent.xx.fbcdn.net/v/${id}.jpg?oe=teste`,
      is_published: o.publicado ?? true,
    };
    const i = this.postsNaPagina.findIndex((x) => x.created_time < p.created_time);
    if (i < 0) this.postsNaPagina.push(p);
    else this.postsNaPagina.splice(i, 0, p);
    return id;
  }

  /** Um comentário (ou, com `pai`, uma resposta) num post da Página. Devolve o id (`{post}_{comentário}`). */
  comentouNaPagina(post: string, o: { message: string; deId?: string; nome?: string; pai?: string; oculto?: boolean }): string {
    const c: ComentarioNaPagina = {
      id: `${post.split('_')[1]}_${idDaMeta()}`,
      message: o.message,
      created_time: dataDoInstagram(new Date()),
      deId: o.deId ?? idDaMeta(),
      nome: o.nome ?? 'Cliente da Página',
      like_count: 0,
      comment_count: 0,
      is_hidden: o.oculto ?? false,
      parent: o.pai ?? null,
    };
    const lista = this.comentariosNaPagina.get(post) ?? [];
    lista.push(c);
    if (c.parent) {
      const pai = lista.find((x) => x.id === c.parent);
      if (pai) pai.comment_count += 1;
    }
    this.comentariosNaPagina.set(post, lista);
    return c.id;
  }

  /**
   * Uma mensagem da pessoa no Direct da conta ligada à Página (A6, Z12): na conversa dela (nova, se não houver), há
   * `minutos` minutos. Devolve o id da conversa.
   */
  escreveuNoDirect(pagina: string, o: { usuario: string; texto?: string; deId?: string; minutos?: number; anexo?: string; story?: 'reply_to' | 'mention' }): string {
    const quando = new Date(Date.now() - (o.minutos ?? 0) * 60_000).toISOString();
    let c = this.conversasDoDirect.find((x) => x.pagina === pagina && x.canal === 'instagram' && x.pessoa.username === o.usuario);
    if (!c) {
      c = { id: `aWdf${randomBytes(9).toString('hex')}`, pagina, canal: 'instagram', updated_time: quando, pessoa: { id: o.deId ?? idDaMeta(), username: o.usuario }, mensagens: [] };
      this.conversasDoDirect.push(c);
    }
    c.mensagens.push({ id: `mid.${randomBytes(9).toString('hex')}`, created_time: quando, daMarca: false, texto: o.texto ?? '', ...(o.anexo ? { anexo: o.anexo } : {}), ...(o.story ? { story: o.story } : {}) });
    c.updated_time = quando;
    return c.id;
  }

  /**
   * Uma mensagem da pessoa no Messenger da Página (A6, Z14): na conversa dela (nova, se não houver), há `minutos`
   * minutos. A pessoa vem com o nome do Facebook e o PSID, sem @. Devolve o id da conversa.
   */
  escreveuNoMessenger(pagina: string, o: { nome: string; texto?: string; deId?: string; minutos?: number; anexo?: string }): string {
    const quando = new Date(Date.now() - (o.minutos ?? 0) * 60_000).toISOString();
    let c = this.conversasDoDirect.find((x) => x.pagina === pagina && x.canal === 'messenger' && x.pessoa.name === o.nome);
    if (!c) {
      c = { id: `t_${randomBytes(9).toString('hex')}`, pagina, canal: 'messenger', updated_time: quando, pessoa: { id: o.deId ?? idDaMeta(), name: o.nome }, mensagens: [] };
      this.conversasDoDirect.push(c);
    }
    c.mensagens.push({ id: `m_${randomBytes(9).toString('hex')}`, created_time: quando, daMarca: false, texto: o.texto ?? '', ...(o.anexo ? { anexo: o.anexo } : {}) });
    c.updated_time = quando;
    return c.id;
  }

  /** A resposta da marca numa conversa do Direct (pelo app do Instagram ou pelo Liame), há `minutos` minutos. */
  marcaNoDirect(conversa: string, texto: string, minutos = 0): void {
    const c = this.conversasDoDirect.find((x) => x.id === conversa);
    if (!c) throw new Error(`conversa ${conversa} não existe`);
    const quando = new Date(Date.now() - minutos * 60_000).toISOString();
    c.mensagens.push({ id: `mid.${randomBytes(9).toString('hex')}`, created_time: quando, daMarca: true, texto });
    c.updated_time = quando;
  }

  /**
   * A pessoa apaga uma mensagem que mandou (o "cancelar envio" do Instagram): ela deixa de vir na conversa. A hora da
   * mudança da conversa anda (suposição do teste: a documentação lida em 11/11/2026 não diz; o primeiro uso real confere).
   * Sem o texto, apaga a última da pessoa. Devolve quantas mensagens ficaram.
   */
  apagouNoDirect(conversa: string, texto?: string): number {
    const c = this.conversasDoDirect.find((x) => x.id === conversa);
    if (!c) throw new Error(`conversa ${conversa} não existe`);
    const alvo = texto === undefined ? [...c.mensagens].reverse().find((m) => !m.daMarca) : c.mensagens.find((m) => !m.daMarca && m.texto === texto);
    if (!alvo) throw new Error(`a mensagem da pessoa não existe na conversa ${conversa}`);
    c.mensagens = c.mensagens.filter((m) => m !== alvo);
    c.updated_time = new Date().toISOString();
    return c.mensagens.length;
  }

  /**
   * O Direct (A6, Z12), pela documentação lida em 11/11/2026: as conversas da conta do Instagram ligada à Página
   * (`GET /{page-id}/conversations?platform=instagram`, o token dela, de quem tem a tarefa MODERATE) e as mensagens de
   * uma conversa (`GET /{conversation-id}?fields=messages{…}`, só as 20 mais novas, a mais nova primeiro). Nulo para o
   * que não é do Direct.
   */
  private doDirect(metodo: string, id: string, aresta: string | undefined, params: Record<string, string>, corpo: Record<string, unknown> | null): Resposta | null {
    // A marca na conversa: a conta do Instagram no Direct; a própria Página no Messenger (com o nome dela).
    const daMarca = (pagina: string, canal: 'instagram' | 'messenger' = 'instagram') =>
      canal === 'messenger' ? { id: pagina, name: 'Página da marca' } : { id: `ig-${pagina}`, username: this.usuarioDaConta };
    // Mandar (Z12, parte 2): `POST /{page-id}/messages` com recipient.id e message.text, a tarefa de mensagens na Página,
    // só dentro da janela de 24 horas (fora dela, 10/2534022) e só o app dono da conversa (com o dono, 100/2534037).
    if (metodo === 'POST' && aresta === 'messages' && this.paginas.has(id)) {
      const tarefas = this.paginas.get(id) ?? [];
      if (!tarefas.includes('MESSAGING') && !tarefas.includes('MODERATE')) return erro(403, 200, 'Requires the MESSAGING task on the Page');
      if (this.semPermissaoDeMensagens) return erro(403, 10, '(#10) Application does not have permission for this action');
      const para = String(objetoDe(corpo?.recipient).id ?? '');
      const texto = String(objetoDe(corpo?.message).text ?? '');
      const c = this.conversasDoDirect.find((x) => x.pagina === id && x.pessoa.id === para);
      if (!c) return erro(400, 100, '(#100) No matching user found', 2018001);
      if (Buffer.byteLength(texto, 'utf8') > 1000) return erro(400, 100, '(#100) Message text is too long');
      if (this.donoDasConversas && this.donoDasConversas !== 'liame') return erro(400, 100, '(#100) Another app is controlling this thread', 2534037);
      const ultima = [...c.mensagens].reverse().find((m) => !m.daMarca);
      if (!ultima || Date.parse(ultima.created_time) + 24 * 3_600_000 <= Date.now()) return erro(400, 10, '(#10) This message is sent outside of allowed window.', 2534022);
      const mid = `mid.${randomBytes(9).toString('hex')}`;
      c.mensagens.push({ id: mid, created_time: new Date().toISOString(), daMarca: true, texto });
      c.updated_time = new Date().toISOString();
      if (this.perderARespostaDaMensagem) {
        this.perderARespostaDaMensagem = false;
        return erro(503, 2, 'Service temporarily unavailable');
      }
      return { status: 200, corpo: { recipient_id: para, message_id: mid } };
    }
    if (metodo !== 'GET') return null;
    // O dono da conversa (o Conversation Routing): o app dono, quando há; sem dono, a lista vazia.
    if (aresta === 'thread_owner' && this.paginas.has(id)) {
      return { status: 200, corpo: { data: this.donoDasConversas ? [{ thread_owner: { app_id: this.donoDasConversas === 'liame' ? APP_DA_META : this.donoDasConversas } }] : [] } };
    }
    if (aresta === 'conversations' && this.paginas.has(id)) {
      // A plataforma pedida (`instagram` ou `messenger`; a documentação lida em 11/11/2026) e a tarefa MESSAGING na Página
      // para as duas (D-A6-124).
      if (params.platform !== 'instagram' && params.platform !== 'messenger') return erro(400, 100, '(#100) The parameter platform must be instagram or messenger');
      if (!(this.paginas.get(id) ?? []).includes('MESSAGING')) return erro(403, 200, 'Requires the MESSAGING task on the Page');
      if (this.semPermissaoDeMensagens) return erro(403, 10, '(#10) Application does not have permission for this action');
      const lista = this.conversasDoDirect.filter((c) => c.pagina === id && c.canal === params.platform).sort((a, b) => b.updated_time.localeCompare(a.updated_time));
      return {
        status: 200,
        corpo: {
          data: lista.slice(0, Number(params.limit ?? 25)).map((c) => ({ id: c.id, updated_time: c.updated_time, participants: { data: [daMarca(c.pagina, c.canal), c.pessoa] } })),
          paging: {},
        },
      };
    }
    const c = aresta ? undefined : this.conversasDoDirect.find((x) => x.id === id);
    if (!c) return null;
    if (this.semPermissaoDeMensagens) return erro(403, 10, '(#10) Application does not have permission for this action');
    if (!(params.fields ?? '').includes('messages')) return { status: 200, corpo: { id: c.id } };
    const mensagens = [...c.mensagens].reverse().slice(0, 20).map((m) => ({
      id: m.id,
      created_time: m.created_time,
      from: m.daMarca ? daMarca(c.pagina, c.canal) : c.pessoa,
      to: { data: [m.daMarca ? c.pessoa : daMarca(c.pagina, c.canal)] },
      ...(m.texto ? { message: m.texto } : {}),
      ...(m.anexo ? { attachments: { data: [{ type: m.anexo }] } } : {}),
      ...(m.story ? { story: { [m.story]: { link: 'https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=1', id: '1' } } } : {}),
    }));
    return { status: 200, corpo: { id: c.id, messages: { data: mensagens, paging: {} } } };
  }

  /** Um comentário do Instagram como a Meta o devolve. */
  private comentarioDoInstagram(c: ComentarioNoInstagram, comRespostas: boolean): Record<string, unknown> {
    const base: Record<string, unknown> = { id: c.id, text: c.text, timestamp: c.timestamp, username: c.username, from: { id: c.deId, username: c.username }, like_count: c.like_count, hidden: c.hidden };
    if (!comRespostas || c.respostas.length === 0) return base;
    const limite = 50;
    const respostas = c.respostas.slice(0, limite).map((r) => this.comentarioDoInstagram(r, false));
    return { ...base, replies: { data: respostas, ...(c.respostas.length > limite ? { paging: { cursors: { after: String(limite) }, next: 'https://graph.facebook.com/proxima' } } : {}) } };
  }

  /** Onde está um comentário do Instagram (o de primeiro nível ou a resposta): a mídia, a lista e o pai. */
  private noInstagram(id: string): { media: string; lista: ComentarioNoInstagram[]; c: ComentarioNoInstagram; pai: ComentarioNoInstagram | null } | null {
    for (const [media, lista] of this.comentariosNoInstagram) {
      for (const c of lista) {
        if (c.id === id) return { media, lista, c, pai: null };
        const r = c.respostas.find((x) => x.id === id);
        if (r) return { media, lista: c.respostas, c: r, pai: c };
      }
    }
    return null;
  }

  /** Onde está um comentário da Página: o post e a lista do post. */
  private naPagina(id: string): { post: string; lista: ComentarioNaPagina[]; c: ComentarioNaPagina } | null {
    for (const [post, lista] of this.comentariosNaPagina) {
      const c = lista.find((x) => x.id === id);
      if (c) return { post, lista, c };
    }
    return null;
  }

  /** A conta do Instagram dona de uma mídia (pelo contêiner do post). */
  private donaDaMidia(media: string): string | null {
    const p = this.posts.find((x) => x.id === media);
    return p ? (this.conteineres.get(p.conteiner)?.ig ?? null) : null;
  }

  /**
   * Um comentário sozinho (A6, Z11, parte 2), pelas referências lidas em 07/11/2026: ler (`GET /{id}`, com as respostas
   * pelo campo `replies` no Instagram e `comments` na Página), responder (`POST /{id}/replies` no Instagram, só ao de
   * primeiro nível e nunca ao oculto; `POST /{id}/comments` na Página), ocultar e mostrar (`POST /{id}` com `hide` no
   * Instagram e `is_hidden` na Página) e apagar (`DELETE /{id}`). A Página pede a tarefa MODERATE; o Instagram, a
   * permissão de comentários. Nulo para o que não é um comentário conhecido.
   */
  private umComentario(metodo: string, id: string, aresta: string | undefined, params: Record<string, string>, corpo: Record<string, unknown> | null): Resposta | null {
    const ig = this.noInstagram(id);
    const pg = ig ? null : this.naPagina(id);
    if (!ig && !pg) return null;
    if (aresta && aresta !== 'replies' && aresta !== 'comments') return null;
    const moderar = metodo !== 'GET';
    if (ig) {
      if (this.semPermissaoDeComentarios || (moderar && this.semPermissaoDeModerar)) return erro(403, 10, '(#10) Application does not have permission for this action');
      const c = ig.c;
      if (metodo === 'GET' && !aresta) {
        const comRespostas = (params.fields ?? '').includes('replies');
        return {
          status: 200,
          corpo: {
            ...this.comentarioDoInstagram(c, comRespostas),
            ...(ig.pai ? { parent_id: ig.pai.id } : {}),
          },
        };
      }
      if (metodo === 'POST' && aresta === 'replies') {
        if (ig.pai) return erro(400, 100, '(#100) You can only reply to top-level comments');
        if (c.hidden) return erro(400, 100, '(#100) Cannot reply to a hidden comment');
        const dona = this.donaDaMidia(ig.media) ?? '';
        const r: ComentarioNoInstagram = { id: idDaMeta(), text: String(corpo?.message ?? ''), timestamp: dataDoInstagram(new Date()), username: this.usuarioDaConta, deId: dona, like_count: 0, hidden: false, respostas: [] };
        c.respostas.push(r);
        if (this.perderARespostaDoComentario) {
          this.perderARespostaDoComentario = false;
          return erro(503, 2, 'Service temporarily unavailable');
        }
        return { status: 200, corpo: { id: r.id } };
      }
      if (metodo === 'POST' && !aresta) {
        if (params.hide !== 'true' && params.hide !== 'false') return erro(400, 100, '(#100) The parameter hide is required');
        c.hidden = params.hide === 'true';
        return { status: 200, corpo: { success: true } };
      }
      if (metodo === 'DELETE' && !aresta) {
        ig.lista.splice(ig.lista.indexOf(c), 1);
        return { status: 200, corpo: { success: true } };
      }
      return erro(400, 100, `Unsupported ${metodo.toLowerCase()} request`);
    }
    const p = pg!;
    const dona = p.post.split('_')[0]!;
    if (!(this.paginas.get(dona) ?? []).includes('MODERATE')) return erro(403, 200, 'Requires the MODERATE task on the Page');
    const c = p.c;
    const daPagina = (x: ComentarioNaPagina) => x.deId === dona;
    const comoAMetaManda = (x: ComentarioNaPagina) => ({
      id: x.id,
      message: x.message,
      created_time: x.created_time,
      ...(daPagina(x) || this.paginaDevolveQuemComentou ? { from: { id: x.deId, name: x.nome } } : {}),
      is_hidden: x.is_hidden,
      ...(x.parent ? { parent: { id: x.parent } } : {}),
    });
    if (metodo === 'GET' && !aresta) {
      const comRespostas = (params.fields ?? '').includes('comments');
      const filhas = p.lista.filter((x) => x.parent === c.id).map(comoAMetaManda);
      return { status: 200, corpo: { ...comoAMetaManda(c), ...(comRespostas ? { comments: { data: filhas } } : {}) } };
    }
    if (metodo === 'POST' && aresta === 'comments') {
      const id2 = this.comentouNaPagina(p.post, { message: String(corpo?.message ?? ''), deId: dona, nome: 'Casa Brasa', pai: c.id });
      if (this.perderARespostaDoComentario) {
        this.perderARespostaDoComentario = false;
        return erro(503, 2, 'Service temporarily unavailable');
      }
      return { status: 200, corpo: { id: id2 } };
    }
    if (metodo === 'POST' && !aresta) {
      const valor = corpo?.is_hidden;
      if (valor !== 'true' && valor !== 'false' && valor !== true && valor !== false) return erro(400, 100, '(#100) The parameter is_hidden is required');
      c.is_hidden = valor === true || valor === 'true';
      return { status: 200, corpo: { success: true } };
    }
    if (metodo === 'DELETE' && !aresta) {
      p.lista.splice(p.lista.indexOf(c), 1);
      return { status: 200, corpo: { success: true } };
    }
    return erro(400, 100, `Unsupported ${metodo.toLowerCase()} request`);
  }

  /**
   * Os comentários (A6, Z11): a lista dos do Instagram (o token da autorização), os posts da Página e os comentários do post
   * da Página (o token dela). Nulo para o que não é dos comentários.
   */
  private dosComentarios(metodo: string, id: string, aresta: string | undefined, params: Record<string, string>): Resposta | null {
    if (metodo !== 'GET') return null;
    const pagina = (params: Record<string, string>, total: number, maximo: number) => {
      const inicio = Number(params.after ?? 0);
      const quantos = Math.min(Number(params.limit ?? 25), maximo);
      return { inicio, fim: inicio + quantos, paging: inicio + quantos < total ? { cursors: { after: String(inicio + quantos) }, next: 'https://graph.facebook.com/proxima' } : {} };
    };
    if (aresta === 'posts' && this.paginas.has(id)) {
      const tarefas = this.paginas.get(id)!;
      if (!['CREATE_CONTENT', 'MANAGE', 'MODERATE'].some((t) => tarefas.includes(t))) return erro(403, 200, 'Requires the CREATE_CONTENT, MANAGE or MODERATE task on the Page');
      const lista = this.postsNaPagina.filter((p) => p.pagina === id);
      const p = pagina(params, lista.length, 100);
      return {
        status: 200,
        corpo: {
          data: lista.slice(p.inicio, p.fim).map((x) => ({ id: x.id, created_time: x.created_time, message: x.message, permalink_url: x.permalink_url, full_picture: x.full_picture, is_published: x.is_published })),
          paging: p.paging,
        },
      };
    }
    if (aresta !== 'comments') return null;
    if (id.includes('_')) {
      const dona = id.split('_')[0]!;
      if (!(this.paginas.get(dona) ?? []).includes('MODERATE')) return erro(403, 200, 'Requires the MODERATE task on the Page');
      const todos = this.comentariosNaPagina.get(id) ?? [];
      const lista = params.filter === 'stream' ? todos : todos.filter((c) => !c.parent);
      const p = pagina(params, lista.length, 100);
      const daPagina = (c: ComentarioNaPagina) => c.deId === dona;
      return {
        status: 200,
        corpo: {
          data: lista.slice(p.inicio, p.fim).map((c) => ({
            id: c.id,
            message: c.message,
            created_time: c.created_time,
            ...(daPagina(c) || this.paginaDevolveQuemComentou ? { from: { id: c.deId, name: c.nome } } : {}),
            like_count: c.like_count,
            comment_count: c.comment_count,
            is_hidden: c.is_hidden,
            ...(c.parent ? { parent: { id: c.parent } } : {}),
          })),
          paging: p.paging,
        },
      };
    }
    if (this.semPermissaoDeComentarios) return erro(403, 10, '(#10) Application does not have permission for this action');
    const lista = this.comentariosNoInstagram.get(id);
    if (!lista && !this.posts.some((x) => x.id === id)) return erro(400, 100, `Unsupported get request. Object with ID '${id}' does not exist`, 33);
    const todos = lista ?? [];
    const p = pagina(params, todos.length, 50);
    const comRespostas = (params.fields ?? '').includes('replies');
    return { status: 200, corpo: { data: todos.slice(p.inicio, p.fim).map((c) => this.comentarioDoInstagram(c, comRespostas)), paging: p.paging } };
  }

  /** O post como a lista da conta o descreve, só com os campos pedidos (`fields`). */
  private naLista(p: PostNoInstagram, campos: string[]): Record<string, unknown> {
    const tipo = p.media_type ?? 'IMAGE';
    const completo: Record<string, unknown> = {
      id: p.id,
      caption: p.caption,
      timestamp: p.timestamp,
      permalink: p.permalink,
      media_type: tipo,
      media_product_type: p.media_product_type ?? 'FEED',
      // O arquivo: o que o post diz; sem nada, um endereço da Meta. Nulo = a Meta não manda o campo.
      ...(p.media_url === null ? {} : { media_url: p.media_url ?? `https://scontent.cdninstagram.com/v/${p.id}.jpg?oe=teste` }),
      ...(tipo === 'VIDEO' && p.thumbnail_url !== null ? { thumbnail_url: p.thumbnail_url ?? `https://scontent.cdninstagram.com/v/${p.id}-capa.jpg?oe=teste` } : {}),
      ...(p.like_count === null ? {} : { like_count: p.like_count ?? 0 }),
      comments_count: p.comments_count ?? 0,
    };
    return Object.fromEntries(campos.filter((c) => c in completo).map((c) => [c, completo[c]]));
  }

  /** As chamadas a um caminho final (`media`, `media_publish`, `content_publishing_limit`, `status_code` para a situação). */
  contar(qual: string, metodo?: string): number {
    return this.chamadas.filter((c) => (metodo ? c.metodo === metodo : true) && (qual === 'status_code' ? c.params.fields === 'status_code' : c.caminho.endsWith(`/${qual}`))).length;
  }

  /** Os posts publicados numa conta do Instagram. */
  postsDe(ig: string): PostNoInstagram[] {
    return this.posts.filter((p) => this.conteineres.get(p.conteiner)?.ig === ig);
  }

  /** As fotos publicadas numa Página. */
  fotosDe(pagina: string): FotoNaPagina[] {
    return this.fotosNaPagina.filter((f) => f.pagina === pagina);
  }

  /** O envio do arquivo do Reels: o token da Página (`OAuth`), o vídeo da sessão que começou, e a Meta busca o `file_url`. */
  private noRupload(metodo: string, caminho: string, cabecalhos: { authorization: string; file_url: string }): Resposta {
    const videoId = caminho.split('/').filter(Boolean).at(-1) ?? '';
    if (metodo !== 'POST') return erro(400, 100, 'Unsupported request');
    if (cabecalhos.authorization !== `OAuth ${TOKEN_DA_PAGINA}`) return erro(401, 190, 'Invalid OAuth access token');
    const v = this.videosNaPagina.find((x) => x.id === videoId && (x.tipo === 'reels' || x.tipo === 'story'));
    if (!v || v.fase !== 'enviando') return erro(400, 100, 'Invalid video_id');
    const arquivo = this.buscarImagem(cabecalhos.file_url);
    if (!arquivo) return erro(400, 6000, 'There was a problem uploading your video file');
    v.arquivo = arquivo;
    return { status: 200, corpo: { success: true } };
  }

  /**
   * O vídeo na Página (o "Reels Publishing" e a referência de `/{page-id}/videos`, 06/11/2026), pelo token da Página de
   * quem tem a tarefa de publicar: o Reels (`video_reels`, começo e fim), o vídeo comum (`videos`, com `file_url`), a lista
   * dos vídeos, a situação e o endereço de um vídeo, e apagar. Nulo para o que não é do vídeo.
   */
  private videoNaPagina(metodo: string, id: string, aresta: string | undefined, params: Record<string, string>, corpo: Record<string, unknown> | null): Resposta | null {
    const tarefas = this.paginas.get(id);
    // O Story da Página (A6, Z13; o Page Stories API, lido em 11/11/2026).
    const doStory = tarefas ? this.storyNaPagina(metodo, id, aresta, params, corpo, tarefas) : null;
    if (doStory) return doStory;
    if (tarefas && aresta === 'video_reels' && metodo === 'POST') {
      if (!tarefas.includes('CREATE_CONTENT')) return erro(403, 200, 'Requires the CREATE_CONTENT task on the Page');
      if (corpo?.upload_phase === 'start') {
        const v: VideoNaPagina = { id: idDaMeta(), pagina: id, tipo: 'reels', description: '', created_time: dataDoInstagram(new Date()), arquivo: null, fase: 'enviando' };
        this.videosNaPagina.unshift(v);
        return { status: 200, corpo: { video_id: v.id, upload_url: `${this.rupload}/video-upload/v26.0/${v.id}` } };
      }
      if (corpo?.upload_phase === 'finish') {
        const v = this.videosNaPagina.find((x) => x.id === String(corpo.video_id ?? '') && x.pagina === id);
        if (!v || !v.arquivo) return erro(400, 100, 'The video was not uploaded');
        if (this.recusaDoReels) return erro(400, this.recusaDoReels.codigo, this.recusaDoReels.mensagem);
        v.description = String(corpo.description ?? '');
        if (corpo.video_state === 'PUBLISHED') v.fase = this.videoDaPaginaAoTerminar;
        return { status: 200, corpo: { success: true } };
      }
      return erro(400, 100, '(#100) The parameter upload_phase is required');
    }
    if (tarefas && aresta === 'videos') {
      if (metodo === 'GET') {
        return { status: 200, corpo: { data: this.videosDe(id).slice(0, Number(params.limit ?? 25)).map((v) => ({ id: v.id, description: v.description, created_time: v.created_time })) } };
      }
      if (!tarefas.includes('CREATE_CONTENT')) return erro(403, 200, 'Requires the CREATE_CONTENT task on the Page');
      const arquivo = this.buscarImagem(typeof corpo?.file_url === 'string' ? corpo.file_url : '');
      if (!arquivo) return erro(400, 6000, 'There was a problem uploading your video file');
      const v: VideoNaPagina = { id: idDaMeta(), pagina: id, tipo: 'video', description: String(corpo?.description ?? ''), created_time: dataDoInstagram(new Date()), arquivo, fase: this.videoDaPaginaAoTerminar };
      this.videosNaPagina.unshift(v);
      if (this.perderARespostaDoVideo) {
        this.perderARespostaDoVideo = false;
        return erro(503, 2, 'Service temporarily unavailable');
      }
      return { status: 200, corpo: { id: v.id } };
    }
    const v = !aresta ? this.videosNaPagina.find((x) => x.id === id) : undefined;
    if (!v) return null;
    if (metodo === 'GET' && params.fields === 'status') return { status: 200, corpo: { id: v.id, status: situacaoDoVideo(v.fase) } };
    // O endereço do vídeo vem sem o domínio (o pior caso: a referência não diz).
    if (metodo === 'GET' && params.fields === 'permalink_url') return { status: 200, corpo: { id: v.id, permalink_url: `/${v.pagina}/videos/${v.id}/` } };
    if (metodo === 'DELETE') {
      this.videosNaPagina.splice(this.videosNaPagina.indexOf(v), 1);
      return { status: 200, corpo: { success: true } };
    }
    return null;
  }

  /**
   * O Story da Página (o Page Stories API): a foto sem post vira Story por `photo_stories` (`photo_id`); o vídeo, por
   * `video_stories` em duas fases (o começo devolve o id e o endereço do envio; o fim, depois do envio pelo `rupload`,
   * publica); a lista `GET /{page-id}/stories`. Pede o token da Página de quem tem a tarefa de publicar. Nulo para o resto.
   */
  private storyNaPagina(metodo: string, id: string, aresta: string | undefined, params: Record<string, string>, corpo: Record<string, unknown> | null, tarefas: string[]): Resposta | null {
    if (aresta === 'stories' && metodo === 'GET') {
      const lista = this.stories.filter((s) => s.onde === id).slice(0, Number(params.limit ?? 25));
      return { status: 200, corpo: { data: lista.map((s) => ({ post_id: s.post_id, status: 'PUBLISHED', creation_time: s.creation_time, media_type: s.media_type, media_id: s.media_id, url: s.url })) } };
    }
    if (metodo !== 'POST' || (aresta !== 'photo_stories' && aresta !== 'video_stories')) return null;
    if (!tarefas.includes('CREATE_CONTENT')) return erro(403, 200, 'Requires the CREATE_CONTENT task on the Page');
    const publicar = (mediaId: string, tipo: 'photo' | 'video', imagem: Buffer | null): Resposta => {
      const postId = `${id}_${idDaMeta()}`;
      this.stories.unshift({ id: postId, onde: id, post_id: postId, media_id: mediaId, media_type: tipo, creation_time: dataDoInstagram(new Date()), url: `https://www.facebook.com/stories/${id}/${postId.split('_')[1]}/`, imagem });
      if (this.perderARespostaDoStory) {
        this.perderARespostaDoStory = false;
        return erro(503, 2, 'Service temporarily unavailable');
      }
      return { status: 200, corpo: { success: true, post_id: postId } };
    };
    if (aresta === 'photo_stories') {
      const foto = this.fotosSemPost.find((f) => f.id === String(corpo?.photo_id ?? '') && f.pagina === id);
      if (!foto) return erro(400, 100, '(#100) Invalid photo_id');
      // A mídia de um Story já publicado não se reaproveita (a página da Meta).
      if (this.stories.some((s) => s.media_id === foto.id)) return erro(400, 100, '(#100) Media used in a previously published post cannot be reused');
      return publicar(foto.id, 'photo', foto.imagem);
    }
    if (corpo?.upload_phase === 'start') {
      const v: VideoNaPagina = { id: idDaMeta(), pagina: id, tipo: 'story', description: '', created_time: dataDoInstagram(new Date()), arquivo: null, fase: 'enviando' };
      this.videosNaPagina.unshift(v);
      return { status: 200, corpo: { video_id: v.id, upload_url: `${this.rupload}/video-upload/v26.0/${v.id}` } };
    }
    if (corpo?.upload_phase === 'finish') {
      const v = this.videosNaPagina.find((x) => x.id === String(corpo.video_id ?? '') && x.pagina === id && x.tipo === 'story');
      if (!v || !v.arquivo) return erro(400, 100, 'The video was not uploaded');
      if (this.recusaDoReels) return erro(400, this.recusaDoReels.codigo, this.recusaDoReels.mensagem);
      v.fase = this.videoDaPaginaAoTerminar;
      return publicar(v.id, 'video', v.arquivo);
    }
    return erro(400, 100, '(#100) The parameter upload_phase is required');
  }

  private responder(req: IncomingMessage, texto: string): { status: number; corpo: unknown } {
    const url = new URL(req.url ?? '/', 'http://local');
    const params = Object.fromEntries(url.searchParams.entries());
    let corpo: Record<string, unknown> | null = null;
    if (texto) {
      try {
        corpo = JSON.parse(texto) as Record<string, unknown>;
      } catch {
        return erro(400, 100, 'corpo que não é JSON');
      }
    }
    const metodo = req.method ?? 'GET';
    const cabecalhos = { authorization: String(req.headers.authorization ?? ''), file_url: String(req.headers.file_url ?? '') };
    this.chamadas.push({ metodo, caminho: url.pathname, params, corpo, cabecalhos });
    // O envio do vídeo do Reels à Página (A6, Z10; o "Reels Publishing", 06/11/2026): `POST rupload.facebook.com/video-upload/
    // {versão}/{video-id}`, com `Authorization: OAuth {token da Página}` e o endereço do arquivo em `file_url` (a Meta o busca).
    if (url.pathname.startsWith('/rupload/')) return this.noRupload(metodo, url.pathname, cabecalhos);
    const partes = url.pathname.split('/').filter(Boolean); // graph, v26.0, id, [aresta]
    const [, , id, aresta] = partes;
    // O token vai no cabeçalho, nunca na URL; a prova do segredo do app vai junto, calculada com o token. O que é da
    // Página (as fotos dela, o post e os vídeos) pede o token da Página; o resto, o da autorização.
    const daPagina =
      this.paginas.has(id ?? '') || (id ?? '').includes('_') || this.videosNaPagina.some((v) => v.id === id) || this.conversasDoDirect.some((c) => c.id === id);
    const esperado = daPagina ? TOKEN_DA_PAGINA : TOKEN_DO_INSTAGRAM;
    if (params.access_token) this.defeitos.push('token na URL');
    if (req.headers.authorization !== `Bearer ${esperado}`) return erro(401, 190, 'Invalid OAuth access token');
    if (params.appsecret_proof !== createHmac('sha256', SEGREDO_DO_APP).update(esperado).digest('hex')) this.defeitos.push('sem a prova do segredo do app');

    const final = aresta ?? (params.fields === 'status_code' ? 'status_code' : params.fields === 'status' ? 'status' : 'objeto');
    const falha = this.falhas.get(final)?.shift();
    if (falha) return falha;

    // O Direct (A6, Z12, parte 1).
    const doDirect = this.doDirect(metodo, id ?? '', aresta, params, corpo);
    if (doDirect) return doDirect;

    // Os comentários (A6, Z11, parte 1).
    const dosComentarios = this.umComentario(metodo, id ?? '', aresta, params, corpo) ?? this.dosComentarios(metodo, id ?? '', aresta, params);
    if (dosComentarios) return dosComentarios;

    // O vídeo na Página (A6, Z10, parte 3a).
    const doVideo = this.videoNaPagina(metodo, id ?? '', aresta, params, corpo);
    if (doVideo) return doVideo;

    // Apagar das redes (A6, Z5d, parte 6): o post da Página (o id com `_`, pelo token dela) ou a mídia do Instagram.
    if (metodo === 'DELETE' && !aresta) {
      const naoExiste = erro(400, 100, `Unsupported delete request. Object with ID '${id}' does not exist, cannot be loaded due to missing permissions, or does not support this operation`, 33);
      if ((id ?? '').includes('_')) {
        if (!(this.paginas.get(id!.split('_')[0]!) ?? []).includes('CREATE_CONTENT')) return erro(403, 200, 'Requires the CREATE_CONTENT task on the Page');
        const i = this.fotosNaPagina.findIndex((f) => f.page_story_id === id);
        if (i < 0) return naoExiste;
        this.fotosNaPagina.splice(i, 1);
        return { status: 200, corpo: { success: true } };
      }
      if (this.semPermissaoDeApagar) return erro(403, 10, '(#10) Application does not have permission for this action');
      const i = this.posts.findIndex((p) => p.id === id);
      // O Story do Instagram também sai pelo `DELETE /<IG_MEDIA_ID>` (a referência, lida em 11/11/2026: "Non-ad posts,
      // Stories, Reels and entire carousel albums are supported"). O da Página não tem como apagar (o Page Stories API).
      const s = i < 0 ? this.stories.findIndex((x) => x.id === id && !x.id.includes('_')) : -1;
      if (s >= 0) {
        this.stories.splice(s, 1);
        return { status: 200, corpo: { success: true, deleted_id: id } };
      }
      if (i < 0) return naoExiste;
      this.posts.splice(i, 1);
      return { status: 200, corpo: { success: true, deleted_id: id } };
    }

    // Os números do post (A6, Z7, parte c; base §2.2, conferida em 29/10/2026): o post da Página pede o token dela, de quem
    // tem a tarefa ANALYZE; a mídia do Instagram, a permissão de ler os números. O dado que falta volta como lista vazia.
    if (metodo === 'GET' && aresta === 'insights') {
      if (!params.metric) return erro(400, 100, '(#100) The parameter metric is required');
      if ((id ?? '').includes('_')) {
        const pagina = id!.split('_')[0]!;
        if (!(this.paginas.get(pagina) ?? []).includes('ANALYZE')) return erro(403, 200, 'Requires the ANALYZE task on the Page');
      } else if (this.semPermissaoDeNumeros) {
        return erro(403, 10, '(#10) Application does not have permission for this action');
      }
      return { status: 200, corpo: { data: this.numeros.get(id!) ?? [], paging: {} } };
    }
    if (metodo === 'GET' && id === 'me' && aresta === 'accounts') {
      return { status: 200, corpo: { data: [...this.paginas.entries()].map(([pagina, tasks]) => ({ id: pagina, access_token: TOKEN_DA_PAGINA, tasks })) } };
    }
    if (aresta === 'photos' && this.paginas.has(id!)) {
      const tarefas = this.paginas.get(id!)!;
      if (metodo === 'GET') {
        if (!tarefas.includes('MODERATE')) return erro(403, 200, 'Requires the MODERATE task on the Page');
        const lista = this.fotosDe(id!).slice(0, Number(params.limit ?? 25));
        return { status: 200, corpo: { data: lista.map((f) => ({ id: f.id, name: f.name, created_time: f.created_time, link: f.link, page_story_id: f.page_story_id })) } };
      }
      if (!tarefas.includes('CREATE_CONTENT')) return erro(403, 200, 'Requires the CREATE_CONTENT task on the Page');
      const imagem = this.buscarImagem(typeof corpo?.url === 'string' ? corpo.url : '');
      if (!imagem) return erro(400, 324, 'Missing or invalid image file');
      // A foto sem post (`published=false`; o Story da Página, A6, Z13): fica à parte, sem post e fora das fotos da Página.
      if (corpo?.published === false || corpo?.published === 'false') {
        const semPost: FotoNaPagina = { id: idDaMeta(), pagina: id!, name: '', created_time: dataDoInstagram(new Date()), link: '', page_story_id: '', imagem };
        this.fotosSemPost.unshift(semPost);
        return { status: 200, corpo: { id: semPost.id } };
      }
      const foto: FotoNaPagina = { id: idDaMeta(), pagina: id!, name: String(corpo?.caption ?? ''), created_time: dataDoInstagram(new Date()), link: '', page_story_id: `${id}_${idDaMeta()}`, imagem };
      foto.link = `https://www.facebook.com/photo/?fbid=${foto.id}`;
      this.fotosNaPagina.unshift(foto);
      if (this.perderARespostaDaFoto) {
        this.perderARespostaDaFoto = false;
        return erro(503, 2, 'Service temporarily unavailable');
      }
      return { status: 200, corpo: { id: foto.id, post_id: foto.page_story_id } };
    }
    if (metodo === 'GET' && !aresta && (id ?? '').includes('_')) {
      const f = this.fotosNaPagina.find((x) => x.page_story_id === id);
      if (f) return { status: 200, corpo: { permalink_url: `https://www.facebook.com/${f.pagina}/posts/${id!.split('_')[1]}`, id } };
    }

    if (metodo === 'POST' && aresta === 'media') {
      // O Reels (A6, Z10): `media_type=REELS` com `video_url`, a capa (`cover_url` ou `thumb_offset`) e `share_to_feed`.
      const reels = corpo?.media_type === 'REELS';
      // O Story (A6, Z13): `media_type=STORIES` com `image_url` ou `video_url`, sem legenda (a referência não a aceita).
      const story = corpo?.media_type === 'STORIES';
      if (story && corpo?.caption !== undefined) return erro(400, 100, '(#100) The parameter caption is not supported for stories');
      const campo = reels || (story && corpo?.video_url !== undefined) ? corpo?.video_url : corpo?.image_url;
      const endereco = typeof campo === 'string' ? campo : '';
      const imagem = this.buscarImagem(endereco);
      // A Meta busca a imagem (ou o vídeo) na hora: sem ela, o contêiner não nasce.
      if (!imagem) return erro(400, 9004, 'Media download has failed. The media URI doesn\'t meet our requirements.');
      const textoOuNulo = (v: unknown) => (typeof v === 'string' ? v : null);
      if (reels && corpo?.cover_url !== undefined && !this.buscarImagem(String(corpo.cover_url))) return erro(400, 9004, 'Cover download has failed.');
      const c: Conteiner = {
        id: idDaMeta(),
        ig: id!,
        caption: String(corpo?.caption ?? ''),
        imagem,
        endereco,
        status: this.situacaoAoCriar,
        tipo: reels ? 'REELS' : story ? 'STORY' : 'foto',
        ...(reels ? { capa: textoOuNulo(corpo?.cover_url), quadro: textoOuNulo(corpo?.thumb_offset), noFeed: textoOuNulo(corpo?.share_to_feed) } : {}),
        ...(story ? { storyVideo: corpo?.video_url !== undefined } : {}),
      };
      this.conteineres.set(c.id, c);
      return { status: 200, corpo: { id: c.id } };
    }
    if (metodo === 'POST' && aresta === 'media_publish') {
      const c = this.conteineres.get(String(corpo?.creation_id ?? ''));
      if (!c || c.ig !== id) return erro(400, 100, 'Invalid parameter');
      // O pior caso (V125): o contêiner já publicado publica de novo.
      if (c.status !== 'FINISHED' && c.status !== 'PUBLISHED') return erro(400, 9007, 'Media ID is not available', 2207027);
      // O Story (A6, Z13) fica à parte dos posts: ele não aparece em `/media`.
      if (c.tipo === 'STORY') {
        const sid = idDaMeta();
        this.stories.unshift({ id: sid, onde: id!, post_id: sid, media_id: c.id, media_type: c.storyVideo ? 'video' : 'photo', creation_time: dataDoInstagram(new Date()), url: `https://www.instagram.com/stories/${this.usuarioDaConta}/${sid}/`, imagem: c.imagem });
        c.status = 'PUBLISHED';
        if (this.perderARespostaDaPublicacao) {
          this.perderARespostaDaPublicacao = false;
          return erro(503, 2, 'Service temporarily unavailable');
        }
        return { status: 200, corpo: { id: sid } };
      }
      const p: PostNoInstagram = { id: idDaMeta(), caption: c.caption, timestamp: dataDoInstagram(new Date()), permalink: `https://www.instagram.com/p/${randomBytes(5).toString('hex')}/`, conteiner: c.id, imagem: c.imagem };
      this.posts.unshift(p);
      c.status = 'PUBLISHED';
      if (this.perderARespostaDaPublicacao) {
        this.perderARespostaDaPublicacao = false;
        return erro(503, 2, 'Service temporarily unavailable');
      }
      return { status: 200, corpo: { id: p.id } };
    }
    if (metodo === 'GET' && aresta === 'content_publishing_limit') {
      return { status: 200, corpo: { data: [{ quota_usage: this.cota.usados, config: { quota_total: this.cota.total, quota_duration: 86400 } }] } };
    }
    if (metodo === 'GET' && aresta === 'media') {
      const campos = (params.fields ?? 'id').split(',');
      return { status: 200, corpo: { data: this.postsDe(id!).slice(0, Number(params.limit ?? 25)).map((p) => this.naLista(p, campos)) } };
    }
    if (metodo === 'GET' && !aresta) {
      const c = this.conteineres.get(id!);
      if (c && params.fields === 'status_code') return { status: 200, corpo: { status_code: c.status, id: c.id } };
      const p = this.posts.find((x) => x.id === id);
      if (p) return { status: 200, corpo: { permalink: p.permalink, id: p.id } };
      const s = this.stories.find((x) => x.id === id);
      if (s) return { status: 200, corpo: { permalink: s.url, id: s.id } };
    }
    return erro(400, 100, `Unsupported ${metodo.toLowerCase()} request`, 33);
  }
}

type Resposta = { status: number; corpo: unknown };

/** A situação do vídeo na Página como a Meta a devolve (`GET /{video-id}?fields=status`). */
function situacaoDoVideo(fase: VideoNaPagina['fase']): Record<string, unknown> {
  switch (fase) {
    case 'enviando':
      return { video_status: 'uploading', uploading_phase: { status: 'in_progress' }, processing_phase: { status: 'not_started' }, publishing_phase: { status: 'not_started' } };
    case 'processando':
      return { video_status: 'processing', uploading_phase: { status: 'complete' }, processing_phase: { status: 'in_progress' }, publishing_phase: { status: 'not_started' } };
    case 'publicado':
      return { video_status: 'ready', uploading_phase: { status: 'complete' }, processing_phase: { status: 'complete' }, publishing_phase: { status: 'complete', publish_status: 'published' } };
    case 'erro':
      return { video_status: 'error', uploading_phase: { status: 'complete' }, processing_phase: { status: 'error', error: { message: 'Unsupported video' } } };
  }
}

function erro(status: number, code: number, message: string, subcode?: number): { status: number; corpo: unknown } {
  return { status, corpo: { error: { message, type: 'OAuthException', code, ...(subcode ? { error_subcode: subcode } : {}), fbtrace_id: 'teste' } } };
}
