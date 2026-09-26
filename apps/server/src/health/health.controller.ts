import { HealthResponse } from '@liame/contracts';
import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';

@ApiTags('infra')
@Controller()
export class HealthController {
  @Get('health')
  @ApiOkResponse({ standardSchema: HealthResponse })
  check(): HealthResponse {
    return { status: 'ok', service: 'liame-api', version: process.env.APP_VERSION ?? 'dev' };
  }
}
