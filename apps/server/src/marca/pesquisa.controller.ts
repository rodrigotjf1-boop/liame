import { CreateResearchRequest, ProblemDetails, ResearchListQuery, ResearchListResponse, ResearchResponse } from '@liame/contracts';
import { Body, Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
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
import { PesquisaService } from './pesquisa.service.js';

// O Pesquisador (A3, I12; protótipo P6, aguardando aprovação; sem tela ainda): a pessoa informa uma página, o Liame lê
// na fila do worker, e o que serve vira sugestão no dossiê. A página não fica guardada.

@ApiTags('marca')
@ApiCookieAuth('liame_sessao')
@Controller('brand-dossier/research')
export class PesquisaController {
  constructor(private readonly pesquisa: PesquisaService) {}

  @Post()
  @HttpCode(202)
  @Permissao('dossie.editar')
  @Auditar('pesquisa.pedir', { recurso: 'research_request' })
  @ApiOperation({
    summary: 'Pedir a leitura de uma página',
    description:
      'O site ou o cardápio da marca, ou a página de um concorrente (só `https`, só página pública). O Liame lê na fila, respeitando o robots.txt do site; um modelo sem ferramenta nenhuma tira da página só produtos e preços, ofertas e diferenciais, e o código confere cada rótulo contra o texto da página. O que serve vira sugestão em Minha marca, que uma pessoa confere. A página não fica guardada. Precisa da IA ligada e do Pesquisador ativo (409 `pesquisador-desligado`); até 20 leituras por marca por dia (429). O mesmo endereço já na fila devolve o pedido que está lá.',
  })
  @ApiAcceptedResponse({ standardSchema: ResearchResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  @ApiConflictResponse({ standardSchema: ProblemDetails })
  @ApiUnprocessableEntityResponse({ standardSchema: ProblemDetails })
  @ApiTooManyRequestsResponse({ standardSchema: ProblemDetails })
  pedir(@Auth() auth: AuthContext, @Body({ schema: CreateResearchRequest }) body: CreateResearchRequest): Promise<ResearchResponse> {
    return this.pesquisa.pedir(auth, body);
  }

  @Get()
  @Permissao('dossie.ver')
  @ApiOperation({
    summary: 'As leituras de páginas da marca',
    description: 'Os pedidos de leitura, os mais novos primeiro (até 50): a situação, o porquê de cada recusa e as partes do dossiê que ganharam sugestão.',
  })
  @ApiOkResponse({ standardSchema: ResearchListResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  lista(@Auth() auth: AuthContext, @Query({ schema: ResearchListQuery }) query: ResearchListQuery): Promise<ResearchListResponse> {
    return this.pesquisa.lista(auth, query.brand_id);
  }
}
