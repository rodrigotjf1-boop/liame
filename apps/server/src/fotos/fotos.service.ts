import {
  BRAND_VIDEO_LIMITS,
  BrandDossierContent,
  type BrandPhoto,
  type BrandPhotosResponse,
  type BrandVideoUploadResponse,
  type CreateBrandVideoRequest,
  DOSSIER_CONTENT_VERSION,
  type UpdateBrandPhotoRequest,
} from '@liame/contracts';
import { type Database, uuidv7 } from '@liame/database';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { naTransacaoDaEmpresa } from '../ai/na-empresa.js';
import { activeTraceId, writeAudit } from '../audit/audit.js';
import { type AuthContext, auditDetail, currentTx } from '../context/request-context.js';
import { actorLabel, actorTypeOf } from '../context/unit-of-work.interceptor.js';
import { DATABASE } from '../database/database.module.js';
import { AppProblem } from '../errors/problems.js';
import { FlagService } from '../flags/flag.service.js';
import { ARMAZEM_DE_IMAGENS, type ArmazemDeImagens, ArmazemIndisponivel } from '../imagens/armazem.js';
import { lerCabecalhoDoVideo, VideoIlegivel } from './cabecalho-do-video.js';
import {
  chaveDaFoto,
  chaveDaMiniatura,
  chaveDoVideo,
  conferirVideo,
  estreitaParaOInstagram,
  medidasNoReels,
  type MotivoDaRecusaDoVideo,
  orientacao,
  RECUSAS,
  RECUSAS_DO_VIDEO,
  recorteDoInstagram,
} from './conferencia.js';
import { type FotoProcessada, processarCapa, processarFoto, RecusaDaFoto, SemSharp } from './processar.js';

// Fotos dos produtos (A6, Z4; ADR-021; protótipo P20, aprovado em 21/10/2026; D-A6-19). A empresa envia as fotos de
// verdade dos produtos, para os posts. O Liame guarda uma cópia regravada (JPEG, o lado maior em até 2.048 px, sem os
// dados do celular) e a miniatura no armazenamento de imagens, e aqui o registro. Ver a foto é por um endereço
// assinado de 5 minutos. Apagar tira a foto da lista na hora; a rotina `fotos` do worker tira o arquivo e depois a
// linha. Com a função `fotos` desligada, a lista vem vazia e enviar e mudar respondem 409; apagar sempre vale.
// O vídeo (A6 · Z10, parte 1; D-A6-67 e D-A6-68), com a função `videos` ligada: o navegador manda o arquivo direto
// ao armazenamento (o endereço de envio assinado); o Liame confere o cabeçalho (MP4 ou MOV, de 3 a 90 s, até 300 MB,
// até o 4K, H.264 ou HEVC com o som em AAC) e só então o vídeo fica pronto; a capa é um quadro que a tela tira dele.

export const FLAG_FOTOS = 'fotos';
export const FLAG_VIDEOS = 'videos';
export const ACAO_VIDEO_CONCLUIR = 'fotos.video_concluir';
export const ACAO_CAPA = 'fotos.capa';
export const ACAO_ENVIAR = 'fotos.enviar';
export const RECURSO = 'brand_photo';

/** Quanto vale o endereço assinado de uma foto (o bucket recusa assinatura com mais de 10 minutos). */
export const VALIDADE_DO_ENDERECO_S = 300;

/** A lista mostra as fotos mais novas, até este tanto. */
export const FOTOS_NA_LISTA = 500;

type Quem = { tenantId: string; userId: string };

type LinhaDaFoto = {
  id: string;
  brand_id: string;
  product: string | null;
  description: string;
  width: number;
  height: number;
  bytes: number;
  object_key: string;
  created_at: Date | string;
  uploaded_by: string | null;
  uploaded_by_name: string | null;
  kind: string;
  duration_ms: number | null;
  media_type: string | null;
  has_audio: boolean | null;
  has_cover: boolean;
};

const COLUNAS = sql`p.id, p.brand_id, p.product, p.description, p.width, p.height, p.bytes, p.object_key, p.created_at,
  p.uploaded_by, u.name as uploaded_by_name, p.kind, p.duration_ms, p.media_type, p.has_audio, p.has_cover`;

