import { type CreatePostRequest, type PostListQuery, type PostListResponse, type PostResponse } from '@liame/contracts';
import { uuidv7 } from '@liame/database';
import { Injectable } from '@nestjs/common';
import { type SQL, sql } from 'drizzle-orm';
import { ActionService, PREFIXO_RECUSA } from '../actions/action.service.js';
import { contaConectada } from '../connections/conectada.js';
import { FLAG_DOS_POSTS } from '../connectors/meta/publicacao.js';
import { type AuthContext, auditDetail, currentTx } from '../context/request-context.js';
import { AppProblem } from '../errors/problems.js';
import { FlagService } from '../flags/flag.service.js';
import { recorteDoInstagram } from '../fotos/conferencia.js';
import {
  type CanalDoPost,
  CANAIS_DO_POST,
  DIAS_DE_ANTECEDENCIA,
  dentroDaJanela,
  horaLocal,
  LIMITE_DO_TEXTO,
  PROVEDOR_DO_CANAL,
  recursoDoPost,
  situacaoDoPost,
} from './post-plano.js';

// Os posts da marca (A6, Z5b; protótipo P19, aprovado pelo dono em 21/10/2026; D-A6-3, D-A6-6 a D-A6-8 e D-A6-21; as
// decisões técnicas D-A6-32 a D-A6-37). Criar um post grava o post e os canais e faz o pedido em Aprovações, na mesma
// transação (a ferramenta `post_publicar`): o post só sai com a aprovação de uma pessoa, com o código do app, na hora
// marcada. A Agenda lê os posts de um período, com a situação de cada um. Com a função `social_write` desligada, a
// Agenda vem vazia e criar responde 409, antes de qualquer outra conferência.

export const RECURSO_DO_POST = 'social_post';
export const ACAO_CRIAR_POST = 'posts.criar';
/** O período da Agenda vai até este tanto de dias. */
export const DIAS_DA_AGENDA = 62;

type Quem = { tenantId: string; userId: string };

type LinhaDoPost = {
  id: string;
  brand_id: string;
  photo_id: string | null;
  crop_pos: number | null;
  publish_at: Date;
  action_id: string | null;
  created_at: Date;
  pedido_status: string | null;
  pedido_motivo: string | null;
};
type LinhaDoCanal = {
  post_id: string;
  channel: string;
  connected_account_id: string | null;
  account_name: string | null;
  body: string;
  status: string;
  permalink: string | null;
  error: string | null;
  published_at: Date | null;
};

const iso = (d: Date | string) => new Date(d).toISOString();
const isoOuNulo = (d: Date | string | null) => (d ? iso(d) : null);

function desligada(): AppProblem {
  return new AppProblem(409, 'funcao-desligada', 'Função desligada', 'Os posts não estão ligados para esta empresa.');
}

function recusa(code: string, title: string, detail: string, path?: string): AppProblem {
  return new AppProblem(422, code, title, detail, {}, path ? [{ path, message: detail }] : undefined);
}

@Injectable()
export class PostsService {
  constructor(
    private readonly actions: ActionService,
    private readonly flags: FlagService,
  ) {}

  private ligada(quem: Quem, brandId: string): Promise<boolean> {
    return this.flags.isEnabled(FLAG_DOS_POSTS, this.flags.context({ tenantId: quem.tenantId, userId: quem.userId, brandId }));
  }

  private quem(auth: AuthContext): Quem {
    if (!auth.tenantId) throw new AppProblem(403, 'sem-empresa-ativa', 'Escolha uma empresa', 'Selecione uma empresa com acesso ativo.');
    return { tenantId: auth.tenantId, userId: auth.userId };
  }

  private async marcaDaEmpresa(tenantId: string, brandId: string): Promise<void> {
    const b = await currentTx().execute(sql`select 1 from liame.brand where id = ${brandId} and tenant_id = ${tenantId} and archived_at is null`);
    if (!b.rows[0]) throw new AppProblem(404, 'nao-encontrado', 'Não encontramos', 'Marca não encontrada nesta empresa.');
  }

