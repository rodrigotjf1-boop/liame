import {
  AgencyClientsResponse,
  AgencyClientTeamResponse,
  AgencyInvitationResponse,
  AgencyMemberResponse,
  AgencyRequestResponse,
  AgencyTeamResponse,
  CreateAgencyInvitationRequest,
  CreatePartnerRequestRequest,
  ProblemDetails,
  ResourceId,
  SetAgencyClientTeamRequest,
  UpdateAgencyMemberRequest,
} from '@liame/contracts';
import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put } from '@nestjs/common';
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
import { VinculoService } from './vinculo.service.js';

// A agência ativa (A7, W6): o time (parte 1; D-A7-51) e os clientes, com o pedido de acesso (parte 2; D-A7-46 e D-A7-50).
@ApiTags('agency')
@ApiCookieAuth('liame_sessao')
@Controller('agency')
export class AgencyController {
  constructor(
    private readonly agency: AgencyService,
    private readonly vinculos: VinculoService,
  ) {}

  @Get('clients')
  @Permissao('agencia.clientes')
  @ApiOperation({
    summary: 'Clientes da agência',
    description: 'As empresas que aceitaram o vínculo (vivo, vencido ou desfeito) e os pedidos da agência (esperando, recusados e vencidos).',
  })
  @ApiOkResponse({ standardSchema: AgencyClientsResponse })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  clients(@Auth() auth: AuthContext): Promise<AgencyClientsResponse> {
    return this.vinculos.clientes(auth);
  }

  @Post('requests')
  @Auditar('agencia.pedir_acesso', { recurso: 'partner_link' })
  @Permissao('agencia.clientes')
  @HttpCode(201)
  @ApiOperation({
    summary: 'Pedir acesso a um cliente',
    description:
      'O pedido vai para o e-mail do Dono da empresa e vale 7 dias. A resposta é a mesma exista ou não a conta do e-mail. Pedir de novo ao mesmo e-mail troca o pedido anterior; até 20 pedidos por dia.',
  })
  @ApiCreatedResponse({ standardSchema: AgencyRequestResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiTooManyRequestsResponse({ standardSchema: ProblemDetails })
  request(@Auth() auth: AuthContext, @Body({ schema: CreatePartnerRequestRequest }) body: CreatePartnerRequestRequest): Promise<AgencyRequestResponse> {
    return this.vinculos.pedir(auth, body);
  }

  @Delete('requests/:id')
  @Auditar('agencia.cancelar_pedido', { recurso: 'partner_link' })
  @Permissao('agencia.clientes')
  @HttpCode(204)
  @ApiOperation({ summary: 'Cancelar um pedido de acesso', description: 'O pedido em aberto deixa de valer na hora.' })
  @ApiNoContentResponse({ description: 'Pedido cancelado' })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  async cancelRequest(@Auth() auth: AuthContext, @Param('id', { schema: ResourceId }) id: string): Promise<void> {
    await this.vinculos.cancelarPedido(auth, id);
  }

  @Get('clients/:id/team')
  @Permissao('agencia.time')
  @ApiOperation({
    summary: 'Quem do time entra no cliente',
    description: 'O time da agência e, de quem está neste cliente, o nível e o limite; o máximo é o que o Dono deu.',
  })
  @ApiOkResponse({ standardSchema: AgencyClientTeamResponse })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  clientTeam(@Auth() auth: AuthContext, @Param('id', { schema: ResourceId }) id: string): Promise<AgencyClientTeamResponse> {
    return this.vinculos.timeNoCliente(auth, id);
  }

  @Put('clients/:id/team')
  @Auditar('agencia.escolher_time', { recurso: 'partner_link' })
  @Permissao('agencia.time')
  @ApiOperation({
    summary: 'Salvar quem entra no cliente',
    description:
      'A lista inteira de quem do time entra, com o nível e o limite até o máximo do Dono; só com o app autenticador ativo. Quem sai da lista perde o acesso a este cliente na hora. O Dono recebe um aviso de cada pessoa nova.',
  })
  @ApiOkResponse({ standardSchema: AgencyClientTeamResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  @ApiConflictResponse({ standardSchema: ProblemDetails })
  setClientTeam(
    @Auth() auth: AuthContext,
    @Param('id', { schema: ResourceId }) id: string,
    @Body({ schema: SetAgencyClientTeamRequest }) body: SetAgencyClientTeamRequest,
  ): Promise<AgencyClientTeamResponse> {
    return this.vinculos.escolherTime(auth, id, body);
  }

  @Delete('clients/:id')
  @Auditar('agencia.deixar_cliente', { recurso: 'partner_link' })
  @Permissao('agencia.clientes')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Deixar de cuidar de uma empresa',
    description: 'Desfaz o vínculo pelo lado da agência, na hora e sem o código; o Dono da empresa é avisado por e-mail.',
  })
  @ApiNoContentResponse({ description: 'Vínculo desfeito' })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  async leave(@Auth() auth: AuthContext, @Param('id', { schema: ResourceId }) id: string): Promise<void> {
    await this.vinculos.deixar(auth, id);
  }

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