export function quemPede(auth: AuthContext): Quem {
  if (!auth.tenantId) throw new AppProblem(403, 'sem-empresa-ativa', 'Escolha uma empresa', 'Selecione uma empresa com acesso ativo.');
  return { tenantId: auth.tenantId, userId: auth.userId };
}

const iso = (v: Date | string): string => (v instanceof Date ? v : new Date(v)).toISOString();

function desligada(): AppProblem {
  return new AppProblem(409, 'funcao-desligada', 'Função desligada', 'Fotos não está ligado para esta empresa.');
}

function naoEncontrada(): AppProblem {
  return new AppProblem(404, 'foto-nao-encontrada', 'Não encontramos', 'Esta foto não está mais aqui.');
}

function indisponivel(): AppProblem {
  return new AppProblem(503, 'fotos-indisponiveis', 'Fotos indisponíveis', 'O armazenamento das fotos não está configurado. Tente mais tarde.');
}

function videosDesligados(): AppProblem {
  return new AppProblem(409, 'funcao-desligada', 'Função desligada', 'O vídeo nas Fotos não está ligado para esta empresa.');
}

function semEnvioDireto(): AppProblem {
  return new AppProblem(503, 'videos-indisponiveis', 'Vídeos indisponíveis', 'O envio de vídeo precisa do armazenamento na nuvem. Tente mais tarde.');
}

function recusaDoVideo(motivo: MotivoDaRecusaDoVideo): AppProblem {
  const r = RECUSAS_DO_VIDEO[motivo];
  return new AppProblem(422, r.code, r.title, r.detail);
}

function falhouAoGuardar(): AppProblem {
  return new AppProblem(502, 'foto-nao-guardada', 'A foto não foi guardada', 'Não deu para guardar a foto agora. Tente de novo.');
}

/** A marca é da empresa e não está arquivada (a RLS esconde a de outra empresa: 404). */
export async function marcaDaEmpresa(brandId: string): Promise<void> {
  const r = await currentTx().execute<{ id: string }>(sql`select id from liame.brand where id = ${brandId} and archived_at is null`);
  if (!r.rows[0]) throw new AppProblem(404, 'nao-encontrado', 'Não encontramos', 'Marca não encontrada nesta empresa.');
}

/** Os produtos de Minha marca, na versão atual do dossiê (vazio sem dossiê). */
async function produtosDaMarca(brandId: string): Promise<string[]> {
  const r = await currentTx().execute<{ content: unknown; content_version: number }>(sql`
    select content, content_version from liame.brand_dossier_version where brand_id = ${brandId} order by version desc limit 1`);
  const l = r.rows[0];
  if (!l || l.content_version > DOSSIER_CONTENT_VERSION) return [];
  return BrandDossierContent.parse(l.content).products.items;
}

@Injectable()
export class FotosService {
  private readonly logger = new Logger('fotos');

  constructor(
    @Inject(DATABASE) private readonly database: Database | null,
    @Inject(ARMAZEM_DE_IMAGENS) private readonly armazem: ArmazemDeImagens,
    private readonly flags: FlagService,
  ) {}

  private banco(): Database {
    if (!this.database) throw new Error('fotos: sem banco');
    return this.database;
  }

  private ligada(quem: Quem, brandId: string): Promise<boolean> {
    return this.flags.isEnabled(FLAG_FOTOS, this.flags.context({ tenantId: quem.tenantId, userId: quem.userId, brandId }));
  }

  /** O vídeo nas Fotos: as duas funções ligadas (`fotos` e `videos`). */
  private async videosLigados(quem: Quem, brandId: string): Promise<boolean> {
    if (!(await this.ligada(quem, brandId))) return false;
    return this.flags.isEnabled(FLAG_VIDEOS, this.flags.context({ tenantId: quem.tenantId, userId: quem.userId, brandId }));
  }

