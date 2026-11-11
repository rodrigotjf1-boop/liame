import type { Database, Tx } from '@liame/database';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { ActionService } from '../actions/action.service.js';
import { recursoDoComentario } from '../actions/comentario-na-rede.js';
import { EstadoDoComentario, ParametrosDaRespostaAoComentario, resumoDoComentario } from '../actions/comentario-plano.js';
import { AiError, AiGateway } from '../ai/gateway.js';
import { naTransacaoDaEmpresa } from '../ai/na-empresa.js';
import { registrarRecusa } from '../ai/recusas.js';
import { respostaPronta, sugestoesDoComentario } from '../ai/social/comentario.js';
import { baseDoComentario, contextoDoComentario, mensagemDoComentario, type PedidoDeComentarioDoSocial, type TipoComSugestao } from '../ai/social/comentario-contexto.js';
import type { SugestaoVista } from '../ai/social/contexto.js';
import { PROMPT_SOCIAL_COMENTARIO, SOCIAL, TAREFA_SOCIAL_COMENTARIO, WORKFLOW_DO_SOCIAL_COMENTARIO } from '../ai/social/prompt.js';
import { type BaseDoTextoDeResposta, RespostaDoSocial } from '../ai/social/resposta.js';
import { activeTraceId, writeAudit } from '../audit/audit.js';
import { achadosQueBarraram, codigoDoMotivo, esperaDaIa, itensQueBarraram, minutosAteATentativa, SEGUNDA_RODADA_DO_PEDIDO_RETIRADO } from '../avaliacoes/sugestoes.js';
import {
  adiarVez,
  barrarVez,
  DIAS_DOS_PEDIDOS,
  type DonoDaVez,
  encerrarSegundaRodadaDoComentario,
  encerrarVez,
  esperarVez,
  FERRAMENTA_DA_OPERACAO,
  lerVez,
  MINUTOS_DE_ESPERA_DOS_PEDIDOS,
  marcarVezOlhada,
  marcarVezPronta,
  marcarVezRetirada,
  motivoDaRetirada,
  type OperacaoDoPedido,
  operacaoDoTipo,
  oQueDesligaOsPedidos,
  PEDIDO_EM_ANDAMENTO,
  primeiraRodadaDoComentario,
  type RetiradaDoComentario,
  TENTATIVAS_DOS_PEDIDOS,
} from '../comentarios/pedidos.js';
import { contaConectada } from '../connections/conectada.js';
import { PROVEDOR_INSTAGRAM, PROVEDOR_PAGINA } from '../connectors/meta/publicacao.js';
import { currentTx } from '../context/request-context.js';
import { marcaDoCriativo } from '../criativo/base.js';
import { DATABASE } from '../database/database.module.js';
import { AppProblem } from '../errors/problems.js';
import { FlagService } from '../flags/flag.service.js';
import { REGRAS_DE_TEXTO_VERSAO } from '../policy/texto.js';
import { ResultsService } from '../results/results.service.js';

// A rotina dos pedidos do Social media para os comentários (A6, Z11, parte 2d-2; D-A6-88, D-A6-89, D-A6-94 e D-A6-98;
// protótipo P38). Fica na pasta do worker: quem chama é o laço. Para o comentário na vez dele, monta o pedido em
// Aprovações, pelo Action Service e em nome do dono da empresa: nada sai sem a aprovação de uma pessoa com o código do
// app (pode ser no lote, D-A6-93). No elogio e na marcação, com a resposta pronta, sem IA; na pergunta e na reclamação,
// com as sugestões do Social media que a conferência deixou passar (o texto que ela barra não é guardado, só os nomes do
// que barrou); no golpe e no ofensivo, o pedido de ocultar. O @ ou o nome de quem comentou não vai ao modelo.
//
// Três tempos, para não segurar uma transação enquanto o modelo responde (o mesmo desenho das avaliações, Z6):
// 1. banco (transação curta da empresa): a vez, o comentário, as chaves, o pedido que já existe, o dono e Minha marca;
// 2. o modelo, pelo gateway (sem transação), só na pergunta e na reclamação: o gateway confere a `ia`, a rota e o teto;
// 3. banco (transação da empresa): o pedido em Aprovações (o Action Service lê o comentário na rede na hora, monta o
//    plano e aplica a política) e a vez que acaba ligada a ele, juntos; ou a vez barrada, com a auditoria.

