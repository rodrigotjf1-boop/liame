import { type Database, withSystem, withTenant } from '@liame/database';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { writeAudit } from '../audit/audit.js';
import { APP_CONFIG, type AppConfig } from '../config.js';
import type { DescobertaGuardada } from '../connections/connections.service.js';
import { contaPelaLigacao, contasPelosTokens } from '../connections/descoberta-regemcast.js';
import {
  acessoGoogle,
  type CredencialGuardada,
  type CredencialLigacaoRegem,
  type CredencialLigacaoRegemcast,
  type CredencialRegem,
  ESCOPOS_GOOGLE,
  type ProvedorOAuth,
  trocarCodigo,
} from '../connections/oauth.js';
import { ClienteConector, ErroConector } from '../connectors/cliente-http.js';
import { clienteDoDmsId, comTokenDoDmsId, recursoDoRegemcast } from '../connectors/dms/dms-id.js';
import type { ClienteDmsId } from '../connectors/dms/integracao-dms.js';
import { enderecosDasPlataformas } from '../connectors/enderecos.js';
import { PERMISSOES_DO_CLIQUE, trocarCodigoDoClique } from '../connectors/regemcast/conector-regemcast.js';
import { criarConectorGa4 } from '../connectors/ga4/conector-ga4.js';
import { criarConectorGoogleAds } from '../connectors/google-ads/conector-google-ads.js';
import { BALDE_DO_PERFIL_GOOGLE, criarConectorPerfilGoogle, type LojaDoPerfil } from '../connectors/google-business/conector-perfil-google.js';
import { ESCOPO_PERFIL_GOOGLE, FLAG_PERFIL_GOOGLE, falhaDaProcura, PROVEDOR_PERFIL_GOOGLE, type ProcuraDoPerfil } from '../connectors/google-business/perfil-google.js';
import { criarConectorMeta } from '../connectors/meta/conector-meta.js';
import { BALDE_DO_SEARCH_CONSOLE, criarConectorSearchConsole } from '../connectors/search-console/conector-search-console.js';
import {
  ESCOPO_SEARCH_CONSOLE,
  FLAG_SEARCH_CONSOLE,
  type ProcuraDosSites,
  PROVEDOR_SEARCH_CONSOLE,
  type SiteDoSearchConsole,
  TAMANHO_DO_SITE_LIGADO,
} from '../connectors/search-console/search-console.js';
import { comAcessoDaLoja, type CredencialDaLoja, PERMISSOES_DA_ESCRITA, peloToken, recursoDoRegem, recusaDaLoja } from '../connectors/regem/acesso-da-loja.js';
import { lerLoja, trocarCodigoDoCliqueRegem, trocarCodigoRegem } from '../connectors/regem/conector-regem.js';
import type { ContaDescoberta, Credencial } from '../connectors/tipos.js';
import { versaoRegistrada } from '../connectors/tipos.js';
import { DATABASE } from '../database/database.module.js';
import { FlagService } from '../flags/flag.service.js';
import { VaultService } from '../vault/vault.service.js';
import { type JobScope, tenantFilter } from './outbox-publisher.js';

/** Processando por mais que isto (worker caiu no meio) volta para a fila. */
const TRAVADA_MIN = 10;
const MAX_TENTATIVAS = 3;
/**
 * A procura das lojas do Perfil que não deu certo (o limite do Google, uma falha) é refeita uma vez por dia, sozinha:
 * é o que a tela promete enquanto o Google não libera o acesso do Liame à API. Uma chamada por dia e por autorização.
 */