  /** A foto como a tela lê, com os endereços assinados. */
  private async paraTela(l: LinhaDaFoto, expira: Date): Promise<BrandPhoto> {
    let url: string;
    let miniatura: string;
    const video = l.kind === 'video';
    try {
      // O vídeo sem a capa ainda: a grade mostra o próprio arquivo (o navegador tira o primeiro quadro).
      [url, miniatura] = await Promise.all([
        this.armazem.enderecoDeLeitura(l.object_key, VALIDADE_DO_ENDERECO_S),
        this.armazem.enderecoDeLeitura(video && !l.has_cover ? l.object_key : chaveDaMiniatura(l.object_key), VALIDADE_DO_ENDERECO_S),
      ]);
    } catch (err) {
      if (err instanceof ArmazemIndisponivel) throw indisponivel();
      throw err;
    }
    // As medidas com que a mídia vai aos posts: a da cópia da foto; a do Reels no vídeo (o 4K vai reduzido, D-A6-68).
    const nosPosts = video ? medidasNoReels(l.width, l.height) : { largura: l.width, altura: l.height };
    return {
      id: l.id,
      brand_id: l.brand_id,
      product: l.product,
      description: l.description,
      width: nosPosts.largura,
      height: nosPosts.altura,
      bytes: l.bytes,
      orientation: orientacao(nosPosts.largura, nosPosts.altura),
      // Um vídeo vai como a loja gravou (o Reels não recorta): sem o aviso de nitidez nem o recorte da foto.
      narrow_for_instagram: video ? false : estreitaParaOInstagram(l.width),
      instagram_crop: video ? 'nenhum' : recorteDoInstagram(l.width, l.height),
      uploaded_at: iso(l.created_at),
      uploaded_by: l.uploaded_by ? { id: l.uploaded_by, name: l.uploaded_by_name ?? '' } : null,
      url,
      thumbnail_url: miniatura,
      urls_expire_at: expira.toISOString(),
      kind: l.kind,
      video:
        video && l.duration_ms !== null && l.media_type !== null
          ? {
              width: l.width,
              height: l.height,
              duration_ms: l.duration_ms,
              media_type: l.media_type,
              has_audio: l.has_audio === true,
              has_cover: l.has_cover,
            }
          : null,
    };
  }

  /** A lista da tela, na transação da rota. Desligada para a empresa, vazia. */
  async listar(auth: AuthContext, brandId: string, agora: Date = new Date()): Promise<BrandPhotosResponse> {
    const quem = quemPede(auth);
    await marcaDaEmpresa(brandId);
    const base: BrandPhotosResponse = { brand_id: brandId, enabled: false, can_manage: auth.permissions.has('fotos.enviar'), products: [], items: [] };
    if (!(await this.ligada(quem, brandId))) return base;
    if (!this.armazem.disponivel) throw indisponivel();
    const produtos = await produtosDaMarca(brandId);
    const r = await currentTx().execute<LinhaDaFoto>(sql`
      select ${COLUNAS}
        from liame.brand_photo p left join liame.app_user u on u.id = p.uploaded_by
       where p.brand_id = ${brandId} and p.status = 'pronta' and p.removed_at is null
       order by p.created_at desc, p.id desc
       limit ${FOTOS_NA_LISTA}`);
    const expira = new Date(agora.getTime() + VALIDADE_DO_ENDERECO_S * 1000);
    const items = await Promise.all(r.rows.map((l) => this.paraTela(l, expira)));
    return { ...base, enabled: true, products: produtos, items, videos_enabled: await this.videosLigados(quem, brandId) };
  }

