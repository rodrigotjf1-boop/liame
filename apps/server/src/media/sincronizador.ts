import { type Db, uuidv7, withTenant } from '@liame/database';
import { Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { AppConfig } from '../config.js';
import { acessoGoogle, type CredencialGuardada } from '../connections/oauth.js';
import { ClienteConector, ErroConector } from '../connectors/cliente-http.js';
import { enderecosDasPlataformas } from '../connectors/enderecos.js';
import { criarConectorGa4 } from '../connectors/ga4/conector-ga4.js';
import { criarConectorGoogleAds } from '../connectors/google-ads/conector-google-ads.js';
import { criarConectorMeta } from '../connectors/meta/conector-meta.js';
import type { ConectorLeitura, ContextoConta, ProviderId } from '../connectors/tipos.js';
import type { VaultService } from '../vault/vault.service.js';
import { gravarEntidades, idsDasEntidades } from './entidades-store.js';
import { gravarMetricas, zerarAusentes } from './metric-store.js';

// Sincronização de uma conta conectada (A2, G7; plano-a2 D-A2-3, D-A2-4, D-A2-7). Chamadas externas
// fora de transação; cada gravação numa transação curta da empresa. Janela: carga inicial de 90 dias,
// revisão longa uma vez por semana e, no resto, a janela de revisão de cada plataforma (o passado que
// ela ainda reescreve). O dia é o do fuso da conta.

/** Dias relidos a cada sincronização (D-A2-4). */
export const JANELA_REVISAO: Record<ProviderId, number> = { meta_ads: 7, google_ads: 14, ga4: 3 };
/** Dias relidos na revisão longa semanal (D-A2-4). */
export const REVISAO_LONGA: Record<ProviderId, number> = { meta_ads: 28, google_ads: 90, ga4: 3 };
export const CARGA_INICIAL_DIAS = 90;
/** Uma sincronização por dia por conta. */
export const INTERVALO_MIN = 1440;
const REVISAO_LONGA_A_CADA_DIAS = 7;
const DIA_MS = 86_400_000;

export type Cursor = { carga_inicial_em?: string; revisao_longa_em?: string; proxima?: string; falhas_seguidas?: number };

export type ResultadoSincronizacao = {
  status: 'ok' | 'falhou' | 'ignorada';
  tipo?: 'carga_inicial' | 'revisao' | 'incremental';
  janela?: { inicio: string; fim: string };
  entidades?: number;
  observacoesNovas?: number;
  zeradas?: number;
  erro?: string;
};

type LinhaConta = {
  id: string;
  tenant_id: string;
  brand_id: string;
  provider: ProviderId;
  external_id: string;
  currency: string | null;
  timezone: string | null;
  status: string;
  credential_secret_id: string | null;
  provider_attributes: Record<string, unknown>;
  cursor: Cursor | null;
};

/** O dia de hoje no fuso da conta (AAAA-MM-DD). */
export function hojeNoFuso(agora: Date, fuso: string | null): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: fuso ?? 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(agora);
  } catch {
    return agora.toISOString().slice(0, 10);
  }
}

const menosDias = (dia: string, n: number) => new Date(new Date(`${dia}T00:00:00Z`).getTime() - n * DIA_MS).toISOString().slice(0, 10);

/** Qual janela ler agora (D-A2-3, D-A2-4). */
export function janelaDaVez(provider: ProviderId, cursor: Cursor, agora: Date, fuso: string | null): { tipo: 'carga_inicial' | 'revisao' | 'incremental'; inicio: string; fim: string } {
  const fim = hojeNoFuso(agora, fuso);
  if (!cursor.carga_inicial_em) return { tipo: 'carga_inicial', inicio: menosDias(fim, CARGA_INICIAL_DIAS - 1), fim };
  const ultimaLonga = cursor.revisao_longa_em ? new Date(cursor.revisao_longa_em).getTime() : 0;
  if (agora.getTime() - ultimaLonga >= REVISAO_LONGA_A_CADA_DIAS * DIA_MS) return { tipo: 'revisao', inicio: menosDias(fim, REVISAO_LONGA[provider] - 1), fim };
  return { tipo: 'incremental', inicio: menosDias(fim, JANELA_REVISAO[provider] - 1), fim };
}

