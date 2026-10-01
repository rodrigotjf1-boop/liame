import { ClosedLoopAttentionQuery, ClosedLoopAttentionResponse, ClosedLoopQuery, ClosedLoopResponse, OrderOriginQuery, OrderOriginResponse, ProblemDetails } from '@liame/contracts';
import { Controller, Get, Query } from '@nestjs/common';
import { ApiCookieAuth, ApiForbiddenResponse, ApiNotFoundResponse, ApiOkResponse, ApiOperation, ApiTags, ApiUnprocessableEntityResponse } from '@nestjs/swagger';
import { Permissao } from '../auth/access.js';
import { AtencaoCicloService } from './atencao-ciclo.service.js';
import { ResultsService } from './results.service.js';

// Resultados do ciclo fechado (A2.5, F8): o ROAS da plataforma ao lado do confirmado no caixa.
@ApiTags('results')
@ApiCookieAuth('liame_sessao')
@Controller('results')
export class ResultsController {
  constructor(
    private readonly results: ResultsService,
    private readonly ciclo: AtencaoCicloService,
  ) {}

  @Get('attention')
  @Permissao('vendas.ver')
  @ApiOperation({
    summary: 'Atenção do ciclo fechado',
    description:
      'O que precisa de alguém agora entre a mídia e as vendas, mais grave primeiro: Regem desconectado ou com os pedidos atrasados, loja sem a plataforma de pedidos informada, anúncios ativos sem rastreio, campanhas sem cupom exclusivo, campanha medida pelo clique com gasto e sem pedido confirmado em 7 dias, cupom exclusivo sem uso com a campanha gastando, margem desconhecida acima de 20% da receita atribuída e plataforma × caixa muito distantes (informativo). Calculado na hora, com o motivo e o que fazer, no formato dos avisos de mídia.',
  })
  @ApiOkResponse({ standardSchema: ClosedLoopAttentionResponse })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  attention(@Query({ schema: ClosedLoopAttentionQuery }) query: ClosedLoopAttentionQuery): Promise<ClosedLoopAttentionResponse> {
    return this.ciclo.atencao(query.brand_id);
  }

  @Get('closed-loop')
  @Permissao('vendas.ver')
  @ApiOperation({
    summary: 'ROAS da plataforma × ROAS confirmado no caixa',
    description:
      'Para a marca (ou uma loja) no período, com o dia no fuso da loja: gasto; o que cada plataforma informa, com a janela dela; pedidos e receita confirmados no caixa do Regem; a parte atribuída pelo modelo (último toque, 7 dias, sem visualização); margem conhecida e cobertura; pedidos sem origem; canais sem clique à parte; cancelados; e o frescor de cada fonte. Dinheiro em micros.',
  })
  @ApiOkResponse({ standardSchema: ClosedLoopResponse })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  @ApiUnprocessableEntityResponse({ standardSchema: ProblemDetails })
  closedLoop(@Query({ schema: ClosedLoopQuery }) query: ClosedLoopQuery): Promise<ClosedLoopResponse> {
    return this.results.closedLoop(query);
  }

  @Get('orders')
  @Permissao('vendas.ver')
  @ApiOperation({
    summary: 'Origem de cada pedido',
    description:
      'Os pedidos do período, do mais recente ao mais antigo, com a evidência da atribuição (tipo, momento, horas antes da confirmação, janela, confiança) ou o motivo de ficar sem origem. Sem nenhum dado pessoal.',
  })
  @ApiOkResponse({ standardSchema: OrderOriginResponse })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  @ApiUnprocessableEntityResponse({ standardSchema: ProblemDetails })
  orders(@Query({ schema: OrderOriginQuery }) query: OrderOriginQuery): Promise<OrderOriginResponse> {
    return this.results.orders(query);
  }
}
