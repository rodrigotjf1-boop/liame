import { type Database, withSystem, withTenant } from '@liame/database';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { writeAudit } from '../audit/audit.js';
import { APP_CONFIG, type AppConfig } from '../config.js';
import type { DescobertaGuardada } from '../connections/connections.service.js';
import { acessoGoogle, type CredencialGuardada, ESCOPOS_GOOGLE, type ProvedorOAuth, trocarCodigo } from '../connections/oauth.js';
import { ClienteConector, ErroConector } from '../connectors/cliente-http.js';
import { enderecosDasPlataformas } from '../connectors/enderecos.js';
import { criarConectorGa4 } from '../connectors/ga4/conector-ga4.js';
import { criarConectorGoogleAds } from '../connectors/google-ads/conector-google-ads.js';
import { criarConectorMeta } from '../connectors/meta/conector-meta.js';
import type { ContaDescoberta } from '../connectors/tipos.js';
import { versaoRegistrada } from '../connectors/tipos.js';
import { DATABASE } from '../database/database.module.js';
import { VaultService } from '../vault/vault.service.js';
import { type JobScope, tenantFilter } from './outbox-publisher.js';

/** Processando por mais que isto (worker caiu no meio) volta para a fila. */
const TRAVADA_MIN = 10;
const MAX_TENTATIVAS = 3;

type Reclamada = { id: string; tenant_id: string; attempts: number };

/**
 * Conclui as conexões que voltaram da plataforma (A2, G3): troca o código pela credencial, guarda no
 * cofre e descobre as contas que ela alcança. Chamadas externas fora de transação; cada gravação numa
 * transação curta da empresa. A troca grava a credencial antes da descoberta: o código vale uma vez, e
 * uma descoberta que falhar tenta de novo só com a credencial.
 */
@Injectable()
export class ConexaoProcessor {
  private readonly logger = new Logger('conexoes');

  constructor(
    @Inject(DATABASE) private readonly database: Database | null,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly vault: VaultService,
  ) {}

  private get db() {
    if (!this.database) throw new Error('conexoes: sem banco');
    return this.database.db;
  }

