import {
  ApprovePlanRequest,
  EditPlanRequest,
  PlanListQuery,
  PlanListResponse,
  PlanResponse,
  ProblemDetails,
  ReanalyzePlanRequest,
  RejectPlanRequest,
  ResourceId,
} from '@liame/contracts';
import { Body, Controller, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCookieAuth,
  ApiForbiddenResponse,
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
import { PlanosService } from './planos.service.js';

// Planos do Estrategista (A3, I11; protótipo P8, aguardando aprovação; sem tela ainda). O plano é feito dos números de
// vendas e de anúncios: ver e decidir pedem também `vendas.ver`. Nada aqui executa coisa alguma fora do Liame.

@ApiTags('planos')
@ApiCookieAuth('liame_sessao')
@Controller('plans')
export class PlanosController {
  constructor(private readonly planos: PlanosService) {}

  @Get()
  @Permissao('planos.ver', 'vendas.ver')
  @ApiOperation({
    summary: 'Planos do Estrategista',
    description:
      'Os planos da marca (até 100): os que esperam decisão primeiro, o que expira antes no topo, e depois os mais novos. `status=pendente` é a fila de Aprovações. Pendente que passou do prazo aparece como `expirado`.',
  })
  @ApiOkResponse({ standardSchema: PlanListResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  list(@Auth() auth: AuthContext, @Query({ schema: PlanListQuery }) query: PlanListQuery): Promise<PlanListResponse> {
    return this.planos.list(auth, query);
  }

  @Get(':id')
  @Permissao('planos.ver', 'vendas.ver')
  @ApiOperation({
    summary: 'Um plano',
    description:
      'A versão atual do plano, cada número com a fonte (dita pelo código, não pela IA), os textos com os números marcados, quem escreveu a versão (o Estrategista ou quem editou), o pedido de nova análise que a gerou e as decisões já tomadas. `can_decide` diz se a pessoa da sessão pode decidir agora.',
  })
  @ApiOkResponse({ standardSchema: PlanResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  get(@Auth() auth: AuthContext, @Param('id', { schema: ResourceId }) id: string): Promise<PlanResponse> {
    return this.planos.get(auth, id);
  }

  @Put(':id')
  @Permissao('planos.decidir', 'vendas.ver')
  @Auditar('plano.editar', { recurso: 'plan' })
  @ApiOperation({
    summary: 'Editar o plano',
    description:
      'O conteúdo inteiro da versão nova, a partir da versão aberta (`base_version`). O texto perde o dado pessoal e passa pelo Compliance e pelo que a marca não diz (422 `texto-recusado`); a verba de hoje continua a calculada pelo sistema. A versão nova tem hash novo: a aprovação da anterior deixa de valer, e o plano volta a esperar decisão, com prazo novo. Versão aberta que não é a atual: 409 `plano-mudou`.',
  })
  @ApiOkResponse({ standardSchema: PlanResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  @ApiConflictResponse({ standardSchema: ProblemDetails })
  @ApiUnprocessableEntityResponse({ standardSchema: ProblemDetails })
  edit(@Auth() auth: AuthContext, @Param('id', { schema: ResourceId }) id: string, @Body({ schema: EditPlanRequest }) body: EditPlanRequest): Promise<PlanResponse> {
    return this.planos.edit(auth, id, body);
  }

  @Post(':id/approve')
  @HttpCode(200)
  @Permissao('planos.decidir', 'vendas.ver')
  @Auditar('plano.aprovar', { recurso: 'plan' })
  @ApiOperation({
    summary: 'Aprovar o plano',
    description:
      'Com o código do app autenticador agora e o hash da versão vista (como as ações). Aprovar não executa nada: quem muda campanha, verba ou cardápio é quem cuida deles. Plano que mudou: 409 `plano-mudou`; que passou do prazo: 409 `plano-expirado`.',
  })
  @ApiOkResponse({ standardSchema: PlanResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiUnauthorizedResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  @ApiConflictResponse({ standardSchema: ProblemDetails })
  approve(@Auth() auth: AuthContext, @Param('id', { schema: ResourceId }) id: string, @Body({ schema: ApprovePlanRequest }) body: ApprovePlanRequest): Promise<PlanResponse> {
    return this.planos.approve(auth, id, body);
  }

  @Post(':id/reject')
  @HttpCode(200)
  @Permissao('planos.decidir', 'vendas.ver')
  @Auditar('plano.recusar', { recurso: 'plan' })
  @ApiOperation({
    summary: 'Recusar o plano',
    description: 'Com pelo menos um motivo e o hash da versão vista; o comentário é opcional e perde o dado pessoal. Recusar não executa nada e não pede o código do app.',
  })
  @ApiOkResponse({ standardSchema: PlanResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  @ApiConflictResponse({ standardSchema: ProblemDetails })
  reject(@Auth() auth: AuthContext, @Param('id', { schema: ResourceId }) id: string, @Body({ schema: RejectPlanRequest }) body: RejectPlanRequest): Promise<PlanResponse> {
    return this.planos.reject(auth, id, body);
  }

  @Post(':id/reanalyze')
  @HttpCode(200)
  @Permissao('planos.decidir', 'vendas.ver')
  @Auditar('plano.pedir_nova_analise', { recurso: 'plan' })
  @ApiOperation({
    summary: 'Pedir nova análise',
    description:
      'O que a pessoa quer diferente, nas palavras dela (sem dado pessoal), com o hash da versão vista. O Estrategista refaz o plano e manda a versão seguinte para Aprovações; até lá, o plano fica em `nova_analise`. Vale também para o plano que expirou sem decisão.',
  })
  @ApiOkResponse({ standardSchema: PlanResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  @ApiConflictResponse({ standardSchema: ProblemDetails })
  @ApiUnprocessableEntityResponse({ standardSchema: ProblemDetails })
  reanalyze(@Auth() auth: AuthContext, @Param('id', { schema: ResourceId }) id: string, @Body({ schema: ReanalyzePlanRequest }) body: ReanalyzePlanRequest): Promise<PlanResponse> {
    return this.planos.reanalyze(auth, id, body);
  }
}
