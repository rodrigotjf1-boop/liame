import { BrandDossierContent, type BrandPhoto, type BrandPhotosResponse, DOSSIER_CONTENT_VERSION, type UpdateBrandPhotoRequest } from '@liame/contracts';
import { type Database, uuidv7 } from '@liame/database';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { naTransacaoDaEmpresa } from '../ai/na-empresa.js';
import { activeTraceId, writeAudit } from '../audit/audit.js';
import { type AuthContext, auditDetail, currentTx } from '../context/request-context.js';
import { actorLabel } from '../context/unit-of-work.interceptor.js';
import { DATABASE } from '../database/database.module.js';
import { AppProblem } from '../errors/problems.js';
import { FlagService } from '../flags/flag.service.js';
import { ARMAZEM_DE_IMAGENS, type ArmazemDeImagens, ArmazemIndisponivel } from '../imagens/armazem.js';
import { chaveDaFoto, chaveDaMiniatura, estreitaParaOInstagram, orientacao, RECUSAS, recorteDoInstagram } from './conferencia.js';
import { type FotoProcessada, processarFoto, RecusaDaFoto } from './processar.js';

// Fotos dos produtos (A6, Z4; ADR-021; protótipo P20, aprovado em 21/10/2026; D-A6-19). A empresa envia as fotos de
// verdade dos produtos, para os posts. O Liame guarda uma cópia regravada (JPEG, o lado maior em até 2.048 px, sem os
// dados do celular) e a miniatura no armazenamento de imagens, e aqui o registro. Ver a foto é por um endereço
// assinado de 5 minutos. Apagar tira a foto da lista na hora; a rotina `fotos` do worker tira o arquivo e depois a
// linha. Com a função `fotos` desligada, a lista vem vazia e enviar e mudar respondem 409; apagar sempre vale.

export const FLAG_FOTOS = 'fotos';
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
};

const COLUNAS = sql`p.id, p.brand_id, p.product, p.description, p.width, p.height, p.bytes, p.object_key, p.created_at,
  p.uploaded_by, u.name as uploaded_by_name`;

function quemPede(auth: AuthContext): Quem {
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

function falhouAoGuardar(): AppProblem {
  return new AppProblem(502, 'foto-nao-guardada', 'A foto não foi guardada', 'Não deu para guardar a foto agora. Tente de novo.');
}

/** A marca é da empresa e não está arquivada (a RLS esconde a de outra empresa: 404). */
async function marcaDaEmpresa(brandId: string): Promise<void> {
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

  /** A foto como a tela lê, com os endereços assinados. */
  private async paraTela(l: LinhaDaFoto, expira: Date): Promise<BrandPhoto> {
    let url: string;
    let miniatura: string;
    try {
      [url, miniatura] = await Promise.all([
        this.armazem.enderecoDeLeitura(l.object_key, VALIDADE_DO_ENDERECO_S),
        this.armazem.enderecoDeLeitura(chaveDaMiniatura(l.object_key), VALIDADE_DO_ENDERECO_S),
      ]);
    } catch (err) {
      if (err instanceof ArmazemIndisponivel) throw indisponivel();
      throw err;
    }
    return {
      id: l.id,
      brand_id: l.brand_id,
      product: l.product,
      description: l.description,
      width: l.width,
      height: l.height,
      bytes: l.bytes,
      orientation: orientacao(l.width, l.height),
      narrow_for_instagram: estreitaParaOInstagram(l.width),
      instagram_crop: recorteDoInstagram(l.width, l.height),
      uploaded_at: iso(l.created_at),
      uploaded_by: l.uploaded_by ? { id: l.uploaded_by, name: l.uploaded_by_name ?? '' } : null,
      url,
      thumbnail_url: miniatura,
      urls_expire_at: expira.toISOString(),
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
    return { ...base, enabled: true, products: produtos, items };
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
        actorType: 'human',
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
