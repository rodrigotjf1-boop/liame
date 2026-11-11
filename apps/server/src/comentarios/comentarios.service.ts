import {
  COMMENTS_LIST_LIMIT,
  COMMENTS_REFRESH_WINDOW_S,
  type CommentPost,
  type CommentReply,
  type CommentsCounts,
  type CommentsQuery,
  type CommentsRefreshRequest,
  type CommentsRefreshResponse,
  type CommentsResponse,
  type CommentsWaitingResponse,
  type SocialComment,
} from '@liame/contracts';
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { ACTIVE_ACTION_STATUSES } from '../actions/action.service.js';
import { recursoDoComentario } from '../actions/comentario-na-rede.js';
import { RateLimitService } from '../auth/rate-limit.service.js';
import { contaConectada } from '../connections/conectada.js';
import { PROVEDOR_INSTAGRAM, PROVEDOR_PAGINA } from '../connectors/meta/publicacao.js';
import { type AuthContext, currentTx } from '../context/request-context.js';
import { AppProblem } from '../errors/problems.js';
import { FlagService } from '../flags/flag.service.js';
import { situacaoDaLeitura } from '../fotos/do-seu-instagram.service.js';
import { marcaDaEmpresa, quemPede } from '../fotos/fotos.service.js';
import { DATASET_DOS_COMENTARIOS, FLAG_DOS_COMENTARIOS } from './comentarios.js';

// Comentários (A6 · Z11, parte 1; P38, D-A6-84 a D-A6-90): o que a tela lê, na transação da rota, e o "Ler agora". Só
// lê o que a rotina `comentarios` do worker gravou; nenhuma chamada à Meta acontece aqui.

const RESPOSTAS_POR_COMENTARIO = 20;

type LinhaDaConta = {
  id: string;
  provider: string;
  name: string;
  last_success_at: Date | string | null;
  last_error: string | null;
  cursor: { falha?: string } | null;
};

type LinhaDoComentario = {
  connected_account_id: string;
  comment_id: string;
  channel: string;
  post_id: string;
  author_name: string | null;
  message: string;
  published_at: Date | string;
  like_count: number | null;
  reply_count: number | null;
  hidden: boolean;
  kind: string | null;
  kind_source: string | null;
  situation: string;
};

type LinhaDaResposta = {
  connected_account_id: string;
  comment_id: string;
  parent_comment_id: string;
  author_name: string | null;
  by_brand: boolean;
  message: string;
  published_at: Date | string;
  hidden: boolean;
};

type LinhaDoPedido = { account_id: string; resource_id: string; id: string; tool: string; status: string };

type LinhaDoPost = {
  connected_account_id: string;
  post_id: string;
  channel: string;
  kind: string | null;
  caption: string;
  permalink: string | null;
  thumbnail_url: string | null;
  published_at: Date | string;
  comment_count: number | null;
};

const iso = (v: Date | string): string => (v instanceof Date ? v : new Date(v)).toISOString();
const canalDo = (provider: string): string => (provider === PROVEDOR_PAGINA ? 'facebook' : 'instagram');
const ZERO: CommentsCounts = { pedem: 0, ocultar: 0, respondidos: 0, ocultos: 0, todos: 0 };

/** O filtro da tela e a situação do comentário que ele mostra. */
const SITUACAO_DO_FILTRO: Record<string, string> = { pedem: 'pede_resposta', ocultar: 'para_ocultar', respondidos: 'respondido', ocultos: 'oculto' };

/** A vez do "Ler agora" é da marca, dentro da empresa. */
const chaveDoLerAgora = (tenantId: string, brandId: string): string => `ler-comentarios:${tenantId}:${brandId}`;

@Injectable()
export class ComentariosService {
  constructor(
    private readonly flags: FlagService,
    private readonly limite: RateLimitService,
  ) {}

  private ligada(tenantId: string, userId: string, brandId: string): Promise<boolean> {
    return this.flags.isEnabled(FLAG_DOS_COMENTARIOS, this.flags.context({ tenantId, userId, brandId }));
  }

