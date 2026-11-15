import { CreateVideoCutsRequest, ProblemDetails, ResourceId, VideoCutsResponse } from '@liame/contracts';
import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { Auditar } from '../audit/auditar.js';
import { Auth, Permissao } from '../auth/access.js';
import type { AuthContext } from '../context/request-context.js';
import { CortesDoSocialService } from './cortes-do-social.service.js';

// Os melhores momentos (A6 · Z16, parte 3; P46; D-A6-150 a D-A6-154): o pedido dos cortes ao Social media e a proposta.
// Os quadros são tirados pelo serviço de montagem (`liame-render`); a leitura pelo Social media é do worker.

@ApiTags('video-montado')
@ApiCookieAuth('liame_sessao')
@Controller('video-montages')
export class CortesDoSocialController {
  constructor(private readonly cortes: CortesDoSocialService) {}

  @Post('cuts')
  @HttpCode(201)
  @Permissao('fotos.enviar')
  @Auditar('video_cortes.pedir', { recurso: 'video_cut_request' })
  @ApiOperation({
    summary: 'Pedir os cortes dos melhores momentos ao Social media',
    description:
      'Confere o pedido e o grava como `pedido`: de 1 a 4 vídeos prontos de Fotos desta marca, na ordem, sem repetir, cada um com 3 segundos ou mais (o vídeo montado pelo Liame não entra), e a duração (10, 15 ou 20 segundos). O serviço de montagem tira os quadros dos vídeos e o Social media propõe de 2 a 6 cortes, conferidos pela régua antes de aparecer (acompanhe por `GET /v1/video-montages/cuts/{id}`). No "Pedir outros cortes", `previous_id` é o pedido de antes, da mesma marca, até 2 vezes (409 `outros-acabaram`). Cada marca pede até 10 vezes por dia, deu ou não deu (409 `limite-do-dia`; volta à meia-noite, no fuso da empresa). Precisa da função `video_momentos` (409 `funcao-desligada`). Recusas (422): `midia-repetida`, `midia-fora-das-fotos`, `midia-montada`, `so-videos`, `video-curto`, `pedido-anterior-fora`.',
  })
  @ApiCreatedResponse({ standardSchema: VideoCutsResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  @ApiConflictResponse({ standardSchema: ProblemDetails })
  @ApiUnprocessableEntityResponse({ standardSchema: ProblemDetails })
  pedir(@Auth() auth: AuthContext, @Body({ schema: CreateVideoCutsRequest }) body: CreateVideoCutsRequest): Promise<VideoCutsResponse> {
    return this.cortes.pedir(auth, body);
  }

  @Get('cuts/:id')
  @Permissao('fotos.ver')
  @ApiOperation({
    summary: 'Um pedido dos cortes',
    description:
      'A situação (`pedido`, `quadros_prontos`, `lendo`, `pronta` ou `falhou` com o porquê em `reason`), os cortes conferidos quando pronta (o vídeo de Fotos, o começo e o fim em milissegundos e a legenda, na ordem do vídeo), o total e quantos "Pedir outros cortes" restam. O de outra empresa, ou que não existe, 404.',
  })
  @ApiOkResponse({ standardSchema: VideoCutsResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  obter(@Auth() auth: AuthContext, @Param('id', { schema: ResourceId }) id: string): Promise<VideoCutsResponse> {
    return this.cortes.obter(auth, id);
  }
}
