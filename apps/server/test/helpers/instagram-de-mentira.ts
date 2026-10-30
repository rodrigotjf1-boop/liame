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

export const TOKEN_DO_INSTAGRAM = `token-do-instagram-${randomBytes(6).toString('hex')}`;
export const SEGREDO_DO_APP = `segredo-do-app-${randomBytes(6).toString('hex')}`;
/** O token que a lista das Páginas devolve para a Página da marca (é com ele que a foto é publicada). */
export const TOKEN_DA_PAGINA = `token-da-pagina-${randomBytes(6).toString('hex')}`;

export type FotoNaPagina = { id: string; pagina: string; name: string; created_time: string; link: string; page_story_id: string; imagem: Buffer | null };

export type PostNoInstagram = { id: string; caption: string; timestamp: string; permalink: string; conteiner: string; imagem: Buffer | null };
export type Conteiner = { id: string; ig: string; caption: string; imagem: Buffer | null; endereco: string; status: string };
export type ChamadaNoInstagram = { metodo: string; caminho: string; params: Record<string, string>; corpo: Record<string, unknown> | null };
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
  base = '';
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
    this.chamadas.length = 0;
    this.defeitos.length = 0;
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
    this.chamadas.push({ metodo, caminho: url.pathname, params, corpo });
    const partes = url.pathname.split('/').filter(Boolean); // graph, v26.0, id, [aresta]
    const [, , id, aresta] = partes;
    // O token vai no cabeçalho, nunca na URL; a prova do segredo do app vai junto, calculada com o token. O que é da
    // Página (as fotos dela e o post) pede o token da Página; o resto, o da autorização.
    const daPagina = this.paginas.has(id ?? '') || (id ?? '').includes('_');
    const esperado = daPagina ? TOKEN_DA_PAGINA : TOKEN_DO_INSTAGRAM;
    if (params.access_token) this.defeitos.push('token na URL');
    if (req.headers.authorization !== `Bearer ${esperado}`) return erro(401, 190, 'Invalid OAuth access token');
    if (params.appsecret_proof !== createHmac('sha256', SEGREDO_DO_APP).update(esperado).digest('hex')) this.defeitos.push('sem a prova do segredo do app');

    const final = aresta ?? (params.fields === 'status_code' ? 'status_code' : 'objeto');
    const falha = this.falhas.get(final)?.shift();
    if (falha) return falha;

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
      const endereco = typeof corpo?.image_url === 'string' ? corpo.image_url : '';
      const imagem = this.buscarImagem(endereco);
      // A Meta busca a imagem na hora: sem ela, o contêiner não nasce.
      if (!imagem) return erro(400, 9004, 'Media download has failed. The media URI doesn\'t meet our requirements.');
      const c: Conteiner = { id: idDaMeta(), ig: id!, caption: String(corpo?.caption ?? ''), imagem, endereco, status: this.situacaoAoCriar };
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

function erro(status: number, code: number, message: string, subcode?: number): { status: number; corpo: unknown } {
  return { status, corpo: { error: { message, type: 'OAuthException', code, ...(subcode ? { error_subcode: subcode } : {}), fbtrace_id: 'teste' } } };
}
