import { createHmac } from 'node:crypto';
import { type Database, type Tx, withTenant } from '@liame/database';
import { INSTAGRAM_MEDIA_LIMIT } from '@liame/contracts';
import { Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { contaConectada } from '../connections/conectada.js';
import { type ClienteConector, ErroConector } from '../connectors/cliente-http.js';
import { PROVEDOR_INSTAGRAM, PROVEDOR_PAGINA, tokenDaPagina } from '../connectors/meta/publicacao.js';
import { CAMPOS_DA_LISTA, esperaDaFalhaDoInstagram } from '../fotos/do-seu-instagram.js';
import { abrirVezDosPedidos } from './pedidos.js';
import {
  CAMPOS_DO_COMENTARIO_NA_PAGINA,
  CAMPOS_DO_COMENTARIO_NO_INSTAGRAM,
  CAMPOS_DO_POST_DA_PAGINA,
  type ComentarioLido,
  comentariosDaPagina,
  comentariosDoInstagram,
  DATASET_DOS_COMENTARIOS,
  DIAS_DOS_POSTS,
  INTERVALO_DOS_COMENTARIOS_MIN,
  PAGINAS_POR_POST,
  POR_PAGINA_NA_PAGINA,
  POR_PAGINA_NO_INSTAGRAM,
  type PostComentado,
  postDevido,
  postsDaPagina,
  postsDoInstagram,
} from './comentarios.js';

// A leitura dos comentários (A6 · Z11, parte 1; P38, D-A6-85 e D-A6-86). A cada 15 minutos, para cada conta do
// Instagram e cada Página ligadas a uma marca de empresa com a função `comentarios` ligada: os posts dos últimos 30 dias
// e, de cada post devido (até 7 dias, sempre; de 8 a 30, de hora em hora), os comentários com as respostas. O banco em
// transações curtas, antes e depois; as chamadas à Meta, sem transação aberta. O que saiu da rede sai daqui: o post que
// não está mais na lista e o comentário que não voltou numa leitura inteira do post (o oculto fica: a documentação não
// diz se a Meta o devolve). O token nunca vai para log nem banco; a prova do segredo do app vai no endereço (V161). A
// reserva da vez é da rotina do worker (V53).

const META = 'meta_ads';
const HORA_MS = 3_600_000;

type Capacidade = 'instagram_media' | 'instagram_comments' | 'pages' | 'pagina_posts' | 'pagina_comments';

/** O que a leitura precisa do resto do app (os testes trocam a Graph). */
export type DependenciasDosComentarios = {
  lerSegredo: (tx: Tx, secretId: string) => Promise<string | null>;
  cliente: () => ClienteConector;
  graphUrl: string;
  appSecret: string | null;
  versao: (capacidade: Capacidade) => Promise<string>;
  /** A função `comentarios` da empresa, conferida na vez. */
  ligada: (tenantId: string, brandId: string) => Promise<boolean>;
  /**
   * A função dos pedidos do Social media (`comentarios_sugeridos`, A6, Z11, parte 2d-2): ligada, a leitura que deu certo
   * abre a vez de cada comentário que pede uma ação da marca. Ausente = desligada.
   */
  pedidosLigados?: (tenantId: string, brandId: string) => Promise<boolean>;
};

/** Como terminou a vez de uma conta. */
export type ResultadoDosComentarios = {
  conta: string;
  status: 'ok' | 'desligada' | 'ignorada' | 'sem_permissao' | 'falhou';
  posts?: number;
  lidos?: number;
  comentarios?: number;
  /** Quantos comentários entraram na fila dos pedidos do Social media nesta leitura (só com a função ligada). */
  pedidos?: number;
  erro?: string;
};

/**
 * O que fica no `cursor` do `sync_state`. `tudo`: o "Ler agora" pediu todos os posts, sem a espera de uma hora; `lendo`:
 * a reserva do worker (a conta está sendo lida), que toda gravação desta leitura tira.
 */
export type CursorDosComentarios = { proxima?: string; falha?: string; falhas_seguidas?: number; tudo?: boolean; lendo?: string };

type LinhaDaConta = {
  id: string;
  provider: string;
  brand_id: string;
  external_id: string;
  usuario: string | null;
  segredo: string | null;
  conectada: boolean;
  cursor: CursorDosComentarios | null;
};

type LinhaDoPost = { post_id: string; comments_read_at: Date | string | null };

/** Os comentários lidos de um post: os da leitura e se ela veio inteira (todas as páginas). */
type LidoDoPost = { post: PostComentado; comentarios: ComentarioLido[]; inteira: boolean; respostasInteiras: boolean };

/** A falha que para a vez da conta inteira (o token, a permissão, a Página fora da autorização). */
class FalhaDaConta extends Error {
  constructor(readonly erro: ErroConector) {
    super(erro.message);
  }
}

const iso = (v: Date | string): string => (v instanceof Date ? v : new Date(v)).toISOString();

export class SincronizadorDosComentarios {
  private readonly logger = new Logger('comentarios');

  constructor(
    private readonly database: Database,
    private readonly deps: DependenciasDosComentarios,
  ) {}

  async sincronizar(contaId: string, tenantId: string, agora: Date = new Date()): Promise<ResultadoDosComentarios> {
    const db = this.database.db;
    const depois = (ms: number) => new Date(agora.getTime() + ms).toISOString();

    // 1. A conta, o cursor, a função, o token e os posts guardados, numa transação curta da empresa.
    const inicio = await withTenant(db, tenantId, async (tx) => {
      const conta = (
        await tx.execute<LinhaDaConta>(sql`
          select a.id, a.provider, a.brand_id, a.external_id, a.provider_attributes->>'usuario' as usuario,
                 a.credential_secret_id as segredo, coalesce(${contaConectada('a')}, false) as conectada, s.cursor
            from liame.connected_account a
            left join liame.sync_state s on s.connected_account_id = a.id and s.dataset = ${DATASET_DOS_COMENTARIOS}
           where a.id = ${contaId} and a.provider in (${PROVEDOR_INSTAGRAM}, ${PROVEDOR_PAGINA})`)
      ).rows[0];
      if (!conta) return { situacao: 'ignorada' as const };
      // A marca da reserva sai em toda gravação desta leitura (adiar, falhar ou terminar).
      const { lendo: _reserva, ...cursor }: CursorDosComentarios = conta.cursor ?? {};
      if (!conta.conectada || !conta.segredo) {
        await this.adiar(tx, contaId, tenantId, { ...cursor, proxima: depois(24 * HORA_MS) }, agora);
        return { situacao: 'ignorada' as const };
      }
      if (!(await this.deps.ligada(tenantId, conta.brand_id))) {
        // A função desligada: a conta espera um dia, sem ler (V106).
        await this.adiar(tx, contaId, tenantId, { ...cursor, proxima: depois(24 * HORA_MS) }, agora);
        return { situacao: 'desligada' as const };
      }
      const token = await this.token(tx, conta.segredo);
      const guardados = (
        await tx.execute<LinhaDoPost>(sql`select post_id, comments_read_at from liame.social_comment_post where connected_account_id = ${contaId}`)
      ).rows;
      return { situacao: 'ler' as const, conta, cursor, token, guardados };
    }).catch(async (err: unknown) => {
      if (!(err instanceof ErroConector)) throw err;
      // O token que não está mais no cofre: como a autorização revogada.
      await withTenant(db, tenantId, (tx) => this.marcarFalha(tx, contaId, tenantId, {}, err, agora));
      return { situacao: 'falhou' as const, erro: err };
    });
    if (inicio.situacao === 'ignorada' || inicio.situacao === 'desligada') return { conta: contaId, status: inicio.situacao };
    if (inicio.situacao === 'falhou') return { conta: contaId, status: inicio.erro.tipo === 'permissao' ? 'sem_permissao' : 'falhou', erro: inicio.erro.message };
    const { conta, cursor, token, guardados } = inicio;

    // 2. Os posts e os comentários, sem transação aberta.
    let leitura: { posts: PostComentado[]; corte: string; lidos: LidoDoPost[] };
    try {
      leitura = await this.ler(conta, token, guardados, agora, cursor.tudo === true);
    } catch (err) {
      const erro = err instanceof FalhaDaConta ? err.erro : err instanceof ErroConector ? err : null;
      if (!erro) throw err;
      this.logger.warn(`conta ${contaId}: os comentários não vieram (${erro.tipo}): ${erro.message}`);
      await withTenant(db, tenantId, (tx) => this.marcarFalha(tx, contaId, tenantId, cursor, erro, agora));
      return { conta: contaId, status: erro.tipo === 'permissao' ? 'sem_permissao' : 'falhou', erro: erro.message };
    }

    // 3. A gravação: os posts (o que saiu da lista sai daqui), os comentários de cada post lido e o estado; com os pedidos
    // do Social media ligados, a vez dos comentários que pedem uma ação da marca abre na mesma transação.
    const pedidos = await withTenant(db, tenantId, async (tx) => {
      await this.gravarPosts(tx, conta, tenantId, leitura.posts, leitura.corte, agora);
      for (const l of leitura.lidos) await this.gravarComentarios(tx, conta, tenantId, l, agora);
      await this.marcar(tx, contaId, tenantId, { sucesso: true, erro: null, cursor: { proxima: depois(INTERVALO_DOS_COMENTARIOS_MIN * 60_000), falhas_seguidas: 0 } }, agora);
      if (!(await this.deps.pedidosLigados?.(tenantId, conta.brand_id))) return null;
      return abrirVezDosPedidos(tx, { tenantId, brandId: conta.brand_id, connectedAccountId: contaId }, agora);
    });
    return {
      conta: contaId,
      status: 'ok',
      posts: leitura.posts.length,
      lidos: leitura.lidos.length,
      comentarios: leitura.lidos.reduce((n, l) => n + l.comentarios.length, 0),
      ...(pedidos === null ? {} : { pedidos }),
    };
  }

  /**
   * A lista dos posts e os comentários dos devidos. A falha da lista, do token da Página ou de permissão para a conta
   * inteira (V42); a de um post (o post apagado no meio, a falha passageira) deixa só aquele para a próxima vez; a cota
   * para as chamadas e grava o que já veio.
   */
  private async ler(conta: LinhaDaConta, token: string, guardados: LinhaDoPost[], agora: Date, tudo: boolean): Promise<{ posts: PostComentado[]; corte: string; lidos: LidoDoPost[] }> {
    const ehPagina = conta.provider === PROVEDOR_PAGINA;
    let tokenDaLeitura = token;
    let posts: PostComentado[];
    let lidosNaLista: number;
    if (ehPagina) {
      const contas = await this.chamar(conta.external_id, token, 'pages', 'me/accounts', { fields: 'id,access_token,tasks', limit: '100' });
      const daPagina = tokenDaPagina(contas, conta.external_id);
      // Sem a Página na autorização, ou sem a tarefa de moderar (a leitura dos comentários pede MODERATE desde a v11.0).
      if (!daPagina) throw new FalhaDaConta(new ErroConector('permissao', META, 'a autorização não alcança a Página'));
      if (!daPagina.podeModerar) throw new FalhaDaConta(new ErroConector('permissao', META, 'quem autorizou não tem a tarefa de moderar a Página'));
      tokenDaLeitura = daPagina.token;
      const corpo = await this.chamar(conta.external_id, tokenDaLeitura, 'pagina_posts', `${conta.external_id}/posts`, { fields: CAMPOS_DO_POST_DA_PAGINA, limit: String(POR_PAGINA_NA_PAGINA) });
      posts = postsDaPagina(corpo, agora);
      lidosNaLista = tamanhoDaLista(corpo);
    } else {
      const corpo = await this.chamar(conta.external_id, token, 'instagram_media', `${conta.external_id}/media`, { fields: CAMPOS_DA_LISTA, limit: String(INSTAGRAM_MEDIA_LIMIT) });
      posts = postsDoInstagram(corpo, agora);
      lidosNaLista = tamanhoDaLista(corpo);
    }
    // A lista que encheu (50 no Instagram, 100 na Página) pode não ter chegado aos 30 dias: o post mais antigo dela é o
    // corte do que sai do Liame (o que fica antes dele não é tirado só por não ter vindo).
    const desde = new Date(agora.getTime() - DIAS_DOS_POSTS * 24 * HORA_MS).toISOString();
    const cheia = lidosNaLista >= (ehPagina ? POR_PAGINA_NA_PAGINA : INSTAGRAM_MEDIA_LIMIT);
    const corte = cheia && posts.length ? posts.reduce((m, p) => (p.published_at < m ? p.published_at : m), posts[0]!.published_at) : desde;

    const lidoEm = new Map(guardados.map((g) => [g.post_id, g.comments_read_at ? iso(g.comments_read_at) : null]));
    const lidos: LidoDoPost[] = [];
    for (const post of posts) {
      if (!postDevido(post.published_at, lidoEm.get(post.post_id) ?? null, agora, tudo)) continue;
      // O post do Instagram que a lista diz sem comentários não pede chamada: nada a ler, e o que havia saiu.
      if (!ehPagina && post.comment_count === 0) {
        lidos.push({ post, comentarios: [], inteira: true, respostasInteiras: true });
        continue;
      }
      try {
        lidos.push(await this.comentariosDoPost(conta, tokenDaLeitura, post, ehPagina));
      } catch (err) {
        if (!(err instanceof ErroConector)) throw err;
        if (err.tipo === 'permissao' || err.tipo === 'autenticacao') throw new FalhaDaConta(err);
        if (err.tipo === 'limite' || err.tipo === 'circuito_aberto') {
          this.logger.warn(`conta ${conta.id}: a Meta pediu para esperar; os outros posts ficam para a próxima vez`);
          break;
        }
        this.logger.warn(`conta ${conta.id}: os comentários de um post ficam para a próxima vez (${err.tipo}, HTTP ${err.status ?? '?'}, código ${err.codigoProvider ?? '?'})`);
      }
    }
    return { posts, corte, lidos };
  }

  /** Os comentários de um post, página a página, até o máximo; a leitura é inteira quando não sobrou página. */
  private async comentariosDoPost(conta: LinhaDaConta, token: string, post: PostComentado, ehPagina: boolean): Promise<LidoDoPost> {
    const comentarios: ComentarioLido[] = [];
    let respostasInteiras = true;
    let depois: string | null = null;
    for (let pagina = 0; pagina < PAGINAS_POR_POST; pagina += 1) {
      const params: Record<string, string> = ehPagina
        ? { filter: 'stream', fields: CAMPOS_DO_COMENTARIO_NA_PAGINA, limit: String(POR_PAGINA_NA_PAGINA) }
        : { fields: CAMPOS_DO_COMENTARIO_NO_INSTAGRAM, limit: String(POR_PAGINA_NO_INSTAGRAM) };
      if (depois) params.after = depois;
      const corpo = await this.chamar(conta.external_id, token, ehPagina ? 'pagina_comments' : 'instagram_comments', `${post.post_id}/comments`, params);
      const lida = ehPagina ? comentariosDaPagina(corpo, conta.external_id) : comentariosDoInstagram(corpo, { id: conta.external_id, usuario: conta.usuario });
      comentarios.push(...lida.comentarios);
      if (lida.respostasIncompletas) respostasInteiras = false;
      depois = lida.proxima;
      if (!depois) return { post, comentarios: semRepetir(comentarios), inteira: true, respostasInteiras };
    }
    return { post, comentarios: semRepetir(comentarios), inteira: false, respostasInteiras: false };
  }

  /** Grava os posts lidos e tira os que saíram da lista (a partir do corte). Sem post, tira os da janela. */
  private async gravarPosts(tx: Tx, conta: LinhaDaConta, tenantId: string, posts: PostComentado[], corte: string, agora: Date): Promise<void> {
    if (posts.length) {
      await tx.execute(sql`
        insert into liame.social_comment_post (connected_account_id, tenant_id, brand_id, post_id, channel, kind, caption, permalink, thumbnail_url,
                                               published_at, comment_count, read_at)
        select ${conta.id}, ${tenantId}, ${conta.brand_id}, x.post_id, x.channel, x.kind, x.caption, x.permalink, x.thumbnail_url,
               x.published_at, x.comment_count, ${agora.toISOString()}::timestamptz
          from jsonb_to_recordset(${JSON.stringify(posts)}::jsonb) as x (
                 post_id text, channel text, kind text, caption text, permalink text, thumbnail_url text, published_at timestamptz, comment_count integer)
        on conflict (connected_account_id, post_id) do update set
          kind = excluded.kind,
          caption = excluded.caption,
          permalink = excluded.permalink,
          thumbnail_url = excluded.thumbnail_url,
          published_at = excluded.published_at,
          comment_count = coalesce(excluded.comment_count, liame.social_comment_post.comment_count),
          read_at = excluded.read_at`);
      await tx.execute(sql`
        delete from liame.social_comment_post
         where connected_account_id = ${conta.id} and published_at >= ${corte}::timestamptz and post_id not in ${posts.map((p) => p.post_id)}`);
    } else {
      await tx.execute(sql`delete from liame.social_comment_post where connected_account_id = ${conta.id} and published_at >= ${corte}::timestamptz`);
    }
  }

  /**
   * Grava os comentários de um post e marca a leitura dele. Na leitura inteira, o comentário guardado que não voltou sai
   * (foi apagado na rede, ou a conta restringiu quem fez), menos o oculto; com as respostas pela metade, só os de primeiro
   * nível saem. O tipo que a IA decidiu fica enquanto o texto for o mesmo.
   */
  private async gravarComentarios(tx: Tx, conta: LinhaDaConta, tenantId: string, l: LidoDoPost, agora: Date): Promise<void> {
    const linhas = l.comentarios.map((c) => ({ ...c, channel: l.post.channel, kind_source: c.kind ? 'regra' : null }));
    if (linhas.length) {
      await tx.execute(sql`
        insert into liame.social_comment (connected_account_id, tenant_id, brand_id, comment_id, post_id, channel, parent_comment_id, author_name, author_key,
                                          by_brand, message, published_at, like_count, reply_count, hidden, kind, kind_source, read_at)
        select ${conta.id}, ${tenantId}, ${conta.brand_id}, x.comment_id, ${l.post.post_id}, x.channel, x.parent_comment_id, x.author_name, x.author_key,
               x.by_brand, x.message, x.published_at, x.like_count, x.reply_count, x.hidden, x.kind, x.kind_source, ${agora.toISOString()}::timestamptz
          from jsonb_to_recordset(${JSON.stringify(linhas)}::jsonb) as x (
                 comment_id text, channel text, parent_comment_id text, author_name text, author_key text, by_brand boolean, message text,
                 published_at timestamptz, like_count integer, reply_count integer, hidden boolean, kind text, kind_source text)
        on conflict (connected_account_id, comment_id) do update set
          parent_comment_id = excluded.parent_comment_id,
          author_name = coalesce(excluded.author_name, liame.social_comment.author_name),
          author_key = coalesce(excluded.author_key, liame.social_comment.author_key),
          by_brand = excluded.by_brand,
          like_count = excluded.like_count,
          reply_count = excluded.reply_count,
          hidden = excluded.hidden,
          kind = case when liame.social_comment.kind_source = 'ia' and liame.social_comment.message = excluded.message then liame.social_comment.kind else excluded.kind end,
          kind_source = case when liame.social_comment.kind_source = 'ia' and liame.social_comment.message = excluded.message then liame.social_comment.kind_source else excluded.kind_source end,
          message = excluded.message,
          read_at = excluded.read_at`);
    }
    if (l.inteira) {
      const ids = linhas.map((c) => c.comment_id);
      await tx.execute(sql`
        delete from liame.social_comment
         where connected_account_id = ${conta.id} and post_id = ${l.post.post_id} and not hidden
           ${l.respostasInteiras ? sql`` : sql`and parent_comment_id is null`}
           ${ids.length ? sql`and comment_id not in ${ids}` : sql``}`);
    }
    await tx.execute(sql`
      update liame.social_comment_post set comments_read_at = ${agora.toISOString()}::timestamptz
       where connected_account_id = ${conta.id} and post_id = ${l.post.post_id}`);
  }

  /** Grava a tentativa no `sync_state`: a que deu certo leva a hora do sucesso; a que falhou, o motivo. */
  private async marcar(tx: Tx, contaId: string, tenantId: string, o: { sucesso: boolean; erro: string | null; cursor: CursorDosComentarios }, agora: Date): Promise<void> {
    const quando = agora.toISOString();
    await tx.execute(sql`
      insert into liame.sync_state (connected_account_id, dataset, tenant_id, expected_every_minutes, last_success_at, last_attempt_at, last_error, cursor, updated_at)
      values (${contaId}, ${DATASET_DOS_COMENTARIOS}, ${tenantId}, ${INTERVALO_DOS_COMENTARIOS_MIN}, ${o.sucesso ? quando : null}::timestamptz, ${quando}::timestamptz,
              ${o.erro}, ${JSON.stringify(o.cursor)}::jsonb, ${quando}::timestamptz)
      on conflict (connected_account_id, dataset) do update set
        last_success_at = coalesce(excluded.last_success_at, liame.sync_state.last_success_at),
        last_attempt_at = excluded.last_attempt_at,
        last_error = excluded.last_error,
        cursor = excluded.cursor,
        updated_at = excluded.updated_at`);
  }

  /** A falha da leitura: o motivo, a espera pelo tipo e quantas seguidas. O "Ler agora" pendente fica para a próxima. */
  private marcarFalha(tx: Tx, contaId: string, tenantId: string, cursor: CursorDosComentarios, err: ErroConector, agora: Date): Promise<void> {
    const falhas = (cursor.falhas_seguidas ?? 0) + 1;
    const espera = esperaDaFalhaDoInstagram(err.tipo, err.esperarMs);
    const texto = `${err.tipo}: ${err.message}`.slice(0, 500);
    const proximo: CursorDosComentarios = { proxima: new Date(agora.getTime() + espera).toISOString(), falha: err.tipo, falhas_seguidas: falhas, ...(cursor.tudo ? { tudo: true } : {}) };
    return this.marcar(tx, contaId, tenantId, { sucesso: false, erro: texto, cursor: proximo }, agora);
  }

  /** Muda só a próxima vez (a conta desligada ou sem a função): não é tentativa, e o que já havia fica. */
  private async adiar(tx: Tx, contaId: string, tenantId: string, cursor: CursorDosComentarios, agora: Date): Promise<void> {
    await tx.execute(sql`
      insert into liame.sync_state (connected_account_id, dataset, tenant_id, expected_every_minutes, cursor, updated_at)
      values (${contaId}, ${DATASET_DOS_COMENTARIOS}, ${tenantId}, ${INTERVALO_DOS_COMENTARIOS_MIN}, ${JSON.stringify(cursor)}::jsonb, ${agora.toISOString()}::timestamptz)
      on conflict (connected_account_id, dataset) do update set cursor = excluded.cursor, updated_at = excluded.updated_at`);
  }

  private async token(tx: Tx, secretId: string): Promise<string> {
    const guardada = await this.deps.lerSegredo(tx, secretId);
    const credencial = guardada ? (JSON.parse(guardada) as { tipo?: string; access_token?: string }) : null;
    if (!credencial || credencial.tipo !== 'meta' || !credencial.access_token) throw new ErroConector('autenticacao', META, 'autorização revogada ou ausente');
    return credencial.access_token;
  }

  /** Uma leitura na Graph API: o token no cabeçalho e a prova do segredo do app no endereço (nunca o token, V161). */
  private async chamar(conta: string, token: string, capacidade: Capacidade, caminho: string, params: Record<string, string>): Promise<unknown> {
    const versao = await this.deps.versao(capacidade);
    const q = new URLSearchParams(params);
    if (this.deps.appSecret) q.set('appsecret_proof', createHmac('sha256', this.deps.appSecret).update(token).digest('hex'));
    const r = await this.deps.cliente().requisitar<unknown>({
      provider: META,
      conta,
      url: `${this.deps.graphUrl}/${versao}/${caminho}?${q.toString()}`,
      metodo: 'GET',
      endpoint: capacidade,
      apiVersion: versao,
      cabecalhos: { authorization: `Bearer ${token}` },
    });
    return r.corpo;
  }
}

/** Quantos itens a lista trouxe (antes de tirar o Story, o anúncio e o fora da janela): é o que diz se ela encheu. */
function tamanhoDaLista(corpo: unknown): number {
  const data = (corpo as { data?: unknown } | null)?.data;
  return Array.isArray(data) ? data.length : 0;
}

/** O mesmo comentário em duas páginas (a lista mudou entre elas): fica a última leitura. */
function semRepetir(lista: ComentarioLido[]): ComentarioLido[] {
  const porId = new Map<string, ComentarioLido>();
  for (const c of lista) porId.set(c.comment_id, c);
  return [...porId.values()];
}