const MINUTO_MS = 60_000;
const DIA_MS = 24 * 60 * MINUTO_MS;

/** O que a vez fez com o comentário. Os mesmos casos das avaliações (`VezDaSugestao`); `sugestoes` é nulo no ocultar. */
export type VezDoPedido =
  | { status: 'pronta'; pedido: string; sugestoes: number | null }
  | { status: 'barrada'; itens: string[] }
  | { status: 'descartada'; motivo: string }
  | { status: 'falhou'; motivo: string; deVez: boolean }
  | { status: 'esperando'; motivo: string }
  | { status: 'fora' };

type LinhaDoComentario = {
  brand_id: string;
  provider: string;
  kind: string | null;
  message: string;
  hidden: boolean;
  published_at: Date | string;
  caption: string | null;
  respondido: boolean;
  conectada: boolean;
  marca_viva: boolean;
};

type Lido = {
  brandId: string;
  contaId: string;
  commentId: string;
  provider: string;
  operacao: OperacaoDoPedido;
  tipo: string;
  /** 1: o pedido nasce; 2: o "Pedir outra" (parte 3c), com as novas no pedido da rodada 1 (`pedidoAtual`). */
  rodada: 1 | 2;
  pedidoAtual: string | null;
  /** O dono da empresa, em nome de quem o pedido nasce (só na rodada 1). */
  dono: string | null;
  /** Só na pergunta e na reclamação: o que vai ao Social media, a base da conferência e o que a marca já escreve. */
  ia: { pedido: PedidoDeComentarioDoSocial; base: BaseDoTextoDeResposta; conhecido: string } | null;
};

/** O que a conferência da retirada fez com o pedido (A6, Z11, parte 2d-5). */
export type VezDaRetiradaDoComentario = { status: 'retirada'; motivo: RetiradaDoComentario; pedido: string } | { status: 'igual' } | { status: 'fora' };

const ehUuid = (v: string): boolean => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

/** A vez acabou enquanto o pedido era montado (outra volta da rotina a tratou): o pedido não pode ficar. */
class ForaDaFila extends Error {}

@Injectable()
export class PedidosDosComentariosService {
  private readonly logger = new Logger('pedidos-dos-comentarios');

  constructor(
    @Inject(DATABASE) private readonly database: Database | null,
    private readonly flags: FlagService,
    private readonly gateway: AiGateway,
    private readonly resultados: ResultsService,
    private readonly acoes: ActionService,
  ) {}

