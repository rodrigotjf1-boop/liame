import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRAND_VIDEO_LIMITS, fitsInstagramReels } from '@liame/contracts';
import { type Database, withSystem } from '@liame/database';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { writeAudit } from '../audit/audit.js';
import { DATABASE } from '../database/database.module.js';
import { chaveDaVersaoDoInstagram } from '../fotos/versao-do-instagram.js';
import { ARMAZEM_DE_IMAGENS, type ArmazemDeImagens } from '../imagens/armazem.js';
import { REDUTOR, type Redutor, VideoQueNaoReduz } from '../video/redutor.js';
import { type JobScope, tenantFilter } from './outbox-publisher.js';

// A cópia do vídeo para o Instagram (A6 · Z10, parte 3b; D-A6-149), no serviço `liame-render`, ao lado da montagem: a
// coluna `brand_photo.instagram_status` é a fila, uma só para todas as marcas (por isso aqui, no escopo do sistema; V53).
// Um por vez, o mais antigo primeiro: pega (`for update skip locked`, contando a tentativa), baixa o vídeo como a loja
// gravou, reduz pelo ffmpeg, confere e grava a cópia ao lado do arquivo, e marca `pronta` com as medidas e o tamanho,
// com a auditoria. O que falha volta à fila até a terceira tentativa; o arquivo que o ffmpeg não abre, e a terceira
// falha, viram `nao_deu` (o vídeo segue só na Página, como antes). Nada vai para rede nenhuma por aqui.

/** A cópia que ficou `reduzindo` sem terminar por este tempo foi abandonada (o serviço caiu no meio). */
export const REDUCAO_PARADA_MIN = 30;
/** Quantas vezes o serviço tenta a cópia de um vídeo antes de desistir. */
export const TENTATIVAS_DA_REDUCAO = 3;

type Pedido = {
  id: string;
  tenant_id: string;
  brand_id: string;
  object_key: string;
  instagram_attempts: number;
  /** A marca desta vez (o texto exato de `instagram_started_at`): só ela termina a cópia. */
  vez: string;
};

export type VezDaReducao = { id: string; situacao: 'pronta' | 'de_novo' | 'nao_deu' | 'devolvido' };

