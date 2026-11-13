import { type Database, type Tx, withSystem, withTenant } from '@liame/database';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { contaConectada } from '../connections/conectada.js';
import { acessoGoogle, type CredencialGuardada } from '../connections/oauth.js';
import { ClienteConector, ErroConector } from '../connectors/cliente-http.js';
import { enderecosDasPlataformas } from '../connectors/enderecos.js';
import { criarConectorGoogleAds } from '../connectors/google-ads/conector-google-ads.js';
import { criarConectorMeta } from '../connectors/meta/conector-meta.js';
import type { ContextoConta } from '../connectors/tipos.js';
import { DATABASE } from '../database/database.module.js';
import { FlagService } from '../flags/flag.service.js';
import { type CidadeLida, DATASET_DA_MIDIA, esperaDaFalhaDaMidia, type HoraLida, INTERVALO_DA_MIDIA_MIN, janelaDaMidia, type LugarLido } from '../regiao/midia-paga.js';
import { FLAG_DA_REGIAO } from '../regiao/regiao.js';
import { diaNoFuso } from '../results/fora-do-normal.js';
import { VaultService } from '../vault/vault.service.js';
import { type JobScope, tenantFilter } from './outbox-publisher.js';

// A mídia por região e por hora (plano da região, R4, parte 1; base §19.7). Uma vez por dia, para cada conta de anúncio
// (Meta e Google) ligada a uma marca com a função `regiao` ligada: as 4 semanas completas até ontem, no fuso da conta,
// por dia e por hora (as duas) e por dia e cidade (só o Google), com o nome dos lugares novos. A janela lida substitui a
// guardada. O banco em transações curtas; as chamadas às plataformas, sem transação aberta. A reserva da vez é desta
// rotina, em escopo de sistema, na mesma linha que a reserva altera (o `sync_state` do conjunto, ERR-029).

/** Reserva da leitura: se o worker cair no meio, ela volta para a fila depois disto. */
const RESERVA_MIN = 30;
const PROVEDORES = ['meta_ads', 'google_ads'] as const;
/**
 * A versão da leitura, no cursor: 1 = a hora e a cidade (R4, parte 1); 2 = mais o local mais específico do Google (a
 * medição dos bairros). A conta lida por uma versão anterior fica devida já, sem esperar o dia: a leitura nova sai logo
 * depois do deploy (a migration entra antes do merge e não pode antecipá-la).
 */
const VERSAO_DA_LEITURA = 2;
type Provedor = (typeof PROVEDORES)[number];

/** Como terminou a vez de uma conta. */
export type ResultadoDaMidia = {
  conta: string;
  status: 'ok' | 'desligada' | 'ignorada' | 'sem_permissao' | 'falhou';
  horas?: number;
  cidades?: number;
  locais?: number;
  erro?: string;
};

type CursorDaMidia = { proxima?: string; falha?: string; falhas_seguidas?: number; cidades?: 'falhou'; locais?: 'falhou'; versao?: number };

type LinhaDaConta = {
  id: string;
  brand_id: string;
  provider: Provedor;
  external_id: string;
  timezone: string | null;
  currency: string | null;
  provider_attributes: Record<string, unknown> | null;
  segredo: string | null;
  conectada: boolean;
  cursor: CursorDaMidia | null;
};

@Injectable()
export class RegiaoMidiaLoop {
  private readonly logger = new Logger('regiao-midia');

  constructor(
    @Inject(DATABASE) private readonly database: Database | null,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly vault: VaultService,
    private readonly flags: FlagService,
  ) {}

