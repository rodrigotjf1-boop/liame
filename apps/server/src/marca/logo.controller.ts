import { BRAND_LOGO_LIMITS, BrandLogoResponse, ProblemDetails, ResourceId } from '@liame/contracts';
import { Controller, Delete, Get, HttpCode, Param, Put, Req } from '@nestjs/common';
import {
  ApiBadGatewayResponse,
  ApiBadRequestResponse,
  ApiBody,
  ApiConsumes,
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiPayloadTooLargeResponse,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { Auditar } from '../audit/auditar.js';
import { Auth, Permissao } from '../auth/access.js';
import type { AuthContext } from '../context/request-context.js';
import { SemTransacao } from '../context/sem-transacao.js';
import { ACAO_LOGO_DA_MARCA, LogoDaMarcaService } from './logo-da-marca.service.js';

// A logo do restaurante em Minha marca (A6 · Z15, parte 1; P43 aprovado em 11/11/2026; D-A6-138): o vídeo montado pelo
// Liame a põe num selo, quando a pessoa liga a opção. Ver: quem vê Minha marca (`dossie.ver`); trocar e tirar: quem
// edita (`dossie.editar`, o dono e o administrador).

const GRAVA_A_LOGO =
  'grava a logo no armazenamento de imagens (S3) depois de conferir e regravar o arquivo: o banco em transações curtas, antes e depois, e o envio do arquivo sem transação aberta';

@ApiTags('marca')
@ApiCookieAuth('liame_sessao')
@Controller('brands/:id/logo')
export class LogoDaMarcaController {
  constructor(private readonly logos: LogoDaMarcaService) {}

  @Get()
  @Permissao('dossie.ver')
  @ApiOperation({
    summary: 'A logo do restaurante',
    description: 'A logo da marca, regravada pelo servidor (o endereço vale poucos minutos), ou nulo sem logo; e se o armazenamento de imagens está configurado. Marca de outra empresa ou arquivada, 404.',
  })
  @ApiOkResponse({ standardSchema: BrandLogoResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  ler(@Auth() auth: AuthContext, @Param('id', { schema: ResourceId }) id: string): Promise<BrandLogoResponse> {
    return this.logos.ler(auth, id);
  }

  @Put()
  @Permissao('dossie.editar')
  @SemTransacao(GRAVA_A_LOGO)
  @Auditar(ACAO_LOGO_DA_MARCA, { manual: true, recurso: 'brand' })
  @ApiConsumes('image/png', 'image/jpeg')
  @ApiBody({ description: `O arquivo da logo, cru (até ${BRAND_LOGO_LIMITS.maxBytes / 1024 / 1024} MB).`, schema: { type: 'string', format: 'binary' } })
  @ApiOperation({
    summary: 'Trocar a logo do restaurante',
    description:
      'O arquivo cru no corpo. O tipo é lido do conteúdo: só PNG ou JPG (422 `logo-formato`; SVG não, porque pode levar código). Até 1 MB (413 `grande-demais`); o lado menor com 32 px ou mais (422 `logo-pequeno`) e o maior até 4.000 px (422 `logo-grande-demais`); o arquivo que não abre, 422 `logo-nao-abre`. O Liame guarda uma cópia regravada em JPEG, sobre fundo branco, cabendo em 512 × 512 px; a anterior sai do armazenamento. Até 30 por dia por marca. O armazenamento que falha responde 502 `logo-nao-guardado`, e o que não está configurado, 503 `logo-indisponivel`.',
  })
  @ApiOkResponse({ standardSchema: BrandLogoResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  @ApiPayloadTooLargeResponse({ standardSchema: ProblemDetails })
  @ApiUnprocessableEntityResponse({ standardSchema: ProblemDetails })
  @ApiTooManyRequestsResponse({ standardSchema: ProblemDetails })
  @ApiBadGatewayResponse({ standardSchema: ProblemDetails })
  @ApiServiceUnavailableResponse({ standardSchema: ProblemDetails })
  enviar(@Auth() auth: AuthContext, @Param('id', { schema: ResourceId }) id: string, @Req() req: { body?: unknown }): Promise<BrandLogoResponse> {
    return this.logos.enviar(auth, id, req.body);
  }

  @Delete()
  @HttpCode(204)
  @Permissao('dossie.editar')
  @Auditar('marca.logo_tirar', { recurso: 'brand' })
  @ApiOperation({ summary: 'Tirar a logo do restaurante', description: 'A marca fica sem logo: o vídeo montado deixa de oferecer a opção. Sem logo, nada muda.' })
  @ApiNoContentResponse({ description: 'Logo tirada' })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  async apagar(@Auth() auth: AuthContext, @Param('id', { schema: ResourceId }) id: string): Promise<void> {
    await this.logos.apagar(auth, id);
  }
}
