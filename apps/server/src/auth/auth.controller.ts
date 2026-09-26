import {
  AcceptedResponse,
  ForgotPasswordRequest,
  LoginRequest,
  MeResponse,
  ProblemDetails,
  ResetPasswordRequest,
  SignupRequest,
  SwitchOrganizationRequest,
  TokenRequest,
} from '@liame/contracts';
import { Body, Controller, Get, HttpCode, Post, Put, Req, Res } from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBadRequestResponse,
  ApiCookieAuth,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { AuthContext } from '../context/request-context.js';
import { Auth, Autenticado, Publico } from './access.js';
import { AuthService, type RequestMeta } from './auth.service.js';
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

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
  ) {}

  @Post('signup')
  @Publico()
  @HttpCode(202)
  @ApiOperation({
    summary: 'Criar conta',
    description: 'Cria a pessoa, a empresa (tenant) e o vínculo de dono, e manda o link de confirmação. A resposta é a mesma exista ou não a conta.',
  })
  @ApiAcceptedResponse({ standardSchema: AcceptedResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiTooManyRequestsResponse({ standardSchema: ProblemDetails })
  signup(@Body({ schema: SignupRequest }) body: SignupRequest, @Req() req: HttpRequest): Promise<AcceptedResponse> {
    return this.auth.signup(body, meta(req));
  }

  @Post('verify-email')
  @Publico()
  @HttpCode(200)
  @ApiOperation({ summary: 'Confirmar e-mail', description: 'Usa o link de uso único enviado no cadastro (vale 24 horas).' })
  @ApiOkResponse({ standardSchema: AcceptedResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  verifyEmail(@Body({ schema: TokenRequest }) body: TokenRequest): Promise<AcceptedResponse> {
    return this.auth.verifyEmail(body.token);
  }

  @Post('login')
  @Publico()
  @HttpCode(200)
  @ApiOperation({
    summary: 'Entrar',
    description: 'E-mail e senha. Abre a sessão num cookie httpOnly e devolve a pessoa, as empresas e a empresa ativa.',
  })
  @ApiOkResponse({ standardSchema: MeResponse })
  @ApiUnauthorizedResponse({ standardSchema: ProblemDetails })
  @ApiTooManyRequestsResponse({ standardSchema: ProblemDetails })
  async login(
    @Body({ schema: LoginRequest }) body: LoginRequest,
    @Req() req: HttpRequest,
    @Res({ passthrough: true }) res: HttpResponse,
  ): Promise<MeResponse> {
    const { token, me } = await this.auth.login(body, meta(req));
    res.setHeader('set-cookie', this.sessions.cookie(token));
    return me;
  }

  @Post('logout')
  @Autenticado({ antesDoSegundoFator: true })
  @ApiCookieAuth('liame_sessao')
  @HttpCode(204)
  @ApiOperation({ summary: 'Sair', description: 'Encerra a sessão atual.' })
  @ApiNoContentResponse({ description: 'Sessão encerrada' })
  async logout(@Auth() auth: AuthContext, @Res({ passthrough: true }) res: HttpResponse): Promise<void> {
    await this.auth.logout(auth);
    res.setHeader('set-cookie', this.sessions.clearCookie());
  }

  @Post('password/forgot')
  @Publico()
  @HttpCode(202)
  @ApiOperation({ summary: 'Esqueci a senha', description: 'Manda um link de uso único (1 hora). A resposta é a mesma exista ou não a conta.' })
  @ApiAcceptedResponse({ standardSchema: AcceptedResponse })
  @ApiTooManyRequestsResponse({ standardSchema: ProblemDetails })
  forgot(@Body({ schema: ForgotPasswordRequest }) body: ForgotPasswordRequest, @Req() req: HttpRequest): Promise<AcceptedResponse> {
    return this.auth.forgotPassword(body.email, meta(req));
  }

  @Post('password/reset')
  @Publico()
  @HttpCode(200)
  @ApiOperation({ summary: 'Criar senha nova', description: 'Usa o link de uso único e encerra todas as sessões abertas.' })
  @ApiOkResponse({ standardSchema: AcceptedResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  reset(@Body({ schema: ResetPasswordRequest }) body: ResetPasswordRequest): Promise<AcceptedResponse> {
    return this.auth.resetPassword(body);
  }
}

@ApiTags('me')
@ApiCookieAuth('liame_sessao')
@Controller('me')
export class MeController {
  constructor(private readonly auth: AuthService) {}

  @Get()
  @Autenticado({ antesDoSegundoFator: true })
  @ApiOperation({ summary: 'Quem sou eu', description: 'A pessoa da sessão, as empresas a que tem acesso e a empresa ativa.' })
  @ApiOkResponse({ standardSchema: MeResponse })
  @ApiUnauthorizedResponse({ standardSchema: ProblemDetails })
  me(@Auth() auth: AuthContext): Promise<MeResponse> {
    return this.auth.me(auth);
  }

  @Put('active-organization')
  @Autenticado()
  @ApiOperation({ summary: 'Trocar de empresa', description: 'Muda a empresa ativa da sessão. Só para empresas com vínculo ativo.' })
  @ApiOkResponse({ standardSchema: MeResponse })
  @ApiUnauthorizedResponse({ standardSchema: ProblemDetails })
  switchOrganization(
    @Auth() auth: AuthContext,
    @Body({ schema: SwitchOrganizationRequest }) body: SwitchOrganizationRequest,
  ): Promise<MeResponse> {
    return this.auth.switchOrganization(auth, body.organization_id);
  }
}
