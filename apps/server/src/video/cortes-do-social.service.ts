import { type CreateVideoCutsRequest, VIDEO_CUTS_LIMITS, type VideoCutsResponse } from '@liame/contracts';
import { uuidv7 } from '@liame/database';
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { CorteConferido } from '../ai/social/cortes.js';
import { type AuthContext, auditDetail, currentTx } from '../context/request-context.js';
import { AppProblem } from '../errors/problems.js';
import { FlagService } from '../flags/flag.service.js';

// Os melhores momentos (A6 · Z16, parte 3; P46; D-A6-150 a D-A6-154): o pedido dos cortes ao Social media. A rota confere
// tudo antes de gravar: a marca, a função `video_momentos`, os vídeos de Fotos (prontos, desta marca, não montados, cada um
// com 3 segundos ou mais) e, no "Pedir outros cortes", o pedido de antes (da mesma marca, até 2 vezes). O pedido nasce
// `pedido`: o serviço de montagem (`liame-render`) tira os quadros e o worker (`worker/cortes-do-social.ts`) os manda ao
// Social media e grava a proposta conferida.

export const FLAG_DOS_MELHORES_MOMENTOS = 'video_momentos';

type Quem = { tenantId: string; userId: string };

type Linha = {
  id: string;
  brand_id: string;
  media_ids: string[];
  duration_s: number;
  status: VideoCutsResponse['status'];
  proposal: { cortes?: CorteConferido[]; totalMs?: number } | null;
  error: string | null;
  created_at: Date | string;
  /** Quantos pedidos vêm antes deste pela cadeia do `previous_id` (até 3). */
  antes: number;
};

const iso = (v: Date | string): string => (v instanceof Date ? v : new Date(v)).toISOString();
/** O motivo gravado como a resposta o leva (o formato do contrato; a lista de motivos pode crescer, V23). */
const FORMATO_DO_MOTIVO = /^[a-z][a-z_-]{1,40}$/;

function recusa(code: string, title: string, detail: string, path?: string): AppProblem {
  return new AppProblem(422, code, title, detail, {}, path ? [{ path, message: detail }] : undefined);
}

/** Quantos pedidos vêm antes do pedido `id` pela cadeia do `previous_id`, contados até 3 (o limite é 2). */
const antesDe = (id: string) => sql`(
  with recursive cadeia (previous_id, n) as (
    select v.previous_id, 0 from liame.video_cut_request v where v.id = ${id}
    union all
    select v.previous_id, c.n + 1 from liame.video_cut_request v join cadeia c on v.id = c.previous_id where c.n < ${VIDEO_CUTS_LIMITS.others + 1})
  select max(n)::int from cadeia)`;

@Injectable()
export class CortesDoSocialService {
  constructor(private readonly flags: FlagService) {}

  private quem(auth: AuthContext): Quem {
    if (!auth.tenantId) throw new AppProblem(403, 'sem-empresa-ativa', 'Escolha uma empresa', 'Selecione uma empresa com acesso ativo.');
    return { tenantId: auth.tenantId, userId: auth.userId };
  }

  private async marca(quem: Quem, brandId: string): Promise<void> {
    const r = await currentTx().execute(sql`select 1 from liame.brand where id = ${brandId} and tenant_id = ${quem.tenantId} and archived_at is null`);
    if (!r.rows[0]) throw new AppProblem(404, 'nao-encontrado', 'Não encontramos', 'Marca não encontrada nesta empresa.');
  }

  private ligada(quem: Quem, brandId: string): Promise<boolean> {
    return this.flags.isEnabled(FLAG_DOS_MELHORES_MOMENTOS, this.flags.context({ tenantId: quem.tenantId, userId: quem.userId, brandId }));
  }

  /**
   * Os pedidos de cortes da marca hoje, no fuso da empresa (a mesma conta do limite do vídeo montado). Todos contam, deu
   * ou não deu: cada pedido tira os quadros e pode ter gastado a IA.
   */
  private async hoje(quem: Quem, brandId: string): Promise<number> {
    const r = await currentTx().execute<{ usados: number }>(sql`
      with fuso as (select coalesce((select timezone from liame.organization where id = ${quem.tenantId}), 'America/Sao_Paulo') as tz),
      dia as (select (date_trunc('day', now() at time zone fuso.tz) at time zone fuso.tz) as inicio from fuso)
      select count(*)::int as usados from liame.video_cut_request v, dia
       where v.brand_id = ${brandId} and v.tenant_id = ${quem.tenantId} and v.created_at >= dia.inicio`);
    return Number(r.rows[0]?.usados ?? 0);
  }

  private resposta(l: Linha): VideoCutsResponse {
    const pronta = l.status === 'pronta' && l.proposal?.cortes ? l.proposal : null;
    const motivo = l.status === 'falhou' ? (l.error ?? '') : '';
    return {
      id: l.id,
      brand_id: l.brand_id,
      media_ids: l.media_ids,
      duration_s: l.duration_s,
      status: l.status,
      // O vídeo de cada corte é a posição em `media_ids`.
      cuts: pronta?.cortes ? pronta.cortes.map((c) => ({ media_id: l.media_ids[c.video]!, start_ms: c.inicioMs, end_ms: c.fimMs, caption: c.legenda })) : null,
      total_ms: pronta?.totalMs ?? null,
      reason: FORMATO_DO_MOTIVO.test(motivo) ? motivo : null,
      others_left: Math.max(0, VIDEO_CUTS_LIMITS.others - Number(l.antes ?? 0)),
      created_at: iso(l.created_at),
    };
  }