  /**
   * Envia uma foto (o arquivo cru no corpo). Fora da transação da requisição: a conferência e a regravação acontecem
   * antes de qualquer gravação, o banco em transações curtas, e o arquivo vai ao armazenamento sem transação aberta.
   * A linha nasce `enviando` antes do arquivo (todo arquivo guardado tem linha); a foto só aparece depois de `pronta`,
   * junto com o evento de auditoria.
   */
  async enviar(auth: AuthContext, brandId: string, corpo: unknown): Promise<BrandPhoto> {
    const quem = quemPede(auth);
    const database = this.banco();
    if (!Buffer.isBuffer(corpo) || corpo.length === 0) {
      throw new AppProblem(400, 'foto-sem-arquivo', 'Falta a foto', 'Mande o arquivo da foto no corpo do pedido (JPEG, PNG ou WebP).');
    }
    await naTransacaoDaEmpresa(database, quem, async () => {
      await marcaDaEmpresa(brandId);
      if (!(await this.ligada(quem, brandId))) throw desligada();
    });
    if (!this.armazem.disponivel) throw indisponivel();

    let foto: FotoProcessada;
    try {
      foto = await processarFoto(corpo);
    } catch (err) {
      if (err instanceof RecusaDaFoto) {
        const r = RECUSAS[err.motivo];
        throw new AppProblem(422, r.code, r.title, r.detail);
      }
      if (err instanceof SemSharp) {
        // Só o envio de fotos para: o binário da biblioteca de imagem não abriu neste processo (V6: a causa no log).
        this.logger.error(err.message);
        throw new AppProblem(503, 'fotos-indisponiveis', 'Fotos indisponíveis', 'Não dá para conferir fotos agora. Tente mais tarde.');
      }
      throw err;
    }

    const id = uuidv7();
    const chave = chaveDaFoto(quem.tenantId, brandId, id);
    try {
      await naTransacaoDaEmpresa(database, quem, async () => {
        await marcaDaEmpresa(brandId);
        await currentTx().execute(sql`
          insert into liame.brand_photo (id, tenant_id, brand_id, status, object_key, sha256, bytes, width, height, uploaded_by)
          values (${id}, ${quem.tenantId}, ${brandId}, 'enviando', ${chave}, ${foto.sha256}, ${foto.copia.bytes.length},
                  ${foto.copia.largura}, ${foto.copia.altura}, ${quem.userId})`);
      });
    } catch (err) {
      const causa = (err as { cause?: { code?: string; constraint?: string } }).cause;
      if (causa?.code === '23505' && causa.constraint === 'brand_photo_repetida') {
        throw new AppProblem(409, 'foto-repetida', 'Essa foto já está aqui', 'Essa foto já está aqui.');
      }
      throw err;
    }

    try {
      await this.armazem.gravar(chave, foto.copia.bytes);
      await this.armazem.gravar(chaveDaMiniatura(chave), foto.miniatura.bytes);
    } catch (err) {
      this.logger.warn(`foto ${id}: o armazenamento não guardou (${err instanceof Error ? err.message : String(err)})`);
      // A linha sai da lista e da conta das repetidas; a rotina tira o que chegou a ser gravado e depois a linha.
      await naTransacaoDaEmpresa(database, quem, () =>
        currentTx().execute(sql`update liame.brand_photo set removed_at = now(), updated_at = now() where id = ${id}`),
      ).catch((e: unknown) => this.logger.error(`foto ${id}: não marcou o envio que falhou (${e instanceof Error ? e.message : String(e)})`));
      if (err instanceof ArmazemIndisponivel) throw indisponivel();
      throw falhouAoGuardar();
    }

    return naTransacaoDaEmpresa(database, quem, async () => {
      const tx = currentTx();
      const r = await tx.execute<LinhaDaFoto>(sql`
        with pronta as (
          update liame.brand_photo set status = 'pronta', updated_at = now() where id = ${id} and removed_at is null returning *)
        select ${COLUNAS} from pronta p left join liame.app_user u on u.id = p.uploaded_by`);
      const linha = r.rows[0];
      if (!linha) throw naoEncontrada();
      await writeAudit(tx, {
        tenantId: quem.tenantId,
        actorType: actorTypeOf(auth),
        actorId: quem.userId,
        actorLabel: actorLabel(auth),
        actorRole: auth.roleKey,
        action: ACAO_ENVIAR,
        resourceType: RECURSO,
        resourceId: id,
        after: { brand_id: brandId, width: linha.width, height: linha.height, bytes: linha.bytes },
        traceId: activeTraceId(),
        origin: 'api',
      });
      return this.paraTela(linha, new Date(Date.now() + VALIDADE_DO_ENDERECO_S * 1000));
    });
  }