  /** Trata o comentário na vez dele. O relógio injetado vale para a operação inteira (V34). */
  async pedir(alvo: DonoDaVez, agora = new Date()): Promise<VezDoPedido> {
    const database = this.banco();
    const quem = { tenantId: alvo.tenantId, userId: null };
    const lido = await naTransacaoDaEmpresa<Lido | VezDoPedido>(database, quem, () => this.ler(alvo, agora));
    if ('status' in lido) return lido;

    // O golpe e o ofensivo: o pedido de ocultar, sem texto e sem IA (D-A6-89).
    if (lido.operacao === 'ocultar') return this.criar(alvo, lido, {}, null, null, agora);
    // O elogio e a marcação: a resposta pronta, sem IA, a mesma para o mesmo comentário (D-A6-88).
    if (lido.tipo === 'elogio' || lido.tipo === 'marcacao') return this.criar(alvo, lido, { texto: respostaPronta(lido.tipo, lido.commentId) }, 1, null, agora);
    const ia = lido.ia!;

    // ---- 2. O Social media: sem ferramenta; o comentário vai na mensagem, entre marcas.
    let r: Awaited<ReturnType<AiGateway['structured']>>;
    try {
      r = await this.gateway.structured({
        tenantId: alvo.tenantId,
        brandId: lido.brandId,
        // Ninguém pediu agora: é rotina do sistema, e não entra no limite por pessoa.
        userId: null,
        workflow: WORKFLOW_DO_SOCIAL_COMENTARIO,
        task: TAREFA_SOCIAL_COMENTARIO,
        promptVersion: `${PROMPT_SOCIAL_COMENTARIO.key}@${PROMPT_SOCIAL_COMENTARIO.version}`,
        instructions: PROMPT_SOCIAL_COMENTARIO.content,
        context: contextoDoComentario(ia.pedido),
        messages: [{ role: 'user', content: mensagemDoComentario(ia.pedido) }],
        schema: RespostaDoSocial,
      });
    } catch (err) {
      if (!(err instanceof AiError)) throw err;
      if (err.code === 'entrada-grande') return this.naEmpresa(alvo, (tx) => this.descartar(tx, alvo, 'grande_demais', agora));
      if (err.code === 'indisponivel') return this.falhou(alvo, 'ia_fora_do_ar', agora);
      // A IA desligada, parada, sem a rota do modelo ou no limite: não é falha do comentário. Ele espera, sem contar tentativa.
      const ate = err.detalhe.voltaEm ?? new Date(agora.getTime() + MINUTOS_DE_ESPERA_DOS_PEDIDOS * MINUTO_MS);
      return this.naEmpresa(alvo, (tx) => this.esperar(tx, alvo, esperaDaIa(err.code, err.detalhe.teto), ate, agora));
    }
    const resposta = RespostaDoSocial.safeParse(r.object);
    if (!resposta.success) return this.falhou(alvo, 'formato', agora);

    // No "Pedir outra", a sugestão que repete uma das que a pessoa já viu também é descartada.
    const vistas = (ia.pedido.anteriores ?? []).map((a) => a.texto);
    const { sugestoes, descartes } = sugestoesDoComentario(resposta.data, ia.base, lido.tipo as TipoComSugestao, ia.conhecido, vistas);
    const passaram = sugestoes.filter((s) => s.conferencia.situacao !== 'barrou');
    const barradas = sugestoes.filter((s) => s.conferencia.situacao === 'barrou');
    if (descartes.length) this.logger.warn(`pedido ${alvo.id}: o código descartou ${descartes.join(', ')} antes da conferência; uso ${r.usageId}`);

    if (!passaram.length) {
      // A conferência barrou o que ele escreveu: a vez acaba barrada, e o comentário fica com o "Responder" de sempre.
      if (barradas.length) {
        const itens = itensQueBarraram(barradas);
        return this.naEmpresa(alvo, async (tx) => {
          if (!(await barrarVez(tx, alvo, itens, r.usageId, agora))) return { status: 'fora' };
          // Na trilha, os nomes dos itens e dos achados; nunca o trecho nem o texto barrado.
          await this.auditar(tx, alvo, 'comentario.barrar_sugestoes', { barred_by: itens, findings: achadosQueBarraram(barradas), usage_id: r.usageId });
          return { status: 'barrada', itens };
        });
      }
      // Nada chegou à conferência (vazia, longa demais, com dado pessoal, fora do caminho): conta em Sua equipe, sem o
      // texto, e o comentário tenta de novo.
      const motivo = descartes.includes('dado_pessoal') ? 'dado_pessoal' : (descartes[0] ?? 'vazia');
      const doCompliance = motivo === 'dado_pessoal';
      await registrarRecusa(database, {
        tenantId: alvo.tenantId,
        brandId: lido.brandId,
        userId: null,
        usageId: r.usageId,
        member: SOCIAL.key,
        workflow: WORKFLOW_DO_SOCIAL_COMENTARIO,
        kind: doCompliance ? 'compliance' : motivo,
        rules: doCompliance ? ['dado_pessoal'] : [],
        rulesVersion: doCompliance ? REGRAS_DE_TEXTO_VERSAO : null,
      });
      return this.falhou(alvo, motivo, agora);
    }
    const barradasNaVez = barradas.length ? itensQueBarraram(barradas) : null;
    // O "Pedir outra": as novas entram no pedido que já espera a decisão.
    if (lido.rodada === 2) return this.trocar(alvo, lido, passaram, r.usageId, agora, barradasNaVez);
    // O texto que vai à rede começa sendo o da primeira sugestão (a pessoa escolhe outra, ou ajusta, antes de aprovar).
    const params = { texto: passaram[0]!.texto, sugestoes: passaram.map((s) => ({ enfoque: s.enfoque, texto: s.texto, rodada: 1 as const })) };
    return this.criar(alvo, lido, params, passaram.length, r.usageId, agora, barradasNaVez);
  }

