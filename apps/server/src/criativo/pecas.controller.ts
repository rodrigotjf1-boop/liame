import {
  AdPieceListQuery,
  AdPieceListResponse,
  AdPieceOptionsQuery,
  AdPieceOptionsResponse,
  AdPieceRequestListQuery,
  AdPieceRequestListResponse,
  AdPieceRequestResponse,
  AdPieceResponse,
  ApproveAdPieceRequest,
  ApproveAdPiecesRequest,
  ApproveAdPiecesResponse,
  ContestAdPieceRequest,
  CreateAdPieceRequest,
  ProblemDetails,
  RedoAdPieceRequest,
  RejectAdPieceRequest,
  ResourceId,
  UpdateAdPieceRequest,
} from '@liame/contracts';
import { Body, Controller, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
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
import { DecisoesDePecaService } from './decisoes.service.js';
import { PecasService } from './pecas.service.js';

// As peças do Criativo (A4, X6; protótipo P10, aguardando aprovação; sem tela ainda): quem opera campanhas pede peças
// para uma oferta de Minha marca; o Criativo escreve na fila do worker; cada peça aparece conferida, item por item, e
// a pessoa decide: edita, aprova, recusa, pede outra ou contesta a conferência. Nada vai para a Meta por aqui.

@ApiTags('pecas')
@ApiCookieAuth('liame_sessao')
@Controller('ad-pieces')
export class PecasController {
  constructor(
    private readonly pecas: PecasService,
    private readonly decisoes: DecisoesDePecaService,
  ) {}

  @Get('options')
  @Permissao('campanhas.ver')
  @ApiOperation({
    summary: 'O que dá para pedir ao Criativo',
    description:
      'Se dá para pedir uma peça agora (com o motivo quando não dá: o Criativo desligado, Minha marca sem dossiê ou sem oferta, ou um pedido ainda em andamento), as ofertas de Minha marca com o que impede cada uma de ir ao Criativo (política, categoria proibida, bebida alcoólica) e se ela escreve um preço, e os anúncios da marca com pedidos confirmados nos últimos 7 dias completos, do que mais vendeu para o que menos. Para quem pode pedir peças, traz o custo à vista (`ai`): o uso de IA da empresa no dia e no mês com os limites, quanto ainda cabe, o que as peças da marca custaram hoje e a estimativa de um pedido (a média dos pedidos da própria empresa ou, sem histórico, o máximo que um pedido deve custar), em micros de dólar, com a cotação de referência para a tela mostrar em reais. Sem caber no que resta, `reason` é `limite_de_ia`.',
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
      'Peças de anúncio (título, texto principal e botão) para uma oferta de Minha marca, escrita no pedido exatamente como está lá. O pedido é conferido antes de ir ao Criativo: a oferta de política, de categoria proibida ou de bebida alcoólica não vai, e a instrução não bate em regra, não cita concorrente, não leva link e não muda o preço (422 `pedido-recusado`, com o que mudar em cada campo). As peças saem na fila, cada uma conferida pelo código, e esperam a decisão de uma pessoa. Precisa do Criativo ligado (409 `criativo-desligado`) e de Minha marca preenchida (409 `sem-dossie`); um pedido de peças novas por marca de cada vez (409 `lote-em-andamento`); o pedido que não cabe no que resta do limite de uso de IA da empresa é negado na hora (409 `limite-de-ia`); até 30 pedidos por marca por dia (429).',
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
      'A peça com todas as versões, da mais nova para a mais antiga. Cada versão traz o título, o texto principal, o botão, quem escreveu (o Criativo ou uma pessoa), o custo de IA dela (a parte dela na chamada que a escreveu; nulo na versão de uma pessoa) e a conferência, item por item: a oferta (o preço e as condições são os dela), as regras da Liame e das plataformas, as regras da marca e o tamanho que a Meta recomenda. Com um item barrado, a peça não pode ser aprovada; o tamanho só avisa.',
  })
  @ApiOkResponse({ standardSchema: AdPieceResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  detalhe(@Auth() auth: AuthContext, @Param('id', { schema: ResourceId }) id: string): Promise<AdPieceResponse> {
    return this.pecas.detalhe(auth, id);
  }

  @Put(':id')
  @Permissao('campanhas.operar')
  @Auditar('peca.editar', { recurso: 'ad_piece' })
  @ApiOperation({
    summary: 'Editar o texto de uma peça',
    description:
      'Nasce a versão seguinte, da pessoa, conferida de novo: o preço continua sendo o da oferta, e as regras da Liame e da marca valem. O texto que seria barrado não é salvo (422 `texto-barrado`, com o que mudar em cada campo). Só a peça que espera decisão (409 `peca-decidida`); `base_version` é a versão que a pessoa estava vendo (409 `peca-mudou`); enquanto o Criativo refaz a peça, editar espera (409 `peca-refazendo`); a oferta precisa continuar em Minha marca (409 `oferta-mudou`).',
  })
  @ApiOkResponse({ standardSchema: AdPieceResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  @ApiConflictResponse({ standardSchema: ProblemDetails })
  @ApiUnprocessableEntityResponse({ standardSchema: ProblemDetails })
  editar(@Auth() auth: AuthContext, @Param('id', { schema: ResourceId }) id: string, @Body({ schema: UpdateAdPieceRequest }) body: UpdateAdPieceRequest): Promise<AdPieceResponse> {
    return this.decisoes.editar(auth, id, body);
  }

  @Post(':id/approve')
  @HttpCode(200)
  @Permissao('campanhas.operar')
  @Auditar('peca.aprovar', { recurso: 'ad_piece' })
  @ApiOperation({
    summary: 'Aprovar uma peça',
    description:
      'A peça vai para a biblioteca. Vale para o hash que a pessoa viu (409 `peca-mudou`), e a peça é conferida de novo com as regras e a oferta de agora: a barrada não é aprovada (409 `peca-barrada`, com os motivos), nem a que partiu de uma oferta que mudou em Minha marca (409 `oferta-mudou`). Não pede o código do app: nada sai do Liame; criar e ativar uma campanha são pedidos à parte, com o código.',
  })
  @ApiOkResponse({ standardSchema: AdPieceResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  @ApiConflictResponse({ standardSchema: ProblemDetails })
  aprovar(@Auth() auth: AuthContext, @Param('id', { schema: ResourceId }) id: string, @Body({ schema: ApproveAdPieceRequest }) body: ApproveAdPieceRequest): Promise<AdPieceResponse> {
    return this.decisoes.aprovar(auth, id, body);
  }

  @Post('approve')
  @HttpCode(200)
  @Permissao('campanhas.operar')
  @Auditar('peca.aprovar_varias', { recurso: 'ad_piece' })
  @ApiOperation({
    summary: 'Aprovar várias peças de uma vez',
    description:
      '"Aprovar as que passaram": até 20 peças da marca, cada uma com o hash que a pessoa viu. Vale a mesma regra de aprovar uma, peça por peça: a conferência é refeita com as regras e a oferta de agora. A que não pode ser aprovada fica como está, com o motivo em `reason` (`nao_encontrada`, `peca_decidida`, `peca_refazendo`, `peca_mudou`, `oferta_mudou` ou `peca_barrada`), e as outras entram: a resposta é 200 mesmo quando nenhuma entra, com uma linha por peça, na ordem do pedido, e a peça como ficou. Não pede o código do app: nada sai do Liame.',
  })
  @ApiOkResponse({ standardSchema: ApproveAdPiecesResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiConflictResponse({ standardSchema: ProblemDetails })
  aprovarVarias(@Auth() auth: AuthContext, @Body({ schema: ApproveAdPiecesRequest }) body: ApproveAdPiecesRequest): Promise<ApproveAdPiecesResponse> {
    return this.decisoes.aprovarVarias(auth, body);
  }

  @Post(':id/reject')
  @HttpCode(200)
  @Permissao('campanhas.operar')
  @Auditar('peca.recusar', { recurso: 'ad_piece' })
  @ApiOperation({
    summary: 'Recusar uma peça',
    description: 'Com o motivo (`texto_nao_serve`, `nao_parece_a_marca`, `nao_preciso_mais` ou `outro`) e, se quiser, um comentário, guardado sem dado pessoal. Só a peça que espera decisão, pelo hash que a pessoa viu.',
  })
  @ApiOkResponse({ standardSchema: AdPieceResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  @ApiConflictResponse({ standardSchema: ProblemDetails })
  recusar(@Auth() auth: AuthContext, @Param('id', { schema: ResourceId }) id: string, @Body({ schema: RejectAdPieceRequest }) body: RejectAdPieceRequest): Promise<AdPieceResponse> {
    return this.decisoes.recusar(auth, id, body);
  }

  @Post(':id/redo')
  @HttpCode(202)
  @Permissao('campanhas.operar')
  @Auditar('peca.pedir_outra', { recurso: 'ad_piece' })
  @ApiOperation({
    summary: 'Pedir outra versão ao Criativo',
    description:
      'O Criativo refaz a peça, diferente da versão atual, e a versão nova entra na mesma peça (`redoing` fica verdadeiro até lá). `instruction` diz o que mudar; sem ela, vale a do pedido original. É um pedido à IA: precisa do Criativo ligado (409 `criativo-desligado`), passa pela conferência do pedido (422 `pedido-recusado`), precisa caber no que resta do limite de uso de IA da empresa (409 `limite-de-ia`) e conta no limite de pedidos do dia (429). Um de cada vez por peça (409 `peca-refazendo`).',
  })
  @ApiAcceptedResponse({ standardSchema: AdPieceResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  @ApiConflictResponse({ standardSchema: ProblemDetails })
  @ApiUnprocessableEntityResponse({ standardSchema: ProblemDetails })
  @ApiTooManyRequestsResponse({ standardSchema: ProblemDetails })
  pedirOutra(@Auth() auth: AuthContext, @Param('id', { schema: ResourceId }) id: string, @Body({ schema: RedoAdPieceRequest }) body: RedoAdPieceRequest): Promise<AdPieceResponse> {
    return this.decisoes.pedirOutra(auth, id, body);
  }

  @Post(':id/contest')
  @HttpCode(200)
  @Permissao('campanhas.operar')
  @Auditar('peca.contestar', { recurso: 'ad_piece' })
  @ApiOperation({
    summary: 'Dizer que a conferência errou',
    description: 'Para a peça barrada ou com aviso: o motivo fica guardado, sem dado pessoal, para a regra ser revista. A peça não é destravada: o que é regra não é liberado por quem está com pressa. Uma vez por versão (409 `ja-contestada`).',
  })
  @ApiOkResponse({ standardSchema: AdPieceResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  @ApiConflictResponse({ standardSchema: ProblemDetails })
  @ApiUnprocessableEntityResponse({ standardSchema: ProblemDetails })
  contestar(@Auth() auth: AuthContext, @Param('id', { schema: ResourceId }) id: string, @Body({ schema: ContestAdPieceRequest }) body: ContestAdPieceRequest): Promise<AdPieceResponse> {
    return this.decisoes.contestar(auth, id, body);
  }
}
