import { type Database, type Tx, withSystem } from '@liame/database';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { AiError, AiGateway } from '../ai/gateway.js';
import { naTransacaoDaEmpresa } from '../ai/na-empresa.js';
import { registrarRecusa } from '../ai/recusas.js';
import { type BaseDoPost, postDaResposta, RespostaDoPost } from '../ai/social/post.js';
import { baseDoPedidoDePost, contextoDoPost, FOTOS_NO_PEDIDO, mensagemDoPost, type PedidoDePostDoSocial, refDaFoto } from '../ai/social/post-contexto.js';
import { PROMPT_SOCIAL_POST, SOCIAL, TAREFA_SOCIAL_POST, WORKFLOW_DO_SOCIAL_POST } from '../ai/social/prompt.js';
import { activeTraceId, writeAudit } from '../audit/audit.js';
import { codigoDoMotivo, esperaDaIa, minutosAteATentativa } from '../avaliacoes/sugestoes.js';
import { diaNoFuso, somarDias } from '../cobranca/vida.js';
import { contaConectada } from '../connections/conectada.js';
import { currentTx } from '../context/request-context.js';
import { marcaDoCriativo } from '../criativo/base.js';
import { DATABASE } from '../database/database.module.js';
import { AppProblem } from '../errors/problems.js';
import { FlagService } from '../flags/flag.service.js';
import { destinoDoPost } from '../posts/link-do-post.js';
import { fusoDaEmpresa } from '../posts/ler-posts.js';
import { ehNadaNovo, itensDaPauta } from '../posts/pauta.js';
import { type CanalDoPost, CANAIS_DO_POST, PROVEDOR_DO_CANAL } from '../posts/post-plano.js';
import { PostsService } from '../posts/posts.service.js';
import {
  abrirVezDoPost,
  achadosQueBarraramOPost,
  adiarVezDoPost,
  barrarVezDoPost,
  DIAS_A_FRENTE,
  type DonoDaVezDoPost,
  encerrarVezDoPost,
  esperarVezDoPost,
  HORA_DO_POST,
  itensQueBarraramOPost,
  lerVezDoPost,
  MINUTOS_DE_ESPERA_DO_POST,
  marcarVezPronta,
  oQueDesligaOsPosts,
  RECORTE_NO_CENTRO,
  TENTATIVAS_DOS_POSTS,
} from '../posts/sugestoes-de-post.js';
import { REGRAS_DE_TEXTO_VERSAO } from '../policy/texto.js';

// A rotina dos posts do Social media (A6, Z6, os posts, parte 2; `plano-a6.md` D-A6-58 a D-A6-60; protótipo P21). Fica
// na pasta do worker: quem chama é o laço. Duas partes:
//   - abrir as vezes: de hora em hora, para cada marca com pauta aprovada e com a função ligada, os dias de amanhã e de
//     depois de amanhã (no fuso da empresa) que têm item na pauta e ainda não têm post nem vez;
//   - a vez de cada dia, em três tempos, para não segurar uma transação enquanto o modelo responde: 1) banco (transação
//     curta da empresa): a vez, a pauta do dia, os canais, as Fotos, o link, o dono e Minha marca; 2) o modelo, pelo
//     gateway (sem transação): o gateway confere a flag `ia`, a rota, o teto e limpa o dado pessoal; 3) banco (transação
//     da empresa): o post na Agenda e o pedido em Aprovações (pelo mesmo caminho do "Novo post", com o pedido feito pelo
//     funcionário em nome do dono) e a vez que acaba ligada a eles, juntos; ou a vez barrada, com a auditoria.
// Nada é publicado daqui: o post só sai com a aprovação de uma pessoa, com o código do app.

const MINUTO_MS = 60_000;

/**
 * O que a vez fez com o dia. `pronta`: o post está na Agenda e o pedido, em Aprovações. `barrada`: a conferência barrou o
 * que ele escreveu. `descartada`: o dia não vai ter post dele. `falhou`: não deu desta vez; `deVez` diz se as tentativas
 * acabaram. `esperando`: não é a vez dele agora, sem contar tentativa. `fora`: o dia não está mais esperando.
 */