  async processarLote(limite = 5, scope: JobScope = {}): Promise<number> {
    if (!this.database) return 0;
    const reclamadas = await withSystem(this.db, async (tx) => {
      // Autorização que não voltou no prazo não volta mais.
      await tx.execute(sql`
        update liame.oauth_connection set status = 'expirada', pkce_verifier_enc = null, updated_at = now()
         where status = 'aguardando_autorizacao' and expires_at < now() ${tenantFilter(scope, sql`tenant_id`)}`);
      await tx.execute(sql`
        update liame.oauth_connection
           set status = case when attempts >= ${MAX_TENTATIVAS} then 'erro' else 'recebida' end,
               error_code = case when attempts >= ${MAX_TENTATIVAS} then 'tempo_esgotado' else error_code end,
               code_enc = case when attempts >= ${MAX_TENTATIVAS} then null else code_enc end,
               locked_at = null, updated_at = now()
         where status = 'processando' and locked_at < now() - make_interval(mins => ${TRAVADA_MIN}) ${tenantFilter(scope, sql`tenant_id`)}`);
      const r = await tx.execute<Reclamada>(sql`
        select id, tenant_id, attempts from liame.oauth_connection
         where status = 'recebida' ${tenantFilter(scope, sql`tenant_id`)}
         order by updated_at limit ${limite}
         for update skip locked`);
      if (r.rows.length) {
        await tx.execute(sql`
          update liame.oauth_connection set status = 'processando', locked_at = now(), attempts = attempts + 1, updated_at = now()
           where id in ${r.rows.map((x) => x.id)}`);
      }
      return r.rows;
    });
    for (const c of reclamadas) {
      try {
        await this.concluir(c.id, c.tenant_id, c.attempts + 1);
      } catch (err) {
        // Erro inesperado (banco, cofre): registra e deixa a trava vencer para tentar de novo (LIC-001).
        this.logger.error(`conexão ${c.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return reclamadas.length;
  }

  private async concluir(id: string, tenantId: string, tentativa: number): Promise<void> {
    type Linha = { provider: ProvedorOAuth; redirect_uri: string; code_enc: string | null; pkce_verifier_enc: string | null; credential_secret_id: string | null };
    const dados = await withTenant(this.db, tenantId, async (tx) => {
      const r = await tx.execute<Linha>(sql`
        select provider, redirect_uri, code_enc, pkce_verifier_enc, credential_secret_id from liame.oauth_connection where id = ${id}`);
      const l = r.rows[0];
      if (!l) return null;
      return {
        provider: l.provider,
        redirectUri: l.redirect_uri,
        codigo: l.code_enc ? await this.vault.decryptForTenant(tx, tenantId, `oauth_code:${id}`, l.code_enc) : null,
        verificador: l.pkce_verifier_enc ? await this.vault.decryptForTenant(tx, tenantId, `oauth_pkce:${id}`, l.pkce_verifier_enc) : null,
        credencial: l.credential_secret_id ? await this.vault.readSecret(tx, l.credential_secret_id) : null,
      };
    });
    if (!dados) return;
    const provedor = dados.provider;

    // Etapa 1: o código vira credencial (uma vez só) e vai para o cofre na hora.
    let accessToken: string;
    let credencial: CredencialGuardada;
    if (dados.credencial) {
      credencial = JSON.parse(dados.credencial) as CredencialGuardada;
      try {
        accessToken = credencial.tipo === 'meta' ? credencial.access_token : await this.acessoGoogle(credencial.refresh_token);
      } catch (err) {
        await this.falhar(id, tenantId, err, tentativa, false);
        return;
      }
    } else if (dados.codigo) {
      try {
        const versaoMeta = await versaoRegistrada(this.db, 'meta_ads', 'accounts');
        const troca = await trocarCodigo(
          provedor,
          this.config,
          { graph: this.config.plataformas.metaGraphUrl, googleToken: this.config.oauth.google?.tokenUrl ?? '' },
          { codigo: dados.codigo, redirectUri: dados.redirectUri, verificador: dados.verificador, versaoMeta },
        );
        credencial = troca.credencial;
        accessToken = troca.accessToken;
        await withTenant(this.db, tenantId, async (tx) => {
          const secretId = await this.vault.putSecret(tx, { tenantId, purpose: provedor === 'meta' ? 'oauth_meta' : 'oauth_google', plaintext: JSON.stringify(troca.credencial) });
          await tx.execute(sql`
            update liame.oauth_connection
               set credential_secret_id = ${secretId}, code_enc = null, pkce_verifier_enc = null, scopes = array(select jsonb_array_elements_text(${JSON.stringify(troca.escopos)}::jsonb)),
                   refresh_expires_at = ${troca.refreshExpiraEm?.toISOString() ?? null}, updated_at = now()
             where id = ${id}`);
        });
      } catch (err) {
        await this.falhar(id, tenantId, err, tentativa, true);
        return;
      }
    } else {
      await this.falhar(id, tenantId, new ErroConector('definitivo', provedor, 'conexão sem código nem credencial'), tentativa, false);
      return;
    }

    // Etapa 2: descobrir as contas que a credencial alcança.
    let descobertas: DescobertaGuardada[];
    try {
      descobertas = await this.descobrir(provedor, accessToken, credencial);
    } catch (err) {
      await this.falhar(id, tenantId, err, tentativa, false);
      return;
    }
    await withTenant(this.db, tenantId, async (tx) => {
      await tx.execute(sql`
        update liame.oauth_connection
           set status = case when exists (select 1 from liame.connected_account a where a.connection_id = ${id} and a.disconnected_at is null)
                             then 'ativa' else 'aguardando_escolha' end,
               discovered = ${JSON.stringify(descobertas)}::jsonb, error_code = null, locked_at = null, updated_at = now()
         where id = ${id} and status = 'processando'`);
      await writeAudit(tx, {
        tenantId,
        actorType: 'system',
        actorId: null,
        actorLabel: 'Liame',
        action: 'conexao.concluir',
        resourceType: 'oauth_connection',
        resourceId: id,
        after: { provider: provedor, contas_encontradas: descobertas.length },
        origin: 'worker',
      });
    });
  }

  private acessoGoogle(refreshToken: string): Promise<string> {
    return acessoGoogle(this.config, this.config.oauth.google?.tokenUrl ?? '', refreshToken);
  }

  /** Meta: contas de anúncio. Google: clientes do Google Ads e propriedades do GA4 (cada uma se o escopo veio). */
  private async descobrir(provedor: ProvedorOAuth, accessToken: string, credencial: CredencialGuardada): Promise<DescobertaGuardada[]> {
    const cliente = new ClienteConector(this.db, { enderecos: enderecosDasPlataformas(this.config.plataformas) });
    const credencialLeitura = { accessToken };
    const guardar = (provider: DescobertaGuardada['provider'], contas: ContaDescoberta[]) =>
      contas.map(
        (c): DescobertaGuardada => ({
          provider,
          external_id: c.externalId,
          name: c.name,
          currency: c.currency,
          timezone: c.timezone,
          provider_attributes: c.providerAttributes ?? {},
        }),
      );
    if (provedor === 'meta') {
      const meta = await criarConectorMeta(this.db, cliente, this.config.plataformas);
      return guardar('meta_ads', await meta.descobrirContas(credencialLeitura));
    }
    const escopos = credencial.tipo === 'google' ? credencial.escopos : [];
    // Escopo não concedido (a pessoa desmarcou na tela do Google) ou sem acesso: aquela plataforma fica vazia.
    const seConcedido = async (escopo: string, ler: () => Promise<DescobertaGuardada[]>) => {
      if (escopos.length && !escopos.includes(escopo)) return [];
      try {
        return await ler();
      } catch (err) {
        if (err instanceof ErroConector && (err.tipo === 'permissao' || err.tipo === 'definitivo')) return [];
        throw err;
      }
    };
    const [ads, ga4] = await Promise.all([
      seConcedido(ESCOPOS_GOOGLE[0]!, async () => guardar('google_ads', await (await criarConectorGoogleAds(this.db, cliente, this.config.plataformas)).descobrirContas(credencialLeitura))),
      seConcedido(ESCOPOS_GOOGLE[1]!, async () => guardar('ga4', await (await criarConectorGa4(this.db, cliente, this.config.plataformas)).descobrirContas(credencialLeitura))),
    ]);
    return [...ads, ...ga4];
  }

  /**
   * Falha passageira volta para a fila (até 3 tentativas); o resto vira erro com um código que a tela
   * explica. `naTroca`: o código ainda não virou credencial (só se repete se o erro foi passageiro).
   */
  private async falhar(id: string, tenantId: string, err: unknown, tentativa: number, naTroca: boolean): Promise<void> {
    const e = err instanceof ErroConector ? err : null;
    const passageiro = e !== null && ['transitorio', 'limite', 'circuito_aberto'].includes(e.tipo);
    const deNovo = passageiro && tentativa < MAX_TENTATIVAS;
    const codigo = !e
      ? 'erro_interno'
      : e.tipo === 'autenticacao'
        ? naTroca
          ? 'troca_recusada'
          : 'credencial_recusada'
        : e.tipo === 'permissao'
          ? 'sem_permissao'
          : passageiro
            ? 'plataforma_indisponivel'
            : 'falha_na_plataforma';
    this.logger.warn(`conexão ${id}: ${codigo}${deNovo ? ' (vai tentar de novo)' : ''}: ${err instanceof Error ? err.message : String(err)}`);
    await withTenant(this.db, tenantId, async (tx) => {
      await tx.execute(sql`
        update liame.oauth_connection
           set status = ${deNovo ? 'recebida' : 'erro'}, error_code = ${codigo}, locked_at = null, updated_at = now(),
               code_enc = case when ${deNovo}::boolean then code_enc else null end,
               pkce_verifier_enc = case when ${deNovo}::boolean then pkce_verifier_enc else null end
         where id = ${id} and status = 'processando'`);
      if (!deNovo) {
        await writeAudit(tx, {
          tenantId,
          actorType: 'system',
          actorId: null,
          actorLabel: 'Liame',
          action: 'conexao.falhar',
          resourceType: 'oauth_connection',
          resourceId: id,
          after: { error_code: codigo },
          origin: 'worker',
        });
      }
    });
  }
}