  async ver(auth: AuthContext, query: CommentsQuery): Promise<CommentsResponse> {
    const quem = quemPede(auth);
    const brandId = query.brand_id;
    await marcaDaEmpresa(brandId);
    const base: CommentsResponse = { brand_id: brandId, state: 'desligada', accounts: [], counts: ZERO, items: [], posts: [], refresh: { available: false, next_at: null } };
    if (!(await this.ligada(quem.tenantId, quem.userId, brandId))) return base;

    const tx = currentTx();
    const contas = (
      await tx.execute<LinhaDaConta>(sql`
        select a.id, a.provider, a.name, s.last_success_at, s.last_error, s.cursor
          from liame.connected_account a
          left join liame.sync_state s on s.connected_account_id = a.id and s.dataset = ${DATASET_DOS_COMENTARIOS}
         where a.brand_id = ${brandId} and a.provider in (${PROVEDOR_INSTAGRAM}, ${PROVEDOR_PAGINA}) and ${contaConectada('a')}
         order by a.provider, a.connected_at, a.id`)
    ).rows;
    const proxima = await this.limite.proximaVez(chaveDoLerAgora(quem.tenantId, brandId), 1, COMMENTS_REFRESH_WINDOW_S);
    const refresh = { available: proxima === null, next_at: proxima?.toISOString() ?? null };
    if (contas.length === 0) return { ...base, state: 'sem_conta', refresh };
    const accounts = contas.map((c) => ({ channel: canalDo(c.provider), name: c.name, situation: situacaoDaLeitura(c), read_at: c.last_success_at ? iso(c.last_success_at) : null }));
    const ids = contas.map((c) => c.id);

    // Os comentários de primeiro nível de outras pessoas, com a situação de cada um (a resposta da marca decide
    // "respondido"; o oculto vem antes de tudo).
    const doCanal = query.channel ? sql`and c.channel = ${query.channel}` : sql``;
    const comSituacao = sql`
      select c.connected_account_id, c.comment_id, c.channel, c.post_id, c.author_name, c.message, c.published_at, c.like_count, c.reply_count,
             c.hidden, c.kind, c.kind_source,
             case when c.hidden then 'oculto'
                  when exists (select 1 from liame.social_comment r
                                where r.connected_account_id = c.connected_account_id and r.parent_comment_id = c.comment_id and r.by_brand) then 'respondido'
                  when c.kind in ('pergunta', 'reclamacao') then 'pede_resposta'
                  when c.kind in ('ofensivo', 'golpe') then 'para_ocultar'
                  else 'sem_resposta' end as situation
        from liame.social_comment c
       where c.connected_account_id in ${ids} and c.parent_comment_id is null and not c.by_brand ${doCanal}`;
    const contagens = (await tx.execute<{ situation: string; n: string | number }>(sql`select situation, count(*) as n from (${comSituacao}) x group by situation`)).rows;
    const quantos = (s: string) => Number(contagens.find((c) => c.situation === s)?.n ?? 0);
    const counts: CommentsCounts = {
      pedem: quantos('pede_resposta'),
      ocultar: quantos('para_ocultar'),
      respondidos: quantos('respondido'),
      ocultos: quantos('oculto'),
      todos: contagens.reduce((n, c) => n + Number(c.n), 0),
    };

    const situacao = query.filter && query.filter !== 'todos' ? SITUACAO_DO_FILTRO[query.filter] : null;
    const busca = query.q ? query.q.toLowerCase() : null;
    const linhas = (
      await tx.execute<LinhaDoComentario>(sql`
        select * from (${comSituacao}) x
         where true ${situacao ? sql`and x.situation = ${situacao}` : sql``}
           ${busca ? sql`and (position(${busca} in lower(x.message)) > 0 or position(${busca} in lower(coalesce(x.author_name, ''))) > 0)` : sql``}
         order by case x.situation when 'pede_resposta' then 0 when 'para_ocultar' then 1 when 'sem_resposta' then 2 when 'respondido' then 3 else 4 end,
                  x.published_at desc, x.comment_id
         limit ${COMMENTS_LIST_LIMIT}`)
    ).rows;
    if (linhas.length === 0) return { brand_id: brandId, state: 'pronta', accounts, counts, items: [], posts: [], refresh };

    const pais = linhas.map((l) => l.comment_id);
    const respostas = (
      await tx.execute<LinhaDaResposta>(sql`
        select r.connected_account_id, r.comment_id, r.parent_comment_id, r.author_name, r.by_brand, r.message, r.published_at, r.hidden
          from liame.social_comment r
         where r.connected_account_id in ${ids} and r.parent_comment_id in ${pais}
         order by r.published_at, r.comment_id`)
    ).rows;
    const respostasDe = new Map<string, CommentReply[]>();
    for (const r of respostas) {
      const chave = `${r.connected_account_id}:${r.parent_comment_id}`;
      const lista = respostasDe.get(chave) ?? [];
      if (lista.length < RESPOSTAS_POR_COMENTARIO) lista.push({ id: r.comment_id, author: r.author_name, by_brand: r.by_brand, message: r.message, published_at: iso(r.published_at), hidden: r.hidden });
      respostasDe.set(chave, lista);
    }
    // O pedido em aberto de cada comentário (A6, Z11, parte 2c): o mais novo, enquanto espera a aprovação, aprovado ou em
    // execução (as mesmas situações que seguram um pedido novo do mesmo objeto). A tela mostra "Pedido em Aprovações".
    const pedidos = (
      await tx.execute<LinhaDoPedido>(sql`
        select distinct on (r.account_id, r.resource_id) r.account_id, r.resource_id, r.id, r.tool, r.status
          from liame.action_request r
         where r.account_id in ${ids} and r.resource_id in ${linhas.map((l) => recursoDoComentario(l.comment_id))}
           and r.status in ${ACTIVE_ACTION_STATUSES}
         order by r.account_id, r.resource_id, r.created_at desc, r.id`)
    ).rows;
    const pedidoDe = new Map(pedidos.map((p) => [`${p.account_id}:${p.resource_id}`, { id: p.id, tool: p.tool, status: p.status }]));
    const items: SocialComment[] = linhas.map((l) => ({
      id: l.comment_id,
      channel: l.channel,
      post_id: l.post_id,
      author: l.author_name,
      message: l.message,
      published_at: iso(l.published_at),
      like_count: l.like_count,
      reply_count: l.reply_count,
      hidden: l.hidden,
      kind: l.kind,
      kind_source: l.kind_source,
      situation: l.situation,
      replies: respostasDe.get(`${l.connected_account_id}:${l.comment_id}`) ?? [],
      account_id: l.connected_account_id,
      request: pedidoDe.get(`${l.connected_account_id}:${recursoDoComentario(l.comment_id)}`) ?? null,
    }));

    const postIds = [...new Set(linhas.map((l) => l.post_id))];
    const posts: CommentPost[] = (
      await tx.execute<LinhaDoPost>(sql`
        select p.connected_account_id, p.post_id, p.channel, p.kind, p.caption, p.permalink, p.thumbnail_url, p.published_at, p.comment_count
          from liame.social_comment_post p
         where p.connected_account_id in ${ids} and p.post_id in ${postIds}
         order by p.published_at desc, p.post_id`)
    ).rows.map((p) => ({
      id: p.post_id,
      channel: p.channel,
      kind: p.kind,
      caption: p.caption,
      permalink: p.permalink,
      thumbnail_url: p.thumbnail_url,
      published_at: iso(p.published_at),
      comment_count: p.comment_count,
    }));
    return { brand_id: brandId, state: 'pronta', accounts, counts, items, posts, refresh };
  }

