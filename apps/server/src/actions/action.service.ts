import type {
  ActionMessage,
  ActionProposal,
  ActionResponse,
  ActionStatus,
  ApproveActionRequest,
  AutonomyMode,
  CreateActionRequest,
  PolicyDecision,
  PolicyRule,
  RejectActionRequest,
  SandboxResourceRequest,
  SandboxResourceResponse,
  UpdateActionRequest,
} from '@liame/contracts';
import { type Tx, uuidv7 } from '@liame/database';
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { activeTraceId, canonicalJson, sha256, writeAudit } from '../audit/audit.js';
import { MfaService } from '../auth/mfa.service.js';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { afterCommit, type AuthContext, auditDetail, currentTx } from '../context/request-context.js';
import { AppProblem, issuesToErrors, ValidationProblem } from '../errors/problems.js';
import { emitEvent } from '../events/outbox.js';
import { FlagService } from '../flags/flag.service.js';
import { KillSwitchService } from '../kill-switch/kill-switch.service.js';
import { Mailer } from '../mail/mailer.js';
import { actionMatches, evaluatePolicy, type LoadedPolicy, rateLimitsFor } from '../policy/engine.js';
import { PolicyService } from '../policy/policy.service.js';
import { currentTraceparent, inSpan } from '../observability/trace.js';
import { alvoDaRecomendacao, direcaoDaRecomendacao, type FalhaDaLigacao } from '../sombra/pedido.js';
import type { AcaoSombra } from '../sombra/regras.js';
import { advance, workflowOf } from '../workflow/workflow.js';
import { BudgetService, estadoNaResposta } from './budget.service.js';
import { CONNECTORS, type Connector, type ReadResult, type ResourceRef } from './connectors.js';
import { problemaDaLeitura, recursoNaoEncontrado } from './leitura-na-plataforma.js';
import { EstadoDaMensagem } from './mensagem-plano.js';
import type { RegraDoCupom } from './regem-cupom.js';
import { mensagemDoRecurso } from './regemcast-mensagem.js';
import { respostaDaPlataforma } from './resposta-da-plataforma.js';
import { PlanoRecusado, type ResourceState, TOOLS, type ToolDefinition, type ToolPlan } from './tools.js';

/** Pedido que ninguém aprova expira (e devolve a reserva). */
export const ACTION_TTL_HOURS = 72;
const ACTIVE: ActionStatus[] = ['aguardando_aprovacao', 'aprovada', 'executando'];

export type ActionRow = {
  id: string;
  tenant_id: string;
  brand_id: string | null;
  tool: string;
  action: string;
  provider: string;
  account_id: string;
  resource_id: string;
  params: Record<string, unknown>;
  risk_level: ActionResponse['risk_level'];
  budget_impact: ActionResponse['budget_impact'];
  value_micros: string | null;
  current_value_micros: string | null;
  reserved_micros: string;
  before_state: Record<string, unknown> | null;
  before_version: number | null;
  desired_state: Record<string, unknown>;
  plan_hash: string;
  action_fingerprint: string;
  mode: AutonomyMode;
  policy_decision: PolicyDecision;
  status: ActionStatus;
  status_reason: string | null;
  /** A execução que a plataforma mandou esperar: quantas vezes e quando tenta de novo (migration 0044). */
  attempts: number;
  next_attempt_at: Date | string | null;
  /** A ação que este pedido desfaz (a volta; migration 0045). */
  compensates_action_id: string | null;
  /** A recomendação do Gestor de tráfego de que o pedido nasceu (migration 0047). */
  shadow_decision_id: string | null;
  /** Quem pediu: `human` ou `agent`; no pedido de um funcionário de IA, a chave dele (migration 0048). */
  actor_type: string;
  agent_key: string | null;
  /** A pessoa que pediu; no pedido de um funcionário de IA, a que o deixou pedir. */
  requested_by: string;
  expires_at: Date | string;
  created_at: Date | string;
  updated_at: Date | string;
};

/** O que a tela mostra de cada pedido e não mora na linha dele: quem pediu, a conta do alvo e a campanha citada. */
type Apresentacao = {
  pessoas: Map<string, string>;
  contas: Map<string, string>;
  campanhas: Map<string, NonNullable<ActionResponse['campaign']>>;
  /** O pedido de volta mais recente de cada ação. */
  voltas: Map<string, NonNullable<ActionResponse['undone_by']>>;
  /** A recomendação de que cada pedido nasceu, pelo id dela. */
  recomendacoes: Map<string, NonNullable<ActionResponse['recommendation']>>;
  /** A campanha (na lista do Liame) de cada objeto de anúncio, pela chave `conta/recurso`. */
  campanhasDosObjetos: Map<string, { id: string; name: string }>;
  /** A tentativa de execução mais recente de cada pedido. */
  execucoes: Map<string, NonNullable<ActionResponse['execution']>>;
  /** O retrato da mensagem de cada pedido de envio ou de pausa (A5, Y5), pela chave `conta/campanha do RegemCast`. */
  mensagens: Map<string, RetratoDaMensagem>;
};

/** O retrato da mensagem, como a resposta o mostra (sem o plano do disparo, que é de cada pedido). */
type RetratoDaMensagem = Omit<ActionMessage, 'campaign_id' | 'plan'>;
type VariavelGuardada = { origem: string; valor?: string };
type LinhaDaMensagem = {
  connected_account_id: string;
  campaign_id: string;
  name: string;
  template_name: string;
  template_language: string;
  template_category: string | null;
  template_header: string | null;
  template_body: string;
  template_footer: string | null;
  template_buttons: string[];
  variables: VariavelGuardada[];
  header_variable: VariavelGuardada | null;
  audience_name: string;
  audience_rule: string | null;
  people_can_receive: number;
  people_resting: number;
  rest_days: number | null;
  window_days: number[];
  window_start: string;
  window_end: string;
  coupon_code: string | null;
  coupon_rule: RegraDoCupom | null;
  coupon_created_at: Date | string | null;
};

const variavelDaResposta = (v: VariavelGuardada) => ({ origin: v.origem, value: v.valor ?? null });

function retratoDaMensagem(l: LinhaDaMensagem): RetratoDaMensagem {
  const regra = l.coupon_rule;
  return {
    name: l.name,
    template: { name: l.template_name, language: l.template_language, category: l.template_category, header: l.template_header, body: l.template_body, footer: l.template_footer, buttons: l.template_buttons },
    variables: l.variables.map(variavelDaResposta),
    header_variable: l.header_variable ? variavelDaResposta(l.header_variable) : null,
    audience: { name: l.audience_name, rule: l.audience_rule, can_receive: Number(l.people_can_receive), resting: Number(l.people_resting), rest_days: l.rest_days === null ? null : Number(l.rest_days) },
    window: { days: l.window_days.map(Number), start: l.window_start, end: l.window_end },
    coupon:
      l.coupon_code && regra
        ? {
            code: l.coupon_code,
            kind: regra.tipo,
            percent: regra.percentual === undefined ? null : Number(regra.percentual),
            value_cents: regra.valor_centavos ?? null,
            min_order_cents: regra.pedido_minimo_centavos ?? null,
            valid_from: regra.valido_de,
            valid_until: regra.valido_ate,
            created: l.coupon_created_at !== null,
          }
        : null,
  };
}

/** `campanha`, `conjunto` ou `anuncio` quando o recurso é um objeto de anúncio (`tipo:id na plataforma`); senão, nulo. */
function tipoDoObjeto(resourceId: string): 'campanha' | 'conjunto' | 'anuncio' | null {
  const tipo = resourceId.split(':')[0];
  return resourceId.includes(':') && (tipo === 'campanha' || tipo === 'conjunto' || tipo === 'anuncio') ? tipo : null;
}

/** O retrato que a sombra grava com a recomendação (`shadow_decision.state_snapshot`): só o que a resposta mostra. */
type RetratoDaRecomendacao = {
  campanha?: { verba_diaria_micros?: string | null };
  plataforma?: { spend_micros?: string | null };
  caixa?: { orders?: number | null; revenue_micros?: string | null; margin_known_micros?: string | null; margin_coverage_pct?: string | null };
};

/** Como a recusa fica gravada no motivo do pedido (a aba Cupons e a tela Aprovações reconhecem por aqui). */
export const PREFIXO_RECUSA = 'recusada por ';
const ehUuid = (v: unknown): v is string => z.uuid().safeParse(v).success;

type ApprovalRow = {
  action_request_id: string;
  approved_by: string;
  approver_name: string;
  approver_role: string;
  sufficient: boolean;
  plan_hash: string;
  created_at: Date | string;
};

