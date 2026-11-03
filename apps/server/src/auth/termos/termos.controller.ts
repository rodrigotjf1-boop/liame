import { AcceptTermsRequest, MyTermsResponse, ProblemDetails } from '@liame/contracts';
import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { ApiConflictResponse, ApiCookieAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Auditar } from '../../audit/auditar.js';
import { type AuthContext } from '../../context/request-context.js';
import { Auth, Autenticado } from '../access.js';
import { TermosService } from './termos.service.js';

// Os Termos novos para a própria pessoa (A7, W14, parte 14a; P35; D-A7-92, D-A7-95).
@ApiTags('me')
@ApiCookieAuth('liame_sessao')
@Controller('me')
export class TermosController {
  constructor(private readonly termos: TermosService) {}

  @Get('terms')
  @Autenticado()
  @ApiOperation({
    summary: 'Os Termos para mim',
    description:
      'A versão que vale, o último aceite da pessoa, a versão relevante que vem (com o aceite, se já houve), a que vale e ainda falta aceitar no dia, e as versões declaradas. Com a função `termos_novos` desligada, só a versão do ambiente.',
  })
  @ApiOkResponse({ standardSchema: MyTermsResponse })
  estado(@Auth() auth: AuthContext): Promise<MyTermsResponse> {
    return this.termos.estado(auth);
  }

  @Post('terms/accept')
  @HttpCode(200)
  @Autenticado()
  @Auditar('termos.aceitar', { escopo: 'pessoa', recurso: 'terms_version' })
  @ApiOperation({
    summary: 'Aceitar os Termos novos',
    description:
      'Aceita a versão relevante que vem (antes do dia) ou a que vale e falta aceitar (no dia). Um clique, sem o código do app; repetir não grava de novo. Outra versão, 409 `versao-sem-aceite`; com a função desligada, 409 `funcao-desligada`.',
  })
  @ApiOkResponse({ standardSchema: MyTermsResponse })
  @ApiConflictResponse({ standardSchema: ProblemDetails })
  aceitar(@Auth() auth: AuthContext, @Body({ schema: AcceptTermsRequest }) body: AcceptTermsRequest): Promise<MyTermsResponse> {
    return this.termos.aceitar(auth, body.version);
  }
}
