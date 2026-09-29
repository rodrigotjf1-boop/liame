import { AcceptedResponse, InboxProvider, ProblemDetails, ResourceId } from '@liame/contracts';
import { Controller, HttpCode, Param, Post, Req } from '@nestjs/common';
import { ApiAcceptedResponse, ApiNotFoundResponse, ApiOperation, ApiTags, ApiUnauthorizedResponse } from '@nestjs/swagger';
import { Publico } from '../auth/access.js';
import { InboxService } from './inbox.service.js';
import { SemAuditoria } from '../audit/auditar.js';

interface RawRequest {
  rawBody?: Buffer;
  headers: Record<string, string | string[] | undefined>;
}

// Webhooks recebidos de parceiros (ADR-004). Pública: quem prova a origem é a assinatura.
@ApiTags('inbox')
@Controller('inbox')
export class InboxController {
  constructor(private readonly inbox: InboxService) {}

  @Post(':provider')
  @SemAuditoria('o registro é o próprio inbox_event, gravado cru e deduplicado')
  @Publico()
  @HttpCode(202)
  @ApiOperation({
    summary: 'Receber webhook',
    description:
      'Assinado no padrão Standard Webhooks (webhook-id, webhook-timestamp, webhook-signature). O evento é gravado cru e deduplicado pelo webhook-id; o processamento é assíncrono. Reenviar o mesmo evento responde 202 de novo.',
  })
  @ApiAcceptedResponse({ standardSchema: AcceptedResponse })
  @ApiUnauthorizedResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  async receive(@Param('provider', { schema: InboxProvider }) provider: string, @Req() req: RawRequest): Promise<AcceptedResponse> {
    const { duplicate } = await this.inbox.receive(provider, req.rawBody, req.headers);
    return { status: 'accepted', message: duplicate ? 'Evento já recebido.' : 'Evento recebido.' };
  }

  @Post(':provider/:connectionId')
  @SemAuditoria('o registro é o próprio inbox_event, gravado cru e deduplicado')
  @Publico()
  @HttpCode(202)
  @ApiOperation({
    summary: 'Receber webhook de uma conexão',
    description:
      'Produtos da DMS (Regem, RegemCast): cada conexão tem o próprio segredo de assinatura (Standard Webhooks). O evento é só gatilho: o Liame lê pela rota com cursor em seguida. Conexão inexistente ou revogada responde 404.',
  })
  @ApiAcceptedResponse({ standardSchema: AcceptedResponse })
  @ApiUnauthorizedResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  async receiveForConnection(
    @Param('provider', { schema: InboxProvider }) provider: string,
    @Param('connectionId', { schema: ResourceId }) connectionId: string,
    @Req() req: RawRequest,
  ): Promise<AcceptedResponse> {
    const { duplicate } = await this.inbox.receiveForConnection(provider, connectionId, req.rawBody, req.headers);
    return { status: 'accepted', message: duplicate ? 'Evento já recebido.' : 'Evento recebido.' };
  }
}