  /** Muda o produto ou o que aparece na foto (na transação da rota, com a auditoria dela). */
  async atualizar(auth: AuthContext, id: string, body: UpdateBrandPhotoRequest): Promise<BrandPhoto> {
    const quem = quemPede(auth);
    const tx = currentTx();
    const lida = await tx.execute<{ brand_id: string; product: string | null; description: string }>(sql`
      select brand_id, product, description from liame.brand_photo
       where id = ${id} and status = 'pronta' and removed_at is null for update`);
    const antes = lida.rows[0];
    if (!antes) throw naoEncontrada();
    if (!(await this.ligada(quem, antes.brand_id))) throw desligada();
    if (!this.armazem.disponivel) throw indisponivel();
    if (body.product) {
      const produtos = await produtosDaMarca(antes.brand_id);
      if (!produtos.includes(body.product)) {
        throw new AppProblem(422, 'produto-fora-da-marca', 'Produto fora de Minha marca', 'Escolha um dos produtos de Minha marca, ou "Sem produto".', {}, [
          { path: 'product', message: 'Este produto não está em Minha marca.' },
        ]);
      }
    }
    const product = body.product === undefined ? antes.product : body.product;
    const description = body.description ?? antes.description;
    const r = await tx.execute<LinhaDaFoto>(sql`
      with mudou as (
        update liame.brand_photo set product = ${product}, description = ${description}, updated_at = now() where id = ${id} returning *)
      select ${COLUNAS} from mudou p left join liame.app_user u on u.id = p.uploaded_by`);
    const linha = r.rows[0];
    if (!linha) throw naoEncontrada();
    auditDetail({ resourceId: id, before: { product: antes.product, description: antes.description }, after: { product, description } });
    return this.paraTela(linha, new Date(Date.now() + VALIDADE_DO_ENDERECO_S * 1000));
  }

  // ------------------------------------------------------------------ o vídeo (A6 · Z10, parte 1)

  /**
   * Pede o envio de um vídeo (na transação da rota): guarda o pedido (`enviando`) e devolve o endereço de envio direto,
   * que vale 10 minutos. O navegador manda o arquivo e depois pede a conferência (`concluirVideo`).
   */
  async pedirEnvioDeVideo(auth: AuthContext, body: CreateBrandVideoRequest, agora: Date = new Date()): Promise<BrandVideoUploadResponse> {
    const quem = quemPede(auth);
    await marcaDaEmpresa(body.brand_id);
    if (!(await this.videosLigados(quem, body.brand_id))) throw videosDesligados();
    if (!this.armazem.disponivel) throw indisponivel();
    const id = uuidv7();
    const chave = chaveDoVideo(quem.tenantId, body.brand_id, id, body.media_type);
    let url: string | null;
    try {
      url = await this.armazem.enderecoDeEnvio(chave, body.media_type, body.bytes, BRAND_VIDEO_LIMITS.uploadSeconds);
    } catch (err) {
      if (err instanceof ArmazemIndisponivel) throw indisponivel();
      throw err;
    }
    if (!url) throw semEnvioDireto();
    await currentTx().execute(sql`
      insert into liame.brand_photo (id, tenant_id, brand_id, kind, status, object_key, bytes, media_type, uploaded_by)
      values (${id}, ${quem.tenantId}, ${body.brand_id}, 'video', 'enviando', ${chave}, ${body.bytes}, ${body.media_type}, ${quem.userId})`);
    auditDetail({ resourceId: id, after: { brand_id: body.brand_id, media_type: body.media_type, bytes: body.bytes } });
    return {
      id,
      upload: {
        url,
        method: 'PUT',
        headers: { 'content-type': body.media_type },
        expires_at: new Date(agora.getTime() + BRAND_VIDEO_LIMITS.uploadSeconds * 1000).toISOString(),
      },
    };
  }

