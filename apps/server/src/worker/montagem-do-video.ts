import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRAND_VIDEO_LIMITS, type VideoRenderProps } from '@liame/contracts';
import { type Database, uuidv7, withSystem } from '@liame/database';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { writeAudit } from '../audit/audit.js';
import { DATABASE } from '../database/database.module.js';
import { chaveDaMiniatura, chaveDoVideo } from '../fotos/conferencia.js';
import { processarCapa } from '../fotos/processar.js';
import { ARMAZEM_DE_IMAGENS, type ArmazemDeImagens } from '../imagens/armazem.js';
import { chaveDaLogoDaMarca } from '../marca/logo-da-marca.service.js';
import { MONTADOR, type Montador } from '../video/montador.js';
import { type JobScope, tenantFilter } from './outbox-publisher.js';

// A montagem do vídeo (A6 · Z15, parte 2b; D-A6-139 e D-A6-140), no serviço `liame-render`: a tabela `video_montage` é
// a fila, uma só para todas as marcas (por isso aqui, no escopo do sistema; V53). Um por vez, o mais antigo primeiro:
// pega (`for update skip locked`), confere de novo as fotos e a logo, monta pelo Remotion com o andamento, grava o MP4 e a
// capa no armazenamento e põe o vídeo em Fotos (`montage_id`), com a auditoria; o que falha vira `nao_deu`, com o
// porquê para a pessoa e a causa no log. O vídeo montado não vai para rede nenhuma por aqui (D-A6-136).

/** O pedido que ficou `montando` sem andar por este tempo foi abandonado (o serviço caiu no meio). */
export const MONTAGEM_PARADA_MIN = 10;
/** Os endereços de leitura das fotos e da logo valem 30 minutos: a montagem de 15 s leva bem menos. */
const VALIDADE_DOS_ENDERECOS_S = 30 * 60;
/** O andamento vai ao banco no máximo a cada 2 segundos. */
const ANDAMENTO_A_CADA_MS = 2_000;

export const MOTIVO = {
  foto: 'Uma das fotos ou o vídeo saiu de Fotos antes da montagem. Peça de novo com o que está em Fotos.',
  logo: 'A logo saiu de Minha marca antes da montagem. Envie a logo de novo ou peça sem ela.',
  parou: 'A montagem parou no meio. Peça de novo; este não conta no limite do dia.',
  falhou: 'Não deu para montar este vídeo. Peça de novo; se continuar, fale com o suporte.',
} as const;

type Pedido = {
  id: string;
  tenant_id: string;
  brand_id: string;
  template: VideoRenderProps['template'];
  format: VideoRenderProps['format'];
  duration_s: VideoRenderProps['duration_s'];
  media_ids: string[];
  title: string;
  price_line: string | null;
  cta: string;
  with_logo: boolean;
  sound: VideoRenderProps['sound'];
  requested_by: string | null;
  /** A marca desta vez (o texto exato de `started_at`): só ela termina o pedido. */
  vez: string;
};

export type VezDaMontagem = { id: string; situacao: 'pronto' | 'nao_deu' | 'devolvido' };