  /** Uma tentativa que não deu certo: conta, e o comentário tenta de novo mais tarde; na última, fecha como `falhou`. */
  async falhou(alvo: DonoDaVez, motivo: string, agora = new Date()): Promise<VezDoPedido> {
    const codigo = codigoDoMotivo(motivo);
    return this.naEmpresa(alvo, async (tx) => {
      const s = await lerVez(tx, alvo);
      if (!s || s.status !== 'esperando') return { status: 'fora' };
      if (s.attempts + 1 >= TENTATIVAS_DOS_PEDIDOS) {
        if (!(await encerrarVez(tx, alvo, 'falhou', codigo, agora, { contarTentativa: true }))) return { status: 'fora' };
        await this.auditar(tx, alvo, 'comentario.falhar_pedido', { reason: codigo, attempts: s.attempts + 1 });
        return { status: 'falhou', motivo: codigo, deVez: true };
      }
      const ate = new Date(agora.getTime() + minutosAteATentativa(s.attempts) * MINUTO_MS);
      if (!(await adiarVez(tx, alvo, codigo, ate, agora))) return { status: 'fora' };
      return { status: 'falhou', motivo: codigo, deVez: false };
    });
  }

  /**
   * A retirada (A6, Z11, parte 2d-5; D-A6-102): o pedido do Social media sobre um comentário, que ainda espera a decisão,
   * sai de Aprovações quando o comentário deixou de ser o que o pedido leu (respondido direto na rede, ocultado, editado,
   * apagado). O pedido sai pelo Action Service, em nome do Social media (a reserva volta, nada é executado, o porquê fica
   * no motivo), e a vez acaba retirada. Nada mudou: a vez fica marcada como olhada, até a próxima leitura. Tudo numa
   * transação da empresa; o pedido é travado pelo Action Service: duas voltas ao mesmo tempo não retiram em dobro.
   */
  async retirarSeMudou(alvo: { tenantId: string; actionId: string }, agora = new Date()): Promise<VezDaRetiradaDoComentario> {
    return naTransacaoDaEmpresa<VezDaRetiradaDoComentario>(this.banco(), { tenantId: alvo.tenantId, userId: null }, async () => {
      const tx = currentTx();
      const p = (
        await tx.execute<{ status: string; actor_type: string; agent_key: string | null; tool: string; account_id: string | null; resource_id: string | null; before_state: unknown }>(sql`
          select status, actor_type, agent_key, tool, account_id, resource_id, before_state
            from liame.action_request where id = ${alvo.actionId} and tenant_id = ${alvo.tenantId}`)
      ).rows[0];
      if (!p || p.status !== 'aguardando_aprovacao' || p.actor_type !== 'agent' || p.agent_key !== SOCIAL.key) return { status: 'fora' };
      if (p.tool !== FERRAMENTA_DA_OPERACAO.responder && p.tool !== FERRAMENTA_DA_OPERACAO.ocultar) return { status: 'fora' };
      const prefixo = recursoDoComentario('');
      const commentId = p.resource_id?.startsWith(prefixo) ? p.resource_id.slice(prefixo.length) : null;
      if (!commentId || !p.account_id || !ehUuid(p.account_id)) return { status: 'fora' };
      const c = (
        await tx.execute<{ message: string; hidden: boolean; respondido: boolean }>(sql`
          select c.message, c.hidden,
                 exists (select 1 from liame.social_comment r
                          where r.connected_account_id = c.connected_account_id and r.parent_comment_id = c.comment_id and r.by_brand) as respondido
            from liame.social_comment c
           where c.connected_account_id = ${p.account_id}::uuid and c.comment_id = ${commentId} and c.tenant_id = ${alvo.tenantId}`)
      ).rows[0];
      // A vez sai com o comentário (em cascata): o pedido do comentário que sumiu do Liame não tem mais vez.
      const vez = (
        await tx.execute<{ id: string }>(sql`
          select id from liame.comment_suggestion where action_id = ${alvo.actionId} and tenant_id = ${alvo.tenantId} and status = 'pronta' for update`)
      ).rows[0];
      const antes = EstadoDoComentario.safeParse(p.before_state);
      const motivo = motivoDaRetirada(
        { ferramenta: p.tool, resumoDoPedido: antes.success ? antes.data.texto_resumo : null },
        c ? { oculto: c.hidden, respondido: c.respondido, resumoAgora: resumoDoComentario(c.message) } : null,
      );
      if (!motivo) {
        if (vez) await marcarVezOlhada(tx, { tenantId: alvo.tenantId, id: vez.id }, agora);
        return { status: 'igual' };
      }
      const quem = { tenantId: alvo.tenantId, agentKey: SOCIAL.key, agentLabel: SOCIAL.name };
      // Quem decidiu antes (aprovou, recusou) ganha: o Action Service não retira o que já não espera.
      if (!(await this.acoes.retirarPeloFuncionario(quem, alvo.actionId, motivo))) return { status: 'fora' };
      if (vez) {
        const daVez = { tenantId: alvo.tenantId, id: vez.id };
        if (!(await marcarVezRetirada(tx, daVez, motivo, agora))) throw new ForaDaFila();
        await this.auditar(tx, daVez, 'comentario.retirar_pedido', { reason: motivo, action_id: alvo.actionId });
      }
      // O "Pedir outra" que esperava o Social media não tem mais onde entrar (a tela não o mostra mais).
      await encerrarSegundaRodadaDoComentario(tx, { tenantId: alvo.tenantId, contaId: p.account_id, commentId }, SEGUNDA_RODADA_DO_PEDIDO_RETIRADO, agora);
      return { status: 'retirada', motivo, pedido: alvo.actionId };
    }).catch((err: unknown) => {
      if (err instanceof ForaDaFila) return { status: 'fora' as const };
      throw err;
    });
  }

