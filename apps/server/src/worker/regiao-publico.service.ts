import { createHmac } from 'node:crypto';
import { type Database, type Tx, withSystem, withTenant } from '@liame/database';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { contaConectada } from '../connections/conectada.js';
import { ClienteConector, ErroConector } from '../connectors/cliente-http.js';
import { enderecosDasPlataformas } from '../connectors/enderecos.js';
import { PROVEDOR_INSTAGRAM, PROVEDOR_PAGINA, tokenDaPagina } from '../connectors/meta/publicacao.js';
import { versaoRegistrada } from '../connectors/tipos.js';
import { DATABASE } from '../database/database.module.js';
import { FlagService } from '../flags/flag.service.js';
import { janelaDaMidia } from '../regiao/midia-paga.js';
import {
  type CidadeDoPublico,
  cidadesDevidas,
  cidadesDosSeguidores,
  DATASET_DO_PUBLICO,
  esperaDaFalhaDoPublico,
  INTERVALO_DO_PUBLICO_MIN,
  janelaEmSegundos,
  METRICAS_DA_PAGINA_NA_REGIAO,
  MINIMO_DE_SEGUIDORES,
  seguiramEDeixaram,
  seguidoresDoNo,
  somaDaPagina,
  type ToquesDoPerfil,
  toquesDoPerfil,
} from '../regiao/publico-nas-redes.js';
import { FLAG_DA_REGIAO } from '../regiao/regiao.js';
import { diaNoFuso } from '../results/fora-do-normal.js';
import { VaultService } from '../vault/vault.service.js';
import { type JobScope, tenantFilter } from './outbox-publisher.js';

// O público nas redes (plano da região, R4, parte 3; D-RG-40 a D-RG-43; base §19.7). Uma vez por dia, para cada conta
// do Instagram e Página do Facebook ligada a uma marca com a função `regiao` ligada: os seguidores agora e, nas 4 semanas
// completas até ontem (no fuso da loja), quem seguiu e quem deixou de seguir, os toques nos botões do perfil (Instagram)
// e as visitas (Página); uma vez por semana, as cidades dos seguidores do Instagram. No Instagram, o token da
// autorização lê o nó e `GET /{ig-user-id}/insights`; na Página, o token dela (pela lista das Páginas da autorização, de
// quem pode ANALYZE). O banco em transações curtas; as chamadas à Meta, sem transação aberta. A reserva da vez é desta
// rotina, em escopo de sistema, na mesma linha que a reserva altera (o `sync_state` do conjunto, ERR-029). O token nunca
// vai para log nem banco; a prova do segredo do app vai no endereço, nunca o token (V161).

const META = 'meta_ads';
/** Reserva da leitura: se o worker cair no meio, ela volta para a fila depois disto. */
const RESERVA_MIN = 30;
/** Quanto da série dos seguidores fica (D-RG-40). */
const DIAS_DA_SERIE = 400;

/** Como terminou a vez de uma conta. */
export type ResultadoDoPublico = {
  conta: string;
  status: 'ok' | 'desligada' | 'ignorada' | 'sem_permissao' | 'falhou';
  seguidores?: number | null;
  cidades?: number;
  erro?: string;
};

type CursorDoPublico = { proxima?: string; falha?: string; falhas_seguidas?: number };

type LinhaDaConta = {
  id: string;
  brand_id: string;
  provider: typeof PROVEDOR_INSTAGRAM | typeof PROVEDOR_PAGINA;
  external_id: string;
  fuso: string;
  segredo: string | null;
  conectada: boolean;
  cursor: CursorDoPublico | null;
  cidades_lidas_em: Date | string | null;
};

/** O que a leitura de uma conta trouxe (`cidades` indefinida: a de antes fica). */
type Lido = {
  seguidores: number | null;
  seguiram: number | null;
  deixaram: number | null;
  toques: ToquesDoPerfil | null;
  visitas: number | null;
  cidades?: CidadeDoPublico[] | null;
};

@Injectable()
export class RegiaoPublicoLoop {
  private readonly logger = new Logger('regiao-publico');

  constructor(
    @Inject(DATABASE) private readonly database: Database | null,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly vault: VaultService,
    private readonly flags: FlagService,
  ) {}

