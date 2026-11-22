import {
  BrandPhoto,
  BrandPhotoEditPreview,
  CreateBrandPhotoEditRequest,
  DmsGraphCallbackRequest,
  DmsGraphCallbackResponse,
  DmsGraphCnpjRequest,
  DmsGraphSituation,
  DmsGraphStartResponse,
  ProblemDetails,
  ResourceId,
  SaveBrandPhotoEditRequest,
} from '@liame/contracts';
import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { Auditar } from '../audit/auditar.js';
import { Auth, Permissao } from '../auth/access.js';
import type { AuthContext } from '../context/request-context.js';
import { SemTransacao } from '../context/sem-transacao.js';
import { DmsGraphService } from './dms-graph.service.js';

// O DMS Graph (F4; protótipo aprovado em 22/11/2026): conectar a empresa e editar a luz, o fundo e o enquadramento de uma
// foto real. A edição devolve uma prévia; ela só vira foto com a conferência da pessoa.

const FALA_COM_O_GRAPH = 'chama o DMS Graph, que leva segundos: o banco em transações curtas, antes e depois, e a chamada sem transação aberta';

@ApiTags('dms-graph')
@ApiCookieAuth('liame_sessao')
@Controller()
export class DmsGraphController {
  constructor(private readonly servico: DmsGraphService) {}

  @Get('dms-graph')
  @Permissao('fotos.ver')
  @SemTransacao(FALA_COM_O_GRAPH)
  @ApiOperation({ summary: 'A situação do DMS Graph na empresa', description: 'Se está ligado, a ligação e a franquia de imagem do mês. Desligado para a empresa: só `enabled: false`.' })
  @ApiOkResponse({ standardSchema: DmsGraphSituation })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  situacao(@Auth() auth: AuthContext): Promise<DmsGraphSituation> {
    return this.servico.situacao(auth);
  }

  @Put('dms-graph/cnpj')
  @HttpCode(204)
  @Permissao('contas.conectar')
  @SemTransacao('grava em transação própria, com a auditoria, depois de conferir a função')
  @Auditar('dms_graph.cnpj', { manual: true, recurso: 'organization' })
  @ApiOperation({ summary: 'Informar o CNPJ da empresa', description: 'Uma vez só: a conta da empresa no DMS Graph nasce pelo CNPJ.' })
  @ApiNoContentResponse()
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiConflictResponse({ standardSchema: ProblemDetails })
  @ApiUnprocessableEntityResponse({ standardSchema: ProblemDetails })
  salvarCnpj(@Auth() auth: AuthContext, @Body({ schema: DmsGraphCnpjRequest }) body: DmsGraphCnpjRequest): Promise<void> {
    return this.servico.salvarCnpj(auth, body.cnpj);
  }

  @Post('dms-graph/authorize')
  @HttpCode(200)
  @Permissao('contas.conectar')
  @SemTransacao(FALA_COM_O_GRAPH)
  @Auditar('dms_graph.iniciar', { manual: true, recurso: 'dms_graph_link' })
  @ApiOperation({ summary: 'Conectar ao DMS Graph', description: 'Abre o pedido no Graph (RFC 9126 + PKCE) e devolve a página, para onde o navegador vai.' })
  @ApiOkResponse({ standardSchema: DmsGraphStartResponse })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiConflictResponse({ standardSchema: ProblemDetails })
  @ApiUnprocessableEntityResponse({ standardSchema: ProblemDetails })
  @ApiServiceUnavailableResponse({ standardSchema: ProblemDetails })
  iniciar(@Auth() auth: AuthContext): Promise<DmsGraphStartResponse> {
    return this.servico.iniciar(auth);
  }

