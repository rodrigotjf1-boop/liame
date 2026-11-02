import { CreateOwnershipClaimRequest, OwnershipClaimDocumentKind, OwnershipClaimResponse, ProblemDetails, ResourceId } from '@liame/contracts';
import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Req } from '@nestjs/common';
import {
  ApiBody,
  ApiConflictResponse,
  ApiConsumes,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiPayloadTooLargeResponse,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { Auditar } from '../audit/auditar.js';
import { Auth, Permissao } from '../auth/access.js';
import type { AuthContext } from '../context/request-context.js';
import { PropriedadePelaDmsService } from './propriedade-pela-dms.service.js';

// A propriedade pedida à DMS quando o Dono não está mais (A7, W8, parte 6a; P34; D-A7-63, D-A7-64; D-A7-86), em Pessoas e
// acessos. O serviço confere quem é quem: só um Administrador da própria empresa pede; só o Dono responde.
@ApiTags('people')
@ApiCookieAuth('liame_sessao')
@Controller('ownership')
export class PropriedadePelaDmsController {
  constructor(private readonly propriedade: PropriedadePelaDmsService) {}

  @Get('claim')
  @Permissao('pessoas.ver')
  @ApiOperation({
    summary: 'O pedido da propriedade à DMS',
    description:
      'O pedido de quem lê (em andamento, ou o último que terminou há até 30 dias) ou, para o Dono, o pedido sobre ele na espera (`about_me`, para responder "Ainda cuido da conta"); e por que quem lê não pode pedir (`cannot_claim`, nulo = pode).',
  })
  @ApiOkResponse({ standardSchema: OwnershipClaimResponse })
  ler(@Auth() auth: AuthContext): Promise<OwnershipClaimResponse> {
    return this.propriedade.ler(auth);
  }

  @Post('claims')
  @HttpCode(201)
  @Permissao('pessoas.ver')
  @Auditar('pessoas.propriedade_dms_comecar', { recurso: 'ownership_claim' })
  @ApiOperation({
    summary: 'Começar o pedido da propriedade à DMS',
    description:
      'Só um Administrador da própria empresa (403 `so-administrador`; quem vem de uma agência, 403 `vem-de-agencia`; o Dono, 403 `e-o-dono`), com o app autenticador (409 `sem-segundo-fator`). Um pedido em andamento por empresa (409 `pedido-em-andamento`); até 5 por dia (429). Com os Termos de agora, aceitos como dona se a DMS aprovar (409 `termos-desatualizados`). Cria o rascunho, ou atualiza o rascunho de quem pede. Sem a chave da DMS no ar, 503 `propriedade-indisponivel`.',
  })
  @ApiCreatedResponse({ standardSchema: OwnershipClaimResponse })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiConflictResponse({ standardSchema: ProblemDetails })
  @ApiTooManyRequestsResponse({ standardSchema: ProblemDetails })
  @ApiServiceUnavailableResponse({ standardSchema: ProblemDetails })
  comecar(@Auth() auth: AuthContext, @Body({ schema: CreateOwnershipClaimRequest }) body: CreateOwnershipClaimRequest): Promise<OwnershipClaimResponse> {
    return this.propriedade.comecar(auth, body);
  }

  @Put('claims/:id/documents/:kind')
  @HttpCode(200)
  @Permissao('pessoas.ver')
  @Auditar('pessoas.propriedade_dms_documento', { recurso: 'ownership_claim' })
  @ApiConsumes('image/jpeg', 'image/png', 'application/pdf')
  @ApiBody({ description: 'O documento, cru, até 10 MB.', schema: { type: 'string', format: 'binary' } })
  @ApiOperation({
    summary: 'Mandar um documento do pedido da propriedade',
    description:
      'No rascunho de quem pede (404 `nao-encontrado`): `documento_com_foto` (RG ou CNH de quem pede) ou `documento_da_empresa` (contrato social, alteração ou certidão da Junta). O tipo é lido do conteúdo: só JPG, PNG ou PDF (422 `documento-formato`), até 10 MB (413 `grande-demais`). Mandar de novo troca o anterior. Lacrado com a chave pública da DMS.',
  })
  @ApiOkResponse({ standardSchema: OwnershipClaimResponse })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  @ApiPayloadTooLargeResponse({ standardSchema: ProblemDetails })
  @ApiUnprocessableEntityResponse({ standardSchema: ProblemDetails })
  @ApiServiceUnavailableResponse({ standardSchema: ProblemDetails })
  documento(
    @Auth() auth: AuthContext,
    @Param('id', { schema: ResourceId }) id: string,
    @Param('kind', { schema: OwnershipClaimDocumentKind }) kind: OwnershipClaimDocumentKind,
    @Req() req: { body?: unknown },
  ): Promise<OwnershipClaimResponse> {
    return this.propriedade.documento(auth, id, kind, req.body);
  }

  @Post('claims/:id/send')
  @HttpCode(200)
  @Permissao('pessoas.ver')
  @Auditar('pessoas.propriedade_dms_enviar', { recurso: 'ownership_claim' })
  @ApiOperation({
    summary: 'Enviar o pedido da propriedade à DMS',
    description: 'Com os dois documentos (422 `faltam-documentos`). E-mail a quem pediu (o protocolo) e à DMS (só o protocolo).',
  })
  @ApiOkResponse({ standardSchema: OwnershipClaimResponse })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  @ApiUnprocessableEntityResponse({ standardSchema: ProblemDetails })
  enviar(@Auth() auth: AuthContext, @Param('id', { schema: ResourceId }) id: string): Promise<OwnershipClaimResponse> {
    return this.propriedade.enviar(auth, id);
  }

  @Delete('claims/:id')
  @HttpCode(200)
  @Permissao('pessoas.ver')
  @Auditar('pessoas.propriedade_dms_cancelar', { recurso: 'ownership_claim' })
  @ApiOperation({ summary: 'Desistir do pedido da propriedade', description: 'Só quem pediu. O rascunho some; o pedido enviado fica cancelado.' })
  @ApiOkResponse({ standardSchema: OwnershipClaimResponse })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  cancelar(@Auth() auth: AuthContext, @Param('id', { schema: ResourceId }) id: string): Promise<OwnershipClaimResponse> {
    return this.propriedade.cancelar(auth, id);
  }

  @Post('claims/:id/contest')
  @HttpCode(200)
  @Permissao('pessoas.ver')
  @Auditar('pessoas.propriedade_dms_contestar', { recurso: 'ownership_claim' })
  @ApiOperation({
    summary: 'Ainda cuido da conta',
    description: 'Só o Dono (403 `so-o-dono`), com o pedido sobre ele na espera (404 `nao-encontrado`). O pedido para, e a DMS fala com os dois antes de decidir.',
  })
  @ApiOkResponse({ standardSchema: OwnershipClaimResponse })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  contestar(@Auth() auth: AuthContext, @Param('id', { schema: ResourceId }) id: string): Promise<OwnershipClaimResponse> {
    return this.propriedade.contestar(auth, id);
  }
}