  /**
   * O contador do menu (A6, Z11, parte 3c; P38): quantos comentários pedem resposta, somadas as marcas da empresa com a
   * função ligada. A mesma regra de "Pedem resposta" na tela (`ver`), numa contagem só, sem os textos.
   */
  async esperando(auth: AuthContext): Promise<CommentsWaitingResponse> {
    const quem = quemPede(auth);
    const tx = currentTx();
    const contas = (
      await tx.execute<{ id: string; brand_id: string }>(sql`
        select a.id, a.brand_id from liame.connected_account a
          join liame.brand b on b.id = a.brand_id
         where b.archived_at is null and a.provider in (${PROVEDOR_INSTAGRAM}, ${PROVEDOR_PAGINA}) and ${contaConectada('a')}`)
    ).rows;
    // A função é por marca (a empresa costuma ter poucas): a conta da marca desligada não conta.
    const ligadas = new Set<string>();
    for (const marca of new Set(contas.map((c) => c.brand_id))) if (await this.ligada(quem.tenantId, quem.userId, marca)) ligadas.add(marca);
    const ids = contas.filter((c) => ligadas.has(c.brand_id)).map((c) => c.id);
    if (!ids.length) return { asking: 0 };
    const r = await tx.execute<{ n: string | number }>(sql`
      select count(*) as n from liame.social_comment c
       where c.connected_account_id in ${ids} and c.parent_comment_id is null and not c.by_brand and not c.hidden
         and c.kind in ('pergunta', 'reclamacao')
         and not exists (select 1 from liame.social_comment r
                          where r.connected_account_id = c.connected_account_id and r.parent_comment_id = c.comment_id and r.by_brand)`);
    return { asking: Number(r.rows[0]?.n ?? 0) };
  }

