import {
  type CreateVideoMontageRequest,
  VIDEO_MONTAGE_LIMITS,
  VIDEO_TEMPLATE_RULES,
  type VideoMontageListResponse,
  type VideoMontageResponse,
} from '@liame/contracts';
import { type Database, uuidv7, withSystem } from '@liame/database';
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { baseDoPedido } from '../ai/criativo/contexto.js';
import { conferirPeca } from '../ai/criativo/peca.js';
import { type AuthContext, auditDetail, currentTx } from '../context/request-context.js';
import { marcaDoCriativo } from '../criativo/base.js';
import { DATABASE } from '../database/database.module.js';
import { AppProblem } from '../errors/problems.js';
import { FlagService } from '../flags/flag.service.js';

// O vídeo montado pelo Liame (A6 · Z15, parte 2a; P43 aprovado em 11/11/2026; D-A6-133 a D-A6-138): os pedidos e a
// fila. A rota confere tudo antes de pôr na fila: a função ligada, as fotos ou o vídeo de Fotos que o modelo aceita
// (prontos, da marca, na ordem; o vídeo montado não entra de novo), a logo de Minha marca (quando a pessoa liga a
// opção), o som original só com vídeo, o limite do dia (10 por marca; o que não deu não conta) e os textos pelo
// Compliance, como nas peças (o preço só o de uma oferta em vigor em Minha marca; as regras do Liame; o que a marca não
// diz). A tabela é a fila: o serviço de montagem (`liame-render`, parte 2b) pega o mais antigo, um por vez.

export const FLAG_DO_VIDEO_MONTADO = 'video_montado';

type Quem = { tenantId: string; userId: string };

type Linha = {
  id: string;
  brand_id: string;
  template: VideoMontageResponse['template'];
  format: VideoMontageResponse['format'];
  duration_s: number;
  media_ids: string[];
  title: string;
  price_line: string | null;
  cta: string;
  with_logo: boolean;
  sound: VideoMontageResponse['sound'];
  status: VideoMontageResponse['status'];
  progress: number;
  error: string | null;
  photo_id: string | null;
  created_at: Date | string;
  started_at: Date | string | null;
  finished_at: Date | string | null;
};

const iso = (v: Date | string): string => (v instanceof Date ? v : new Date(v)).toISOString();
const COLUNAS = sql`id, brand_id, template, format, duration_s, media_ids, title, price_line, cta, with_logo, sound, status, progress, error, photo_id, created_at, started_at, finished_at`;

function recusa(code: string, title: string, detail: string, path?: string, errors?: { path: string; message: string }[]): AppProblem {
  return new AppProblem(422, code, title, detail, {}, errors ?? (path ? [{ path, message: detail }] : undefined));
}
function conflito(code: string, title: string, detail: string): AppProblem {
  return new AppProblem(409, code, title, detail);
}

/** O texto do vídeo como o Compliance lê: o título como título; a linha do preço e a chamada como texto. */
export function textoParaConferir(b: Pick<CreateVideoMontageRequest, 'title' | 'price_line' | 'cta'>): { titulo: string; texto: string } {
  return { titulo: b.title, texto: [b.price_line, b.cta].filter(Boolean).join(' · ') };
}

@Injectable()
export class VideoMontadoService {
  constructor(
    @Inject(DATABASE) private readonly database: Database | null,
    private readonly flags: FlagService,
  ) {}

  private quem(auth: AuthContext): Quem {
    if (!auth.tenantId) throw new AppProblem(403, 'sem-empresa-ativa', 'Escolha uma empresa', 'Selecione uma empresa com acesso ativo.');
    return { tenantId: auth.tenantId, userId: auth.userId };
  }

  private async marca(quem: Quem, brandId: string): Promise<void> {
    const r = await currentTx().execute(sql`select 1 from liame.brand where id = ${brandId} and tenant_id = ${quem.tenantId} and archived_at is null`);
    if (!r.rows[0]) throw new AppProblem(404, 'nao-encontrado', 'Não encontramos', 'Marca não encontrada nesta empresa.');
  }

  private ligada(quem: Quem, brandId: string): Promise<boolean> {
    return this.flags.isEnabled(FLAG_DO_VIDEO_MONTADO, this.flags.context({ tenantId: quem.tenantId, userId: quem.userId, brandId }));
  }

  /** Os vídeos de hoje que contam no limite (o que não deu não conta) e quando o limite volta, no fuso da empresa. */
  private async hoje(quem: Quem, brandId: string): Promise<{ used: number; resets_at: string }> {
    const r = await currentTx().execute<{ usados: number; volta: Date | string }>(sql`
      with fuso as (select coalesce((select timezone from liame.organization where id = ${quem.tenantId}), 'America/Sao_Paulo') as tz),
      dia as (select (date_trunc('day', now() at time zone fuso.tz) at time zone fuso.tz) as inicio from fuso)
      select (select count(*)::int from liame.video_montage v, dia
               where v.brand_id = ${brandId} and v.tenant_id = ${quem.tenantId} and v.status <> 'nao_deu' and v.created_at >= dia.inicio) as usados,
             (select (date_trunc('day', now() at time zone fuso.tz) + interval '1 day') at time zone fuso.tz from fuso) as volta`);
    const l = r.rows[0]!;
    return { used: Number(l.usados), resets_at: iso(l.volta) };
  }