  async executarLote(limite = 3, scope: JobScope = {}, agora: Date = new Date()): Promise<ResultadoDaMidia[]> {
    const database = this.database;
    if (!database) return [];
    const db = database.db;
    // O relógio de quem chama vale para a fila inteira: a reserva e o que a leitura grava (V34).
    const referencia = sql`${agora.toISOString()}::timestamptz`;
    const elegivel = sql`a.provider in ('meta_ads', 'google_ads') and ${contaConectada('a')} and a.credential_secret_id is not null`;
    const reservadas = await withSystem(db, async (tx) => {
      // A conta desligada leva junto o que foi lido dela (`data-classes.ts`: "com a conta conectada"); os pedidos por
      // bairro da loja do Regem (R3, parte 2) também saem aqui, na mesma limpeza da região.
      for (const tabela of [sql`liame.ad_hour_daily`, sql`liame.ad_city_daily`, sql`liame.ad_local_daily`, sql`liame.region_order_district`]) {
        await tx.execute(sql`
          delete from ${tabela} m
           using liame.connected_account a
           where a.id = m.connected_account_id and not coalesce(${contaConectada('a')}, false) ${tenantFilter(scope, sql`m.tenant_id`)}`);
      }
      await tx.execute(sql`
        insert into liame.sync_state (connected_account_id, dataset, tenant_id, expected_every_minutes, cursor)
        select a.id, ${DATASET_DA_MIDIA}, a.tenant_id, ${INTERVALO_DA_MIDIA_MIN}::integer, '{}'::jsonb
          from liame.connected_account a
         where ${elegivel} ${tenantFilter(scope, sql`a.tenant_id`)}
           and not exists (select 1 from liame.sync_state s where s.connected_account_id = a.id and s.dataset = ${DATASET_DA_MIDIA})
        on conflict (connected_account_id, dataset) do nothing`);
      const r = await tx.execute<{ id: string; tenant_id: string }>(sql`
        with devidas as materialized (
          select s.connected_account_id
            from liame.sync_state s
            join liame.connected_account a on a.id = s.connected_account_id
           where s.dataset = ${DATASET_DA_MIDIA} and ${elegivel}
             and (coalesce((s.cursor->>'proxima')::timestamptz, '-infinity'::timestamptz) <= ${referencia}
                  or coalesce((s.cursor->>'versao')::integer, 1) < ${VERSAO_DA_LEITURA}::integer)
             ${tenantFilter(scope, sql`a.tenant_id`)}
           order by coalesce((s.cursor->>'proxima')::timestamptz, '-infinity'::timestamptz), s.connected_account_id
           limit ${limite}
           for update of s skip locked
        )
        update liame.sync_state s
           set cursor = s.cursor || jsonb_build_object('proxima', ${referencia} + make_interval(mins => ${RESERVA_MIN}), 'versao', ${VERSAO_DA_LEITURA}::integer),
               updated_at = ${referencia}
          from devidas d
         where s.connected_account_id = d.connected_account_id and s.dataset = ${DATASET_DA_MIDIA}
        returning s.connected_account_id as id, s.tenant_id`);
      return r.rows;
    });
    const resultados: ResultadoDaMidia[] = [];
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

  private async sincronizar(database: Database, contaId: string, tenantId: string, agora: Date): Promise<ResultadoDaMidia> {
    const db = database.db;
    const depois = (ms: number) => new Date(agora.getTime() + ms).toISOString();

    // 1. A conta, o cursor, a função `regiao` e o segredo, numa transação curta da empresa.
    const inicio = await withTenant(db, tenantId, async (tx) => {
      const conta = (
        await tx.execute<LinhaDaConta>(sql`
          select a.id, a.brand_id, a.provider, a.external_id, a.timezone, a.currency, a.provider_attributes,
                 a.credential_secret_id as segredo, coalesce(${contaConectada('a')}, false) as conectada, s.cursor
            from liame.connected_account a
            left join liame.sync_state s on s.connected_account_id = a.id and s.dataset = ${DATASET_DA_MIDIA}
           where a.id = ${contaId} and a.provider in ('meta_ads', 'google_ads')`)
      ).rows[0];
      if (!conta) return { situacao: 'ignorada' as const };
      const cursor: CursorDaMidia = conta.cursor ?? {};
      if (!conta.conectada || !conta.segredo) {
        await this.adiar(tx, contaId, tenantId, { ...cursor, proxima: depois(24 * 3_600_000) }, agora);
        return { situacao: 'ignorada' as const };
      }
      if (!(await this.flags.isEnabled(FLAG_DA_REGIAO, this.flags.context({ tenantId, brandId: conta.brand_id })))) {
        // A função desligada: a conta espera um dia, sem ler, e o que já foi lido fica até a conta sair.
        await this.adiar(tx, contaId, tenantId, { ...cursor, proxima: depois(24 * 3_600_000) }, agora);
        return { situacao: 'desligada' as const };
      }
      const segredo = await this.vault.readSecret(tx, conta.segredo);
      return { situacao: 'ler' as const, conta, cursor, segredo };
    });
    if (inicio.situacao !== 'ler') return { conta: contaId, status: inicio.situacao };
    const { conta, cursor } = inicio;

    // 2. As leituras, sem transação aberta.
    const janela = janelaDaMidia(diaNoFuso(agora, conta.timezone ?? 'America/Sao_Paulo'));
    let horas: HoraLida[];
    let cidades: CidadeLida[] | null = null;
    let lugares: LugarLido[] = [];
    let cidadesFalharam = false;
    let locais: CidadeLida[] | null = null;
    let locaisFalharam = false;
    try {
      if (!inicio.segredo) throw new ErroConector('autenticacao', conta.provider, 'autorização revogada ou ausente');
      const credencial = JSON.parse(inicio.segredo) as CredencialGuardada;
      if (credencial.tipo !== 'meta' && credencial.tipo !== 'google') throw new ErroConector('definitivo', conta.provider, 'credencial que não é de anúncio');
      const accessToken = credencial.tipo === 'meta' ? credencial.access_token : await acessoGoogle(this.config, this.config.oauth.google?.tokenUrl ?? '', credencial.refresh_token);
      const ctx: ContextoConta = {
        credencial: { accessToken },
        externalId: conta.external_id,
        timezone: conta.timezone,
        currency: conta.currency,
        loginCustomerId: typeof conta.provider_attributes?.login_customer_id === 'string' ? conta.provider_attributes.login_customer_id : null,
      };
      // Uma tentativa por chamada: a leitura que falha volta para a fila pela espera do tipo da falha.
      const cliente = new ClienteConector(db, { enderecos: enderecosDasPlataformas(this.config.plataformas), tentativas: 1 });
      if (conta.provider === 'meta_ads') {
        horas = await (await criarConectorMeta(db, cliente, this.config.plataformas)).lerHoras(ctx, janela);
      } else {
        const google = await criarConectorGoogleAds(db, cliente, this.config.plataformas);
        horas = await google.lerHoras(ctx, janela);
        // A cidade e o local mais específico (a medição dos bairros) são extras da hora: o que falhar sem ser a
        // autorização fica o de antes, e a hora vale.
        const extra = async <T,>(nome: string, leitura: () => Promise<T>): Promise<T | null> => {
          try {
            return await leitura();
          } catch (err) {
            if (!(err instanceof ErroConector) || err.tipo === 'autenticacao') throw err;
            this.logger.warn(`conta ${contaId}: ${nome} dos anúncios do Google não veio (${err.tipo}): ${err.message}`);
            return null;
          }
        };
        cidades = await extra('a cidade', () => google.lerCidades(ctx, janela));
        cidadesFalharam = cidades === null;
        locais = await extra('o local mais específico', () => google.lerLocais(ctx, janela));
        locaisFalharam = locais === null;
        // O nome e o tipo dos lugares novos das duas leituras; sem eles, o lugar aparece pelo id até a leitura seguinte.
        const ids = [...new Set([...(cidades ?? []), ...(locais ?? [])].map((c) => c.lugar))];
        const conhecidos = await this.lugaresConhecidos(db, ids);
        const novos = ids.filter((id) => !conhecidos.has(id));
        if (novos.length) lugares = (await extra('o nome dos lugares', () => google.lerLugares(ctx, novos))) ?? [];
      }
    } catch (err) {
      if (!(err instanceof ErroConector)) throw err;
      this.logger.warn(`conta ${contaId}: a mídia por hora não veio (${err.tipo}): ${err.message}`);
      await withTenant(db, tenantId, (tx) => this.marcarFalha(tx, contaId, tenantId, cursor, err, agora));
      return { conta: contaId, status: err.tipo === 'permissao' ? 'sem_permissao' : 'falhou', erro: err.message };
    }

    // 3. A gravação: a janela lida substitui a guardada, e o estado, numa transação curta da empresa.
    await withTenant(db, tenantId, async (tx) => {
      await tx.execute(sql`
        delete from liame.ad_hour_daily where connected_account_id = ${contaId} and day between ${janela.inicio}::date and ${janela.fim}::date`);
      if (horas.length) {
        await tx.execute(sql`
          insert into liame.ad_hour_daily (connected_account_id, tenant_id, brand_id, provider, day, hour, impressions, clicks, spend, conversions, read_at)
          select ${contaId}, ${tenantId}, ${conta.brand_id}, ${conta.provider}, x.dia, x.hora, x.impressoes, x.cliques, x.gasto, x.conversoes, ${agora.toISOString()}::timestamptz
            from jsonb_to_recordset(${JSON.stringify(horas)}::jsonb) as x (dia date, hora smallint, impressoes bigint, cliques bigint, gasto numeric, conversoes numeric)
           where x.dia between ${janela.inicio}::date and ${janela.fim}::date`);
      }
      // As semanas que saíram da janela também saem daqui: só as 4 mais novas ficam.
      await tx.execute(sql`delete from liame.ad_hour_daily where connected_account_id = ${contaId} and day < ${janela.inicio}::date`);
      if (cidades) {
        await tx.execute(sql`delete from liame.ad_city_daily where connected_account_id = ${contaId}`);
        if (cidades.length) {
          await tx.execute(sql`
            insert into liame.ad_city_daily (connected_account_id, tenant_id, brand_id, provider, day, geo_target_id, impressions, clicks, spend, conversions, read_at)
            select ${contaId}, ${tenantId}, ${conta.brand_id}, 'google_ads', x.dia, x.lugar, x.impressoes, x.cliques, x.gasto, x.conversoes, ${agora.toISOString()}::timestamptz
              from jsonb_to_recordset(${JSON.stringify(cidades)}::jsonb) as x (dia date, lugar bigint, impressoes bigint, cliques bigint, gasto numeric, conversoes numeric)
             where x.dia between ${janela.inicio}::date and ${janela.fim}::date`);
        }
      }
      if (locais) {
        await tx.execute(sql`delete from liame.ad_local_daily where connected_account_id = ${contaId}`);
        if (locais.length) {
          await tx.execute(sql`
            insert into liame.ad_local_daily (connected_account_id, tenant_id, brand_id, provider, day, geo_target_id, impressions, clicks, spend, conversions, read_at)
            select ${contaId}, ${tenantId}, ${conta.brand_id}, 'google_ads', x.dia, x.lugar, x.impressoes, x.cliques, x.gasto, x.conversoes, ${agora.toISOString()}::timestamptz
              from jsonb_to_recordset(${JSON.stringify(locais)}::jsonb) as x (dia date, lugar bigint, impressoes bigint, cliques bigint, gasto numeric, conversoes numeric)
             where x.dia between ${janela.inicio}::date and ${janela.fim}::date`);
        }
      }
      const proximo: CursorDaMidia = {
        proxima: depois(INTERVALO_DA_MIDIA_MIN * 60_000),
        falhas_seguidas: 0,
        ...(cidadesFalharam ? { cidades: 'falhou' } : {}),
        ...(locaisFalharam ? { locais: 'falhou' } : {}),
      };
      await this.marcar(tx, contaId, tenantId, { sucesso: true, erro: null, cursor: proximo }, agora);
    });
    // O nome dos lugares novos: tabela do sistema, gravada em escopo de sistema.
    if (lugares.length) {
      await withSystem(db, (tx) =>
        tx.execute(sql`
          insert into liame.region_geo_target (id, name, canonical_name, target_type, country_code, fetched_at)
          select x.id, x.nome, x."nomeCompleto", x.tipo, x.pais, ${agora.toISOString()}::timestamptz
            from jsonb_to_recordset(${JSON.stringify(lugares)}::jsonb) as x (id bigint, nome text, "nomeCompleto" text, tipo text, pais text)
          on conflict (id) do update set name = excluded.name, canonical_name = excluded.canonical_name, target_type = excluded.target_type,
                                         country_code = excluded.country_code, fetched_at = excluded.fetched_at`),
      );
    }
    return { conta: contaId, status: 'ok', horas: horas.length, ...(cidades ? { cidades: cidades.length } : {}), ...(locais ? { locais: locais.length } : {}) };
  }

  /** Os lugares que o Liame já sabe o nome (a tabela do sistema, que todos leem). */
  private async lugaresConhecidos(db: Database['db'], ids: string[]): Promise<Set<string>> {
    if (!ids.length) return new Set();
    const r = await withSystem(db, (tx) =>
      tx.execute<{ id: string }>(sql`select id::text as id from liame.region_geo_target where id = any(${`{${ids.join(',')}}`}::bigint[])`),
    );
    return new Set(r.rows.map((x) => x.id));
  }

  /** Grava a tentativa no `sync_state`: a que deu certo leva a hora do sucesso; a que falhou, o motivo. */
  private async marcar(tx: Tx, contaId: string, tenantId: string, o: { sucesso: boolean; erro: string | null; cursor: CursorDaMidia }, agora: Date): Promise<void> {
    const quando = agora.toISOString();
    await tx.execute(sql`
      insert into liame.sync_state (connected_account_id, dataset, tenant_id, expected_every_minutes, last_success_at, last_attempt_at, last_error, cursor, updated_at)
      values (${contaId}, ${DATASET_DA_MIDIA}, ${tenantId}, ${INTERVALO_DA_MIDIA_MIN}, ${o.sucesso ? quando : null}::timestamptz, ${quando}::timestamptz,
              ${o.erro}, ${JSON.stringify({ ...o.cursor, versao: VERSAO_DA_LEITURA })}::jsonb, ${quando}::timestamptz)
      on conflict (connected_account_id, dataset) do update set
        last_success_at = coalesce(excluded.last_success_at, liame.sync_state.last_success_at),
        last_attempt_at = excluded.last_attempt_at,
        last_error = excluded.last_error,
        cursor = excluded.cursor,
        updated_at = excluded.updated_at`);
  }

  /** A falha da leitura: o motivo, a espera pelo tipo e quantas seguidas. */
  private marcarFalha(tx: Tx, contaId: string, tenantId: string, cursor: CursorDaMidia, err: ErroConector, agora: Date): Promise<void> {
    const falhas = (cursor.falhas_seguidas ?? 0) + 1;
    const espera = esperaDaFalhaDaMidia(err.tipo, err.esperarMs);
    const texto = `${err.tipo}: ${err.message}`.slice(0, 500);
    return this.marcar(tx, contaId, tenantId, { sucesso: false, erro: texto, cursor: { proxima: new Date(agora.getTime() + espera).toISOString(), falha: err.tipo, falhas_seguidas: falhas } }, agora);
  }

  /** Muda só a próxima vez (a conta desligada ou sem a função): não é tentativa, e o que já havia fica. */
  private async adiar(tx: Tx, contaId: string, tenantId: string, cursor: CursorDaMidia, agora: Date): Promise<void> {
    await tx.execute(sql`
      insert into liame.sync_state (connected_account_id, dataset, tenant_id, expected_every_minutes, cursor, updated_at)
      values (${contaId}, ${DATASET_DA_MIDIA}, ${tenantId}, ${INTERVALO_DA_MIDIA_MIN}, ${JSON.stringify({ ...cursor, versao: VERSAO_DA_LEITURA })}::jsonb, ${agora.toISOString()}::timestamptz)
      on conflict (connected_account_id, dataset) do update set cursor = excluded.cursor, updated_at = excluded.updated_at`);
  }
}