/** Espera depois de uma falha passageira: o que a plataforma pediu, ou 30 min dobrando até 12 h. */
export function esperaDepoisDaFalha(err: unknown, falhasSeguidas: number): number {
  if (err instanceof ErroConector && err.esperarMs && err.esperarMs > 0) return err.esperarMs;
  return Math.min(30 * 60_000 * 2 ** Math.max(0, falhasSeguidas - 1), 12 * 3_600_000);
}

export class Sincronizador {
  private readonly logger = new Logger('sincronizacao');

  constructor(
    private readonly db: Db,
    private readonly vault: VaultService,
    private readonly config: AppConfig,
  ) {}

  async sincronizar(contaId: string, tenantId: string, agora: Date = new Date()): Promise<ResultadoSincronizacao> {
    const lida = await withTenant(this.db, tenantId, async (tx) => {
      const r = await tx.execute<LinhaConta>(sql`
        select a.id, a.tenant_id, a.brand_id, a.provider, a.external_id, a.currency, a.timezone, a.status, a.credential_secret_id,
               a.provider_attributes, s.cursor
          from liame.connected_account a
          left join liame.sync_state s on s.connected_account_id = a.id and s.dataset = 'metricas'
         where a.id = ${contaId} and a.disconnected_at is null`);
      const conta = r.rows[0];
      if (!conta) return null;
      const segredo = conta.credential_secret_id ? await this.vault.readSecret(tx, conta.credential_secret_id) : null;
      return { conta, segredo };
    });
    if (!lida) return { status: 'ignorada' };
    const { conta } = lida;
    const cursor: Cursor = conta.cursor ?? {};
    const cliente = new ClienteConector(this.db, { enderecos: enderecosDasPlataformas(this.config.plataformas) });
    let etapa: 'entidades' | 'metricas' = 'entidades';
    let runId: string | null = null;

    try {
      if (!lida.segredo) throw new ErroConector('autenticacao', conta.provider, 'autorização revogada ou ausente');
      const credencial = JSON.parse(lida.segredo) as CredencialGuardada;
      const accessToken =
        credencial.tipo === 'meta' ? credencial.access_token : await acessoGoogle(this.config, this.config.oauth.google?.tokenUrl ?? '', credencial.refresh_token);
      const conector = await this.conector(conta.provider, cliente);
      const ctxConta: ContextoConta = {
        credencial: { accessToken },
        externalId: conta.external_id,
        timezone: conta.timezone,
        currency: conta.currency,
        loginCustomerId: typeof conta.provider_attributes?.login_customer_id === 'string' ? conta.provider_attributes.login_customer_id : null,
      };

      // Entidades (o GA4 não tem): campanhas, grupos, criativos e anúncios.
      let entidades = 0;
      if (conta.provider !== 'ga4') {
        runId = await this.abrirExecucao(conta, 'entidades', 'incremental', null, conector.apiVersion);
        const e = await conector.lerEntidades(ctxConta);
        entidades = await withTenant(this.db, tenantId, (tx) => gravarEntidades(tx, { tenantId, connectedAccountId: conta.id, provider: conta.provider }, e));
        await this.fecharExecucao(tenantId, runId, 'ok', cliente.chamadas, entidades, 0, null);
        await this.marcarEstado(tenantId, conta.id, 'entidades', null, null);
        runId = null;
      }

      // Métricas da janela da vez.
      etapa = 'metricas';
      const janela = janelaDaVez(conta.provider, cursor, agora, conta.timezone);
      const chamadasAntes = cliente.chamadas;
      runId = await this.abrirExecucao(conta, 'metricas', janela.tipo, janela, conector.apiVersion);
      const pontos = await conector.lerMetricas(ctxConta, janela);
      const observedAt = new Date();
      const ctxMetricas = {
        tenantId,
        brandId: conta.brand_id,
        connectedAccountId: conta.id,
        provider: conta.provider,
        syncRunId: runId,
        sourceVersion: conector.apiVersion,
        currency: conta.currency,
        timezone: conta.timezone,
        observedAt,
      };
      const { novas, zeradas } = await withTenant(this.db, tenantId, async (tx) => {
        const ids = await idsDasEntidades(tx, conta.id);
        for (const p of pontos) {
          if (p.level === 'ad') p.entityId = ids.ad.get(p.externalEntityId) ?? null;
          else if (p.level === 'campaign' && conta.provider !== 'ga4') p.entityId = ids.campaign.get(p.externalEntityId) ?? null;
        }
        const g = await gravarMetricas(tx, ctxMetricas, pontos);
        return { novas: g.novas, zeradas: await zerarAusentes(tx, ctxMetricas, janela) };
      });
      await this.fecharExecucao(tenantId, runId, 'ok', cliente.chamadas - chamadasAntes, 0, novas + zeradas, null);
      runId = null;
      const novoCursor: Cursor = {
        ...cursor,
        carga_inicial_em: cursor.carga_inicial_em ?? (janela.tipo === 'carga_inicial' ? agora.toISOString() : undefined),
        revisao_longa_em: janela.tipo === 'incremental' ? cursor.revisao_longa_em : agora.toISOString(),
        proxima: new Date(agora.getTime() + INTERVALO_MIN * 60_000).toISOString(),
        falhas_seguidas: 0,
      };
      await this.marcarEstado(tenantId, conta.id, 'metricas', null, novoCursor);
      if (conta.status !== 'ativa') await this.situacaoDaConta(tenantId, conta.id, 'ativa', null);
      return { status: 'ok', tipo: janela.tipo, janela: { inicio: janela.inicio, fim: janela.fim }, entidades, observacoesNovas: novas, zeradas };
    } catch (err) {
      return this.falhou(conta, cursor, etapa, runId, cliente.chamadas, err, agora);
    }
  }

