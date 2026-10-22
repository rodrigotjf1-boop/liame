import type { Database, Tx } from '@liame/database';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { ActionService } from '../actions/action.service.js';
import { recursoDaAvaliacao } from '../actions/perfil-avaliacao.js';
import { PROVEDOR_PERFIL_GOOGLE } from '../connectors/google-business/perfil-google.js';
import { AiError, AiGateway } from '../ai/gateway.js';
import { naTransacaoDaEmpresa } from '../ai/na-empresa.js';
import { registrarRecusa } from '../ai/recusas.js';
import { baseDoPedidoDoSocial, contextoDoSocial, mensagemDoSocial, type PedidoDoSocial, sugestoesPedidas } from '../ai/social/contexto.js';
import { PROMPT_SOCIAL_RESPOSTA, SOCIAL, TAREFA_SOCIAL_RESPOSTA, WORKFLOW_DO_SOCIAL } from '../ai/social/prompt.js';
import { type BaseDaSugestao, RespostaDoSocial, sugestoesDaResposta } from '../ai/social/resposta.js';
import { activeTraceId, writeAudit } from '../audit/audit.js';
import {
  achadosQueBarraram,
  adiarSugestao,
  avaliacaoAntiga,
  barrarSugestao,
  codigoDoMotivo,
  type DonoDaSugestao,
  encerrarSugestao,
  esperarSugestao,
  itensQueBarraram,
  lerSugestao,
  MINUTOS_DE_ESPERA,
  marcarPronta,
  minutosAteATentativa,
  oQueDesligaAsSugestoes,
  PEDIDO_QUE_CONTA,
  paramsDaResposta,
  TENTATIVAS_DAS_SUGESTOES,
} from '../avaliacoes/sugestoes.js';
import { contaConectada } from '../connections/conectada.js';
import { currentTx } from '../context/request-context.js';
import { marcaDoCriativo } from '../criativo/base.js';
import { DATABASE } from '../database/database.module.js';
import { AppProblem } from '../errors/problems.js';
import { FlagService } from '../flags/flag.service.js';
import { REGRAS_DE_TEXTO_VERSAO } from '../policy/texto.js';
import { ResultsService } from '../results/results.service.js';

// A rotina das sugestões de resposta às avaliações do Google, pelo Social media (A6, Z6, parte 2; `plano-a6.md` D-A6-26
// a D-A6-30; protótipo P31). Fica na pasta do worker: quem chama é o laço. Para a avaliação na vez dela, ele recebe a
// nota, o texto e o dia da avaliação e Minha marca (D-A6-29; nunca o nome de quem avaliou, que o Liame não guarda),
// escreve uma ou duas sugestões (D-A6-26), e o código confere cada uma antes de qualquer pessoa ver (D-A6-28). As que
// passam vão num pedido só em Aprovações, pelo Action Service e em nome do dono da empresa: nada é publicado sem a
// aprovação de uma pessoa com o código do app, e a resposta a uma avaliação de 1 ou 2 estrelas, só com a do dono
// (D-A6-27). O texto que a conferência barra não é guardado, só os nomes do que barrou.
//
// Três tempos, para não segurar uma transação enquanto o modelo responde:
// 1. banco (transação curta da empresa): a vez, a avaliação, as chaves, o pedido que já existe, o dono e Minha marca;
// 2. o modelo, pelo gateway (sem transação): o gateway confere a flag `ia`, a rota, o teto e limpa o dado pessoal;
// 3. banco (transação da empresa): o pedido em Aprovações (o Action Service lê a avaliação no Google na hora, monta o
//    plano e aplica a política) e a vez que acaba ligada a ele, juntos; ou a vez barrada, com a auditoria.

const MINUTO_MS = 60_000;

/**
 * O que a vez fez com a avaliação. `pronta`: o pedido com as sugestões que passaram está em Aprovações. `barrada`: a
 * conferência não deixou passar nenhuma. `descartada`: a avaliação não vai ter sugestão (já tem resposta ou pedido,
 * passou dos 30 dias, a loja foi desconectada…). `falhou`: não deu desta vez; `deVez` diz se as tentativas acabaram.
 * `esperando`: não é a vez dela agora (a função, a IA ou o Social media desligados, o limite de IA), sem contar
 * tentativa. `fora`: ela não está mais esperando.
 */
export type VezDaSugestao =
  | { status: 'pronta'; pedido: string; sugestoes: number }
  | { status: 'barrada'; itens: string[] }
  | { status: 'descartada'; motivo: string }
  | { status: 'falhou'; motivo: string; deVez: boolean }
  | { status: 'esperando'; motivo: string }
  | { status: 'fora' };

