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
import { palavrasProibidasNoTexto } from '../policy/engine.js';
import { carregarPoliticas } from '../policy/policy.service.js';
import {
  type CanalDoPacote,
  type CanalDoPost,
  CANAIS_DO_PACOTE,
  CANAIS_DO_POST,
  DIAS_DE_ANTECEDENCIA,
  dentroDaJanela,
  ehCanalDoPacote,
  horaLocal,
  LIMITE_DO_PACOTE,
  LIMITE_DO_TEXTO,
  PROVEDOR_DO_CANAL,
  recursoDoPost,
} from './post-plano.js';
import { fusoDaEmpresa, lerPosts } from './ler-posts.js';

// Os posts da marca (A6, Z5b; protótipo P19, aprovado pelo dono em 21/10/2026; D-A6-3, D-A6-6 a D-A6-8 e D-A6-21; as
// decisões técnicas D-A6-32 a D-A6-37). Criar um post grava o post e os canais e faz o pedido em Aprovações, na mesma
// transação (a ferramenta `post_publicar`): o post só sai com a aprovação de uma pessoa, com o código do app, na hora
// marcada. A Agenda lê os posts de um período, com a situação de cada um. Com a função `social_write` desligada, a
// Agenda vem vazia e criar responde 409, antes de qualquer outra conferência.
//
// O pacote pronto (A6, Z8; P22; D-A6-12, D-A6-25 e as decisões técnicas D-A6-40 a D-A6-42): no TikTok e no YouTube o
// Liame não publica. O mesmo "Novo post" monta um pacote para cada uma dessas redes (o texto, a foto e a hora), sem pedido
// em Aprovações e sem o código do app: quem publica é a pessoa, que marca "Publiquei" ou tira o pacote da Agenda. O texto
// do pacote passa pelas palavras proibidas da política, como o do post.

export const RECURSO_DO_POST = 'social_post';
export const ACAO_CRIAR_POST = 'posts.criar';
export const ACAO_PACOTE_PUBLICADO = 'posts.pacote_publicado';
export const ACAO_PACOTE_TIRADO = 'posts.pacote_tirado';

/** O canal na frase, com a preposição dele (V121). */
const DO_CANAL: Record<string, string> = { instagram: 'do Instagram', facebook: 'da Página', tiktok: 'do TikTok', youtube: 'do YouTube' };
/** O período da Agenda vai até este tanto de dias. */
export const DIAS_DA_AGENDA = 62;

