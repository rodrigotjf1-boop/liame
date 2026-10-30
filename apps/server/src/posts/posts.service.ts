import {
  type CreatePostRequest,
  type PostListQuery,
  type PostListResponse,
  type PostPhotoResponse,
  type PostResponse,
  type ReschedulePostRequest,
  type UnpublishPostRequest,
} from '@liame/contracts';
import { uuidv7 } from '@liame/database';
import { Inject, Injectable } from '@nestjs/common';
import { type SQL, sql } from 'drizzle-orm';
import { ActionService, PREFIXO_RECUSA } from '../actions/action.service.js';
import { pedeUmPostNovo } from '../actions/post-publicacao.js';
import { contaConectada } from '../connections/conectada.js';
import { FLAG_DOS_POSTS } from '../connectors/meta/publicacao.js';
import { type AuthContext, auditDetail, currentTx } from '../context/request-context.js';
import { AppProblem } from '../errors/problems.js';
import { FlagService } from '../flags/flag.service.js';
import { recorteDoInstagram } from '../fotos/conferencia.js';
import { ARMAZEM_DE_IMAGENS, type ArmazemDeImagens, ArmazemIndisponivel, FalhaDoArmazem } from '../imagens/armazem.js';
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
  type NovaTentativa,
  novaTentativa,
  PEDIDO_AINDA_SAI,
  PROVEDOR_DO_CANAL,
  recursoDoPost,
} from './post-plano.js';
import { fusoDaEmpresa, lerPosts } from './ler-posts.js';
import { itensDaPauta } from './pauta.js';
import { CANAIS_COM_LINK, criarLinkDoPost, destinoDoPost, SEPARADOR, tamanhoNoTexto } from './link-do-post.js';

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
//
// "Tentar de novo" (A6, Z5d; P19; D-A6-54): o post que saiu num canal e não no outro manda o mesmo post aprovado só no
// canal que faltou, pedido por uma pessoa, sem o código do app, até 24 horas depois de sair no outro (a ferramenta
// `post_tentar_de_novo`, que só existe por esta rota).
//
// "Apagar das redes" (A6, Z5d, parte 6; P19; D-A6-57): o post que o Liame publicou sai de cada canal em que está no ar,
// com o código do app de quem apaga, pedido e aprovado na mesma chamada (a ferramenta `post_apagar`, a volta da
// publicação, que só existe por esta rota). O pedido executa em seguida, no worker.

export const RECURSO_DO_POST = 'social_post';
export const ACAO_CRIAR_POST = 'posts.criar';
export const ACAO_PACOTE_PUBLICADO = 'posts.pacote_publicado';
export const ACAO_PACOTE_TIRADO = 'posts.pacote_tirado';
export const ACAO_TENTAR_DE_NOVO = 'posts.tentar_de_novo';
export const ACAO_MUDAR_A_HORA = 'posts.mudar_a_hora';
export const ACAO_APAGAR_DAS_REDES = 'posts.apagar_das_redes';

/** O canal na frase, com a preposição dele (V121). */
const DO_CANAL: Record<string, string> = { instagram: 'do Instagram', facebook: 'da Página', tiktok: 'do TikTok', youtube: 'do YouTube' };
/** O período da Agenda vai até este tanto de dias. */
export const DIAS_DA_AGENDA = 62;
/** Quanto vale o endereço da foto do pacote: o bastante para o clique baixar (o bucket recusa mais de 10 minutos). */
export const VALIDADE_DA_FOTO_DO_PACOTE_S = 300;

type Quem = { tenantId: string; userId: string };

function desligada(): AppProblem {
  return new AppProblem(409, 'funcao-desligada', 'Função desligada', 'Os posts não estão ligados para esta empresa.');
}

function recusa(code: string, title: string, detail: string, path?: string): AppProblem {
  return new AppProblem(422, code, title, detail, {}, path ? [{ path, message: detail }] : undefined);
}

/**
 * A hora do post (D-A6-8 e D-A6-34): depois de agora (com um minuto de folga), até 60 dias e entre 8h e 22h no fuso da
 * empresa. A recusa (422, com o campo), ou nula. O "Novo post" e "Mudar a hora" conferem igual.
 */
