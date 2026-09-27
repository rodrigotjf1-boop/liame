import { MediaAttentionQuery, MediaAttentionResponse, MediaFreshnessQuery, MediaFreshnessResponse, MediaMetricsQuery, MediaMetricsResponse, ProblemDetails } from '@liame/contracts';
import { Controller, Get, Query } from '@nestjs/common';
import { ApiBadRequestResponse, ApiCookieAuth, ApiForbiddenResponse, ApiOkResponse, ApiOperation, ApiTags, ApiUnprocessableEntityResponse } from '@nestjs/swagger';
import { Permissao } from '../auth/access.js';
import { MediaService } from './media.service.js';

// Dados de mídia lidos das plataformas (A2, G7): frescor das contas e o último valor de cada métrica.
@ApiTags('media')
@ApiCookieAuth('liame_sessao')
@Controller('media')
export class MediaController {
  constructor(private readonly media: MediaService) {}

  @Get('freshness')
  @Permissao('contas.ver')
  @ApiOperation({
    summary: 'Frescor das contas',
    description: 'Para cada conta ligada: situação, última leitura com sucesso, última tentativa, motivo da última falha e próxima leitura, por conjunto de dados.',
  })
  @ApiOkResponse({ standardSchema: MediaFreshnessResponse })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  freshness(@Query({ schema: MediaFreshnessQuery }) query: MediaFreshnessQuery): Promise<MediaFreshnessResponse> {
    return this.media.frescor(query.brand_id);
  }

  @Get('attention')
  @Permissao('campanhas.ver')
  @ApiOperation({
    summary: 'Atenção de mídia',
    description:
      'O que precisa de alguém agora, mais grave primeiro: conta desconectada ou sem permissão, dado atrasado, autorização perto de vencer, gasto fora do normal, campanha que parou de entregar e versão de API que a plataforma vai desligar. Calculado na hora, com o motivo e o que fazer.',
  })
  @ApiOkResponse({ standardSchema: MediaAttentionResponse })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  attention(@Query({ schema: MediaAttentionQuery }) query: MediaAttentionQuery): Promise<MediaAttentionResponse> {
    return this.media.atencao(query.brand_id);
  }

  @Get('metrics')
  @Permissao('campanhas.ver')
  @ApiOperation({
    summary: 'Métricas do período',
    description:
      'Último valor de cada métrica por dia (no fuso da conta), nível e janela de atribuição, cada ponto com o frescor da fonte. Período de até 92 dias; `has_more` indica mais páginas (`offset`).',
  })
  @ApiOkResponse({ standardSchema: MediaMetricsResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiUnprocessableEntityResponse({ standardSchema: ProblemDetails })
  metrics(@Query({ schema: MediaMetricsQuery }) query: MediaMetricsQuery): Promise<MediaMetricsResponse> {
    return this.media.metricas(query);
  }
}