type LinhaDaAvaliacao = {
  id: string;
  brand_id: string;
  connected_account_id: string;
  stars: number;
  comment: string | null;
  reviewed_at: Date | string;
  reply_text: string | null;
  conectada: boolean;
  marca_viva: boolean;
};

type Lido = {
  brandId: string;
  contaId: string;
  reviewId: string;
  dono: string;
  pedido: PedidoDoSocial;
  base: BaseDaSugestao;
  pedidas: 1 | 2;
  /** O que a marca já escreve (o dossiê, com o nome dela): o nome que está ali não é de quem avaliou. */
  conhecido: string;
};

/** A vez acabou enquanto o pedido era montado (outra volta da rotina a tratou): o pedido não pode ficar. */
class ForaDaFila extends Error {}

@Injectable()
export class SugestoesDeRespostaService {
  private readonly logger = new Logger('sugestoes-de-resposta');

  constructor(
    @Inject(DATABASE) private readonly database: Database | null,
    private readonly flags: FlagService,
    private readonly gateway: AiGateway,
    private readonly resultados: ResultsService,
    private readonly acoes: ActionService,
  ) {}

  /** Trata a avaliação na vez dela. O relógio injetado vale para a operação inteira (V34). */
  async sugerir(alvo: DonoDaSugestao, agora = new Date()): Promise<VezDaSugestao> {
    const database = this.banco();
    const quem = { tenantId: alvo.tenantId, userId: null };

    // ---- 1. O banco: a vez, a avaliação e tudo de que o pedido ao modelo parte.
    const lido = await naTransacaoDaEmpresa<Lido | VezDaSugestao>(database, quem, () => this.ler(alvo, agora));
    if ('status' in lido) return lido;

    // ---- 2. O Social media: sem ferramenta; o texto da avaliação vai na mensagem, entre marcas.
    let r: Awaited<ReturnType<AiGateway['structured']>>;
    try {
      r = await this.gateway.structured({
        tenantId: alvo.tenantId,
        brandId: lido.brandId,
        // Ninguém pediu esta sugestão agora: é rotina do sistema, e não entra no limite por pessoa.
        userId: null,
        workflow: WORKFLOW_DO_SOCIAL,
        task: TAREFA_SOCIAL_RESPOSTA,
        promptVersion: `${PROMPT_SOCIAL_RESPOSTA.key}@${PROMPT_SOCIAL_RESPOSTA.version}`,
        instructions: PROMPT_SOCIAL_RESPOSTA.content,
        context: contextoDoSocial(lido.pedido),
        messages: [{ role: 'user', content: mensagemDoSocial(lido.pedido) }],
        schema: RespostaDoSocial,
      });
    } catch (err) {
      if (!(err instanceof AiError)) throw err;
      if (err.code === 'entrada-grande') return this.naEmpresa(alvo, (tx) => this.descartar(tx, alvo, 'grande_demais', agora));
      if (err.code === 'indisponivel') return this.falhou(alvo, 'ia_fora_do_ar', agora);
      // A IA desligada, parada, sem rota ou no limite: não é falha da avaliação. Ela espera, sem contar tentativa.
      const ate = err.detalhe.voltaEm ?? new Date(agora.getTime() + MINUTOS_DE_ESPERA * MINUTO_MS);
      return this.naEmpresa(alvo, (tx) => this.esperar(tx, alvo, `ia_${codigoDoMotivo(err.code)}`, ate, agora));
    }
    const resposta = RespostaDoSocial.safeParse(r.object);
    if (!resposta.success) return this.falhou(alvo, 'formato', agora);

    const { sugestoes, descartes } = sugestoesDaResposta(resposta.data, lido.base, lido.pedidas, lido.conhecido);
    const passaram = sugestoes.filter((s) => s.conferencia.situacao !== 'barrou');
    const barradas = sugestoes.filter((s) => s.conferencia.situacao === 'barrou');
    if (descartes.length) this.logger.warn(`sugestão ${alvo.id}: o código descartou ${descartes.join(', ')} antes da conferência; uso ${r.usageId}`);

    if (!passaram.length) {
      // A conferência barrou o que ele escreveu: a vez acaba barrada, e a avaliação fica com o "Responder" de sempre.
      if (barradas.length) {
        const itens = itensQueBarraram(barradas);
        return this.naEmpresa(alvo, async (tx) => {
          if (!(await barrarSugestao(tx, alvo, itens, r.usageId, agora))) return { status: 'fora' };
          // Na trilha, os nomes dos itens e dos achados; nunca o trecho nem o texto barrado.
          await this.auditar(tx, alvo, 'avaliacao.barrar_sugestoes', { barred_by: itens, findings: achadosQueBarraram(barradas), usage_id: r.usageId });
          return { status: 'barrada', itens };
        });
      }
      // Nada chegou à conferência (vazia, longa demais, com dado pessoal): conta em Sua equipe, sem o texto, e a avaliação
      // tenta de novo.
      const motivo = descartes.includes('dado_pessoal') ? 'dado_pessoal' : (descartes[0] ?? 'vazia');
      const doCompliance = motivo === 'dado_pessoal';
      await registrarRecusa(database, {
        tenantId: alvo.tenantId,
        brandId: lido.brandId,
        userId: null,
        usageId: r.usageId,
        member: SOCIAL.key,
        workflow: WORKFLOW_DO_SOCIAL,
        kind: doCompliance ? 'compliance' : motivo,
        rules: doCompliance ? ['dado_pessoal'] : [],
        rulesVersion: doCompliance ? REGRAS_DE_TEXTO_VERSAO : null,
      });
      return this.falhou(alvo, motivo, agora);
    }

    // ---- 3. O pedido em Aprovações e a vez que acaba, juntos: se um falhar, nenhum fica.
    try {
      const pedido = await naTransacaoDaEmpresa(database, quem, async () => {
        const tx = currentTx();
        const id = await this.acoes.pedirRespostaPeloFuncionario(
          { tenantId: alvo.tenantId, agentKey: SOCIAL.key, agentLabel: SOCIAL.name, emNomeDe: lido.dono },
          {
            tool: 'avaliacao_responder',
            brand_id: lido.brandId,
            provider: PROVEDOR_PERFIL_GOOGLE,
            account_id: lido.contaId,
            resource_id: recursoDaAvaliacao(lido.reviewId),
            params: paramsDaResposta(passaram, 1),
          },
        );
        if (!(await marcarPronta(tx, alvo, { pedido: id, sugestoes: passaram.length, usageId: r.usageId }, agora))) throw new ForaDaFila();
        // Só números e códigos: o texto das sugestões fica no pedido, não na trilha.
        await this.auditar(tx, alvo, 'avaliacao.sugerir', {
          round: 1,
          suggestions: passaram.length,
          barred: barradas.length,
          ...(barradas.length ? { barred_by: itensQueBarraram(barradas) } : {}),
          action_id: id,
          usage_id: r.usageId,
        });
        return id;
      });
      return { status: 'pronta', pedido, sugestoes: passaram.length };
    } catch (err) {
      if (err instanceof ForaDaFila) return { status: 'fora' };
      if (!(err instanceof AppProblem)) throw err;
      return this.pedidoRecusado(alvo, err, r.usageId, agora);
    }
  }

