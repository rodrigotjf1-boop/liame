import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRAND_VIDEO_LIMITS } from '@liame/contracts';
import { type Database, withSystem } from '@liame/database';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DATABASE } from '../database/database.module.js';
import { chaveDaVersaoDoInstagram } from '../fotos/versao-do-instagram.js';
import { ARMAZEM_DE_IMAGENS, type ArmazemDeImagens, chaveDoQuadroDosCortes } from '../imagens/armazem.js';
import { QUADROS_MAXIMOS, quadrosDoVideo } from '../video/quadros.js';
import { type JobScope, tenantFilter } from './outbox-publisher.js';

// Os quadros do pedido dos cortes (A6 · Z16, parte 3; D-A6-151), no serviço `liame-render`, entre a montagem e a cópia
// para o Instagram: a tabela `video_cut_request` em `pedido` é a fila, uma só para todas as marcas (por isso aqui, no
// escopo do sistema; V53). Um por vez, o mais antigo primeiro: pega (`for update skip locked`, com a vez em `started_at` e
// a tentativa contada; o pego há mais de 10 minutos sem terminar volta a ser pego, até a 3ª tentativa), confere os vídeos
// em Fotos (o que saiu ou deixou de ser vídeo é pulado), divide os 16 quadros entre eles (o teto de imagens do gateway de
// IA), baixa cada vídeo (a cópia para o Instagram, quando pronta: menor e já no BT.709), tira os quadros, grava cada JPEG no
// armazenamento e marca `quadros_prontos` com `frames` e `frame_index` (o vídeo e o tempo de cada quadro, na ordem das
// chaves), zerando a vez e a tentativa para o worker, que manda os quadros ao Social media e os apaga. Sem quadro nenhum,
// `falhou` com `sem_quadros`; a 3ª tentativa parada, `falhou` com `parado` (o `error` é um código: a tela traduz). Nada
// vai para fora por aqui.

/** O pedido que ficou na vez sem terminar por este tempo foi abandonado (o serviço caiu no meio). */
export const QUADROS_PARADOS_MIN = 10;
/** Quantas vezes o serviço tenta tirar os quadros de um pedido antes de desistir. */
export const TENTATIVAS_DOS_QUADROS = 3;

/** Os códigos do `error` que este passo grava (a tela e a rota do pedido traduzem). */
export const ERRO_DOS_QUADROS = { parado: 'parado', semQuadros: 'sem_quadros' } as const;

/** Quem tira os quadros de um vídeo no disco (o `quadrosDoVideo`, com o ffmpeg do Remotion; nos testes, um de mentira). */
export const TIRAR_QUADROS = Symbol('TIRAR_QUADROS');
export type TirarQuadros = (arquivo: string, opcoes: { quantos: number; duracaoMs: number }) => ReturnType<typeof quadrosDoVideo>;

type Pedido = {
  id: string;
  tenant_id: string;
  brand_id: string;
  media_ids: string[];
  attempts: number;
  /** A marca desta vez (o texto exato de `started_at`): só ela termina o pedido. */
  vez: string;
};

export type VezDosQuadros = { id: string; situacao: 'quadros_prontos' | 'falhou' | 'de_novo' | 'devolvido'; quadros: number };

/** Quantos quadros cada vídeo dá: os 16 divididos entre os vídeos que ficaram (de 1 a 4, então pelo menos 4 por vídeo). */
export function quadrosPorVideo(videos: number): number {
  return videos < 1 ? 0 : Math.floor(QUADROS_MAXIMOS / videos);
}

/** As chaves de todos os quadros que um pedido pode ter (para apagar o que uma vez interrompida deixou para trás). */
export function chavesPossiveis(p: Pick<Pedido, 'id' | 'tenant_id' | 'brand_id'>): string[] {
  return Array.from({ length: QUADROS_MAXIMOS }, (_, n) => chaveDoQuadroDosCortes(p.tenant_id, p.brand_id, p.id, n));
}