type Quem = { tenantId: string; userId: string };

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

  /**
   * Cria o post e o pedido em Aprovações (D-A6-20: o "Novo post" da Agenda) e, para o TikTok e o YouTube, um pacote pronto
   * de cada rede (A6, Z8; D-A6-25). A foto é uma pronta das Fotos da marca; cada canal do Liame é a conta ligada à marca
   * daquele canal (a Página, o Instagram), uma só (decisão técnica D-A6-36); a hora fica entre 8h e 22h no fuso da empresa,
   * depois de agora e até 60 dias; o recorte do Instagram só vale quando a foto não cabe nele (D-A6-21; sem ele, no
   * centro). O pedido passa pelo trilho de sempre (a trava, a política, o plano); o texto do pacote, pelas palavras
   * proibidas da política. Devolve o post do Liame ou, sem ele, o primeiro pacote; os outros aparecem na Agenda.
   */
  async criar(auth: AuthContext, body: CreatePostRequest, agora: Date = new Date()): Promise<PostResponse> {
    const tx = currentTx();
    const quem = this.quem(auth);
    await this.marcaDaEmpresa(quem.tenantId, body.brand_id);
    if (!(await this.ligada(quem, body.brand_id))) throw desligada();

    const canais = body.channels.map((c) => c.channel);
    if (new Set(canais).size !== canais.length) throw recusa('canal-repetido', 'Canal repetido', 'Cada canal entra uma vez no post.', 'channels');
    // A ordem do post é a dos canais do Liame (o Instagram primeiro): é a do pedido e a da publicação. Os do pacote vão à parte.
    const ordenados = body.channels
      .filter((c): c is { channel: CanalDoPost; text: string } => !ehCanalDoPacote(c.channel))
      .sort((a, b) => CANAIS_DO_POST.indexOf(a.channel) - CANAIS_DO_POST.indexOf(b.channel));
    const doPacote = body.channels
      .filter((c): c is { channel: CanalDoPacote; text: string } => ehCanalDoPacote(c.channel))
      .sort((a, b) => CANAIS_DO_PACOTE.indexOf(a.channel) - CANAIS_DO_PACOTE.indexOf(b.channel));
    for (const c of [...ordenados, ...doPacote]) {
      const limite = ehCanalDoPacote(c.channel) ? LIMITE_DO_PACOTE[c.channel] : LIMITE_DO_TEXTO[c.channel];
      if (c.text.length > limite) {
        throw recusa('texto-longo-demais', 'Texto longo demais', `O texto ${DO_CANAL[c.channel]} passa de ${limite.toLocaleString('pt-BR')} caracteres.`, 'channels');
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
    const fuso = await fusoDaEmpresa(tx, quem.tenantId);
    if (hora.getTime() < agora.getTime() - 60_000) throw recusa('hora-no-passado', 'Hora no passado', 'Escolha uma hora depois de agora.', 'publish_at');
    if (hora.getTime() > agora.getTime() + DIAS_DE_ANTECEDENCIA * 86_400_000) {
      throw recusa('hora-longe-demais', 'Longe demais', `O post pode ser marcado para até ${DIAS_DE_ANTECEDENCIA} dias.`, 'publish_at');
    }
    if (!dentroDaJanela(horaLocal(hora, fuso))) throw recusa('hora-fora-da-janela', 'Fora do horário', 'O post sai entre 8h e 22h.', 'publish_at');

    // O texto do pacote: as palavras que a empresa ou a marca proíbem na política, como no pedido do post (D-A6-25). O do
    // post é conferido pelo trilho, no pedido.
    if (doPacote.length) {
      const { policies } = await carregarPoliticas(tx, quem.tenantId, body.brand_id);
      const violacoes = doPacote.flatMap((c) => palavrasProibidasNoTexto(policies, c.text));
      if (violacoes.length) {
        throw new AppProblem(
          422,
          'politica-negou',
          'A política não permite',
          'O texto do pacote fere uma regra da política da empresa ou da plataforma.',
          {},
          violacoes.map((v) => ({ path: `politica.${v.source}.${v.rule_index}`, message: v.message })),
        );
      }
    }

    // A conta de cada canal: a conectada à marca (ligada e sem a recusa da plataforma), com o provedor do canal; uma só.
    const contas = ordenados.length
      ? await tx.execute<{ id: string; provider: string }>(sql`
          select a.id, a.provider from liame.connected_account a
           where a.tenant_id = ${quem.tenantId} and a.brand_id = ${body.brand_id} and ${contaConectada('a')}
             and a.provider in ${ordenados.map((c) => PROVEDOR_DO_CANAL[c.channel])}`)
      : { rows: [] as Array<{ id: string; provider: string }> };
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

    let id: string | null = null;
    let pedidoId: string | null = null;
    if (ordenados.length) {
      id = uuidv7();
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
      pedidoId = pedido.id;
      await tx.execute(sql`update liame.social_post set action_id = ${pedido.id}, updated_at = now() where id = ${id} and tenant_id = ${quem.tenantId}`);
    }

    // Um pacote para cada rede (D-A6-40): a foto inteira (sem recorte), na mesma hora, pronto na Agenda; sem pedido.
    const pacotes = doPacote.map((c) => ({ id: uuidv7(), canal: uuidv7(), channel: c.channel, body: c.text }));
    if (pacotes.length) {
      await tx.execute(sql`
        insert into liame.social_post (id, tenant_id, brand_id, kind, photo_id, photo_sha256, crop_pos, publish_at, created_by)
        select x.id, ${quem.tenantId}, ${body.brand_id}, 'pacote', ${foto.id}, ${foto.sha256}, null, ${hora.toISOString()}, ${quem.userId}
          from jsonb_to_recordset(${JSON.stringify(pacotes)}::jsonb) as x (id uuid)`);
      await tx.execute(sql`
        insert into liame.social_post_channel (id, tenant_id, post_id, channel, connected_account_id, body, status)
        select x.canal, ${quem.tenantId}, x.id, x.channel, null, x.body, 'pronto'
          from jsonb_to_recordset(${JSON.stringify(pacotes)}::jsonb) as x (id uuid, canal uuid, channel text, body text)`);
    }
    auditDetail({
      resourceId: id ?? pacotes[0]!.id,
      after: {
        brand_id: body.brand_id,
        action_id: pedidoId,
        canais: ordenados.map((c) => c.channel),
        pacotes: pacotes.map((p) => ({ id: p.id, canal: p.channel })),
        publish_at: hora.toISOString(),
        crop_pos: recorte,
      },
    });
    return this.obter(auth, id ?? pacotes[0]!.id);
  }

  /**
   * "Publiquei": a pessoa publicou o pacote na rede e marca (P22). Só o pacote pronto muda; o já marcado volta como está
   * (a segunda vez não muda nada); o tirado da Agenda, 409. O Liame não confere na rede (ele não lê o TikTok nem o YouTube).
   */
  async marcarPublicado(auth: AuthContext, id: string, agora: Date = new Date()): Promise<PostResponse> {
    const quem = this.quem(auth);
    const p = await this.pacoteTravado(quem, id);
    if (p.situacoes.includes('pronto')) {
      await currentTx().execute(sql`
        update liame.social_post_channel set status = 'publicado', published_at = ${agora.toISOString()}::timestamptz, updated_at = now()
         where post_id = ${id} and tenant_id = ${quem.tenantId} and status = 'pronto'`);
      await currentTx().execute(sql`update liame.social_post set updated_at = now() where id = ${id} and tenant_id = ${quem.tenantId}`);
      auditDetail({ resourceId: id, before: { situacao: 'pacote_pronto' }, after: { brand_id: p.brand_id, situacao: 'pacote_publicado', canais: p.canais } });
    } else if (!p.situacoes.every((s) => s === 'publicado')) {
      throw new AppProblem(409, 'pacote-tirado', 'O pacote saiu da Agenda', 'Este pacote foi tirado da Agenda: monte outro no "Novo post".');
    }
    return this.obter(auth, id);
  }

  /**
   * Tira o pacote pronto da Agenda (P22): nada foi publicado pelo Liame. O já tirado volta como está; o já marcado como
   * publicado, 409 (o que saiu, saiu).
   */
  async tirar(auth: AuthContext, id: string, agora: Date = new Date()): Promise<PostResponse> {
    const quem = this.quem(auth);
    const p = await this.pacoteTravado(quem, id);
    if (p.situacoes.includes('pronto')) {
      await currentTx().execute(sql`
        update liame.social_post_channel set status = 'cancelado', removed_at = ${agora.toISOString()}::timestamptz, updated_at = now()
         where post_id = ${id} and tenant_id = ${quem.tenantId} and status = 'pronto'`);
      await currentTx().execute(sql`update liame.social_post set updated_at = now() where id = ${id} and tenant_id = ${quem.tenantId}`);
      auditDetail({ resourceId: id, before: { situacao: 'pacote_pronto' }, after: { brand_id: p.brand_id, situacao: 'cancelado', canais: p.canais } });
    } else if (p.situacoes.some((s) => s === 'publicado')) {
      throw new AppProblem(409, 'pacote-ja-publicado', 'O pacote já foi publicado', 'Você marcou este pacote como publicado: ele fica na Agenda.');
    }
    return this.obter(auth, id);
  }

  /** O pacote da empresa, travado até o fim da transação (o "Publiquei" e o "Tirar" ao mesmo tempo não se atropelam). */
  private async pacoteTravado(quem: Quem, id: string): Promise<{ brand_id: string; situacoes: string[]; canais: string[] }> {
    const tx = currentTx();
    const p = (
      await tx.execute<{ brand_id: string; kind: string }>(sql`
        select brand_id, kind from liame.social_post where id = ${id} and tenant_id = ${quem.tenantId} for update`)
    ).rows[0];
    if (!p) throw new AppProblem(404, 'post-nao-encontrado', 'Não encontramos', 'Este post não está mais aqui.');
    if (p.kind !== 'pacote') throw new AppProblem(409, 'nao-e-pacote', 'Não é um pacote', 'O Liame publica este post: ele não tem "Publiquei".');
    if (!(await this.ligada(quem, p.brand_id))) throw desligada();
    const c = await tx.execute<{ channel: string; status: string }>(sql`
      select channel, status from liame.social_post_channel where post_id = ${id} and tenant_id = ${quem.tenantId} order by channel`);
    return { brand_id: p.brand_id, situacoes: c.rows.map((x) => x.status), canais: c.rows.map((x) => x.channel) };
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
    const fuso = await fusoDaEmpresa(currentTx(), quem.tenantId);
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

  /** Os posts que casam com o filtro, com os canais (a leitura que o pedido em Aprovações também usa). */
  private ler(tenantId: string, filtro: SQL): Promise<PostResponse[]> {
    return lerPosts(currentTx(), tenantId, filtro, PREFIXO_RECUSA);
  }
}