  /**
   * Confere o vídeo que chegou ao armazenamento (fora da transação da rota: a leitura do cabeçalho vai ao armazenamento).
   * Pronto, devolve o vídeo como a tela lê. Recusado, o vídeo sai da lista (a rotina tira o arquivo) e a resposta diz por
   * quê (422). Pedir de novo o que já ficou pronto devolve o mesmo vídeo.
   */
  async concluirVideo(auth: AuthContext, id: string): Promise<BrandPhoto> {
    const quem = quemPede(auth);
    const database = this.banco();
    const linha = await naTransacaoDaEmpresa(database, quem, async () => {
      const r = await currentTx().execute<{ brand_id: string; object_key: string; status: string }>(sql`
        select brand_id, object_key, status from liame.brand_photo where id = ${id} and kind = 'video' and removed_at is null`);
      const l = r.rows[0];
      if (!l) throw naoEncontrada();
      if (!(await this.videosLigados(quem, l.brand_id))) throw videosDesligados();
      return l;
    });
    if (linha.status === 'pronta') return this.doVideo(quem, id);
    if (!this.armazem.disponivel) throw indisponivel();

    let tamanho: number | null;
    let motivo: MotivoDaRecusaDoVideo | null;
    let cabecalho: Awaited<ReturnType<typeof lerCabecalhoDoVideo>> | null = null;
    try {
      tamanho = await this.armazem.tamanho(linha.object_key);
      if (tamanho === null) {
        throw new AppProblem(409, 'video-nao-chegou', 'O vídeo não chegou', 'O vídeo ainda não chegou ao armazenamento. Envie de novo.');
      }
      if (tamanho > BRAND_VIDEO_LIMITS.maxBytes) {
        motivo = 'grande';
      } else {
        const chave = linha.object_key;
        cabecalho = await lerCabecalhoDoVideo((inicio, fim) => this.armazem.lerTrecho(chave, inicio, fim), tamanho);
        motivo = conferirVideo(cabecalho, tamanho);
      }
    } catch (err) {
      if (err instanceof VideoIlegivel) {
        motivo = 'nao_abre';
        tamanho = null;
      } else if (err instanceof ArmazemIndisponivel) {
        throw indisponivel();
      } else if (err instanceof AppProblem) {
        throw err;
      } else {
        // V6: a causa no log; para a pessoa, tentar de novo (o arquivo continua lá).
        this.logger.warn(`vídeo ${id}: o armazenamento não leu o cabeçalho (${err instanceof Error ? err.message : String(err)})`);
        throw new AppProblem(502, 'video-nao-conferido', 'O vídeo não foi conferido', 'Não deu para conferir o vídeo agora. Tente de novo.');
      }
    }

    if (motivo || !cabecalho || tamanho === null) {
      // Recusado: sai da lista na hora, e a rotina tira o arquivo e depois a linha.
      await naTransacaoDaEmpresa(database, quem, () =>
        currentTx().execute(sql`update liame.brand_photo set removed_at = now(), updated_at = now() where id = ${id} and status = 'enviando'`),
      );
      throw recusaDoVideo(motivo ?? 'nao_abre');
    }

    const c = cabecalho;
    const bytes = tamanho;
    return naTransacaoDaEmpresa(database, quem, async () => {
      const tx = currentTx();
      const r = await tx.execute<{ id: string; brand_id: string }>(sql`
        update liame.brand_photo
           set status = 'pronta', bytes = ${bytes}, width = ${c.largura}, height = ${c.altura}, duration_ms = ${c.duracaoMs},
               has_audio = ${c.temAudio}, updated_at = now()
         where id = ${id} and kind = 'video' and status = 'enviando' and removed_at is null
        returning id, brand_id`);
      const pronta = r.rows[0];
      // Outro pedido concluiu antes (o navegador repetiu): o vídeo que ele deixou pronto.
      if (!pronta) return this.videoNaTransacao(id);
      await writeAudit(tx, {
        tenantId: quem.tenantId,
        actorType: actorTypeOf(auth),
        actorId: quem.userId,
        actorLabel: actorLabel(auth),
        actorRole: auth.roleKey,
        action: ACAO_VIDEO_CONCLUIR,
        resourceType: RECURSO,
        resourceId: id,
        after: { brand_id: pronta.brand_id, width: c.largura, height: c.altura, duration_ms: c.duracaoMs, bytes, has_audio: c.temAudio },
        traceId: activeTraceId(),
        origin: 'api',
      });
      return this.videoNaTransacao(id);
    });
  }

  /**
   * O vídeo pronto como a tela lê, na transação já aberta: a mudança que ela acabou de fazer ainda não foi gravada, e
   * outra transação (outra conexão) não a enxergaria.
   */
  private async videoNaTransacao(id: string): Promise<BrandPhoto> {
    const r = await currentTx().execute<LinhaDaFoto>(sql`
      select ${COLUNAS} from liame.brand_photo p left join liame.app_user u on u.id = p.uploaded_by
       where p.id = ${id} and p.kind = 'video' and p.status = 'pronta' and p.removed_at is null`);
    const l = r.rows[0];
    if (!l) throw naoEncontrada();
    return this.paraTela(l, new Date(Date.now() + VALIDADE_DO_ENDERECO_S * 1000));
  }

