import {
  ActionListQuery,
  ActionListResponse,
  ActionResponse,
  ApproveActionRequest,
  BudgetPolicyRequest,
  BudgetResponse,
  CreateActionRequest,
  ProblemDetails,
  ResourceId,
  SandboxResourceRequest,
  SandboxResourceResponse,
  UpdateActionRequest,
} from '@liame/contracts';
import { Body, Controller, Get, HttpCode, Param, Patch, Post, Put, Query } from '@nestjs/common';
import {
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
import { ActionService } from './action.service.js';
import { BudgetService } from './budget.service.js';

// Ações com trilho (ADR-007): a única porta de escrita fora do Liame.
@ApiTags('actions')
@ApiCookieAuth('liame_sessao')
@Controller()
export class ActionsController {
  constructor(
    private readonly actions: ActionService,
    private readonly budget: BudgetService,
  ) {}

  @Post('actions')
  @Permissao('campanhas.operar')
  @Auditar('acao.pedir', { recurso: 'action_request' })
  @HttpCode(201)
  @ApiOperation({
    summary: 'Pedir uma ação',
    description:
      'Ferramenta + alvo + parâmetros. O servidor lê o estado no provedor, aplica trava, política e orçamento (reserva) e devolve o plano com o hash que a aprovação precisa. Risco e impacto vêm do registro de ferramentas.',
  })
  @ApiCreatedResponse({ standardSchema: ActionResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiConflictResponse({ standardSchema: ProblemDetails })
  @ApiUnprocessableEntityResponse({ standardSchema: ProblemDetails })
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

  @Get('budget')
  @Permissao('campanhas.ver')
  @ApiOperation({ summary: 'Orçamento do mês', description: 'Envelopes da empresa e das marcas: limite, comprometido, executado e livre.' })
  @ApiOkResponse({ standardSchema: BudgetResponse })
  budgetSummary(@Auth() auth: AuthContext): Promise<BudgetResponse> {
    return this.budget.summary(auth);
  }

  @Put('budget/policies')
  @Permissao('orcamento.gerenciar')
  @Auditar('orcamento.definir', { recurso: 'budget_policy' })
  @HttpCode(204)
  @ApiOperation({ summary: 'Definir envelope', description: 'Limite do mês para a empresa (`brand_id` nulo) ou para uma marca.' })
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
