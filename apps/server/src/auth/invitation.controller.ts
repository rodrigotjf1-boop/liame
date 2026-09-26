import { InvitationPreviewResponse, InvitationSignupRequest, MeResponse, ProblemDetails, TokenRequest } from '@liame/contracts';
import { Body, Controller, HttpCode, Post, Req, Res } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import type { AuthContext } from '../context/request-context.js';
import { Auth, Autenticado, Publico } from './access.js';
import type { RequestMeta } from './auth.service.js';
import { InvitationAcceptService } from './invitation-accept.service.js';
import { SessionService } from './session.service.js';

interface HttpRequest {
  ip?: string;
  headers: Record<string, string | string[] | undefined>;
}
interface HttpResponse {
  setHeader(name: string, value: string): void;
}

function meta(req: HttpRequest): RequestMeta {
  const ua = req.headers['user-agent'];
  return { ip: req.ip ?? null, userAgent: typeof ua === 'string' ? ua : null };
}

// Aceite do convite (ADR-017). O link vai no corpo, nunca na URL da API (não fica em log de acesso).
@ApiTags('people')
@Controller('invitations')
export class InvitationController {
  constructor(
    private readonly invitations: InvitationAcceptService,
    private readonly sessions: SessionService,
  ) {}

  @Post('preview')
  @Publico()
  @HttpCode(200)
  @ApiOperation({ summary: 'Ver convite', description: 'Empresa, nível e e-mail do convite, e se o e-mail já tem conta.' })
  @ApiOkResponse({ standardSchema: InvitationPreviewResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiTooManyRequestsResponse({ standardSchema: ProblemDetails })
  preview(@Body({ schema: TokenRequest }) body: TokenRequest, @Req() req: HttpRequest): Promise<InvitationPreviewResponse> {
    return this.invitations.preview(body.token, meta(req));
  }

  @Post('signup')
  @Publico()
  @HttpCode(200)
  @ApiOperation({
    summary: 'Criar login pelo convite',
    description: 'Para quem ainda não tem conta: cria o login com o e-mail convidado (já confirmado pelo link), aceita o convite e abre a sessão.',
  })
  @ApiOkResponse({ standardSchema: MeResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiConflictResponse({ standardSchema: ProblemDetails })
  @ApiTooManyRequestsResponse({ standardSchema: ProblemDetails })
  async signup(
    @Body({ schema: InvitationSignupRequest }) body: InvitationSignupRequest,
    @Req() req: HttpRequest,
    @Res({ passthrough: true }) res: HttpResponse,
  ): Promise<MeResponse> {
    const { token, me } = await this.invitations.signup(body, meta(req));
    res.setHeader('set-cookie', this.sessions.cookie(token));
    return me;
  }

  @Post('accept')
  @Autenticado()
  @ApiCookieAuth('liame_sessao')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Aceitar convite',
    description: 'Para quem já tem conta: aceita logado com o e-mail convidado; a empresa do convite vira a ativa.',
  })
  @ApiOkResponse({ standardSchema: MeResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiConflictResponse({ standardSchema: ProblemDetails })
  accept(@Auth() auth: AuthContext, @Body({ schema: TokenRequest }) body: TokenRequest): Promise<MeResponse> {
    return this.invitations.accept(auth, body.token);
  }
}
