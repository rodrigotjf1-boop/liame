import { SpikeEchoRequest, SpikeEchoResponse } from '@liame/contracts';
import { Body, Controller, Post } from '@nestjs/common';
import { ApiCreatedResponse, ApiTags } from '@nestjs/swagger';

/** Rota do spike A0-3: prova o Standard Schema (Zod) na validação e no OpenAPI. Sai na A1. */
@ApiTags('spike')
@Controller('spike')
export class SpikeController {
  @Post('echo')
  @ApiCreatedResponse({ standardSchema: SpikeEchoResponse })
  echo(@Body({ schema: SpikeEchoRequest }) body: SpikeEchoRequest): SpikeEchoResponse {
    return { message: body.message, tags: body.tags, length: body.message.length };
  }
}