  /**
   * Uma tentativa que não deu certo: conta, e a avaliação tenta de novo mais tarde (15, 30 minutos…); na última, fecha
   * como `falhou`, com a auditoria. É também por onde o laço registra a falha fora do previsto.
   */
  async falhou(alvo: DonoDaSugestao, motivo: string, agora = new Date()): Promise<VezDaSugestao> {
    const codigo = codigoDoMotivo(motivo);
    return this.naEmpresa(alvo, async (tx) => {
      const s = await lerSugestao(tx, alvo);
      if (!s || s.status !== 'esperando') return { status: 'fora' };
      if (s.attempts + 1 >= TENTATIVAS_DAS_SUGESTOES) {
        if (!(await encerrarSugestao(tx, alvo, 'falhou', codigo, agora, { contarTentativa: true }))) return { status: 'fora' };
        await this.auditar(tx, alvo, 'avaliacao.falhar_sugestoes', { reason: codigo, attempts: s.attempts + 1 });
        return { status: 'falhou', motivo: codigo, deVez: true };
      }
      const ate = new Date(agora.getTime() + minutosAteATentativa(s.attempts) * MINUTO_MS);
      if (!(await adiarSugestao(tx, alvo, codigo, ate, agora))) return { status: 'fora' };
      return { status: 'falhou', motivo: codigo, deVez: false };
    });
  }

