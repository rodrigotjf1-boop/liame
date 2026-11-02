import { AGENCY_LOGO_LIMITS, AgencyBrandResponse, ProblemDetails, UpdateAgencyBrandRequest } from '@liame/contracts';
import { Body, Controller, Delete, Get, HttpCode, Patch, Put, Req } from '@nestjs/common';
import {
  ApiBadGatewayResponse,
  ApiBadRequestResponse,
  ApiBody,
  ApiConsumes,
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiNoContentResponse,
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
import { ACAO_LOGO, AgencyBrandService } from './marca.service.js';

// A marca da agência (A7, W7, parte 3; D-A7-69; D-A7-81): o nome, o logo, o e-mail de resposta e como o relatório do mês
// sai. Quem é da agência lê; a dona e o administrador (quem cuida dos clientes) mudam.

const GRAVA_O_LOGO =
  'grava o logo no armazenamento de imagens (S3) depois de conferir e regravar o arquivo: o banco em transações curtas, antes e depois, e o envio do arquivo sem transação aberta';

@ApiTags('agency')
@ApiCookieAuth('liame_sessao')
@Controller('agency/brand')
export class AgencyBrandController {
  constructor(private readonly marca: AgencyBrandService) {}

  @Get()
  @Permissao('agencia.ver')
  @ApiOperation({
    summary: 'A marca da agência',
    description:
      'O nome, o logo (com um endereço de leitura que vale 5 minutos), o e-mail de resposta confirmado, o e-mail novo esperando o link de confirmação e como o relatório do mês sai.',
  })
  @ApiOkResponse({ standardSchema: AgencyBrandResponse })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  ler(@Auth() auth: AuthContext): Promise<AgencyBrandResponse> {
    return this.marca.ler(auth);
  }

  @Patch()
  @Permissao('agencia.clientes')
  @Auditar('agencia.marca_mudar', { recurso: 'agency_brand' })
  @ApiOperation({
    summary: 'Mudar a marca da agência',
    description:
      'O nome da agência, o e-mail de resposta e como o relatório do mês sai; o que não vem fica como está. Um e-mail de resposta novo fica pendente e recebe um link de confirmação (vale 24 horas, até 10 por dia por agência: 429 `limite-excedido`); só depois dele passa a valer. `null` tira o e-mail de resposta.',
  })
  @ApiOkResponse({ standardSchema: AgencyBrandResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiTooManyRequestsResponse({ standardSchema: ProblemDetails })
  mudar(@Auth() auth: AuthContext, @Body({ schema: UpdateAgencyBrandRequest }) body: UpdateAgencyBrandRequest): Promise<AgencyBrandResponse> {
    return this.marca.mudar(auth, body);
  }

  @Put('logo')
  @Permissao('agencia.clientes')
  @SemTransacao(GRAVA_O_LOGO)
  @Auditar(ACAO_LOGO, { manual: true, recurso: 'agency_brand' })
  @ApiConsumes('image/png', 'image/jpeg')
  @ApiBody({ description: `O arquivo do logo, cru (até ${AGENCY_LOGO_LIMITS.maxBytes / 1024 / 1024} MB).`, schema: { type: 'string', format: 'binary' } })
  @ApiOperation({
    summary: 'Trocar o logo da agência',
    description:
      'O arquivo cru no corpo. O tipo é lido do conteúdo: só PNG ou JPG (422 `logo-formato`; SVG não, porque pode levar código). Até 1 MB (413 `grande-demais`); o lado menor com 32 px ou mais (422 `logo-pequeno`) e o maior até 4.000 px (422 `logo-grande-demais`); o arquivo que não abre, 422 `logo-nao-abre`. O Liame guarda uma cópia regravada em JPEG, sobre fundo branco, cabendo em 384 × 96 px. Até 30 por dia por agência. O armazenamento que falha responde 502 `logo-nao-guardado`, e o que não está configurado, 503 `logo-indisponivel`.',
  })
  @ApiOkResponse({ standardSchema: AgencyBrandResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiPayloadTooLargeResponse({ standardSchema: ProblemDetails })
  @ApiUnprocessableEntityResponse({ standardSchema: ProblemDetails })
  @ApiTooManyRequestsResponse({ standardSchema: ProblemDetails })
  @ApiBadGatewayResponse({ standardSchema: ProblemDetails })
  @ApiServiceUnavailableResponse({ standardSchema: ProblemDetails })
  enviarLogo(@Auth() auth: AuthContext, @Req() req: { body?: unknown }): Promise<AgencyBrandResponse> {
    return this.marca.enviarLogo(auth, req.body);
  }

  @Delete('logo')
  @HttpCode(204)
  @Permissao('agencia.clientes')
  @Auditar('agencia.marca_tirar_logo', { recurso: 'agency_brand' })
  @ApiOperation({ summary: 'Tirar o logo da agência', description: 'O relatório volta a mostrar só o nome da agência. Sem logo, nada muda.' })
  @ApiNoContentResponse({ description: 'Logo tirado' })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  async apagarLogo(@Auth() auth: AuthContext): Promise<void> {
    await this.marca.apagarLogo(auth);
  }
}
