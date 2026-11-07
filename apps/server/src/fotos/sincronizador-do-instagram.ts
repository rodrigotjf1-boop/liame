import { createHmac } from 'node:crypto';
import { type Database, type Tx, withTenant } from '@liame/database';
import { Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { contaConectada } from '../connections/conectada.js';
import { type ClienteConector, ErroConector } from '../connectors/cliente-http.js';
import { PROVEDOR_INSTAGRAM } from '../connectors/meta/publicacao.js';
import type { FlagService } from '../flags/flag.service.js';
import { METRICAS_DO_INSTAGRAM, type NumerosDoPost, numerosDoInstagram } from '../posts/numeros-do-post.js';
import {
  CAMPOS_DA_LISTA,
  DATASET_DO_INSTAGRAM,
  esperaDaFalhaDoInstagram,
  INTERVALO_DO_INSTAGRAM_MIN,
  type PublicacaoDoInstagram,
  publicacoesDaLista,
  releDosNumeros,
} from './do-seu-instagram.js';
import { INSTAGRAM_MEDIA_LIMIT } from '@liame/contracts';

// A leitura de "Do seu Instagram" (A6 · Z10, parte 5; D-A6-71 e D-A6-83). Uma vez por dia, para cada conta do
// Instagram ligada a uma marca de empresa com as funções `fotos` e `videos` ligadas: a lista das publicações mais
// novas (`GET /{ig-user-id}/media`) e os números de cada uma (`GET /{ig-media-id}/insights`, as mesmas métricas do post
// do Liame), relidos nos primeiros 30 dias. O banco em transações curtas, antes e depois; as chamadas à Meta, sem
// transação aberta. A lista gravada espelha a conta: o que saiu de lá sai daqui. O token nunca vai para log nem banco;
// a prova do segredo do app vai no endereço, nunca o token (V161). A reserva da vez é da rotina do worker (V53).

const META = 'meta_ads';

/** O que a leitura precisa do resto do app (o mesmo que a leitura dos números dos posts; os testes trocam a Graph). */
export type DependenciasDoInstagram = {
  lerSegredo: (tx: Tx, secretId: string) => Promise<string | null>;
  cliente: () => ClienteConector;
  graphUrl: string;
  appSecret: string | null;
  versao: (capacidade: 'instagram_media' | 'instagram_insights') => Promise<string>;
  /** As funções da empresa que a leitura exige (`fotos` e `videos`), conferidas na vez. */
  ligadas: (tenantId: string, brandId: string) => Promise<boolean>;
};

/** Como terminou a vez de uma conta. */
export type ResultadoDoInstagram = {
  conta: string;
  status: 'ok' | 'desligada' | 'ignorada' | 'sem_permissao' | 'falhou';
  publicacoes?: number;
  numeros?: number;
  erro?: string;
};

/** O que fica no `cursor` do `sync_state`. */
type CursorDoInstagram = { proxima?: string; falha?: string; falhas_seguidas?: number; numeros?: 'sem_permissao' };

type LinhaDaConta = {
  id: string;
  brand_id: string;
  external_id: string;
  segredo: string | null;
  conectada: boolean;
  cursor: CursorDoInstagram | null;
};

type LinhaGuardada = { media_id: string; published_at: Date | string; metrics_read_at: Date | string | null };

/** Uma linha para gravar: a publicação da lista e, quando lidos agora, os números. */
type LinhaParaGravar = PublicacaoDoInstagram & {
  views: number | null;
  reach: number | null;
  saved: number | null;
  shares: number | null;
  metrics_read_at: string | null;
};

const iso = (v: Date | string): string => (v instanceof Date ? v : new Date(v)).toISOString();

export class SincronizadorDoInstagram {
  private readonly logger = new Logger('do-seu-instagram');

  constructor(
    private readonly database: Database,
    private readonly deps: DependenciasDoInstagram,
  ) {}

  async sincronizar(contaId: string, tenantId: string, agora: Date = new Date()): Promise<ResultadoDoInstagram> {
    const db = this.database.db;
    const depois = (ms: number) => new Date(agora.getTime() + ms).toISOString();

    // 1. A conta, o cursor, as funções e o token, numa transação curta da empresa.
    const inicio = await withTenant(db, tenantId, async (tx) => {
      const conta = (
        await tx.execute<LinhaDaConta>(sql`
          select a.id, a.brand_id, a.external_id, a.credential_secret_id as segredo,
                 coalesce(${contaConectada('a')}, false) as conectada, s.cursor
            from liame.connected_account a
            left join liame.sync_state s on s.connected_account_id = a.id and s.dataset = ${DATASET_DO_INSTAGRAM}
           where a.id = ${contaId} and a.provider = ${PROVEDOR_INSTAGRAM}`)
      ).rows[0];
      if (!conta) return { situacao: 'ignorada' as const };
      const cursor: CursorDoInstagram = conta.cursor ?? {};
      if (!conta.conectada || !conta.segredo) {
        await this.adiar(tx, contaId, tenantId, { ...cursor, proxima: depois(24 * 3_600_000) }, agora);
        return { situacao: 'ignorada' as const };
      }
      if (!(await this.deps.ligadas(tenantId, conta.brand_id))) {
        // As funções desligadas: a conta espera um dia, sem ler (V106).
        await this.adiar(tx, contaId, tenantId, { ...cursor, proxima: depois(24 * 3_600_000) }, agora);
        return { situacao: 'desligada' as const };
      }
      const token = await this.token(tx, conta.segredo);
      const guardadas = (
        await tx.execute<LinhaGuardada>(sql`select media_id, published_at, metrics_read_at from liame.instagram_media where connected_account_id = ${contaId}`)
      ).rows;
      return { situacao: 'ler' as const, conta, cursor, token, guardadas };
    }).catch(async (err: unknown) => {
      if (!(err instanceof ErroConector)) throw err;
      // O token que não está mais no cofre: como a autorização revogada.
      await withTenant(db, tenantId, (tx) => this.marcarFalha(tx, contaId, tenantId, {}, err, agora));
      return { situacao: 'falhou' as const, erro: err };
    });
    if (inicio.situacao === 'ignorada' || inicio.situacao === 'desligada') return { conta: contaId, status: inicio.situacao };
    if (inicio.situacao === 'falhou') return { conta: contaId, status: inicio.erro.tipo === 'permissao' ? 'sem_permissao' : 'falhou', erro: inicio.erro.message };
    const { conta, cursor, token, guardadas } = inicio;

    // 2. A lista, sem transação aberta.
    let lista: PublicacaoDoInstagram[];
    try {
      const corpo = await this.chamar(conta.external_id, token, await this.deps.versao('instagram_media'), `${conta.external_id}/media`, 'instagram_media', {
        fields: CAMPOS_DA_LISTA,
        limit: String(INSTAGRAM_MEDIA_LIMIT),
      });
      lista = publicacoesDaLista(corpo);
    } catch (err) {
      if (!(err instanceof ErroConector)) throw err;
      this.logger.warn(`conta ${contaId}: a lista do Instagram não veio (${err.tipo}): ${err.message}`);
      await withTenant(db, tenantId, (tx) => this.marcarFalha(tx, contaId, tenantId, cursor, err, agora));
      return { conta: contaId, status: err.tipo === 'permissao' ? 'sem_permissao' : 'falhou', erro: err.message };
    }

    // 3. Os números de cada publicação que ainda se relê. A falha de uma não para a lista: a sem permissão para os
    // números de todas; a passageira deixa as outras para a leitura de amanhã; a definitiva (a Meta não tem o número
    // daquela) pula só ela.
    const lidasAntes = new Map(guardadas.map((g) => [g.media_id, g.metrics_read_at ? iso(g.metrics_read_at) : null]));
    const numeros = new Map<string, NumerosDoPost | null>();
    let semPermissaoDosNumeros = false;
    const versaoDosNumeros = await this.deps.versao('instagram_insights');
    for (const p of lista) {
      if (!releDosNumeros(p.published_at, lidasAntes.get(p.media_id) ?? null, agora)) continue;
      try {
        const corpo = await this.chamar(conta.external_id, token, versaoDosNumeros, `${p.media_id}/insights`, 'instagram_insights', { metric: METRICAS_DO_INSTAGRAM.join(',') });
        numeros.set(p.media_id, numerosDoInstagram(corpo));
      } catch (err) {
        if (!(err instanceof ErroConector)) throw err;
        if (err.tipo === 'permissao') {
          semPermissaoDosNumeros = true;
          break;
        }
        if (err.tipo === 'definitivo') {
          this.logger.warn(`conta ${contaId}: a Meta não deu os números de uma publicação (HTTP ${err.status ?? '?'}, código ${err.codigoProvider ?? '?'})`);
          continue;
        }
        this.logger.warn(`conta ${contaId}: os números ficam para a próxima leitura (${err.tipo}): ${err.message}`);
        break;
      }
    }

    // 4. A gravação: a lista inteira (o que saiu da conta sai daqui) e o estado, numa transação curta.
    const linhas: LinhaParaGravar[] = lista.map((p) => {
      const n = numeros.get(p.media_id);
      const lidos = numeros.has(p.media_id);
      return {
        ...p,
        likes: p.likes ?? n?.likes ?? null,
        comments: p.comments ?? n?.comments ?? null,
        views: n?.views ?? null,
        reach: n?.reach ?? null,
        saved: n?.saves ?? null,
        shares: n?.shares ?? null,
        metrics_read_at: lidos ? agora.toISOString() : null,
      };
    });
    await withTenant(db, tenantId, async (tx) => {
      await this.gravar(tx, contaId, tenantId, conta.brand_id, linhas, agora);
      const proximo: CursorDoInstagram = { proxima: depois(INTERVALO_DO_INSTAGRAM_MIN * 60_000), falhas_seguidas: 0, ...(semPermissaoDosNumeros ? { numeros: 'sem_permissao' } : {}) };
      await this.marcar(tx, contaId, tenantId, { sucesso: true, erro: null, cursor: proximo }, agora);
    });
    return { conta: contaId, status: 'ok', publicacoes: linhas.length, numeros: [...numeros.values()].filter(Boolean).length };
  }

  /** Grava a lista: novas e mudadas por cima (o número que não veio agora não apaga o que já havia), e tira o que saiu. */
  private async gravar(tx: Tx, contaId: string, tenantId: string, brandId: string, linhas: LinhaParaGravar[], agora: Date): Promise<void> {
    if (linhas.length) {
      await tx.execute(sql`
        insert into liame.instagram_media (connected_account_id, tenant_id, brand_id, media_id, kind, caption, permalink, thumbnail_url, has_file,
                                           published_at, views, reach, likes, comments, saved, shares, metrics_read_at, read_at)
        select ${contaId}, ${tenantId}, ${brandId}, x.media_id, x.kind, x.caption, x.permalink, x.thumbnail_url, x.has_file,
               x.published_at, x.views, x.reach, x.likes, x.comments, x.saved, x.shares, x.metrics_read_at, ${agora.toISOString()}::timestamptz
          from jsonb_to_recordset(${JSON.stringify(linhas)}::jsonb) as x (
                 media_id text, kind text, caption text, permalink text, thumbnail_url text, has_file boolean, published_at timestamptz,
                 views bigint, reach bigint, likes bigint, comments bigint, saved bigint, shares bigint, metrics_read_at timestamptz)
        on conflict (connected_account_id, media_id) do update set
          kind = excluded.kind,
          caption = excluded.caption,
          permalink = excluded.permalink,
          thumbnail_url = excluded.thumbnail_url,
          has_file = excluded.has_file,
          published_at = excluded.published_at,
          views = coalesce(excluded.views, liame.instagram_media.views),
          reach = coalesce(excluded.reach, liame.instagram_media.reach),
          likes = coalesce(excluded.likes, liame.instagram_media.likes),
          comments = coalesce(excluded.comments, liame.instagram_media.comments),
          saved = coalesce(excluded.saved, liame.instagram_media.saved),
          shares = coalesce(excluded.shares, liame.instagram_media.shares),
          metrics_read_at = coalesce(excluded.metrics_read_at, liame.instagram_media.metrics_read_at),
          read_at = excluded.read_at`);
      await tx.execute(sql`
        delete from liame.instagram_media
         where connected_account_id = ${contaId} and media_id not in ${linhas.map((l) => l.media_id)}`);
    } else {
      await tx.execute(sql`delete from liame.instagram_media where connected_account_id = ${contaId}`);
    }
  }

  /** Grava a tentativa no `sync_state`: a que deu certo leva a hora do sucesso; a que falhou, o motivo. */
  private async marcar(tx: Tx, contaId: string, tenantId: string, o: { sucesso: boolean; erro: string | null; cursor: CursorDoInstagram }, agora: Date): Promise<void> {
    const quando = agora.toISOString();
    await tx.execute(sql`
      insert into liame.sync_state (connected_account_id, dataset, tenant_id, expected_every_minutes, last_success_at, last_attempt_at, last_error, cursor, updated_at)
      values (${contaId}, ${DATASET_DO_INSTAGRAM}, ${tenantId}, ${INTERVALO_DO_INSTAGRAM_MIN}, ${o.sucesso ? quando : null}::timestamptz, ${quando}::timestamptz,
              ${o.erro}, ${JSON.stringify(o.cursor)}::jsonb, ${quando}::timestamptz)
      on conflict (connected_account_id, dataset) do update set
        last_success_at = coalesce(excluded.last_success_at, liame.sync_state.last_success_at),
        last_attempt_at = excluded.last_attempt_at,
        last_error = excluded.last_error,
        cursor = excluded.cursor,
        updated_at = excluded.updated_at`);
  }

  /** A falha da leitura: o motivo, a espera pelo tipo e quantas seguidas. */
  private marcarFalha(tx: Tx, contaId: string, tenantId: string, cursor: CursorDoInstagram, err: ErroConector, agora: Date): Promise<void> {
    const falhas = (cursor.falhas_seguidas ?? 0) + 1;
    const espera = esperaDaFalhaDoInstagram(err.tipo, err.esperarMs);
    const texto = `${err.tipo}: ${err.message}`.slice(0, 500);
    return this.marcar(tx, contaId, tenantId, { sucesso: false, erro: texto, cursor: { proxima: new Date(agora.getTime() + espera).toISOString(), falha: err.tipo, falhas_seguidas: falhas } }, agora);
  }

  /** Muda só a próxima vez (a conta desligada ou sem as funções): não é tentativa, e o que já havia fica. */
  private async adiar(tx: Tx, contaId: string, tenantId: string, cursor: CursorDoInstagram, agora: Date): Promise<void> {
    await tx.execute(sql`
      insert into liame.sync_state (connected_account_id, dataset, tenant_id, expected_every_minutes, cursor, updated_at)
      values (${contaId}, ${DATASET_DO_INSTAGRAM}, ${tenantId}, ${INTERVALO_DO_INSTAGRAM_MIN}, ${JSON.stringify(cursor)}::jsonb, ${agora.toISOString()}::timestamptz)
      on conflict (connected_account_id, dataset) do update set cursor = excluded.cursor, updated_at = excluded.updated_at`);
  }

  private async token(tx: Tx, secretId: string): Promise<string> {
    const guardada = await this.deps.lerSegredo(tx, secretId);
    const credencial = guardada ? (JSON.parse(guardada) as { tipo?: string; access_token?: string }) : null;
    if (!credencial || credencial.tipo !== 'meta' || !credencial.access_token) throw new ErroConector('autenticacao', META, 'autorização revogada ou ausente');
    return credencial.access_token;
  }

  /** Uma leitura na Graph API: o token no cabeçalho e a prova do segredo do app no endereço (nunca o token, V161). */
  private async chamar(conta: string, token: string, versao: string, caminho: string, capacidade: string, params: Record<string, string>): Promise<unknown> {
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
