import { ProblemDetails, SummaryQuery, SummaryResponse } from '@liame/contracts';
import { Controller, Get, Query } from '@nestjs/common';
import { ApiBadRequestResponse, ApiCookieAuth, ApiForbiddenResponse, ApiNotFoundResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Auth, Permissao } from '../auth/access.js';
import type { AuthContext } from '../context/request-context.js';
import { ResumoService } from './resumo.service.js';

// O Resumo (A3, I13c; protótipo P8, aguardando aprovação; sem tela ainda): a página inicial do Lite. É feito das vendas
// confirmadas no caixa: pede `vendas.ver`, como Resultados; os avisos de mídia entram só para quem tem `campanhas.ver`.

@ApiTags('resumo')
@ApiCookieAuth('liame_sessao')
@Controller('summary')
export class ResumoController {
  constructor(private readonly resumo: ResumoService) {}

  @Get()
  @Permissao('vendas.ver')
  @ApiOperation({
    summary: 'Resumo',
    description:
      'A página inicial do Lite, numa chamada: o dinheiro do marketing nos últimos 7 dias completos (vendas confirmadas no caixa com origem nos anúncios, gasto e o que sobrou), com a semana anterior; o veredito pela regra de Resultados e as campanhas de cada lado; os pedidos; de onde vieram; os avisos críticos e de atenção e o que espera decisão (ações, planos e propostas de autonomia). Os mesmos números de Resultados, com o frescor de cada fonte. O que a equipe fez vem de `/v1/team`.',
  })
  @ApiOkResponse({ standardSchema: SummaryResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  ver(@Auth() auth: AuthContext, @Query({ schema: SummaryQuery }) query: SummaryQuery): Promise<SummaryResponse> {
    return this.resumo.ver(auth, query.brand_id);
  }
}