  async executarLote(limite = 3, scope: JobScope = {}, agora: Date = new Date()): Promise<ResultadoDoPublico[]> {
    const database = this.database;
    if (!database) return [];
    const db = database.db;
    // O relógio de quem chama vale para a fila inteira: a reserva e o que a leitura grava (V34).
    const referencia = sql`${agora.toISOString()}::timestamptz`;
    const elegivel = sql`a.provider in (${PROVEDOR_INSTAGRAM}, ${PROVEDOR_PAGINA}) and ${contaConectada('a')} and a.credential_secret_id is not null`;
    const reservadas = await withSystem(db, async (tx) => {
      // A conta desligada leva junto o que foi lido dela (`data-classes.ts`: "com a conta conectada").
      for (const tabela of [sql`liame.social_audience`, sql`liame.social_follower_daily`]) {
        await tx.execute(sql`
          delete from ${tabela} m
           using liame.connected_account a
           where a.id = m.connected_account_id and not coalesce(${contaConectada('a')}, false) ${tenantFilter(scope, sql`m.tenant_id`)}`);
      }
      await tx.execute(sql`
        insert into liame.sync_state (connected_account_id, dataset, tenant_id, expected_every_minutes, cursor)
        select a.id, ${DATASET_DO_PUBLICO}, a.tenant_id, ${INTERVALO_DO_PUBLICO_MIN}::integer, '{}'::jsonb
          from liame.connected_account a
         where ${elegivel} ${tenantFilter(scope, sql`a.tenant_id`)}
           and not exists (select 1 from liame.sync_state s where s.connected_account_id = a.id and s.dataset = ${DATASET_DO_PUBLICO})
        on conflict (connected_account_id, dataset) do nothing`);
      const r = await tx.execute<{ id: string; tenant_id: string }>(sql`
        with devidas as materialized (
          select s.connected_account_id
            from liame.sync_state s
            join liame.connected_account a on a.id = s.connected_account_id
           where s.dataset = ${DATASET_DO_PUBLICO} and ${elegivel}
             and coalesce((s.cursor->>'proxima')::timestamptz, '-infinity'::timestamptz) <= ${referencia}
             ${tenantFilter(scope, sql`a.tenant_id`)}
           order by coalesce((s.cursor->>'proxima')::timestamptz, '-infinity'::timestamptz), s.connected_account_id
           limit ${limite}
           for update of s skip locked
        )
        update liame.sync_state s
           set cursor = s.cursor || jsonb_build_object('proxima', ${referencia} + make_interval(mins => ${RESERVA_MIN})), updated_at = ${referencia}
          from devidas d
         where s.connected_account_id = d.connected_account_id and s.dataset = ${DATASET_DO_PUBLICO}
        returning s.connected_account_id as id, s.tenant_id`);
      return r.rows;
    });
    const resultados: ResultadoDoPublico[] = [];
    for (const c of reservadas) {
      try {
        resultados.push(await this.sincronizar(database, c.id, c.tenant_id, agora));
      } catch (err) {
        // Falha fora do previsto (banco): a reserva vence e a leitura volta para a fila (LIC-001).
        this.logger.error(`conta ${c.id}: ${err instanceof Error ? err.message : String(err)}`);
        resultados.push({ conta: c.id, status: 'falhou', erro: 'erro interno' });
      }
    }
    return resultados;
  }

