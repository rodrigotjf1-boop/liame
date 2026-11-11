import { createHmac } from 'node:crypto';
import type { Tx } from '@liame/database';
import { Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import {
  campanhaNovaDoRecurso,
  EstadoDaCampanhaNova,
  type MidiaNaMeta,
  type ParametrosDaMeta,
  parametrosDaCampanha,
  parametrosDoAnuncio,
  parametrosDoConjunto,
  parametrosDoCriativo,
} from '../campanhas/campanha-nova-plano.js';
import { contaConectada } from '../connections/conectada.js';
import type { CredencialGuardada } from '../connections/oauth.js';
import { type ClienteConector, ErroConector } from '../connectors/cliente-http.js';
import { VIDEO_EM_PREPARO } from '../connectors/meta/publicacao.js';
import { chaveDaMiniatura } from '../fotos/conferencia.js';
import type { ArmazemDeImagens } from '../imagens/armazem.js';
import type { ApplyOptions, ApplyResult, Connector, ReadResult, ResourceRef } from './connectors.js';
import { recusaDaMeta } from './meta-anuncios.js';
import type { ResourceState } from './tools.js';

// A campanha nova na Meta, criada pausada (A4, X5, parte 1; D-A4-31, D-A4-35, D-A4-40 e D-A4-41; base de conhecimento
// §2.1, reconferida em 11/11/2026). O recurso é a campanha nova do Liame (`campanha_nova:<id>`, a tabela
// `ad_campaign_new`), na conta de anúncios do pedido. Depois da aprovação com o código do app, o conector cria, nesta
// ordem, a campanha, o conjunto, o vídeo (quando a mídia é um vídeo), o criativo e o anúncio, todos pausados:
// - cada objeto passa antes pela validação da Meta (`execution_options=["validate_only"]`) e vai com a chave de
//   idempotência do passo (`X-Client-Idempotent-Key`): a mesma chave não cria de novo;
// - o id de cada objeto criado fica guardado na linha logo depois: a tentativa seguinte (a Meta mandou esperar, ou o
//   vídeo ainda está sendo preparado) continua dali, sem criar de novo;
// - a recusa da Meta encerra a criação com o motivo; o que já foi criado fica na Meta, pausado, e nada se apaga (D-A4-31);
// - a foto e a capa do vídeo vão pelo endereço assinado do armazenamento (a Meta guarda a imagem na biblioteca da conta);
//   o vídeo, pelo `file_url`, e a Meta prepara antes de o criativo poder usá-lo (até 15 minutos).
// O token da empresa sai do cofre só na hora de chamar e nunca vai para log, estado ou auditoria.

const PROVIDER = 'meta_ads';

/** Quanto o endereço assinado da mídia vale para a Meta buscar (a validação e a criação buscam de novo). */
const VALIDADE_DA_MIDIA_S = 60 * 60;
/** Quanto a Meta pode levar preparando o vídeo antes de a criação desistir. */
const PREPARO_DO_VIDEO_MS = 15 * 60_000;
/** A espera entre as conferências do vídeo (a Meta recomenda conferir uma vez por minuto). */
const ESPERA_DO_VIDEO_MS = 60_000;

/** O que o conector precisa do resto do app; ligado na subida (API e worker). */
export type DependenciasDaCampanhaNova = {
  lerSegredo: (tx: Tx, secretId: string) => Promise<string | null>;
  cliente: () => ClienteConector;
  graphUrl: string;
  appSecret: string | null;
  versao: (capacidade: 'anuncio_criar' | 'anuncio_video') => Promise<string>;
  armazem: Pick<ArmazemDeImagens, 'enderecoDeLeitura'>;
};

type Linha = {
  id: string;
  status: string;
  version: number;
  error: string | null;
  meta_campaign_id: string | null;
  meta_adset_id: string | null;
  meta_video_id: string | null;
  meta_creative_id: string | null;
  meta_ad_id: string | null;
  video_esperando_ms: number | null;
  conta_externa: string;
  credential_secret_id: string | null;
  midia_chave: string;
  midia_viva: boolean;
};

const recusado = (mensagem: string): ApplyResult => ({ ok: false, reason: 'recusado', mensagem });
const FORA_DO_AMBIENTE = 'A criação de campanha na Meta não está disponível neste ambiente.';
const SUMIU = 'Esta campanha nova não está mais aqui (a peça, a mídia ou a conta saiu da marca).';
const SEM_ACESSO = 'A Meta recusou o acesso desta conta (a autorização foi revogada ou venceu). Conecte a Meta de novo em Contas conectadas.';
const MIDIA_SAIU = 'A foto ou o vídeo desta campanha saiu de Fotos: a campanha não foi criada. Peça de novo com outra mídia.';
const VIDEO_SEM_PREPARO = 'A Meta não terminou de preparar o vídeo em 15 minutos: a campanha não foi criada. Peça de novo; se repetir, use outro vídeo.';
const VIDEO_RECUSADO = 'A Meta não aceitou o vídeo: a campanha não foi criada. Use outro vídeo de Fotos.';
const FICOU_PAUSADO = 'O que já foi criado na Meta ficou pausado: nada aparece para ninguém nem gasta.';

/**
 * A campanha nova do pedido (sob a RLS da empresa) e o estado dela, como o pedido guarda: a peça na versão pedida, a
 * mídia, quem assina, a loja e o raio, a verba e o fim. Nulo quando ela não é desta empresa e desta conta, ou quando a
 * peça, a Página ou a loja não estão mais lá.
 */
export async function lerCampanhaNova(tx: Tx, ref: ResourceRef, travar = false): Promise<{ linha: Linha; estado: EstadoDaCampanhaNova } | null> {
  const id = campanhaNovaDoRecurso(ref.resourceId);
  if (!id) return null;
  const r = await tx.execute<
    Linha & {
      brand_id: string;
      name: string;
      objective: 'cardapio' | 'whatsapp';
      radius_km: string;
      daily_budget_micros: string;
      end_date: string | null;
      link: string | null;
      piece_id: string;
      piece_version: number;
      title: string;
      body: string;
      button: 'pedir_agora' | 'ver_cardapio' | 'enviar_mensagem';
      media_id: string;
      media_kind: string;
      media_file: string;
      pagina_externa: string;
      pagina_nome: string;
      instagram_externo: string | null;
      instagram_nome: string | null;
      unit_id: string;
      unit_nome: string;
      latitude: string | null;
      longitude: string | null;
      currency: string | null;
      timezone: string | null;
    }
  >(sql`
    select c.id, c.status, c.version, c.error, c.meta_campaign_id, c.meta_adset_id, c.meta_video_id, c.meta_creative_id, c.meta_ad_id,
           (extract(epoch from now() - c.video_waiting_since) * 1000)::bigint as video_esperando_ms,
           c.brand_id, c.name, c.objective, c.radius_km::text, c.daily_budget_micros::text, c.end_date::text as end_date, c.link,
           c.piece_id, c.piece_version, v.title, v.body, v.button,
           c.media_id, m.kind as media_kind, coalesce(m.sha256, m.object_key) as media_file, m.object_key as midia_chave,
           (m.status = 'pronta' and m.removed_at is null) as midia_viva,
           p.external_id as pagina_externa, p.name as pagina_nome, ig.external_id as instagram_externo, ig.name as instagram_nome,
           u.id as unit_id, u.name as unit_nome, u.latitude::text, u.longitude::text,
           a.external_id as conta_externa, a.credential_secret_id, a.currency, o.timezone
      from liame.ad_campaign_new c
      join liame.ad_piece_version v on v.piece_id = c.piece_id and v.version = c.piece_version and v.tenant_id = c.tenant_id
      join liame.brand_photo m on m.id = c.media_id and m.tenant_id = c.tenant_id
      join liame.connected_account p on p.id = c.page_account_id and p.tenant_id = c.tenant_id
      left join liame.connected_account ig on ig.tenant_id = c.tenant_id and ig.brand_id = c.brand_id and ig.provider = 'instagram'
                and ig.external_id = p.provider_attributes->>'instagram_id' and ${contaConectada('ig')}
      join liame.unit u on u.id = c.unit_id and u.tenant_id = c.tenant_id
      join liame.connected_account a on a.id = c.ad_account_id and a.tenant_id = c.tenant_id and a.provider = ${PROVIDER}
      join liame.organization o on o.id = c.tenant_id
     where c.id = ${id} and c.tenant_id = ${ref.tenantId} and c.ad_account_id = ${ref.accountId}
     ${travar ? sql`for update of c` : sql``}`);
  const l = r.rows[0];
  if (!l || l.latitude === null || l.longitude === null) return null;
  const estado = EstadoDaCampanhaNova.parse({
    campanha: l.id,
    marca: l.brand_id,
    nome: l.name,
    objetivo: l.objective,
    peca: { id: l.piece_id, versao: l.piece_version, titulo: l.title, texto: l.body, botao: l.button },
    midia: { id: l.media_id, tipo: l.media_kind === 'video' ? 'video' : 'foto', arquivo: l.media_file },
    pagina: { id: l.pagina_externa, nome: l.pagina_nome },
    instagram: l.instagram_externo ? { id: l.instagram_externo, nome: l.instagram_nome ?? '' } : null,
    loja: { id: l.unit_id, nome: l.unit_nome, latitude: Number(l.latitude), longitude: Number(l.longitude) },
    raio_km: Number(l.radius_km),
    verba_diaria_micros: Number(l.daily_budget_micros),
    moeda: l.currency ?? 'BRL',
    fim: l.end_date,
    fuso: l.timezone ?? 'America/Sao_Paulo',
    link: l.link,
    situacao: l.status,
  });
  return { linha: { ...l, version: Number(l.version), video_esperando_ms: l.video_esperando_ms === null ? null : Number(l.video_esperando_ms) }, estado };
}

export class CampanhaNovaNaMetaConnector implements Connector {
  readonly provider = PROVIDER;
  readonly writeFlag = 'meta_write';
  // Criar não gasta (nasce pausada): o pedido não reserva verba. O registro da Meta continua pedindo os limites para o
  // que gasta (ativar, a parte 3).
  readonly requiresSpendLimits = true;
  readonly needsWriteAuthorization = true;
  private readonly logger = new Logger('campanha-nova');
  private deps: DependenciasDaCampanhaNova | null = null;

  ligar(deps: DependenciasDaCampanhaNova): void {
    this.deps = deps;
  }

  async read(tx: Tx, ref: ResourceRef): Promise<ReadResult | null> {
    const lida = await lerCampanhaNova(tx, ref);
    return lida ? { state: lida.estado as unknown as ResourceState, version: lida.linha.version } : null;
  }

  async apply(tx: Tx, ref: ResourceRef, desired: ResourceState, expectedVersion: number, options: ApplyOptions = {}): Promise<ApplyResult> {
    const lida = await lerCampanhaNova(tx, ref, true);
    if (!lida) return recusado(SUMIU);
    const { linha, estado } = lida;
    // Já criada (a tentativa anterior terminou e a resposta se perdeu): nada a fazer.
    if (linha.status === 'criada') return { ok: true, state: { ...estado, situacao: 'criada' } as unknown as ResourceState, version: linha.version };
    if (linha.status === 'cancelada') return recusado('Esta campanha nova foi cancelada: nada foi criado na Meta.');
    if (linha.status === 'nao_criada') return recusado(linha.error ?? 'Esta campanha nova não foi criada.');
    // Alguém mudou o pedido desde a aprovação: nada é criado com o que não foi aprovado.
    if (linha.version !== expectedVersion) return { ok: false, reason: 'estado-mudou', current: { state: estado as unknown as ResourceState, version: linha.version } };
    // A validação de cada objeto é na Meta, passo a passo, com o pai de verdade: aqui só confere o pedido.
    if (options.validateOnly) return { ok: true, state: desired, version: linha.version };
    const deps = this.deps;
    if (!deps) return recusado(FORA_DO_AMBIENTE);
    if (!linha.midia_viva) return this.naoCriou(tx, linha, MIDIA_SAIU);

    await tx.execute(sql`update liame.ad_campaign_new set status = 'criando', updated_at = now() where id = ${linha.id}`);
    const g = { deps, conta: linha.conta_externa, token: await this.token(tx, linha, deps), versao: await deps.versao('anuncio_criar') };
    const chave = (passo: string) => `${linha.id}:${passo}`;
    const guardar = (coluna: 'meta_campaign_id' | 'meta_adset_id' | 'meta_video_id' | 'meta_creative_id' | 'meta_ad_id', valor: string) =>
      tx.execute(sql`update liame.ad_campaign_new set ${sql.raw(coluna)} = ${valor}, updated_at = now() where id = ${linha.id}`);
    try {
      const campanha = linha.meta_campaign_id ?? (await this.criar(g, 'campaigns', parametrosDaCampanha(estado), chave('campanha')));
      if (!linha.meta_campaign_id) await guardar('meta_campaign_id', campanha);
      const conjunto = linha.meta_adset_id ?? (await this.criar(g, 'adsets', parametrosDoConjunto(estado, campanha), chave('conjunto')));
      if (!linha.meta_adset_id) await guardar('meta_adset_id', conjunto);
      const midia = await this.midia(tx, g, linha, estado, guardar);
      if (midia === 'recusado') return this.naoCriou(tx, linha, `${VIDEO_RECUSADO} ${FICOU_PAUSADO}`);
      if (midia === 'sem_preparo') return this.naoCriou(tx, linha, `${VIDEO_SEM_PREPARO} ${FICOU_PAUSADO}`);
      const criativo = linha.meta_creative_id ?? (await this.criar(g, 'adcreatives', parametrosDoCriativo(estado, midia), chave('criativo')));
      if (!linha.meta_creative_id) await guardar('meta_creative_id', criativo);
      const anuncio = linha.meta_ad_id ?? (await this.criar(g, 'ads', parametrosDoAnuncio(estado, conjunto, criativo), chave('anuncio')));
      if (!linha.meta_ad_id) await guardar('meta_ad_id', anuncio);
      await tx.execute(sql`update liame.ad_campaign_new set status = 'criada', error = null, video_waiting_since = null, updated_at = now() where id = ${linha.id}`);
      return { ok: true, state: { ...estado, situacao: 'criada', meta: { campanha, conjunto, criativo, anuncio } } as unknown as ResourceState, version: linha.version };
    } catch (err) {
      const motivo = err instanceof CriacaoRecusada ? err.message : err instanceof ErroConector && err.tipo === 'autenticacao' ? SEM_ACESSO : recusaDaMeta(err);
      // O que é passageiro (o limite da conta, a Meta fora do ar, o vídeo em preparo) sobe: o executor adia, e a
      // transação guarda o que já foi criado, para a próxima tentativa continuar dali.
      if (!motivo) throw err;
      return this.naoCriou(tx, linha, `${motivo} ${FICOU_PAUSADO}`);
    }
  }

  /** A criação que não vai adiante: a campanha nova fica "não criada", com o motivo; o que existe na Meta fica pausado. */
  private async naoCriou(tx: Tx, linha: Linha, motivo: string): Promise<ApplyResult> {
    await tx.execute(sql`update liame.ad_campaign_new set status = 'nao_criada', error = ${motivo.slice(0, 2000)}, updated_at = now() where id = ${linha.id}`);
    this.logger.warn(`campanha nova ${linha.id}: não criada (${motivo.slice(0, 200)})`);
    return recusado(motivo);
  }

  private async token(tx: Tx, linha: Linha, deps: DependenciasDaCampanhaNova): Promise<string> {
    const guardada = linha.credential_secret_id ? await deps.lerSegredo(tx, linha.credential_secret_id) : null;
    const credencial = guardada ? (JSON.parse(guardada) as CredencialGuardada) : null;
    if (!credencial || credencial.tipo !== 'meta') throw new ErroConector('autenticacao', PROVIDER, 'autorização revogada ou ausente');
    return credencial.access_token;
  }

  private endereco(g: Grafo, versao: string, caminho: string, params: Record<string, string>): string {
    const query = new URLSearchParams(params);
    if (g.deps.appSecret) query.set('appsecret_proof', createHmac('sha256', g.deps.appSecret).update(g.token).digest('hex'));
    return `${g.deps.graphUrl}/${versao}/${caminho}?${query.toString()}`;
  }

  /**
   * Um objeto novo na conta: primeiro a validação da Meta (que não cria nada), depois a criação com a chave de
   * idempotência do passo. Devolve o id do objeto.
   */
  private async criar(g: Grafo, aresta: 'campaigns' | 'adsets' | 'adcreatives' | 'ads', params: ParametrosDaMeta, chave: string): Promise<string> {
    const caminho = `${g.conta}/${aresta}`;
    const validacao = await g.deps.cliente().requisitar<{ success?: unknown } | null>({
      provider: PROVIDER,
      conta: g.conta,
      url: this.endereco(g, g.versao, caminho, { ...params, execution_options: JSON.stringify(['validate_only']) }),
      metodo: 'POST',
      endpoint: 'anuncio_criar',
      apiVersion: g.versao,
      cabecalhos: { authorization: `Bearer ${g.token}` },
      custo: 3,
    });
    if (validacao.corpo?.success !== true) throw new CriacaoRecusada('A Meta não confirmou a conferência da campanha nova: nada mais foi criado.');
    const r = await g.deps.cliente().requisitar<{ id?: unknown } | null>({
      provider: PROVIDER,
      conta: g.conta,
      url: this.endereco(g, g.versao, caminho, params),
      metodo: 'POST',
      endpoint: 'anuncio_criar',
      apiVersion: g.versao,
      cabecalhos: { authorization: `Bearer ${g.token}`, 'x-client-idempotent-key': chave },
      custo: 3,
    });
    const id = typeof r.corpo?.id === 'string' && /^\d+$/.test(r.corpo.id) ? r.corpo.id : null;
    if (!id) throw new CriacaoRecusada('A Meta não devolveu o objeto criado: confira a conta de anúncios antes de pedir de novo.');
    return id;
  }

  /**
   * A mídia do criativo: a foto pelo endereço assinado; o vídeo enviado pelo `file_url` (uma vez só, guardado), pronto
   * quando a Meta termina de preparar, com a capa guardada pelo endereço assinado.
   */
  private async midia(
    tx: Tx,
    g: Grafo,
    linha: Linha,
    estado: EstadoDaCampanhaNova,
    guardar: (coluna: 'meta_video_id', valor: string) => Promise<unknown>,
  ): Promise<MidiaNaMeta | 'recusado' | 'sem_preparo'> {
    if (estado.midia.tipo === 'foto') return { tipo: 'foto', imagem: await g.deps.armazem.enderecoDeLeitura(linha.midia_chave, VALIDADE_DA_MIDIA_S) };
    const versao = await g.deps.versao('anuncio_video');
    let video = linha.meta_video_id;
    if (!video) {
      const r = await g.deps.cliente().requisitar<{ id?: unknown } | null>({
        provider: PROVIDER,
        conta: g.conta,
        url: this.endereco(g, versao, `${g.conta}/advideos`, { file_url: await g.deps.armazem.enderecoDeLeitura(linha.midia_chave, VALIDADE_DA_MIDIA_S), name: estado.nome }),
        metodo: 'POST',
        endpoint: 'anuncio_video',
        apiVersion: versao,
        cabecalhos: { authorization: `Bearer ${g.token}` },
        custo: 3,
      });
      video = typeof r.corpo?.id === 'string' && /^\d+$/.test(r.corpo.id) ? r.corpo.id : null;
      if (!video) throw new CriacaoRecusada('A Meta não devolveu o vídeo enviado: a campanha não foi criada.');
      await guardar('meta_video_id', video);
      await tx.execute(sql`update liame.ad_campaign_new set video_waiting_since = coalesce(video_waiting_since, now()) where id = ${linha.id}`);
    }
    const situacao = await g.deps.cliente().requisitar<{ status?: { video_status?: unknown } } | null>({
      provider: PROVIDER,
      conta: g.conta,
      url: this.endereco(g, versao, video, { fields: 'status' }),
      endpoint: 'anuncio_video',
      apiVersion: versao,
      cabecalhos: { authorization: `Bearer ${g.token}` },
    });
    const s = situacao.corpo?.status?.video_status;
    if (s === 'error' || s === 'expired') return 'recusado';
    if (s !== 'ready') {
      if ((linha.video_esperando_ms ?? 0) >= PREPARO_DO_VIDEO_MS) return 'sem_preparo';
      // A espera fixa do vídeo (como no post): não conta tentativa; quem encerra são os 15 minutos acima.
      throw new ErroConector('limite', PROVIDER, 'a Meta ainda prepara o vídeo da campanha nova', null, ESPERA_DO_VIDEO_MS, VIDEO_EM_PREPARO);
    }
    return { tipo: 'video', videoId: video, capa: await g.deps.armazem.enderecoDeLeitura(chaveDaMiniatura(linha.midia_chave), VALIDADE_DA_MIDIA_S) };
  }
}

type Grafo = { deps: DependenciasDaCampanhaNova; conta: string; token: string; versao: string };

/** A recusa que encerra a criação, com a frase para a pessoa. */
class CriacaoRecusada extends Error {}

export const campanhaNovaNaMetaConnector = new CampanhaNovaNaMetaConnector();