  /** Quantos estão na frente de cada pedido da fila, de todas as marcas (a fila é uma só no serviço de montagem). */
  private async naFrente(ids: string[]): Promise<Map<string, number>> {
    const saida = new Map<string, number>();
    if (!ids.length || !this.database) return saida;
    const r = await withSystem(this.database.db, (tx) =>
      tx.execute<{ id: string; frente: number }>(sql`
        select v.id, (select count(*)::int from liame.video_montage o
                       where o.status in ('na_fila', 'montando') and (o.created_at, o.id) < (v.created_at, v.id)) as frente
          from liame.video_montage v
         where v.id in ${ids} and v.status = 'na_fila'`),
    );
    for (const l of r.rows) saida.set(l.id, Number(l.frente));
    return saida;
  }

  private resposta(l: Linha, frente: Map<string, number>): VideoMontageResponse {
    return {
      id: l.id,
      brand_id: l.brand_id,
      template: l.template,
      format: l.format,
      duration_s: l.duration_s,
      media_ids: l.media_ids,
      title: l.title,
      price_line: l.price_line,
      cta: l.cta,
      with_logo: l.with_logo,
      sound: l.sound,
      status: l.status,
      progress: l.progress,
      error: l.error,
      queue_ahead: l.status === 'na_fila' ? (frente.get(l.id) ?? 0) : null,
      photo_id: l.photo_id,
      created_at: iso(l.created_at),
      started_at: l.started_at ? iso(l.started_at) : null,
      finished_at: l.finished_at ? iso(l.finished_at) : null,
    };
  }

  /** Os pedidos mais recentes da marca, o limite do dia e se há logo em Minha marca. */
  async lista(auth: AuthContext, brandId: string): Promise<VideoMontageListResponse> {
    const quem = this.quem(auth);
    await this.marca(quem, brandId);
    const tx = currentTx();
    const linhas = (await tx.execute<Linha>(sql`select ${COLUNAS} from liame.video_montage where brand_id = ${brandId} order by created_at desc, id desc limit 20`)).rows;
    const frente = await this.naFrente(linhas.filter((l) => l.status === 'na_fila').map((l) => l.id));
    const logo = await tx.execute(sql`select 1 from liame.brand where id = ${brandId} and logo_id is not null`);
    const hoje = await this.hoje(quem, brandId);
    return {
      enabled: await this.ligada(quem, brandId),
      today: { used: hoje.used, limit: VIDEO_MONTAGE_LIMITS.perDay, resets_at: hoje.resets_at },
      has_logo: Boolean(logo.rows[0]),
      items: linhas.map((l) => this.resposta(l, frente)),
    };
  }

  /** Um pedido da empresa. */
  async obter(auth: AuthContext, id: string): Promise<VideoMontageResponse> {
    const quem = this.quem(auth);
    const l = (await currentTx().execute<Linha>(sql`select ${COLUNAS} from liame.video_montage where id = ${id} and tenant_id = ${quem.tenantId}`)).rows[0];
    if (!l) throw new AppProblem(404, 'nao-encontrado', 'Não encontramos', 'Este vídeo não está aqui.');
    return this.resposta(l, await this.naFrente(l.status === 'na_fila' ? [l.id] : []));
  }

