import { createHmac, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

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

export const TOKEN_DO_INSTAGRAM = `token-do-instagram-${randomBytes(6).toString('hex')}`;
export const SEGREDO_DO_APP = `segredo-do-app-${randomBytes(6).toString('hex')}`;
/** O token que a lista das Páginas devolve para a Página da marca (é com ele que a foto é publicada). */
export const TOKEN_DA_PAGINA = `token-da-pagina-${randomBytes(6).toString('hex')}`;

export type FotoNaPagina = { id: string; pagina: string; name: string; created_time: string; link: string; page_story_id: string; imagem: Buffer | null };

export type PostNoInstagram = { id: string; caption: string; timestamp: string; permalink: string; conteiner: string; imagem: Buffer | null };
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
  tipo: 'foto' | 'REELS';
  capa?: string | null;
  quadro?: string | null;
  noFeed?: string | null;
};
/**
 * O vídeo na Página (A6, Z10): o Reels (o começo, o envio pelo `rupload` e o fim) ou o vídeo comum. `fase`: enviando (o
 * Reels antes do arquivo), processando, publicado ou erro.
 */
export type VideoNaPagina = {
  id: string;
  pagina: string;
  tipo: 'reels' | 'video';
  description: string;
  created_time: string;
  arquivo: Buffer | null;
  fase: 'enviando' | 'processando' | 'publicado' | 'erro';
};
export type ChamadaNoInstagram = { metodo: string; caminho: string; params: Record<string, string>; corpo: Record<string, unknown> | null; cabecalhos?: Record<string, string> };
export type FalhaCombinada = { status: number; corpo: unknown };

/** Um id numérico como os da Meta, único a cada execução (V156). */
const idDaMeta = (): string => `${Date.now()}${Number.parseInt(randomBytes(3).toString('hex'), 16)}`.slice(0, 17).padEnd(17, '3');

/** A data no formato do Instagram: `2026-10-29T19:00:00+0000`. */
const dataDoInstagram = (d: Date): string => `${d.toISOString().slice(0, 19)}+0000`;

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
    this.chamadas.length = 0;
    this.defeitos.length = 0;
  }

  /** Os vídeos publicados (ou não) numa Página. */
  videosDe(pagina: string): VideoNaPagina[] {
    return this.videosNaPagina.filter((v) => v.pagina === pagina);
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
    const v = this.videosNaPagina.find((x) => x.id === videoId && x.tipo === 'reels');
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
    const daPagina = this.paginas.has(id ?? '') || (id ?? '').includes('_') || this.videosNaPagina.some((v) => v.id === id);
    const esperado = daPagina ? TOKEN_DA_PAGINA : TOKEN_DO_INSTAGRAM;
    if (params.access_token) this.defeitos.push('token na URL');
    if (req.headers.authorization !== `Bearer ${esperado}`) return erro(401, 190, 'Invalid OAuth access token');
    if (params.appsecret_proof !== createHmac('sha256', SEGREDO_DO_APP).update(esperado).digest('hex')) this.defeitos.push('sem a prova do segredo do app');

    const final = aresta ?? (params.fields === 'status_code' ? 'status_code' : params.fields === 'status' ? 'status' : 'objeto');
    const falha = this.falhas.get(final)?.shift();
    if (falha) return falha;

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
      const campo = reels ? corpo?.video_url : corpo?.image_url;
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
        tipo: reels ? 'REELS' : 'foto',
        ...(reels ? { capa: textoOuNulo(corpo?.cover_url), quadro: textoOuNulo(corpo?.thumb_offset), noFeed: textoOuNulo(corpo?.share_to_feed) } : {}),
      };
      this.conteineres.set(c.id, c);
      return { status: 200, corpo: { id: c.id } };
    }
    if (metodo === 'POST' && aresta === 'media_publish') {
      const c = this.conteineres.get(String(corpo?.creation_id ?? ''));
      if (!c || c.ig !== id) return erro(400, 100, 'Invalid parameter');
      // O pior caso (V125): o contêiner já publicado publica de novo.
      if (c.status !== 'FINISHED' && c.status !== 'PUBLISHED') return erro(400, 9007, 'Media ID is not available', 2207027);
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
      return { status: 200, corpo: { data: this.postsDe(id!).slice(0, Number(params.limit ?? 25)).map((p) => ({ id: p.id, caption: p.caption, timestamp: p.timestamp, permalink: p.permalink })) } };
    }
    if (metodo === 'GET' && !aresta) {
      const c = this.conteineres.get(id!);
      if (c && params.fields === 'status_code') return { status: 200, corpo: { status_code: c.status, id: c.id } };
      const p = this.posts.find((x) => x.id === id);
      if (p) return { status: 200, corpo: { permalink: p.permalink, id: p.id } };
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