  @Post('dms-graph/callback')
  @HttpCode(200)
  @Permissao('contas.conectar')
  @SemTransacao(FALA_COM_O_GRAPH)
  @Auditar('dms_graph.ligou', { manual: true, recurso: 'dms_graph_link' })
  @ApiOperation({ summary: 'A volta do DMS Graph', description: 'Troca o código pela ligação da empresa, ou registra que a pessoa não autorizou.' })
  @ApiOkResponse({ standardSchema: DmsGraphCallbackResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiServiceUnavailableResponse({ standardSchema: ProblemDetails })
  concluir(@Auth() auth: AuthContext, @Body({ schema: DmsGraphCallbackRequest }) body: DmsGraphCallbackRequest): Promise<DmsGraphCallbackResponse> {
    return this.servico.concluir(auth, body);
  }

  @Post('dms-graph/disconnect')
  @HttpCode(204)
  @Permissao('contas.conectar')
  @SemTransacao(FALA_COM_O_GRAPH)
  @Auditar('dms_graph.desligou', { manual: true, recurso: 'dms_graph_link' })
  @ApiOperation({ summary: 'Desligar o DMS Graph', description: 'Desliga aqui na hora e avisa o Graph. As fotos editadas continuam em Fotos.' })
  @ApiNoContentResponse()
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  async desligar(@Auth() auth: AuthContext): Promise<void> {
    await this.servico.desligar(auth);
  }

  @Post('brand-photos/:id/edits')
  @HttpCode(200)
  @Permissao('fotos.enviar')
  @SemTransacao(FALA_COM_O_GRAPH)
  @Auditar('fotos.editar', { manual: true, recurso: 'brand_photo' })
  @ApiOperation({ summary: 'Editar uma foto', description: 'Devolve uma prévia, com a luz, o fundo e o enquadramento pedidos. O produto não muda e a original fica. Só vira foto com a conferência da pessoa.' })
  @ApiOkResponse({ standardSchema: BrandPhotoEditPreview })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  @ApiConflictResponse({ standardSchema: ProblemDetails })
  @ApiUnprocessableEntityResponse({ standardSchema: ProblemDetails })
  @ApiServiceUnavailableResponse({ standardSchema: ProblemDetails })
  editar(
    @Auth() auth: AuthContext,
    @Param('id', { schema: ResourceId }) id: string,
    @Body({ schema: CreateBrandPhotoEditRequest }) body: CreateBrandPhotoEditRequest,
  ): Promise<BrandPhotoEditPreview> {
    return this.servico.editar(auth, id, body);
  }

  @Post('brand-photos/edits/:id/save')
  @HttpCode(200)
  @Permissao('fotos.enviar')
  @SemTransacao('grava em transação própria, com a auditoria')
  @Auditar('fotos.editar_guardar', { manual: true, recurso: 'brand_photo' })
  @ApiOperation({ summary: 'Guardar a foto editada', description: 'A pessoa conferiu que o produto continua igual: a prévia vira uma foto nova em Fotos.' })
  @ApiOkResponse({ standardSchema: BrandPhoto })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiConflictResponse({ standardSchema: ProblemDetails })
  guardar(
    @Auth() auth: AuthContext,
    @Param('id', { schema: ResourceId }) id: string,
    @Body({ schema: SaveBrandPhotoEditRequest }) _body: SaveBrandPhotoEditRequest,
  ): Promise<BrandPhoto> {
    return this.servico.guardar(auth, id);
  }

  @Delete('brand-photos/edits/:id')
  @HttpCode(204)
  @Permissao('fotos.enviar')
  @SemTransacao('grava em transação própria')
  @Auditar('fotos.editar_descartar', { manual: true, recurso: 'brand_photo' })
  @ApiOperation({ summary: 'Descartar a prévia', description: 'A prévia sai, e o arquivo vai embora pela rotina de Fotos. A edição já contou na franquia.' })
  @ApiNoContentResponse()
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  descartar(@Auth() auth: AuthContext, @Param('id', { schema: ResourceId }) id: string): Promise<void> {
    return this.servico.descartar(auth, id);
  }
}