  /** O primeiro tempo. Devolve o que a vez já decidiu (e gravou), ou o pedido que vai ao Social media. */
  private async ler(alvo: DonoDaSugestao, agora: Date): Promise<Lido | VezDaSugestao> {
    const tx = currentTx();
    const s = await lerSugestao(tx, alvo);
    if (!s || s.status !== 'esperando') return { status: 'fora' };
    const a = (
      await tx.execute<LinhaDaAvaliacao>(sql`
        select r.id, r.brand_id, r.connected_account_id, r.stars, r.comment, r.reviewed_at, r.reply_text,
               (c.id is not null) as conectada, (b.archived_at is null) as marca_viva
          from liame.profile_review r
          join liame.brand b on b.id = r.brand_id
          left join liame.connected_account c on c.id = r.connected_account_id and ${contaConectada('c')}
         where r.id = ${s.review_id} and r.tenant_id = ${alvo.tenantId}`)
    ).rows[0];
    // A avaliação sai do Liame com a guarda dela (e a vez sai junto); aqui, só por segurança.
    if (!a) return this.descartar(tx, alvo, 'sumiu', agora);
    // A resposta chegou antes da vez (dada direto no Google, ou pelo Liame): não há o que sugerir.
    if (a.reply_text !== null) return this.descartar(tx, alvo, 'respondida', agora);
    // A vez que esperou demais (a função ficou desligada no meio) não volta semanas depois (D-A6-26).
    if (avaliacaoAntiga(new Date(a.reviewed_at), agora)) return this.descartar(tx, alvo, 'antiga', agora);
    if (!a.marca_viva) return this.descartar(tx, alvo, 'marca_arquivada', agora);
    // Sem a loja conectada, o pedido não teria como ler a avaliação nem publicar a resposta.
    if (!a.conectada) return this.descartar(tx, alvo, 'perfil_desconectado', agora);

    const desligado = await oQueDesligaAsSugestoes(tx, this.flags, { tenantId: alvo.tenantId, brandId: a.brand_id, connectedAccountId: a.connected_account_id });
    if (desligado) return this.esperar(tx, alvo, desligado, new Date(agora.getTime() + MINUTOS_DE_ESPERA * MINUTO_MS), agora);

    // Uma pessoa já pediu a resposta (ou ela já saiu pelo Liame): o Social media não escreve por cima.
    const comPedido = (
      await tx.execute<{ tem: boolean }>(sql`
        select exists (
          select 1 from liame.action_request
           where tenant_id = ${alvo.tenantId} and tool = 'avaliacao_responder' and resource_id = ${recursoDaAvaliacao(a.id)}
             and status in ${[...PEDIDO_QUE_CONTA]}) as tem`)
    ).rows[0];
    if (comPedido?.tem) return this.descartar(tx, alvo, 'ja_tem_pedido', agora);

    // Quem responde pelo que o funcionário propõe em público é o dono da empresa (uma por empresa: `uq_membership_dono`).
    const dono = (
      await tx.execute<{ user_id: string }>(sql`
        select user_id from liame.membership where tenant_id = ${alvo.tenantId} and role_key = 'dono' and revoked_at is null`)
    ).rows[0];
    if (!dono) return this.descartar(tx, alvo, 'sem_dono', agora);

    // Minha marca: o nome, o dossiê (o tom de voz, o que pode provar, o que nunca diz) e os fatos para a conferência.
    const fuso = await this.resultados.fusoDaMarca(a.brand_id);
    const marca = await marcaDoCriativo(a.brand_id, fuso, agora);
    if (!marca) return this.descartar(tx, alvo, 'sem_dossie', agora);
    const feitaEm = new Date(a.reviewed_at).toLocaleDateString('pt-BR', { timeZone: fuso, day: '2-digit', month: '2-digit', year: 'numeric' });
    // O canal de contato vem de Minha marca quando o campo existir (D-A6-31, proposta): até lá, nulo.
    const pedido: PedidoDoSocial = { marca: marca.nome, dossie: marca.dossie, estrelas: a.stars, feitaEm, texto: a.comment, canal: null };
    return {
      brandId: a.brand_id,
      contaId: a.connected_account_id,
      reviewId: a.id,
      dono: dono.user_id,
      pedido,
      base: baseDoPedidoDoSocial(pedido, marca),
      pedidas: sugestoesPedidas(pedido),
      conhecido: marca.dossie,
    };
  }