function mensagem(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

@Injectable()
export class MontagemDoVideo {
  private readonly logger = new Logger('video-montado');
  /** O pedido em montagem agora (para devolver à fila se o serviço parar). */
  private atual: { id: string; vez: string } | null = null;
  /** O aviso do armazenamento fora do ar sai uma vez só (o laço olha a fila a cada 5 segundos). */
  private avisouSemArmazem = false;

  constructor(
    @Inject(DATABASE) private readonly database: Database | null,
    @Inject(ARMAZEM_DE_IMAGENS) private readonly armazem: ArmazemDeImagens,
    @Inject(MONTADOR) private readonly montador: Montador,
  ) {}

  private db() {
    if (!this.database) throw new Error('sem banco: o serviço de montagem precisa do DATABASE_URL');
    return this.database.db;
  }

  /** Os pedidos parados no meio (sem andar por 10 minutos): não deu, e não contam no limite do dia. */
  async soltarParados(scope: JobScope = {}, agora: Date = new Date()): Promise<string[]> {
    const limite = new Date(agora.getTime() - MONTAGEM_PARADA_MIN * 60_000).toISOString();
    const r = await withSystem(this.db(), (tx) =>
      tx.execute<{ id: string }>(sql`
        update liame.video_montage
           set status = 'nao_deu', error = ${MOTIVO.parou}, finished_at = now(), updated_at = now()
         where status = 'montando' and updated_at < ${limite}::timestamptz ${tenantFilter(scope, sql`tenant_id`)}
        returning id`),
    );
    for (const l of r.rows) this.logger.warn(`vídeo ${l.id}: parou no meio (sem andar por ${MONTAGEM_PARADA_MIN} minutos); não deu`);
    return r.rows.map((l) => l.id);
  }

  /** Pega o mais antigo da fila, de todas as marcas, e o marca `montando`. */
  private async pegar(scope: JobScope): Promise<Pedido | null> {
    const r = await withSystem(this.db(), (tx) =>
      tx.execute<Pedido>(sql`
        with proximo as (
          select id from liame.video_montage
           where status = 'na_fila' ${tenantFilter(scope, sql`tenant_id`)}
           order by created_at, id
           limit 1
           for update skip locked)
        update liame.video_montage v
           set status = 'montando', progress = 0, started_at = clock_timestamp(), updated_at = now()
          from proximo where v.id = proximo.id
        returning v.id, v.tenant_id, v.brand_id, v.template, v.format, v.duration_s, v.media_ids, v.title, v.price_line, v.cta,
                  v.with_logo, v.sound, v.requested_by, v.started_at::text as vez`),
    );
    return r.rows[0] ?? null;
  }

  /** O pedido termina sem vídeo, com o porquê para a pessoa (só se ainda for desta vez). */
  private async naoDeu(p: Pedido, motivo: string): Promise<boolean> {
    return withSystem(this.db(), async (tx) => {
      const r = await tx.execute<{ id: string }>(sql`
        update liame.video_montage set status = 'nao_deu', error = ${motivo}, finished_at = now(), updated_at = now()
         where id = ${p.id} and status = 'montando' and started_at = ${p.vez}::timestamptz
        returning id`);
      if (!r.rows[0]) return false;
      await writeAudit(tx, {
        tenantId: p.tenant_id,
        actorType: 'system',
        actorId: null,
        actorLabel: 'Liame (vídeo montado)',
        action: 'video_montado.nao_deu',
        resourceType: 'video_montage',
        resourceId: p.id,
        after: { brand_id: p.brand_id, motivo },
        origin: 'worker',
      });
      return true;
    });
  }

  /** Os endereços das fotos (na ordem do pedido) e da logo; `null` com o motivo quando algo saiu antes da montagem. */
  private async entradas(p: Pedido): Promise<{ props: VideoRenderProps } | { motivo: string }> {
    const lido = await withSystem(this.db(), async (tx) => {
      const midias = await tx.execute<{ id: string; kind: string; object_key: string }>(sql`
        select id, kind, object_key from liame.brand_photo
         where id in ${p.media_ids} and tenant_id = ${p.tenant_id} and brand_id = ${p.brand_id} and status = 'pronta' and removed_at is null`);
      const logo = p.with_logo
        ? (await tx.execute<{ logo_id: string | null }>(sql`select logo_id from liame.brand where id = ${p.brand_id} and archived_at is null`)).rows[0]?.logo_id ?? null
        : null;
      return { midias: midias.rows, logo };
    });
    const porId = new Map(lido.midias.map((m) => [m.id, m]));
    const ordem = p.media_ids.map((id) => porId.get(id));
    if (ordem.some((m) => !m)) return { motivo: MOTIVO.foto };
    if (p.with_logo && !lido.logo) return { motivo: MOTIVO.logo };
    const media = await Promise.all(
      ordem.map(async (m) => ({ url: await this.armazem.enderecoDeLeitura(m!.object_key, VALIDADE_DOS_ENDERECOS_S), kind: m!.kind === 'video' ? ('video' as const) : ('foto' as const) })),
    );
    const logoUrl = lido.logo ? await this.armazem.enderecoDeLeitura(chaveDaLogoDaMarca(p.tenant_id, p.brand_id, lido.logo), VALIDADE_DOS_ENDERECOS_S) : null;
    return {
      props: {
        template: p.template,
        format: p.format,
        duration_s: p.duration_s,
        media,
        title: p.title,
        price_line: p.price_line,
        cta: p.cta,
        logo_url: logoUrl,
        sound: p.sound,
      },
    };
  }

  /**
   * Uma vez: pega o mais antigo da fila e o monta. Devolve como terminou, ou `null` com a fila vazia. Se o serviço
   * devolveu o pedido à fila no meio (vai parar), o resultado é descartado.
   */
  async vez(scope: JobScope = {}): Promise<VezDaMontagem | null> {
    // Sem o armazenamento (o bucket não configurado), nada sai da fila: o pedido espera, em vez de virar "não deu".
    if (!this.armazem.disponivel) {
      if (!this.avisouSemArmazem) this.logger.error('o armazenamento não está configurado (IMAGENS_BUCKET): a fila do vídeo espera');
      this.avisouSemArmazem = true;
      return null;
    }
    const p = await this.pegar(scope);
    if (!p) return null;
    this.atual = { id: p.id, vez: p.vez };
    let pasta: string | null = null;
    const gravados: string[] = [];
    try {
      const entrada = await this.entradas(p);
      if ('motivo' in entrada) {
        this.logger.warn(`vídeo ${p.id}: ${entrada.motivo}`);
        return { id: p.id, situacao: (await this.naoDeu(p, entrada.motivo)) ? 'nao_deu' : 'devolvido' };
      }

      pasta = await mkdtemp(join(tmpdir(), 'liame-video-'));
      let ultimo = 0;
      const pronto = await this.montador.montar(entrada.props, pasta, (andamento) => {
        const agora = Date.now();
        if (agora - ultimo < ANDAMENTO_A_CADA_MS) return;
        ultimo = agora;
        const pct = Math.max(0, Math.min(99, Math.floor(andamento * 100)));
        void withSystem(this.db(), (tx) =>
          tx.execute(sql`update liame.video_montage set progress = ${pct}, updated_at = now() where id = ${p.id} and status = 'montando' and started_at = ${p.vez}::timestamptz`),
        ).catch((err: unknown) => this.logger.warn(`vídeo ${p.id}: o andamento não foi gravado (${mensagem(err)})`));
      });
      const bytes = await readFile(pronto.arquivo);
      if (bytes.length < 1 || bytes.length > BRAND_VIDEO_LIMITS.maxBytes) throw new Error(`o vídeo montado saiu com ${bytes.length} bytes`);
      const capa = await processarCapa(pronto.capa);

      const fotoId = uuidv7();
      const chave = chaveDoVideo(p.tenant_id, p.brand_id, fotoId, 'video/mp4');
      await this.armazem.gravar(chave, bytes, 'video/mp4');
      gravados.push(chave);
      await this.armazem.gravar(chaveDaMiniatura(chave), capa.bytes);
      gravados.push(chaveDaMiniatura(chave));

      const terminou = await withSystem(this.db(), async (tx) => {
        // Só esta vez termina o pedido: devolvido à fila (o serviço vai parar) ou dado como parado, o vídeo não entra.
        const r = await tx.execute<{ id: string }>(sql`
          select id from liame.video_montage where id = ${p.id} and status = 'montando' and started_at = ${p.vez}::timestamptz for update`);
        if (!r.rows[0]) return false;
        await tx.execute(sql`
          insert into liame.brand_photo (id, tenant_id, brand_id, kind, status, object_key, bytes, media_type, width, height, duration_ms,
                                         has_audio, has_cover, cover_version, uploaded_by, montage_id)
          values (${fotoId}, ${p.tenant_id}, ${p.brand_id}, 'video', 'pronta', ${chave}, ${bytes.length}, 'video/mp4', ${pronto.largura},
                  ${pronto.altura}, ${pronto.duracaoMs}, ${pronto.temAudio}, true, 1, ${p.requested_by}, ${p.id})`);
        await tx.execute(sql`
          update liame.video_montage set status = 'pronto', progress = 100, photo_id = ${fotoId}, finished_at = now(), updated_at = now()
           where id = ${p.id}`);
        await writeAudit(tx, {
          tenantId: p.tenant_id,
          actorType: 'system',
          actorId: null,
          actorLabel: 'Liame (vídeo montado)',
          action: 'video_montado.pronto',
          resourceType: 'video_montage',
          resourceId: p.id,
          after: { brand_id: p.brand_id, photo_id: fotoId, bytes: bytes.length, duration_ms: pronto.duracaoMs, width: pronto.largura, height: pronto.altura },
          origin: 'worker',
        });
        return true;
      });
      if (!terminou) {
        await this.apagarGravados(p.id, gravados);
        return { id: p.id, situacao: 'devolvido' };
      }
      return { id: p.id, situacao: 'pronto' };
    } catch (err) {
      // A causa no log; para a pessoa, o motivo da tela (V6).
      this.logger.error(`vídeo ${p.id}: a montagem falhou (${mensagem(err)})`);
      await this.apagarGravados(p.id, gravados);
      const marcou = await this.naoDeu(p, MOTIVO.falhou).catch((e: unknown) => {
        this.logger.error(`vídeo ${p.id}: não deu para marcar "não deu" (${mensagem(e)})`);
        return false;
      });
      return { id: p.id, situacao: marcou ? 'nao_deu' : 'devolvido' };
    } finally {
      this.atual = null;
      if (pasta) await rm(pasta, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async apagarGravados(id: string, chaves: string[]): Promise<void> {
    if (!chaves.length) return;
    await this.armazem.apagar(chaves).catch((err: unknown) => this.logger.warn(`vídeo ${id}: os arquivos desta vez não saíram do armazenamento (${mensagem(err)})`));
  }

  /** O serviço vai parar: o pedido em montagem volta à fila (o próximo serviço o monta do começo). */
  async devolverAtual(): Promise<string | null> {
    const atual = this.atual;
    if (!atual || !this.database) return null;
    await withSystem(this.database.db, (tx) =>
      tx.execute(sql`
        update liame.video_montage set status = 'na_fila', progress = 0, started_at = null, updated_at = now()
         where id = ${atual.id} and status = 'montando' and started_at = ${atual.vez}::timestamptz`),
    );
    this.logger.log(`vídeo ${atual.id}: devolvido à fila (o serviço vai parar)`);
    return atual.id;
  }
}
