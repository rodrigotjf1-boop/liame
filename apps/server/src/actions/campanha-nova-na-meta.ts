import type { Tx } from '@liame/database';
import { Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import {
  campanhaNovaDoRecurso,
  EstadoDaCampanhaNova,
  type MidiaNaMeta,
  parametrosDaCampanha,
  parametrosDoAnuncio,
  parametrosDoConjunto,
  parametrosDoCriativo,
  type ObjetivoDaCampanhaNova,
} from '../campanhas/campanha-nova-plano.js';
import { contaConectada } from '../connections/conectada.js';
import { ErroConector } from '../connectors/cliente-http.js';
import type { ApplyOptions, ApplyResult, Connector, ReadResult, ResourceRef } from './connectors.js';
import { recusaDaMeta } from './meta-anuncios.js';
import {
  APAGADA_NA_META,
  CriacaoRecusada,
  criarNaMeta,
  type DependenciasDaCriacaoNaMeta,
  enderecoDaMeta,
  type GrafoDaMeta,
  MIDIA_SAIU,
  midiaNaMeta,
  mudarSituacaoNaMeta,
  SEM_ACESSO,
  tokenDaConta,
} from './meta-criacao.js';
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

/** O que o conector precisa do resto do app; ligado na subida (API e worker). São as dependências dos passos comuns. */
export type DependenciasDaCampanhaNova = DependenciasDaCriacaoNaMeta;

/** Os passos da criação que levam chave de idempotência (o vídeo não leva: o id dele fica guardado na linha). */
export type PassoDaCampanhaNova = 'campanha' | 'conjunto' | 'criativo' | 'anuncio';

/**
 * A chave de idempotência de um passo da criação (`X-Client-Idempotent-Key`): a campanha nova e o passo. NÃO mude o
 * formato: a criação que estiver no meio quando um deploy entrar repete o passo com a mesma chave, e com outra a Meta
 * criaria o objeto de novo.
 */
export const chaveDoPassoDaCampanhaNova = (campanhaNova: string, passo: PassoDaCampanhaNova): string => `${campanhaNova}:${passo}`;

type Linha = {
  id: string;
  status: string;
  active: boolean;
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
  midia_chave: string | null;
  midia_viva: boolean;
};

const recusado = (mensagem: string): ApplyResult => ({ ok: false, reason: 'recusado', mensagem });

const FORA_DO_AMBIENTE = 'A criação de campanha na Meta não está disponível neste ambiente.';
const SUMIU = 'Esta campanha nova não está mais aqui (a peça, a mídia ou a conta saiu da marca).';
const VIDEO_SEM_PREPARO = 'A Meta não terminou de preparar o vídeo em 15 minutos: a campanha não foi criada. Peça de novo; se repetir, use outro vídeo.';
const VIDEO_RECUSADO = 'A Meta não aceitou o vídeo: a campanha não foi criada. Use outro vídeo de Fotos.';
const FICOU_PAUSADO = 'O que já foi criado na Meta ficou pausado: nada aparece para ninguém nem gasta.';
const REELS_SAIU = 'O Reels desta campanha saiu do Instagram da marca (ou da leitura do Liame): a campanha não foi criada.';
const REELS_NAO_PODE =
  'A Meta não deixa este Reels virar anúncio (por exemplo, com música do Instagram ou um filtro interativo): a campanha não foi criada, e nada foi criado na Meta. Use um vídeo de Fotos.';

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
      objective: ObjetivoDaCampanhaNova;
      radius_km: string | null;
      daily_budget_micros: string;
      end_date: string | null;
      link: string | null;
      piece_id: string | null;
      piece_version: number | null;
      title: string | null;
      body: string | null;
      button: 'pedir_agora' | 'ver_cardapio' | 'enviar_mensagem' | null;
      media_id: string | null;
      media_kind: string | null;
      media_file: string | null;
      instagram_media_id: string | null;
      reels_legenda: string | null;
      pagina_externa: string;
      pagina_nome: string;
      instagram_externo: string | null;
      instagram_nome: string | null;
      unit_id: string;
      unit_nome: string;
      latitude: string | null;
      longitude: string | null;
      audience_lower: string | null;
      audience_upper: string | null;
      districts: unknown;
      currency: string | null;
      timezone: string | null;
    }
  >(sql`
    select c.id, c.status, c.active, c.version, c.error, c.meta_campaign_id, c.meta_adset_id, c.meta_video_id, c.meta_creative_id, c.meta_ad_id,
           (extract(epoch from now() - c.video_waiting_since) * 1000)::bigint as video_esperando_ms,
           c.brand_id, c.name, c.objective, c.radius_km::text, c.daily_budget_micros::text, c.end_date::text as end_date, c.link,
           c.piece_id, c.piece_version, v.title, v.body, v.button,
           c.media_id, m.kind as media_kind, coalesce(m.sha256, m.object_key) as media_file, m.object_key as midia_chave,
           c.instagram_media_id, im.caption as reels_legenda,
           -- A mídia viva: a foto ou o vídeo pronto em Fotos; o Reels, ainda na leitura do Instagram da marca.
           case when c.instagram_media_id is not null then im.media_id is not null
                else coalesce(m.status = 'pronta' and m.removed_at is null, false) end as midia_viva,
           p.external_id as pagina_externa, p.name as pagina_nome, ig.external_id as instagram_externo, ig.name as instagram_nome,
           u.id as unit_id, u.name as unit_nome, u.latitude::text, u.longitude::text, c.audience_lower::text, c.audience_upper::text, c.districts,
           a.external_id as conta_externa, a.credential_secret_id, a.currency, o.timezone
      from liame.ad_campaign_new c
      left join liame.ad_piece_version v on v.piece_id = c.piece_id and v.version = c.piece_version and v.tenant_id = c.tenant_id
      left join liame.brand_photo m on m.id = c.media_id and m.tenant_id = c.tenant_id
      join liame.connected_account p on p.id = c.page_account_id and p.tenant_id = c.tenant_id
      left join liame.connected_account ig on ig.tenant_id = c.tenant_id and ig.brand_id = c.brand_id and ig.provider = 'instagram'
                and ig.external_id = p.provider_attributes->>'instagram_id' and ${contaConectada('ig')}
      -- O Reels do perfil que assina o anúncio (o Instagram da Página): de outro perfil, a Meta não aceita.
      left join liame.instagram_media im on im.connected_account_id = ig.id and im.media_id = c.instagram_media_id and im.kind = 'reels'
      join liame.unit u on u.id = c.unit_id and u.tenant_id = c.tenant_id
      join liame.connected_account a on a.id = c.ad_account_id and a.tenant_id = c.tenant_id and a.provider = ${PROVIDER}
      join liame.organization o on o.id = c.tenant_id
     where c.id = ${id} and c.tenant_id = ${ref.tenantId} and c.ad_account_id = ${ref.accountId}
     ${travar ? sql`for update of c` : sql``}`);
  const l = r.rows[0];
  if (!l || l.latitude === null || l.longitude === null) return null;
  // A peça e a foto de Fotos (as linhas delas) ou o Reels (A4, X5, parte 6): sem a peça ou a foto, a campanha sumiu.
  const doReels = l.instagram_media_id !== null;
  if (!doReels && (l.title === null || l.media_kind === null)) return null;
  const estado = EstadoDaCampanhaNova.parse({
    campanha: l.id,
    marca: l.brand_id,
    nome: l.name,
    objetivo: l.objective,
    peca: doReels ? null : { id: l.piece_id, versao: l.piece_version, titulo: l.title, texto: l.body, botao: l.button },
    midia: doReels
      ? { id: l.instagram_media_id, tipo: 'reels', legenda: l.reels_legenda ?? '' }
      : { id: l.media_id, tipo: l.media_kind === 'video' ? 'video' : 'foto', arquivo: l.media_file },
    pagina: { id: l.pagina_externa, nome: l.pagina_nome },
    instagram: l.instagram_externo ? { id: l.instagram_externo, nome: l.instagram_nome ?? '' } : null,
    loja: { id: l.unit_id, nome: l.unit_nome, latitude: Number(l.latitude), longitude: Number(l.longitude) },
    raio_km: l.radius_km === null ? null : Number(l.radius_km),
    bairros: l.districts ?? null,
    verba_diaria_micros: Number(l.daily_budget_micros),
    moeda: l.currency ?? 'BRL',
    fim: l.end_date,
    fuso: l.timezone ?? 'America/Sao_Paulo',
    link: l.link,
    publico: l.audience_lower !== null && l.audience_upper !== null ? { de: Number(l.audience_lower), ate: Number(l.audience_upper) } : null,
    situacao: l.status,
    ativa: l.active,
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
    // A campanha já criada: ativar ou pausar (parte 3). Já como o pedido quer (a criação que terminou e a resposta se
    // perdeu, a ativação repetida): nada a fazer.
    if (linha.status === 'criada') {
      const ativar = desired.ativa === true;
      if (ativar === linha.active) return { ok: true, state: estado as unknown as ResourceState, version: linha.version };
      if (linha.version !== expectedVersion) return { ok: false, reason: 'estado-mudou', current: { state: estado as unknown as ResourceState, version: linha.version } };
      if (options.validateOnly) return { ok: true, state: desired, version: linha.version };
      if (!this.deps) return recusado(FORA_DO_AMBIENTE);
      return this.mudarSituacao(tx, linha, estado, ativar, this.deps);
    }
    if (linha.status === 'cancelada') return recusado('Esta campanha nova foi cancelada: nada foi criado na Meta.');
    if (linha.status === 'nao_criada') return recusado(linha.error ?? 'Esta campanha nova não foi criada.');
    // Alguém mudou o pedido desde a aprovação: nada é criado com o que não foi aprovado.
    if (linha.version !== expectedVersion) return { ok: false, reason: 'estado-mudou', current: { state: estado as unknown as ResourceState, version: linha.version } };
    // A validação de cada objeto é na Meta, passo a passo, com o pai de verdade: aqui só confere o pedido.
    if (options.validateOnly) return { ok: true, state: desired, version: linha.version };
    const deps = this.deps;
    if (!deps) return recusado(FORA_DO_AMBIENTE);
    const doReels = estado.midia.tipo === 'reels';
    if (!linha.midia_viva) return this.naoCriou(tx, linha, doReels ? REELS_SAIU : MIDIA_SAIU);

    await tx.execute(sql`update liame.ad_campaign_new set status = 'criando', updated_at = now() where id = ${linha.id}`);
    const g = { deps, conta: linha.conta_externa, token: await tokenDaConta(tx, linha.credential_secret_id, deps), versao: await deps.versao('anuncio_criar') };
    const chave = (passo: PassoDaCampanhaNova) => chaveDoPassoDaCampanhaNova(linha.id, passo);
    const guardar = (coluna: 'meta_campaign_id' | 'meta_adset_id' | 'meta_video_id' | 'meta_creative_id' | 'meta_ad_id', valor: string) =>
      tx.execute(sql`update liame.ad_campaign_new set ${sql.raw(coluna)} = ${valor}, updated_at = now() where id = ${linha.id}`);
    try {
      // O Reels (D-A4-46): antes de criar qualquer coisa, a pergunta à Meta se o post pode virar anúncio (o campo
      // `boost_eligibility_info` do post; a música do Instagram e os filtros interativos não podem). Recusado, nada é criado.
      if (doReels && !linha.meta_campaign_id && (await this.reelsPodeVirarAnuncio(g, estado.midia.id)) === false) return this.naoCriou(tx, linha, REELS_NAO_PODE);
      const campanha = linha.meta_campaign_id ?? (await criarNaMeta(g, 'campaigns', parametrosDaCampanha(estado), chave('campanha')));
      if (!linha.meta_campaign_id) await guardar('meta_campaign_id', campanha);
      const conjunto = linha.meta_adset_id ?? (await criarNaMeta(g, 'adsets', parametrosDoConjunto(estado, campanha), chave('conjunto')));
      if (!linha.meta_adset_id) await guardar('meta_adset_id', conjunto);
      const midia = await this.midia(tx, g, linha, estado, guardar);
      if (midia === 'recusado') return this.naoCriou(tx, linha, `${VIDEO_RECUSADO} ${FICOU_PAUSADO}`);
      if (midia === 'sem_preparo') return this.naoCriou(tx, linha, `${VIDEO_SEM_PREPARO} ${FICOU_PAUSADO}`);
      const criativo = linha.meta_creative_id ?? (await criarNaMeta(g, 'adcreatives', parametrosDoCriativo(estado, midia), chave('criativo')));
      if (!linha.meta_creative_id) await guardar('meta_creative_id', criativo);
      const anuncio = linha.meta_ad_id ?? (await criarNaMeta(g, 'ads', parametrosDoAnuncio(estado, conjunto, criativo), chave('anuncio')));
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

  /**
   * Ativar ou pausar a campanha nova (A4, X5, parte 3; D-A4-31). Ativar põe o anúncio, o conjunto e a campanha em
   * ACTIVE, nesta ordem (nada roda antes de os três estarem ativos); pausar põe a campanha em PAUSED (os filhos herdam).
   * Antes, cada objeto é lido na Meta: o apagado ou arquivado no Gerenciador de Anúncios não volta (quem está na Meta
   * manda, D-A4-5). Depois, a validação da Meta em cada um e a mudança. A versão da campanha nova sobe: a volta confere
   * por ela que ninguém mexeu depois.
   */
  private async mudarSituacao(tx: Tx, linha: Linha, estado: EstadoDaCampanhaNova, ativar: boolean, deps: DependenciasDaCampanhaNova): Promise<ApplyResult> {
    const ids = ativar ? [linha.meta_ad_id, linha.meta_adset_id, linha.meta_campaign_id] : [linha.meta_campaign_id];
    if (ids.some((id) => !id)) return recusado('O Liame não guardou os objetos desta campanha na Meta: confira no Gerenciador de Anúncios.');
    const token = await tokenDaConta(tx, linha.credential_secret_id, deps);
    const g: GrafoDaMeta = { deps, conta: linha.conta_externa, token, versao: await deps.versao('entity_update') };
    const leitura = await deps.versao('entity_state');
    const recusa = await mudarSituacaoNaMeta(g, leitura, ids as string[], ativar);
    if (recusa) return recusado(recusa);
    await tx.execute(sql`
      update liame.ad_campaign_new
         set active = ${ativar}, activated_at = case when ${ativar} then now() else activated_at end, version = version + 1, updated_at = now()
       where id = ${linha.id}`);
    return { ok: true, state: { ...estado, ativa: ativar } as unknown as ResourceState, version: linha.version + 1 };
  }

  /** A criação que não vai adiante: a campanha nova fica "não criada", com o motivo; o que existe na Meta fica pausado. */
  private async naoCriou(tx: Tx, linha: Linha, motivo: string): Promise<ApplyResult> {
    await tx.execute(sql`update liame.ad_campaign_new set status = 'nao_criada', error = ${motivo.slice(0, 2000)}, updated_at = now() where id = ${linha.id}`);
    this.logger.warn(`campanha nova ${linha.id}: não criada (${motivo.slice(0, 200)})`);
    return recusado(motivo);
  }

  /**
   * A mídia do criativo: o Reels é o próprio post (D-A4-46); a foto e o vídeo de Fotos vão pelos passos comuns da
   * criação na Meta (`midiaNaMeta`). O que é desta tabela fica aqui: o id do vídeo enviado e desde quando a Meta o prepara.
   */
  private async midia(
    tx: Tx,
    g: GrafoDaMeta,
    linha: Linha,
    estado: EstadoDaCampanhaNova,
    guardar: (coluna: 'meta_video_id', valor: string) => Promise<unknown>,
  ): Promise<MidiaNaMeta | 'recusado' | 'sem_preparo'> {
    // O Reels é o próprio post: nada a enviar (D-A4-46).
    if (estado.midia.tipo === 'reels') return { tipo: 'reels', id: estado.midia.id };
    return midiaNaMeta(g, { tipo: estado.midia.tipo, chave: linha.midia_chave, nome: estado.nome, video: linha.meta_video_id, esperandoMs: linha.video_esperando_ms }, async (video) => {
      await guardar('meta_video_id', video);
      await tx.execute(sql`update liame.ad_campaign_new set video_waiting_since = coalesce(video_waiting_since, now()) where id = ${linha.id}`);
    });
  }

  /**
   * O Reels pode virar anúncio? `GET /{ig-media-id}?fields=boost_eligibility_info` (o guia "Use Posts as Instagram Ads"
   * da Meta; o subcampo `eligible_to_boost`, booleano). `false` só quando a Meta responde que não. Sem a resposta (a
   * permissão que falta no post, o campo que não veio), segue: a recusa do criativo, se vier, diz o porquê. O que é
   * passageiro e o acesso revogado sobem, como nos outros passos.
   */
  private async reelsPodeVirarAnuncio(g: GrafoDaMeta, midia: string): Promise<boolean | null> {
    const versao = await g.deps.versao('entity_state');
    try {
      const r = await g.deps.cliente().requisitar<{ boost_eligibility_info?: { eligible_to_boost?: unknown } } | null>({
        provider: PROVIDER,
        conta: g.conta,
        url: enderecoDaMeta(g, versao, midia, { fields: 'boost_eligibility_info' }),
        endpoint: 'reels_elegivel',
        apiVersion: versao,
        cabecalhos: { authorization: `Bearer ${g.token}` },
      });
      const elegivel = r.corpo?.boost_eligibility_info?.eligible_to_boost;
      return typeof elegivel === 'boolean' ? elegivel : null;
    } catch (err) {
      if (!(err instanceof ErroConector) || (err.tipo !== 'permissao' && err.tipo !== 'definitivo')) throw err;
      this.logger.warn(`Reels ${midia}: a Meta não disse se ele pode virar anúncio (${err.message.slice(0, 200)}); segue para o criativo`);
      return null;
    }
  }
}

export const campanhaNovaNaMetaConnector = new CampanhaNovaNaMetaConnector();