  /** O primeiro tempo. Devolve o que a vez já decidiu (e gravou), ou o que o pedido precisa. */
  private async ler(alvo: DonoDaVez, agora: Date): Promise<Lido | VezDoPedido> {
    const tx = currentTx();
    const s = await lerVez(tx, alvo);
    if (!s || s.status !== 'esperando') return { status: 'fora' };
    const c = (
      await tx.execute<LinhaDoComentario>(sql`
        select c.brand_id, a.provider, c.kind, c.message, c.hidden, c.published_at, p.caption,
               exists (select 1 from liame.social_comment r
                        where r.connected_account_id = c.connected_account_id and r.parent_comment_id = c.comment_id and r.by_brand) as respondido,
               coalesce(${contaConectada('a')}, false) as conectada, (b.archived_at is null) as marca_viva
          from liame.social_comment c
          join liame.connected_account a on a.id = c.connected_account_id
          join liame.brand b on b.id = c.brand_id
          left join liame.social_comment_post p on p.connected_account_id = c.connected_account_id and p.post_id = c.post_id
         where c.connected_account_id = ${s.connected_account_id} and c.comment_id = ${s.comment_id} and c.tenant_id = ${alvo.tenantId}`)
    ).rows[0];
    // O comentário sai do Liame com a guarda dele (e a vez sai junto); aqui, só por segurança.
    if (!c) return this.descartar(tx, alvo, 'sumiu', agora);
    const operacao = operacaoDoTipo(c.kind);
    // O tipo mudou desde que a vez abriu (a IA decidiu outro, o texto mudou): a vez de agora não serve.
    if (!operacao || operacao !== s.operation) return this.descartar(tx, alvo, 'tipo_mudou', agora);
    if (c.hidden) return this.descartar(tx, alvo, 'oculto', agora);
    if (operacao === 'responder' && c.respondido) return this.descartar(tx, alvo, 'respondido', agora);
    // A vez que esperou demais (uma chave ficou desligada no meio) não volta semanas depois.
    if (agora.getTime() - new Date(c.published_at).getTime() > DIAS_DOS_PEDIDOS * DIA_MS) return this.descartar(tx, alvo, 'antigo', agora);
    if (!c.marca_viva) return this.descartar(tx, alvo, 'marca_arquivada', agora);
    // Sem a conta conectada, o pedido não teria como ler o comentário nem responder.
    if (!c.conectada) return this.descartar(tx, alvo, 'conta_desconectada', agora);

    const desligado = await oQueDesligaOsPedidos(tx, this.flags, { tenantId: alvo.tenantId, brandId: c.brand_id, connectedAccountId: s.connected_account_id });
    if (desligado) return this.esperar(tx, alvo, desligado, new Date(agora.getTime() + MINUTOS_DE_ESPERA_DOS_PEDIDOS * MINUTO_MS), agora);

    let dono: string | null = null;
    let pedidoAtual: string | null = null;
    let anteriores: SugestaoVista[] = [];
    if (s.round === 2) {
      // O "Pedir outra" (parte 3c): só a pergunta e a reclamação têm sugestões; as novas entram no pedido da rodada 1,
      // que tem de seguir esperando a decisão, com as sugestões que a pessoa já viu.
      if (c.kind !== 'pergunta' && c.kind !== 'reclamacao') return this.descartar(tx, alvo, 'tipo_mudou', agora);
      const primeira = await primeiraRodadaDoComentario(tx, { tenantId: alvo.tenantId, contaId: s.connected_account_id, commentId: s.comment_id });
      if (!primeira) return this.descartar(tx, alvo, 'sem_primeira', agora);
      const atual = (
        await tx.execute<{ status: string; params: unknown }>(sql`
          select status, params from liame.action_request where id = ${primeira.action_id} and tenant_id = ${alvo.tenantId}`)
      ).rows[0];
      const params = ParametrosDaRespostaAoComentario.safeParse(atual?.params);
      if (!atual || atual.status !== 'aguardando_aprovacao' || !params.success || !params.data.sugestoes) return this.descartar(tx, alvo, 'pedido_decidido', agora);
      pedidoAtual = primeira.action_id;
      // O enfoque vai junto do texto: o modelo só evita repetir o enfoque que vê.
      anteriores = params.data.sugestoes.map((x) => ({ enfoque: x.enfoque, texto: x.texto }));
    } else {
      // Uma pessoa já pediu (ou a ação já saiu pelo Liame): o Social media não pede por cima.
      const comPedido = (
        await tx.execute<{ tem: boolean }>(sql`
          select exists (
            select 1 from liame.action_request
             where tenant_id = ${alvo.tenantId} and account_id = ${s.connected_account_id}
               and resource_id = ${recursoDoComentario(s.comment_id)} and status in ${[...PEDIDO_EM_ANDAMENTO]}) as tem`)
      ).rows[0];
      if (comPedido?.tem) return this.descartar(tx, alvo, 'ja_tem_pedido', agora);
      // Quem responde pelo que o funcionário propõe em público é o dono da empresa (uma por empresa: `uq_membership_dono`).
      const linha = (
        await tx.execute<{ user_id: string }>(sql`
          select user_id from liame.membership where tenant_id = ${alvo.tenantId} and role_key = 'dono' and revoked_at is null`)
      ).rows[0];
      if (!linha) return this.descartar(tx, alvo, 'sem_dono', agora);
      dono = linha.user_id;
    }

    const base: Omit<Lido, 'ia'> = {
      brandId: c.brand_id,
      contaId: s.connected_account_id,
      commentId: s.comment_id,
      provider: c.provider,
      operacao,
      tipo: c.kind!,
      rodada: s.round,
      pedidoAtual,
      dono,
    };
    if (operacao === 'ocultar' || c.kind === 'elogio' || c.kind === 'marcacao') return { ...base, ia: null };

    // A pergunta e a reclamação: Minha marca (o nome, o dossiê e os fatos para a conferência).
    const fuso = await this.resultados.fusoDaMarca(c.brand_id);
    const marca = await marcaDoCriativo(c.brand_id, fuso, agora);
    if (!marca) return this.descartar(tx, alvo, 'sem_dossie', agora);
    const pedido: PedidoDeComentarioDoSocial = {
      marca: marca.nome,
      dossie: marca.dossie,
      rede: c.provider === PROVEDOR_PAGINA ? 'facebook' : 'instagram',
      tipo: c.kind as TipoComSugestao,
      legenda: c.caption ?? '',
      texto: c.message,
      // O canal de contato vem de Minha marca quando o campo existir (D-A6-31, proposta): até lá, nulo.
      contato: null,
      anteriores,
    };
    return { ...base, ia: { pedido, base: baseDoComentario(pedido, marca), conhecido: marca.dossie } };
  }

