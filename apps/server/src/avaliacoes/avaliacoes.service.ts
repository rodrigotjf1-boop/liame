import type { ReviewAuthorsResponse, ReviewItem, ReviewsResponse, ReviewStore } from '@liame/contracts';
import type { Database } from '@liame/database';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { avaliacaoDoRecurso } from '../actions/perfil-avaliacao.js';
import { TOOLS } from '../actions/tools.js';
import { naTransacaoDaEmpresa } from '../ai/na-empresa.js';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { acessoGoogle, type CredencialGuardada } from '../connections/oauth.js';
import { ClienteConector, ErroConector } from '../connectors/cliente-http.js';
import { enderecosDasPlataformas } from '../connectors/enderecos.js';
import { BALDE_DO_PERFIL_GOOGLE, criarConectorPerfilGoogle } from '../connectors/google-business/conector-perfil-google.js';
import { ESCOPO_PERFIL_GOOGLE, FLAG_PERFIL_GOOGLE, FLAG_PERFIL_GOOGLE_ESCRITA, procuraGuardada, PROVEDOR_PERFIL_GOOGLE } from '../connectors/google-business/perfil-google.js';
import { type AuthContext, currentTx } from '../context/request-context.js';
import { DATABASE } from '../database/database.module.js';
import { AppProblem } from '../errors/problems.js';
import { FlagService } from '../flags/flag.service.js';
import { VaultService } from '../vault/vault.service.js';
import { DATASET_AVALIACOES } from './sincronizador-do-perfil.js';

// A tela Avaliações (A6, Z1; protótipo P17, aprovado em 09/10/2026): o que o Liame guardou das lojas do perfil da
// empresa no Google ligadas à marca, e em que pé está a ligação. Só leitura: responder uma avaliação é um pedido de
// ação (Z2).
//
// Duas rotas. `ver` lê do banco do Liame, na transação da requisição. `quemAvaliou` lê do Google, na hora, o nome de
// quem fez as avaliações mais recentes, só para a tela mostrar: **nada disso é guardado, nem escrito em registro**
// (D-A6-5; critério A6-1). Por falar com o Google, ela é `@SemTransacao`: o banco numa transação curta e o Google
// depois, sem transação aberta.

/** Quantas avaliações a tela recebe de uma vez. */
export const AVALIACOES_NA_TELA = 200;
/** A ferramenta do pedido de resposta (`actions/tools.ts`). */
const FERRAMENTA_DA_RESPOSTA = 'avaliacao_responder';
/** A tela olha as avaliações feitas nos últimos 30 dias à parte (a caixa "Nos últimos 30 dias"). */
const DIAS_RECENTES = 30;
/** Há uma pessoa esperando a tela: o Google tem este tempo para responder, e o Liame não fica esperando ficha de cota. */
const TEMPO_DO_GOOGLE_MS = 8_000;
const ESPERA_PELA_COTA_MS = 2_000;
/** As lojas de que a tela lê os nomes, e quantos nomes por loja. */
const LOJAS_COM_NOME = 3;
const NOMES_POR_LOJA = 100;

type LinhaLoja = {
  id: string;
  name: string;
  status: string;
  status_reason: string | null;
  rating: string | null;
  review_count: number | null;
  lida_em: Date | string | null;
  falha: string | null;
  espera_ate: string | null;
};
type LinhaAvaliacao = {
  id: string;
  store_id: string;
  stars: number;
  comment: string | null;
  reviewed_at: Date | string;
  changed_at: Date | string;
  reply_text: string | null;
  reply_state: string | null;
  reply_changed_at: Date | string | null;
  reply_violation: string | null;
};

const iso = (v: Date | string) => new Date(v).toISOString();
const isoOuNulo = (v: Date | string | null) => (v ? iso(v) : null);
const umaCasa = (n: number) => Math.round(n * 10) / 10;

const marcaNaoEncontrada = () => new AppProblem(404, 'nao-encontrado', 'Não encontramos', 'Marca não encontrada nesta empresa.');

