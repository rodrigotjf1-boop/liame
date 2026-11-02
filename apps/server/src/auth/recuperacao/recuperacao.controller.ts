import { CreateAccountRecoveryQuery, MyAccountRecoveryResponse, ProblemDetails, ResourceId } from '@liame/contracts';
import { Controller, Delete, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import {
  ApiBadRequestResponse,
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
import { Auditar } from '../../audit/auditar.js';
import type { AuthContext } from '../../context/request-context.js';
import { Auth, Autenticado } from '../access.js';
import { RecuperacaoDaContaService } from './recuperacao.service.js';

// A recuperação da conta do Dono pela entrada (A7, W8, parte 4a; P34; D-A7-62, D-A7-64; D-A7-85). As três rotas valem
// ANTES do segundo fator: quem perdeu o celular e os códigos só tem a senha. O serviço confere o resto (é o Dono, a
// sessão ainda não passou pelo app, um pedido por vez).
@ApiTags('me')
@ApiCookieAuth('liame_sessao')
@Controller('me/account-recovery')
export class RecuperacaoDaContaController {
  constructor(private readonly recuperacao: RecuperacaoDaContaService) {}

  @Get()
  @Autenticado({ antesDoSegundoFator: true })
  @ApiOperation({
    summary: 'A recuperação da minha conta',
    description:
      'O pedido em andamento, ou o último que terminou há até 30 dias; as empresas de que a pessoa é a dona; e por que não dá para pedir agora (`cannot_request`, nulo = pode). Vale antes do segundo fator.',
  })
  @ApiOkResponse({ standardSchema: MyAccountRecoveryResponse })
  minha(@Auth() auth: AuthContext): Promise<MyAccountRecoveryResponse> {
    return this.recuperacao.minha(auth);
  }

  @Post()
  @HttpCode(201)
  @Autenticado({ antesDoSegundoFator: true })
  @Auditar('segundo_fator.recuperacao_pedir', { escopo: 'pessoa', recurso: 'account_recovery' })
  @ApiConsumes('image/jpeg', 'image/png', 'application/pdf')
  @ApiBody({ description: 'O documento com foto (RG ou CNH, frente e verso), cru, até 10 MB.', schema: { type: 'string', format: 'binary' } })
  @ApiOperation({
    summary: 'Pedir a recuperação da conta',
    description:
      'Só o Dono (403 `nao-e-dono`), depois da senha e antes do app (409 `ja-entrou`; a conta sem app, 409 `sem-segundo-fator`). Um pedido em andamento por pessoa (409 `pedido-em-andamento`); até 3 por dia (429). O que aconteceu vai na consulta (`reason`); o documento, cru no corpo: o tipo é lido do conteúdo, só JPG, PNG ou PDF (422 `documento-formato`), até 10 MB (413 `grande-demais`); sem o documento, 400 `falta-o-documento`. O documento é lacrado com a chave pública da DMS e só a DMS o abre; sem a chave configurada, 503 `recuperacao-indisponivel`. E-mail à pessoa (o protocolo) e à DMS.',
  })
  @ApiCreatedResponse({ standardSchema: MyAccountRecoveryResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiConflictResponse({ standardSchema: ProblemDetails })
  @ApiPayloadTooLargeResponse({ standardSchema: ProblemDetails })
  @ApiUnprocessableEntityResponse({ standardSchema: ProblemDetails })
  @ApiTooManyRequestsResponse({ standardSchema: ProblemDetails })
  @ApiServiceUnavailableResponse({ standardSchema: ProblemDetails })
  pedir(
    @Auth() auth: AuthContext,
    @Query({ schema: CreateAccountRecoveryQuery }) query: CreateAccountRecoveryQuery,
    @Req() req: { body?: unknown },
  ): Promise<MyAccountRecoveryResponse> {
    return this.recuperacao.pedir(auth, query.reason, req.body);
  }

  @Delete(':id')
  @HttpCode(200)
  @Autenticado({ antesDoSegundoFator: true })
  @Auditar('segundo_fator.recuperacao_cancelar', { escopo: 'pessoa', recurso: 'account_recovery' })
  @ApiOperation({
    summary: 'Cancelar o pedido de recuperação',
    description: 'Só quem pediu, com o pedido em andamento (404 `nao-encontrado`). O app autenticador de antes continua valendo. E-mail à pessoa.',
  })
  @ApiOkResponse({ standardSchema: MyAccountRecoveryResponse })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  cancelar(@Auth() auth: AuthContext, @Param('id', { schema: ResourceId }) id: string): Promise<MyAccountRecoveryResponse> {
    return this.recuperacao.cancelar(auth, id);
  }
}