  /**
   * O terceiro tempo: o pedido em Aprovações e a vez que acaba, juntos (se um falhar, nenhum fica), com a auditoria (só
   * números e códigos: o texto fica no pedido). O que o Action Service recusa vai a `pedidoRecusado`.
   */
  private async criar(
    alvo: DonoDaVez,
    lido: Lido,
    params: Record<string, unknown>,
    sugestoes: number | null,
    usageId: string | null,
    agora: Date,
    barradas: string[] | null = null,
  ): Promise<VezDoPedido> {
    // A rodada 1 sempre tem o dono (`ler` descarta a vez sem ele).
    const funcionario = { tenantId: alvo.tenantId, agentKey: SOCIAL.key, agentLabel: SOCIAL.name, emNomeDe: lido.dono! };
    try {
      return await naTransacaoDaEmpresa<VezDoPedido>(this.banco(), { tenantId: alvo.tenantId, userId: null }, async () => {
        const tx = currentTx();
        const pedido = await this.acoes.pedirRespostaPeloFuncionario(funcionario, {
          tool: FERRAMENTA_DA_OPERACAO[lido.operacao],
          brand_id: lido.brandId,
          provider: lido.provider === PROVEDOR_PAGINA ? PROVEDOR_PAGINA : PROVEDOR_INSTAGRAM,
          account_id: lido.contaId,
          resource_id: recursoDoComentario(lido.commentId),
          params,
        });
        if (!(await marcarVezPronta(tx, alvo, { pedido, sugestoes, usageId }, agora))) throw new ForaDaFila();
        await this.auditar(tx, alvo, 'comentario.pedir', {
          operation: lido.operacao,
          kind: lido.tipo,
          ...(sugestoes !== null ? { suggestions: sugestoes } : {}),
          ...(barradas ? { barred: barradas.length, barred_by: barradas } : {}),
          action_id: pedido,
          usage_id: usageId,
        });
        return { status: 'pronta', pedido, sugestoes };
      });
    } catch (err) {
      if (err instanceof ForaDaFila) return { status: 'fora' };
      if (!(err instanceof AppProblem)) throw err;
      return this.pedidoRecusado(alvo, err, usageId, agora);
    }
  }

