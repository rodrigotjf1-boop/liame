import { AcceptPartnerRequest, PartnerResponse, PartnersResponse, ProblemDetails, ResourceId, UpdatePartnerRequest } from '@liame/contracts';
import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCookieAuth,
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
import { VinculoService } from './vinculo.service.js';

// As agências da empresa ativa, em Pessoas e acessos (A7, W6, parte 2; ADR-017; D-A7-47 a D-A7-50).
@ApiTags('people')
@ApiCookieAuth('liame_sessao')
@Controller('partners')
export class PartnersController {
  constructor(private readonly vinculos: VinculoService) {}

  @Get()
  @Permissao('pessoas.ver')
  @ApiOperation({
    summary: 'Agências com acesso',
    description: 'As agências com vínculo nesta empresa e, só para o Dono, os pedidos em aberto ao e-mail dele. Com a função desligada, nenhum pedido aparece.',
  })
  @ApiOkResponse({ standardSchema: PartnersResponse })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  list(@Auth() auth: AuthContext): Promise<PartnersResponse> {
    return this.vinculos.parceiros(auth);
  }

  @Post('requests/:id/accept')
  @Auditar('parceiro.aceitar', { recurso: 'partner_link' })
  @Permissao('pessoas.convidar')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Aceitar o pedido de uma agência',
    description:
      'Só o Dono, com o código do app, para a empresa ativa: o nível máximo (nunca o Dono), o limite por ação, "acima disso, eu também aprovo" e a data de fim. O time da agência nunca convida nem remove pessoas e nunca vê a cobrança.',
  })
  @ApiOkResponse({ standardSchema: PartnerResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  @ApiConflictResponse({ standardSchema: ProblemDetails })
  @ApiTooManyRequestsResponse({ standardSchema: ProblemDetails })
  accept(
    @Auth() auth: AuthContext,
    @Param('id', { schema: ResourceId }) id: string,
    @Body({ schema: AcceptPartnerRequest }) body: AcceptPartnerRequest,
  ): Promise<PartnerResponse> {
    return this.vinculos.aceitar(auth, id, body);
  }

  @Post('requests/:id/refuse')
  @Auditar('parceiro.recusar', { recurso: 'partner_link' })
  @Permissao('pessoas.convidar')
  @HttpCode(204)
  @ApiOperation({ summary: 'Recusar o pedido de uma agência', description: 'Só o Dono, sem o código. A agência é avisada sem o motivo.' })
  @ApiNoContentResponse({ description: 'Pedido recusado' })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  @ApiConflictResponse({ standardSchema: ProblemDetails })
  async refuse(@Auth() auth: AuthContext, @Param('id', { schema: ResourceId }) id: string): Promise<void> {
    await this.vinculos.recusar(auth, id);
  }

  @Patch(':id')
  @Auditar('parceiro.alterar', { recurso: 'partner_link' })
  @Permissao('pessoas.alterar_nivel')
  @ApiOperation({
    summary: 'Mudar o que a agência pode',
    description: 'Só o Dono. Baixar vale na hora, sem o código; subir o nível ou o limite, tirar o "eu também aprovo" ou dar mais tempo pede o código do app.',
  })
  @ApiOkResponse({ standardSchema: PartnerResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  @ApiConflictResponse({ standardSchema: ProblemDetails })
  @ApiTooManyRequestsResponse({ standardSchema: ProblemDetails })
  update(
    @Auth() auth: AuthContext,
    @Param('id', { schema: ResourceId }) id: string,
    @Body({ schema: UpdatePartnerRequest }) body: UpdatePartnerRequest,
  ): Promise<PartnerResponse> {
    return this.vinculos.mudar(auth, id, body);
  }

  @Delete(':id')
  @Auditar('parceiro.desfazer', { recurso: 'partner_link' })
  @Permissao('pessoas.remover')
  @HttpCode(204)
  @ApiOperation({ summary: 'Desfazer o vínculo com a agência', description: 'Corta na hora, sem o código, mesmo com a função desligada. A agência é avisada.' })
  @ApiNoContentResponse({ description: 'Vínculo desfeito' })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  async remove(@Auth() auth: AuthContext, @Param('id', { schema: ResourceId }) id: string): Promise<void> {
    await this.vinculos.desfazer(auth, id);
  }
}
