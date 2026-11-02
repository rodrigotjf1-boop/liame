import {
  AcceptedResponse,
  ForgotPasswordRequest,
  LoginRequest,
  MeResponse,
  PasskeyAssertion,
  PasskeyCeremony,
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
  ApiConflictResponse,
  ApiCookieAuth,
  ApiForbiddenResponse,
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
import { ChavesService } from './chaves/chaves.service.js';
import { SessionService } from './session.service.js';
import { Auditar, SemAuditoria } from '../audit/auditar.js';

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
    private readonly chaves: ChavesService,
  ) {}

  @Post('signup')
  @Auditar('conta.criar', { manual: true, recurso: 'organization' })
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
  @Auditar('email.confirmar', { manual: true, escopo: 'pessoa' })
  @Publico()
  @HttpCode(200)
  @ApiOperation({ summary: 'Confirmar e-mail', description: 'Usa o link de uso único enviado no cadastro (vale 24 horas).' })
  @ApiOkResponse({ standardSchema: AcceptedResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  verifyEmail(@Body({ schema: TokenRequest }) body: TokenRequest): Promise<AcceptedResponse> {
    return this.auth.verifyEmail(body.token);
  }

  @Post('login')
  @Auditar('sessao.abrir', { manual: true, escopo: 'pessoa' })
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

  @Post('passkey-options')
  @SemAuditoria('só cria o desafio da entrada (5 minutos, uso único); a entrada é auditada na rota seguinte, na conta de quem entrou')
  @Publico()
  @HttpCode(200)
  @ApiOperation({
    summary: 'Começar a entrar com a chave de acesso',
    description:
      'O desafio da entrada sem senha (5 minutos, uso único), sem dizer quais chaves existem: a chave que o aparelho escolher diz quem é. 30 por IP a cada 15 minutos. Com a função `chaves_de_acesso` desligada para todos (a regra do ambiente: ninguém entrou ainda), 409 `funcao-desligada`, sem gastar o limite: a entrada fica só com a senha.',
  })
  @ApiOkResponse({ standardSchema: PasskeyCeremony })
  @ApiConflictResponse({ standardSchema: ProblemDetails })
  @ApiTooManyRequestsResponse({ standardSchema: ProblemDetails })
  opcoesDaChave(@Req() req: HttpRequest): Promise<PasskeyCeremony> {
    return this.chaves.opcoesDaEntrada(meta(req).ip);
  }

  @Post('passkey')
  @Auditar('sessao.abrir', { manual: true, escopo: 'pessoa' })
  @Publico()
  @HttpCode(200)
  @ApiOperation({
    summary: 'Entrar com a chave de acesso',
    description:
      'O que o aparelho assinou, com o desafio de `passkey-options`. A chave vale pela senha e pelo código do app: a sessão já nasce verificada. A chave que saiu da conta, 401 `chave-desconhecida`; a que não confere (ou a pessoa desativada), 401 `chave-recusada`; o desafio vencido ou já usado, 400 `desafio-vencido`. Como na entrada com senha: o e-mail por confirmar (403), o aviso de acesso novo por e-mail e o pedido de recuperação em andamento, que cai sozinho.',
  })
  @ApiOkResponse({ standardSchema: MeResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiUnauthorizedResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiTooManyRequestsResponse({ standardSchema: ProblemDetails })
  async entrarComChave(
    @Body({ schema: PasskeyAssertion }) body: PasskeyAssertion,
    @Req() req: HttpRequest,
    @Res({ passthrough: true }) res: HttpResponse,
  ): Promise<MeResponse> {
    const { token, me } = await this.auth.entrarComChave(body, meta(req));
    res.setHeader('set-cookie', this.sessions.cookie(token));
    return me;
  }

  @Post('logout')
  @Auditar('sessao.encerrar', { escopo: 'pessoa' })
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
  @SemAuditoria('só manda o link; a resposta não revela se a conta existe e o registro é o próprio token')
  @Publico()
  @HttpCode(202)
  @ApiOperation({ summary: 'Esqueci a senha', description: 'Manda um link de uso único (1 hora). A resposta é a mesma exista ou não a conta.' })
  @ApiAcceptedResponse({ standardSchema: AcceptedResponse })
  @ApiTooManyRequestsResponse({ standardSchema: ProblemDetails })
  forgot(@Body({ schema: ForgotPasswordRequest }) body: ForgotPasswordRequest, @Req() req: HttpRequest): Promise<AcceptedResponse> {
    return this.auth.forgotPassword(body.email, meta(req));
  }

  @Post('password/reset')
  @Auditar('senha.redefinir', { manual: true, escopo: 'pessoa' })
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
  @Auditar('empresa.trocar_ativa', { escopo: 'pessoa', recurso: 'organization' })
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
