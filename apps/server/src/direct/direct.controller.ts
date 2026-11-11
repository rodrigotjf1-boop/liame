import {
  DirectConversationId,
  DirectConversationResponse,
  DirectConversationsQuery,
  DirectConversationsResponse,
  DirectSettingsQuery,
  DirectSettingsRequest,
  DirectSettingsResponse,
  ProblemDetails,
} from '@liame/contracts';
import { Body, Controller, Get, Param, Put, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { Auditar } from '../audit/auditar.js';
import { Auth, Permissao } from '../auth/access.js';
import type { AuthContext } from '../context/request-context.js';
import { DirectService } from './direct.service.js';

// O Direct do Instagram (A6, Z12, parte 1; protótipo P39): o ajuste da marca e o que a tela Direct lê. As rotas de
// leitura só leem o que a rotina `direct` do worker guardou; responder vem à parte (Z12, parte 3).

@ApiTags('direct')
@ApiCookieAuth('liame_sessao')
@Controller('direct')
export class DirectController {
  constructor(private readonly direct: DirectService) {}

  @Get('settings')
  @Permissao('campanhas.ver')
  @ApiOperation({
    summary: 'O Direct da marca',
    description:
      'Como está o Direct do Instagram da marca (A6, Z12; P39, D-A6-107 e D-A6-109): `available` (a função `direct` liberada para a empresa), ligado, a confirmação de que nenhum outro programa responde aquele Direct, quem pode ligar (o Dono ou um Administrador) e desligar (quem aprova), a conta do Instagram, a conferência com o Regem (`regem`: o Direct do Liame fica desligado na conta que a Central do Regem atende) e a leitura.',
  })
  @ApiOkResponse({ standardSchema: DirectSettingsResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  verAjuste(@Auth() auth: AuthContext, @Query({ schema: DirectSettingsQuery }) query: DirectSettingsQuery): Promise<DirectSettingsResponse> {
    return this.direct.verAjuste(auth, query);
  }

  @Put('settings')
  @Permissao('acoes.aprovar')
  @Auditar('direct.ajuste', { recurso: 'brand' })
  @ApiOperation({
    summary: 'Ligar ou desligar o Direct',
    description:
      'Liga ou desliga o Direct do Instagram da marca. Ligar pede o Dono ou um Administrador, a função liberada, o Instagram conectado, `no_other_app` (nenhum outro programa responde aquele Direct) e a confirmação de quem é (o código do app ou a chave de acesso); a leitura começa em até um minuto. Desligar vale na hora, sem código, para quem aprova. Fica na auditoria, com o antes e o depois.',
  })
  @ApiOkResponse({ standardSchema: DirectSettingsResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  @ApiConflictResponse({ standardSchema: ProblemDetails })
  @ApiUnprocessableEntityResponse({ standardSchema: ProblemDetails })
  @ApiTooManyRequestsResponse({ standardSchema: ProblemDetails })
  mudarAjuste(@Auth() auth: AuthContext, @Body({ schema: DirectSettingsRequest }) body: DirectSettingsRequest): Promise<DirectSettingsResponse> {
    return this.direct.mudarAjuste(auth, body);
  }

  @Get('conversations')
  @Permissao('campanhas.ver')
  @ApiOperation({
    summary: 'As conversas do Direct',
    description:
      'As conversas do Direct do Instagram da marca que a rotina `direct` guardou (A6, Z12; P39, D-A6-111), na situação pedida (`espera`, `fechando`, `respondida`, `fora` ou `todas`), com a contagem de cada uma; as que esperam resposta vêm primeiro, a que fecha a janela antes na frente. A busca olha o @ e o texto. Vazia com a função desligada, o Direct desligado na marca ou o Regem atendendo a conta.',
  })
  @ApiOkResponse({ standardSchema: DirectConversationsResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  conversas(@Auth() auth: AuthContext, @Query({ schema: DirectConversationsQuery }) query: DirectConversationsQuery): Promise<DirectConversationsResponse> {
    return this.direct.conversas(auth, query);
  }

  @Get('conversations/:id')
  @Permissao('campanhas.ver')
  @ApiOperation({
    summary: 'Uma conversa do Direct',
    description:
      'A conversa e as mensagens guardadas dela (as 100 mais novas, da mais velha para a mais nova): o texto e, do que só a Meta guarda (a foto, o vídeo, o áudio, o story), só o tipo (D-A6-112).',
  })
  @ApiOkResponse({ standardSchema: DirectConversationResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  conversa(
    @Auth() auth: AuthContext,
    @Param('id', { schema: DirectConversationId }) id: string,
    @Query({ schema: DirectSettingsQuery }) query: DirectSettingsQuery,
  ): Promise<DirectConversationResponse> {
    return this.direct.conversa(auth, query.brand_id, id);
  }
}