  /**
   * O terceiro tempo do "Pedir outra" (parte 3c): as sugestões novas entram no pedido da rodada 1, pelo Action Service
   * (o plano é montado de novo, com o comentário lido na rede agora, e a aprovação dada ao plano anterior deixa de
   * valer), e a vez acaba pronta, sem apontar o pedido. O pedido decidido enquanto ele escrevia: a vez acaba descartada.
   */
  private async trocar(
    alvo: DonoDaVez,
    lido: Lido,
    novas: readonly { enfoque: string; texto: string }[],
    usageId: string | null,
    agora: Date,
    barradas: string[] | null,
  ): Promise<VezDoPedido> {
    const funcionario = { tenantId: alvo.tenantId, agentKey: SOCIAL.key, agentLabel: SOCIAL.name };
    const pedido = lido.pedidoAtual!;
    try {
      return await naTransacaoDaEmpresa<VezDoPedido>(this.banco(), { tenantId: alvo.tenantId, userId: null }, async () => {
        const tx = currentTx();
        if (!(await this.acoes.trocarSugestoesPeloFuncionario(funcionario, pedido, novas))) return this.descartar(tx, alvo, 'pedido_decidido', agora, usageId);
        if (!(await marcarVezPronta(tx, alvo, { pedido: null, sugestoes: novas.length, usageId }, agora))) throw new ForaDaFila();
        await this.auditar(tx, alvo, 'comentario.pedir', {
          operation: lido.operacao,
          kind: lido.tipo,
          round: 2,
          suggestions: novas.length,
          ...(barradas ? { barred: barradas.length, barred_by: barradas } : {}),
          action_id: pedido,
          usage_id: usageId,
        });
        return { status: 'pronta', pedido, sugestoes: novas.length };
      });
    } catch (err) {
      if (err instanceof ForaDaFila) return { status: 'fora' };
      if (!(err instanceof AppProblem)) throw err;
      return this.pedidoRecusado(alvo, err, usageId, agora);
    }
  }

