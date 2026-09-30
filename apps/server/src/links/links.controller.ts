import {
  CreatedTrackingLinkResponse,
  CreateTrackingLinkRequest,
  LinkListQuery,
  LinkOptionsQuery,
  LinkOptionsResponse,
  ProblemDetails,
  ResourceId,
  TrackingCheckQuery,
  TrackingCheckResponse,
  TrackingLinkDetailResponse,
  TrackingLinkListResponse,
} from '@liame/contracts';
import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiCookieAuth,
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
import { LinksService } from './links.service.js';

// Links de campanha (A2.5, F5; protótipo P3): o link do cardápio com rastreio, os parâmetros para colar no
// anúncio, o QR e a conferência dos anúncios ativos. Sem escrita na Meta nem no Google e sem redirecionador:
// o link leva direto ao cardápio da loja. As rotas fixas vêm antes de `links/:id`.
@ApiTags('links')
@ApiCookieAuth('liame_sessao')
@Controller('links')
export class LinksController {
  constructor(private readonly links: LinksService) {}

  @Get()
  @Permissao('vendas.ver')
  @ApiOperation({
    summary: 'Links de campanha',
    description:
      'Os links da marca (ou de uma loja ou campanha), do mais novo ao mais antigo: o código (`lk`), o link com rastreio para a bio, o WhatsApp e o QR, os parâmetros para colar no anúncio (Meta: "Parâmetros de URL"; Google Ads: "Sufixo do URL final") e os pedidos dos últimos 7 dias que chegaram por ele.',
  })
  @ApiOkResponse({ standardSchema: TrackingLinkListResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  list(@Query({ schema: LinkListQuery }) query: LinkListQuery): Promise<TrackingLinkListResponse> {
    return this.links.list(query);
  }

  @Get('options')
  @Permissao('links.gerenciar')
  @ApiOperation({
    summary: 'O que dá para escolher ao criar um link',
    description:
      'Os cardápios das lojas da marca (vindos da conexão do Regem; loja sem cardápio ou sem loja do Liame aparece com o motivo), as campanhas ativas e pausadas da Meta e do Google Ads com os anúncios e o tipo de destino (campanha que abre o WhatsApp não leva link do cardápio) e quando cada conta foi lida.',
  })
  @ApiOkResponse({ standardSchema: LinkOptionsResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  options(@Query({ schema: LinkOptionsQuery }) query: LinkOptionsQuery): Promise<LinkOptionsResponse> {
    return this.links.options(query.brand_id);
  }

  @Get('tracking-check')
  @Permissao('vendas.ver')
  @ApiOperation({
    summary: 'Conferência do rastreio dos anúncios ativos',
    description:
      'Para cada anúncio ativo na última leitura da Meta e do Google Ads, se ele leva o rastreio que o motor de atribuição usa: o código de um link desta campanha ou os ids da campanha, do grupo ou do anúncio (Meta pelos parâmetros de URL e pelo link do criativo; Google pelo sufixo do URL final, pelo modelo de acompanhamento e pela URL final). Devolve os sem rastreio e os não verificados, com o motivo e o que fazer; o Liame não mexe nos anúncios.',
  })
  @ApiOkResponse({ standardSchema: TrackingCheckResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  trackingCheck(@Query({ schema: TrackingCheckQuery }) query: TrackingCheckQuery): Promise<TrackingCheckResponse> {
    return this.links.trackingCheck(query.brand_id);
  }

  @Get(':id')
  @Permissao('vendas.ver')
  @ApiOperation({ summary: 'Um link de campanha', description: 'O link, os parâmetros para colar e o QR do link com rastreio (SVG, com o mesmo `lk`).' })
  @ApiOkResponse({ standardSchema: TrackingLinkDetailResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  detail(@Param('id', { schema: ResourceId }) id: string): Promise<TrackingLinkDetailResponse> {
    return this.links.detail(id);
  }

  @Post()
  @Auditar('link.criar', { recurso: 'tracking_link' })
  @Permissao('links.gerenciar')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Criar um link de campanha',
    description:
      'Monta o link do cardápio da loja para uma campanha (e, se quiser, um anúncio): só o cardápio da loja é aceito como destino. O mesmo link (loja, campanha, anúncio e destino) criado de novo volta como estava, com `created` falso e o mesmo código. Devolve os parâmetros para colar no anúncio e o QR.',
  })
  @ApiOkResponse({ standardSchema: CreatedTrackingLinkResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  @ApiUnprocessableEntityResponse({ standardSchema: ProblemDetails })
  create(@Auth() auth: AuthContext, @Body({ schema: CreateTrackingLinkRequest }) body: CreateTrackingLinkRequest): Promise<CreatedTrackingLinkResponse> {
    return this.links.create(auth, body);
  }
}