/** A nota da empresa: a da loja ou, com mais de uma, a média das lojas pesada pelo total de avaliações de cada uma. */
export function notaDaEmpresa(lojas: Array<{ rating: number | null; review_count: number | null }>): { rating: number | null; review_count: number | null } {
  const comNota = lojas.filter((l): l is { rating: number; review_count: number | null } => l.rating !== null);
  const totais = lojas.filter((l) => l.review_count !== null).map((l) => l.review_count as number);
  const total = totais.length ? totais.reduce((s, n) => s + n, 0) : null;
  if (!comNota.length) return { rating: null, review_count: total };
  const peso = (l: { review_count: number | null }) => (l.review_count && l.review_count > 0 ? l.review_count : 1);
  const soma = comNota.reduce((s, l) => s + peso(l), 0);
  return { rating: Math.min(5, Math.max(1, Math.round((comNota.reduce((s, l) => s + l.rating * peso(l), 0) / soma) * 100) / 100)), review_count: total };
}

/**
 * Sem loja ligada, o que falta: a autorização do Google (ou a escolha da loja), a permissão do perfil, ou o Google
 * liberar o acesso do Liame. `conexoes`: as autorizações do Google da marca que estão valendo.
 */
export function estadoSemLoja(conexoes: Array<{ scopes: string[]; discovery_notes: unknown; lojas: number }>): 'sem_perfil' | 'sem_permissao' | 'esperando_google' {
  if (!conexoes.length) return 'sem_perfil';
  const comPermissao = conexoes.filter((c) => c.scopes.includes(ESCOPO_PERFIL_GOOGLE));
  if (!comPermissao.length) return 'sem_permissao';
  // Com loja para escolher em alguma autorização, o caminho é Contas conectadas, mesmo que outra ainda espere o Google.
  if (comPermissao.some((c) => c.lojas > 0)) return 'sem_perfil';
  return comPermissao.some((c) => procuraGuardada(c.discovery_notes)?.resultado === 'limite') ? 'esperando_google' : 'sem_perfil';
}