  private async sincronizar(database: Database, contaId: string, tenantId: string, agora: Date): Promise<ResultadoDoPublico> {
    const db = database.db;
    const depois = (ms: number) => new Date(agora.getTime() + ms).toISOString();

    // 1. A conta, o cursor, a função `regiao` e o token, numa transação curta da empresa.
    const inicio = await withTenant(db, tenantId, async (tx) => {
      const conta = (
        await tx.execute<LinhaDaConta>(sql`
          select a.id, a.brand_id, a.provider, a.external_id, a.credential_secret_id as segredo,
                 coalesce(a.timezone, (select u.timezone from liame.unit u where u.brand_id = a.brand_id order by u.created_at, u.id limit 1), 'America/Sao_Paulo') as fuso,
                 coalesce(${contaConectada('a')}, false) as conectada, s.cursor, p.cities_read_at as cidades_lidas_em
            from liame.connected_account a
            left join liame.sync_state s on s.connected_account_id = a.id and s.dataset = ${DATASET_DO_PUBLICO}
            left join liame.social_audience p on p.connected_account_id = a.id
           where a.id = ${contaId} and a.provider in (${PROVEDOR_INSTAGRAM}, ${PROVEDOR_PAGINA})`)
      ).rows[0];
      if (!conta) return { situacao: 'ignorada' as const };
      const cursor: CursorDoPublico = conta.cursor ?? {};
      if (!conta.conectada || !conta.segredo) {
        await this.adiar(tx, contaId, tenantId, { ...cursor, proxima: depois(24 * 3_600_000) }, agora);
        return { situacao: 'ignorada' as const };
      }
      if (!(await this.flags.isEnabled(FLAG_DA_REGIAO, this.flags.context({ tenantId, brandId: conta.brand_id })))) {
        // A função desligada: a conta espera um dia, sem ler, e o que já foi lido fica até a conta sair.
        await this.adiar(tx, contaId, tenantId, { ...cursor, proxima: depois(24 * 3_600_000) }, agora);
        return { situacao: 'desligada' as const };
      }
      const guardada = await this.vault.readSecret(tx, conta.segredo);
      const credencial = guardada ? (JSON.parse(guardada) as { tipo?: string; access_token?: string }) : null;
      const token = credencial?.tipo === 'meta' && credencial.access_token ? credencial.access_token : null;
      return { situacao: 'ler' as const, conta, cursor, token };
    });
    if (inicio.situacao !== 'ler') return { conta: contaId, status: inicio.situacao };
    const { conta, cursor } = inicio;
    const hoje = diaNoFuso(agora, conta.fuso);
    const janela = janelaDaMidia(hoje);

    // 2. As leituras, sem transação aberta.
    let lido: Lido;
    try {
      if (!inicio.token) throw new ErroConector('autenticacao', META, 'autorização revogada ou ausente');
      const segundos = janelaEmSegundos(janela, conta.fuso);
      lido =
        conta.provider === PROVEDOR_INSTAGRAM
          ? await this.doInstagram(conta, inicio.token, segundos, cidadesDevidas(conta.cidades_lidas_em, agora))
          : await this.daPagina(conta, inicio.token, segundos);
    } catch (err) {
      if (!(err instanceof ErroConector)) throw err;
      this.logger.warn(`conta ${contaId}: o público nas redes não veio (${err.tipo}): ${err.message}`);
      await withTenant(db, tenantId, (tx) => this.marcarFalha(tx, contaId, tenantId, cursor, err, agora));
      return { conta: contaId, status: err.tipo === 'permissao' ? 'sem_permissao' : 'falhou', erro: err.message };
    }

    // 3. A gravação: a leitura nova substitui a anterior (a cidade não lida agora fica a de antes), a série ganha o dia
    // de hoje e perde o que passa de 400 dias, e o estado, numa transação curta da empresa.
    const quando = agora.toISOString();
    const cidadesLidas = lido.cidades !== undefined;
    await withTenant(db, tenantId, async (tx) => {
      await tx.execute(sql`
        insert into liame.social_audience (connected_account_id, tenant_id, brand_id, provider, day_from, day_to, followers, follows, unfollows, taps, page_views, cities, cities_read_at, read_at)
        values (${contaId}, ${tenantId}, ${conta.brand_id}, ${conta.provider}, ${janela.inicio}::date, ${janela.fim}::date, ${lido.seguidores}, ${lido.seguiram}, ${lido.deixaram},
                ${lido.toques ? JSON.stringify(lido.toques) : null}::jsonb, ${lido.visitas},
                ${cidadesLidas && lido.cidades ? JSON.stringify(lido.cidades) : null}::jsonb, ${cidadesLidas ? quando : null}::timestamptz, ${quando}::timestamptz)
        on conflict (connected_account_id) do update set
          day_from = excluded.day_from, day_to = excluded.day_to, followers = excluded.followers, follows = excluded.follows,
          unfollows = excluded.unfollows, taps = excluded.taps, page_views = excluded.page_views,
          cities = case when ${cidadesLidas}::boolean then excluded.cities else liame.social_audience.cities end,
          cities_read_at = case when ${cidadesLidas}::boolean then excluded.cities_read_at else liame.social_audience.cities_read_at end,
          read_at = excluded.read_at`);
      if (lido.seguidores !== null) {
        await tx.execute(sql`
          insert into liame.social_follower_daily (connected_account_id, tenant_id, brand_id, provider, day, followers, read_at)
          values (${contaId}, ${tenantId}, ${conta.brand_id}, ${conta.provider}, ${hoje}::date, ${lido.seguidores}, ${quando}::timestamptz)
          on conflict (connected_account_id, day) do update set followers = excluded.followers, read_at = excluded.read_at`);
      }
      await tx.execute(sql`delete from liame.social_follower_daily where connected_account_id = ${contaId} and day < ${hoje}::date - ${DIAS_DA_SERIE}::integer`);
      await this.marcar(tx, contaId, tenantId, { sucesso: true, erro: null, cursor: { proxima: depois(INTERVALO_DO_PUBLICO_MIN * 60_000), falhas_seguidas: 0 } }, agora);
    });
    return { conta: contaId, status: 'ok', seguidores: lido.seguidores, ...(cidadesLidas ? { cidades: lido.cidades?.length ?? 0 } : {}) };
  }

