import { ProblemDetails, SpikeEchoRequest, SpikeEchoResponse } from '@liame/contracts';
import { Body, Controller, Get, Post } from '@nestjs/common';
import { ApiBadRequestResponse, ApiCreatedResponse, ApiExcludeEndpoint, ApiOperation, ApiTags } from '@nestjs/swagger';

/** Rotas do spike A0-3 e da E1: provam validação, OpenAPI e a política de erros. Saem na A1 (E2). */
@ApiTags('spike')
@Controller('spike')
export class SpikeController {
  @Post('echo')
  @ApiOperation({ summary: 'Eco (spike)', description: 'Devolve a mensagem validada pelo schema Zod. Rota provisória do spike A0-3.' })
  @ApiCreatedResponse({ standardSchema: SpikeEchoResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  echo(@Body({ schema: SpikeEchoRequest }) body: SpikeEchoRequest): SpikeEchoResponse {
    return { message: body.message, tags: body.tags, length: body.message.length };
  }

  /** Falha proposital: o 500 não pode mostrar o dado interno da mensagem, e o log precisa ter a causa. */
  @Get('falha')
  @ApiExcludeEndpoint()
  falha(): never {
    throw new Error('falha proposital do spike (dado interno: tabela liame.segredo)');
  }
}
