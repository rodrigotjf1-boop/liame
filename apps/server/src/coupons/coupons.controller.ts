import {
  CouponListQuery,
  CouponListResponse,
  CouponRequestResponse,
  CouponResponse,
  CreateExternalCouponRequest,
  CreateRegemCouponRequest,
  LinkCouponRequest,
  OrderPlatformResponse,
  ProblemDetails,
  ResourceId,
  SetOrderPlatformRequest,
} from '@liame/contracts';
import { Body, Controller, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCookieAuth,
  ApiCreatedResponse,
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
import { CouponsService } from './coupons.service.js';

// Cupons de campanha (A2.5, F6; protótipo P3 com a plataforma de pedidos, aprovado em 30/09/2026): os cupons
// do Regem e os informados de outra plataforma de pedidos, ligados a campanhas, e onde cada loja recebe os
// pedidos online. Nada é escrito na Meta, no Google nem na plataforma de pedidos; no Regem, só a criação de cupom,
// e ela não sai daqui: a rota monta o pedido e o Action Service cuida da política, da aprovação e da execução.
@ApiTags('cupons')
@ApiCookieAuth('liame_sessao')
@Controller()
export class CouponsController {
  constructor(private readonly coupons: CouponsService) {}

  @Get('coupons')
  @Permissao('vendas.ver')
  @ApiOperation({
    summary: 'Cupons das lojas da marca',
    description:
      'As lojas com o Regem conectado (plataforma de pedidos informada e quando os cupons foram lidos), os cupons delas (do Regem e os informados de outra plataforma), com os pedidos confirmados dos últimos 7 dias com o código e a campanha ligada, as campanhas da Meta e do Google Ads para ligar e a plataforma de pedidos sugerida pelo destino dos anúncios ativos.',
  })
  @ApiOkResponse({ standardSchema: CouponListResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  list(@Auth() auth: AuthContext, @Query({ schema: CouponListQuery }) query: CouponListQuery): Promise<CouponListResponse> {
    return this.coupons.list(auth, query.brand_id);
  }

  @Post('coupons/regem')
  @Auditar('cupom.pedir_criacao', { recurso: 'action_request' })
  @Permissao('cupons.criar')
  @HttpCode(201)
  @ApiOperation({
    summary: 'Pedir a criação de um cupom no Regem',
    description:
      'Monta o pedido de um cupom de campanha na loja do Regem (percentual, valor fixo ou entrega grátis, com validade em dias do fuso da loja) e o entrega ao Action Service: nada é criado agora. Quem pode aprovar confirma com o código do app (`POST /v1/actions/{id}/approve`); depois disso o Liame cria o cupom no Regem e o liga à campanha. Volta 403 se a criação pelo Liame está desligada para a empresa, 422 se a loja não liberou "criar cupom de campanha" no Regem ou se o código já existe nela, e 409 se já há um pedido ativo para o mesmo código.',
  })
  @ApiCreatedResponse({ standardSchema: CouponRequestResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  @ApiConflictResponse({ standardSchema: ProblemDetails })
  @ApiUnprocessableEntityResponse({ standardSchema: ProblemDetails })
  createInRegem(@Auth() auth: AuthContext, @Body({ schema: CreateRegemCouponRequest }) body: CreateRegemCouponRequest): Promise<CouponRequestResponse> {
    return this.coupons.createInRegem(auth, body);
  }

  @Post('coupons/regem/:id/cancel')
  @Auditar('cupom.cancelar_pedido', { recurso: 'action_request' })
  @Permissao('cupons.criar')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Cancelar o pedido de criação de um cupom',
    description: 'Cancela o pedido que ainda não foi executado (esperando aprovação ou já aprovado): o cupom não chega a existir no Regem. Depois de executado, volta 409.',
  })
  @ApiNoContentResponse({ description: 'Pedido cancelado' })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  @ApiConflictResponse({ standardSchema: ProblemDetails })
  async cancelRegemRequest(@Auth() auth: AuthContext, @Param('id', { schema: ResourceId }) id: string): Promise<void> {
    await this.coupons.cancelRegemRequest(auth, id);
  }

  @Post('coupons/external')
  @Auditar('cupom.informar', { recurso: 'coupon' })
  @Permissao('atribuicao.gerenciar')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Informar cupom de outra plataforma de pedidos',
    description:
      'Registra o código de um cupom criado no Anota AI ou no CardápioWeb (plataformas cujos pedidos chegam ao Regem com o código) e o liga a uma campanha. O Liame reconhece o cupom nos pedidos da loja; a regra e a validade ficam na plataforma. O mesmo código na mesma loja volta 409.',
  })
  @ApiOkResponse({ standardSchema: CouponResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  @ApiConflictResponse({ standardSchema: ProblemDetails })
  @ApiUnprocessableEntityResponse({ standardSchema: ProblemDetails })
  createExternal(@Auth() auth: AuthContext, @Body({ schema: CreateExternalCouponRequest }) body: CreateExternalCouponRequest): Promise<CouponResponse> {
    return this.coupons.createExternal(auth, body);
  }

  @Post('coupons/:id/link')
  @Auditar('cupom.ligar', { recurso: 'campaign_coupon' })
  @Permissao('atribuicao.gerenciar')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Ligar um cupom a uma campanha',
    description:
      'Liga o cupom a uma campanha da Meta ou do Google Ads, de hoje (ou do dia escolhido) até o fim marcado ou até desligar, em dias do fuso da loja. Só o cupom exclusivo prova a origem: os pedidos com o código desde o início do vínculo são atribuídos de novo na hora. Um cupom fica ligado a uma campanha por vez (409 se já estiver).',
  })
  @ApiOkResponse({ standardSchema: CouponResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  @ApiConflictResponse({ standardSchema: ProblemDetails })
  @ApiUnprocessableEntityResponse({ standardSchema: ProblemDetails })
  link(@Auth() auth: AuthContext, @Param('id', { schema: ResourceId }) id: string, @Body({ schema: LinkCouponRequest }) body: LinkCouponRequest): Promise<CouponResponse> {
    return this.coupons.link(auth, id, body);
  }

  @Post('coupons/:id/unlink')
  @Auditar('cupom.desligar', { recurso: 'campaign_coupon' })
  @Permissao('atribuicao.gerenciar')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Desligar um cupom da campanha',
    description:
      'Encerra o vínculo agora: os pedidos até aqui continuam valendo para a campanha; os próximos, não (atribuídos de novo na hora). O vínculo agendado que ainda não começou é apagado. Sem vínculo, volta como está. O cupom continua valendo no Regem ou na plataforma.',
  })
  @ApiOkResponse({ standardSchema: CouponResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  unlink(@Param('id', { schema: ResourceId }) id: string): Promise<CouponResponse> {
    return this.coupons.unlink(id);
  }

  @Put('units/:id/order-platform')
  @Auditar('loja.plataforma_pedidos', { recurso: 'unit' })
  @Permissao('atribuicao.gerenciar')
  @ApiOperation({
    summary: 'Onde a loja recebe os pedidos online',
    description:
      'Cardápio do Regem, Anota AI, CardápioWeb, Brendi ou outra plataforma (com o endereço do cardápio, só https). O Liame usa isso para dizer como medir as vendas de cada campanha: pelo link com rastreio no cardápio do Regem, pelo cupom exclusivo nas plataformas que chegam ao Regem. Nada muda na plataforma.',
  })
  @ApiOkResponse({ standardSchema: OrderPlatformResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  @ApiUnprocessableEntityResponse({ standardSchema: ProblemDetails })
  setOrderPlatform(
    @Auth() auth: AuthContext,
    @Param('id', { schema: ResourceId }) id: string,
    @Body({ schema: SetOrderPlatformRequest }) body: SetOrderPlatformRequest,
  ): Promise<OrderPlatformResponse> {
    return this.coupons.setOrderPlatform(auth, id, body);
  }
}