  /**
   * O Instagram: o nó (os seguidores), quem seguiu e deixou de seguir e os toques no perfil da janela e, quando devida, a
   * cidade dos seguidores. Com menos de 100 seguidores, o Instagram não informa quem seguiu nem a cidade: nem se pergunta.
   * A métrica que a Meta recusa por definição (a conta que ela não tem o número) fica nula; o resto continua.
   */
  private async doInstagram(conta: LinhaDaConta, token: string, s: { since: number; until: number }, cidadesDaVez: boolean): Promise<Lido> {
    const versao = await versaoRegistrada(this.db(), META, 'instagram_insights');
    const no = await this.chamar(conta.external_id, token, versao, conta.external_id, 'instagram_insights', { fields: 'followers_count' });
    const seguidores = seguidoresDoNo(no);
    const comPublico = seguidores !== null && seguidores >= MINIMO_DE_SEGUIDORES;
    const janela = { period: 'day', metric_type: 'total_value', since: String(s.since), until: String(s.until) };
    const insights = (params: Record<string, string>) => this.opcional(conta, () => this.chamar(conta.external_id, token, versao, `${conta.external_id}/insights`, 'instagram_insights', params));
    const seguir = comPublico ? seguiramEDeixaram(await insights({ metric: 'follows_and_unfollows', breakdown: 'follow_type', ...janela })) : null;
    const toques = toquesDoPerfil(await insights({ metric: 'profile_links_taps', breakdown: 'contact_button_type', ...janela }));
    let cidades: CidadeDoPublico[] | null | undefined;
    if (!comPublico) cidades = seguidores === null ? undefined : null;
    else if (cidadesDaVez) {
      const corpo = await insights({ metric: 'follower_demographics', period: 'lifetime', metric_type: 'total_value', breakdown: 'city', timeframe: 'this_month' });
      cidades = corpo === null ? undefined : cidadesDosSeguidores(corpo);
    }
    return { seguidores, seguiram: seguir?.seguiram ?? null, deixaram: seguir?.deixaram ?? null, toques, visitas: null, ...(cidades !== undefined ? { cidades } : {}) };
  }

  /** A Página: pelo token dela (de quem pode analisar), os seguidores agora e, na janela, quem seguiu, quem saiu e as visitas. */
  private async daPagina(conta: LinhaDaConta, tokenDaAutorizacao: string, s: { since: number; until: number }): Promise<Lido> {
    const db = this.db();
    const contas = await this.chamar(conta.external_id, tokenDaAutorizacao, await versaoRegistrada(db, META, 'pages'), 'me/accounts', 'pages', { fields: 'id,access_token,tasks', limit: '100' });
    const pagina = tokenDaPagina(contas, conta.external_id);
    // Ler os números da Página pede o token dela, de quem pode analisar (ANALYZE).
    if (!pagina || !pagina.podeAnalisar) throw new ErroConector('permissao', META, 'a autorização não pode analisar esta Página (ANALYZE)');
    const versao = await versaoRegistrada(db, META, 'pagina_insights');
    const no = await this.chamar(conta.external_id, pagina.token, versao, conta.external_id, 'pagina_insights', { fields: 'followers_count' });
    const corpo = await this.opcional(conta, () =>
      this.chamar(conta.external_id, pagina.token, versao, `${conta.external_id}/insights`, 'pagina_insights', {
        metric: METRICAS_DA_PAGINA_NA_REGIAO.join(','),
        period: 'day',
        since: String(s.since),
        until: String(s.until),
      }),
    );
    return {
      seguidores: seguidoresDoNo(no),
      seguiram: somaDaPagina(corpo, 'page_daily_follows_unique'),
      deixaram: somaDaPagina(corpo, 'page_daily_unfollows_unique'),
      toques: null,
      visitas: somaDaPagina(corpo, 'page_views_total'),
    };
  }

