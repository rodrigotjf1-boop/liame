import { AcceptOwnershipTransferRequest, CreateOwnershipTransferRequest, OwnershipResponse, ProblemDetails, ResourceId } from '@liame/contracts';
import { Body, Controller, Delete, Get, HttpCode, Param, Post } from '@nestjs/common';
import {
  ApiConflictResponse,
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { Auditar } from '../audit/auditar.js';
import { Auth, Permissao } from '../auth/access.js';
import type { AuthContext } from '../context/request-context.js';
import { PropriedadeService } from './propriedade.service.js';

// A propriedade da conta (A7, W8, parte 2; ADR-017; P34; D-A7-59 a D-A7-61): em Pessoas e acessos. Só o Dono pede e
// cancela; só quem recebe aceita ou recusa (o serviço confere quem é quem).
@ApiTags('people')
@ApiCookieAuth('liame_sessao')
@Controller('ownership')
export class PropriedadeController {
  constructor(private readonly propriedade: PropriedadeService) {}

  @Get()
  @Permissao('pessoas.ver')
  @ApiOperation({
    summary: 'A propriedade da conta',
    description:
      'O Dono e desde quando; o pedido de transferência em aberto, só para o Dono e para quem recebe (`addressed_to_me`); para o Dono, quem pode receber (os Administradores com o app, de fora das agências) e quando pode transferir de novo (7 dias depois de receber a propriedade).',
  })
  @ApiOkResponse({ standardSchema: OwnershipResponse })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  ler(@Auth() auth: AuthContext): Promise<OwnershipResponse> {
    return this.propriedade.ler(auth);
  }

  @Post('transfers')
  @HttpCode(201)
  @Permissao('pessoas.ver')
  @Auditar('pessoas.propriedade_pedir', { recurso: 'ownership_transfer' })
  @ApiOperation({
    summary: 'Pedir a transferência da propriedade',
    description:
      'Só o Dono (403 `so-o-dono`), com o código do app. Para um Administrador da empresa que já entra com o app e não vem de uma agência (422 `nao-pode-receber`). Um pedido em aberto por empresa (409 `pedido-em-aberto`); quem recebeu a propriedade há menos de 7 dias espera (409 `propriedade-recente`). O pedido vale 7 dias, e até o aceite nada muda; os dois recebem um e-mail.',
  })
  @ApiOkResponse({ standardSchema: OwnershipResponse })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiConflictResponse({ standardSchema: ProblemDetails })
  @ApiUnprocessableEntityResponse({ standardSchema: ProblemDetails })
  pedir(@Auth() auth: AuthContext, @Body({ schema: CreateOwnershipTransferRequest }) body: CreateOwnershipTransferRequest): Promise<OwnershipResponse> {
    return this.propriedade.pedir(auth, body);
  }

  @Delete('transfers/:id')
  @HttpCode(204)
  @Permissao('pessoas.ver')
  @Auditar('pessoas.propriedade_cancelar', { recurso: 'ownership_transfer' })
  @ApiOperation({ summary: 'Cancelar o pedido de transferência', description: 'Só o Dono que pediu; quem ia receber é avisado por e-mail. Nada mudou.' })
  @ApiNoContentResponse({ description: 'Pedido cancelado' })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  async cancelar(@Auth() auth: AuthContext, @Param('id', { schema: ResourceId }) id: string): Promise<void> {
    await this.propriedade.cancelar(auth, id);
  }

  @Post('transfers/:id/accept')
  @HttpCode(200)
  @Permissao('pessoas.ver')
  @Auditar('pessoas.propriedade_aceitar', { recurso: 'ownership_transfer' })
  @ApiOperation({
    summary: 'Aceitar a propriedade da conta',
    description:
      'Só quem recebe, em até 7 dias, com o código do app e a versão dos Termos que aceita como dona (409 `termos-desatualizados`). Na hora: o Dono antigo fica como Administrador, sem a cobrança, ou sai, como pediu; quem aceitou vira a dona. A assinatura, as contas conectadas, a equipe e o que está em andamento continuam como estão.',
  })
  @ApiOkResponse({ standardSchema: OwnershipResponse })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  @ApiConflictResponse({ standardSchema: ProblemDetails })
  aceitar(
    @Auth() auth: AuthContext,
    @Param('id', { schema: ResourceId }) id: string,
    @Body({ schema: AcceptOwnershipTransferRequest }) body: AcceptOwnershipTransferRequest,
  ): Promise<OwnershipResponse> {
    return this.propriedade.aceitar(auth, id, body);
  }

  @Post('transfers/:id/decline')
  @HttpCode(204)
  @Permissao('pessoas.ver')
  @Auditar('pessoas.propriedade_recusar', { recurso: 'ownership_transfer' })
  @ApiOperation({ summary: 'Recusar a propriedade da conta', description: 'Só quem recebe; o Dono é avisado por e-mail. Nada muda.' })
  @ApiNoContentResponse({ description: 'Pedido recusado' })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  async recusar(@Auth() auth: AuthContext, @Param('id', { schema: ResourceId }) id: string): Promise<void> {
    await this.propriedade.recusar(auth, id);
  }
}