function mensagem(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

@Injectable()
export class ReducaoDoVideo {
  private readonly logger = new Logger('video-do-instagram');
  /** O vídeo sendo reduzido agora (para devolver à fila se o serviço parar). */
  private atual: { id: string; vez: string } | null = null;

  constructor(
    @Inject(DATABASE) private readonly database: Database | null,
    @Inject(ARMAZEM_DE_IMAGENS) private readonly armazem: ArmazemDeImagens,
    @Inject(REDUTOR) private readonly redutor: Redutor,
  ) {}

  private db() {
    if (!this.database) throw new Error('sem banco: o serviço de montagem precisa do DATABASE_URL');
    return this.database.db;
  }

  /** As cópias paradas no meio (sem terminar por 30 minutos): voltam à fila; na terceira tentativa, não deu. */
  async soltarParados(scope: JobScope = {}, agora: Date = new Date()): Promise<string[]> {
    const limite = new Date(agora.getTime() - REDUCAO_PARADA_MIN * 60_000).toISOString();
    const r = await withSystem(this.db(), (tx) =>
      tx.execute<{ id: string; instagram_status: string }>(sql`
        update liame.brand_photo
           set instagram_status = case when instagram_attempts >= ${TENTATIVAS_DA_REDUCAO} then 'nao_deu' else 'na_fila' end,
               instagram_started_at = null, updated_at = now()
         where instagram_status = 'reduzindo' and instagram_started_at < ${limite}::timestamptz ${tenantFilter(scope, sql`tenant_id`)}
        returning id, instagram_status`),
    );
    for (const l of r.rows) this.logger.warn(`vídeo ${l.id}: a cópia para o Instagram parou no meio (sem terminar em ${REDUCAO_PARADA_MIN} minutos); ${l.instagram_status}`);
    return r.rows.map((l) => l.id);
  }

  /** Pega o mais antigo da fila, de todas as marcas, conta a tentativa e o marca `reduzindo`. */
  private async pegar(scope: JobScope): Promise<Pedido | null> {
    const r = await withSystem(this.db(), (tx) =>
      tx.execute<Pedido>(sql`
        with proximo as (
          select id from liame.brand_photo
           where instagram_status = 'na_fila' and removed_at is null and kind = 'video' and status = 'pronta'
             ${tenantFilter(scope, sql`tenant_id`)}
           order by created_at, id
           limit 1
           for update skip locked)
        update liame.brand_photo f
           set instagram_status = 'reduzindo', instagram_attempts = f.instagram_attempts + 1, instagram_started_at = clock_timestamp(),
               updated_at = now()
          from proximo where f.id = proximo.id
        returning f.id, f.tenant_id, f.brand_id, f.object_key, f.instagram_attempts, f.instagram_started_at::text as vez`),
    );
    return r.rows[0] ?? null;
  }

  /** A cópia desta vez não saiu: volta à fila, ou não deu (o arquivo que não reduz, ou a última tentativa). */
  private async falhou(p: Pedido, definitivo: boolean): Promise<VezDaReducao['situacao']> {
    const desiste = definitivo || p.instagram_attempts >= TENTATIVAS_DA_REDUCAO;
    return withSystem(this.db(), async (tx) => {
      const r = await tx.execute<{ id: string }>(sql`
        update liame.brand_photo
           set instagram_status = ${desiste ? 'nao_deu' : 'na_fila'}, instagram_started_at = null, updated_at = now()
         where id = ${p.id} and instagram_status = 'reduzindo' and instagram_started_at = ${p.vez}::timestamptz
        returning id`);
      if (!r.rows[0]) return 'devolvido';
      if (!desiste) return 'de_novo';
      await writeAudit(tx, {
        tenantId: p.tenant_id,
        actorType: 'system',
        actorId: null,
        actorLabel: 'Liame (vídeo para o Instagram)',
        action: 'fotos.video_instagram_nao_deu',
        resourceType: 'brand_photo',
        resourceId: p.id,
        after: { brand_id: p.brand_id, tentativas: p.instagram_attempts },
        origin: 'worker',
      });
      return 'nao_deu';
    });
  }

  /**
   * Uma vez: pega o mais antigo da fila e faz a cópia. Devolve como terminou, ou `null` com a fila vazia. Se o serviço
   * devolveu o vídeo à fila no meio (vai parar), ou ele saiu de Fotos, a cópia desta vez é descartada.
   */
  async vez(scope: JobScope = {}): Promise<VezDaReducao | null> {
    // Sem o armazenamento, nada sai da fila (a montagem já avisa no log).
    if (!this.armazem.disponivel) return null;
    const p = await this.pegar(scope);
    if (!p) return null;
    this.atual = { id: p.id, vez: p.vez };
    let pasta: string | null = null;
    let gravada: string | null = null;
    try {
      pasta = await mkdtemp(join(tmpdir(), 'liame-instagram-'));
      const entrada = join(pasta, p.object_key.endsWith('.mov') ? 'original.mov' : 'original.mp4');
      // Direto para o disco: o vídeo vai até 300 MB (o `ler` do armazenamento é para a imagem, com o teto dela).
      await this.armazem.baixarParaArquivo(p.object_key, entrada, BRAND_VIDEO_LIMITS.maxBytes);
      const copia = await this.redutor.reduzir(entrada, pasta);
      const bytes = await readFile(copia.arquivo);
      if (bytes.length < 1 || bytes.length > BRAND_VIDEO_LIMITS.maxBytes || !fitsInstagramReels(copia.largura, bytes.length, copia.duracaoMs)) {
        throw new Error(`a cópia não cabe no Instagram (${copia.largura} × ${copia.altura}, ${bytes.length} bytes)`);
      }
      const chave = chaveDaVersaoDoInstagram(p.object_key);
      await this.armazem.gravar(chave, bytes, 'video/mp4');
      gravada = chave;

      const terminou = await withSystem(this.db(), async (tx) => {
        // Só esta vez termina a cópia, e só com o vídeo ainda em Fotos.
        const r = await tx.execute<{ id: string }>(sql`
          update liame.brand_photo
             set instagram_status = 'pronta', instagram_bytes = ${bytes.length}, instagram_width = ${copia.largura},
                 instagram_height = ${copia.altura}, updated_at = now()
           where id = ${p.id} and instagram_status = 'reduzindo' and instagram_started_at = ${p.vez}::timestamptz
             and removed_at is null and status = 'pronta'
          returning id`);
        if (!r.rows[0]) return false;
        await writeAudit(tx, {
          tenantId: p.tenant_id,
          actorType: 'system',
          actorId: null,
          actorLabel: 'Liame (vídeo para o Instagram)',
          action: 'fotos.video_instagram_pronto',
          resourceType: 'brand_photo',
          resourceId: p.id,
          after: { brand_id: p.brand_id, width: copia.largura, height: copia.altura, bytes: bytes.length, duration_ms: copia.duracaoMs },
          origin: 'worker',
        });
        return true;
      });
      if (!terminou) {
        await this.apagarCopia(p.id, gravada);
        return { id: p.id, situacao: 'devolvido' };
      }
      return { id: p.id, situacao: 'pronta' };
    } catch (err) {
      // A causa no log (V6); a tela mostra só a situação.
      this.logger.error(`vídeo ${p.id}: a cópia para o Instagram falhou na tentativa ${p.instagram_attempts} (${mensagem(err)})`);
      if (gravada) await this.apagarCopia(p.id, gravada);
      const situacao = await this.falhou(p, err instanceof VideoQueNaoReduz).catch((e: unknown) => {
        this.logger.error(`vídeo ${p.id}: não deu para marcar a falha da cópia (${mensagem(e)})`);
        return 'devolvido' as const;
      });
      return { id: p.id, situacao };
    } finally {
      this.atual = null;
      if (pasta) await rm(pasta, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async apagarCopia(id: string, chave: string): Promise<void> {
    await this.armazem.apagar([chave]).catch((err: unknown) => this.logger.warn(`vídeo ${id}: a cópia desta vez não saiu do armazenamento (${mensagem(err)})`));
  }

  /** O serviço vai parar: o vídeo em redução volta à fila, sem contar a tentativa (o próximo serviço faz do começo). */
  async devolverAtual(): Promise<string | null> {
    const atual = this.atual;
    if (!atual || !this.database) return null;
    await withSystem(this.database.db, (tx) =>
      tx.execute(sql`
        update liame.brand_photo
           set instagram_status = 'na_fila', instagram_started_at = null, instagram_attempts = greatest(instagram_attempts - 1, 0), updated_at = now()
         where id = ${atual.id} and instagram_status = 'reduzindo' and instagram_started_at = ${atual.vez}::timestamptz`),
    );
    this.logger.log(`vídeo ${atual.id}: a cópia para o Instagram voltou à fila (o serviço vai parar)`);
    return atual.id;
  }
}
