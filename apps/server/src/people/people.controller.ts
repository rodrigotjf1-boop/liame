import {
  CreateInvitationRequest,
  InvitationResponse,
  MemberResponse,
  PeopleResponse,
  ProblemDetails,
  ResourceId,
  UpdateMemberRequest,
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
import { Auth, Permissao } from '../auth/access.js';
import type { AuthContext } from '../context/request-context.js';
import { PeopleService } from './people.service.js';
import { Auditar } from '../audit/auditar.js';

// Pessoas e acessos da empresa ativa (ADR-017).
@ApiTags('people')
@ApiCookieAuth('liame_sessao')
@Controller()
export class PeopleController {
  constructor(private readonly people: PeopleService) {}

  @Get('people')
  @Permissao('pessoas.ver')
  @ApiOperation({ summary: 'Pessoas e acessos', description: 'Quem tem acesso à empresa ativa e os convites em aberto.' })
  @ApiOkResponse({ standardSchema: PeopleResponse })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  list(@Auth() auth: AuthContext): Promise<PeopleResponse> {
    return this.people.list(auth);
  }

  @Post('invitations')
  @Auditar('convite.criar', { recurso: 'invitation' })
  @Permissao('pessoas.convidar')
  @HttpCode(201)
  @ApiOperation({
    summary: 'Convidar pessoa',
    description:
      'Manda por e-mail um link de uso único que vence em 7 dias e só vale para o e-mail convidado. Convidar de novo o mesmo e-mail substitui o convite em aberto. Ninguém dá nível, limite ou cobrança acima do que tem.',
  })
  @ApiCreatedResponse({ standardSchema: InvitationResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiConflictResponse({ standardSchema: ProblemDetails })
  @ApiTooManyRequestsResponse({ standardSchema: ProblemDetails })
  invite(@Auth() auth: AuthContext, @Body({ schema: CreateInvitationRequest }) body: CreateInvitationRequest): Promise<InvitationResponse> {
    return this.people.invite(auth, body);
  }

  @Delete('invitations/:id')
  @Auditar('convite.cancelar', { recurso: 'invitation' })
  @Permissao('pessoas.convidar')
  @HttpCode(204)
  @ApiOperation({ summary: 'Cancelar convite', description: 'O link deixa de valer na hora.' })
  @ApiNoContentResponse({ description: 'Convite cancelado' })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  async revokeInvitation(@Auth() auth: AuthContext, @Param('id', { schema: ResourceId }) id: string): Promise<void> {
    await this.people.revokeInvitation(auth, id);
  }

  @Patch('members/:id')
  @Auditar('acesso.alterar', { recurso: 'membership' })
  @Permissao('pessoas.alterar_nivel')
  @ApiOperation({
    summary: 'Mudar o acesso de alguém',
    description: 'Nível, limite de aprovação, aprovação dupla, cobrança e data de fim. O dono não muda, ninguém muda o próprio acesso e ninguém dá mais do que tem.',
  })
  @ApiOkResponse({ standardSchema: MemberResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  updateMember(
    @Auth() auth: AuthContext,
    @Param('id', { schema: ResourceId }) id: string,
    @Body({ schema: UpdateMemberRequest }) body: UpdateMemberRequest,
  ): Promise<MemberResponse> {
    return this.people.updateMember(auth, id, body);
  }

  @Delete('members/:id')
  @Auditar('acesso.remover', { recurso: 'membership' })
  @Permissao('pessoas.remover')
  @HttpCode(204)
  @ApiOperation({ summary: 'Remover acesso', description: 'Corta o acesso da pessoa a esta empresa na hora. O dono não sai.' })
  @ApiNoContentResponse({ description: 'Acesso removido' })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  async removeMember(@Auth() auth: AuthContext, @Param('id', { schema: ResourceId }) id: string): Promise<void> {
    await this.people.removeMember(auth, id);
  }
}