export type VezDoPost =
  | { status: 'pronta'; post: string; pedido: string }
  | { status: 'barrada'; itens: string[] }
  | { status: 'descartada'; motivo: string }
  | { status: 'falhou'; motivo: string; deVez: boolean }
  | { status: 'esperando'; motivo: string }
  | { status: 'fora' };

type Lido = {
  brandId: string;
  dono: string;
  /** O instante da hora do post (19h do dia, no fuso da empresa). */
  publicarEm: string;
  pedido: PedidoDePostDoSocial;
  base: BaseDoPost;
  /** A referência de cada foto que foi ao modelo, e o id dela nas Fotos. */
  fotoDa: Map<string, string>;
};

/** A vez acabou enquanto o post era montado (outra volta da rotina a tratou): o post não pode ficar. */
class ForaDaFila extends Error {}

/** "sexta-feira, 30/10/2026": o dia com o dia da semana, como vai ao modelo. */
export function diaParaOModelo(dia: string): string {
  const semana = new Intl.DateTimeFormat('pt-BR', { timeZone: 'UTC', weekday: 'long' }).format(new Date(`${dia}T12:00:00Z`));
  return `${semana}, ${dia.slice(8, 10)}/${dia.slice(5, 7)}/${dia.slice(0, 4)}`;
}

@Injectable()
export class PostsSugeridosService {
  private readonly logger = new Logger('posts-sugeridos');

  constructor(
    @Inject(DATABASE) private readonly database: Database | null,
    private readonly flags: FlagService,
    private readonly gateway: AiGateway,
    private readonly posts: PostsService,
  ) {}

  // ---------------------------------------------------------------- abrir as vezes

