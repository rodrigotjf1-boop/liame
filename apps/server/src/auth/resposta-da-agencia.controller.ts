import { AgencyReplyToConfirmedResponse, ProblemDetails, TokenRequest } from '@liame/contracts';
import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { ApiBadRequestResponse, ApiOkResponse, ApiOperation, ApiTags, ApiTooManyRequestsResponse } from '@nestjs/swagger';
import { Auditar } from '../audit/auditar.js';
import { Publico } from './access.js';
import { AgencyReplyToService } from './resposta-da-agencia.js';

// O link de confirmação do e-mail de resposta da agência (A7, W7, parte 3; D-A7-69): rota pública, de uso único.
@ApiTags('agency')
@Controller('agency-reply-to')
export class AgencyReplyToController {
  constructor(private readonly respostas: AgencyReplyToService) {}

  @Post('confirm')
  @Publico()
  @HttpCode(200)
  @Auditar('agencia.marca_resposta_confirmada', { manual: true, recurso: 'agency_brand' })
  @ApiOperation({
    summary: 'Confirmar o e-mail de resposta da agência',
    description:
      'Usa o link de uso único que vai ao e-mail novo de resposta da agência (vale 24 horas). Depois dele, o "Responder" do relatório que a agência manda vai para esse e-mail. Link vencido, já usado ou trocado por um e-mail mais novo: 400 `link-invalido`.',
  })
  @ApiOkResponse({ standardSchema: AgencyReplyToConfirmedResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiTooManyRequestsResponse({ standardSchema: ProblemDetails })
  confirmar(@Body({ schema: TokenRequest }) body: TokenRequest): Promise<AgencyReplyToConfirmedResponse> {
    return this.respostas.confirmar(body.token);
  }
}