export const HORAS_ENTRE_PROCURAS_DO_PERFIL = 24;

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
  private clienteDmsId: ClienteDmsId | null = null;

  constructor(
    @Inject(DATABASE) private readonly database: Database | null,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly vault: VaultService,
    private readonly flags: FlagService,
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
    type Linha = {
      provider: ProvedorOAuth;
      brand_id: string;
      redirect_uri: string;
      code_enc: string | null;
      pkce_verifier_enc: string | null;
      credential_secret_id: string | null;
      authorization_flow: string | null;
    };
    const dados = await withTenant(this.db, tenantId, async (tx) => {
      const r = await tx.execute<Linha>(sql`
        select provider, brand_id, redirect_uri, code_enc, pkce_verifier_enc, credential_secret_id, authorization_flow from liame.oauth_connection where id = ${id}`);
      const l = r.rows[0];
      if (!l) return null;
      return {
        provider: l.provider,
        brandId: l.brand_id,
        redirectUri: l.redirect_uri,
        porClique: l.authorization_flow === 'clique',
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
        accessToken =
          credencial.tipo === 'meta' ? credencial.access_token : credencial.tipo === 'google' ? await this.acessoGoogle(credencial.refresh_token) : '';
      } catch (err) {
        await this.falhar(id, tenantId, err, tentativa, false);
        return;
      }
    } else if (dados.codigo && provedor === 'regemcast') {
      // Autorização por clique (Hub DMS, B1): o código vira o segredo da ligação da conta, direto para o cofre.
      try {
        const ligacao = await this.trocarRegemcast(dados.codigo, dados.verificador, dados.redirectUri);
        credencial = ligacao;
        accessToken = '';
        await withTenant(this.db, tenantId, async (tx) => {
          const secretId = await this.vault.putSecret(tx, { tenantId, purpose: 'oauth_regemcast', plaintext: JSON.stringify(ligacao) });
          await tx.execute(sql`
            update liame.oauth_connection
               set credential_secret_id = ${secretId}, code_enc = null, pkce_verifier_enc = null,
                   scopes = array(select jsonb_array_elements_text(${JSON.stringify([...ligacao.permissoes].sort())}::jsonb)), updated_at = now()
             where id = ${id}`);
        });
      } catch (err) {
        await this.falhar(id, tenantId, err, tentativa, true);
        return;
      }
    } else if (dados.codigo && provedor === 'regem' && dados.porClique) {
      // Autorização por clique do Regem (Hub DMS, F3, parte C): o código vira uma ligação por loja, direto para o cofre.
      try {
        const ligacoes = await this.trocarRegemPeloClique(dados.codigo, dados.verificador, dados.redirectUri);
        credencial = ligacoes;
        accessToken = '';
        await withTenant(this.db, tenantId, async (tx) => {
          const secretId = await this.vault.putSecret(tx, { tenantId, purpose: 'oauth_regem', plaintext: JSON.stringify(ligacoes) });
          const escopos = [...new Set(ligacoes.lojas.flatMap((l) => l.escopos))].sort();
          await tx.execute(sql`
            update liame.oauth_connection
               set credential_secret_id = ${secretId}, code_enc = null, pkce_verifier_enc = null,
                   scopes = array(select jsonb_array_elements_text(${JSON.stringify(escopos)}::jsonb)), updated_at = now()
             where id = ${id}`);
        });
      } catch (err) {
        await this.falhar(id, tenantId, err, tentativa, true);
        return;
      }
    } else if (dados.codigo && provedor === 'regem') {
      try {
        credencial = await this.trocarRegem(dados.codigo, dados.verificador, dados.redirectUri);
        accessToken = '';
        const guardada = credencial;
        await withTenant(this.db, tenantId, async (tx) => {
          const secretId = await this.vault.putSecret(tx, { tenantId, purpose: 'oauth_regem', plaintext: JSON.stringify(guardada) });
          const escopos = [...new Set(guardada.lojas.flatMap((l) => l.escopos))].sort();
          await tx.execute(sql`
            update liame.oauth_connection
               set credential_secret_id = ${secretId}, code_enc = null, pkce_verifier_enc = null,
                   scopes = array(select jsonb_array_elements_text(${JSON.stringify(escopos)}::jsonb)), updated_at = now()
             where id = ${id}`);
        });
      } catch (err) {
        await this.falhar(id, tenantId, err, tentativa, true);
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
    let perfil: ProcuraDoPerfil | null;
    let sites: ProcuraDosSites | null;
    try {
      ({ descobertas, perfil, sites } = await this.descobrir(provedor, accessToken, credencial, { tenantId, brandId: dados.brandId }));
    } catch (err) {
      await this.falhar(id, tenantId, err, tentativa, false);
      return;
    }
    // A procura das lojas do Perfil (ou dos sites do Search Console) que não deu certo (o limite do Google, uma falha
    // passageira) não apaga as que a conexão já conhecia: elas seguem na lista, e a anotação diz o que aconteceu desta
    // vez. Sem procura (função desligada ou permissão não concedida), não fica anotação nem loja ou site.
    const manterAsLojas = perfil !== null && perfil.resultado !== 'ok';
    const manterOsSites = sites !== null && sites.resultado !== 'ok';
    const notas = { ...(perfil ? { [PROVEDOR_PERFIL_GOOGLE]: perfil } : {}), ...(sites ? { [PROVEDOR_SEARCH_CONSOLE]: sites } : {}) };
    await withTenant(this.db, tenantId, async (tx) => {
      await tx.execute(sql`
        update liame.oauth_connection
           set status = case when exists (select 1 from liame.connected_account a where a.connection_id = ${id} and a.disconnected_at is null)
                             then 'ativa' else 'aguardando_escolha' end,
               discovered = ${JSON.stringify(descobertas)}::jsonb || case when ${manterAsLojas}::boolean
                 then coalesce((select jsonb_agg(d) from jsonb_array_elements(liame.oauth_connection.discovered) as d where d ->> 'provider' = ${PROVEDOR_PERFIL_GOOGLE}), '[]'::jsonb)
                 else '[]'::jsonb end
                 || case when ${manterOsSites}::boolean
                 then coalesce((select jsonb_agg(d) from jsonb_array_elements(liame.oauth_connection.discovered) as d where d ->> 'provider' = ${PROVEDOR_SEARCH_CONSOLE}), '[]'::jsonb)
                 else '[]'::jsonb end,
               discovery_notes = (liame.oauth_connection.discovery_notes - ${PROVEDOR_PERFIL_GOOGLE}::text - ${PROVEDOR_SEARCH_CONSOLE}::text) || ${JSON.stringify(notas)}::jsonb,
               error_code = null, locked_at = null, updated_at = now()
         where id = ${id} and status = 'processando'`);
      await writeAudit(tx, {
        tenantId,
        actorType: 'system',
        actorId: null,
        actorLabel: 'Liame',
        action: 'conexao.concluir',
        resourceType: 'oauth_connection',
        resourceId: id,
        after: {
          provider: provedor,
          contas_encontradas: descobertas.length,
          ...(perfil ? { perfil_no_google: perfil.resultado } : {}),
          ...(sites ? { search_console: sites.resultado } : {}),
        },
        origin: 'worker',
      });
    });
  }

  /**
   * A procura diária das lojas do Perfil (A6, Z1): as autorizações do Google em que a última procura parou no limite
   * (o Google ainda não liberou o acesso, ou a cota acabou) ou falhou, há pelo menos um dia. Só as lojas do Perfil são
   * procuradas de novo: as contas de anúncio da autorização ficam como estão, e a situação dela não muda. A reserva
   * (SKIP LOCKED, na linha da autorização) já empurra o instante da anotação: se o worker cair no meio, a autorização
   * volta no dia seguinte. A autorização que a procura recusa (a função desligada, a permissão que saiu) perde a
   * anotação e sai da fila (V106). O relógio é o de quem chama (V34).
   */
  async procurarLojasDeNovo(limite = 3, scope: JobScope = {}, agora: Date = new Date()): Promise<number> {
    if (!this.database) return 0;
    const referencia = sql`${agora.toISOString()}::timestamptz`;
    const caminhoDoInstante = `{${PROVEDOR_PERFIL_GOOGLE},em}`;
    const reservadas = await withSystem(this.db, async (tx) => {
      const r = await tx.execute<{ id: string; tenant_id: string; brand_id: string }>(sql`
        with devidas as materialized (
          select c.id
            from liame.oauth_connection c
           where c.provider = 'google' and c.status in ('ativa', 'aguardando_escolha') and c.credential_secret_id is not null
             and c.discovery_notes -> ${PROVEDOR_PERFIL_GOOGLE}::text ->> 'resultado' in ('limite', 'falhou')
             and (c.discovery_notes -> ${PROVEDOR_PERFIL_GOOGLE}::text ->> 'em')::timestamptz <= ${referencia} - make_interval(hours => ${HORAS_ENTRE_PROCURAS_DO_PERFIL})
             ${tenantFilter(scope, sql`c.tenant_id`)}
           order by (c.discovery_notes -> ${PROVEDOR_PERFIL_GOOGLE}::text ->> 'em')::timestamptz, c.id
           limit ${limite}
           for update skip locked
        )
        update liame.oauth_connection c
           set discovery_notes = jsonb_set(c.discovery_notes, ${caminhoDoInstante}::text[], to_jsonb(${agora.toISOString()}::text)), updated_at = ${referencia}
          from devidas d
         where c.id = d.id
        returning c.id, c.tenant_id, c.brand_id`);
      return r.rows;
    });
    for (const c of reservadas) {
      try {
        await this.procurarLojasDaConexao(c.id, c.tenant_id, c.brand_id, agora);
      } catch (err) {
        // Erro inesperado (banco, cofre): fica o registro; a autorização volta no dia seguinte (LIC-001).
        this.logger.error(`lojas do Perfil no Google, conexão ${c.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return reservadas.length;
  }

  /** Procura de novo só as lojas do Perfil de uma autorização do Google e guarda o resultado. */
  private async procurarLojasDaConexao(id: string, tenantId: string, brandId: string, agora: Date): Promise<void> {
    const guardada = await withTenant(this.db, tenantId, async (tx) => {
      const r = await tx.execute<{ credential_secret_id: string | null }>(sql`select credential_secret_id from liame.oauth_connection where id = ${id}`);
      const segredo = r.rows[0]?.credential_secret_id;
      return segredo ? await this.vault.readSecret(tx, segredo) : null;
    });
    const credencial = guardada ? (JSON.parse(guardada) as CredencialGuardada) : null;
    let procura: { descobertas: DescobertaGuardada[]; perfil: ProcuraDoPerfil | null };
    if (credencial?.tipo !== 'google') {
      // A credencial saiu do cofre no meio do caminho (revogada): não há o que procurar.
      procura = { descobertas: [], perfil: null };
    } else {
      try {
        const accessToken = await this.acessoGoogle(credencial.refresh_token);
        procura = await this.procurarLojasDoPerfil(credencial.escopos, { accessToken }, { tenantId, brandId }, agora);
      } catch (err) {
        // A renovação do acesso falhou (o Google fora do ar, ou a autorização recusada): fica como falha, e a leitura
        // das contas da autorização é quem trata a recusa.
        this.logger.warn(`lojas do Perfil no Google, conexão ${id}: a renovação do acesso falhou: ${err instanceof Error ? err.message : String(err)}`);
        procura = { descobertas: [], perfil: { resultado: 'falhou', em: agora.toISOString(), lojas: 0 } };
      }
    }
    const { descobertas, perfil } = procura;
    // Achou: a lista de lojas da autorização passa a ser a do Google. Não achou (limite, falha): as lojas que ela já
    // conhecia ficam. Sem procura (a função desligada ou a permissão que saiu): não fica anotação nem loja.
    const trocarAsLojas = perfil === null || perfil.resultado === 'ok';
    await withTenant(this.db, tenantId, async (tx) => {
      const r = await tx.execute(sql`
        update liame.oauth_connection
           set discovered = case when ${trocarAsLojas}::boolean
                 then coalesce((select jsonb_agg(d) from jsonb_array_elements(liame.oauth_connection.discovered) as d where d ->> 'provider' <> ${PROVEDOR_PERFIL_GOOGLE}), '[]'::jsonb)
                      || ${JSON.stringify(descobertas)}::jsonb
                 else liame.oauth_connection.discovered end,
               discovery_notes = case when ${perfil !== null}::boolean
                 then liame.oauth_connection.discovery_notes || jsonb_build_object(${PROVEDOR_PERFIL_GOOGLE}::text, ${JSON.stringify(perfil ?? {})}::jsonb)
                 else liame.oauth_connection.discovery_notes - ${PROVEDOR_PERFIL_GOOGLE}::text end,
               updated_at = ${agora.toISOString()}::timestamptz
         where id = ${id} and status in ('ativa', 'aguardando_escolha')
        returning id`);
      // Só o que muda alguma coisa para a empresa entra na auditoria: as lojas apareceram.
      if (r.rows.length && perfil?.resultado === 'ok') {
        await writeAudit(tx, {
          tenantId,
          actorType: 'system',
          actorId: null,
          actorLabel: 'Liame',
          action: 'conexao.procurar_lojas',
          resourceType: 'oauth_connection',
          resourceId: id,
          after: { perfil_no_google: 'ok', lojas: perfil.lojas },
          origin: 'worker',
        });
      }
    });
  }

  /** Código + PKCE → um token por loja, entre servidores. Uma tentativa só: o código vale uma vez. */
  private async trocarRegem(codigo: string, verificador: string | null, redirectUri: string): Promise<CredencialRegem> {
    const regem = this.config.oauth.regem;
    if (!regem) throw new ErroConector('definitivo', 'regem', 'cliente do Regem não configurado');
    if (!verificador) throw new ErroConector('definitivo', 'regem', 'autorização do Regem sem PKCE');
    const cliente = new ClienteConector(this.db, { enderecos: enderecosDasPlataformas(this.config.plataformas, this.config.produtos), tentativas: 1 });
    const tokens = await trocarCodigoRegem(
      { cliente, apiUrl: this.config.produtos.regemApiUrl },
      { codigo, verificador, redirectUri, clientId: regem.clientId, clientSecret: regem.clientSecret },
    );
    return {
      tipo: 'regem',
      lojas: tokens.lojas.map((l) => ({ loja_id: l.loja_id, token: l.token, escopos: l.escopos })),
      obtido_em: new Date().toISOString(),
    };
  }

  /**
   * Código + PKCE → uma ligação por loja do Regem (Hub DMS, F3, parte C), entre servidores, com o token do DMS ID do
   * aplicativo do Liame (pedido de novo uma vez se o Regem o recusar: ele confere o token antes do corpo, e o código não
   * é gasto nessa recusa). Uma tentativa só da troca: o código vale uma vez.
   */
  private async trocarRegemPeloClique(codigo: string, verificador: string | null, redirectUri: string): Promise<CredencialLigacaoRegem> {
    const regemClique = this.config.oauth.regemClique;
    if (!regemClique || !this.config.dmsId) throw new ErroConector('definitivo', 'regem', 'autorização por clique do Regem não configurada');
    if (!verificador) throw new ErroConector('definitivo', 'regem', 'autorização do Regem sem PKCE');
    const clientId = this.config.dmsId.aplicativo;
    const cliente = new ClienteConector(this.db, { enderecos: enderecosDasPlataformas(this.config.plataformas, this.config.produtos), tentativas: 1 });
    const ctx = { cliente, apiUrl: regemClique.apiUrl };
    const r = await comTokenDoDmsId(
      this.dmsId(),
      recursoDoRegem(regemClique.apiUrl),
      PERMISSOES_DA_ESCRITA,
      (tokenDmsId) => trocarCodigoDoCliqueRegem(ctx, { tokenDmsId, contaChave: 'autorizacao-por-clique', clientId, codigo, verificador, redirectUri }),
      'regem',
    );
    return {
      tipo: 'regem_ligacao',
      lojas: r.lojas.map((l) => ({ loja_id: l.loja_id, ligacao: l.ligacao, prefixo: l.prefixo, escopos: l.permissoes })),
      obtido_em: new Date().toISOString(),
    };
  }

  private acessoGoogle(refreshToken: string): Promise<string> {
    return acessoGoogle(this.config, this.config.oauth.google?.tokenUrl ?? '', refreshToken);
  }

  /** O cliente do DMS ID, um por processo: guarda o token e junta os pedidos ao mesmo tempo num só. */
  private dmsId(): ClienteDmsId {
    if (!this.config.dmsId) throw new ErroConector('definitivo', 'regemcast', 'sem o aplicativo do Liame no DMS ID');
    this.clienteDmsId ??= clienteDoDmsId(this.config.dmsId);
    return this.clienteDmsId;
  }

  /** O endereço da API do RegemCast; sem ele, nada do RegemCast é lido nem trocado. */
  private apiDoRegemcast(): string {
    const apiUrl = this.config.produtos.regemcastApiUrl;
    if (!apiUrl) throw new ErroConector('definitivo', 'regemcast', 'REGEMCAST_API_URL não definida');
    return apiUrl;
  }

  /**
   * Chama o RegemCast com o token do DMS ID do aplicativo do Liame, com as permissões da autorização por clique; o
   * token recusado é pedido de novo, uma vez (o RegemCast confere o token antes do corpo: o código da troca não é gasto
   * nessa recusa). O DMS ID fora do ar é passageiro e volta para a fila.
   */
  private comTokenDoDmsId<T>(chamar: (token: string) => Promise<T>): Promise<T> {
    return comTokenDoDmsId(this.dmsId(), recursoDoRegemcast(this.apiDoRegemcast()), PERMISSOES_DO_CLIQUE, chamar);
  }

  /** Código + PKCE → o segredo da ligação da conta do RegemCast, entre servidores. Uma tentativa só: o código vale uma vez. */
  private async trocarRegemcast(codigo: string, verificador: string | null, redirectUri: string): Promise<CredencialLigacaoRegemcast> {
    if (!this.config.oauth.regemcast || !this.config.dmsId) throw new ErroConector('definitivo', 'regemcast', 'autorização por clique do RegemCast não configurada');
    if (!verificador) throw new ErroConector('definitivo', 'regemcast', 'autorização do RegemCast sem PKCE');
    const clientId = this.config.dmsId.aplicativo;
    const cliente = new ClienteConector(this.db, { enderecos: enderecosDasPlataformas(this.config.plataformas, this.config.produtos), tentativas: 1 });
    const ctx = { cliente, apiUrl: this.apiDoRegemcast() };
    const r = await this.comTokenDoDmsId((tokenDmsId) =>
      trocarCodigoDoClique(ctx, { tokenDmsId, contaChave: 'autorizacao-por-clique', clientId, codigo, verificador, redirectUri }),
    );
    return { tipo: 'regemcast_ligacao', ligacao: r.ligacao, prefixo: r.prefixo, conta_id: r.conta_id, conta: r.conta, permissoes: r.permissoes, obtido_em: r.segredo_em };
  }

  /**
   * Meta: contas de anúncio. Google: clientes do Google Ads e propriedades do GA4 (cada uma se o escopo veio) e, para a
   * empresa com cada função ligada, as lojas do Perfil da Empresa e os sites do Search Console. `perfil` e `sites`: como
   * terminou cada procura (nulo = o Liame não procurou).
   */
  private async descobrir(
    provedor: ProvedorOAuth,
    accessToken: string,
    credencial: CredencialGuardada,
    alvo: { tenantId: string; brandId: string },
  ): Promise<{ descobertas: DescobertaGuardada[]; perfil: ProcuraDoPerfil | null; sites: ProcuraDosSites | null }> {
    const cliente = new ClienteConector(this.db, { enderecos: enderecosDasPlataformas(this.config.plataformas, this.config.produtos) });
    if (credencial.tipo === 'regem') {
      return { descobertas: await descobrirLojas(cliente, this.config.produtos.regemApiUrl, credencial), perfil: null, sites: null };
    }
    if (credencial.tipo === 'regem_ligacao') {
      return { descobertas: await descobrirLojasPelaLigacao(cliente, this.config, credencial), perfil: null, sites: null };
    }
    // O token do RegemCast só vai para o RegemCast: o "Procurar as contas de novo" de uma conexão da distribuição lia a
    // loja do Regem com ele, o Regem recusava e a conexão virava erro.
    if (credencial.tipo === 'regemcast') {
      return { descobertas: await contasPelosTokens(cliente, this.apiDoRegemcast(), credencial), perfil: null, sites: null };
    }
    if (credencial.tipo === 'regemcast_ligacao') {
      const apiUrl = this.apiDoRegemcast();
      return { descobertas: [await this.comTokenDoDmsId((tokenDmsId) => contaPelaLigacao(cliente, apiUrl, tokenDmsId, credencial))], perfil: null, sites: null };
    }
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
      return { descobertas: guardar('meta_ads', await meta.descobrirContas(credencialLeitura)), perfil: null, sites: null };
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
    const [ads, ga4, lojas, sites] = await Promise.all([
      seConcedido(ESCOPOS_GOOGLE[0]!, async () => guardar('google_ads', await (await criarConectorGoogleAds(this.db, cliente, this.config.plataformas)).descobrirContas(credencialLeitura))),
      seConcedido(ESCOPOS_GOOGLE[1]!, async () => guardar('ga4', await (await criarConectorGa4(this.db, cliente, this.config.plataformas)).descobrirContas(credencialLeitura))),
      this.procurarLojasDoPerfil(escopos, credencialLeitura, alvo),
      this.procurarSites(escopos, credencialLeitura, alvo),
    ]);
    return { descobertas: [...ads, ...ga4, ...lojas.descobertas, ...sites.descobertas], perfil: lojas.perfil, sites: sites.procura };
  }

  /**
   * Os sites do Search Console (A6, Z3): só para a empresa com a função ligada E com a permissão concedida nesta
   * autorização, como as lojas do Perfil (D-A6-17). Nada do que acontece aqui derruba a conexão: o Google Ads e o GA4
   * não têm nada com isso (V42). O que aconteceu fica anotado na conexão. Uma tentativa só, sem insistir no limite.
   */
  private async procurarSites(
    escopos: string[],
    credencial: Credencial,
    alvo: { tenantId: string; brandId: string },
    agora = new Date(),
  ): Promise<{ descobertas: DescobertaGuardada[]; procura: ProcuraDosSites | null }> {
    if (!escopos.includes(ESCOPO_SEARCH_CONSOLE)) return { descobertas: [], procura: null };
    if (!(await this.flags.isEnabled(FLAG_SEARCH_CONSOLE, this.flags.context(alvo)))) return { descobertas: [], procura: null };
    const em = agora.toISOString();
    try {
      const cliente = new ClienteConector(this.db, {
        enderecos: enderecosDasPlataformas(this.config.plataformas, this.config.produtos),
        balde: BALDE_DO_SEARCH_CONSOLE,
        tentativas: 1,
      });
      const conector = await criarConectorSearchConsole(this.db, cliente, this.config.plataformas);
      const descobertas = (await conector.descobrirSites(credencial)).map(siteDescoberto).filter((d) => d !== null);
      return { descobertas, procura: { resultado: 'ok', em, sites: descobertas.length } };
    } catch (err) {
      const resultado = falhaDaProcura(err instanceof ErroConector ? err.tipo : null);
      this.logger.warn(`sites do Search Console (empresa ${alvo.tenantId}): ${resultado}: ${err instanceof Error ? err.message : String(err)}`);
      return { descobertas: [], procura: { resultado, em, sites: 0 } };
    }
  }

  /**
   * As lojas do Perfil da Empresa no Google: só para a empresa com a função ligada E com a permissão concedida nesta
   * autorização (D-A6-17). Sem a lista de permissões (credencial antiga), o Liame não procura: cada chamada gasta a
   * cota do app, que é uma só para todas as empresas.
   * Nada do que acontece aqui derruba a conexão: a cota do Perfil é zero até o Google liberar o acesso, e o Google Ads e
   * o GA4 não têm nada com isso (V42). O que aconteceu fica anotado na conexão, para a tela dizer. Uma tentativa só:
   * no limite, a procura espera a próxima vez em vez de insistir (critério A6-2).
   */
  private async procurarLojasDoPerfil(
    escopos: string[],
    credencial: Credencial,
    alvo: { tenantId: string; brandId: string },
    agora = new Date(),
  ): Promise<{ descobertas: DescobertaGuardada[]; perfil: ProcuraDoPerfil | null }> {
    if (!escopos.includes(ESCOPO_PERFIL_GOOGLE)) return { descobertas: [], perfil: null };
    if (!(await this.flags.isEnabled(FLAG_PERFIL_GOOGLE, this.flags.context(alvo)))) return { descobertas: [], perfil: null };
    const em = agora.toISOString();
    try {
      const cliente = new ClienteConector(this.db, {
        enderecos: enderecosDasPlataformas(this.config.plataformas, this.config.produtos),
        balde: BALDE_DO_PERFIL_GOOGLE,
        tentativas: 1,
      });
      const conector = await criarConectorPerfilGoogle(this.db, cliente, this.config.plataformas);
      const lojas = await conector.descobrirLojas(credencial);
      return { descobertas: lojas.map(lojaDoPerfilDescoberta), perfil: { resultado: 'ok', em, lojas: lojas.length } };
    } catch (err) {
      const resultado = falhaDaProcura(err instanceof ErroConector ? err.tipo : null);
      this.logger.warn(`lojas do Perfil no Google (empresa ${alvo.tenantId}): ${resultado}: ${err instanceof Error ? err.message : String(err)}`);
      return { descobertas: [], perfil: { resultado, em, lojas: 0 } };
    }
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

/**
 * A loja do Perfil da Empresa como conta descoberta. O código dela é a loja (`locations/…`); a conta do Perfil
 * (`accounts/…`) vai junto, porque as avaliações são lidas por conta e loja. Sem moeda e sem fuso: não é conta de anúncio.
 */
export function lojaDoPerfilDescoberta(l: LojaDoPerfil): DescobertaGuardada {
  return {
    provider: PROVEDOR_PERFIL_GOOGLE,
    external_id: l.loja,
    name: l.nome,
    currency: null,
    timezone: null,
    provider_attributes: { conta: l.conta, site: l.site, place_id: l.placeId, maps_uri: l.mapsUri },
  };
}

/**
 * O site do Search Console como conta descoberta: o código é o site como o Google o escreve, e o nome é o da tela. Sem
 * moeda e sem fuso (as datas do Search Console são as do fuso do Pacífico, e quem lê trata disso). O site com o
 * endereço mais comprido que o código de uma conta ligada aceita fica de fora (nulo).
 */
export function siteDescoberto(s: SiteDoSearchConsole): DescobertaGuardada | null {
  if (s.site.length > TAMANHO_DO_SITE_LIGADO) return null;
  return { provider: PROVEDOR_SEARCH_CONSOLE, external_id: s.site, name: s.nome, currency: null, timezone: null, provider_attributes: { permissao: s.permissao } };
}

/**
 * Lojas que os tokens alcançam (produtos DMS): cada token diz a loja dele (`GET /loja`), pelo acesso do token
 * (`acesso-da-loja.ts`: na conexão, a loja ainda não tem ligação). Token recusado fica de fora; se todos forem
 * recusados, a conexão precisa ser refeita.
 */
export async function descobrirLojas(cliente: ClienteConector, apiUrl: string, credencial: CredencialRegem): Promise<DescobertaGuardada[]> {
  const descobertas: DescobertaGuardada[] = [];
  let recusados = 0;
  for (const l of credencial.lojas) {
    const daLoja = peloToken(l.token, l.escopos);
    try {
      const loja = await lerLoja({ cliente, apiUrl }, { token: l.token, lojaChave: l.loja_id });
      descobertas.push({
        provider: credencial.tipo,
        external_id: loja.loja_id,
        name: loja.loja_nome,
        currency: loja.moeda,
        timezone: loja.fuso,
        provider_attributes: { escopos: loja.escopos, empresa: loja.empresa_nome ?? null, cardapio_url: loja.cardapio_url ?? null },
      });
    } catch (err) {
      if (err instanceof ErroConector && recusaDaLoja(daLoja, err)) {
        recusados++;
        continue;
      }
      throw err;
    }
  }
  if (!descobertas.length && recusados) throw new ErroConector('autenticacao', credencial.tipo, 'todos os tokens das lojas foram recusados');
  return descobertas;
}

/**
 * Lojas da autorização por clique do Regem (F3, parte C): cada ligação diz a loja dela (`GET /loja`), com o token do DMS
 * ID do aplicativo do Liame. A `/loja` pela ligação devolve as permissões que valem na chamada (as da loja E as do token):
 * o token pede as do aplicativo inteiro (a escrita inclui a leitura), para elas serem as que o presidente liberou. A
 * ligação recusada (`ligacao-invalida`) fica de fora; se todas forem recusadas, a conexão precisa ser refeita. A recusa
 * do token do DMS ID é do aplicativo e sobe (ERR-149).
 */
export async function descobrirLojasPelaLigacao(
  cliente: ClienteConector,
  config: Pick<AppConfig, 'dmsId' | 'produtos'>,
  credencial: CredencialLigacaoRegem,
): Promise<DescobertaGuardada[]> {
  const descobertas: DescobertaGuardada[] = [];
  let recusadas = 0;
  for (const l of credencial.lojas) {
    const daLoja: CredencialDaLoja = { via: 'ligacao', ligacao: l.ligacao, escopos: l.escopos, reserva: null };
    try {
      const loja = await comAcessoDaLoja(daLoja, config, l.loja_id, PERMISSOES_DA_ESCRITA, (a) => lerLoja({ cliente, apiUrl: config.produtos.regemApiUrl }, a));
      descobertas.push({
        provider: 'regem',
        external_id: loja.loja_id,
        name: loja.loja_nome,
        currency: loja.moeda,
        timezone: loja.fuso,
        provider_attributes: { escopos: loja.escopos, empresa: loja.empresa_nome ?? null, cardapio_url: loja.cardapio_url ?? null },
      });
    } catch (err) {
      if (err instanceof ErroConector && recusaDaLoja(daLoja, err)) {
        recusadas++;
        continue;
      }
      throw err;
    }
  }
  if (!descobertas.length && recusadas) throw new ErroConector('autenticacao', 'regem', 'todas as ligações das lojas foram recusadas');
  return descobertas;
}
