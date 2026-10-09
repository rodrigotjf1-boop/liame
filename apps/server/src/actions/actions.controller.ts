import {
  ActionListQuery,
  ActionListResponse,
  ActionOptionsQuery,
  ActionOptionsResponse,
  ActionResponse,
  ActionTargetsQuery,
  ActionTargetsResponse,
  ApproveActionRequest,
  BudgetLimitsRequest,
  BudgetMonthResponse,
  BudgetPolicyRequest,
  BudgetResponse,
  CreateActionRequest,
  ProblemDetails,
  RejectActionRequest,
  ResourceId,
  SandboxResourceRequest,
  SandboxResourceResponse,
  UpdateActionRequest,
} from '@liame/contracts';
import { Body, Controller, Get, HttpCode, Param, Patch, Post, Put, Query } from '@nestjs/common';
import {
  ApiBadGatewayResponse,
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { Auditar } from '../audit/auditar.js';
import { Auth, Permissao } from '../auth/access.js';
import type { AuthContext } from '../context/request-context.js';
import { SemTransacao } from '../context/sem-transacao.js';
import { ActionService } from './action.service.js';
import { BudgetService } from './budget.service.js';
import { OpcoesDoPedidoService } from './opcoes-do-pedido.service.js';

// Ações com trilho (ADR-007): a única porta de escrita fora do Liame.
@ApiTags('actions')
@ApiCookieAuth('liame_sessao')
@Controller()
export class ActionsController {
  constructor(
    private readonly actions: ActionService,
    private readonly budget: BudgetService,
    private readonly opcoes: OpcoesDoPedidoService,
  ) {}

  @Post('actions')
  @Permissao('campanhas.operar')
  @Auditar('acao.pedir', { recurso: 'action_request' })
  @HttpCode(201)
  @ApiOperation({
    summary: 'Pedir uma ação',
    description:
      'Ferramenta + alvo + parâmetros. O servidor lê o estado no provedor, aplica trava, política e orçamento (reserva) e devolve o plano com o hash que a aprovação precisa. Risco e impacto vêm do registro de ferramentas. Numa plataforma de anúncio, o estado é lido nela na hora do pedido: se ela não responde, o pedido não é criado (502 `plataforma-indisponivel`). Com `recommendation_id`, o pedido nasce de uma recomendação do Gestor de tráfego e fica ligado a ela: ela precisa estar em aberto (409 `recomendacao-encerrada`), ser da mesma conta e da mesma campanha e ir na mesma direção do pedido (422 `recomendacao-nao-confere`).',
  })
  @ApiCreatedResponse({ standardSchema: ActionResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiConflictResponse({ standardSchema: ProblemDetails })
  @ApiUnprocessableEntityResponse({ standardSchema: ProblemDetails })
  @ApiBadGatewayResponse({ standardSchema: ProblemDetails })
  create(@Auth() auth: AuthContext, @Body({ schema: CreateActionRequest }) body: CreateActionRequest): Promise<ActionResponse> {
    return this.actions.create(auth, body);
  }

  @Get('actions')
  @Permissao('campanhas.ver')
  @ApiOperation({ summary: 'Ações', description: 'As 100 mais recentes, com as aprovações.' })
  @ApiOkResponse({ standardSchema: ActionListResponse })
  async list(@Auth() auth: AuthContext, @Query({ schema: ActionListQuery }) query: ActionListQuery): Promise<ActionListResponse> {
    return { items: await this.actions.list(auth, query.status) };
  }

  // As duas leituras do pedido de mudança vêm antes de `actions/:id`: senão, "targets" e "options" seriam lidos como um id.
  @Get('actions/targets')
  @Permissao('campanhas.ver')
  @ApiOperation({
    summary: 'Onde dá para pedir uma mudança',
    description:
      'As campanhas de uma marca em que dá para pedir uma mudança pelo Liame (as das contas de anúncio com a escrita ligada para a empresa), com os pedidos em aberto de cada uma: esperando aprovação, aprovados ou executando. `write` diz se a conta já pode escrever (`ligada`) ou se a autorização dela só pediu leitura (`so_leitura`: é conectar a plataforma de novo). Campanha de plataforma que o Liame só lê, ou de conta com a escrita desligada, não aparece.',
  })
  @ApiOkResponse({ standardSchema: ActionTargetsResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  targets(@Auth() auth: AuthContext, @Query({ schema: ActionTargetsQuery }) query: ActionTargetsQuery): Promise<ActionTargetsResponse> {
    return this.opcoes.alvos(auth, query.brand_id);
  }

  @Get('actions/options')
  @Permissao('campanhas.operar')
  @SemTransacao('lê o objeto na plataforma de anúncio na hora, por até 10 segundos: o banco numa transação curta e a plataforma depois, sem transação aberta')
  @ApiOperation({
    summary: 'As opções do pedido de mudança numa campanha',
    description:
      'O que a tela precisa antes de a pessoa pedir uma mudança numa campanha: o objeto escolhido (a campanha ou, com `target`, um conjunto ou um anúncio dela) lido AGORA na plataforma, para o pedido partir do que está valendo; as ferramentas que cabem nele (`tools`); os conjuntos e os anúncios da campanha pela leitura diária; e os pedidos em aberto. Não cria pedido e não muda nada: quem decide é `POST /v1/actions`. As recusas que dá para antecipar saem com os mesmos códigos do pedido: 403 `escrita-desligada`, 423 `parada-acionada`, 409 `conta-desconectada`, 502 `plataforma-indisponivel` (a plataforma não respondeu: é tentar de novo), e mais 409 `conexao-so-leitura` (a autorização desta conta não pediu para gerenciar anúncios: é conectar de novo) e 422 `plataforma-so-leitura` (o Liame só lê esta plataforma). Os limites da empresa e a conta do mês vêm de `GET /v1/budget/month`.',
  })
  @ApiOkResponse({ standardSchema: ActionOptionsResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  @ApiConflictResponse({ standardSchema: ProblemDetails })
  @ApiUnprocessableEntityResponse({ standardSchema: ProblemDetails })
  @ApiBadGatewayResponse({ standardSchema: ProblemDetails })
  options(@Auth() auth: AuthContext, @Query({ schema: ActionOptionsQuery }) query: ActionOptionsQuery): Promise<ActionOptionsResponse> {
    return this.opcoes.daCampanha(auth, query);
  }

  @Get('actions/:id')
  @Permissao('campanhas.ver')
  @ApiOperation({ summary: 'Ação', description: 'O plano, a decisão da política e as aprovações.' })
  @ApiOkResponse({ standardSchema: ActionResponse })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  get(@Auth() auth: AuthContext, @Param('id', { schema: ResourceId }) id: string): Promise<ActionResponse> {
    return this.actions.get(auth, id);
  }

  @Patch('actions/:id')
  @Permissao('campanhas.operar')
  @Auditar('acao.alterar', { recurso: 'action_request' })
  @ApiOperation({ summary: 'Alterar o pedido', description: 'Parâmetros novos = plano novo (hash novo): a aprovação dada ao plano anterior deixa de valer.' })
  @ApiOkResponse({ standardSchema: ActionResponse })
  @ApiConflictResponse({ standardSchema: ProblemDetails })
  update(@Auth() auth: AuthContext, @Param('id', { schema: ResourceId }) id: string, @Body({ schema: UpdateActionRequest }) body: UpdateActionRequest): Promise<ActionResponse> {
    return this.actions.update(auth, id, body);
  }

  @Post('actions/:id/recheck')
  @Permissao('acoes.aprovar')
  @Auditar('acao.conferir', { recurso: 'action_request' })
  @HttpCode(200)
  @ApiOperation({
    summary: 'Conferir de novo',
    description:
      'Para o pedido que espera aprovação e cujo plano muda sozinho na plataforma (a mensagem de WhatsApp): lê o plano de agora e guarda no pedido, sem mudar o que foi pedido. Com o plano novo, o hash muda e a aprovação dada ao anterior deixa de valer. O que impede a aprovação vem em `blocked_reason`. Para os outros pedidos, 409 `acao-nao-confere`.',
  })
  @ApiOkResponse({ standardSchema: ActionResponse })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  @ApiConflictResponse({ standardSchema: ProblemDetails })
  recheck(@Auth() auth: AuthContext, @Param('id', { schema: ResourceId }) id: string): Promise<ActionResponse> {
    return this.actions.recheck(auth, id);
  }

  @Post('actions/:id/approve')
  @Permissao('acoes.aprovar')
  @Auditar('acao.aprovar', { recurso: 'action_request' })
  @HttpCode(200)
  @ApiOperation({
    summary: 'Aprovar',
    description: 'Com o código do app autenticador agora e o hash do plano visto. Acima do limite de quem aprova (ou em ESCALATE), falta também o dono.',
  })
  @ApiOkResponse({ standardSchema: ActionResponse })
  @ApiUnauthorizedResponse({ standardSchema: ProblemDetails })
  @ApiConflictResponse({ standardSchema: ProblemDetails })
  approve(@Auth() auth: AuthContext, @Param('id', { schema: ResourceId }) id: string, @Body({ schema: ApproveActionRequest }) body: ApproveActionRequest): Promise<ActionResponse> {
    return this.actions.approve(auth, id, body);
  }

  @Post('actions/:id/reject')
  @Permissao('acoes.aprovar')
  @Auditar('acao.recusar', { recurso: 'action_request' })
  @HttpCode(200)
  @ApiOperation({
    summary: 'Recusar',
    description: 'Quem pode aprovar recusa o pedido que espera aprovação, com o motivo e o hash do plano visto: o pedido é cancelado, a reserva volta ao envelope e nada é executado. O motivo e quem recusou ficam no pedido (`status_reason`) e na auditoria.',
  })
  @ApiOkResponse({ standardSchema: ActionResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  @ApiConflictResponse({ standardSchema: ProblemDetails })
  reject(@Auth() auth: AuthContext, @Param('id', { schema: ResourceId }) id: string, @Body({ schema: RejectActionRequest }) body: RejectActionRequest): Promise<ActionResponse> {
    return this.actions.reject(auth, id, body);
  }

  @Post('actions/:id/cancel')
  @Permissao('campanhas.operar')
  @Auditar('acao.cancelar', { recurso: 'action_request' })
  @HttpCode(200)
  @ApiOperation({ summary: 'Cancelar', description: 'Cancela o pedido que ainda não executou e devolve a reserva ao envelope.' })
  @ApiOkResponse({ standardSchema: ActionResponse })
  @ApiConflictResponse({ standardSchema: ProblemDetails })
  cancel(@Auth() auth: AuthContext, @Param('id', { schema: ResourceId }) id: string): Promise<ActionResponse> {
    return this.actions.cancel(auth, id);
  }

  @Post('actions/:id/undo')
  @Permissao('campanhas.operar')
  @Auditar('acao.desfazer', { recurso: 'action_request' })
  @HttpCode(201)
  @ApiOperation({
    summary: 'Desfazer (pedir a volta)',
    description:
      'Pede a volta de uma ação executada: um pedido novo, com a ferramenta inversa (a verba de antes, retomar o que foi pausado, pausar o que foi retomado), pelo mesmo trilho do pedido comum: trava, política, reserva, aprovação com o código do app, validação e escrita. Só é aceito se o objeto está como a ação o deixou: se alguém mexeu depois, nada é desfeito (409 `estado-mudou`). O pedido novo traz `undoes`; a ação original passa a trazer `undone_by`.',
  })
  @ApiCreatedResponse({ standardSchema: ActionResponse })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  @ApiConflictResponse({ standardSchema: ProblemDetails })
  @ApiUnprocessableEntityResponse({ standardSchema: ProblemDetails })
  @ApiBadGatewayResponse({ standardSchema: ProblemDetails })
  undo(@Auth() auth: AuthContext, @Param('id', { schema: ResourceId }) id: string): Promise<ActionResponse> {
    return this.actions.undo(auth, id);
  }

  @Get('budget')
  @Permissao('campanhas.ver')
  @ApiOperation({
    summary: 'Livro de reservas do mês',
    description:
      'Envelopes da empresa e das marcas pelo livro de reservas: limite, o que os pedidos reservaram por dia, o executado e a diferença. Numa plataforma de anúncio, a conta que decide o pedido é a de `GET /v1/budget/month` (o gasto inteiro das contas conectadas).',
  })
  @ApiOkResponse({ standardSchema: BudgetResponse })
  budgetSummary(@Auth() auth: AuthContext): Promise<BudgetResponse> {
    return this.budget.summary(auth);
  }

  @Get('budget/month')
  @Permissao('campanhas.ver')
  @ApiOperation({
    summary: 'Verba do mês',
    description:
      'Quanto as contas de anúncio conectadas (Meta e Google) já gastaram no mês, o ritmo dos 7 dias inteiros mais recentes, a previsão de fechamento, os aumentos e as retomadas pedidos ou feitos hoje, os dois limites da empresa (o teto do mês e o teto por campanha) e o que sobra. É por esta conta que o Liame aceita ou nega o pedido que faz o gasto subir: gasto lido + ritmo × dias que a leitura não cobre + o que pesa hoje + o que o pedido acrescenta até o fim do mês não pode passar do teto do mês. A conta lida pela última vez antes de hoje entra com o gasto até onde foi lida (`stale`), e os dias que faltam entram pelo ritmo.',
  })
  @ApiOkResponse({ standardSchema: BudgetMonthResponse })
  budgetMonth(@Auth() auth: AuthContext): Promise<BudgetMonthResponse> {
    return this.budget.month(auth);
  }

  @Put('budget/limits')
  @Permissao('orcamento.gerenciar')
  @Auditar('orcamento.limites', { recurso: 'budget_policy' })
  @ApiOperation({
    summary: 'Definir os limites da empresa',
    description:
      'O teto do mês (tudo o que a empresa pode gastar em anúncios no mês, nas contas conectadas) e o teto por campanha (a maior verba diária que um aumento pode deixar numa campanha ou num conjunto), sempre juntos. Valem na hora, para os pedidos seguintes; reduzir verba e pausar não dependem deles. O teto por campanha entra como uma versão nova da política da empresa. Devolve a verba do mês com os limites novos.',
  })
  @ApiOkResponse({ standardSchema: BudgetMonthResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  setLimits(@Auth() auth: AuthContext, @Body({ schema: BudgetLimitsRequest }) body: BudgetLimitsRequest): Promise<BudgetMonthResponse> {
    return this.budget.setLimits(auth, body);
  }

  @Put('budget/policies')
  @Permissao('orcamento.gerenciar')
  @Auditar('orcamento.definir', { recurso: 'budget_policy' })
  @HttpCode(204)
  @ApiOperation({
    summary: 'Definir envelope',
    description: 'Limite do mês para a empresa (`brand_id` nulo) ou para uma marca. Numa plataforma de anúncio, é o teto de tudo o que as contas conectadas (da empresa ou da marca) gastam no mês.',
  })
  @ApiNoContentResponse({ description: 'Envelope definido' })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  async setBudget(@Auth() auth: AuthContext, @Body({ schema: BudgetPolicyRequest }) body: BudgetPolicyRequest): Promise<void> {
    await this.budget.setPolicy(auth, body);
  }

  @Put('sandbox/resources')
  @Permissao('campanhas.operar')
  @Auditar('sandbox.gravar', { recurso: 'sandbox_resource' })
  @ApiOperation({ summary: 'Recurso do sandbox', description: 'Cria ou troca um recurso no provedor de mentira (demonstração e testes). Não toca plataforma real.' })
  @ApiOkResponse({ standardSchema: SandboxResourceResponse })
  putSandbox(@Auth() auth: AuthContext, @Body({ schema: SandboxResourceRequest }) body: SandboxResourceRequest): Promise<SandboxResourceResponse> {
    return this.actions.putSandbox(auth, body);
  }
}