  private async fusoDaEmpresa(tenantId: string): Promise<string> {
    const r = await currentTx().execute<{ timezone: string | null }>(sql`select timezone from liame.organization where id = ${tenantId}`);
    return r.rows[0]?.timezone ?? 'America/Sao_Paulo';
  }

  /**
   * Cria o post e o pedido em Aprovações (D-A6-20: o "Novo post" da Agenda). A foto é uma pronta das Fotos da marca; cada
   * canal é a conta ligada à marca daquele canal (a Página, o Instagram), uma só (decisão técnica D-A6-36); a hora fica
   * entre 8h e 22h no fuso da empresa, depois de agora e até 60 dias; o recorte do Instagram só vale quando a foto não
   * cabe nele (D-A6-21; sem ele, no centro). O pedido passa pelo trilho de sempre (a trava, a política, o plano).
   */
  async criar(auth: AuthContext, body: CreatePostRequest, agora: Date = new Date()): Promise<PostResponse> {
    const tx = currentTx();
    const quem = this.quem(auth);
    await this.marcaDaEmpresa(quem.tenantId, body.brand_id);
    if (!(await this.ligada(quem, body.brand_id))) throw desligada();

    const canais = body.channels.map((c) => c.channel);
    if (new Set(canais).size !== canais.length) throw recusa('canal-repetido', 'Canal repetido', 'Cada canal entra uma vez no post.', 'channels');
    // A ordem do post é a dos canais do Liame (o Instagram primeiro): é a do pedido e a da publicação.
    const ordenados = [...body.channels].sort((a, b) => CANAIS_DO_POST.indexOf(a.channel) - CANAIS_DO_POST.indexOf(b.channel));
    for (const c of ordenados) {
      if (c.text.length > LIMITE_DO_TEXTO[c.channel]) {
        throw recusa('texto-longo-demais', 'Texto longo demais', `O texto ${c.channel === 'instagram' ? 'do Instagram' : 'da Página'} passa de ${LIMITE_DO_TEXTO[c.channel].toLocaleString('pt-BR')} caracteres.`, 'channels');
      }
    }

    const f = await tx.execute<{ id: string; sha256: string; width: number; height: number }>(sql`
      select id, sha256, width, height from liame.brand_photo
       where id = ${body.photo_id} and tenant_id = ${quem.tenantId} and brand_id = ${body.brand_id} and status = 'pronta' and removed_at is null`);
    const foto = f.rows[0];
    if (!foto) throw recusa('foto-fora-da-marca', 'Foto não encontrada', 'A foto não está nas Fotos desta marca (ou ainda não terminou de chegar).', 'photo_id');
    const comInstagram = canais.includes('instagram');
    const precisaDeRecorte = comInstagram && recorteDoInstagram(foto.width, foto.height) !== 'nenhum';
    const recorte = precisaDeRecorte ? (body.crop_pos ?? 50) : null;

    const hora = new Date(body.publish_at);
    const fuso = await this.fusoDaEmpresa(quem.tenantId);
    if (hora.getTime() < agora.getTime() - 60_000) throw recusa('hora-no-passado', 'Hora no passado', 'Escolha uma hora depois de agora.', 'publish_at');
    if (hora.getTime() > agora.getTime() + DIAS_DE_ANTECEDENCIA * 86_400_000) {
      throw recusa('hora-longe-demais', 'Longe demais', `O post pode ser marcado para até ${DIAS_DE_ANTECEDENCIA} dias.`, 'publish_at');
    }
    if (!dentroDaJanela(horaLocal(hora, fuso))) throw recusa('hora-fora-da-janela', 'Fora do horário', 'O post sai entre 8h e 22h.', 'publish_at');

    // A conta de cada canal: a conectada à marca (ligada e sem a recusa da plataforma), com o provedor do canal; uma só.
    const contas = await tx.execute<{ id: string; provider: string }>(sql`
      select a.id, a.provider from liame.connected_account a
       where a.tenant_id = ${quem.tenantId} and a.brand_id = ${body.brand_id} and ${contaConectada('a')}
         and a.provider in ${ordenados.map((c) => PROVEDOR_DO_CANAL[c.channel])}`);
    const contaDo = new Map<CanalDoPost, string>();
    for (const c of ordenados) {
      const achadas = contas.rows.filter((r) => r.provider === PROVEDOR_DO_CANAL[c.channel]);
      const nome = c.channel === 'instagram' ? 'o Instagram' : 'a Página do Facebook';
      if (achadas.length === 0) throw recusa('canal-nao-conectado', 'Canal não conectado', `Ligue ${nome} da marca em Contas conectadas.`, 'channels');
      if (achadas.length > 1) {
        throw recusa('canal-com-duas-contas', 'Mais de uma conta', `A marca tem mais de uma conta ${c.channel === 'instagram' ? 'do Instagram' : 'da Página do Facebook'} ligada. Deixe uma só ligada em Contas conectadas.`, 'channels');
      }
      contaDo.set(c.channel, achadas[0]!.id);
    }

    const id = uuidv7();
    await tx.execute(sql`
      insert into liame.social_post (id, tenant_id, brand_id, photo_id, photo_sha256, crop_pos, publish_at, created_by)
      values (${id}, ${quem.tenantId}, ${body.brand_id}, ${foto.id}, ${foto.sha256}, ${recorte}, ${hora.toISOString()}, ${quem.userId})`);
    const linhas = ordenados.map((c) => ({ id: uuidv7(), channel: c.channel, conta: contaDo.get(c.channel)!, body: c.text }));
    await tx.execute(sql`
      insert into liame.social_post_channel (id, tenant_id, post_id, channel, connected_account_id, body)
      select x.id, ${quem.tenantId}, ${id}, x.channel, x.conta, x.body
        from jsonb_to_recordset(${JSON.stringify(linhas)}::jsonb) as x (id uuid, channel text, conta uuid, body text)`);

    // O pedido em Aprovações, pela conta do primeiro canal (o provedor do pedido é o dela; D-A6-32).
    const primeiro = ordenados[0]!.channel;
    const pedido = await this.actions.create(auth, {
      tool: 'post_publicar',
      brand_id: body.brand_id,
      provider: PROVEDOR_DO_CANAL[primeiro],
      account_id: contaDo.get(primeiro)!,
      resource_id: recursoDoPost(id),
      params: {},
    });
    await tx.execute(sql`update liame.social_post set action_id = ${pedido.id}, updated_at = now() where id = ${id} and tenant_id = ${quem.tenantId}`);
    auditDetail({ resourceId: id, after: { brand_id: body.brand_id, action_id: pedido.id, canais: ordenados.map((c) => c.channel), publish_at: hora.toISOString(), crop_pos: recorte } });
    return this.obter(auth, id);
  }

