import { AcceptedResponse, ProblemDetails } from '@liame/contracts';
import { Controller, HttpCode, Post, Req } from '@nestjs/common';
import { ApiBadRequestResponse, ApiNotFoundResponse, ApiOkResponse, ApiOperation, ApiTags, ApiUnauthorizedResponse } from '@nestjs/swagger';
import { SemAuditoria } from '../audit/auditar.js';
import { Publico } from '../auth/access.js';
import { InboxService } from './inbox.service.js';

interface RawRequest {
  rawBody?: Buffer;
  headers: Record<string, string | string[] | undefined>;
}

// O aviso do Asaas (A7, W2a, parte 2; D-A7-28). Rota própria, e não a da inbox, porque o Asaas espera 200 (uma página da
// documentação aceita só o 200 como sucesso; base §18.5), e a da inbox responde 202. Pública: quem prova a origem é o token.
@ApiTags('inbox')
@Controller('billing/asaas')
export class AvisoDoAsaasController {
  constructor(private readonly inbox: InboxService) {}

  @Post('webhook')
  @SemAuditoria('o registro é o próprio inbox_event, gravado cru e deduplicado')
  @Publico()
  @HttpCode(200)
  @ApiOperation({
    summary: 'Receber o aviso do Asaas',
    description:
      'O token do aviso vem no cabeçalho asaas-access-token e é conferido em tempo constante. O evento é gravado cru e deduplicado pelo id dele; o processamento é assíncrono (o worker relê a cobrança na API do Asaas). Reenviar o mesmo evento responde 200 de novo.',
  })
  @ApiOkResponse({ standardSchema: AcceptedResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiUnauthorizedResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  async receber(@Req() req: RawRequest): Promise<AcceptedResponse> {
    const { duplicate } = await this.inbox.receberDoAsaas(req.rawBody, req.headers);
    return { status: 'accepted', message: duplicate ? 'Evento já recebido.' : 'Evento recebido.' };
  }
}