  /**
   * Abre a vez dos dias que o Social media vai propor (D-A6-60): para cada marca viva com uma pauta aprovada e com os
   * posts dele ligados, amanhã e depois de amanhã no fuso da empresa, o dia que tem item na pauta (o "nada novo" fica de
   * fora), não tem post (de ninguém) e ainda não teve a vez. Com a função desligada, nada abre. Devolve quantas abriram.
   */
  async abrirVezes(marcasPorPagina = 200, agora = new Date()): Promise<number> {
    const database = this.banco();
    // Só as marcas com item na pauta aprovada perto dos dias que abrem (um dia de folga para cada lado cobre qualquer
    // fuso); o dia exato, no fuso da empresa, quem confere é `abrirDaMarca`. Em páginas, continuando de onde a anterior
    // parou, até acabar: com um `limit` só, as mesmas primeiras marcas seriam escolhidas toda hora, e as outras nunca.
    const de = somarDias(diaNoFuso(agora, 'UTC'), DIAS_A_FRENTE[0]! - 1);
    const ate = somarDias(diaNoFuso(agora, 'UTC'), DIAS_A_FRENTE[DIAS_A_FRENTE.length - 1]! + 1);
    type Marca = { tenant_id: string; brand_id: string };
    let depoisDe: Marca | null = null;
    let abertas = 0;
    for (;;) {
      const cursor: Marca | null = depoisDe;
      const marcas: Marca[] = await withSystem(database.db, async (tx): Promise<Marca[]> =>
        (
          await tx.execute<Marca>(sql`
            select b.tenant_id, b.id as brand_id
              from liame.brand b
             where b.archived_at is null
               ${cursor ? sql`and (b.tenant_id, b.id) > (${cursor.tenant_id}::uuid, ${cursor.brand_id}::uuid)` : sql``}
               and exists (
                 select 1 from liame.plan p
                   join liame.plan_version v on v.plan_id = p.id and v.version = p.version and v.tenant_id = p.tenant_id
                   cross join lateral jsonb_to_recordset(case when jsonb_typeof(v.content->'days') = 'array' then v.content->'days' else '[]'::jsonb end) as d(day date, item text)
                  where p.tenant_id = b.tenant_id and p.brand_id = b.id and p.kind = 'pauta' and p.status = 'aprovado'
                    and d.day between ${de}::date and ${ate}::date)
             order by b.tenant_id, b.id
             limit ${marcasPorPagina}`)
        ).rows,
      );
      for (const m of marcas) {
        try {
          abertas += await naTransacaoDaEmpresa(database, { tenantId: m.tenant_id, userId: null }, () => this.abrirDaMarca({ tenantId: m.tenant_id, brandId: m.brand_id }, agora));
        } catch (err) {
          // Uma marca que falha não segura as outras; a próxima volta tenta de novo.
          this.logger.error(`posts do Social media: abrir as vezes da marca ${m.brand_id}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
        }
      }
      if (marcas.length < marcasPorPagina) return abertas;
      depoisDe = marcas[marcas.length - 1]!;
    }
  }

  private async abrirDaMarca(alvo: { tenantId: string; brandId: string }, agora: Date): Promise<number> {
    const tx = currentTx();
    if (await oQueDesligaOsPosts(tx, this.flags, alvo)) return 0;
    const fuso = await fusoDaEmpresa(tx, alvo.tenantId);
    const hoje = diaNoFuso(agora, fuso);
    const dias = DIAS_A_FRENTE.map((n) => somarDias(hoje, n));
    const itens = await itensDaPauta(tx, alvo.tenantId, alvo.brandId, dias[0]!, dias[dias.length - 1]!);
    let abertas = 0;
    for (const i of itens) {
      if (ehNadaNovo(i.item) || (await this.diaTemPost(tx, alvo, i.day, fuso))) continue;
      if (await abrirVezDoPost(tx, { ...alvo, planId: i.plan_id, day: i.day }, agora)) abertas += 1;
    }
    return abertas;
  }

  /** O dia já tem post da marca na Agenda (de uma pessoa, um pacote ou dele mesmo), em qualquer situação. */
  private async diaTemPost(tx: Tx, alvo: { tenantId: string; brandId: string }, dia: string, fuso: string): Promise<boolean> {
    const r = await tx.execute<{ tem: boolean }>(sql`
      select exists (
        select 1 from liame.social_post p
         where p.tenant_id = ${alvo.tenantId} and p.brand_id = ${alvo.brandId}
           and p.publish_at >= (${dia}::date)::timestamp at time zone ${fuso}
           and p.publish_at < ((${dia}::date + 1)::timestamp at time zone ${fuso})) as tem`);
    return r.rows[0]?.tem === true;
  }

  // ---------------------------------------------------------------- a vez de cada dia

  /** Trata o dia na vez dele. O relógio injetado vale para a operação inteira (V34). */
  async propor(alvo: DonoDaVezDoPost, agora = new Date()): Promise<VezDoPost> {
    const database = this.banco();
    const quem = { tenantId: alvo.tenantId, userId: null };

    // ---- 1. O banco: a vez, a pauta do dia e tudo de que o pedido ao modelo parte.
    const lido = await naTransacaoDaEmpresa<Lido | VezDoPost>(database, quem, () => this.ler(alvo, agora));
    if ('status' in lido) return lido;

    // ---- 2. O Social media: sem ferramenta; o item da pauta vai na mensagem, entre marcas.
    let r: Awaited<ReturnType<AiGateway['structured']>>;
    try {
      r = await this.gateway.structured({
        tenantId: alvo.tenantId,
        brandId: lido.brandId,
        // Ninguém pediu este post agora: é rotina do sistema, e não entra no limite por pessoa.
        userId: null,
        workflow: WORKFLOW_DO_SOCIAL_POST,
        task: TAREFA_SOCIAL_POST,
        promptVersion: `${PROMPT_SOCIAL_POST.key}@${PROMPT_SOCIAL_POST.version}`,
        instructions: PROMPT_SOCIAL_POST.content,
        context: contextoDoPost(lido.pedido),
        messages: [{ role: 'user', content: mensagemDoPost(lido.pedido) }],
        schema: RespostaDoPost,
      });
    } catch (err) {
      if (!(err instanceof AiError)) throw err;
      if (err.code === 'entrada-grande') return this.naEmpresa(alvo, (tx) => this.descartar(tx, alvo, 'grande_demais', agora));
      if (err.code === 'indisponivel') return this.falhou(alvo, 'ia_fora_do_ar', agora);
      // A IA desligada, parada, sem rota ou no limite: não é falha do dia. Ele espera, sem contar tentativa.
      const ate = err.detalhe.voltaEm ?? new Date(agora.getTime() + MINUTOS_DE_ESPERA_DO_POST * MINUTO_MS);
      return this.naEmpresa(alvo, (tx) => this.esperar(tx, alvo, esperaDaIa(err.code, err.detalhe.teto), ate, agora));
    }
    const resposta = RespostaDoPost.safeParse(r.object);
    if (!resposta.success) return this.falhou(alvo, 'formato', agora);

    const resultado = postDaResposta(resposta.data, lido.base);
    if (!resultado.ok) {
      // Nenhuma foto combina com o item: o dia fica sem post dele (o porquê dele fica só no log, sem o texto do item).
      if (resultado.descarte === 'sem_foto') {
        this.logger.log(`post ${alvo.id}: nenhuma foto combina com o item do dia (uso ${r.usageId})`);
        return this.naEmpresa(alvo, (tx) => this.descartar(tx, alvo, 'sem_foto', agora, r.usageId));
      }
      // O resto não chegou à conferência (a foto fora da lista, o canal que falta, o texto vazio, longo ou com dado
      // pessoal): conta em Sua equipe, sem o texto, e o dia tenta de novo.
      const doCompliance = resultado.descarte === 'dado_pessoal';
      await registrarRecusa(database, {
        tenantId: alvo.tenantId,
        brandId: lido.brandId,
        userId: null,
        usageId: r.usageId,
        member: SOCIAL.key,
        workflow: WORKFLOW_DO_SOCIAL_POST,
        kind: doCompliance ? 'compliance' : resultado.descarte,
        rules: doCompliance ? ['dado_pessoal'] : [],
        rulesVersion: doCompliance ? REGRAS_DE_TEXTO_VERSAO : null,
      });
      return this.falhou(alvo, resultado.descarte, agora);
    }
    const post = resultado.post;
    if (post.situacao === 'barrou') {
      // A conferência barrou o que ele escreveu: a vez acaba barrada, e o dia fica para a pessoa fazer o post à mão.
      const itens = itensQueBarraramOPost(post);
      return this.naEmpresa(alvo, async (tx) => {
        if (!(await barrarVezDoPost(tx, alvo, itens, r.usageId, agora))) return { status: 'fora' };
        // Na trilha, os nomes dos itens e dos achados; nunca o trecho nem o texto barrado.
        await this.auditar(tx, alvo, 'post.barrar_proposta', { barred_by: itens, findings: achadosQueBarraramOPost(post), usage_id: r.usageId });
        return { status: 'barrada', itens };
      });
    }

    // ---- 3. O post na Agenda, o pedido em Aprovações e a vez que acaba, juntos: se um falhar, nenhum fica.
    const funcionario = { tenantId: alvo.tenantId, agentKey: SOCIAL.key, agentLabel: SOCIAL.name, emNomeDe: lido.dono };
    try {
      return await naTransacaoDaEmpresa<VezDoPost>(database, quem, async () => {
        const tx = currentTx();
        const s = await lerVezDoPost(tx, alvo);
        if (!s || s.status !== 'esperando') return { status: 'fora' };
        // Uma pessoa marcou um post para o dia enquanto ele escrevia: o dia é dela.
        if (await this.diaTemPost(tx, { tenantId: alvo.tenantId, brandId: lido.brandId }, s.day, await fusoDaEmpresa(tx, alvo.tenantId))) {
          return this.descartar(tx, alvo, 'dia_com_post', agora, r.usageId);
        }
        const feito = await this.posts.criarPeloFuncionario(
          funcionario,
          {
            brand_id: lido.brandId,
            photo_id: lido.fotoDa.get(post.foto)!,
            publish_at: lido.publicarEm,
            crop_pos: RECORTE_NO_CENTRO,
            channels: post.textos.map((t) => ({ channel: t.canal, text: t.texto })),
          },
          agora,
        );
        if (!(await marcarVezPronta(tx, alvo, { post: feito.post, pedido: feito.pedido, usageId: r.usageId }, agora))) throw new ForaDaFila();
        // Só números e códigos: o texto do post fica no post, não na trilha.
        await this.auditar(tx, alvo, 'post.propor', {
          post_id: feito.post,
          action_id: feito.pedido,
          canais: post.textos.map((t) => t.canal),
          avisos: [...new Set(post.textos.flatMap((t) => t.conferencia.itens.filter((i) => i.situacao === 'aviso').map((i) => i.item)))],
          usage_id: r.usageId,
          link_do_post: feito.auditoria.link_do_post ?? null,
        });
        return { status: 'pronta', post: feito.post, pedido: feito.pedido };
      });
    } catch (err) {
      if (err instanceof ForaDaFila) return { status: 'fora' };
      if (!(err instanceof AppProblem)) throw err;
      return this.postRecusado(alvo, err, r.usageId, agora);
    }
  }

  /**
   * Uma tentativa que não deu certo: conta, e o dia tenta de novo mais tarde (15, 30 minutos…); na última, fecha como
   * `falhou`, com a auditoria. É também por onde o laço registra a falha fora do previsto.
   */
  async falhou(alvo: DonoDaVezDoPost, motivo: string, agora = new Date()): Promise<VezDoPost> {
    const codigo = codigoDoMotivo(motivo);
    return this.naEmpresa(alvo, async (tx) => {
      const s = await lerVezDoPost(tx, alvo);
      if (!s || s.status !== 'esperando') return { status: 'fora' };
      if (s.attempts + 1 >= TENTATIVAS_DOS_POSTS) {
        if (!(await encerrarVezDoPost(tx, alvo, 'falhou', codigo, agora, { contarTentativa: true }))) return { status: 'fora' };
        await this.auditar(tx, alvo, 'post.falhar_proposta', { reason: codigo, attempts: s.attempts + 1 });
        return { status: 'falhou', motivo: codigo, deVez: true };
      }
      const ate = new Date(agora.getTime() + minutosAteATentativa(s.attempts) * MINUTO_MS);
      if (!(await adiarVezDoPost(tx, alvo, codigo, ate, agora))) return { status: 'fora' };
      return { status: 'falhou', motivo: codigo, deVez: false };
    });
  }

  /** O primeiro tempo. Devolve o que a vez já decidiu (e gravou), ou o pedido que vai ao Social media. */
  private async ler(alvo: DonoDaVezDoPost, agora: Date): Promise<Lido | VezDoPost> {
    const tx = currentTx();
    const s = await lerVezDoPost(tx, alvo);
    if (!s || s.status !== 'esperando') return { status: 'fora' };
    const marcaViva = (await tx.execute<{ viva: boolean }>(sql`select archived_at is null as viva from liame.brand where id = ${s.brand_id} and tenant_id = ${alvo.tenantId}`)).rows[0];
    if (!marcaViva?.viva) return this.descartar(tx, alvo, 'marca_arquivada', agora);
    const fuso = await fusoDaEmpresa(tx, alvo.tenantId);
    // O dia chegou (ou passou) sem a vez: tarde demais para propor e para alguém aprovar com calma.
    if (s.day <= diaNoFuso(agora, fuso)) return this.descartar(tx, alvo, 'dia_passou', agora);
    const marca = { tenantId: alvo.tenantId, brandId: s.brand_id };
    if (await this.diaTemPost(tx, marca, s.day, fuso)) return this.descartar(tx, alvo, 'dia_com_post', agora);
    // A pauta do dia, como está agora: a aprovada mais nova pode ter mudado o item, ou não ter mais o dia.
    const item = (await itensDaPauta(tx, alvo.tenantId, s.brand_id, s.day, s.day))[0];
    if (!item) return this.descartar(tx, alvo, 'pauta_mudou', agora);
    if (ehNadaNovo(item.item)) return this.descartar(tx, alvo, 'nada_novo', agora);

    const emUmaHora = new Date(agora.getTime() + MINUTOS_DE_ESPERA_DO_POST * MINUTO_MS);
    const desligado = await oQueDesligaOsPosts(tx, this.flags, marca);
    if (desligado) return this.esperar(tx, alvo, desligado, emUmaHora, agora);

    // Os canais: os do Liame com uma conta só conectada à marca (com duas, o "Novo post" também recusa).
    const contas = await tx.execute<{ provider: string; n: number }>(sql`
      select a.provider, count(*)::int as n from liame.connected_account a
       where a.tenant_id = ${alvo.tenantId} and a.brand_id = ${s.brand_id} and ${contaConectada('a')}
         and a.provider in ${CANAIS_DO_POST.map((c) => PROVEDOR_DO_CANAL[c])}
       group by a.provider`);
    const canais: CanalDoPost[] = CANAIS_DO_POST.filter((c) => contas.rows.some((l) => l.provider === PROVEDOR_DO_CANAL[c] && l.n === 1));
    if (!canais.length) return this.esperar(tx, alvo, 'sem_canal', emUmaHora, agora);

    // As Fotos prontas da marca, as mais novas primeiro: de cada uma, só o produto e a descrição vão ao modelo.
    const fotos = (
      await tx.execute<{ id: string; product: string | null; description: string }>(sql`
        select id, product, description from liame.brand_photo
         where tenant_id = ${alvo.tenantId} and brand_id = ${s.brand_id} and status = 'pronta' and removed_at is null
         order by created_at desc, id desc
         limit ${FOTOS_NO_PEDIDO}`)
    ).rows;
    if (!fotos.length) return this.esperar(tx, alvo, 'sem_fotos', emUmaHora, agora);

    // Quem responde pelo que o funcionário propõe em público é o dono da empresa (um por empresa: `uq_membership_dono`).
    const dono = (await tx.execute<{ user_id: string }>(sql`select user_id from liame.membership where tenant_id = ${alvo.tenantId} and role_key = 'dono' and revoked_at is null`)).rows[0];
    if (!dono) return this.descartar(tx, alvo, 'sem_dono', agora);
    // Minha marca: o nome, o dossiê (o tom de voz, o que pode provar, o que nunca diz) e os fatos para a conferência.
    const daMarca = await marcaDoCriativo(s.brand_id, fuso, agora);
    if (!daMarca) return this.descartar(tx, alvo, 'sem_dossie', agora);
    const destino = await destinoDoPost(tx, alvo.tenantId, s.brand_id);
    const publicarEm = (
      await tx.execute<{ em: string }>(sql`select to_char((((${s.day}::date + ${HORA_DO_POST}::time)::timestamp at time zone ${fuso}) at time zone 'UTC'), 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as em`)
    ).rows[0]!.em;

    const fotoDa = new Map<string, string>();
    const pedido: PedidoDePostDoSocial = {
      marca: daMarca.nome,
      dossie: daMarca.dossie,
      dia: diaParaOModelo(s.day),
      item: item.item,
      canais,
      link: destino.ok,
      fotos: fotos.map((f, i) => {
        fotoDa.set(refDaFoto(i), f.id);
        return { ref: refDaFoto(i), produto: f.product, descricao: f.description.trim() || null };
      }),
    };
    return { brandId: s.brand_id, dono: dono.user_id, publicarEm, pedido, base: baseDoPedidoDePost(pedido, daMarca), fotoDa };
  }

  /**
   * O "Novo post" ou o trilho recusaram o post (o texto já está escrito, e o gasto de IA, feito). O que não muda tentando
   * de novo acaba aqui; o que passa sozinho (a escrita desligada no meio, a trava) espera. O motivo fica no log, sem o
   * texto do post.
   */
  private async postRecusado(alvo: DonoDaVezDoPost, err: AppProblem, usageId: string, agora: Date): Promise<VezDoPost> {
    this.logger.warn(`post ${alvo.id}: o post do Social media não foi montado (${err.code}): ${err.detail}`);
    const emUmaHora = new Date(agora.getTime() + MINUTOS_DE_ESPERA_DO_POST * MINUTO_MS);
    switch (err.code) {
      // A política da empresa ou da marca não deixa o texto, ou não deixa o funcionário pedir.
      case 'politica-negou':
        return this.naEmpresa(alvo, async (tx) => {
          if (!(await barrarVezDoPost(tx, alvo, ['politica_da_empresa'], usageId, agora))) return { status: 'fora' };
          await this.auditar(tx, alvo, 'post.barrar_proposta', { barred_by: ['politica_da_empresa'], usage_id: usageId });
          return { status: 'barrada', itens: ['politica_da_empresa'] };
        });
      case 'modo-nao-e-aprovacao':
      case 'plano-recusado':
        return this.naEmpresa(alvo, (tx) => this.descartar(tx, alvo, codigoDoMotivo(err.code), agora, usageId));
      // A foto saiu das Fotos, uma conta saiu da marca, ou a marca ganhou outra conta no meio: tenta de novo, com a lista nova.
      case 'foto-fora-da-marca':
      case 'canal-nao-conectado':
      case 'canal-com-duas-contas':
      case 'texto-longo-demais':
        return this.falhou(alvo, err.code, agora);
      case 'funcao-desligada':
      case 'escrita-desligada':
        return this.naEmpresa(alvo, (tx) => this.esperar(tx, alvo, 'posts_desligados', emUmaHora, agora));
      case 'parada-acionada':
        return this.naEmpresa(alvo, (tx) => this.esperar(tx, alvo, 'parada', emUmaHora, agora));
      default:
        return this.falhou(alvo, err.code, agora);
    }
  }

  /** O dia não vai ter post dele: a vez acaba descartada, com o porquê em código e a auditoria. */
  private async descartar(tx: Tx, alvo: DonoDaVezDoPost, motivo: string, agora: Date, usageId: string | null = null): Promise<VezDoPost> {
    if (!(await encerrarVezDoPost(tx, alvo, 'descartada', motivo, agora, { usageId }))) return { status: 'fora' };
    await this.auditar(tx, alvo, 'post.descartar_proposta', { reason: motivo, usage_id: usageId });
    return { status: 'descartada', motivo };
  }

  /** Não é a vez dele agora: olha de novo depois, sem contar tentativa. */
  private async esperar(tx: Tx, alvo: DonoDaVezDoPost, motivo: string, ate: Date, agora: Date): Promise<VezDoPost> {
    if (!(await esperarVezDoPost(tx, alvo, motivo, ate, agora))) return { status: 'fora' };
    return { status: 'esperando', motivo };
  }

  private auditar(tx: Tx, alvo: DonoDaVezDoPost, acao: string, depois: Record<string, unknown>): Promise<string> {
    return writeAudit(tx, {
      tenantId: alvo.tenantId,
      actorType: 'agent',
      actorId: null,
      actorLabel: SOCIAL.name,
      action: acao,
      resourceType: 'post_suggestion',
      resourceId: alvo.id,
      after: { ...depois, agent_key: SOCIAL.key },
      traceId: activeTraceId(),
      origin: 'worker',
      agent: SOCIAL.key,
    });
  }

  private naEmpresa(alvo: DonoDaVezDoPost, fn: (tx: Tx) => Promise<VezDoPost>): Promise<VezDoPost> {
    return naTransacaoDaEmpresa<VezDoPost>(this.banco(), { tenantId: alvo.tenantId, userId: null }, () => fn(currentTx()));
  }

  private banco(): Database {
    if (!this.database) throw new Error('posts do Social media: sem banco');
    return this.database;
  }
}
