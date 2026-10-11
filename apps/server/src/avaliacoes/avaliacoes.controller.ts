import { ProblemDetails, ReviewAuthorsResponse, ReviewsQuery, ReviewsResponse } from '@liame/contracts';
import { Controller, Get, Query } from '@nestjs/common';
import { ApiBadRequestResponse, ApiCookieAuth, ApiForbiddenResponse, ApiNotFoundResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Auth, Permissao } from '../auth/access.js';
import type { AuthContext } from '../context/request-context.js';
import { SemTransacao } from '../context/sem-transacao.js';
import { AvaliacoesService } from './avaliacoes.service.js';

// Avaliações do Google (A6, Z1; protótipo P17, aprovado em 09/10/2026): o que a tela Avaliações lê. As duas rotas só
// leem: responder uma avaliação é um pedido de ação (Z2), com aprovação.

@ApiTags('avaliacoes')
@ApiCookieAuth('liame_sessao')
@Controller('reviews')
export class AvaliacoesController {
  constructor(private readonly avaliacoes: AvaliacoesService) {}

  @Get()
  @Permissao('campanhas.ver')
  @ApiOperation({
    summary: 'As avaliações da marca no Google',
    description:
      'O que o Liame guardou das lojas do perfil da empresa no Google ligadas à marca. `state` diz o que a tela mostra: `desligada` (a função não está ligada para a empresa), `sem_perfil` (nenhuma loja ligada: o caminho é Contas conectadas), `sem_permissao` (a autorização do Google não inclui o perfil), `esperando_google` (o Google ainda não liberou o acesso do Liame ao perfil) ou `pronta`. Com `pronta`: as lojas com a leitura de cada uma, o resumo (a nota e o total que o Google informa, quantas avaliações seguem sem resposta e as dos últimos 30 dias) e até 200 avaliações, as sem resposta primeiro, das notas mais baixas para as mais altas. O Liame guarda as avaliações que mudaram nos últimos 12 meses, **sem o nome e sem a foto de quem avaliou**. Só leitura.',
  })
  @ApiOkResponse({ standardSchema: ReviewsResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  ver(@Auth() auth: AuthContext, @Query({ schema: ReviewsQuery }) query: ReviewsQuery): Promise<ReviewsResponse> {
    return this.avaliacoes.ver(auth, query.brand_id);
  }

  @Get('authors')
  @Permissao('campanhas.ver')
  @SemTransacao('lê do Google na hora, por até 8 segundos por loja: o banco numa transação curta e o Google depois, sem transação aberta')
  @ApiOperation({
    summary: 'Quem fez as avaliações, lido do Google agora',
    description:
      'O nome de quem fez as avaliações mais recentes de cada loja ligada (até 3 lojas, 100 avaliações de cada), lido do Google na hora em que a tela é aberta, só para ela mostrar. **O Liame não guarda o nome nem a foto de quem avaliou**; a foto nem é lida. `status`: `ok`; `parcial` (alguma loja não respondeu); `indisponivel` (o Google não respondeu, ou pediu para esperar: a tela mostra as avaliações sem o nome); `desligada` (a função não está ligada para a empresa). A avaliação anônima e a que o Google não devolveu agora ficam fora de `items`.',
  })
  @ApiOkResponse({ standardSchema: ReviewAuthorsResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  quemAvaliou(@Auth() auth: AuthContext, @Query({ schema: ReviewsQuery }) query: ReviewsQuery): Promise<ReviewAuthorsResponse> {
    return this.avaliacoes.quemAvaliou(auth, query.brand_id);
  }
}
