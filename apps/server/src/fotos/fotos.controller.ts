import { BrandPhoto, BrandPhotosQuery, BrandPhotosResponse, BrandPhotoUploadQuery, ProblemDetails, ResourceId, UpdateBrandPhotoRequest } from '@liame/contracts';
import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, Req } from '@nestjs/common';
import {
  ApiBadGatewayResponse,
  ApiBadRequestResponse,
  ApiBody,
  ApiConflictResponse,
  ApiConsumes,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiPayloadTooLargeResponse,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { Auditar } from '../audit/auditar.js';
import { Auth, Permissao } from '../auth/access.js';
import type { AuthContext } from '../context/request-context.js';
import { SemTransacao } from '../context/sem-transacao.js';
import { ACAO_ENVIAR, FotosService, RECURSO } from './fotos.service.js';

// Fotos dos produtos (A6, Z4; ADR-021; protótipo P20, aprovado em 21/10/2026). A tela Fotos: a lista, enviar uma foto
// (o arquivo cru no corpo, um por pedido), mudar o produto ou o que aparece nela, e apagar. Nada vai para rede
// nenhuma por aqui: o post com a foto é outro pedido, com aprovação (Z5).

const GRAVA_NO_ARMAZEM =
  'grava a foto no armazenamento de imagens (S3) depois de conferir e regravar o arquivo: o banco em transações curtas, antes e depois, e o envio do arquivo sem transação aberta';

@ApiTags('fotos')
@ApiCookieAuth('liame_sessao')
@Controller('brand-photos')
export class FotosController {
  constructor(private readonly fotos: FotosService) {}

  @Get()
  @Permissao('fotos.ver')
  @ApiOperation({
    summary: 'As fotos dos produtos da marca',
    description:
      'As fotos que a empresa enviou, a mais nova primeiro (até 500), com o endereço da foto e o da miniatura, assinados (valem até `urls_expire_at`, 5 minutos), e os produtos de Minha marca para o campo "Produto". Com a função `fotos` desligada para a empresa, `enabled` é `false` e a lista vem vazia. Sem o armazenamento configurado, 503 `fotos-indisponiveis`.',
  })
  @ApiOkResponse({ standardSchema: BrandPhotosResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  @ApiServiceUnavailableResponse({ standardSchema: ProblemDetails })
  listar(@Auth() auth: AuthContext, @Query({ schema: BrandPhotosQuery }) query: BrandPhotosQuery): Promise<BrandPhotosResponse> {
    return this.fotos.listar(auth, query.brand_id);
  }

  @Post()
  @HttpCode(201)
  @Permissao('fotos.enviar')
  @SemTransacao(GRAVA_NO_ARMAZEM)
  @Auditar(ACAO_ENVIAR, { manual: true, recurso: RECURSO })
  @ApiConsumes('image/jpeg', 'image/png', 'image/webp')
  @ApiBody({ description: 'O arquivo da foto, cru (até 10 MB).', schema: { type: 'string', format: 'binary' } })
  @ApiOperation({
    summary: 'Enviar uma foto',
    description:
      'Uma foto por pedido, com o arquivo cru no corpo. O tipo é lido do conteúdo: só JPEG, PNG ou WebP (422 `foto-formato`; a foto em HEIC, do iPhone, 422 `foto-heic`). Até 10 MB (413 `grande-demais`); o lado menor com 600 px ou mais (422 `foto-pequena`) e o lado maior até 10.000 px (422 `foto-grande-demais`); o arquivo que não abre, 422 `foto-nao-abre`. A mesma foto não entra duas vezes na marca (409 `foto-repetida`). O Liame guarda uma cópia regravada em JPEG, com o lado maior em até 2.048 px e sem os dados do celular, e a miniatura; o nome do arquivo não é guardado. Precisa da função `fotos` ligada (409 `funcao-desligada`). O armazenamento que falha responde 502 `foto-nao-guardada`, e o que não está configurado, 503 `fotos-indisponiveis`.',
  })
  @ApiCreatedResponse({ standardSchema: BrandPhoto })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  @ApiConflictResponse({ standardSchema: ProblemDetails })
  @ApiPayloadTooLargeResponse({ standardSchema: ProblemDetails })
  @ApiUnprocessableEntityResponse({ standardSchema: ProblemDetails })
  @ApiBadGatewayResponse({ standardSchema: ProblemDetails })
  @ApiServiceUnavailableResponse({ standardSchema: ProblemDetails })
  enviar(@Auth() auth: AuthContext, @Query({ schema: BrandPhotoUploadQuery }) query: BrandPhotoUploadQuery, @Req() req: { body?: unknown }): Promise<BrandPhoto> {
    return this.fotos.enviar(auth, query.brand_id, req.body);
  }

  @Patch(':id')
  @Permissao('fotos.enviar')
  @Auditar('fotos.editar', { recurso: RECURSO })
  @ApiOperation({
    summary: 'Mudar o produto ou o que aparece na foto',
    description:
      'O produto é um dos de Minha marca, como está escrito lá (422 `produto-fora-da-marca`), ou `null` para "Sem produto"; o que aparece na foto, até 120 letras. Precisa da função `fotos` ligada (409 `funcao-desligada`).',
  })
  @ApiOkResponse({ standardSchema: BrandPhoto })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  @ApiConflictResponse({ standardSchema: ProblemDetails })
  @ApiUnprocessableEntityResponse({ standardSchema: ProblemDetails })
  @ApiServiceUnavailableResponse({ standardSchema: ProblemDetails })
  atualizar(
    @Auth() auth: AuthContext,
    @Param('id', { schema: ResourceId }) id: string,
    @Body({ schema: UpdateBrandPhotoRequest }) body: UpdateBrandPhotoRequest,
  ): Promise<BrandPhoto> {
    return this.fotos.atualizar(auth, id, body);
  }

  @Delete(':id')
  @HttpCode(204)
  @Permissao('fotos.enviar')
  @Auditar('fotos.apagar', { recurso: RECURSO })
  @ApiOperation({
    summary: 'Apagar a foto',
    description:
      'A foto sai da lista na hora; o arquivo sai do armazenamento logo depois, pela rotina do Liame, e só então o registro. O que já foi publicado nas redes não muda. Vale também com a função desligada.',
  })
  @ApiNoContentResponse()
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  apagar(@Auth() auth: AuthContext, @Param('id', { schema: ResourceId }) id: string): Promise<void> {
    return this.fotos.apagar(auth, id);
  }
}