const notFound = () => new AppProblem(404, 'nao-encontrado', 'Não encontramos', 'Ação não encontrada nesta empresa.');
/** O que a pessoa precisa saber quando falta um limite da empresa: quem o define, e onde. */
const ONDE_SE_DEFINE = 'Quem define é o Dono ou o Administrador, em Verba do mês.';
/** O pedido aumenta verba ou volta a gastar numa plataforma de anúncio: passa pela conta do mês inteiro (D-A4-19). */
const sobeOGasto = (connector: Connector, plan: ToolPlan): boolean => connector.requiresSpendLimits && (plan.budgetImpact === 'increase' || plan.budgetImpact === 'new_spend');
const micros = (v: string | null) => (v === null ? null : Number(v));
const brl = (m: number) => (m / 1_000_000).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

/**
 * Action Service, lado do pedido (ADR-007): ferramenta → trava → estado no provedor → política →
 * orçamento (reserva) → aprovação amarrada ao hash do plano. A execução fica no worker (E6d).
 */
@Injectable()
export class ActionService {
  constructor(
    private readonly policies: PolicyService,
    private readonly budget: BudgetService,
    private readonly switches: KillSwitchService,
    private readonly flags: FlagService,
    private readonly mfa: MfaService,
    private readonly mailer: Mailer,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async create(auth: AuthContext, input: CreateActionRequest): Promise<ActionResponse> {
    return this.get(auth, await this.pedir(pessoa(auth), input, null));
  }

  /**
   * O pedido que um funcionário de IA faz no modo Aprovação (A4, X3; D-A4-26), a partir de uma recomendação dele. Quem
   * chama é a rotina do worker, na transação da empresa. O pedido passa pelo mesmo trilho do de uma pessoa (trava, flag
   * de escrita, política, limites da empresa, reserva) e só entra se o modo do funcionário para esta ação nesta conta
   * for Aprovação; depois, espera a aprovação de uma pessoa com o código do app, como qualquer outro. `emNomeDe` é a
   * pessoa que deixou o funcionário pedir (quem publicou a regra do modo): o funcionário nunca pode mais do que ela.
   * A auditoria fica em nome do funcionário. Devolve o id do pedido.
   */
  async pedirPeloFuncionario(
    alvo: { tenantId: string; agentKey: string; agentLabel: string; emNomeDe: string },
    input: CreateActionRequest & { recommendation_id: string },
  ): Promise<string> {
    const tx = currentTx();
    // A flag do modo é conferida aqui também (e não só por quem chama), com a marca da conta do pedido.
    const marca = await this.marcaDoPedido(tx, alvo.tenantId, input);
    if (!(await this.flags.isEnabled('modo_aprovacao', this.flags.context({ tenantId: alvo.tenantId, brandId: marca })))) {
      throw new AppProblem(403, 'modo-aprovacao-desligado', 'Modo Aprovação desligado', 'O modo Aprovação não está liberado para esta empresa: o funcionário de IA não faz pedidos.');
    }
    return this.pedirEmNomeDoFuncionario(alvo, input, { recommendation_id: input.recommendation_id });
  }

  /**
   * O pedido de envio de mensagem que o funcionário de CRM e mensageria propõe (A5, Y5 e Y6; D-A5-11), depois de montar
   * a campanha em rascunho no RegemCast. Quem chama é o serviço do pedido de mensagem, na transação da empresa. Passa
   * pelo mesmo trilho do pedido de uma pessoa (trava, flag de escrita, política) e sempre espera a aprovação com o
   * código do app: a política da distribuição põe `mensagem.*` em Aprovação para quem quer que peça, e a ferramenta
   * tem a trava `alwaysApproval`. Não depende do modo Aprovação do Gestor de tráfego: para mensagem não há sombra nem
   * subida de autonomia nesta fase. `emNomeDe` é a pessoa em nome de quem o funcionário trabalha.
   */
  async pedirMensagemPeloFuncionario(alvo: { tenantId: string; agentKey: string; agentLabel: string; emNomeDe: string }, input: CreateActionRequest): Promise<string> {
    if (input.tool !== 'mensagem_disparar') {
      throw new AppProblem(400, 'ferramenta-nao-e-de-mensagem', 'Não é um envio de mensagem', 'Por aqui o funcionário só pede o envio de uma mensagem.');
    }
    return this.pedirEmNomeDoFuncionario(alvo, input, {});
  }

  /** O pedido do funcionário de IA pelo trilho, com a auditoria em nome dele. `extra` vai para a auditoria. */
  private async pedirEmNomeDoFuncionario(
    alvo: { tenantId: string; agentKey: string; agentLabel: string; emNomeDe: string },
    input: CreateActionRequest,
    extra: Record<string, unknown>,
  ): Promise<string> {
    const tx = currentTx();
    const id = await this.pedir({ tenantId: alvo.tenantId, userId: alvo.emNomeDe, ator: 'agent', agentKey: alvo.agentKey }, input, null);
    const r = await tx.execute<{ tool: string; action: string; mode: string; status: string; plan_hash: string; reserved_micros: string }>(sql`
      select tool, action, mode, status, plan_hash, reserved_micros::text as reserved_micros from liame.action_request where id = ${id} and tenant_id = ${alvo.tenantId}`);
    const feito = r.rows[0]!;
    await writeAudit(tx, {
      tenantId: alvo.tenantId,
      actorType: 'agent',
      actorId: null,
      actorLabel: alvo.agentLabel,
      action: 'acao.pedir',
      resourceType: 'action_request',
      resourceId: id,
      after: {
        tool: feito.tool,
        action: feito.action,
        mode: feito.mode,
        status: feito.status,
        plan_hash: feito.plan_hash,
        reserved_micros: Number(feito.reserved_micros),
        ...extra,
        agent_key: alvo.agentKey,
        on_behalf_of: alvo.emNomeDe,
      },
      tool: feito.tool,
      traceId: activeTraceId(),
      origin: 'worker',
    });
    return id;
  }

  /**
   * A volta de uma ação executada (A4, X2; A4-5): um pedido novo, com a ferramenta inversa, pelo mesmo trilho (trava,
   * flag, política, reserva, aprovação com o código do app, validação e escrita). Só é aceita se o objeto está como a
   * ação o deixou: se alguém mexeu depois, a mudança humana vence e nada é desfeito.
   */
  async undo(auth: AuthContext, id: string): Promise<ActionResponse> {
    const tx = currentTx();
    const tenantId = tenantOf(auth);
    const row = await this.lock(tx, tenantId, id);
    if (row.status !== 'executada') throw new AppProblem(409, 'acao-nao-desfaz', 'Não dá para desfazer', 'Só dá para desfazer uma ação que foi executada.');
    const semVolta = (detalhe: string) => new AppProblem(409, 'acao-sem-volta', 'Esta ação não tem volta', detalhe);
    const volta = TOOLS[row.tool]?.undo;
    if (!volta || !row.before_state) throw semVolta('Esta ação não tem volta pelo Liame.');
    const { tool: inversa, params } = volta(row.before_state);
    if (!TOOLS[inversa]?.providers.includes(row.provider)) throw semVolta('Esta ação não tem volta pelo Liame neste provedor.');
    const jaPedida = await tx.execute<{ id: string }>(sql`
      select id from liame.action_request
       where tenant_id = ${tenantId} and compensates_action_id = ${id} and status in ('aguardando_aprovacao', 'aprovada', 'executando', 'executada')
       limit 1`);
    if (jaPedida.rows[0]) throw new AppProblem(409, 'volta-ja-pedida', 'A volta já foi pedida', 'Já existe um pedido de volta para esta ação.');
    const exec = await tx.execute<{ provider_version: number | null; result_state: Record<string, unknown> | null }>(sql`
      select provider_version, result_state from liame.action_execution
       where action_request_id = ${id} and status = 'executada' order by finished_at desc limit 1`);
    const feita = exec.rows[0];
    if (!feita || feita.provider_version === null) throw semVolta('O Liame não tem o registro de como esta ação deixou o objeto.');
    // O objeto já estava como o pedido queria (alguém fez antes): o Liame não mudou nada, e não desfaz o que não fez.
    if (feita.result_state?.sem_escrita === true) {
      throw semVolta('O objeto já estava assim quando o Liame foi executar: o Liame não mudou nada, então não há o que desfazer por aqui.');
    }
    const pedidoDeVolta = await this.pedir(
      pessoa(auth),
      { tool: inversa, brand_id: row.brand_id, provider: row.provider, account_id: row.account_id, resource_id: row.resource_id, params },
      { de: id, versaoDepois: feita.provider_version },
    );
    return this.get(auth, pedidoDeVolta);
  }

  /**
   * O pedido, do começo ao fim; devolve o id dele. `quem`: a pessoa que pede ou o funcionário de IA (em nome de uma
   * pessoa). `volta`: a ação que este pedido desfaz e a versão em que ela deixou o objeto.
   */
  private async pedir(quem: Solicitante, input: CreateActionRequest, volta: { de: string; versaoDepois: number } | null): Promise<string> {
    const tx = currentTx();
    const tenantId = quem.tenantId;
    const { tool, connector } = this.resolve(input.tool, input.provider);
    if (input.brand_id) await this.assertBrand(tx, tenantId, input.brand_id);
    const brandId = await this.marcaDoPedido(tx, tenantId, input);
    const target = { tenantId, provider: input.provider, brandId, accountId: input.account_id, tool: tool.name };
    await this.assertNotStopped(tx, target);
    await this.assertWriteEnabled(quem, connector, brandId, input.account_id);

    const params = this.parseParams(tool, input.params);
    // O pedido que nasce de uma recomendação (X3): o alvo é conferido antes de gastar a leitura na plataforma.
    const recomendacao = input.recommendation_id ? await this.recomendacaoDoPedido(tx, tenantId, input.recommendation_id, input) : null;
    const read = await this.lerNoProvedor(connector, tx, { tenantId, accountId: input.account_id, resourceId: input.resource_id });
    // A volta só vale sobre o que a ação deixou: outra versão é sinal de que alguém mexeu depois.
    if (volta && read.version !== volta.versaoDepois) {
      throw new AppProblem(409, 'estado-mudou', 'Alguém mexeu depois', 'O objeto mudou depois desta ação. A volta não é feita, para não sobrescrever o que foi mudado.');
    }
    const plan = this.planejar(tool, read.state, params);
    // Com o estado lido, a direção: reduzir quando a recomendação é de reduzir (o valor pode ser outro).
    if (recomendacao) naoLiga(direcaoDaRecomendacao(recomendacao.tool, plan.action));
    const decision = await inSpan('politica.avaliar', { 'liame.tool': tool.name, 'liame.action': plan.action }, () =>
      this.decide(tx, tenantId, brandId, tool, connector, input, plan, Boolean(volta), quem.ator),
    );
    // O funcionário de IA só pede no modo Aprovação (D-A4-26): em Sombra ou em Sugerir quem pede é a pessoa, e os modos
    // automáticos não existem nesta fase. A regra é conferida aqui, com a política de agora, e não só por quem chama.
    if (quem.ator === 'agent' && decision.mode !== 'APPROVAL') {
      throw new AppProblem(409, 'modo-nao-e-aprovacao', 'O modo não é Aprovação', `Nesta conta, esta ação está em ${decision.mode} para o funcionário de IA: ele não faz o pedido.`);
    }

    const id = uuidv7();
    const { mode, status, reason } = await this.statusFor(decision.mode, quem, brandId, tool);
    const fingerprint = sha256(canonicalJson({ tenantId, tool: tool.name, provider: input.provider, account: input.account_id, resource: input.resource_id }));
    const planHash = planHashOf({ ...input, brand_id: brandId, tool: tool.name, params }, plan, read.version);
    try {
      await tx.execute(sql`
        insert into liame.action_request (id, tenant_id, brand_id, tool, action, provider, account_id, resource_id, params, risk_level,
                                          budget_impact, value_micros, current_value_micros, reserved_micros, before_state, before_version,
                                          desired_state, plan_hash, action_fingerprint, mode, policy_decision, status, status_reason,
                                          requested_by, expires_at, trace_context, compensates_action_id, shadow_decision_id,
                                          actor_type, agent_key)
        values (${id}, ${tenantId}, ${brandId}, ${tool.name}, ${plan.action}, ${input.provider}, ${input.account_id},
                ${input.resource_id}, ${JSON.stringify(params)}::jsonb, ${tool.risk}, ${plan.budgetImpact}, ${plan.valueMicros},
                ${plan.currentValueMicros}, ${status === 'sombra' ? 0 : plan.reserveMicros}, ${JSON.stringify(read.state)}::jsonb,
                ${read.version}, ${JSON.stringify(plan.desiredState)}::jsonb, ${planHash}, ${fingerprint}, ${mode},
                ${JSON.stringify(decision)}::jsonb, ${status}, ${reason}, ${quem.userId},
                now() + make_interval(hours => ${ACTION_TTL_HOURS}), ${currentTraceparent()}, ${volta?.de ?? null}, ${recomendacao?.id ?? null},
                ${quem.ator}, ${quem.agentKey})`);
    } catch (err) {
      const causa = (err as { cause?: { code?: string; constraint?: string } }).cause;
      // Duas voltas da mesma ação ao mesmo tempo (a trava da ação original já barra; o índice é a segunda barreira).
      if (causa?.code === '23505' && causa.constraint === 'uq_action_volta_viva') {
        throw new AppProblem(409, 'volta-ja-pedida', 'A volta já foi pedida', 'Já existe um pedido de volta para esta ação.');
      }
      // Outro pedido ativo para a mesma ferramenta no mesmo recurso (A1-8): inclusive dois ao mesmo tempo.
      if (causa?.code === '23505') {
        throw new AppProblem(409, 'acao-duplicada', 'Já existe um pedido igual', 'Já há um pedido ativo desta ferramenta para este recurso. Aprove, altere ou cancele o que existe.');
      }
      throw err;
    }
    if (status !== 'sombra') {
      await inSpan('orcamento.reservar', { 'liame.action_id': id }, () =>
        this.budget.reserve(tx, { tenantId, brandId, actionId: id, amountMicros: plan.reserveMicros, sobeOGasto: sobeOGasto(connector, plan) }),
      );
    }
    await advance(tx, { tenantId, kind: 'acao', subjectId: id, ...flowAfterRequest(status, mode, decision, plan.reserveMicros) });
    await emitEvent(tx, { tenantId, type: 'liame.action.requested', subject: id, data: { action_id: id, tool: tool.name, action: plan.action, mode, status } });
    auditDetail({
      resourceId: id,
      after: {
        tool: tool.name,
        action: plan.action,
        mode,
        status,
        plan_hash: planHash,
        reserved_micros: plan.reserveMicros,
        ...(volta ? { volta_de: volta.de } : {}),
        ...(recomendacao ? { recommendation_id: recomendacao.id } : {}),
      },
    });
    return id;
  }

  /**
   * A recomendação de que o pedido diz nascer (A4, X3), lida sob a RLS da empresa: a de outra empresa não existe. Ela
   * precisa estar em aberto e ser da conta e da campanha do pedido; a direção é conferida depois, com o plano.
   */
  private async recomendacaoDoPedido(
    tx: Tx,
    tenantId: string,
    id: string,
    pedido: Pick<CreateActionRequest, 'provider' | 'account_id' | 'resource_id'>,
  ): Promise<{ id: string; tool: AcaoSombra }> {
    const r = await tx.execute<{ id: string; tool: AcaoSombra; status: string; provider: string; connected_account_id: string; external_id: string }>(sql`
      select d.id, d.tool, d.status, d.provider, d.connected_account_id, c.external_id
        from liame.shadow_decision d join liame.campaign c on c.id = d.campaign_id
       where d.id = ${id} and d.tenant_id = ${tenantId}`);
    const d = r.rows[0];
    if (!d) throw new AppProblem(404, 'nao-encontrado', 'Não encontramos', 'Recomendação não encontrada nesta empresa.');
    naoLiga(
      alvoDaRecomendacao(
        { tool: d.tool, status: d.status, provider: d.provider, connectedAccountId: d.connected_account_id, campanhaExterna: d.external_id },
        { provider: pedido.provider, accountId: pedido.account_id, resourceId: pedido.resource_id },
      ),
    );
    return { id: d.id, tool: d.tool };
  }

  /**
   * A marca do pedido. Quando o alvo é uma conta conectada, é a marca dela: o pedido não escolhe outra (nem nenhuma),
   * para a política, o envelope, a trava e as flags da marca valerem sempre. No sandbox (conta de mentira), é a do pedido.
   */
  private async marcaDoPedido(tx: Tx, tenantId: string, input: Pick<CreateActionRequest, 'brand_id' | 'account_id'>): Promise<string | null> {
    const pedida = input.brand_id ?? null;
    if (!ehUuid(input.account_id)) return pedida;
    const r = await tx.execute<{ brand_id: string }>(sql`
      select brand_id from liame.connected_account where id = ${input.account_id} and tenant_id = ${tenantId} and disconnected_at is null`);
    const daConta = r.rows[0]?.brand_id;
    // Conta que a empresa não tem: segue como veio, e o conector responde "não existe".
    if (!daConta) return pedida;
    if (pedida && pedida !== daConta) {
      throw new AppProblem(422, 'marca-nao-confere', 'A conta é de outra marca', 'A conta deste pedido pertence a outra marca da empresa. Peça pela marca da conta.');
    }
    return daConta;
  }

  /** Mudar os parâmetros gera plano novo: a aprovação dada ao plano anterior deixa de valer. */
  async update(auth: AuthContext, id: string, input: UpdateActionRequest): Promise<ActionResponse> {
    const tx = currentTx();
    const tenantId = tenantOf(auth);
    const row = await this.lock(tx, tenantId, id);
    if (row.status !== 'aguardando_aprovacao' && row.status !== 'sombra') {
      throw new AppProblem(409, 'acao-nao-altera', 'Não dá para alterar', 'Só se altera um pedido que ainda espera aprovação.');
    }
    // A volta devolve o que estava antes: não tem parâmetro para escolher. Para mudar de ideia, cancela-se a volta.
    if (row.compensates_action_id) throw new AppProblem(409, 'acao-nao-altera', 'Não dá para alterar', 'O pedido de volta não se altera: cancele e peça outra ação.');
    const { tool, connector } = this.resolve(row.tool, row.provider);
    const params = this.parseParams(tool, input.params);
    const read = await this.lerNoProvedor(connector, tx, { tenantId, accountId: row.account_id, resourceId: row.resource_id });
    const plan = this.planejar(tool, read.state, params);
    const request = { brand_id: row.brand_id, provider: row.provider, account_id: row.account_id, resource_id: row.resource_id, tool: row.tool, params };
    // Quem altera é uma pessoa: o plano novo é avaliado como pedido dela, também no pedido que o funcionário de IA fez.
    const decision = await this.decide(tx, tenantId, row.brand_id, tool, connector, request, plan);
    const { mode, status, reason } = await this.statusFor(decision.mode, { tenantId, userId: auth.userId }, row.brand_id, tool);
    const planHash = planHashOf(request, plan, read.version);
    // O pedido que nasceu de uma recomendação e passa a fazer outra coisa (de reduzir para aumentar) deixa de ser dela:
    // a ligação sai, para a prontidão do funcionário não contar o que a pessoa decidiu por conta própria.
    const recomendacao = row.shadow_decision_id !== null && plan.action === row.action ? row.shadow_decision_id : null;

    await this.budget.release(tx, tenantId, id);
    await tx.execute(sql`
      update liame.action_request
         set params = ${JSON.stringify(params)}::jsonb, action = ${plan.action}, budget_impact = ${plan.budgetImpact},
             value_micros = ${plan.valueMicros}, current_value_micros = ${plan.currentValueMicros},
             reserved_micros = ${status === 'sombra' ? 0 : plan.reserveMicros}, before_state = ${JSON.stringify(read.state)}::jsonb,
             before_version = ${read.version}, desired_state = ${JSON.stringify(plan.desiredState)}::jsonb, plan_hash = ${planHash},
             mode = ${mode}, policy_decision = ${JSON.stringify(decision)}::jsonb, status = ${status}, status_reason = ${reason},
             shadow_decision_id = ${recomendacao}, updated_at = now()
       where id = ${id} and tenant_id = ${tenantId}`);
    if (status !== 'sombra') {
      await this.budget.reserve(tx, { tenantId, brandId: row.brand_id, actionId: id, amountMicros: plan.reserveMicros, sobeOGasto: sobeOGasto(connector, plan) });
    }
    await advance(tx, { tenantId, kind: 'acao', subjectId: id, ...flowAfterRequest(status, mode, decision, plan.reserveMicros) });
    auditDetail({
      before: { plan_hash: row.plan_hash, params: row.params },
      after: { plan_hash: planHash, params, mode, status, ...(row.shadow_decision_id && !recomendacao ? { recommendation_unlinked: row.shadow_decision_id } : {}) },
    });
    return this.get(auth, id);
  }

  /**
   * Conferir de novo (A5, Y5): lê o recurso na plataforma e guarda no pedido o plano de agora, sem mudar o que foi
   * pedido. Só para a ferramenta cujo plano muda sozinho (`revalidateOnApproval`: a mensagem, que espera a Meta aprovar
   * o modelo ou o teto de gasto caber) e só no pedido que espera aprovação. Com o plano novo, o hash muda: a aprovação
   * dada ao plano anterior deixa de valer, como em alterar. A política não é avaliada de novo: o pedido é o mesmo.
   */
  async recheck(auth: AuthContext, id: string): Promise<ActionResponse> {
    const tx = currentTx();
    const tenantId = tenantOf(auth);
    const row = await this.lock(tx, tenantId, id);
    if (row.status !== 'aguardando_aprovacao') {
      throw new AppProblem(409, 'acao-nao-aguarda', 'Não espera aprovação', 'Este pedido não está esperando aprovação.');
    }
    const { tool, connector } = this.resolve(row.tool, row.provider);
    if (!tool.revalidateOnApproval) {
      throw new AppProblem(409, 'acao-nao-confere', 'Não há o que conferir', 'O plano deste pedido não muda sozinho. Para mudar o pedido, altere-o.');
    }
    const read = await this.lerNoProvedor(connector, tx, { tenantId, accountId: row.account_id, resourceId: row.resource_id });
    const plan = this.planejar(tool, read.state, row.params);
    const request = { brand_id: row.brand_id, provider: row.provider, account_id: row.account_id, resource_id: row.resource_id, tool: row.tool, params: row.params };
    const planHash = planHashOf(request, plan, read.version);
    if (planHash !== row.plan_hash) {
      await this.budget.release(tx, tenantId, id);
      await tx.execute(sql`
        update liame.action_request
           set action = ${plan.action}, budget_impact = ${plan.budgetImpact}, value_micros = ${plan.valueMicros},
               current_value_micros = ${plan.currentValueMicros}, reserved_micros = ${plan.reserveMicros},
               before_state = ${JSON.stringify(read.state)}::jsonb, before_version = ${read.version},
               desired_state = ${JSON.stringify(plan.desiredState)}::jsonb, plan_hash = ${planHash}, updated_at = now()
         where id = ${id} and tenant_id = ${tenantId}`);
      await this.budget.reserve(tx, { tenantId, brandId: row.brand_id, actionId: id, amountMicros: plan.reserveMicros, sobeOGasto: sobeOGasto(connector, plan) });
    }
    auditDetail({ before: { plan_hash: row.plan_hash }, after: { plan_hash: planHash, changed: planHash !== row.plan_hash, blocked: Boolean(plan.blocked) } });
    return this.get(auth, id);
  }

  /**
   * Aprovar (ADR-007, ADR-017): código do app agora, para o plano que a pessoa viu. Basta sozinha quando o
   * limite dela cobre o valor; acima disso (ou se o modo é ESCALATE), falta o dono.
   */
  async approve(auth: AuthContext, id: string, input: ApproveActionRequest): Promise<ActionResponse> {
    const tx = currentTx();
    const tenantId = tenantOf(auth);
    const row = await this.lock(tx, tenantId, id);
    if (row.status !== 'aguardando_aprovacao') {
      throw new AppProblem(409, 'acao-nao-aguarda', 'Não espera aprovação', 'Este pedido não está esperando aprovação.');
    }
    if (row.plan_hash !== input.plan_hash) {
      throw new AppProblem(409, 'plano-mudou', 'O plano mudou', 'O pedido foi alterado depois que você abriu. Confira o plano novo e aprove de novo.');
    }
    // O plano de uma mensagem muda sozinho na plataforma: a pessoa aprova o de agora (A5, Y5). Antes do código do app,
    // para ela não gastar um código num pedido que ainda não pode ser aprovado.
    if (TOOLS[row.tool]?.revalidateOnApproval) await this.conferirOPlanoDeAgora(tx, tenantId, row);
    await this.mfa.verifyStepUp(tx, auth.userId, input.code);

    const m = await tx.execute<{ role_key: string; approve_limit_micros: string | null }>(sql`
      select role_key, approve_limit_micros from liame.membership
       where tenant_id = ${tenantId} and user_id = ${auth.userId} and revoked_at is null`);
    const role = m.rows[0]?.role_key ?? auth.roleKey ?? '';
    const limit = micros(m.rows[0]?.approve_limit_micros ?? null);
    const amount = Number(row.reserved_micros);
    const sufficient = role === 'dono' || (row.mode !== 'ESCALATE' && (limit === null || amount <= limit));
    try {
      await tx.execute(sql`
        insert into liame.approval (id, tenant_id, action_request_id, plan_hash, approved_by, approver_role, approver_limit_micros, sufficient, method)
        values (${uuidv7()}, ${tenantId}, ${id}, ${row.plan_hash}, ${auth.userId}, ${role}, ${limit}, ${sufficient}, 'totp')`);
    } catch (err) {
      if ((err as { cause?: { code?: string } }).cause?.code === '23505') {
        throw new AppProblem(409, 'ja-aprovou', 'Você já aprovou', 'Sua aprovação para este plano já está registrada.');
      }
      throw err;
    }
    if (sufficient) {
      await tx.execute(sql`update liame.action_request set status = 'aprovada', status_reason = null, updated_at = now() where id = ${id}`);
      await advance(tx, {
        tenantId,
        kind: 'acao',
        subjectId: id,
        steps: [
          { name: 'aprovacao', status: 'concluido', output: { plan_hash: row.plan_hash, approved_by: auth.userId } },
          { name: 'execucao', status: 'aguardando' },
        ],
        run: 'em_andamento',
      });
      await emitEvent(tx, { tenantId, type: 'liame.action.approved', subject: id, data: { action_id: id, plan_hash: row.plan_hash } });
    } else {
      await this.notifyOwners(tx, tenantId, row, auth.name);
    }
    auditDetail({ after: { plan_hash: row.plan_hash, sufficient, amount_micros: amount } });
    return this.get(auth, id);
  }

  /**
   * A aprovação que lê o recurso de novo (A5, Y5: a mensagem de WhatsApp; `revalidateOnApproval`). O plano guardado no
   * pedido é o da hora em que ele foi feito ou conferido, e a plataforma pode ter mudado desde então. Com um
   * impedimento, ninguém aprova: o pedido espera. Com o plano diferente do que a pessoa viu, ela confere o de agora
   * (alterar o pedido com os mesmos parâmetros lê e guarda o plano novo) e aprova de novo.
   */
  private async conferirOPlanoDeAgora(tx: Tx, tenantId: string, row: ActionRow): Promise<void> {
    const { tool, connector } = this.resolve(row.tool, row.provider);
    const read = await this.lerNoProvedor(connector, tx, { tenantId, accountId: row.account_id, resourceId: row.resource_id });
    const plan = this.planejar(tool, read.state, row.params);
    if (plan.blocked) throw new AppProblem(409, 'pedido-impedido', 'Ainda não dá para aprovar', plan.blocked);
    const request = { brand_id: row.brand_id, provider: row.provider, account_id: row.account_id, resource_id: row.resource_id, tool: row.tool, params: row.params };
    if (planHashOf(request, plan, read.version) !== row.plan_hash) {
      throw new AppProblem(409, 'plano-mudou', 'O plano mudou', 'O plano deste pedido mudou na plataforma depois que ele foi feito. Confira o plano de agora e aprove de novo.');
    }
  }

  /**
   * Recusar (quem pode aprovar): o pedido sai da fila, a reserva volta ao envelope e nada é executado. O motivo
   * fica no pedido, com o nome de quem recusou, e na auditoria. Não pede o código do app: recusar não executa nada.
   */
  async reject(auth: AuthContext, id: string, input: RejectActionRequest): Promise<ActionResponse> {
    const tx = currentTx();
    const tenantId = tenantOf(auth);
    const row = await this.lock(tx, tenantId, id);
    if (row.status !== 'aguardando_aprovacao') {
      throw new AppProblem(409, 'acao-nao-aguarda', 'Não espera aprovação', 'Este pedido não está esperando aprovação.');
    }
    if (row.plan_hash !== input.plan_hash) {
      throw new AppProblem(409, 'plano-mudou', 'O plano mudou', 'O pedido foi alterado depois que você abriu. Confira o plano novo antes de recusar.');
    }
    const motivo = `${PREFIXO_RECUSA}${auth.name}: ${input.reason}`;
    await tx.execute(sql`update liame.action_request set status = 'cancelada', status_reason = ${motivo}, updated_at = now() where id = ${id}`);
    const released = await this.budget.release(tx, tenantId, id);
    await advance(tx, {
      tenantId,
      kind: 'acao',
      subjectId: id,
      steps: [
        { name: 'aprovacao', status: 'falhou', output: { motivo: 'recusada', por: auth.userId } },
        { name: 'execucao', status: 'pulado', output: { motivo: 'recusada' } },
      ],
      run: 'cancelado',
    });
    await emitEvent(tx, { tenantId, type: 'liame.action.cancelled', subject: id, data: { action_id: id, rejected: true } });
    auditDetail({ before: { status: row.status, plan_hash: row.plan_hash }, after: { status: 'cancelada', recusada: true, reason: input.reason, released_micros: released } });
    return this.get(auth, id);
  }

  async cancel(auth: AuthContext, id: string): Promise<ActionResponse> {
    const tx = currentTx();
    const tenantId = tenantOf(auth);
    const row = await this.lock(tx, tenantId, id);
    if (!['sombra', 'aguardando_aprovacao', 'aprovada'].includes(row.status)) {
      throw new AppProblem(409, 'acao-nao-cancela', 'Não dá para cancelar', 'A ação já está em execução ou terminou.');
    }
    await tx.execute(sql`update liame.action_request set status = 'cancelada', status_reason = 'cancelada por quem opera', updated_at = now() where id = ${id}`);
    const released = await this.budget.release(tx, tenantId, id);
    await advance(tx, { tenantId, kind: 'acao', subjectId: id, steps: [{ name: 'execucao', status: 'pulado', output: { motivo: 'cancelada' } }], run: 'cancelado' });
    await emitEvent(tx, { tenantId, type: 'liame.action.cancelled', subject: id, data: { action_id: id } });
    auditDetail({ before: { status: row.status }, after: { status: 'cancelada', released_micros: released } });
    return this.get(auth, id);
  }

  async list(auth: AuthContext, status?: ActionStatus): Promise<ActionResponse[]> {
    const tx = currentTx();
    const r = await tx.execute<ActionRow>(sql`
      select * from liame.action_request where tenant_id = ${tenantOf(auth)} ${status ? sql`and status = ${status}` : sql``}
       order by created_at desc limit 100`);
    const ids = r.rows.map((x) => x.id);
    const [approvals, flows, ap] = [await this.approvalsOf(tx, ids), await workflowOf(tx, 'acao', ids), await this.apresentacaoDe(tx, r.rows, veVendas(auth))];
    return r.rows.map((row) => toResponse(row, approvals, flows.get(row.id) ?? null, ap));
  }

  async get(auth: AuthContext, id: string): Promise<ActionResponse> {
    const tx = currentTx();
    const r = await tx.execute<ActionRow>(sql`select * from liame.action_request where id = ${id} and tenant_id = ${tenantOf(auth)}`);
    const row = r.rows[0];
    if (!row) throw notFound();
    return toResponse(row, await this.approvalsOf(tx, [id]), (await workflowOf(tx, 'acao', [id])).get(id) ?? null, await this.apresentacaoDe(tx, [row], veVendas(auth)));
  }

  // ------------------------------------------------------------------ sandbox

  async putSandbox(auth: AuthContext, input: SandboxResourceRequest): Promise<SandboxResourceResponse> {
    const tenantId = tenantOf(auth);
    const r = await currentTx().execute<{ state: Record<string, unknown>; version: number }>(sql`
      insert into liame.sandbox_resource (tenant_id, account_id, resource_id, state)
      values (${tenantId}, ${input.account_id}, ${input.resource_id}, ${JSON.stringify(input.state)}::jsonb)
      on conflict (tenant_id, account_id, resource_id)
        do update set state = excluded.state, version = liame.sandbox_resource.version + 1, updated_at = now()
      returning state, version`);
    auditDetail({ resourceId: `${input.account_id}/${input.resource_id}` });
    return { account_id: input.account_id, resource_id: input.resource_id, state: r.rows[0]!.state, version: r.rows[0]!.version };
  }

  // ------------------------------------------------------------------ apoio

  private resolve(toolName: string, provider: string): { tool: ToolDefinition; connector: Connector } {
    const tool = TOOLS[toolName];
    if (!tool) throw new AppProblem(400, 'ferramenta-desconhecida', 'Ferramenta desconhecida', `Não existe a ferramenta "${toolName}".`);
    const connector = CONNECTORS[provider];
    if (!connector || !tool.providers.includes(provider)) {
      throw new AppProblem(400, 'provedor-nao-suportado', 'Provedor não suportado', `A ferramenta ${tool.name} não atende o provedor "${provider}".`);
    }
    return { tool, connector };
  }

  /** O plano da ferramenta; o que ela recusa pelo estado do recurso (`PlanoRecusado`) volta como 422, com o motivo. */
  private planejar(tool: ToolDefinition, before: ResourceState, params: Record<string, unknown>): ToolPlan {
    try {
      return tool.plan(before, params);
    } catch (err) {
      if (err instanceof PlanoRecusado) throw new AppProblem(422, 'plano-recusado', 'Não dá para pedir isto', err.message);
      throw err;
    }
  }

  private parseParams(tool: ToolDefinition, params: Record<string, unknown>): Record<string, unknown> {
    const parsed = tool.params.safeParse(params);
    if (!parsed.success) {
      throw new ValidationProblem(issuesToErrors(parsed.error.issues).map((e) => ({ ...e, path: `params.${e.path}` })));
    }
    return parsed.data;
  }

  private async assertNotStopped(tx: Tx, target: Parameters<KillSwitchService['check']>[1]): Promise<void> {
    const stop = await this.switches.check(tx, target);
    if (stop) {
      throw new AppProblem(423, 'parada-acionada', 'Execução parada', `Há uma trava ativa (nível ${stop.level}): ${stop.reason}`);
    }
  }

  private async assertWriteEnabled(quem: Solicitante, connector: Connector, brandId: string | null, accountId: string): Promise<void> {
    if (!connector.writeFlag) return;
    const on = await this.flags.isEnabled(connector.writeFlag, this.flags.context({ tenantId: quem.tenantId, userId: quem.userId, brandId, accountId }));
    if (!on) throw new AppProblem(403, 'escrita-desligada', 'Escrita desligada', `A escrita em ${connector.provider} não está liberada para esta conta.`);
  }

  /**
   * Lê o estado do recurso no provedor. Com conector de plataforma (Meta), a leitura é uma chamada de verdade e pode
   * falhar: cada falha vira um problema que a pessoa entende, em vez de um erro interno.
   */
  private async lerNoProvedor(connector: Connector, tx: Tx, ref: ResourceRef): Promise<ReadResult> {
    let read: ReadResult | null;
    try {
      read = await connector.read(tx, ref);
    } catch (err) {
      throw problemaDaLeitura(connector.provider, err) ?? err;
    }
    if (!read) throw recursoNaoEncontrado();
    return read;
  }

  /**
   * No provedor que gasta dinheiro de mídia de verdade (a Meta), aumentar a verba ou voltar a gastar pede dois limites
   * que só a empresa define (A4, D-A4-13 e D-A4-19): o teto por campanha e o teto do mês. Sem eles, o pedido é negado,
   * em vez de seguir sem limite. A volta de uma ação fica fora do teto por campanha (devolve o valor de antes), mas não
   * do teto do mês.
   */
  private async exigirLimitesDaEmpresa(tx: Tx, tenantId: string, brandId: string | null, connector: Connector, plan: ToolPlan, policies: LoadedPolicy[], volta: boolean): Promise<void> {
    if (!connector.requiresSpendLimits || (plan.budgetImpact !== 'increase' && plan.budgetImpact !== 'new_spend')) return;
    const aumento = plan.budgetImpact === 'increase' && !volta;
    const osDois = `Para aumentar a verba, a empresa precisa definir antes o teto do mês e o teto por campanha. Reduzir e pausar não dependem deles. ${ONDE_SE_DEFINE}`;
    if (aumento) {
      const temTeto = policies.some(
        (p) =>
          p.source !== 'platform' &&
          p.document.rules.some((r) => r.type === 'max_value' && actionMatches(r.action, plan.action) && (!r.provider || r.provider === connector.provider)),
      );
      if (!temTeto) throw new AppProblem(422, 'teto-nao-definido', 'Falta o teto por campanha', osDois);
    }
    const envelope = await tx.execute(sql`select 1 from liame.budget_policy where tenant_id = ${tenantId} and (brand_id is null or brand_id = ${brandId}) limit 1`);
    if (!envelope.rows[0]) {
      const so = volta
        ? 'Para desfazer esta ação, a empresa precisa definir antes o teto do mês: a volta faz o gasto subir.'
        : 'Para retomar, a empresa precisa definir antes o teto do mês. Reduzir e pausar não dependem dele.';
      throw new AppProblem(422, 'envelope-nao-definido', 'Falta o teto do mês', aumento ? osDois : `${so} ${ONDE_SE_DEFINE}`);
    }
  }

  /**
   * As execuções recentes que contam para cada regra de frequência que vale para a ação: as ações do padrão da regra
   * (`orcamento.*` conta aumentar e reduzir), na janela dela, na conta ou só no mesmo recurso (`per`).
   */
  private async execucoesRecentes(
    tx: Tx,
    tenantId: string,
    policies: LoadedPolicy[],
    alvo: { provider: string; account_id: string; resource_id: string },
    action: string,
  ): Promise<Map<PolicyRule, number>> {
    const recent = new Map<PolicyRule, number>();
    for (const rule of rateLimitsFor(policies, { action, provider: alvo.provider })) {
      const daAcao = !rule.action ? sql`` : rule.action.endsWith('.*') ? sql`and starts_with(action, ${rule.action.slice(0, -1)})` : sql`and action = ${rule.action}`;
      const doRecurso = rule.per === 'resource' ? sql`and resource_id = ${alvo.resource_id}` : sql``;
      const r = await tx.execute<{ n: number }>(sql`
        select count(*)::int as n from liame.action_request
         where tenant_id = ${tenantId} and provider = ${alvo.provider} and account_id = ${alvo.account_id} ${doRecurso} ${daAcao}
           and status in ('executada', 'executando', 'aprovada') and updated_at > now() - make_interval(mins => ${rule.window_minutes})`);
      recent.set(rule, r.rows[0]?.n ?? 0);
    }
    return recent;
  }

  /** Política (plataforma + empresa + marca) com a contagem recente para os limites de frequência. */
  private async decide(
    tx: Tx,
    tenantId: string,
    brandId: string | null,
    tool: ToolDefinition,
    connector: Connector,
    input: { provider: string; account_id: string; resource_id: string },
    plan: ToolPlan,
    volta = false,
    ator: Solicitante['ator'] = 'human',
  ): Promise<PolicyDecision> {
    const { policies, timezone } = await this.policies.load(tx, tenantId, brandId);
    await this.exigirLimitesDaEmpresa(tx, tenantId, brandId, connector, plan, policies, volta);
    const recent = await this.execucoesRecentes(tx, tenantId, policies, input, plan.action);
    const proposal: ActionProposal = {
      tool: tool.name,
      action: plan.action,
      brand_id: brandId,
      provider: input.provider,
      account_id: input.account_id,
      risk_level: tool.risk,
      budget_impact: plan.budgetImpact,
      value_micros: plan.valueMicros,
      current_value_micros: plan.currentValueMicros,
      categories: [],
      text: null,
      recent_count: Math.max(0, ...recent.values()),
      // Quem pede: uma pessoa (a regra da distribuição para a Meta manda esperar aprovação) ou o funcionário de IA (vale
      // o modo dele nesta conta, a regra com `actor: 'agent'`).
      actor: ator,
      ...(volta ? { undo: true } : {}),
    };
    const decision = evaluatePolicy(policies, proposal, { at: new Date(), timezone, recent });
    if (!decision.allowed) {
      throw new AppProblem(
        422,
        'politica-negou',
        'A política não permite',
        'Esta ação fere uma regra da política da empresa ou da plataforma.',
        {},
        decision.violations.map((v) => ({ path: `politica.${v.source}.${v.rule_index}`, message: v.message })),
      );
    }
    return decision;
  }

  /**
   * Autonomia sem o autopilot ligado volta para aprovação (ADR-012: flag de escrita nasce desligada). A ferramenta que
   * sempre espera uma pessoa (`alwaysApproval`) volta para aprovação mesmo com ele ligado.
   */
  private async statusFor(
    mode: AutonomyMode,
    quem: Pick<Solicitante, 'tenantId' | 'userId'>,
    brandId: string | null,
    tool?: Pick<ToolDefinition, 'alwaysApproval'>,
  ): Promise<{ mode: AutonomyMode; status: ActionStatus; reason: string | null }> {
    if (mode === 'SHADOW') return { mode, status: 'sombra', reason: 'modo sombra: registra, não executa' };
    if (mode === 'LIMITED_AUTO' || mode === 'AUTO') {
      if (tool?.alwaysApproval) return { mode: 'APPROVAL', status: 'aguardando_aprovacao', reason: `autonomia ${mode} pedida, mas esta ação sempre espera a aprovação de uma pessoa` };
      const autopilot = await this.flags.isEnabled('autopilot', this.flags.context({ tenantId: quem.tenantId, userId: quem.userId, brandId }));
      if (autopilot) return { mode, status: 'aprovada', reason: 'aprovada pela política (autonomia)' };
      return { mode: 'APPROVAL', status: 'aguardando_aprovacao', reason: `autonomia ${mode} pedida, mas o autopilot está desligado` };
    }
    return { mode, status: 'aguardando_aprovacao', reason: mode === 'ESCALATE' ? 'precisa do dono' : null };
  }

  private async lock(tx: Tx, tenantId: string, id: string): Promise<ActionRow> {
    const r = await tx.execute<ActionRow>(sql`select * from liame.action_request where id = ${id} and tenant_id = ${tenantId} for update`);
    const row = r.rows[0];
    if (!row) throw notFound();
    return row;
  }

  private async assertBrand(tx: Tx, tenantId: string, brandId: string): Promise<void> {
    const b = await tx.execute(sql`select 1 from liame.brand where id = ${brandId} and tenant_id = ${tenantId}`);
    if (!b.rows[0]) throw new AppProblem(404, 'nao-encontrado', 'Não encontramos', 'Marca não encontrada nesta empresa.');
  }

  /**
   * Os nomes que a tela precisa, lidos de uma vez para a página inteira (sob a RLS da empresa). `comVendas`: os números
   * do caixa no retrato da recomendação (pedidos, receita, margem) só saem para quem vê as vendas.
   */
  private async apresentacaoDe(tx: Tx, rows: ActionRow[], comVendas: boolean): Promise<Apresentacao> {
    const ap: Apresentacao = { pessoas: new Map(), contas: new Map(), campanhas: new Map(), voltas: new Map(), recomendacoes: new Map(), campanhasDosObjetos: new Map(), execucoes: new Map(), mensagens: new Map() };
    if (!rows.length) return ap;
    // O retrato da mensagem (A5, Y5): o envio e a pausa são da mesma campanha em rascunho que o Liame montou.
    const deMensagem = rows.filter((r) => r.provider === 'regemcast' && mensagemDoRecurso(r.resource_id) !== null);
    if (deMensagem.length) {
      const m = await tx.execute<LinhaDaMensagem>(sql`
        select connected_account_id, campaign_id, name, template_name, template_language, template_category, template_header, template_body,
               template_footer, template_buttons, variables, header_variable, audience_name, audience_rule, people_can_receive,
               people_resting, rest_days, window_days, window_start, window_end, coupon_code, coupon_rule, coupon_created_at
          from liame.message_request
         where connected_account_id in ${[...new Set(deMensagem.map((r) => r.account_id))]}
           and campaign_id in ${[...new Set(deMensagem.map((r) => mensagemDoRecurso(r.resource_id)!))]}`);
      for (const l of m.rows) ap.mensagens.set(`${l.connected_account_id}/${l.campaign_id}`, retratoDaMensagem(l));
    }
    const recomendacoes = [...new Set(rows.map((r) => r.shadow_decision_id).filter((id): id is string => id !== null))];
    if (recomendacoes.length) {
      const d = await tx.execute<{
        id: string;
        tool: string;
        rule_key: string;
        rule_version: number;
        confidence_pct: string;
        percent: number | string | null;
        decided_on: string;
        window_from: string;
        window_to: string;
        state_snapshot: RetratoDaRecomendacao;
      }>(sql`
        select id, tool, rule_key, rule_version, to_char(confidence * 100, 'FM990.0') as confidence_pct, (params->>'percent')::numeric::integer as percent,
               decided_on::text as decided_on, window_from::text as window_from, window_to::text as window_to, state_snapshot
          from liame.shadow_decision where id in ${recomendacoes}`);
      for (const l of d.rows) {
        const caixa = comVendas ? l.state_snapshot.caixa : undefined;
        ap.recomendacoes.set(l.id, {
          id: l.id,
          tool: l.tool,
          rule: l.rule_key,
          rule_version: Number(l.rule_version),
          confidence_pct: l.confidence_pct,
          percent: l.percent === null ? null : Number(l.percent),
          decided_on: l.decided_on,
          window: { from: l.window_from, to: l.window_to },
          daily_budget_micros: l.state_snapshot.campanha?.verba_diaria_micros ?? null,
          spend_micros: l.state_snapshot.plataforma?.spend_micros ?? null,
          orders: caixa?.orders ?? null,
          revenue_micros: caixa?.revenue_micros ?? null,
          margin_known_micros: caixa?.margin_known_micros ?? null,
          margin_coverage_pct: caixa?.margin_coverage_pct ?? null,
        });
      }
    }
    // O pedido de volta mais recente de cada ação (a volta cancelada ou que falhou também aparece: é a história dela).
    const voltas = await tx.execute<{ id: string; status: ActionStatus; compensates_action_id: string }>(sql`
      select distinct on (compensates_action_id) id, status, compensates_action_id from liame.action_request
       where tenant_id = ${rows[0]!.tenant_id} and compensates_action_id in ${rows.map((r) => r.id)}
       order by compensates_action_id, created_at desc, id desc`);
    for (const v of voltas.rows) ap.voltas.set(v.compensates_action_id, { id: v.id, status: v.status });
    const pessoas = [...new Set(rows.map((r) => r.requested_by))];
    const contas = [...new Set(rows.map((r) => r.account_id).filter(ehUuid))];
    const campanhas = [...new Set(rows.map((r) => r.params.campaign_id).filter(ehUuid))];
    const u = await tx.execute<{ id: string; name: string }>(sql`select id, name from liame.app_user where id in ${pessoas}`);
    for (const l of u.rows) ap.pessoas.set(l.id, l.name);
    if (contas.length) {
      // A loja do Liame, quando a conta é de uma loja; senão, o nome da conta conectada.
      const a = await tx.execute<{ id: string; name: string }>(sql`
        select a.id, coalesce(un.name, a.name) as name from liame.connected_account a left join liame.unit un on un.id = a.unit_id where a.id in ${contas}`);
      for (const l of a.rows) ap.contas.set(l.id, l.name);
    }
    if (campanhas.length) {
      const c = await tx.execute<{ id: string; name: string; provider: string; status: string }>(sql`
        select id, name, provider, status from liame.campaign where id in ${campanhas}`);
      for (const l of c.rows) ap.campanhas.set(l.id, l);
    }
    // Os objetos de anúncio (pelo id deles na plataforma): a campanha de cada um na lista do Liame (X8).
    const objetos = rows.flatMap((r) => {
      const tipo = tipoDoObjeto(r.resource_id);
      return tipo && ehUuid(r.account_id) ? [{ conta: r.account_id, tipo, externo: r.resource_id.slice(tipo.length + 1) }] : [];
    });
    if (objetos.length) {
      const contasDosObjetos = [...new Set(objetos.map((o) => o.conta))];
      const externos = (tipo: string) => [...new Set(objetos.filter((o) => o.tipo === tipo).map((o) => o.externo))];
      type Linha = { conta: string; externo: string; id: string; name: string };
      const guardar = (tipo: string, linhas: Linha[]) => {
        for (const l of linhas) ap.campanhasDosObjetos.set(`${l.conta}/${tipo}:${l.externo}`, { id: l.id, name: l.name });
      };
      const [dasCampanhas, dosConjuntos, dosAnuncios] = [externos('campanha'), externos('conjunto'), externos('anuncio')];
      if (dasCampanhas.length) {
        const c = await tx.execute<Linha>(sql`
          select c.connected_account_id::text as conta, c.external_id as externo, c.id, c.name from liame.campaign c
           where c.connected_account_id in ${contasDosObjetos} and c.external_id in ${dasCampanhas}`);
        guardar('campanha', c.rows);
      }
      if (dosConjuntos.length) {
        const g = await tx.execute<Linha>(sql`
          select g.connected_account_id::text as conta, g.external_id as externo, c.id, c.name
            from liame.ad_group g join liame.campaign c on c.id = g.campaign_id
           where g.connected_account_id in ${contasDosObjetos} and g.external_id in ${dosConjuntos}`);
        guardar('conjunto', g.rows);
      }
      if (dosAnuncios.length) {
        const a = await tx.execute<Linha>(sql`
          select ad.connected_account_id::text as conta, ad.external_id as externo, c.id, c.name
            from liame.ad ad join liame.ad_group g on g.id = ad.ad_group_id join liame.campaign c on c.id = g.campaign_id
           where ad.connected_account_id in ${contasDosObjetos} and ad.external_id in ${dosAnuncios}`);
        guardar('anuncio', a.rows);
      }
    }
    // A tentativa de execução mais recente de cada pedido (a adiada também: é ela que diz que a plataforma mandou esperar).
    const execucoes = await tx.execute<{
      action_request_id: string;
      status: string;
      finished_at: Date | string;
      result_state: Record<string, unknown> | null;
      observed_state: Record<string, unknown> | null;
    }>(sql`
      select distinct on (action_request_id) action_request_id, status, finished_at, result_state, observed_state
        from liame.action_execution
       where tenant_id = ${rows[0]!.tenant_id} and action_request_id in ${rows.map((r) => r.id)}
       order by action_request_id, finished_at desc, id desc`);
    for (const x of execucoes.rows) {
      ap.execucoes.set(x.action_request_id, {
        status: x.status,
        finished_at: new Date(x.finished_at).toISOString(),
        no_write: x.result_state?.sem_escrita === true,
        observed: x.status === 'estado_mudou' && x.observed_state ? estadoNaResposta(x.observed_state) : null,
      });
    }
    return ap;
  }

  private async approvalsOf(tx: Tx, ids: string[]): Promise<ApprovalRow[]> {
    if (!ids.length) return [];
    const r = await tx.execute<ApprovalRow>(sql`
      select a.action_request_id, a.approved_by, u.name as approver_name, a.approver_role, a.sufficient, a.plan_hash, a.created_at
        from liame.approval a join liame.app_user u on u.id = a.approved_by
       where a.action_request_id in ${ids} order by a.created_at`);
    return r.rows;
  }

  private async notifyOwners(tx: Tx, tenantId: string, row: ActionRow, approverName: string): Promise<void> {
    const owners = await tx.execute<{ email: string }>(sql`
      select u.email from liame.membership m join liame.app_user u on u.id = m.user_id
       where m.tenant_id = ${tenantId} and m.role_key = 'dono' and m.revoked_at is null`);
    const text =
      `${approverName} aprovou a ação ${row.action} (${row.tool}), mas o valor de ${brl(Number(row.reserved_micros))} passa do limite dela` +
      `${row.mode === 'ESCALATE' ? ' ou a política pede a sua decisão' : ''}. Falta a sua aprovação:\n\n${this.config.appUrl}/aprovacoes?pedido=${row.id}`;
    for (const { email } of owners.rows) afterCommit(() => this.mailer.send({ to: email, subject: 'Liame: uma ação espera a sua aprovação', text }));
  }
}

export function planHashOf(
  input: { tool: string; brand_id?: string | null; provider: string; account_id: string; resource_id: string; params: Record<string, unknown> },
  plan: ToolPlan,
  beforeVersion: number,
): string {
  return sha256(
    canonicalJson({
      tool: input.tool,
      action: plan.action,
      brand_id: input.brand_id ?? null,
      provider: input.provider,
      account_id: input.account_id,
      resource_id: input.resource_id,
      params: input.params,
      value_micros: plan.valueMicros,
      current_value_micros: plan.currentValueMicros,
      desired_state: plan.desiredState,
      before_version: beforeVersion,
    }),
  );
}

function tenantOf(auth: AuthContext): string {
  if (!auth.tenantId) throw new AppProblem(403, 'sem-empresa-ativa', 'Escolha uma empresa', 'Selecione uma empresa com acesso ativo.');
  return auth.tenantId;
}

/**
 * Quem pede: uma pessoa (pela API) ou um funcionário de IA (pela rotina da sombra, no modo Aprovação). No pedido do
 * funcionário, `userId` é a pessoa que o deixou pedir: é ela que fica em `requested_by`, e as flags valem como para ela.
 */
type Solicitante = { tenantId: string; userId: string; ator: 'human' | 'agent'; agentKey: string | null };
const pessoa = (auth: AuthContext): Solicitante => ({ tenantId: tenantOf(auth), userId: auth.userId, ator: 'human', agentKey: null });

/** Pedidos, receita e margem são do ciclo fechado: só para quem vê as vendas (ADR-013). */
const veVendas = (auth: AuthContext): boolean => auth.permissions.has('vendas.ver');

/** O pedido que não confere com a recomendação citada não entra: 409 se ela já se encerrou, 422 se é de outra coisa. */
function naoLiga(falha: FalhaDaLigacao | null): void {
  if (!falha) return;
  if (falha.codigo === 'recomendacao-encerrada') throw new AppProblem(409, falha.codigo, 'A recomendação se encerrou', falha.detalhe);
  throw new AppProblem(422, falha.codigo, 'O pedido não confere com a recomendação', falha.detalhe);
}

/** Passos depois do pedido (ou da alteração): política e orçamento feitos; aprovação conforme o modo. */
function flowAfterRequest(
  status: ActionStatus,
  mode: AutonomyMode,
  decision: PolicyDecision,
  reserve: number,
): { steps: Array<{ name: string; status: 'aguardando' | 'concluido' | 'pulado'; output?: Record<string, unknown> }>; run: 'aguardando' | 'em_andamento' | 'concluido' } {
  const policy = { name: 'politica', status: 'concluido' as const, output: { mode, versions: decision.versions } };
  if (status === 'sombra') {
    return {
      steps: [policy, { name: 'orcamento', status: 'pulado' }, { name: 'aprovacao', status: 'pulado' }, { name: 'execucao', status: 'pulado', output: { motivo: 'sombra' } }],
      run: 'concluido',
    };
  }
  const budget = { name: 'orcamento', status: 'concluido' as const, output: { reserved_micros: reserve } };
  if (status === 'aprovada') {
    return { steps: [policy, budget, { name: 'aprovacao', status: 'concluido', output: { por: 'politica' } }, { name: 'execucao', status: 'aguardando' }], run: 'em_andamento' };
  }
  return { steps: [policy, budget, { name: 'aprovacao', status: 'aguardando' }], run: 'aguardando' };
}

/** A mensagem do pedido de envio ou de pausa: o retrato guardado e o plano do disparo que o pedido leu. Nulo nos outros pedidos. */
function mensagemDaResposta(row: ActionRow, ap: Apresentacao): ActionMessage | null {
  const campanha = row.provider === 'regemcast' ? mensagemDoRecurso(row.resource_id) : null;
  const retrato = campanha ? ap.mensagens.get(`${row.account_id}/${campanha}`) : undefined;
  if (!campanha || !retrato) return null;
  const lido = EstadoDaMensagem.safeParse(row.before_state);
  const e = lido.success ? lido.data : null;
  return {
    campaign_id: campanha,
    ...retrato,
    plan: e
      ? {
          status: e.situacao,
          people: e.pessoas,
          recipients: e.destinatarios,
          cost_cents: e.custo_centavos,
          currency: e.moeda,
          budget: {
            defined: e.orcamento.definido,
            periods: e.orcamento.periodos.map((p) => ({ period: p.periodo, label: p.rotulo, limit_cents: p.teto_centavos, spent_cents: p.gasto_centavos, signal: p.sinal })),
            notice: e.orcamento.aviso,
          },
        }
      : null,
  };
}

function toResponse(row: ActionRow, approvals: ApprovalRow[], workflow: ActionResponse['workflow'], ap: Apresentacao): ActionResponse {
  const campanha = row.params.campaign_id;
  const execucao = ap.execucoes.get(row.id) ?? null;
  // O objeto de anúncio do pedido: o tipo e o nome são os da leitura na plataforma, guardados com o pedido.
  const tipo = tipoDoObjeto(row.resource_id);
  const alvo = tipo
    ? {
        kind: typeof row.before_state?.tipo === 'string' ? row.before_state.tipo : tipo,
        name: typeof row.before_state?.nome === 'string' && row.before_state.nome ? row.before_state.nome : row.resource_id,
        campaign: ap.campanhasDosObjetos.get(`${row.account_id}/${row.resource_id}`) ?? null,
      }
    : null;
  return {
    id: row.id,
    tool: row.tool,
    action: row.action,
    brand_id: row.brand_id,
    provider: row.provider,
    account_id: row.account_id,
    resource_id: row.resource_id,
    params: row.params,
    risk_level: row.risk_level,
    budget_impact: row.budget_impact,
    value_micros: micros(row.value_micros),
    current_value_micros: micros(row.current_value_micros),
    reserved_micros: Number(row.reserved_micros),
    plan_hash: row.plan_hash,
    mode: row.mode,
    status: row.status,
    status_reason: row.status_reason,
    blocked_reason: row.status === 'aguardando_aprovacao' && row.before_state ? (TOOLS[row.tool]?.blockedBy?.(row.before_state) ?? null) : null,
    attempts: Number(row.attempts ?? 0),
    next_attempt_at: row.next_attempt_at ? new Date(row.next_attempt_at).toISOString() : null,
    undoes: row.compensates_action_id ?? null,
    undone_by: ap.voltas.get(row.id) ?? null,
    policy: row.policy_decision,
    approvals: approvals
      .filter((a) => a.action_request_id === row.id)
      .map((a) => ({
        approved_by: a.approved_by,
        approver_name: a.approver_name,
        approver_role: a.approver_role,
        sufficient: a.sufficient,
        current_plan: a.plan_hash === row.plan_hash,
        created_at: new Date(a.created_at).toISOString(),
      })),
    workflow,
    expires_at: new Date(row.expires_at).toISOString(),
    created_at: new Date(row.created_at).toISOString(),
    updated_at: new Date(row.updated_at).toISOString(),
    requested_by: { id: row.requested_by, name: ap.pessoas.get(row.requested_by) ?? 'Pessoa removida' },
    account_name: ap.contas.get(row.account_id) ?? null,
    campaign: typeof campanha === 'string' ? (ap.campanhas.get(campanha) ?? null) : null,
    recommendation: row.shadow_decision_id ? (ap.recomendacoes.get(row.shadow_decision_id) ?? null) : null,
    agent_key: row.agent_key ?? null,
    target: alvo,
    from: alvo ? estadoNaResposta(row.before_state) : null,
    to: alvo ? estadoNaResposta(row.desired_state) : null,
    execution: execucao ? { ...execucao, provider_reply: execucao.status === 'falhou' ? respostaDaPlataforma(row.provider, row.status_reason) : null } : null,
    message: mensagemDaResposta(row, ap),
  };
}

export { ACTIVE as ACTIVE_ACTION_STATUSES };