  /** O vídeo pronto como a tela lê, numa transação da empresa nova. */
  private doVideo(quem: Quem, id: string): Promise<BrandPhoto> {
    return naTransacaoDaEmpresa(this.banco(), quem, () => this.videoNaTransacao(id));
  }

  /**
   * Grava a capa do vídeo pronto (um quadro que a tela tira dele, D-A6-70): vira a miniatura da grade. Fora da transação
   * da rota (a imagem é processada antes).
   */
  async gravarCapa(auth: AuthContext, id: string, corpo: unknown): Promise<BrandPhoto> {
    const quem = quemPede(auth);
    const database = this.banco();
    if (!Buffer.isBuffer(corpo) || corpo.length === 0) {
      throw new AppProblem(400, 'capa-sem-arquivo', 'Falta a capa', 'Mande a imagem da capa no corpo do pedido (JPEG, PNG ou WebP).');
    }
    const linha = await naTransacaoDaEmpresa(database, quem, async () => {
      const r = await currentTx().execute<{ brand_id: string; object_key: string }>(sql`
        select brand_id, object_key from liame.brand_photo where id = ${id} and kind = 'video' and status = 'pronta' and removed_at is null`);
      const l = r.rows[0];
      if (!l) throw naoEncontrada();
      if (!(await this.videosLigados(quem, l.brand_id))) throw videosDesligados();
      return l;
    });
    if (!this.armazem.disponivel) throw indisponivel();
    let capa: Awaited<ReturnType<typeof processarCapa>>;
    try {
      capa = await processarCapa(corpo);
    } catch (err) {
      if (err instanceof RecusaDaFoto) {
        const r = RECUSAS[err.motivo];
        throw new AppProblem(422, r.code, r.title, r.detail);
      }
      if (err instanceof SemSharp) {
        this.logger.error(err.message);
        throw new AppProblem(503, 'fotos-indisponiveis', 'Fotos indisponíveis', 'Não dá para conferir imagens agora. Tente mais tarde.');
      }
      throw err;
    }
    try {
      await this.armazem.gravar(chaveDaMiniatura(linha.object_key), capa.bytes);
    } catch (err) {
      this.logger.warn(`vídeo ${id}: o armazenamento não guardou a capa (${err instanceof Error ? err.message : String(err)})`);
      if (err instanceof ArmazemIndisponivel) throw indisponivel();
      throw falhouAoGuardar();
    }
    return naTransacaoDaEmpresa(database, quem, async () => {
      const tx = currentTx();
      const r = await tx.execute<{ id: string }>(
        // A versão da capa sobe a cada capa gravada: o post com vídeo que prendeu a capa de antes não sai (A6, Z10; D-A6-70).
        sql`update liame.brand_photo set has_cover = true, cover_version = cover_version + 1, updated_at = now() where id = ${id} and removed_at is null returning id`,
      );
      // Apagado enquanto a capa era processada: a capa gravada sai com o vídeo, pela rotina.
      if (!r.rows[0]) throw naoEncontrada();
      await writeAudit(tx, {
        tenantId: quem.tenantId,
        actorType: actorTypeOf(auth),
        actorId: quem.userId,
        actorLabel: actorLabel(auth),
        actorRole: auth.roleKey,
        action: ACAO_CAPA,
        resourceType: RECURSO,
        resourceId: id,
        after: { brand_id: linha.brand_id, width: capa.largura, height: capa.altura },
        traceId: activeTraceId(),
        origin: 'api',
      });
      return this.videoNaTransacao(id);
    });
  }

  /**
   * Apaga a foto: ela sai da lista na hora, e a rotina `fotos` tira o arquivo do armazenamento e depois a linha. Vale
   * também com a função desligada (apagar nunca depende de nada).
   */
  async apagar(auth: AuthContext, id: string): Promise<void> {
    const quem = quemPede(auth);
    const r = await currentTx().execute<{ brand_id: string; product: string | null }>(sql`
      update liame.brand_photo set removed_at = now(), removed_by = ${quem.userId}, updated_at = now()
       where id = ${id} and removed_at is null
      returning brand_id, product`);
    const linha = r.rows[0];
    if (!linha) throw naoEncontrada();
    auditDetail({ resourceId: id, before: { brand_id: linha.brand_id, product: linha.product } });
  }
}