  /** Um post da empresa, com os canais e a situação. */
  async obter(auth: AuthContext, id: string): Promise<PostResponse> {
    const quem = this.quem(auth);
    const posts = await this.ler(quem.tenantId, sql`p.id = ${id}`);
    const post = posts[0];
    if (!post) throw new AppProblem(404, 'post-nao-encontrado', 'Não encontramos', 'Este post não está mais aqui.');
    return post;
  }

  /** Os posts da marca de `from` a `to` (os dois dias inclusive, no fuso da empresa): a Agenda. */
  async listar(auth: AuthContext, q: PostListQuery): Promise<PostListResponse> {
    const quem = this.quem(auth);
    await this.marcaDaEmpresa(quem.tenantId, q.brand_id);
    const dias = (Date.parse(`${q.to}T00:00:00Z`) - Date.parse(`${q.from}T00:00:00Z`)) / 86_400_000 + 1;
    if (!(dias >= 1 && dias <= DIAS_DA_AGENDA)) {
      throw new AppProblem(422, 'periodo-invalido', 'Período inválido', `O período vai de 1 a ${DIAS_DA_AGENDA} dias, com o início antes do fim.`);
    }
    const fuso = await this.fusoDaEmpresa(quem.tenantId);
    if (!(await this.ligada(quem, q.brand_id))) return { enabled: false, timezone: fuso, channels: [], items: [] };
    const items = await this.ler(
      quem.tenantId,
      sql`p.brand_id = ${q.brand_id}
          and p.publish_at >= (${q.from}::date)::timestamp at time zone ${fuso}
          and p.publish_at < ((${q.to}::date + 1)::timestamp at time zone ${fuso})`,
    );
    return { enabled: true, timezone: fuso, channels: await this.contasDosCanais(quem.tenantId, q.brand_id), items };
  }