  private async conector(provider: ProviderId, cliente: ClienteConector): Promise<ConectorLeitura> {
    if (provider === 'meta_ads') return criarConectorMeta(this.db, cliente, this.config.plataformas);
    if (provider === 'google_ads') return criarConectorGoogleAds(this.db, cliente, this.config.plataformas);
    return criarConectorGa4(this.db, cliente, this.config.plataformas);
  }

  private async abrirExecucao(conta: LinhaConta, dataset: string, tipo: string, janela: { inicio: string; fim: string } | null, versao: string): Promise<string> {
    const id = uuidv7();
    await withTenant(this.db, conta.tenant_id, (tx) =>
      tx.execute(sql`
        insert into liame.sync_run (id, tenant_id, connected_account_id, dataset, kind, window_start, window_end, api_version)
        values (${id}, ${conta.tenant_id}, ${conta.id}, ${dataset}, ${tipo}, ${janela?.inicio ?? null}, ${janela?.fim ?? null}, ${versao})`),
    );
    return id;
  }

  private async fecharExecucao(tenantId: string, id: string, status: 'ok' | 'falhou', chamadas: number, entidades: number, observacoes: number, erro: string | null) {
    await withTenant(this.db, tenantId, (tx) =>
      tx.execute(sql`
        update liame.sync_run set status = ${status}, calls = ${chamadas}, entities_written = ${entidades}, observations_new = ${observacoes},
               error = ${erro}, finished_at = now()
         where id = ${id}`),
    );
  }