@Injectable()
export class AvaliacoesService {
  private readonly logger = new Logger('avaliacoes');

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(DATABASE) private readonly database: Database | null,
    private readonly flags: FlagService,
    private readonly vault: VaultService,
  ) {}

  private banco(): Database {
    if (!this.database) throw new Error('avaliações: sem banco');
    return this.database;
  }

  private ligada(auth: AuthContext, brandId: string): Promise<boolean> {
    return this.flags.isEnabled(FLAG_PERFIL_GOOGLE, this.flags.context({ tenantId: auth.tenantId, userId: auth.userId, brandId }));
  }

  /** O que a tela Avaliações mostra, do banco do Liame. */
  async ver(auth: AuthContext, brandId: string, agora = new Date()): Promise<ReviewsResponse> {
    const tx = currentTx();
    const marca = await tx.execute(sql`select 1 from liame.brand where id = ${brandId} and archived_at is null`);
    if (!marca.rows[0]) throw marcaNaoEncontrada();
    const base = { brand_id: brandId, stores: [], summary: null, reviews: [], has_more: false, pending_replies: [], can_reply: false, generated_at: agora.toISOString() };
    if (!(await this.ligada(auth, brandId))) return { ...base, state: 'desligada' };

    const lojas = await tx.execute<LinhaLoja>(sql`
      select a.id, a.name, a.status, a.status_reason, p.rating::text as rating, p.review_count, s.last_success_at as lida_em,
             s.cursor ->> 'falha' as falha, s.cursor ->> 'espera_ate' as espera_ate
        from liame.connected_account a
        left join liame.profile_summary p on p.connected_account_id = a.id
        left join liame.sync_state s on s.connected_account_id = a.id and s.dataset = ${DATASET_AVALIACOES}
       where a.provider = ${PROVEDOR_PERFIL_GOOGLE} and a.disconnected_at is null and a.brand_id = ${brandId}
       order by a.name, a.id`);
    if (!lojas.rows.length) {
      const conexoes = await tx.execute<{ scopes: string[] | null; discovery_notes: unknown; lojas: number }>(sql`
        select c.scopes, c.discovery_notes,
               (select count(*)::int from jsonb_array_elements(c.discovered) as d where d ->> 'provider' = ${PROVEDOR_PERFIL_GOOGLE}) as lojas
          from liame.oauth_connection c
         where c.brand_id = ${brandId} and c.provider = 'google' and c.status in ('ativa', 'aguardando_escolha')`);
      return { ...base, state: estadoSemLoja(conexoes.rows.map((c) => ({ scopes: c.scopes ?? [], discovery_notes: c.discovery_notes, lojas: c.lojas }))) };
    }

    const stores: ReviewStore[] = lojas.rows.map((l) => {
      const espera = l.falha === 'limite' && l.espera_ate ? Date.parse(l.espera_ate) : Number.NaN;
      return {
        id: l.id,
        name: l.name,
        status: l.status,
        status_reason: l.status_reason,
        rating: l.rating === null ? null : Number(l.rating),
        review_count: l.review_count,
        read_at: isoOuNulo(l.lida_em),
        waiting_until: espera > agora.getTime() ? new Date(espera).toISOString() : null,
      };
    });
    const ids = lojas.rows.map((l) => l.id);
    const instante = sql`${agora.toISOString()}::timestamptz`;
    const [numeros] = (
      await tx.execute<{ sem_resposta: number; mais_antiga: Date | string | null; recentes: number; media_recente: string | null }>(sql`
        select count(*) filter (where r.reply_text is null)::int as sem_resposta,
               min(r.reviewed_at) filter (where r.reply_text is null) as mais_antiga,
               count(*) filter (where r.reviewed_at >= ${instante} - make_interval(days => ${DIAS_RECENTES}))::int as recentes,
               avg(r.stars) filter (where r.reviewed_at >= ${instante} - make_interval(days => ${DIAS_RECENTES}))::text as media_recente
          from liame.profile_review r
         where r.connected_account_id in ${ids}`)
    ).rows;
    // As sem resposta primeiro; depois as que o Google recusou, as que ele confere e as respondidas. Em cada grupo, das
    // notas mais baixas para as mais altas e, na mesma nota, da mais recente para a mais antiga (P17).
    const avaliacoes = await tx.execute<LinhaAvaliacao>(sql`
      select r.id, r.connected_account_id as store_id, r.stars, r.comment, r.reviewed_at, r.changed_at,
             r.reply_text, r.reply_state, r.reply_changed_at, r.reply_violation
        from liame.profile_review r
       where r.connected_account_id in ${ids}
       order by case when r.reply_text is null then 0 when r.reply_state = 'recusada' then 1 when r.reply_state = 'pendente' then 2 else 3 end,
                r.stars, r.reviewed_at desc, r.id
       limit ${AVALIACOES_NA_TELA + 1}`);
    const reviews: ReviewItem[] = avaliacoes.rows.slice(0, AVALIACOES_NA_TELA).map((r) => ({
      id: r.id,
      store_id: r.store_id,
      stars: r.stars,
      text: r.comment,
      reviewed_at: iso(r.reviewed_at),
      changed_at: iso(r.changed_at),
      reply: r.reply_text === null ? null : { text: r.reply_text, state: r.reply_state ?? 'desconhecida', changed_at: isoOuNulo(r.reply_changed_at), violation: r.reply_violation },
    }));
    // As respostas que esperam a aprovação de uma pessoa (A6, Z2): a tela leva ao pedido, em Aprovações.
    const pendentes = await tx.execute<{ id: string; resource_id: string; before_state: Record<string, unknown> | null }>(sql`
      select q.id, q.resource_id, q.before_state
        from liame.action_request q
       where q.provider = ${PROVEDOR_PERFIL_GOOGLE} and q.tool = ${FERRAMENTA_DA_RESPOSTA} and q.status = 'aguardando_aprovacao' and q.account_id in ${ids}
       order by q.created_at, q.id`);
    const soODono = TOOLS[FERRAMENTA_DA_RESPOSTA]?.ownerOnly;
    const pending_replies = pendentes.rows.flatMap((q) => {
      const avaliacao = avaliacaoDoRecurso(q.resource_id);
      return avaliacao ? [{ review_id: avaliacao, action_id: q.id, owner_only: Boolean(q.before_state && soODono?.(q.before_state)) }] : [];
    });
    return {
      ...base,
      state: 'pronta',
      stores,
      summary: {
        ...notaDaEmpresa(stores),
        unanswered: numeros?.sem_resposta ?? 0,
        oldest_unanswered_at: isoOuNulo(numeros?.mais_antiga ?? null),
        last_30_days: { count: numeros?.recentes ?? 0, average: numeros?.media_recente ? umaCasa(Number(numeros.media_recente)) : null },
      },
      reviews,
      has_more: avaliacoes.rows.length > AVALIACOES_NA_TELA,
      pending_replies,
      // Responder pelo Liame é outra função, ligada à parte (a escrita no Perfil): sem ela, a resposta é dada no Google.
      can_reply: await this.flags.isEnabled(FLAG_PERFIL_GOOGLE_ESCRITA, this.flags.context({ tenantId: auth.tenantId, userId: auth.userId, brandId })),
    };
  }

  /**
   * Quem fez as avaliações mais recentes de cada loja, lido do Google agora. O nome sai daqui para a tela e para mais
   * lugar nenhum: não é gravado no banco nem escrito em registro. A loja que o Google não responde fica sem nomes, e a
   * tela mostra as avaliações do mesmo jeito.
   */
  async quemAvaliou(auth: AuthContext, brandId: string): Promise<ReviewAuthorsResponse> {
    const quem = { tenantId: auth.tenantId!, userId: auth.userId };
    const lojas = await naTransacaoDaEmpresa(this.banco(), quem, async () => {
      const tx = currentTx();
      const marca = await tx.execute(sql`select 1 from liame.brand where id = ${brandId} and archived_at is null`);
      if (!marca.rows[0]) throw marcaNaoEncontrada();
      if (!(await this.ligada(auth, brandId))) return null;
      const r = await tx.execute<{ id: string; external_id: string; conta: string | null; credential_secret_id: string | null }>(sql`
        select a.id, a.external_id, a.provider_attributes ->> 'conta' as conta, a.credential_secret_id
          from liame.connected_account a
         where a.provider = ${PROVEDOR_PERFIL_GOOGLE} and a.disconnected_at is null and a.status = 'ativa' and a.brand_id = ${brandId}
         order by a.name, a.id
         limit ${LOJAS_COM_NOME}`);
      const lidas: Array<{ id: string; loja: string; conta: string; renovacao: string; avaliacoes: Map<string, string> }> = [];
      for (const l of r.rows) {
        const guardada = l.credential_secret_id ? await this.vault.readSecret(tx, l.credential_secret_id) : null;
        const credencial = guardada ? (JSON.parse(guardada) as CredencialGuardada) : null;
        if (credencial?.tipo !== 'google' || !l.conta) continue;
        // O id da avaliação no Liame, pelo id dela no Google: é o que liga o nome lido agora à linha da tela.
        const doLiame = await tx.execute<{ id: string; external_id: string }>(sql`
          select id, external_id from liame.profile_review where connected_account_id = ${l.id} order by changed_at desc limit ${AVALIACOES_NA_TELA}`);
        lidas.push({ id: l.id, loja: l.external_id, conta: l.conta, renovacao: credencial.refresh_token, avaliacoes: new Map(doLiame.rows.map((a) => [a.external_id, a.id])) });
      }
      return lidas;
    });
    if (lojas === null) return { status: 'desligada', items: [] };
    if (!lojas.length) return { status: 'ok', items: [] };

    const cliente = new ClienteConector(this.banco().db, {
      enderecos: enderecosDasPlataformas(this.config.plataformas, this.config.produtos),
      balde: BALDE_DO_PERFIL_GOOGLE,
      tentativas: 1,
      esperaMaximaMs: ESPERA_PELA_COTA_MS,
      tempoLimiteMs: TEMPO_DO_GOOGLE_MS,
    });
    const conector = await criarConectorPerfilGoogle(this.banco().db, cliente, this.config.plataformas);
    const items: ReviewAuthorsResponse['items'] = [];
    let falhas = 0;
    for (const l of lojas) {
      try {
        const accessToken = await acessoGoogle(this.config, this.config.oauth.google?.tokenUrl ?? '', l.renovacao);
        const nomes = await conector.lerQuemAvaliou({ accessToken }, { conta: l.conta, loja: l.loja }, { maximo: NOMES_POR_LOJA, tempoLimiteMs: TEMPO_DO_GOOGLE_MS });
        for (const n of nomes) {
          const id = l.avaliacoes.get(n.id);
          if (id) items.push({ review_id: id, name: n.nome });
        }
      } catch (err) {
        falhas++;
        // Só o tipo da falha vai para o registro: nada do que o Google respondeu.
        this.logger.warn(`nomes de quem avaliou, loja ${l.id}: ${err instanceof ErroConector ? err.tipo : 'erro interno'}`);
      }
    }
    return { status: falhas === 0 ? 'ok' : falhas === lojas.length ? 'indisponivel' : 'parcial', items };
  }
}