function conferirAHora(hora: Date, agora: Date, fuso: string): AppProblem | null {
  if (hora.getTime() < agora.getTime() - 60_000) return recusa('hora-no-passado', 'Hora no passado', 'Escolha uma hora depois de agora.', 'publish_at');
  if (hora.getTime() > agora.getTime() + DIAS_DE_ANTECEDENCIA * 86_400_000) {
    return recusa('hora-longe-demais', 'Longe demais', `O post pode ser marcado para até ${DIAS_DE_ANTECEDENCIA} dias.`, 'publish_at');
  }
  if (!dentroDaJanela(horaLocal(hora, fuso))) return recusa('hora-fora-da-janela', 'Fora do horário', 'O post sai entre 8h e 22h.', 'publish_at');
  return null;
}

/** "30/10, 19:00", no fuso da empresa. */
const diaEHora = (instante: Date, fuso: string): string =>
  new Intl.DateTimeFormat('pt-BR', { timeZone: fuso, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(instante);

/** O canal na frase, com a preposição de lugar (V121). */
const NO_CANAL: Record<string, string> = { instagram: 'no Instagram', facebook: 'na Página do Facebook' };

/** Por que não dá para "Tentar de novo" (A6, Z5d; D-A6-54): 409, com o código e a frase de cada motivo. */
function semNovaTentativa(motivo: Exclude<NovaTentativa, { ok: true }>['motivo'], saiu?: string, falta?: string): AppProblem {
  const no = (c: string | undefined, senao: string) => (c ? (NO_CANAL[c] ?? senao) : senao);
  switch (motivo) {
    case 'ainda_sai':
      return new AppProblem(409, 'post-ainda-sai', 'O post ainda sai', 'Este post ainda espera a aprovação ou a hora, ou está saindo agora: não há o que tentar de novo.');
    case 'nao_tenta':
      return new AppProblem(409, 'post-nao-sai', 'O post não sai', 'Este post foi cancelado, recusado ou não foi aprovado a tempo: para publicar, faça um post novo.');
    case 'nao_saiu_em_nenhum':
      return new AppProblem(
        409,
        'post-nao-saiu',
        'O post não saiu',
        '"Tentar de novo" vale para o post que saiu num canal e não no outro. Este não saiu em nenhum: confira o motivo em cada canal e faça um post novo.',
      );
    case 'ja_saiu':
      return new AppProblem(409, 'post-ja-saiu', 'O post já saiu', 'Este post já saiu em todos os canais.');
    case 'pede_post_novo':
      return new AppProblem(409, 'tentar-nao-adianta', 'Tentar de novo não adianta', `Pelo motivo de o post não ter saído ${no(falta, 'no outro canal')}, tentar de novo não resolve: faça um post novo.`);
    case 'passou_o_prazo':
      return new AppProblem(
        409,
        'prazo-da-tentativa',
        'Passou o prazo',
        `Já passou um dia desde que o post saiu ${no(saiu, 'no outro canal')}: a hora mudaria quem vê o post. Para publicar ${no(falta, 'no canal que faltou')}, faça um post novo.`,
      );
  }
}

@Injectable()
export class PostsService {
  constructor(
    private readonly actions: ActionService,
    private readonly flags: FlagService,
    @Inject(ARMAZEM_DE_IMAGENS) private readonly armazem: ArmazemDeImagens,
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
    const quem = this.quem(auth);
    const feito = await this.montar(quem, body, agora, async (input) => (await this.actions.create(auth, input)).id);
    auditDetail({ resourceId: feito.id, after: feito.auditoria });
    return this.obter(auth, feito.id);
  }

  /**
   * O post que o Social media propõe para um dia da pauta (A6, Z6, os posts, parte 2; D-A6-60): o mesmo caminho do "Novo
   * post" (a foto, as contas, a hora, o link e as conferências), só com os canais do Liame, e o pedido em Aprovações feito
   * pelo funcionário em nome do dono da empresa (`alvo.emNomeDe`, que fica também como quem criou o post). Quem chama é a
   * rotina, na transação da empresa, e grava a auditoria dela com o que volta. As recusas são as do "Novo post" (422 e
   * 409, com o código) e as do trilho.
   */
  async criarPeloFuncionario(
    alvo: { tenantId: string; agentKey: string; agentLabel: string; emNomeDe: string },
    body: CreatePostRequest,
    agora: Date = new Date(),
  ): Promise<{ post: string; pedido: string; auditoria: Record<string, unknown> }> {
    if (body.channels.some((c) => ehCanalDoPacote(c.channel))) throw recusa('canal-do-pacote', 'Canal do pacote', 'O funcionário só propõe post nos canais em que o Liame publica.', 'channels');
    const feito = await this.montar({ tenantId: alvo.tenantId, userId: alvo.emNomeDe }, body, agora, (input) => this.actions.pedirPostPeloFuncionario(alvo, input));
    if (!feito.pedido) throw new Error('post do funcionário sem pedido');
    return { post: feito.id, pedido: feito.pedido, auditoria: feito.auditoria };
  }

  /**
   * O que o "Novo post" e o post do funcionário dividem: confere tudo, grava o post, os canais, o link e os pacotes, e faz
   * o pedido em Aprovações por quem chama (`pedir`, que devolve o id do pedido). Devolve o id do post do Liame (ou do
   * primeiro pacote), o do pedido e o que vai para a auditoria.
   */
  private async montar(
    quem: Quem,
    body: CreatePostRequest,
    agora: Date,
    pedir: (input: { tool: string; brand_id: string; provider: string; account_id: string; resource_id: string; params: Record<string, unknown> }) => Promise<string>,
  ): Promise<{ id: string; pedido: string | null; auditoria: Record<string, unknown> }> {
    const tx = currentTx();
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
    // O link do post (D-A6-46): o cardápio da loja da marca, quando ela tem uma loja só com ele ligado. Na Página, o link
    // vai no fim do texto (D-A6-47), e o limite dela conta o link.
    const comLink = canais.some((c) => CANAIS_COM_LINK.includes(c));
    const destino = comLink ? await destinoDoPost(tx, quem.tenantId, body.brand_id) : null;
    for (const c of [...ordenados, ...doPacote]) {
      const limite = ehCanalDoPacote(c.channel) ? LIMITE_DO_PACOTE[c.channel] : LIMITE_DO_TEXTO[c.channel];
      const doLink = c.channel === 'facebook' && destino?.ok ? tamanhoNoTexto(destino.url, c.channel) : 0;
      if (c.text.length + doLink > limite) {
        const comOLink = doLink ? ', com o link do post no fim,' : '';
        throw recusa('texto-longo-demais', 'Texto longo demais', `O texto ${DO_CANAL[c.channel]}${comOLink} passa de ${limite.toLocaleString('pt-BR')} caracteres.`, 'channels');
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
    const recusaDaHora = conferirAHora(hora, agora, fuso);
    if (recusaDaHora) throw recusaDaHora;

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

    const nomeDoLink = (rede: string) => `Post · ${rede} · ${new Intl.DateTimeFormat('pt-BR', { timeZone: fuso, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(hora)}`;
    let id: string | null = null;
    let pedidoId: string | null = null;
    let linkDoPost: string | null = null;
    if (ordenados.length) {
      id = uuidv7();
      await tx.execute(sql`
        insert into liame.social_post (id, tenant_id, brand_id, photo_id, photo_sha256, crop_pos, publish_at, created_by)
        values (${id}, ${quem.tenantId}, ${body.brand_id}, ${foto.id}, ${foto.sha256}, ${recorte}, ${hora.toISOString()}, ${quem.userId})`);
      // Com a Página e o cardápio da loja, o link do post nasce com ele e vai no fim do texto da Página: é o que vai para
      // Aprovações e o que sai (D-A6-47).
      if (canais.includes('facebook') && destino?.ok) {
        linkDoPost = await criarLinkDoPost(tx, { tenantId: quem.tenantId, brandId: body.brand_id, postId: id, canal: 'facebook', destino, nome: nomeDoLink('Página do Facebook'), userId: quem.userId });
      }
      const linhas = ordenados.map((c) => ({ id: uuidv7(), channel: c.channel, conta: contaDo.get(c.channel)!, body: c.channel === 'facebook' && linkDoPost ? `${c.text}${SEPARADOR}${linkDoPost}` : c.text }));
      await tx.execute(sql`
        insert into liame.social_post_channel (id, tenant_id, post_id, channel, connected_account_id, body)
        select x.id, ${quem.tenantId}, ${id}, x.channel, x.conta, x.body
          from jsonb_to_recordset(${JSON.stringify(linhas)}::jsonb) as x (id uuid, channel text, conta uuid, body text)`);

      // O pedido em Aprovações, pela conta do primeiro canal (o provedor do pedido é o dela; D-A6-32).
      const primeiro = ordenados[0]!.channel;
      pedidoId = await pedir({
        tool: 'post_publicar',
        brand_id: body.brand_id,
        provider: PROVEDOR_DO_CANAL[primeiro],
        account_id: contaDo.get(primeiro)!,
        resource_id: recursoDoPost(id),
        params: {},
      });
      await tx.execute(sql`update liame.social_post set action_id = ${pedidoId}, updated_at = now() where id = ${id} and tenant_id = ${quem.tenantId}`);
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
      // O link de cada pacote é o da bio (D-A6-47): o texto do pacote não muda.
      if (destino?.ok) {
        for (const p of pacotes) {
          await criarLinkDoPost(tx, { tenantId: quem.tenantId, brandId: body.brand_id, postId: p.id, canal: p.channel, destino, nome: nomeDoLink(p.channel === 'tiktok' ? 'TikTok' : 'YouTube'), userId: quem.userId });
        }
      }
    }
    return {
      id: id ?? pacotes[0]!.id,
      pedido: pedidoId,
      auditoria: {
        brand_id: body.brand_id,
        action_id: pedidoId,
        canais: ordenados.map((c) => c.channel),
        pacotes: pacotes.map((p) => ({ id: p.id, canal: p.channel })),
        publish_at: hora.toISOString(),
        crop_pos: recorte,
        // O link do post (D-A6-46): criado, ou por que não.
        link_do_post: destino === null ? null : destino.ok ? 'criado' : destino.motivo,
      },
    };
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

  /**
   * "Tentar de novo" (A6, Z5d; P19, aprovado em 21/10/2026; D-A6-54): o post que saiu num canal e não no outro manda o
   * mesmo post aprovado só no canal que faltou, sem o código do app. Confere, com o post travado, o pedido mais novo do
   * post (terminou sem sair: falhou, inclusive barrado), o canal que falta, o motivo (o que pede um post novo não tenta) e o
   * prazo (24 horas depois de o post sair no outro canal); põe o canal de volta na espera e faz o pedido da nova tentativa
   * pelo trilho (a trava, a flag, a política v10, o plano), que passa a ser o pedido do post. Tudo na mesma transação: o
   * pedido recusado pelo trilho deixa o canal como estava.
   */
  async tentarDeNovo(auth: AuthContext, id: string, agora: Date = new Date()): Promise<PostResponse> {
    const tx = currentTx();
    const quem = this.quem(auth);
    const p = (
      await tx.execute<{ brand_id: string; kind: string; action_id: string | null; pedido: string | null }>(sql`
        select p.brand_id, p.kind, p.action_id, r.status as pedido
          from liame.social_post p
          left join liame.action_request r on r.id = p.action_id and r.tenant_id = p.tenant_id
         where p.id = ${id} and p.tenant_id = ${quem.tenantId}
           for update of p`)
    ).rows[0];
    if (!p) throw new AppProblem(404, 'post-nao-encontrado', 'Não encontramos', 'Este post não está mais aqui.');
    if (p.kind !== 'post') throw new AppProblem(409, 'e-pacote', 'É um pacote', 'O pacote, quem publica é você: ele não tem "Tentar de novo".');
    if (!(await this.ligada(quem, p.brand_id))) throw desligada();
    const canais = (
      await tx.execute<{ id: string; channel: string; connected_account_id: string | null; status: string; error: string | null; published_at: Date | null }>(sql`
        select id, channel, connected_account_id, status, error, published_at from liame.social_post_channel
         where post_id = ${id} and tenant_id = ${quem.tenantId}
         order by case channel when 'instagram' then 0 else 1 end
           for update`)
    ).rows;
    const decisao = novaTentativa(
      p.pedido,
      canais.map((c) => ({ canal: c.channel, situacao: c.status, publicadoEm: c.published_at ? new Date(c.published_at) : null, pedePostNovo: pedeUmPostNovo(c.error) })),
      agora,
    );
    if (!decisao.ok) {
      const outro = canais.find((c) => c.status === 'publicado')?.channel;
      const falta = canais.find((c) => c.status !== 'publicado')?.channel;
      throw semNovaTentativa(decisao.motivo, outro, falta);
    }
    const canal = canais.find((c) => c.channel === decisao.canal)!;
    const nome = canal.channel as CanalDoPost;
    if (!canal.connected_account_id) {
      throw recusa('canal-nao-conectado', 'Canal não conectado', `A conta ${DO_CANAL[nome]} deste post não está mais ligada à marca: conecte de novo em Contas conectadas.`, 'channels');
    }
    // O canal volta para a espera (o contêiner e a hora da tentativa anterior ficam: é por eles que a publicação confere
    // se a tentativa anterior já publicou, A6-9). O pedido novo nasce aprovado e sai agora, na janela das 8h às 22h.
    await tx.execute(sql`update liame.social_post_channel set status = 'aguardando', error = null, updated_at = now() where id = ${canal.id}`);
    const pedido = await this.actions.pedirNovaTentativa(
      auth,
      { tool: 'post_tentar_de_novo', brand_id: p.brand_id, provider: PROVEDOR_DO_CANAL[nome], account_id: canal.connected_account_id, resource_id: recursoDoPost(id), params: {} },
      p.action_id!,
    );
    await tx.execute(sql`update liame.social_post set action_id = ${pedido}, updated_at = now() where id = ${id} and tenant_id = ${quem.tenantId}`);
    auditDetail({
      resourceId: id,
      before: { canal: nome, situacao: canal.status, erro: canal.error, action_id: p.action_id },
      after: { brand_id: p.brand_id, canal: nome, situacao: 'aguardando', action_id: pedido, ate: decisao.ate.toISOString() },
    });
    return this.obter(auth, id);
  }

  /**
   * Mudar a hora de um post aprovado que ainda espera a hora (A6, Z5d; P19; D-A6-23 e D-A6-55): a hora muda quem vê o
   * post, então a aprovação vale de novo, com o código do app. Com o post travado: o pedido aprovado é cancelado (o motivo
   * diz a hora nova), o post muda de hora (e de versão: o que sai é o que foi aprovado agora) e um pedido novo nasce e é
   * aprovado pelo trilho de sempre (a política, o plano, o código de quem muda), na mesma transação: o código errado, ou o
   * trilho que recusa (a conta que saiu da marca, a trava), deixa tudo como estava. O pedido novo passa a ser o do post.
   */
  async mudarAHora(auth: AuthContext, id: string, body: ReschedulePostRequest, agora: Date = new Date()): Promise<PostResponse> {
    const tx = currentTx();
    const quem = this.quem(auth);
    const p = (
      await tx.execute<{ brand_id: string; kind: string; action_id: string | null; publish_at: Date; pedido: string | null; ferramenta: string | null }>(sql`
        select p.brand_id, p.kind, p.action_id, p.publish_at, r.status as pedido, r.tool as ferramenta
          from liame.social_post p
          left join liame.action_request r on r.id = p.action_id and r.tenant_id = p.tenant_id
         where p.id = ${id} and p.tenant_id = ${quem.tenantId}
           for update of p`)
    ).rows[0];
    if (!p) throw new AppProblem(404, 'post-nao-encontrado', 'Não encontramos', 'Este post não está mais aqui.');
    if (p.kind !== 'post') throw new AppProblem(409, 'e-pacote', 'É um pacote', 'O pacote não tem pedido: para outra hora, tire-o da Agenda e monte outro no "Novo post".');
    if (!(await this.ligada(quem, p.brand_id))) throw desligada();
    const canais = (
      await tx.execute<{ channel: string; connected_account_id: string | null; status: string }>(sql`
        select channel, connected_account_id, status from liame.social_post_channel
         where post_id = ${id} and tenant_id = ${quem.tenantId}
         order by case channel when 'instagram' then 0 else 1 end
           for update`)
    ).rows;
    if (p.pedido !== 'aprovada' || p.ferramenta !== 'post_publicar' || !p.action_id || canais.some((c) => c.status !== 'aguardando')) {
      throw new AppProblem(
        409,
        'post-nao-agendado',
        'O post não espera a hora',
        'Só muda a hora o post aprovado que ainda espera a hora de sair. O que espera a aprovação se recusa e se faz de novo; o que já saiu, saiu.',
      );
    }
    const hora = new Date(body.publish_at);
    const fuso = await fusoDaEmpresa(tx, quem.tenantId);
    const recusaDaHora = conferirAHora(hora, agora, fuso);
    if (recusaDaHora) throw recusaDaHora;
    const antes = new Date(p.publish_at);
    if (hora.getTime() === antes.getTime()) throw recusa('mesma-hora', 'A mesma hora', 'O post já está marcado para essa hora.', 'publish_at');
    const primeiro = canais[0]!;
    if (!primeiro.connected_account_id) {
      throw recusa('canal-nao-conectado', 'Canal não conectado', `A conta ${DO_CANAL[primeiro.channel]} deste post não está mais ligada à marca: conecte de novo em Contas conectadas.`, 'channels');
    }
    // O pedido aprovado sai de cena com a hora nova no motivo; o post muda de hora e de versão; o pedido novo nasce e é
    // aprovado com o código de quem muda, pela conta do primeiro canal (D-A6-32), como no "Novo post".
    await this.actions.cancel(auth, p.action_id, `hora mudada para ${diaEHora(hora, fuso)}`);
    await tx.execute(sql`
      update liame.social_post set publish_at = ${hora.toISOString()}, version = version + 1, updated_at = now()
       where id = ${id} and tenant_id = ${quem.tenantId}`);
    const novo = await this.actions.create(auth, {
      tool: 'post_publicar',
      brand_id: p.brand_id,
      provider: PROVEDOR_DO_CANAL[primeiro.channel as CanalDoPost],
      account_id: primeiro.connected_account_id,
      resource_id: recursoDoPost(id),
      params: {},
    });
    const aprovado = await this.actions.approve(auth, novo.id, { plan_hash: novo.plan_hash, code: body.code });
    await tx.execute(sql`update liame.social_post set action_id = ${novo.id}, updated_at = now() where id = ${id} and tenant_id = ${quem.tenantId}`);
    auditDetail({
      resourceId: id,
      before: { publish_at: antes.toISOString(), action_id: p.action_id },
      after: { brand_id: p.brand_id, publish_at: hora.toISOString(), action_id: novo.id, plan_hash: novo.plan_hash, aprovado: aprovado.status === 'aprovada' },
    });
    return this.obter(auth, id);
  }

  /**
   * "Apagar das redes" (A6, Z5d, parte 6; P19; D-A6-57): o post do Liame que está no ar em algum canal sai de cada um, com
   * o código do app de quem apaga. O post fica travado; nada dele pode estar saindo agora (o pedido de publicar ou a nova
   * tentativa ainda executando, um canal publicando), nem já saindo das redes. O pedido `post_apagar` (a volta do pedido
   * que publicou) nasce e é aprovado com o código na mesma transação: o código errado desfaz tudo. Executa em seguida, no
   * worker; a Agenda mostra o andamento em `removal`.
   */
  async apagarDasRedes(auth: AuthContext, id: string, body: UnpublishPostRequest): Promise<PostResponse> {
    const tx = currentTx();
    const quem = this.quem(auth);
    const p = (
      await tx.execute<{ brand_id: string; kind: string; action_id: string | null; version: number; pedido: string | null }>(sql`
        select p.brand_id, p.kind, p.action_id, p.version, r.status as pedido
          from liame.social_post p
          left join liame.action_request r on r.id = p.action_id and r.tenant_id = p.tenant_id
         where p.id = ${id} and p.tenant_id = ${quem.tenantId}
           for update of p`)
    ).rows[0];
    if (!p) throw new AppProblem(404, 'post-nao-encontrado', 'Não encontramos', 'Este post não está mais aqui.');
    if (p.kind !== 'post') throw new AppProblem(409, 'e-pacote', 'É um pacote', 'O pacote o Liame não publicou: quem publicou apaga direto na rede.');
    if (!(await this.ligada(quem, p.brand_id))) throw desligada();
    const canais = (
      await tx.execute<{ channel: string; connected_account_id: string | null; status: string }>(sql`
        select channel, connected_account_id, status from liame.social_post_channel
         where post_id = ${id} and tenant_id = ${quem.tenantId}
         order by case channel when 'instagram' then 0 else 1 end
           for update`)
    ).rows;
    const noAr = canais.filter((c) => c.status === 'publicado');
    if (!p.action_id || noAr.length === 0) {
      throw new AppProblem(409, 'post-fora-do-ar', 'O post não está no ar', 'Apagar das redes vale para o post que o Liame publicou: este post não está no ar em nenhum canal.');
    }
    if ((p.pedido && PEDIDO_AINDA_SAI.includes(p.pedido)) || canais.some((c) => c.status === 'publicando')) {
      throw new AppProblem(409, 'post-saindo', 'O post ainda está saindo', 'O post ainda está saindo num canal: espere terminar para apagar.');
    }
    const jaApagando = await tx.execute<{ id: string }>(sql`
      select id from liame.action_request
       where tenant_id = ${quem.tenantId} and tool = 'post_apagar' and resource_id = ${recursoDoPost(id)}
         and status in ('aguardando_aprovacao', 'aprovada', 'executando')
       limit 1`);
    if (jaApagando.rows[0]) throw new AppProblem(409, 'post-saindo-das-redes', 'Já está saindo das redes', 'O pedido de apagar este post já foi aprovado e executa agora.');
    // A conta do primeiro canal no ar é a do pedido (D-A6-32); a do outro canal, o conector confere na execução.
    const primeiro = noAr[0]!;
    if (!primeiro.connected_account_id) {
      throw new AppProblem(
        409,
        'canal-nao-conectado',
        'Canal não conectado',
        `A conta ${DO_CANAL[primeiro.channel]} deste post não está mais ligada à marca: conecte de novo em Contas conectadas, ou apague direto na rede.`,
      );
    }
    const pedido = await this.actions.pedirVolta(
      auth,
      {
        tool: 'post_apagar',
        brand_id: p.brand_id,
        provider: PROVEDOR_DO_CANAL[primeiro.channel as CanalDoPost],
        account_id: primeiro.connected_account_id,
        resource_id: recursoDoPost(id),
        params: {},
      },
      { de: p.action_id, versaoDepois: p.version },
    );
    const aprovado = await this.actions.approve(auth, pedido.id, { plan_hash: pedido.plan_hash, code: body.code });
    auditDetail({
      resourceId: id,
      before: { canais_no_ar: noAr.map((c) => c.channel) },
      after: { brand_id: p.brand_id, action_id: pedido.id, plan_hash: pedido.plan_hash, aprovado: aprovado.status === 'aprovada' },
    });
    return this.obter(auth, id);
  }

  /**
   * A foto do pacote para baixar (P22, o passo "Baixe a foto"; D-A6-43): o endereço assinado da cópia que o Liame guarda
   * (JPEG, sem os dados do celular), que baixa como arquivo e vale 5 minutos. Só o pacote da empresa, pronto ou
   * publicado; a foto que saiu das Fotos (ou mudou) não volta.
   */
  async fotoDoPacote(auth: AuthContext, id: string, agora: Date = new Date()): Promise<PostPhotoResponse> {
    const quem = this.quem(auth);
    const p = await this.pacoteDaEmpresa(quem, id, false);
    if (!p.situacoes.some((s) => s === 'pronto' || s === 'publicado')) {
      throw new AppProblem(409, 'pacote-tirado', 'O pacote saiu da Agenda', 'Este pacote foi tirado da Agenda: monte outro no "Novo post".');
    }
    const fuso = await fusoDaEmpresa(currentTx(), quem.tenantId);
    const f = (
      await currentTx().execute<{ chave: string; dia: string }>(sql`
        select f.object_key as chave, to_char(p.publish_at at time zone ${fuso}, 'YYYY-MM-DD') as dia
          from liame.social_post p
          join liame.brand_photo f on f.id = p.photo_id and f.tenant_id = p.tenant_id
         where p.id = ${id} and p.tenant_id = ${quem.tenantId}
           and f.status = 'pronta' and f.removed_at is null and f.sha256 = p.photo_sha256`)
    ).rows[0];
    if (!f) throw new AppProblem(409, 'foto-apagada', 'A foto saiu das Fotos', 'A foto deste pacote foi apagada nas Fotos: monte outro pacote com outra foto.');
    const nome = `liame-${p.canais[0] ?? 'pacote'}-${f.dia}.jpg`;
    try {
      const url = await this.armazem.enderecoDeLeitura(f.chave, VALIDADE_DA_FOTO_DO_PACOTE_S, nome);
      return { url, filename: nome, expires_at: new Date(agora.getTime() + VALIDADE_DA_FOTO_DO_PACOTE_S * 1000).toISOString() };
    } catch (e) {
      if (e instanceof ArmazemIndisponivel || e instanceof FalhaDoArmazem) {
        throw new AppProblem(503, 'fotos-indisponiveis', 'Fotos indisponíveis', 'Não deu para preparar a foto agora. Tente de novo em instantes.');
      }
      throw e;
    }
  }

  /** O pacote da empresa, travado até o fim da transação (o "Publiquei" e o "Tirar" ao mesmo tempo não se atropelam). */
  private pacoteTravado(quem: Quem, id: string): Promise<{ brand_id: string; situacoes: string[]; canais: string[] }> {
    return this.pacoteDaEmpresa(quem, id, true);
  }

  /** O pacote da empresa, com a situação de cada canal (`travar`: até o fim da transação). */
  private async pacoteDaEmpresa(quem: Quem, id: string, travar: boolean): Promise<{ brand_id: string; situacoes: string[]; canais: string[] }> {
    const tx = currentTx();
    const p = (
      await tx.execute<{ brand_id: string; kind: string }>(sql`
        select brand_id, kind from liame.social_post where id = ${id} and tenant_id = ${quem.tenantId} ${travar ? sql`for update` : sql``}`)
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
    if (!(await this.ligada(quem, q.brand_id))) return { enabled: false, timezone: fuso, channels: [], items: [], post_link: { ok: false, reason: null }, pauta: [], dates: [] };
    const items = await this.ler(
      quem.tenantId,
      sql`p.brand_id = ${q.brand_id}
          and p.publish_at >= (${q.from}::date)::timestamp at time zone ${fuso}
          and p.publish_at < ((${q.to}::date + 1)::timestamp at time zone ${fuso})`,
    );
    // Se o post novo ganha o link do post (D-A6-46): o novo post diz, na Página e no pacote.
    const destino = await destinoDoPost(currentTx(), quem.tenantId, q.brand_id);
    return {
      enabled: true,
      timezone: fuso,
      channels: await this.contasDosCanais(quem.tenantId, q.brand_id),
      items,
      post_link: destino.ok ? { ok: true, reason: null } : { ok: false, reason: destino.motivo },
      // A pauta e as datas comerciais em cada dia (A6, Z5d, parte 5; D-A6-20 e D-A6-56).
      pauta: auth.permissions.has('planos.ver') ? await this.pautaDoPeriodo(quem.tenantId, q) : [],
      dates: await this.datasDoPeriodo(q),
    };
  }

  /**
   * A pauta da semana no período (D-A6-20 e D-A6-56): o item de cada dia, do plano de pauta aprovado mais novo da marca
   * que cobre o dia (a versão atual dele). Os dias de fora do período e os planos que esperam, recusados ou vencidos não
   * entram.
   */
  private async pautaDoPeriodo(tenantId: string, q: PostListQuery): Promise<PostListResponse['pauta']> {
    const r = await itensDaPauta(currentTx(), tenantId, q.brand_id, q.from, q.to);
    return r.map((l) => ({ day: l.day, item: l.item, plan_id: l.plan_id }));
  }

  /** As datas do calendário comercial do Liame no período (feriados nacionais e datas do varejo; D-A6-20). */
  private async datasDoPeriodo(q: PostListQuery): Promise<PostListResponse['dates']> {
    const r = await currentTx().execute<{ day: string; name: string; kind: string }>(sql`
      select to_char(day, 'YYYY-MM-DD') as day, name, kind from liame.commercial_date
       where day between ${q.from}::date and ${q.to}::date
       order by day, kind, name`);
    return r.rows;
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
