import { CreateAgencyRequest, MeResponse, ProblemDetails } from '@liame/contracts';
import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Auditar } from '../audit/auditar.js';
import type { AuthContext } from '../context/request-context.js';
import { Auth, Autenticado } from './access.js';
import { AgencyAccountService } from './agencia-conta.service.js';

// A conta da agência para quem já tem login (A7, W6; D-A7-45).
@ApiTags('agency')
@ApiCookieAuth('liame_sessao')
@Controller('agencies')
export class AgencyAccountController {
  constructor(private readonly agencies: AgencyAccountService) {}

  @Post()
  @Auditar('agencia.abrir', { manual: true, recurso: 'organization' })
  @Autenticado()
  @HttpCode(201)
  @ApiOperation({
    summary: 'Abrir a conta da agência',
    description:
      'Cria a agência com a pessoa da sessão como dona, sem marca e sem assinatura, e a torna a organização ativa. Uma agência por pessoa como dona.',
  })
  @ApiCreatedResponse({ standardSchema: MeResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiUnauthorizedResponse({ standardSchema: ProblemDetails })
  @ApiConflictResponse({ standardSchema: ProblemDetails })
  @ApiTooManyRequestsResponse({ standardSchema: ProblemDetails })
  open(@Auth() auth: AuthContext, @Body({ schema: CreateAgencyRequest }) body: CreateAgencyRequest): Promise<MeResponse> {
    return this.agencies.open(auth, body);
  }
}