function mensagem(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

@Injectable()
export class QuadrosDosCortes {
  private readonly logger = new Logger('quadros-dos-cortes');
  /** O pedido na vez agora (para devolver à fila se o serviço parar). */
  private atual: { id: string; vez: string } | null = null;

  constructor(
    @Inject(DATABASE) private readonly database: Database | null,
    @Inject(ARMAZEM_DE_IMAGENS) private readonly armazem: ArmazemDeImagens,
    @Inject(TIRAR_QUADROS) private readonly tirar: TirarQuadros,
  ) {}

  private db() {
    if (!this.database) throw new Error('sem banco: o serviço de montagem precisa do DATABASE_URL');
    return this.database.db;
  }

  private async apagar(id: string, chaves: string[]): Promise<void> {
    if (!chaves.length) return;
    await this.armazem.apagar(chaves).catch((err: unknown) => this.logger.warn(`pedido dos cortes ${id}: os quadros não saíram do armazenamento (${mensagem(err)})`));
  }

  /** Os pedidos parados na 3ª tentativa (sem terminar por 10 minutos): falhou, com `parado`, e os quadros que ficaram saem. */
  async soltarParados(scope: JobScope = {}, agora: Date = new Date()): Promise<string[]> {
    const limite = new Date(agora.getTime() - QUADROS_PARADOS_MIN * 60_000).toISOString();
    const r = await withSystem(this.db(), (tx) =>
      tx.execute<{ id: string; tenant_id: string; brand_id: string }>(sql`
        update liame.video_cut_request
           set status = 'falhou', error = ${ERRO_DOS_QUADROS.parado}, started_at = null, updated_at = now()
         where status = 'pedido' and attempts >= ${TENTATIVAS_DOS_QUADROS} and started_at < ${limite}::timestamptz
               ${tenantFilter(scope, sql`tenant_id`)}
        returning id, tenant_id, brand_id`),
    );
    for (const l of r.rows) {
      this.logger.warn(`pedido dos cortes ${l.id}: parou na ${TENTATIVAS_DOS_QUADROS}ª tentativa; falhou`);
      await this.apagar(l.id, chavesPossiveis(l));
    }
    return r.rows.map((l) => l.id);
  }

  /** Pega o mais antigo da fila (ou o abandonado há 10 minutos), de todas as marcas, conta a tentativa e marca a vez. */
  private async pegar(scope: JobScope, agora: Date): Promise<Pedido | null> {
    const limite = new Date(agora.getTime() - QUADROS_PARADOS_MIN * 60_000).toISOString();
    const r = await withSystem(this.db(), (tx) =>
      tx.execute<Pedido>(sql`
        with proximo as (
          select id from liame.video_cut_request
           where status = 'pedido' and attempts < ${TENTATIVAS_DOS_QUADROS} and (started_at is null or started_at < ${limite}::timestamptz)
                 ${tenantFilter(scope, sql`tenant_id`)}
           order by created_at, id
           limit 1
           for update skip locked)
        update liame.video_cut_request c
           set started_at = clock_timestamp(), attempts = c.attempts + 1, updated_at = now()
          from proximo where c.id = proximo.id
        returning c.id, c.tenant_id, c.brand_id, c.media_ids, c.attempts, c.started_at::text as vez`),
    );
    return r.rows[0] ?? null;
  }

  /** O pedido desta vez falhou com o código (só se ainda for desta vez). */
  private async falhou(p: Pedido, codigo: string): Promise<boolean> {
    const r = await withSystem(this.db(), (tx) =>
      tx.execute<{ id: string }>(sql`
        update liame.video_cut_request set status = 'falhou', error = ${codigo}, started_at = null, updated_at = now()
         where id = ${p.id} and status = 'pedido' and started_at = ${p.vez}::timestamptz
        returning id`),
    );
    return Boolean(r.rows[0]);
  }

  /** A vez desta tentativa não terminou: o pedido volta à fila agora (ou falha, na última tentativa). */
  private async deNovo(p: Pedido): Promise<VezDosQuadros['situacao']> {
    if (p.attempts >= TENTATIVAS_DOS_QUADROS) return (await this.falhou(p, ERRO_DOS_QUADROS.parado)) ? 'falhou' : 'devolvido';
    const r = await withSystem(this.db(), (tx) =>
      tx.execute<{ id: string }>(sql`
        update liame.video_cut_request set started_at = null, updated_at = now()
         where id = ${p.id} and status = 'pedido' and started_at = ${p.vez}::timestamptz
        returning id`),
    );
    return r.rows[0] ? 'de_novo' : 'devolvido';
  }

  /** Os vídeos do pedido que ainda estão em Fotos (prontos, desta marca, vídeos), com a posição na lista do pedido. */
  private async videos(p: Pedido): Promise<{ posicao: number; chave: string; duracaoMs: number }[]> {
    const r = await withSystem(this.db(), (tx) =>
      tx.execute<{ id: string; object_key: string; duration_ms: number | null; instagram_status: string | null }>(sql`
        select id, object_key, duration_ms, instagram_status from liame.brand_photo
         where id in ${p.media_ids} and tenant_id = ${p.tenant_id} and brand_id = ${p.brand_id} and kind = 'video'
           and status = 'pronta' and removed_at is null`),
    );
    const porId = new Map(r.rows.map((m) => [m.id, m]));
    return p.media_ids.flatMap((id, posicao) => {
      const m = porId.get(id);
      if (!m || !m.duration_ms) return [];
      // A cópia para o Instagram, quando pronta, é menor (até 1080 px) e já vem no BT.709: baixa e lê mais rápido.
      const chave = m.instagram_status === 'pronta' ? chaveDaVersaoDoInstagram(m.object_key) : m.object_key;
      return [{ posicao, chave, duracaoMs: m.duration_ms }];
    });
  }

  /**
   * Uma vez: pega o pedido mais antigo da fila e tira os quadros. Devolve como terminou, ou `null` com a fila vazia. Se o
   * pedido foi devolvido à fila ou dado como parado no meio, os quadros desta vez saem do armazenamento.
   */
  async vez(scope: JobScope = {}, agora: Date = new Date()): Promise<VezDosQuadros | null> {
    // Sem o armazenamento, nada sai da fila (a montagem já avisa no log).
    if (!this.armazem.disponivel) return null;
    const p = await this.pegar(scope, agora);
    if (!p) return null;
    this.atual = { id: p.id, vez: p.vez };
    const gravadas: string[] = [];
    const indice: { video: number; tempo_ms: number }[] = [];
    let pasta: string | null = null;
    try {
      // Uma vez anterior interrompida pode ter deixado quadros: saem antes (as chaves se repetem).
      if (p.attempts > 1) await this.apagar(p.id, chavesPossiveis(p));
      const videos = await this.videos(p);
      if (videos.length < p.media_ids.length) this.logger.warn(`pedido dos cortes ${p.id}: ${p.media_ids.length - videos.length} vídeo(s) saíram de Fotos; seguem os outros`);
      const quantos = quadrosPorVideo(videos.length);
      pasta = await mkdtemp(join(tmpdir(), 'liame-cortes-'));
      for (const v of videos) {
        const arquivo = join(pasta, `video-${v.posicao}${v.chave.endsWith('.mov') ? '.mov' : '.mp4'}`);
        try {
          await this.armazem.baixarParaArquivo(v.chave, arquivo, BRAND_VIDEO_LIMITS.maxBytes);
          const quadros = await this.tirar(arquivo, { quantos, duracaoMs: v.duracaoMs });
          for (const q of quadros) {
            const chave = chaveDoQuadroDosCortes(p.tenant_id, p.brand_id, p.id, indice.length);
            await this.armazem.gravar(chave, Buffer.from(q.jpeg), 'image/jpeg');
            gravadas.push(chave);
            indice.push({ video: v.posicao, tempo_ms: q.tempoMs });
          }
        } catch (err) {
          // O vídeo que não abre é pulado; os outros seguem (a causa no log).
          this.logger.warn(`pedido dos cortes ${p.id}: o vídeo ${v.posicao + 1} não deu quadros (${mensagem(err)})`);
        } finally {
          await rm(arquivo, { force: true }).catch(() => undefined);
        }
      }

      if (!indice.length) {
        this.logger.warn(`pedido dos cortes ${p.id}: nenhum quadro saiu`);
        return { id: p.id, situacao: (await this.falhou(p, ERRO_DOS_QUADROS.semQuadros)) ? 'falhou' : 'devolvido', quadros: 0 };
      }

      // Só esta vez termina o pedido; a vez e a tentativa zeram para o worker contar as dele.
      const r = await withSystem(this.db(), (tx) =>
        tx.execute<{ id: string }>(sql`
          update liame.video_cut_request
             set status = 'quadros_prontos', frames = ${indice.length}, frame_index = ${JSON.stringify(indice)}::jsonb,
                 started_at = null, attempts = 0, updated_at = now()
           where id = ${p.id} and status = 'pedido' and started_at = ${p.vez}::timestamptz
          returning id`),
      );
      if (!r.rows[0]) {
        await this.apagar(p.id, gravadas);
        return { id: p.id, situacao: 'devolvido', quadros: 0 };
      }
      return { id: p.id, situacao: 'quadros_prontos', quadros: indice.length };
    } catch (err) {
      // A causa no log; o pedido volta à fila (ou falha na última tentativa), sem os quadros desta vez.
      this.logger.error(`pedido dos cortes ${p.id}: os quadros falharam (${mensagem(err)})`);
      await this.apagar(p.id, gravadas);
      const situacao = await this.deNovo(p).catch((e: unknown) => {
        this.logger.error(`pedido dos cortes ${p.id}: não deu para devolver à fila (${mensagem(e)})`);
        return 'devolvido' as const;
      });
      return { id: p.id, situacao, quadros: 0 };
    } finally {
      this.atual = null;
      if (pasta) await rm(pasta, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** O serviço vai parar: o pedido na vez volta à fila agora (o próximo serviço tira os quadros do começo). */
  async devolverAtual(): Promise<string | null> {
    const atual = this.atual;
    if (!atual || !this.database) return null;
    await withSystem(this.database.db, (tx) =>
      tx.execute(sql`
        update liame.video_cut_request set started_at = null, updated_at = now()
         where id = ${atual.id} and status = 'pedido' and started_at = ${atual.vez}::timestamptz`),
    );
    this.logger.log(`pedido dos cortes ${atual.id}: devolvido à fila (o serviço vai parar)`);
    return atual.id;
  }
}
