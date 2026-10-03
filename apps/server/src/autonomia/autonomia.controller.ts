import { AutonomyItem, AutonomyQuery, AutonomyResponse, ProblemDetails, RejectAutonomyRequest, ResourceId, UndoAutonomyRequest } from '@liame/contracts';
import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Auditar } from '../audit/auditar.js';
import { Auth, Permissao } from '../auth/access.js';
import type { AuthContext } from '../context/request-context.js';
import { AutonomiaService } from './autonomia.service.js';

// Autonomia por conta e ação (A3, I13; protótipo P7, aguardando aprovação; sem tela ainda). A prontidão é feita dos
// números do caixa e das campanhas: ver pede `campanhas.ver` e `vendas.ver`. Decidir publica a política da marca:
// pede `politicas.gerenciar`. Nada aqui executa coisa alguma em plataforma de anúncio.

@ApiTags('autonomia')
@ApiCookieAuth('liame_sessao')
@Controller('autonomy')
export class AutonomiaController {
  constructor(private readonly autonomia: AutonomiaService) {}

  @Get()
  @Permissao('campanhas.ver', 'vendas.ver')
  @ApiOperation({
    summary: 'Autonomia da marca',
    description:
      'Cada conta de anúncio e ação com sombra registrada (reduzir a verba, pausar a campanha, aumentar a verba): o modo de agora, dito pelo motor de políticas (sem regra, `SHADOW`), o último retrato dos cinco portões da prontidão e a proposta de promoção (a pendente ou a mais recente). A pendente que deixou de valer aparece como `retirada`. Os limiares vão em `thresholds`; `can_decide` diz se a pessoa pode decidir.',
  })
  @ApiOkResponse({ standardSchema: AutonomyResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  ver(@Auth() auth: AuthContext, @Query({ schema: AutonomyQuery }) query: AutonomyQuery): Promise<AutonomyResponse> {
    return this.autonomia.ver(auth, query.brand_id);
  }

  @Post('proposals/:id/approve')
  @HttpCode(200)
  @Permissao('politicas.gerenciar', 'campanhas.ver', 'vendas.ver')
  @Auditar('autonomia.promover', { recurso: 'autonomy_proposal' })
  @ApiOperation({
    summary: 'Aprovar a promoção',
    description:
      'De Sombra para Sugerir, nesta conta e ação: publica a versão seguinte da política da marca, e a recomendação passa a aparecer na Atenção. Nada é executado: quem muda na plataforma é a pessoa. Proposta já decidida: 409 `proposta-decidida`; portões que deixaram de passar: 409 `prontidao-mudou`; modo que mudou por outro caminho: 409 `modo-mudou`; regra mais específica que mantém o modo: 409 `politica-mais-especifica`.',
  })
  @ApiOkResponse({ standardSchema: AutonomyItem })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  @ApiConflictResponse({ standardSchema: ProblemDetails })
  approve(@Auth() auth: AuthContext, @Param('id', { schema: ResourceId }) id: string): Promise<AutonomyItem> {
    return this.autonomia.aprovar(auth, id);
  }

  @Post('proposals/:id/reject')
  @HttpCode(200)
  @Permissao('politicas.gerenciar', 'campanhas.ver', 'vendas.ver')
  @Auditar('autonomia.recusar', { recurso: 'autonomy_proposal' })
  @ApiOperation({
    summary: 'Recusar a promoção',
    description: 'A ação segue em Sombra; o sistema só propõe de novo com mais 30 decisões comparáveis. O motivo é opcional e perde o dado pessoal.',
  })
  @ApiOkResponse({ standardSchema: AutonomyItem })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  @ApiConflictResponse({ standardSchema: ProblemDetails })
  reject(@Auth() auth: AuthContext, @Param('id', { schema: ResourceId }) id: string, @Body({ schema: RejectAutonomyRequest }) body: RejectAutonomyRequest): Promise<AutonomyItem> {
    return this.autonomia.recusar(auth, id, body);
  }

  @Post('undo')
  @HttpCode(200)
  @Permissao('politicas.gerenciar', 'campanhas.ver', 'vendas.ver')
  @Auditar('autonomia.voltar_sombra', { recurso: 'autonomy_proposal' })
  @ApiOperation({
    summary: 'Voltar para Sombra',
    description:
      'A qualquer momento: publica a versão seguinte da política da marca com a ação em Sombra, nesta conta; a promoção aprovada vira `desfeita`, e o sistema só propõe de novo com mais 30 decisões comparáveis. Já em Sombra: 409 `ja-em-sombra`.',
  })
  @ApiOkResponse({ standardSchema: AutonomyItem })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  @ApiConflictResponse({ standardSchema: ProblemDetails })
  undo(@Auth() auth: AuthContext, @Body({ schema: UndoAutonomyRequest }) body: UndoAutonomyRequest): Promise<AutonomyItem> {
    return this.autonomia.voltarParaSombra(auth, body);
  }
}
