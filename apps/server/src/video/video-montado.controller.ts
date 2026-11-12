import { CreateVideoMontageRequest, ProblemDetails, ResourceId, VideoMontageListQuery, VideoMontageListResponse, VideoMontageResponse } from '@liame/contracts';
import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
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
import { VideoMontadoService } from './video-montado.service.js';

// O vídeo montado pelo Liame (A6 · Z15, parte 2a; P43 aprovado em 11/11/2026; D-A6-133 a D-A6-138): os pedidos e a
// fila. A montagem em si é do serviço `liame-render` (parte 2b); a tela "Montar um vídeo", em Fotos, vem na parte 4.

@ApiTags('video-montado')
@ApiCookieAuth('liame_sessao')
@Controller('video-montages')
export class VideoMontadoController {
  constructor(private readonly videos: VideoMontadoService) {}

  @Get()
  @Permissao('fotos.ver')
  @ApiOperation({
    summary: 'Os vídeos montados da marca',
    description:
      'Os pedidos mais recentes da marca (até 20), cada um com a situação (`na_fila`, `montando`, `pronto`, `nao_deu` com o porquê), o andamento e, na fila, quantos vídeos estão na frente (de todas as marcas: o serviço de montagem faz um por vez); se a função `video_montado` está ligada; quantos vídeos de hoje contam no limite (10 por marca; o que não deu não conta) e quando o limite volta; e se Minha marca tem a logo do restaurante.',
  })
  @ApiOkResponse({ standardSchema: VideoMontageListResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  lista(@Auth() auth: AuthContext, @Query({ schema: VideoMontageListQuery }) query: VideoMontageListQuery): Promise<VideoMontageListResponse> {
    return this.videos.lista(auth, query.brand_id);
  }

  @Post()
  @HttpCode(201)
  @Permissao('fotos.enviar')
  @Auditar('video_montado.pedir', { recurso: 'video_montage' })
  @ApiOperation({
    summary: 'Pedir um vídeo montado',
    description:
      'Confere o pedido e o põe na fila: o modelo (`destaque`, uma foto; `combo`, de 2 a 4 fotos; `novidade`, uma foto ou um vídeo), as fotos ou o vídeo prontos de Fotos desta marca, na ordem (o vídeo montado não entra de novo), o formato, a duração (6, 10 ou 15 segundos), os textos (título até 40, linha do preço até 24, só nos modelos com preço, e chamada até 30), a logo de Minha marca e o som (o original só com vídeo). Os textos passam pelo Compliance, como nas peças: o preço só o de uma oferta em vigor em Minha marca, as regras do Liame e o que a marca não diz (422 `texto-barrado`, com cada trecho). Precisa da função `video_montado` (409 `funcao-desligada`). Recusas (422): `midia-repetida`, `midias-do-modelo`, `preco-no-modelo`, `midia-fora-das-fotos`, `midia-montada`, `video-no-modelo`, `som-sem-video`, `sem-logo`, `texto-barrado`. Conflito (409): `limite-do-dia`.',
  })
  @ApiCreatedResponse({ standardSchema: VideoMontageResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  @ApiConflictResponse({ standardSchema: ProblemDetails })
  @ApiUnprocessableEntityResponse({ standardSchema: ProblemDetails })
  criar(@Auth() auth: AuthContext, @Body({ schema: CreateVideoMontageRequest }) body: CreateVideoMontageRequest): Promise<VideoMontageResponse> {
    return this.videos.criar(auth, body);
  }

  @Get(':id')
  @Permissao('fotos.ver')
  @ApiOperation({ summary: 'Um vídeo montado', description: 'O pedido, a situação, o andamento e, na fila, quantos estão na frente. O de outra empresa, ou que não existe, 404.' })
  @ApiOkResponse({ standardSchema: VideoMontageResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  obter(@Auth() auth: AuthContext, @Param('id', { schema: ResourceId }) id: string): Promise<VideoMontageResponse> {
    return this.videos.obter(auth, id);
  }
}
