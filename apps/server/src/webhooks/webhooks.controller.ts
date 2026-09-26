import {
  CreatedWebhookEndpointResponse,
  CreateWebhookEndpointRequest,
  ProblemDetails,
  ResourceId,
  WebhookDeliveryListResponse,
  WebhookDeliveryQuery,
  WebhookEndpointListResponse,
} from '@liame/contracts';
import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import {
  ApiAcceptedResponse,
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
} from '@nestjs/swagger';
import { Auth, Permissao } from '../auth/access.js';
import type { AuthContext } from '../context/request-context.js';
import { WebhooksService } from './webhooks.service.js';

// Webhooks de saída da empresa ativa (ADR-004): CloudEvents assinados no padrão Standard Webhooks.
@ApiTags('webhooks')
@ApiCookieAuth('liame_sessao')
@Controller('webhooks')
export class WebhooksController {
  constructor(private readonly webhooks: WebhooksService) {}

  @Get('endpoints')
  @Permissao('webhooks.gerenciar')
  @ApiOperation({ summary: 'Endpoints de webhook', description: 'Endereços que recebem os eventos da empresa ativa.' })
  @ApiOkResponse({ standardSchema: WebhookEndpointListResponse })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  async list(@Auth() auth: AuthContext): Promise<WebhookEndpointListResponse> {
    return { items: await this.webhooks.list(auth) };
  }

  @Post('endpoints')
  @Permissao('webhooks.gerenciar')
  @HttpCode(201)
  @ApiOperation({
    summary: 'Cadastrar endpoint',
    description:
      'URL https pública (rede interna é recusada). Devolve o segredo de assinatura (`whsec_...`) uma única vez; os eventos saem com os cabeçalhos webhook-id, webhook-timestamp e webhook-signature.',
  })
  @ApiCreatedResponse({ standardSchema: CreatedWebhookEndpointResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiConflictResponse({ standardSchema: ProblemDetails })
  create(@Auth() auth: AuthContext, @Body({ schema: CreateWebhookEndpointRequest }) body: CreateWebhookEndpointRequest): Promise<CreatedWebhookEndpointResponse> {
    return this.webhooks.create(auth, body);
  }

  @Delete('endpoints/:id')
  @Permissao('webhooks.gerenciar')
  @HttpCode(204)
  @ApiOperation({ summary: 'Desativar endpoint', description: 'Para de enviar na hora e revoga o segredo.' })
  @ApiNoContentResponse({ description: 'Endpoint desativado' })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  async disable(@Auth() auth: AuthContext, @Param('id', { schema: ResourceId }) id: string): Promise<void> {
    await this.webhooks.disable(auth, id);
  }

  @Post('endpoints/:id/test')
  @Permissao('webhooks.gerenciar')
  @HttpCode(202)
  @ApiOperation({ summary: 'Enviar evento de teste', description: 'Manda `liame.webhook.test` só para este endpoint.' })
  @ApiAcceptedResponse({ description: 'Evento de teste na fila' })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  async test(@Auth() auth: AuthContext, @Param('id', { schema: ResourceId }) id: string): Promise<void> {
    await this.webhooks.sendTest(auth, id);
  }

  @Get('deliveries')
  @Permissao('webhooks.gerenciar')
  @ApiOperation({ summary: 'Entregas', description: 'As 100 entregas mais recentes; `status=morta` mostra a fila de mortos.' })
  @ApiOkResponse({ standardSchema: WebhookDeliveryListResponse })
  async deliveries(@Auth() auth: AuthContext, @Query({ schema: WebhookDeliveryQuery }) query: WebhookDeliveryQuery): Promise<WebhookDeliveryListResponse> {
    return { items: await this.webhooks.deliveries(auth, query.status) };
  }

  @Post('deliveries/:id/retry')
  @Permissao('webhooks.gerenciar')
  @HttpCode(202)
  @ApiOperation({ summary: 'Reenviar entrega', description: 'Volta a entrega para a fila agora (reenvio manual, inclusive da fila de mortos).' })
  @ApiAcceptedResponse({ description: 'Entrega na fila' })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  async retry(@Auth() auth: AuthContext, @Param('id', { schema: ResourceId }) id: string): Promise<void> {
    await this.webhooks.retry(auth, id);
  }
}