  /** Uma métrica que a Meta pode recusar por definição (HTTP 400: a conta sem o número): nula, com aviso no log. */
  private async opcional(conta: LinhaDaConta, chamada: () => Promise<unknown>): Promise<unknown> {
    try {
      return await chamada();
    } catch (err) {
      if (!(err instanceof ErroConector) || err.tipo !== 'definitivo') throw err;
      this.logger.warn(`conta ${conta.id}: a Meta não deu um número da conta (HTTP ${err.status ?? '?'}, código ${err.codigoProvider ?? '?'}): ${err.message}`);
      return null;
    }
  }

  private db(): Database['db'] {
    return this.database!.db;
  }

  /** Uma leitura na Graph API: o token no cabeçalho e a prova do segredo do app no endereço (nunca o token, V161). */
  private async chamar(contaExterna: string, token: string, versao: string, caminho: string, capacidade: string, params: Record<string, string>): Promise<unknown> {
    const q = new URLSearchParams(params);
    const segredo = this.config.plataformas.metaAppSecret;
    if (segredo) q.set('appsecret_proof', createHmac('sha256', segredo).update(token).digest('hex'));
    // Uma tentativa por chamada: a leitura que falha volta para a fila pela espera do tipo da falha.
    const cliente = new ClienteConector(this.db(), { enderecos: enderecosDasPlataformas(this.config.plataformas), tentativas: 1 });
    const r = await cliente.requisitar<unknown>({
      provider: META,
      conta: contaExterna,
      url: `${this.config.plataformas.metaGraphUrl}/${versao}/${caminho}?${q.toString()}`,
      metodo: 'GET',
      endpoint: capacidade,
      apiVersion: versao,
      cabecalhos: { authorization: `Bearer ${token}` },
    });
    return r.corpo;
  }

  /** Grava a tentativa no `sync_state`: a que deu certo leva a hora do sucesso; a que falhou, o motivo. */
  private async marcar(tx: Tx, contaId: string, tenantId: string, o: { sucesso: boolean; erro: string | null; cursor: CursorDoPublico }, agora: Date): Promise<void> {
    const quando = agora.toISOString();
    await tx.execute(sql`
      insert into liame.sync_state (connected_account_id, dataset, tenant_id, expected_every_minutes, last_success_at, last_attempt_at, last_error, cursor, updated_at)
      values (${contaId}, ${DATASET_DO_PUBLICO}, ${tenantId}, ${INTERVALO_DO_PUBLICO_MIN}, ${o.sucesso ? quando : null}::timestamptz, ${quando}::timestamptz,
              ${o.erro}, ${JSON.stringify(o.cursor)}::jsonb, ${quando}::timestamptz)
      on conflict (connected_account_id, dataset) do update set
        last_success_at = coalesce(excluded.last_success_at, liame.sync_state.last_success_at),
        last_attempt_at = excluded.last_attempt_at,
        last_error = excluded.last_error,
        cursor = excluded.cursor,
        updated_at = excluded.updated_at`);
  }

  /** A falha da leitura: o motivo, a espera pelo tipo e quantas seguidas; o que já foi lido fica. */
  private marcarFalha(tx: Tx, contaId: string, tenantId: string, cursor: CursorDoPublico, err: ErroConector, agora: Date): Promise<void> {
    const falhas = (cursor.falhas_seguidas ?? 0) + 1;
    const espera = esperaDaFalhaDoPublico(err.tipo, err.esperarMs);
    const texto = `${err.tipo}: ${err.message}`.slice(0, 500);
    return this.marcar(tx, contaId, tenantId, { sucesso: false, erro: texto, cursor: { proxima: new Date(agora.getTime() + espera).toISOString(), falha: err.tipo, falhas_seguidas: falhas } }, agora);
  }

  /** Muda só a próxima vez (a conta desligada ou sem a função): não é tentativa, e o que já havia fica. */
  private async adiar(tx: Tx, contaId: string, tenantId: string, cursor: CursorDoPublico, agora: Date): Promise<void> {
    await tx.execute(sql`
      insert into liame.sync_state (connected_account_id, dataset, tenant_id, expected_every_minutes, cursor, updated_at)
      values (${contaId}, ${DATASET_DO_PUBLICO}, ${tenantId}, ${INTERVALO_DO_PUBLICO_MIN}, ${JSON.stringify(cursor)}::jsonb, ${agora.toISOString()}::timestamptz)
      on conflict (connected_account_id, dataset) do update set cursor = excluded.cursor, updated_at = excluded.updated_at`);
  }
}
