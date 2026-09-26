import { ActivateKillSwitchRequest, KillSwitchListResponse, KillSwitchResponse, ProblemDetails, ResourceId } from '@liame/contracts';
import { Body, Controller, Delete, Get, HttpCode, Param, Post } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Auditar } from '../audit/auditar.js';
import { Auth, Permissao } from '../auth/access.js';
import type { AuthContext } from '../context/request-context.js';
import { KillSwitchService } from './kill-switch.service.js';

// Botão de parada da empresa (ADR-007): trava a execução na hora, da empresa inteira a uma ferramenta.
@ApiTags('kill-switch')
@ApiCookieAuth('liame_sessao')
@Controller('kill-switches')
export class KillSwitchController {
  constructor(private readonly switches: KillSwitchService) {}

  @Get()
  @Permissao('parada.acionar')
  @ApiOperation({ summary: 'Travas', description: 'Travas ativas e recentes da empresa, e as da distribuição que valem para ela.' })
  @ApiOkResponse({ standardSchema: KillSwitchListResponse })
  async list(@Auth() auth: AuthContext): Promise<KillSwitchListResponse> {
    return { items: await this.switches.list(auth) };
  }

  @Post()
  @Permissao('parada.acionar')
  @Auditar('parada.acionar', { recurso: 'kill_switch' })
  @HttpCode(201)
  @ApiOperation({
    summary: 'Acionar a parada',
    description: 'Trava a execução de ações na empresa, numa marca, numa conta de um provedor ou numa ferramenta. Vale na hora e prevalece sobre qualquer flag.',
  })
  @ApiCreatedResponse({ standardSchema: KillSwitchResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  activate(@Auth() auth: AuthContext, @Body({ schema: ActivateKillSwitchRequest }) body: ActivateKillSwitchRequest): Promise<KillSwitchResponse> {
    return this.switches.activate(auth, body);
  }

  @Delete(':id')
  @Permissao('parada.acionar')
  @Auditar('parada.desligar', { recurso: 'kill_switch' })
  @HttpCode(204)
  @ApiOperation({ summary: 'Desligar a parada', description: 'Libera de novo a execução naquele escopo.' })
  @ApiNoContentResponse({ description: 'Trava desligada' })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  async deactivate(@Auth() auth: AuthContext, @Param('id', { schema: ResourceId }) id: string): Promise<void> {
    await this.switches.deactivate(auth, id);
  }
}
