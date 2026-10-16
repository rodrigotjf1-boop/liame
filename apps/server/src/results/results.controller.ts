import {
  AdDeliveryQuery,
  AdDeliveryRefreshRequest,
  AdDeliveryRefreshResponse,
  AdDeliveryResponse,
  ClosedLoopAttentionQuery,
  ClosedLoopAttentionResponse,
  ClosedLoopQuery,
  ClosedLoopResponse,
  DailyResultsResponse,
  OrderOriginQuery,
  OrderOriginResponse,
  ProblemDetails,
  ResourceId,
  WeeklyReviewQuery,
  WeeklyReviewResponse,
} from '@liame/contracts';
import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiNoContentResponse,
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
import { AtencaoCicloService } from './atencao-ciclo.service.js';
import { DesempenhoService } from './desempenho.service.js';
import { ResultsService } from './results.service.js';
import { RevisaoService } from './revisao.service.js';

// Resultados do ciclo fechado (A2.5, F8): o ROAS da plataforma ao lado do confirmado no caixa.
@ApiTags('results')
@ApiCookieAuth('liame_sessao')
@Controller('results')
export class ResultsController {
  constructor(
    private readonly results: ResultsService,
    private readonly ciclo: AtencaoCicloService,
    private readonly revisao: RevisaoService,
    private readonly desempenho: DesempenhoService,
  ) {}

