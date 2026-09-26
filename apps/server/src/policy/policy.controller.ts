import { ActionProposal, PolicyDecision, PolicyListResponse, PolicyVersionResponse, ProblemDetails, PublishPolicyRequest } from '@liame/contracts';
import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { ApiBadRequestResponse, ApiCookieAuth, ApiCreatedResponse, ApiForbiddenResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Auditar, SemAuditoria } from '../audit/auditar.js';
import { Auth, Permissao } from '../auth/access.js';
import { type AuthContext, currentTx } from '../context/request-context.js';
import { PolicyService } from './policy.service.js';

// Políticas da empresa e das marcas (ADR-007): regras que o motor aplica antes de qualquer ação.
@ApiTags('policies')
@ApiCookieAuth('liame_sessao')
@Controller('policies')
export class PolicyController {
  constructor(private readonly policies: PolicyService) {}

  @Get()
  @Permissao('politicas.gerenciar')
  @ApiOperation({ summary: 'Políticas', description: 'A política da plataforma (vale para todos) e as versões da empresa e das marcas.' })
  @ApiOkResponse({ standardSchema: PolicyListResponse })
  list(@Auth() auth: AuthContext): Promise<PolicyListResponse> {
    return this.policies.list(auth);
  }

  @Post()
  @Permissao('politicas.gerenciar')
  @Auditar('politica.publicar', { recurso: 'policy' })
  @HttpCode(201)
  @ApiOperation({
    summary: 'Publicar política',
    description: 'Cria uma versão nova para a empresa (`brand_id` nulo) ou para uma marca; a anterior do mesmo escopo é arquivada. Versão publicada não muda.',
  })
  @ApiCreatedResponse({ standardSchema: PolicyVersionResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  publish(@Auth() auth: AuthContext, @Body({ schema: PublishPolicyRequest }) body: PublishPolicyRequest): Promise<PolicyVersionResponse> {
    return this.policies.publish(auth, body);
  }

  @Post('evaluate')
  @Permissao('politicas.gerenciar')
  @SemAuditoria('simulação da política; nada muda')
  @HttpCode(200)
  @ApiOperation({ summary: 'Simular', description: 'Mostra o que o motor decidiria para uma proposta de ação agora, sem executar nada.' })
  @ApiOkResponse({ standardSchema: PolicyDecision })
  simulate(@Auth() auth: AuthContext, @Body({ schema: ActionProposal }) body: ActionProposal): Promise<PolicyDecision> {
    return this.policies.evaluate(currentTx(), auth.tenantId!, body);
  }
}