  /**
   * O Action Service recusou o pedido. O que não muda tentando de novo acaba aqui; o que passa sozinho (a escrita
   * desligada no meio, a trava, a Meta fora do ar) espera ou conta como tentativa. O motivo fica no log, sem texto.
   */
  private async pedidoRecusado(alvo: DonoDaVez, err: AppProblem, usageId: string | null, agora: Date): Promise<VezDoPedido> {
    this.logger.warn(`pedido ${alvo.id}: o pedido do comentário não foi montado (${err.code}): ${err.detail}`);
    const emUmaHora = new Date(agora.getTime() + MINUTOS_DE_ESPERA_DOS_PEDIDOS * MINUTO_MS);
    switch (err.code) {
      case 'acao-duplicada':
        return this.naEmpresa(alvo, (tx) => this.descartar(tx, alvo, 'ja_tem_pedido', agora, usageId));
      // A rede diz que o comentário já tem resposta, está oculto ou não existe mais; ou o plano não aceita o texto.
      case 'plano-recusado':
        return this.naEmpresa(alvo, (tx) => this.descartar(tx, alvo, 'plano_recusado', agora, usageId));
      case 'recurso-nao-encontrado':
        return this.naEmpresa(alvo, (tx) => this.descartar(tx, alvo, 'sumiu', agora, usageId));
      case 'modo-nao-e-aprovacao':
        return this.naEmpresa(alvo, (tx) => this.descartar(tx, alvo, 'politica', agora, usageId));
      case 'politica-negou':
        return this.naEmpresa(alvo, async (tx) => {
          if (!(await barrarVez(tx, alvo, ['politica_da_empresa'], usageId, agora))) return { status: 'fora' };
          await this.auditar(tx, alvo, 'comentario.barrar_sugestoes', { barred_by: ['politica_da_empresa'], usage_id: usageId });
          return { status: 'barrada', itens: ['politica_da_empresa'] };
        });
      case 'escrita-desligada':
        return this.naEmpresa(alvo, (tx) => this.esperar(tx, alvo, 'resposta_desligada', emUmaHora, agora));
      case 'parada-acionada':
        return this.naEmpresa(alvo, (tx) => this.esperar(tx, alvo, 'parada', emUmaHora, agora));
      // A Página sem a tarefa de moderar, ou a autorização sem a permissão: espera a autorização certa, sem contar tentativa.
      case 'sem-permissao-na-plataforma':
        return this.naEmpresa(alvo, (tx) => this.esperar(tx, alvo, 'sem_permissao', new Date(agora.getTime() + DIA_MS), agora));
      case 'conta-desconectada':
        return this.naEmpresa(alvo, (tx) => this.descartar(tx, alvo, 'conta_desconectada', agora, usageId));
      default:
        return this.falhou(alvo, err.code, agora);
    }
  }

  /** O comentário não vai ter pedido: a vez acaba descartada, com o porquê em código e a auditoria. */
  private async descartar(tx: Tx, alvo: DonoDaVez, motivo: string, agora: Date, usageId: string | null = null): Promise<VezDoPedido> {
    if (!(await encerrarVez(tx, alvo, 'descartada', motivo, agora, { usageId }))) return { status: 'fora' };
    await this.auditar(tx, alvo, 'comentario.descartar_pedido', { reason: motivo, usage_id: usageId });
    return { status: 'descartada', motivo };
  }

  /** Não é a vez dele agora: olha de novo depois, sem contar tentativa. */
  private async esperar(tx: Tx, alvo: DonoDaVez, motivo: string, ate: Date, agora: Date): Promise<VezDoPedido> {
    if (!(await esperarVez(tx, alvo, motivo, ate, agora))) return { status: 'fora' };
    return { status: 'esperando', motivo };
  }

  private auditar(tx: Tx, alvo: DonoDaVez, acao: string, depois: Record<string, unknown>): Promise<string> {
    return writeAudit(tx, {
      tenantId: alvo.tenantId,
      actorType: 'agent',
      actorId: null,
      actorLabel: SOCIAL.name,
      action: acao,
      resourceType: 'comment_suggestion',
      resourceId: alvo.id,
      after: { ...depois, agent_key: SOCIAL.key },
      traceId: activeTraceId(),
      origin: 'worker',
      agent: SOCIAL.key,
    });
  }

  private naEmpresa(alvo: DonoDaVez, fn: (tx: Tx) => Promise<VezDoPedido>): Promise<VezDoPedido> {
    return naTransacaoDaEmpresa<VezDoPedido>(this.banco(), { tenantId: alvo.tenantId, userId: null }, () => fn(currentTx()));
  }

  private banco(): Database {
    if (!this.database) throw new Error('pedidos dos comentários: sem banco');
    return this.database;
  }
}