  /** Estado por conta e conjunto de dados (frescor): sucesso limpa o erro; o cursor só muda quando vem. */
  private async marcarEstado(tenantId: string, contaId: string, dataset: 'entidades' | 'metricas', erro: string | null, cursor: Cursor | null) {
    const sucesso = erro === null;
    await withTenant(this.db, tenantId, (tx) =>
      tx.execute(sql`
        insert into liame.sync_state (connected_account_id, dataset, tenant_id, expected_every_minutes, last_success_at, last_attempt_at, last_error, cursor)
        values (${contaId}, ${dataset}, ${tenantId}, ${INTERVALO_MIN}, ${sucesso ? sql`now()` : sql`null`}, now(), ${erro}, ${JSON.stringify(cursor ?? {})}::jsonb)
        on conflict (connected_account_id, dataset) do update
           set expected_every_minutes = excluded.expected_every_minutes,
               last_success_at = case when ${sucesso}::boolean then now() else liame.sync_state.last_success_at end,
               last_attempt_at = now(), last_error = excluded.last_error,
               cursor = case when ${cursor !== null}::boolean then excluded.cursor else liame.sync_state.cursor end,
               updated_at = now()`),
    );
  }

  private async situacaoDaConta(tenantId: string, contaId: string, status: 'ativa' | 'desconectada' | 'sem_permissao' | 'erro', motivo: string | null) {
    await withTenant(this.db, tenantId, (tx) =>
      tx.execute(sql`
        update liame.connected_account set status = ${status}, status_reason = ${motivo}, updated_at = now()
         where id = ${contaId} and disconnected_at is null`),
    );
  }

  /**
   * Falha classificada: autorização recusada desliga a leitura até reconectar (vira alerta); sem permissão
   * tenta de novo no dia seguinte; o resto espera o que a plataforma pediu ou 30 min dobrando.
   */
  private async falhou(conta: LinhaConta, cursor: Cursor, etapa: 'entidades' | 'metricas', runId: string | null, chamadas: number, err: unknown, agora: Date): Promise<ResultadoSincronizacao> {
    const e = err instanceof ErroConector ? err : null;
    // Texto seguro: a mensagem do ErroConector é nossa (sem corpo da plataforma nem token).
    const texto = e ? `${e.tipo}: ${e.message}`.slice(0, 500) : 'erro interno';
    if (!e) this.logger.error(`conta ${conta.id}: ${err instanceof Error ? err.message : String(err)}`);
    else this.logger.warn(`conta ${conta.id} (${etapa}): ${texto}`);
    if (runId) await this.fecharExecucao(conta.tenant_id, runId, 'falhou', chamadas, 0, 0, texto);

    const falhas = (cursor.falhas_seguidas ?? 0) + 1;
    let espera = esperaDepoisDaFalha(err, falhas);
    if (e?.tipo === 'autenticacao') {
      await this.situacaoDaConta(conta.tenant_id, conta.id, 'desconectada', 'A plataforma recusou a autorização: conecte de novo.');
    } else if (e?.tipo === 'permissao') {
      await this.situacaoDaConta(conta.tenant_id, conta.id, 'sem_permissao', 'Falta permissão para ler esta conta na plataforma.');
      espera = INTERVALO_MIN * 60_000;
    } else if (e?.tipo === 'definitivo' || !e) {
      await this.situacaoDaConta(conta.tenant_id, conta.id, 'erro', 'A leitura falhou; tentamos de novo mais tarde.');
      espera = Math.max(espera, 6 * 3_600_000);
    }
    const novoCursor: Cursor = { ...cursor, proxima: new Date(agora.getTime() + espera).toISOString(), falhas_seguidas: falhas };
    await this.marcarEstado(conta.tenant_id, conta.id, etapa, texto, etapa === 'metricas' ? novoCursor : null);
    if (etapa === 'entidades') await this.marcarEstado(conta.tenant_id, conta.id, 'metricas', texto, novoCursor);
    return { status: 'falhou', erro: texto };
  }
}