  @Get('delivery')
  @Permissao('vendas.ver')
  @ApiOperation({
    summary: 'Como os anúncios rodaram',
    description:
      'O que a Meta e o Google informam da entrega dos anúncios da marca no período, na contagem deles, por campanha: impressões, alcance (só a Meta, e só para hoje, 7 e 30 dias, lido como um número só: pessoas diferentes, que não se somam entre campanhas), cliques, gasto (o mesmo de `closed-loop`) e o resultado que a plataforma conta (compras ou conversas na Meta, com 7 dias do clique; conversões no Google, na janela de cada ação). Traz a última leitura de cada conta e quando dá para pedir "Ler agora" de novo. Com a função `desempenho_anuncios` desligada para a empresa, `enabled` vem falso e o resto vazio.',
  })
  @ApiOkResponse({ standardSchema: AdDeliveryResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  @ApiUnprocessableEntityResponse({ standardSchema: ProblemDetails })
  delivery(@Auth() auth: AuthContext, @Query({ schema: AdDeliveryQuery }) query: AdDeliveryQuery): Promise<AdDeliveryResponse> {
    return this.desempenho.ler(auth, query);
  }

  @Post('delivery/refresh')
  @HttpCode(202)
  @Permissao('vendas.ver')
  @Auditar('resultados.ler_agora', { recurso: 'brand' })
  @ApiOperation({
    summary: 'Ler agora',
    description:
      'Adianta a leitura das contas de anúncio da marca (a Meta e o Google): o worker lê em até meio minuto, com o dia de hoje até agora e os dias recentes de novo. A leitura terminou quando o `last_success_at` de cada conta, em `GET /v1/results/delivery`, passa de `requested_at`. Uma vez a cada janela de 15 minutos por empresa (429 `leitura-recente`, com `retry-after`); a conta que já está sendo lida fica como está. Precisa da função `desempenho_anuncios` ligada (409 `funcao-desligada`).',
  })
  @ApiAcceptedResponse({ standardSchema: AdDeliveryRefreshResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  @ApiConflictResponse({ standardSchema: ProblemDetails })
  @ApiTooManyRequestsResponse({ standardSchema: ProblemDetails })
  refresh(@Auth() auth: AuthContext, @Body({ schema: AdDeliveryRefreshRequest }) body: AdDeliveryRefreshRequest): Promise<AdDeliveryRefreshResponse> {
    return this.desempenho.lerAgora(auth, body);
  }

  @Get('attention')
  @Permissao('vendas.ver')
  @ApiOperation({
    summary: 'Atenção do ciclo fechado',
    description:
      'O que precisa de alguém agora entre a mídia e as vendas, mais grave primeiro: Regem desconectado ou com os pedidos atrasados, loja sem a plataforma de pedidos informada, anúncios ativos sem rastreio, campanhas sem cupom exclusivo, campanha medida pelo clique com gasto e sem pedido confirmado em 7 dias, cupom exclusivo sem uso com a campanha gastando, margem desconhecida acima de 20% da receita atribuída e plataforma × caixa muito distantes (informativo); e a recomendação da sombra (pausar a campanha, reduzir ou aumentar a verba) quando a ação, naquela conta, saiu de Sombra (`sugestao_*`; nada é executado). Cada sugestão leva a recomendação por trás dela (`recommendation`): o corpo do pedido que a pessoa pode fazer por ela em `POST /v1/actions` (só para quem opera campanhas, e só na plataforma e na conta em que a escrita está ligada) e o pedido mais recente que já nasceu dela. Calculado na hora, com o motivo e o que fazer, no formato dos avisos de mídia.',
  })
  @ApiOkResponse({ standardSchema: ClosedLoopAttentionResponse })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  attention(@Auth() auth: AuthContext, @Query({ schema: ClosedLoopAttentionQuery }) query: ClosedLoopAttentionQuery): Promise<ClosedLoopAttentionResponse> {
    // Quem lê decide o que a recomendação de cada sugestão mostra: como pedir (quem opera campanhas) e o pedido já feito (quem os vê).
    return this.ciclo.atencao(query.brand_id, undefined, {
      userId: auth.userId,
      podePedir: auth.permissions.has('campanhas.operar'),
      vePedidos: auth.permissions.has('campanhas.ver'),
    });
  }

  @Post('recommendations/:id/dismiss')
  @Permissao('campanhas.operar')
  @Auditar('recomendacao.dispensar', { recurso: 'shadow_decision' })
  @HttpCode(204)
  @ApiOperation({
    summary: 'Dispensar uma recomendação do Gestor de tráfego',
    description:
      'O "Agora não" da Atenção: a pessoa viu a recomendação (`recommendation.id` de uma sugestão de `GET /v1/results/attention`) e não quis a mudança. O Liame registra quem dispensou, a sugestão sai da Atenção e do Resumo e, no modo Aprovação, o Gestor de tráfego não faz o pedido dela. Nada muda na plataforma de anúncio. Dispensar de novo não grava outra vez. Com um pedido desta recomendação em andamento, responde 409: quem decide é a aprovação.',
  })
  @ApiNoContentResponse({ description: 'Recomendação dispensada.' })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  @ApiConflictResponse({ standardSchema: ProblemDetails })
  async dismissRecommendation(@Auth() auth: AuthContext, @Param('id', { schema: ResourceId }) id: string): Promise<void> {
    await this.ciclo.dispensar(auth, id);
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

  @Get('daily')
  @Permissao('vendas.ver')
  @ApiOperation({
    summary: 'Resultados dia a dia',
    description:
      'Para a marca (ou uma loja) no período: o gasto com anúncios e os pedidos confirmados com evidência, um item por dia (zero onde não houve nada), e o período de mesmo tamanho logo antes, somado, com o retorno dele. São os mesmos números de `GET /v1/results/closed-loop`, abertos por dia: o gasto pelo dia da conta de anúncio; o pedido pelo dia do faturamento no fuso da loja. Sem nenhum dado pessoal.',
  })
  @ApiOkResponse({ standardSchema: DailyResultsResponse })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  @ApiUnprocessableEntityResponse({ standardSchema: ProblemDetails })
  daily(@Query({ schema: ClosedLoopQuery }) query: ClosedLoopQuery): Promise<DailyResultsResponse> {
    return this.results.daily(query);
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

  @Get('weekly-review')
  @Permissao('vendas.ver')
  @ApiOperation({
    summary: 'Revisão da semana',
    description:
      'A revisão de uma semana fechada da loja (de segunda a domingo, no fuso dela), como foi gerada na segunda-feira de manhã: os quatro números do topo ao lado dos da semana anterior, o que cada campanha trouxe no caixa, o que melhorou, o que piorou, o que precisa de decisão e a leitura da semana (da LIA ou, sem ela, do sistema, com o motivo), no formato do Explicar. Sem `week`, a mais recente; `week` é a segunda-feira da semana pedida. Sem revisão ainda, `review` vem nulo e `next_review_on` diz quando sai a primeira. A revisão não é recalculada: a tela e o e-mail mostram os mesmos números.',
  })
  @ApiOkResponse({ standardSchema: WeeklyReviewResponse })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  @ApiUnprocessableEntityResponse({ standardSchema: ProblemDetails })
  weeklyReview(@Query({ schema: WeeklyReviewQuery }) query: WeeklyReviewQuery): Promise<WeeklyReviewResponse> {
    return this.revisao.daMarca(query);
  }
}