  /**
   * As contas conectadas à marca em cada canal do post (ligadas e sem a recusa da plataforma: as que valem para agir),
   * na ordem em que o Liame publica: o novo post escolhe entre elas, e a Agenda diz o que falta conectar.
   */
  private async contasDosCanais(tenantId: string, brandId: string): Promise<PostListResponse['channels']> {
    const r = await currentTx().execute<{ id: string; name: string; provider: string }>(sql`
      select a.id, a.name, a.provider from liame.connected_account a
       where a.tenant_id = ${tenantId} and a.brand_id = ${brandId} and ${contaConectada('a')}
         and a.provider in ${CANAIS_DO_POST.map((c) => PROVEDOR_DO_CANAL[c])}
       order by a.name collate "C", a.id`);
    return CANAIS_DO_POST.map((channel) => ({
      channel,
      accounts: r.rows.filter((l) => l.provider === PROVEDOR_DO_CANAL[channel]).map((l) => ({ id: l.id, name: l.name })),
    }));
  }

  /** Os posts que casam com o filtro, com os canais, numa consulta para os posts e uma para os canais. */
  private async ler(tenantId: string, filtro: SQL): Promise<PostResponse[]> {
    const tx = currentTx();
    const p = await tx.execute<LinhaDoPost>(sql`
      select p.id, p.brand_id, p.photo_id, p.crop_pos, p.publish_at, p.action_id, p.created_at, r.status as pedido_status, r.status_reason as pedido_motivo
        from liame.social_post p
        left join liame.action_request r on r.id = p.action_id and r.tenant_id = p.tenant_id
       where p.tenant_id = ${tenantId} and ${filtro}
       order by p.publish_at, p.id
       limit 500`);
    if (p.rows.length === 0) return [];
    const c = await tx.execute<LinhaDoCanal>(sql`
      select ch.post_id, ch.channel, ch.connected_account_id, a.name as account_name, ch.body, ch.status, ch.permalink, ch.error, ch.published_at
        from liame.social_post_channel ch
        left join liame.connected_account a on a.id = ch.connected_account_id
       where ch.tenant_id = ${tenantId} and ch.post_id in ${p.rows.map((x) => x.id)}
       order by ch.post_id, case ch.channel when 'instagram' then 0 else 1 end`);
    const canaisDo = new Map<string, LinhaDoCanal[]>();
    for (const l of c.rows) canaisDo.set(l.post_id, [...(canaisDo.get(l.post_id) ?? []), l]);
    return p.rows.map((l): PostResponse => {
      const canais = canaisDo.get(l.id) ?? [];
      return {
        id: l.id,
        brand_id: l.brand_id,
        photo_id: l.photo_id,
        crop_pos: l.crop_pos,
        publish_at: iso(l.publish_at),
        action_id: l.action_id,
        status: situacaoDoPost(l.pedido_status ? { status: l.pedido_status, status_reason: l.pedido_motivo } : null, canais.map((x) => x.status), PREFIXO_RECUSA),
        created_at: iso(l.created_at),
        channels: canais.map((x) => ({
          channel: x.channel,
          account_id: x.connected_account_id,
          account_name: x.account_name,
          text: x.body,
          status: x.status,
          permalink: x.permalink,
          error: x.error,
          published_at: isoOuNulo(x.published_at),
        })),
      };
    });
  }
}