  /** Confere o pedido e o põe na fila. */
  async criar(auth: AuthContext, body: CreateVideoMontageRequest): Promise<VideoMontageResponse> {
    const tx = currentTx();
    const quem = this.quem(auth);
    await this.marca(quem, body.brand_id);
    if (!(await this.ligada(quem, body.brand_id))) throw conflito('funcao-desligada', 'Função desligada', 'O vídeo montado não está ligado para esta empresa.');

    // O modelo: quantas fotos ou vídeos, se aceita vídeo e a linha do preço.
    const regra = VIDEO_TEMPLATE_RULES[body.template];
    const ids = [...new Set(body.media_ids)];
    if (ids.length !== body.media_ids.length) throw recusa('midia-repetida', 'Foto repetida', 'Cada foto entra uma vez só no vídeo.', 'media_ids');
    if (ids.length < regra.min || ids.length > regra.max) {
      const quantas = regra.min === regra.max ? `${regra.min} foto${regra.video ? ' ou vídeo' : ''}` : `de ${regra.min} a ${regra.max} fotos`;
      throw recusa('midias-do-modelo', 'Quantidade de fotos', `Este modelo leva ${quantas}.`, 'media_ids');
    }
    if (body.price_line && !regra.price) throw recusa('preco-no-modelo', 'Sem linha do preço', 'Este modelo não leva a linha do preço.', 'price_line');

    // As fotos e o vídeo de Fotos: prontos, da marca; o vídeo montado não entra de novo.
    const midias = (
      await tx.execute<{ id: string; kind: string | null; montage_id: string | null }>(sql`
        select id, kind, montage_id from liame.brand_photo
         where id in ${ids} and tenant_id = ${quem.tenantId} and brand_id = ${body.brand_id} and status = 'pronta' and removed_at is null`)
    ).rows;
    if (midias.length !== ids.length) throw recusa('midia-fora-das-fotos', 'Foto não encontrada', 'Escolha fotos ou vídeos prontos de Fotos desta marca.', 'media_ids');
    if (midias.some((m) => m.montage_id)) throw recusa('midia-montada', 'Vídeo montado', 'Um vídeo montado pelo Liame não entra de novo numa montagem.', 'media_ids');
    const comVideo = midias.some((m) => m.kind === 'video');
    if (comVideo && !regra.video) throw recusa('video-no-modelo', 'Só fotos', 'Este modelo leva só fotos. Para usar um vídeo, escolha "Novidade da casa".', 'media_ids');
    if (body.sound === 'original' && !comVideo) throw recusa('som-sem-video', 'Sem vídeo', 'O som original só vale quando o vídeo da loja entra no modelo.', 'sound');

    // A logo de Minha marca.
    if (body.with_logo) {
      const logo = await tx.execute(sql`select 1 from liame.brand where id = ${body.brand_id} and logo_id is not null`);
      if (!logo.rows[0]) throw recusa('sem-logo', 'Falta a logo', 'Envie a logo do restaurante em Minha marca para usar a opção da logo.', 'with_logo');
    }

    // O limite do dia.
    const hoje = await this.hoje(quem, body.brand_id);
    if (hoje.used >= VIDEO_MONTAGE_LIMITS.perDay) {
      throw conflito('limite-do-dia', 'Limite do dia', `A marca já montou ${VIDEO_MONTAGE_LIMITS.perDay} vídeos hoje: o limite volta à meia-noite.`);
    }

    // Os textos pelo Compliance, como nas peças: o preço só o de uma oferta em vigor; as regras do Liame; o que a marca
    // não diz. O tamanho é da Meta (das peças de anúncio) e não vale aqui.
    const fuso = (await tx.execute<{ timezone: string | null }>(sql`select timezone from liame.organization where id = ${quem.tenantId}`)).rows[0]?.timezone ?? 'America/Sao_Paulo';
    const marca = await marcaDoCriativo(body.brand_id, fuso, new Date());
    const ofertas = marca?.conteudo.offers.items ?? [];
    const base = baseDoPedido({ oferta: ofertas.join('; '), instrucao: null }, { fatos: marca?.fatos ?? '', proibidas: marca?.proibidas ?? [], concorrentes: marca?.concorrentes ?? [] });
    const conferencia = conferirPeca(textoParaConferir(body), base, 'pessoa');
    const barrados = conferencia.itens.filter((i) => i.item !== 'tamanho' && i.situacao === 'barrou').flatMap((i) => i.achados);
    if (barrados.length) {
      const motivo = (tipo: string) =>
        tipo === 'preco_fora' ? 'o preço não é o de uma oferta em vigor em Minha marca' : tipo === 'regra_da_marca' ? 'a marca não diz isso (Minha marca)' : 'uma regra do Liame barra este texto';
      throw recusa(
        'texto-barrado',
        'O Compliance barrou o texto',
        `O Compliance barrou: ${barrados.map((a) => `"${a.trecho}" (${motivo(a.tipo)})`).join('; ')}.`,
        undefined,
        // O texto do Compliance junta a linha do preço e a chamada: o trecho diz de qual das duas veio.
        barrados.map((a) => ({
          path: a.campo === 'titulo' ? 'title' : body.price_line && body.price_line.toLowerCase().includes(a.trecho.toLowerCase()) ? 'price_line' : 'cta',
          message: `"${a.trecho}": ${motivo(a.tipo)}`,
        })),
      );
    }

    const id = uuidv7();
    await tx.execute(sql`
      insert into liame.video_montage (id, tenant_id, brand_id, template, format, duration_s, media_ids, title, price_line, cta, with_logo, sound, requested_by)
      values (${id}, ${quem.tenantId}, ${body.brand_id}, ${body.template}, ${body.format}, ${body.duration_s}, ${`{${ids.join(',')}}`}::uuid[],
              ${body.title}, ${body.price_line ?? null}, ${body.cta}, ${body.with_logo}, ${body.sound}, ${quem.userId})`);
    auditDetail({ resourceId: id, before: null, after: { brand_id: body.brand_id, template: body.template, format: body.format, duration_s: body.duration_s, media: ids.length } });
    return this.obter(auth, id);
  }
}