  /** Um pedido dos cortes da empresa, com a proposta quando pronta. */
  async obter(auth: AuthContext, id: string): Promise<VideoCutsResponse> {
    const quem = this.quem(auth);
    const l = (
      await currentTx().execute<Linha>(sql`
        select r.id, r.brand_id, r.media_ids, r.duration_s, r.status, r.proposal, r.error, r.created_at, ${antesDe(id)} as antes
          from liame.video_cut_request r
         where r.id = ${id} and r.tenant_id = ${quem.tenantId}`)
    ).rows[0];
    if (!l) throw new AppProblem(404, 'nao-encontrado', 'Não encontramos', 'Este pedido de cortes não está aqui.');
    return this.resposta(l);
  }

  /** Confere o pedido e grava `pedido`: o serviço de montagem tira os quadros dos vídeos. */
  async pedir(auth: AuthContext, body: CreateVideoCutsRequest): Promise<VideoCutsResponse> {
    const tx = currentTx();
    const quem = this.quem(auth);
    await this.marca(quem, body.brand_id);
    if (!(await this.ligada(quem, body.brand_id))) {
      throw new AppProblem(409, 'funcao-desligada', 'Função desligada', 'Os melhores momentos não estão ligados para esta empresa.');
    }

    // Os vídeos de Fotos: prontos, desta marca, não montados pelo Liame, cada um com 3 segundos ou mais.
    const ids = [...new Set(body.media_ids)];
    if (ids.length !== body.media_ids.length) throw recusa('midia-repetida', 'Vídeo repetido', 'Cada vídeo entra uma vez só.', 'media_ids');
    const midias = (
      await tx.execute<{ id: string; kind: string | null; montage_id: string | null; duration_ms: number | null }>(sql`
        select id, kind, montage_id, duration_ms from liame.brand_photo
         where id in ${ids} and tenant_id = ${quem.tenantId} and brand_id = ${body.brand_id} and status = 'pronta' and removed_at is null`)
    ).rows;
    if (midias.length !== ids.length) throw recusa('midia-fora-das-fotos', 'Vídeo não encontrado', 'Escolha vídeos prontos de Fotos desta marca.', 'media_ids');
    if (midias.some((m) => m.montage_id)) throw recusa('midia-montada', 'Vídeo montado', 'Um vídeo montado pelo Liame não entra nos melhores momentos.', 'media_ids');
    if (midias.some((m) => m.kind !== 'video')) throw recusa('so-videos', 'Só vídeos', 'Os melhores momentos saem de vídeos: escolha só vídeos de Fotos.', 'media_ids');
    const curto = midias.find((m) => (m.duration_ms ?? 0) < VIDEO_CUTS_LIMITS.minVideoMs);
    if (curto) {
      const tem = Math.floor((curto.duration_ms ?? 0) / 1000);
      throw recusa('video-curto', 'Vídeo curto', `Um dos vídeos tem ${tem} s: escolha vídeos com ${VIDEO_CUTS_LIMITS.minVideoMs / 1000} s ou mais.`, 'media_ids');
    }

    // "Pedir outros cortes": o pedido de antes é da mesma marca, e a cadeia vai até 2 pedidos antes deste.
    if (body.previous_id) {
      const antes = (
        await tx.execute<{ antes: number }>(sql`
          select ${antesDe(body.previous_id)} as antes from liame.video_cut_request r
           where r.id = ${body.previous_id} and r.tenant_id = ${quem.tenantId} and r.brand_id = ${body.brand_id}`)
      ).rows[0];
      if (!antes) throw recusa('pedido-anterior-fora', 'Pedido não encontrado', 'O pedido de antes não é desta marca.', 'previous_id');
      if (Number(antes.antes) + 1 > VIDEO_CUTS_LIMITS.others) {
        throw new AppProblem(409, 'outros-acabaram', 'Outros cortes acabaram', `Os outros cortes já foram pedidos ${VIDEO_CUTS_LIMITS.others} vezes: escolha uma das propostas.`);
      }
    }

    // O limite do dia: cada pedido gasta a IA com até 16 imagens.
    if ((await this.hoje(quem, body.brand_id)) >= VIDEO_CUTS_LIMITS.perDay) {
      throw new AppProblem(409, 'limite-do-dia', 'Limite do dia', `A marca já pediu ${VIDEO_CUTS_LIMITS.perDay} vezes os cortes hoje: o limite volta à meia-noite.`);
    }

    const id = uuidv7();
    await tx.execute(sql`
      insert into liame.video_cut_request (id, tenant_id, brand_id, media_ids, duration_s, previous_id, created_by)
      values (${id}, ${quem.tenantId}, ${body.brand_id}, ${`{${ids.join(',')}}`}::uuid[], ${body.duration_s}, ${body.previous_id ?? null}, ${quem.userId})`);
    auditDetail({ resourceId: id, before: null, after: { brand_id: body.brand_id, videos: ids.length, duration_s: body.duration_s, previous_id: body.previous_id ?? null } });
    return this.obter(auth, id);
  }
}
