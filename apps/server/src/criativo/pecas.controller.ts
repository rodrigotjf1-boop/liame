import {
  AdPieceListQuery,
  AdPieceListResponse,
  AdPieceOptionsQuery,
  AdPieceOptionsResponse,
  AdPieceRequestListQuery,
  AdPieceRequestListResponse,
  AdPieceRequestResponse,
  AdPieceResponse,
  CreateAdPieceRequest,
  ProblemDetails,
  ResourceId,
} from '@liame/contracts';
import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import {
  ApiAcceptedResponse,
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
import { PecasService } from './pecas.service.js';

// As peças do Criativo (A4, X6; protótipo P10, aguardando aprovação; sem tela ainda): quem opera campanhas pede peças
// para uma oferta de Minha marca; o Criativo escreve na fila do worker; cada peça aparece conferida, item por item.
// Nada vai para a Meta por aqui.

@ApiTags('pecas')
@ApiCookieAuth('liame_sessao')
@Controller('ad-pieces')
export class PecasController {
  constructor(private readonly pecas: PecasService) {}

  @Get('options')
  @Permissao('campanhas.ver')
  @ApiOperation({
    summary: 'O que dá para pedir ao Criativo',
    description:
      'Se dá para pedir uma peça agora (com o motivo quando não dá: o Criativo desligado, Minha marca sem dossiê ou sem oferta, ou um pedido ainda em andamento), as ofertas de Minha marca com o que impede cada uma de ir ao Criativo (política, categoria proibida, bebida alcoólica) e se ela escreve um preço, e os anúncios da marca com pedidos confirmados nos últimos 7 dias completos, do que mais vendeu para o que menos.',
  })
  @ApiOkResponse({ standardSchema: AdPieceOptionsResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  opcoes(@Auth() auth: AuthContext, @Query({ schema: AdPieceOptionsQuery }) query: AdPieceOptionsQuery): Promise<AdPieceOptionsResponse> {
    return this.pecas.opcoes(auth, query.brand_id);
  }

  @Post('requests')
  @HttpCode(202)
  @Permissao('campanhas.operar')
  @Auditar('peca.pedir', { recurso: 'ad_piece_request' })
  @ApiOperation({
    summary: 'Pedir peças ao Criativo',
    description:
      'Peças de anúncio (título, texto principal e botão) para uma oferta de Minha marca, escrita no pedido exatamente como está lá. O pedido é conferido antes de ir ao Criativo: a oferta de política, de categoria proibida ou de bebida alcoólica não vai, e a instrução não bate em regra, não cita concorrente, não leva link e não muda o preço (422 `pedido-recusado`, com o que mudar em cada campo). As peças saem na fila, cada uma conferida pelo código, e esperam a decisão de uma pessoa. Precisa do Criativo ligado (409 `criativo-desligado`) e de Minha marca preenchida (409 `sem-dossie`); um pedido de peças novas por marca de cada vez (409 `lote-em-andamento`); até 30 pedidos por marca por dia (429).',
  })
  @ApiAcceptedResponse({ standardSchema: AdPieceRequestResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  @ApiConflictResponse({ standardSchema: ProblemDetails })
  @ApiUnprocessableEntityResponse({ standardSchema: ProblemDetails })
  @ApiTooManyRequestsResponse({ standardSchema: ProblemDetails })
  pedir(@Auth() auth: AuthContext, @Body({ schema: CreateAdPieceRequest }) body: CreateAdPieceRequest): Promise<AdPieceRequestResponse> {
    return this.pecas.pedir(auth, body);
  }

  @Get('requests')
  @Permissao('campanhas.ver')
  @ApiOperation({
    summary: 'Os pedidos de peça da marca',
    description: 'Os pedidos feitos ao Criativo, os mais novos primeiro (até 50): a oferta, a situação, o porquê de cada recusa e quantas peças saíram.',
  })
  @ApiOkResponse({ standardSchema: AdPieceRequestListResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  pedidos(@Auth() auth: AuthContext, @Query({ schema: AdPieceRequestListQuery }) query: AdPieceRequestListQuery): Promise<AdPieceRequestListResponse> {
    return this.pecas.pedidos(auth, query.brand_id);
  }

  @Get()
  @Permissao('campanhas.ver')
  @ApiOperation({
    summary: 'As peças da marca',
    description:
      'As peças do Criativo, as mais novas primeiro (até 100), com a versão atual de cada uma e a conferência dela. `status`: `decidir` (esperam a pessoa), `aprovada` (a biblioteca) ou `recusada`; sem ele, todas.',
  })
  @ApiOkResponse({ standardSchema: AdPieceListResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  lista(@Auth() auth: AuthContext, @Query({ schema: AdPieceListQuery }) query: AdPieceListQuery): Promise<AdPieceListResponse> {
    return this.pecas.lista(auth, query);
  }

  @Get(':id')
  @Permissao('campanhas.ver')
  @ApiOperation({
    summary: 'Uma peça, com as versões',
    description:
      'A peça com todas as versões, da mais nova para a mais antiga. Cada versão traz o título, o texto principal, o botão, quem escreveu (o Criativo ou uma pessoa) e a conferência, item por item: a oferta (o preço e as condições são os dela), as regras da Liame e das plataformas, as regras da marca e o tamanho que a Meta recomenda. Com um item barrado, a peça não pode ser aprovada; o tamanho só avisa.',
  })
  @ApiOkResponse({ standardSchema: AdPieceResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  detalhe(@Auth() auth: AuthContext, @Param('id', { schema: ResourceId }) id: string): Promise<AdPieceResponse> {
    return this.pecas.detalhe(auth, id);
  }
}