  /**
   * "Ler agora": adianta a próxima leitura do Instagram e da Página da marca, com todos os posts dos últimos 30 dias (sem
   * a espera de uma hora dos de 8 a 30 dias); o worker pega na volta seguinte (até um minuto). Uma vez por janela de 5
   * minutos por marca. A conta que está sendo lida fica como está: a leitura em andamento termina com o que veio agora.
   */
  async lerAgora(auth: AuthContext, body: CommentsRefreshRequest, agora = new Date()): Promise<CommentsRefreshResponse> {
    const quem = quemPede(auth);
    await marcaDaEmpresa(body.brand_id);
    if (!(await this.ligada(quem.tenantId, quem.userId, body.brand_id))) {
      throw new AppProblem(409, 'funcao-desligada', 'Função desligada', 'Comentários não está ligado para esta empresa.');
    }
    const chave = chaveDoLerAgora(quem.tenantId, body.brand_id);
    try {
      await this.limite.consume(chave, 1, COMMENTS_REFRESH_WINDOW_S);
    } catch (err) {
      if (!(err instanceof AppProblem) || err.code !== 'muitas-tentativas') throw err;
      const quando = (await this.limite.proximaVez(chave, 1, COMMENTS_REFRESH_WINDOW_S)) ?? new Date(agora.getTime() + COMMENTS_REFRESH_WINDOW_S * 1000);
      const espera = Math.max(1, Math.ceil((quando.getTime() - agora.getTime()) / 1000));
      throw new AppProblem(429, 'leitura-recente', 'Leitura recente', 'Os comentários acabaram de ser pedidos. Dá para pedir de novo daqui a pouco.', { 'retry-after': String(espera) });
    }
    const tx = currentTx();
    const contas = await tx.execute<{ id: string }>(sql`
      select a.id from liame.connected_account a
       where a.brand_id = ${body.brand_id} and a.provider in (${PROVEDOR_INSTAGRAM}, ${PROVEDOR_PAGINA}) and ${contaConectada('a')}`);
    const ids = contas.rows.map((c) => c.id);
    if (ids.length) {
      // Só adianta (nunca adia), e não mexe na conta com uma leitura em andamento (o worker a pegaria duas vezes).
      await tx.execute(sql`
        update liame.sync_state s
           set cursor = s.cursor || jsonb_build_object('proxima', ${agora.toISOString()}::text, 'tudo', true), updated_at = now()
         where s.dataset = ${DATASET_DOS_COMENTARIOS} and s.connected_account_id in ${ids}
           and not (s.cursor ? 'lendo' and (s.cursor->>'lendo')::timestamptz > ${agora.toISOString()}::timestamptz - interval '30 minutes')`);
    }
    const proxima = (await this.limite.proximaVez(chave, 1, COMMENTS_REFRESH_WINDOW_S)) ?? new Date(agora.getTime() + COMMENTS_REFRESH_WINDOW_S * 1000);
    return { requested_at: agora.toISOString(), accounts: ids.length, next_at: proxima.toISOString() };
  }
}
