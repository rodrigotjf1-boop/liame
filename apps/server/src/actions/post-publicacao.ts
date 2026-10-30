import { createHmac } from 'node:crypto';
import { setTimeout as esperar } from 'node:timers/promises';
import type { Tx } from '@liame/database';
import { Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { contaConectada } from '../connections/conectada.js';
import type { CredencialGuardada } from '../connections/oauth.js';
import { type ClienteConector, ErroConector } from '../connectors/cliente-http.js';
import {
  CONTEINER_EM_PREPARO,
  COTA_DE_POSTS,
  ESPERA_DO_CONTEINER_MS,
  enderecoDoPost,
  enderecoNaPagina,
  FLAG_DOS_POSTS,
  fotoJaNaPagina,
  idDaResposta,
  idDoPostDaPagina,
  limiteDePosts,
  MAIOR_FOTO_DA_PAGINA_BYTES,
  postJaPublicado,
  type SituacaoDoConteiner,
  situacaoDoConteiner,
  tokenDaPagina,
} from '../connectors/meta/publicacao.js';
import { chaveDoRecorteDoPost, recorteDoInstagram } from '../fotos/conferencia.js';
import { VALIDADE_DO_ENDERECO_S } from '../fotos/fotos.service.js';
import { type ArmazemDeImagens, FalhaDoArmazem } from '../imagens/armazem.js';
import { type CanalDoPost, CANAIS_DO_POST, type EstadoDoPost, horaLocal, postDoRecurso, PROVEDOR_DO_CANAL, recusaNaHoraDeSair, type SituacaoDoCanal } from '../posts/post-plano.js';
import { PRIMEIRA_LEITURA_MIN } from '../posts/numeros-do-post.js';
import { recortarParaOInstagram } from '../posts/recorte.js';
import type { ApplyOptions, ApplyResult, Connector, ReadResult, ResourceRef } from './connectors.js';
import type { ResourceState } from './tools.js';

// O post da marca pelo Action Service (A6, Z5b; `plano-a6.md` D-A6-3, D-A6-7 e D-A6-8): publicar o post que uma pessoa
// aprovou com o código do app, na hora marcada. Só com a flag de escrita `social_write` ligada, que nasce desligada: sem
// ela, nenhum pedido passa do trilho.
//
// O recurso é o post: `resource_id` = `post:<id do post no Liame>`; `account_id` é a conta do primeiro canal (o Instagram,
// quando ele está no post; senão, a Página), e o provedor do pedido é o dela (`instagram` ou `facebook_page`): a trava
// por conta vale para ela no executor, e para a conta do outro canal aqui (decisão técnica D-A6-32).
//
// - O estado é o post como o Liame o guarda: a foto pelo resumo do arquivo (o que sai é o aprovado, A6-10), o recorte, a
//   hora (com a hora no fuso da empresa, que o plano confere com a janela das 8h às 22h) e cada canal com a conta, o texto
//   e a situação. A conta desligada da marca, ou de outra marca, vira nula: o plano recusa.
// - A versão é a do post (`social_post.version`), que sobe a cada mudança do que o post é: o trilho confere antes de
//   escrever. A situação de cada canal não sobe a versão: a tentativa seguinte continua valendo para o mesmo post.
// - Cada canal sai por conta própria (D-A6-7: a aprovação vale para o conjunto; um canal que não sai não segura o
//   outro). O que é passageiro (o contêiner em preparo, o limite, a rede fora do ar) faz o pedido inteiro esperar; a
//   volta seguinte pula o canal que já saiu.
//
// O Instagram (parte 2; base §2.2, reconferida em 29/10/2026): o contêiner (`POST /{ig}/media`, com o endereço assinado
// da foto, que a Meta busca na hora, e a legenda), a situação dele (`status_code`) e a publicação (`media_publish`), com
// o token da autorização da Meta que ligou o Instagram à marca. O post sai UMA vez (A6-9):
//   1. antes de tudo, os posts recentes do Instagram: o que já saiu com a mesma legenda desde a criação do post no Liame
//      é o desta tentativa (a anterior publicou, e a resposta não chegou), e nada sai de novo;
//   2. o contêiner da tentativa anterior é conferido antes de criar outro: o publicado conta como feito; o pronto é
//      publicado; o que ainda prepara a foto faz o pedido esperar um minuto (o adiamento do trilho, que não desfaz o que
//      já foi gravado: o contêiner fica guardado no canal);
//   3. o limite de posts pela API (`content_publishing_limit`) antes de criar o contêiner (A6-11): no limite, o pedido
//      espera, em vez de a Meta recusar;
//   4. a foto que não cabe no Instagram vai recortada na posição aprovada (D-A6-21), num arquivo à parte no
//      armazenamento, que sai assim que o Instagram busca a imagem.
// A Página do Facebook (parte 3; base §2.2, reconferida em 29/10/2026): o token da Página pela lista das Páginas da
// autorização (`me/accounts`, com as tarefas de quem autorizou: publicar pede `CREATE_CONTENT`) e a foto inteira com a
// legenda (`POST /{página}/photos`, até 4 MB). Uma vez só: antes de publicar, as fotos da Página (a mesma legenda desde
// a criação do post é a desta tentativa); depois de uma tentativa sem resposta, sem essa lista não publica de novo.
// Os tokens saem do cofre (ou da Meta) só na hora de chamar e nunca vão para log, estado ou auditoria.

const META = 'meta_ads';

/** O que o post precisa do resto do app; ligado na subida (API e worker). */
export type DependenciasDoPost = {
  lerSegredo: (tx: Tx, secretId: string) => Promise<string | null>;
  /** O cliente dos conectores, de uma tentativa por chamada: quem tenta de novo é o trilho, que confere antes. */
  cliente: () => ClienteConector;
  /** Endereço da Graph API (o oficial em produção). */
  graphUrl: string;
  appSecret: string | null;
  /** A versão da API registrada para cada capacidade (Capability Registry). */
  versao: (capacidade: CapacidadeDoPost) => Promise<string>;
  armazem: Pick<ArmazemDeImagens, 'ler' | 'gravar' | 'apagar' | 'enderecoDeLeitura'>;
  /**
   * A trava ligada para a conta de um canal que não é a do pedido (a do pedido o executor já conferiu): o motivo, ou nulo.
   * Sem ela (os testes que não a ligam), nenhuma trava.
   */
  trava?: (tx: Tx, alvo: { tenantId: string; brandId: string; provider: string; accountId: string }) => Promise<string | null>;
  /** O recorte da foto (o sharp, por padrão; os testes trocam). Nulo: a foto cabe inteira. */
  recortar?: (bytes: Buffer, posicao: number) => Promise<Buffer | null>;
  /** Quanto esperar depois de criar o contêiner para a primeira conferência (os testes zeram). */
  esperaDoConteinerMs?: number;
};

/**
 * As capacidades da Meta que o post usa, no registro: publicar no Instagram e ler o que foi publicado lá (0087); a lista
 * das Páginas da autorização (0085); publicar a foto na Página e ler as fotos e o post dela (0088).
 */
export type CapacidadeDoPost = 'instagram_publish' | 'instagram_media' | 'pages' | 'pagina_publish' | 'pagina_media';

/** Depois de criar o contêiner, quanto esperar até a primeira conferência: a foto pequena costuma ficar pronta em segundos. */
const PRIMEIRA_CONFERENCIA_MS = 5_000;
/** No limite de posts do dia, quanto esperar até tentar de novo (o limite é de 24 horas, em janela móvel). */
const ESPERA_DA_COTA_MS = 60 * 60_000;
/** Quantos posts recentes (ou fotos da Página) a tentativa olha antes de publicar (o desta tentativa é dos mais novos). */
const RECENTES = 25;

/** A frase de cada canal: o que não saiu, e onde. */
const NAO_SAIU: Record<CanalDoPost, string> = { instagram: 'O post não saiu no Instagram.', facebook: 'O post não saiu na Página do Facebook.' };
const NO_CANAL: Record<CanalDoPost, string> = { instagram: 'no Instagram', facebook: 'na Página do Facebook' };
const SEM_ACESSO = (c: CanalDoPost) =>
  `A Meta recusou o acesso desta conta (a autorização foi revogada ou venceu). Conecte a Meta de novo em Contas conectadas. ${NAO_SAIU[c]}`;
const SEM_PERMISSAO: Record<CanalDoPost, string> = {
  instagram: `A Meta não deixou o Liame publicar neste Instagram: a permissão de publicar não está concedida, ou a conta deixou de ser profissional. Conecte a Meta de novo em Contas conectadas e confirme a permissão de publicar. ${NAO_SAIU.instagram}`,
  facebook: `A Meta não deixou o Liame publicar nesta Página: a permissão de publicar não está concedida, ou quem autorizou não pode criar conteúdo nela. Conecte a Meta de novo em Contas conectadas com uma pessoa que administra a Página. ${NAO_SAIU.facebook}`,
};
const FOTO_RECUSADA = (c: CanalDoPost) => `${c === 'instagram' ? 'O Instagram' : 'A Página do Facebook'} não aceitou a foto deste post. ${NAO_SAIU[c]} Faça um post novo com outra foto.`;
const NAO_ACEITOU = (c: CanalDoPost) => `${c === 'instagram' ? 'O Instagram' : 'A Página do Facebook'} não aceitou o post. ${NAO_SAIU[c]}`;
const SEM_ARQUIVO = (c: CanalDoPost) => `O arquivo da foto deste post não está mais guardado no Liame. ${NAO_SAIU[c]} Faça um post novo.`;
const PAGINA_FORA = `A autorização da Meta não alcança mais esta Página. Conecte a Meta de novo em Contas conectadas. ${NAO_SAIU.facebook}`;
const FOTO_GRANDE = `A foto deste post passa de 4 MB, o limite da Página do Facebook. ${NAO_SAIU.facebook}`;
const SEM_CONFERIR =
  'Uma tentativa anterior pode ter publicado este post na Página do Facebook, e a Meta não deixou o Liame conferir. Para não publicar duas vezes, o Liame não tentou de novo: confira na Página e, se o post não estiver lá, faça um post novo.';
const SUMIU = 'Este post não está mais no Liame.';
const FORA_DO_AMBIENTE = 'A publicação nas redes não está disponível neste ambiente.';

type LinhaDoPost = {
  id: string;
  brand_id: string;
  photo_id: string | null;
  photo_sha256: string;
  foto_pronta: boolean | null;
  foto_chave: string | null;
  foto_largura: number | null;
  foto_altura: number | null;
  foto_bytes: number | null;
  crop_pos: number | null;
  instagram_object_key: string | null;
  publish_at: Date;
  created_at: Date;
  version: number;
  fuso: string | null;
};
type LinhaDoCanal = { channel: string; conta: string | null; body: string; status: string };

/** O post como o trilho o vê, com o que só a execução usa (o arquivo da foto e quando o post nasceu). */
export type PostLido = {
  estado: EstadoDoPost;
  versao: number;
  marca: string;
  foto: { chave: string; largura: number; altura: number; bytes: number } | null;
  criadoEm: Date;
  recorteGuardado: string | null;
};

const ehCanal = (c: string): c is CanalDoPost => (CANAIS_DO_POST as readonly string[]).includes(c);

/** O estado do post como o trilho o vê; nulo quando o post não é desta empresa (ou o recurso não é um post). */
export async function lerEstadoDoPost(tx: Tx, tenantId: string, resourceId: string): Promise<PostLido | null> {
  const id = postDoRecurso(resourceId);
  if (!id) return null;
  const p = await tx.execute<LinhaDoPost>(sql`
    select p.id, p.brand_id, p.photo_id, p.photo_sha256, (f.status = 'pronta' and f.removed_at is null and f.sha256 = p.photo_sha256) as foto_pronta,
           f.object_key as foto_chave, f.width as foto_largura, f.height as foto_altura, f.bytes as foto_bytes,
           p.crop_pos, p.instagram_object_key, p.publish_at, p.created_at, p.version, o.timezone as fuso
      from liame.social_post p
      join liame.organization o on o.id = p.tenant_id
      left join liame.brand_photo f on f.id = p.photo_id
     where p.id = ${id} and p.tenant_id = ${tenantId}`);
  const post = p.rows[0];
  if (!post) return null;
  // A conta só vale se ainda está conectada (ligada e sem a recusa da plataforma: é o que vale para agir) à marca do
  // post, com o provedor do canal (a Página, o Instagram).
  const c = await tx.execute<LinhaDoCanal>(sql`
    select ch.channel, a.id as conta, ch.body, ch.status
      from liame.social_post_channel ch
      left join liame.connected_account a
        on a.id = ch.connected_account_id and ${contaConectada('a')} and a.brand_id = ${post.brand_id}
       and a.provider = case ch.channel when 'instagram' then ${PROVEDOR_DO_CANAL.instagram} else ${PROVEDOR_DO_CANAL.facebook} end
     where ch.post_id = ${id} and ch.tenant_id = ${tenantId}
     order by case ch.channel when 'instagram' then 0 else 1 end`);
  const fuso = post.fuso ?? 'America/Sao_Paulo';
  const hora = new Date(post.publish_at);
  const pronta = Boolean(post.photo_id && post.foto_pronta);
  const estado: EstadoDoPost = {
    post: post.id,
    foto: pronta && post.photo_id ? { id: post.photo_id, sha256: post.photo_sha256 } : null,
    recorte: post.crop_pos,
    hora: hora.toISOString(),
    hora_local: horaLocal(hora, fuso),
    canais: c.rows.filter((l) => ehCanal(l.channel)).map((l) => ({ canal: l.channel as CanalDoPost, conta: l.conta, texto: l.body, situacao: l.status as SituacaoDoCanal })),
  };
  return {
    estado,
    versao: post.version,
    marca: post.brand_id,
    foto:
      pronta && post.foto_chave && post.foto_largura && post.foto_altura
        ? { chave: post.foto_chave, largura: post.foto_largura, altura: post.foto_altura, bytes: Number(post.foto_bytes ?? 0) }
        : null,
    criadoEm: new Date(post.created_at),
    recorteGuardado: post.instagram_object_key,
  };
}

/** O canal não sai: a frase vai para a pessoa (o pedido termina como "falhou", com ela). */
class CanalNaoSaiu extends Error {}

/** O que cada chamada à Graph API leva: as dependências, a conta na rede (a chave da cota), o token e as versões. */
type Graph = { deps: DependenciasDoPost; conta: string; token: string; versoes: Partial<Record<CapacidadeDoPost, string>> };

/** A linha do canal e a conta dele, como a execução as lê (travada até o fim da transação). */
type CanalLido = { id: string; status: string; container_id: string | null; body: string; external_id: string; credential_secret_id: string | null; conta: string };

/** As situações em que o canal ainda pode sair (o que já saiu, não saiu ou foi cancelado fica como está). */
const AINDA_SAI = new Set<SituacaoDoCanal>(['aguardando', 'publicando']);

export class PostPublicacaoConnector implements Connector {
  // O mesmo conector responde pelos dois provedores do post (o da conta do primeiro canal); ver o registro.
  constructor(readonly provider: string) {}
  readonly writeFlag = FLAG_DOS_POSTS;
  // Publicar um post não gasta verba de mídia.
  readonly requiresSpendLimits = false;
  private readonly logger = new Logger('post-nas-redes');
  private deps: DependenciasDoPost | null = null;

  ligar(deps: DependenciasDoPost): void {
    this.deps = deps;
  }

  async read(tx: Tx, ref: ResourceRef): Promise<ReadResult | null> {
    const lido = await lerEstadoDoPost(tx, ref.tenantId, ref.resourceId);
    if (!lido) return null;
    // A conta do pedido tem de ser a de um canal do post: o pedido de outra conta não é deste post.
    if (!lido.estado.canais.some((c) => c.conta === ref.accountId)) return null;
    return { state: lido.estado as unknown as ResourceState, version: lido.versao };
  }

  async apply(tx: Tx, ref: ResourceRef, _desired: ResourceState, expectedVersion: number, options: ApplyOptions = {}): Promise<ApplyResult> {
    const lido = await lerEstadoDoPost(tx, ref.tenantId, ref.resourceId);
    if (!lido) return recusado(SUMIU);
    const estado = lido.estado as unknown as ResourceState;
    // O post mudou desde o pedido (a hora, a foto, o texto, uma conta): o que sai tem de ser o aprovado (A6-10).
    if (lido.versao !== expectedVersion) return { ok: false, reason: 'estado-mudou', current: { state: estado, version: lido.versao } };
    // Já saiu em todos os canais (a tentativa anterior publicou): nada a mandar de novo.
    if (lido.estado.canais.every((c) => c.situacao === 'publicado')) return { ok: true, state: estado, version: lido.versao };
    // Na hora de sair, de novo: a foto apagada ou a conta que deixou de estar conectada não sai.
    const motivo = recusaNaHoraDeSair(lido.estado);
    if (motivo) return recusado(motivo);
    if (options.validateOnly) return { ok: true, state: estado, version: lido.versao };
    const deps = this.deps;
    if (!deps) return recusado(FORA_DO_AMBIENTE);

    // Cada canal por conta própria: o que não sai fica anotado no canal e na frase; o passageiro faz o pedido esperar.
    const falhas: string[] = [];
    for (const canal of lido.estado.canais) {
      if (!AINDA_SAI.has(canal.situacao)) continue;
      try {
        if (canal.canal === 'instagram') await this.noInstagram(tx, ref, lido, deps);
        else await this.naPagina(tx, ref, lido, deps);
      } catch (err) {
        if (!(err instanceof CanalNaoSaiu)) throw err;
        falhas.push(err.message);
      }
    }
    const depois = (await lerEstadoDoPost(tx, ref.tenantId, ref.resourceId)) ?? lido;
    if (falhas.length) {
      const sairam = depois.estado.canais.filter((c) => c.situacao === 'publicado').map((c) => NO_CANAL[c.canal]);
      return recusado(`${sairam.length ? `O post saiu ${sairam.join(' e ')}. ` : ''}${falhas.join(' ')}`);
    }
    return { ok: true, state: depois.estado as unknown as ResourceState, version: lido.versao };
  }

  // ---- O que os dois canais dividem -------------------------------------------------------------------------------

  /** O canal e a conta dele, travados até o fim da transação; e a trava da conta, se não é a do pedido. */
  private async canal(tx: Tx, ref: ResourceRef, post: PostLido, canal: CanalDoPost, deps: DependenciasDoPost): Promise<CanalLido> {
    const c = await tx.execute<CanalLido>(sql`
      select ch.id, ch.status, ch.container_id, ch.body, a.external_id, a.credential_secret_id, a.id as conta
        from liame.social_post_channel ch
        join liame.connected_account a on a.id = ch.connected_account_id and a.tenant_id = ch.tenant_id
       where ch.post_id = ${post.estado.post} and ch.tenant_id = ${ref.tenantId} and ch.channel = ${canal}
       for update of ch`);
    const linha = c.rows[0];
    if (!linha) throw new CanalNaoSaiu(SUMIU);
    // A conta do pedido o executor já conferiu; a do outro canal, aqui (a trava por conta vale para os dois).
    if (linha.conta !== ref.accountId && deps.trava) {
      const travado = await deps.trava(tx, { tenantId: ref.tenantId, brandId: post.marca, provider: PROVEDOR_DO_CANAL[canal], accountId: linha.conta });
      if (travado) {
        const frase = `Uma trava está ligada (${travado}). ${NAO_SAIU[canal]}`;
        await this.naoSaiu(tx, ref, post, linha.id, frase, deps);
        throw new CanalNaoSaiu(frase);
      }
    }
    return linha;
  }

  private async token(tx: Tx, secretId: string | null, deps: DependenciasDoPost): Promise<string> {
    const guardada = secretId ? await deps.lerSegredo(tx, secretId) : null;
    const credencial = guardada ? (JSON.parse(guardada) as CredencialGuardada) : null;
    if (!credencial || credencial.tipo !== 'meta') throw new ErroConector('autenticacao', META, 'autorização revogada ou ausente');
    return credencial.access_token;
  }

  /** As versões registradas das capacidades que o canal usa. */
  private async versoes(deps: DependenciasDoPost, capacidades: readonly CapacidadeDoPost[]): Promise<Partial<Record<CapacidadeDoPost, string>>> {
    const v: Partial<Record<CapacidadeDoPost, string>> = {};
    for (const c of capacidades) v[c] = await deps.versao(c);
    return v;
  }

  /** Uma chamada à Graph API: o token no cabeçalho e a prova do segredo do app no endereço (nunca o token, V161). */
  private async chamar<T>(
    g: Graph,
    metodo: 'GET' | 'POST',
    caminho: string,
    capacidade: CapacidadeDoPost,
    o: { params?: Record<string, string>; corpo?: Record<string, string>; custo?: number } = {},
  ): Promise<T | null> {
    const versao = g.versoes[capacidade];
    if (!versao) throw new Error(`post nas redes: a versão de ${capacidade} não foi lida`);
    const q = new URLSearchParams(o.params ?? {});
    if (g.deps.appSecret) q.set('appsecret_proof', createHmac('sha256', g.deps.appSecret).update(g.token).digest('hex'));
    const consulta = q.toString();
    const r = await g.deps.cliente().requisitar<T | null>({
      provider: META,
      conta: g.conta,
      url: `${g.deps.graphUrl}/${versao}/${caminho}${consulta ? `?${consulta}` : ''}`,
      metodo,
      endpoint: capacidade,
      apiVersion: versao,
      cabecalhos: { authorization: `Bearer ${g.token}` },
      ...(o.corpo ? { corpo: o.corpo } : {}),
      ...(o.custo ? { custo: o.custo } : {}),
    });
    return r.corpo;
  }

  /** O canal que não sai: a frase da recusa da Meta (ou a nossa), anotada no canal. O passageiro sobe para o trilho. */
  private async recusaDoCanal(tx: Tx, ref: ResourceRef, post: PostLido, canal: CanalDoPost, linha: string, err: unknown, deps: DependenciasDoPost): Promise<never> {
    if (err instanceof CanalNaoSaiu) {
      await this.naoSaiu(tx, ref, post, linha, err.message, deps);
      throw err;
    }
    const motivo = recusaDaRede(err, canal);
    if (!motivo) throw err;
    if (err instanceof ErroConector) {
      // O que a Meta disse fica no registro, para quem cuida do produto; a pessoa lê a frase em português.
      this.logger.warn(`post ${post.estado.post}: a Meta recusou ${NO_CANAL[canal]} (${err.tipo}, HTTP ${err.status ?? '?'}, código ${err.codigoProvider ?? '?'}): ${err.message}`);
    }
    await this.naoSaiu(tx, ref, post, linha, motivo, deps);
    throw new CanalNaoSaiu(motivo);
  }

  private async publicado(tx: Tx, ref: ResourceRef, post: PostLido, canal: string, externo: string | null, permalink: string | null, deps: DependenciasDoPost): Promise<void> {
    await tx.execute(sql`
      update liame.social_post_channel
         set status = 'publicado', external_id = ${externo}, permalink = ${permalink}, error = null,
             published_at = coalesce(published_at, now()), attempted_at = coalesce(attempted_at, now()), updated_at = now(),
             -- A primeira leitura dos números, uma hora depois de sair (A6, Z7, parte c; D-A6-51).
             metrics_next_at = coalesce(metrics_next_at, now() + make_interval(mins => ${PRIMEIRA_LEITURA_MIN}))
       where id = ${canal}`);
    await this.limparRecorte(tx, ref, post, deps);
  }

  private async naoSaiu(tx: Tx, ref: ResourceRef, post: PostLido, canal: string, motivo: string, deps: DependenciasDoPost): Promise<void> {
    await tx.execute(sql`
      update liame.social_post_channel
         set status = 'falhou', error = ${motivo.slice(0, 500)}, attempted_at = coalesce(attempted_at, now()), updated_at = now()
       where id = ${canal}`);
    await this.limparRecorte(tx, ref, post, deps);
  }

  // ---- O Instagram -------------------------------------------------------------------------------------------------

  private async noInstagram(tx: Tx, ref: ResourceRef, post: PostLido, deps: DependenciasDoPost): Promise<void> {
    const canal = await this.canal(tx, ref, post, 'instagram', deps);
    if (canal.status === 'publicado') return;
    try {
      const g: Graph = { deps, conta: canal.external_id, token: await this.token(tx, canal.credential_secret_id, deps), versoes: await this.versoes(deps, ['instagram_publish', 'instagram_media']) };
      const ig = canal.external_id;

      // 1. A tentativa anterior pode ter publicado sem a resposta chegar: o post já está lá?
      const recentes = await this.chamar<unknown>(g, 'GET', `${ig}/media`, 'instagram_media', { params: { fields: 'id,caption,timestamp,permalink', limit: String(RECENTES) } });
      const jaSaiu = postJaPublicado(recentes, canal.body, post.criadoEm);
      if (jaSaiu) return await this.publicado(tx, ref, post, canal.id, jaSaiu.id, jaSaiu.permalink, deps);

      // 2. O contêiner da tentativa anterior, antes de criar outro.
      if (canal.container_id) {
        const situacao = await this.situacao(g, canal.container_id);
        if (situacao === 'publicado') return await this.publicado(tx, ref, post, canal.id, null, null, deps);
        if (situacao === 'pronto') return await this.publicarNoInstagram(tx, ref, post, canal.id, canal.container_id, g);
        if (situacao === 'processando') throw emPreparo();
        if (situacao === 'erro') throw new CanalNaoSaiu(FOTO_RECUSADA('instagram'));
        // Vencido (passou de 24 horas) ou sem situação conhecida: um contêiner novo.
      }

      // 3. O limite de posts pela API, antes de criar o contêiner (A6-11).
      const limite = limiteDePosts(await this.chamar<unknown>(g, 'GET', `${ig}/content_publishing_limit`, 'instagram_media', { params: { fields: 'quota_usage,config' } }));
      if (limite && limite.usados >= limite.total) {
        throw new ErroConector('limite', META, `o Instagram chegou a ${limite.usados} de ${limite.total} posts pela API nas últimas 24 horas`, null, ESPERA_DA_COTA_MS, COTA_DE_POSTS);
      }

      // 4. O contêiner: a foto (recortada, se não cabe no Instagram) e a legenda. A Meta busca a imagem na hora.
      const imagem = await this.imagemDoInstagram(tx, ref, post, deps);
      const conteiner = idDaResposta(await this.chamar<unknown>(g, 'POST', `${ig}/media`, 'instagram_publish', { corpo: { image_url: imagem, caption: canal.body }, custo: 3 }));
      if (!conteiner) throw new CanalNaoSaiu(NAO_ACEITOU('instagram'));
      await tx.execute(sql`
        update liame.social_post_channel
           set container_id = ${conteiner}, status = 'publicando', attempted_at = now(), error = null, updated_at = now()
         where id = ${canal.id}`);
      await esperar(deps.esperaDoConteinerMs ?? PRIMEIRA_CONFERENCIA_MS);
      const situacao = await this.situacao(g, conteiner);
      if (situacao === 'pronto') return await this.publicarNoInstagram(tx, ref, post, canal.id, conteiner, g);
      if (situacao === 'publicado') return await this.publicado(tx, ref, post, canal.id, null, null, deps);
      if (situacao === 'erro') throw new CanalNaoSaiu(FOTO_RECUSADA('instagram'));
      // Ainda preparando a foto (ou sem situação conhecida logo depois de criar): o pedido espera um minuto.
      throw emPreparo();
    } catch (err) {
      return await this.recusaDoCanal(tx, ref, post, 'instagram', canal.id, err, deps);
    }
  }

  private async situacao(g: Graph, conteiner: string): Promise<SituacaoDoConteiner> {
    const r = await this.chamar<{ status_code?: unknown }>(g, 'GET', conteiner, 'instagram_media', { params: { fields: 'status_code' } });
    return situacaoDoConteiner(r?.status_code);
  }

  /** Publica o contêiner pronto e guarda o post publicado (o id e o endereço). */
  private async publicarNoInstagram(tx: Tx, ref: ResourceRef, post: PostLido, canal: string, conteiner: string, g: Graph): Promise<void> {
    let publicado: unknown;
    try {
      publicado = await this.chamar<unknown>(g, 'POST', `${g.conta}/media_publish`, 'instagram_publish', { corpo: { creation_id: conteiner }, custo: 3 });
    } catch (err) {
      // "A mídia ainda não está pronta" (código 9007): espera, como o contêiner que prepara a foto (base §2.2, [NC]).
      if (err instanceof ErroConector && err.tipo === 'definitivo' && err.codigoProvider === '9007') throw emPreparo();
      throw err;
    }
    const id = idDaResposta(publicado);
    let permalink: string | null = null;
    if (id) {
      // O endereço do post é só para a Agenda: se a leitura falhar, o post saiu do mesmo jeito.
      try {
        permalink = enderecoDoPost((await this.chamar<{ permalink?: unknown }>(g, 'GET', id, 'instagram_media', { params: { fields: 'permalink' } }))?.permalink);
      } catch (err) {
        if (!(err instanceof ErroConector)) throw err;
      }
    }
    await this.publicado(tx, ref, post, canal, id, permalink, g.deps);
  }

  /**
   * O endereço assinado da foto que vai ao Instagram (5 minutos, como a tela das Fotos): a própria foto, quando cabe; o
   * recorte na posição aprovada, quando não cabe (D-A6-21), gravado ao lado das fotos da marca.
   */
  private async imagemDoInstagram(tx: Tx, ref: ResourceRef, post: PostLido, deps: DependenciasDoPost): Promise<string> {
    const foto = post.foto;
    if (!foto) throw new CanalNaoSaiu(SEM_ARQUIVO('instagram'));
    try {
      if (recorteDoInstagram(foto.largura, foto.altura) === 'nenhum') return await deps.armazem.enderecoDeLeitura(foto.chave, VALIDADE_DO_ENDERECO_S);
      const recorte = await (deps.recortar ?? recortarParaOInstagram)(await deps.armazem.ler(foto.chave), post.estado.recorte ?? 50);
      if (!recorte) return await deps.armazem.enderecoDeLeitura(foto.chave, VALIDADE_DO_ENDERECO_S);
      const chave = chaveDoRecorteDoPost(ref.tenantId, post.marca, post.estado.post);
      await deps.armazem.gravar(chave, recorte);
      // Guardar a chave não muda a versão do post: é o arquivo de passagem, não o que o post é.
      await tx.execute(sql`update liame.social_post set instagram_object_key = ${chave}, updated_at = now() where id = ${post.estado.post} and tenant_id = ${ref.tenantId}`);
      post.recorteGuardado = chave;
      return await deps.armazem.enderecoDeLeitura(chave, VALIDADE_DO_ENDERECO_S);
    } catch (err) {
      if (err instanceof FalhaDoArmazem && err.semArquivo) throw new CanalNaoSaiu(SEM_ARQUIVO('instagram'));
      throw err;
    }
  }

  /** O recorte sai assim que o Instagram buscou a imagem (o post publicado, ou o canal que não sai). */
  private async limparRecorte(tx: Tx, ref: ResourceRef, post: PostLido, deps: DependenciasDoPost): Promise<void> {
    const chave = post.recorteGuardado;
    if (!chave) return;
    try {
      await deps.armazem.apagar([chave]);
    } catch (err) {
      // Fica para o apagamento da marca ou da empresa (o prefixo leva o recorte junto); o post não depende dele.
      this.logger.warn(`post ${post.estado.post}: o recorte do Instagram não foi apagado (${err instanceof Error ? err.message : String(err)})`);
      return;
    }
    await tx.execute(sql`update liame.social_post set instagram_object_key = null, updated_at = now() where id = ${post.estado.post} and tenant_id = ${ref.tenantId}`);
    post.recorteGuardado = null;
  }

  // ---- A Página do Facebook ----------------------------------------------------------------------------------------

  private async naPagina(tx: Tx, ref: ResourceRef, post: PostLido, deps: DependenciasDoPost): Promise<void> {
    const canal = await this.canal(tx, ref, post, 'facebook', deps);
    if (canal.status === 'publicado') return;
    try {
      const pagina = canal.external_id;
      const versoes = await this.versoes(deps, ['pages', 'pagina_publish', 'pagina_media']);
      // O token da Página, pela lista das Páginas da autorização (com as tarefas de quem autorizou).
      const daAutorizacao: Graph = { deps, conta: pagina, token: await this.token(tx, canal.credential_secret_id, deps), versoes };
      const contas = await this.chamar<unknown>(daAutorizacao, 'GET', 'me/accounts', 'pages', { params: { fields: 'id,access_token,tasks', limit: '100' } });
      const daPagina = tokenDaPagina(contas, pagina);
      if (!daPagina) throw new CanalNaoSaiu(PAGINA_FORA);
      if (!daPagina.podePublicar) throw new CanalNaoSaiu(SEM_PERMISSAO.facebook);
      const g: Graph = { deps, conta: pagina, token: daPagina.token, versoes };

      // 1. A tentativa anterior pode ter publicado sem a resposta chegar: a foto já está na Página?
      let fotos: unknown = null;
      try {
        fotos = await this.chamar<unknown>(g, 'GET', `${pagina}/photos`, 'pagina_media', { params: { type: 'uploaded', fields: 'id,name,created_time,link,page_story_id', limit: String(RECENTES) } });
      } catch (err) {
        // Sem a lista (ler as fotos pede outra tarefa na Página): na primeira tentativa, publica; depois de uma
        // tentativa sem resposta, não arrisca publicar de novo.
        if (!(err instanceof ErroConector) || (err.tipo !== 'permissao' && err.tipo !== 'definitivo')) throw err;
        if (canal.status === 'publicando') throw new CanalNaoSaiu(SEM_CONFERIR);
      }
      const jaSaiu = fotoJaNaPagina(fotos, canal.body, post.criadoEm);
      if (jaSaiu) return await this.publicado(tx, ref, post, canal.id, jaSaiu.post ?? jaSaiu.id, jaSaiu.link, deps);

      // 2. A foto inteira (a Página aceita qualquer proporção), até 4 MB, e a legenda. A tentativa fica anotada antes.
      const foto = post.foto;
      if (!foto) throw new CanalNaoSaiu(SEM_ARQUIVO('facebook'));
      if (foto.bytes > MAIOR_FOTO_DA_PAGINA_BYTES) throw new CanalNaoSaiu(FOTO_GRANDE);
      let imagem: string;
      try {
        imagem = await deps.armazem.enderecoDeLeitura(foto.chave, VALIDADE_DO_ENDERECO_S);
      } catch (err) {
        if (err instanceof FalhaDoArmazem && err.semArquivo) throw new CanalNaoSaiu(SEM_ARQUIVO('facebook'));
        throw err;
      }
      await tx.execute(sql`update liame.social_post_channel set status = 'publicando', attempted_at = now(), error = null, updated_at = now() where id = ${canal.id}`);
      const r = await this.chamar<{ id?: unknown; post_id?: unknown }>(g, 'POST', `${pagina}/photos`, 'pagina_publish', { corpo: { url: imagem, caption: canal.body }, custo: 3 });
      const foi = idDoPostDaPagina(r?.post_id) ?? idDaResposta(r);
      if (!foi) throw new CanalNaoSaiu(NAO_ACEITOU('facebook'));
      // O endereço do post é só para a Agenda: se a leitura falhar, o post saiu do mesmo jeito.
      let permalink: string | null = null;
      const postDaPagina = idDoPostDaPagina(r?.post_id);
      if (postDaPagina) {
        try {
          permalink = enderecoNaPagina((await this.chamar<{ permalink_url?: unknown }>(g, 'GET', postDaPagina, 'pagina_media', { params: { fields: 'permalink_url' } }))?.permalink_url);
        } catch (err) {
          if (!(err instanceof ErroConector)) throw err;
        }
      }
      await this.publicado(tx, ref, post, canal.id, foi, permalink, deps);
    } catch (err) {
      // A Página recusa a imagem com o código 324 ("Missing or invalid image file").
      if (err instanceof ErroConector && err.tipo === 'definitivo' && err.codigoProvider === '324') {
        return await this.recusaDoCanal(tx, ref, post, 'facebook', canal.id, new CanalNaoSaiu(FOTO_RECUSADA('facebook')), deps);
      }
      return await this.recusaDoCanal(tx, ref, post, 'facebook', canal.id, err, deps);
    }
  }
}

const recusado = (mensagem: string): ApplyResult => ({ ok: false, reason: 'recusado', mensagem });

/** O contêiner ainda prepara a foto: o pedido espera um minuto (a Meta recomenda conferir uma vez por minuto). */
function emPreparo(): ErroConector {
  return new ErroConector('limite', META, 'o Instagram ainda prepara a foto do post', null, ESPERA_DO_CONTEINER_MS, CONTEINER_EM_PREPARO);
}

/**
 * A recusa definitiva da Meta em palavras, para o canal; nulo para o que é passageiro (limite, fora do ar, o contêiner
 * em preparo): isso sobe para o trilho adiar. O texto da Meta não vai para a pessoa (vem em inglês e é de quem programa).
 */
export function recusaDaRede(err: unknown, canal: CanalDoPost): string | null {
  if (!(err instanceof ErroConector)) return null;
  if (err.tipo === 'autenticacao') return SEM_ACESSO(canal);
  if (err.tipo === 'permissao') return SEM_PERMISSAO[canal];
  if (err.tipo !== 'definitivo') return null;
  return NAO_ACEITOU(canal);
}

/** Um para cada provedor do pedido do post: o do Instagram e o da Página (a conta do primeiro canal). */
export const postNoInstagramConnector = new PostPublicacaoConnector(PROVEDOR_DO_CANAL.instagram);
export const postNaPaginaConnector = new PostPublicacaoConnector(PROVEDOR_DO_CANAL.facebook);