  /**
   * O Action Service recusou o pedido (a sugestão já está escrita, e o gasto de IA, feito). O que não muda tentando de
   * novo acaba aqui; o que passa sozinho (a escrita desligada no meio, a trava, o Google fora do ar) espera ou conta
   * como tentativa. O motivo do serviço fica no log, sem o texto da sugestão.
   */
  private async pedidoRecusado(alvo: DonoDaSugestao, err: AppProblem, usageId: string, agora: Date): Promise<VezDaSugestao> {
    this.logger.warn(`sugestão ${alvo.id}: o pedido de resposta não foi montado (${err.code}): ${err.detail}`);
    const emUmaHora = new Date(agora.getTime() + MINUTOS_DE_ESPERA * MINUTO_MS);
    switch (err.code) {
      // Uma pessoa pediu a resposta enquanto ele escrevia.
      case 'acao-duplicada':
        return this.naEmpresa(alvo, (tx) => this.descartar(tx, alvo, 'ja_tem_pedido', agora, usageId));
      // O Google diz que a avaliação já tem resposta, ou que não existe mais; ou o plano não aceita o texto.
      case 'plano-recusado':
        return this.naEmpresa(alvo, (tx) => this.descartar(tx, alvo, 'plano_recusado', agora, usageId));
      case 'recurso-nao-encontrado':
        return this.naEmpresa(alvo, (tx) => this.descartar(tx, alvo, 'sumiu', agora, usageId));
      // A política da empresa ou da marca não deixa o funcionário pedir esta ação, ou não deixa o texto.
      case 'modo-nao-e-aprovacao':
        return this.naEmpresa(alvo, (tx) => this.descartar(tx, alvo, 'politica', agora, usageId));
      case 'politica-negou':
        return this.naEmpresa(alvo, async (tx) => {
          if (!(await barrarSugestao(tx, alvo, ['politica_da_empresa'], usageId, agora))) return { status: 'fora' };
          await this.auditar(tx, alvo, 'avaliacao.barrar_sugestoes', { barred_by: ['politica_da_empresa'], usage_id: usageId });
          return { status: 'barrada', itens: ['politica_da_empresa'] };
        });
      case 'escrita-desligada':
        return this.naEmpresa(alvo, (tx) => this.esperar(tx, alvo, 'resposta_desligada', emUmaHora, agora));
      case 'parada-acionada':
        return this.naEmpresa(alvo, (tx) => this.esperar(tx, alvo, 'parada', emUmaHora, agora));
      // A conta recusou a leitura (autorização vencida ou sem permissão): a loja precisa ser conectada de novo.
      case 'conta-desconectada':
      case 'sem-permissao-na-plataforma':
        return this.naEmpresa(alvo, (tx) => this.descartar(tx, alvo, 'perfil_desconectado', agora, usageId));
      default:
        return this.falhou(alvo, err.code, agora);
    }
  }

  /** A avaliação não vai ter sugestão: a vez acaba descartada, com o porquê em código e a auditoria. */
  private async descartar(tx: Tx, alvo: DonoDaSugestao, motivo: string, agora: Date, usageId: string | null = null): Promise<VezDaSugestao> {
    if (!(await encerrarSugestao(tx, alvo, 'descartada', motivo, agora, { usageId }))) return { status: 'fora' };
    await this.auditar(tx, alvo, 'avaliacao.descartar_sugestoes', { reason: motivo, usage_id: usageId });
    return { status: 'descartada', motivo };
  }

  /** Não é a vez dela agora: olha de novo depois, sem contar tentativa. */
  private async esperar(tx: Tx, alvo: DonoDaSugestao, motivo: string, ate: Date, agora: Date): Promise<VezDaSugestao> {
    if (!(await esperarSugestao(tx, alvo, motivo, ate, agora))) return { status: 'fora' };
    return { status: 'esperando', motivo };
  }

  private auditar(tx: Tx, alvo: DonoDaSugestao, acao: string, depois: Record<string, unknown>): Promise<string> {
    return writeAudit(tx, {
      tenantId: alvo.tenantId,
      actorType: 'agent',
      actorId: null,
      actorLabel: SOCIAL.name,
      action: acao,
      resourceType: 'review_suggestion',
      resourceId: alvo.id,
      after: { ...depois, agent_key: SOCIAL.key },
      traceId: activeTraceId(),
      origin: 'worker',
      agent: SOCIAL.key,
    });
  }

  private naEmpresa(alvo: DonoDaSugestao, fn: (tx: Tx) => Promise<VezDaSugestao>): Promise<VezDaSugestao> {
    return naTransacaoDaEmpresa<VezDaSugestao>(this.banco(), { tenantId: alvo.tenantId, userId: null }, () => fn(currentTx()));
  }

  private banco(): Database {
    if (!this.database) throw new Error('sugestões de resposta: sem banco');
    return this.database;
  }
}
