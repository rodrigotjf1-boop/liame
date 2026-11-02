import {
  AgencyInvitationResponse,
  AgencyMemberResponse,
  AgencyTeamResponse,
  CreateAgencyInvitationRequest,
  ProblemDetails,
  ResourceId,
  UpdateAgencyMemberRequest,
} from '@liame/contracts';
import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import {
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
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import { Auditar } from '../audit/auditar.js';
import { Auth, Permissao } from '../auth/access.js';
import type { AuthContext } from '../context/request-context.js';
import { AgencyService } from './agencia.service.js';

// O time da agência ativa (A7, W6, parte 1; D-A7-51).
@ApiTags('agency')
@ApiCookieAuth('liame_sessao')
@Controller('agency')
export class AgencyController {
  constructor(private readonly agency: AgencyService) {}

  @Get('team')
  @Permissao('agencia.ver')
  @ApiOperation({ summary: 'Time da agência', description: 'Quem está no time da agência ativa e os convites em aberto.' })
  @ApiOkResponse({ standardSchema: AgencyTeamResponse })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  team(@Auth() auth: AuthContext): Promise<AgencyTeamResponse> {
    return this.agency.team(auth);
  }

  @Post('invitations')
  @Auditar('agencia.convidar', { recurso: 'invitation' })
  @Permissao('agencia.time')
  @HttpCode(201)
  @ApiOperation({
    summary: 'Convidar para a agência',
    description:
      'Manda por e-mail um link de uso único que vence em 7 dias e só vale para o e-mail convidado, como Administrador ou Membro da agência. Convidar de novo o mesmo e-mail substitui o convite em aberto.',
  })
  @ApiCreatedResponse({ standardSchema: AgencyInvitationResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiConflictResponse({ standardSchema: ProblemDetails })
  @ApiTooManyRequestsResponse({ standardSchema: ProblemDetails })
  invite(
    @Auth() auth: AuthContext,
    @Body({ schema: CreateAgencyInvitationRequest }) body: CreateAgencyInvitationRequest,
  ): Promise<AgencyInvitationResponse> {
    return this.agency.invite(auth, body);
  }

  @Delete('invitations/:id')
  @Auditar('agencia.cancelar_convite', { recurso: 'invitation' })
  @Permissao('agencia.time')
  @HttpCode(204)
  @ApiOperation({ summary: 'Cancelar convite da agência', description: 'O link deixa de valer na hora.' })
  @ApiNoContentResponse({ description: 'Convite cancelado' })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  async revokeInvitation(@Auth() auth: AuthContext, @Param('id', { schema: ResourceId }) id: string): Promise<void> {
    await this.agency.revokeInvitation(auth, id);
  }

  @Patch('members/:id')
  @Auditar('agencia.mudar_papel', { recurso: 'membership' })
  @Permissao('agencia.time')
  @ApiOperation({
    summary: 'Mudar o papel na agência',
    description: 'Administrador ou Membro da agência. A dona não muda, ninguém muda o próprio papel e ninguém mexe em quem está acima.',
  })
  @ApiOkResponse({ standardSchema: AgencyMemberResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  updateMember(
    @Auth() auth: AuthContext,
    @Param('id', { schema: ResourceId }) id: string,
    @Body({ schema: UpdateAgencyMemberRequest }) body: UpdateAgencyMemberRequest,
  ): Promise<AgencyMemberResponse> {
    return this.agency.updateMember(auth, id, body);
  }

  @Delete('members/:id')
  @Auditar('agencia.tirar_do_time', { recurso: 'membership' })
  @Permissao('agencia.time')
  @HttpCode(204)
  @ApiOperation({ summary: 'Tirar do time da agência', description: 'Corta o acesso da pessoa à agência na hora. A dona não sai.' })
  @ApiNoContentResponse({ description: 'Pessoa fora do time' })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  async removeMember(@Auth() auth: AuthContext, @Param('id', { schema: ResourceId }) id: string): Promise<void> {
    await this.agency.removeMember(auth, id);
  }
}
