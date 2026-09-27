import { MfaVerifyRequest, ProblemDetails, RecoveryCodesResponse, TotpCodeRequest, TotpSetupResponse } from '@liame/contracts';
import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBadRequestResponse,
  ApiCookieAuth,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { AuthContext } from '../context/request-context.js';
import { Auth, Autenticado } from './access.js';
import { MfaService } from './mfa.service.js';
import { Auditar } from '../audit/auditar.js';

@ApiTags('me')
@ApiCookieAuth('liame_sessao')
@Controller('me/mfa')
export class MfaController {
  constructor(private readonly mfa: MfaService) {}

  @Post('totp/setup')
  @Auditar('segundo_fator.iniciar', { escopo: 'pessoa' })
  @Autenticado()
  @HttpCode(200)
  @ApiOperation({
    summary: 'Configurar o app autenticador',
    description: 'Gera um segredo pendente e a URI do QR. Trocar um app já ativo exige a sessão verificada pelo app ou um pedido de troca com mais de 24 horas.',
  })
  @ApiOkResponse({ standardSchema: TotpSetupResponse })
  @ApiUnauthorizedResponse({ standardSchema: ProblemDetails })
  setup(@Auth() auth: AuthContext): Promise<TotpSetupResponse> {
    return this.mfa.setup(auth);
  }

  @Post('totp/confirm')
  @Auditar('segundo_fator.ativar', { escopo: 'pessoa' })
  @Autenticado()
  @HttpCode(200)
  @ApiOperation({
    summary: 'Confirmar o app autenticador',
    description: 'Ativa o app com um código dele e devolve os 10 códigos de recuperação, mostrados uma única vez.',
  })
  @ApiOkResponse({ standardSchema: RecoveryCodesResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiUnauthorizedResponse({ standardSchema: ProblemDetails })
  confirm(@Auth() auth: AuthContext, @Body({ schema: TotpCodeRequest }) body: TotpCodeRequest): Promise<RecoveryCodesResponse> {
    return this.mfa.confirm(auth, body.code);
  }

  @Post('verify')
  @Auditar('segundo_fator.verificar', { escopo: 'pessoa' })
  @Autenticado({ antesDoSegundoFator: true })
  @HttpCode(204)
  @ApiOperation({
    summary: 'Verificar o segundo fator',
    description: 'Confirma a sessão com o código do app (6 dígitos) ou com um código de recuperação (uso único).',
  })
  @ApiNoContentResponse({ description: 'Sessão verificada' })
  @ApiUnauthorizedResponse({ standardSchema: ProblemDetails })
  async verify(@Auth() auth: AuthContext, @Body({ schema: MfaVerifyRequest }) body: MfaVerifyRequest): Promise<void> {
    await this.mfa.verify(auth, body.code);
  }

  @Post('recovery-codes')
  @Auditar('segundo_fator.gerar_codigos', { escopo: 'pessoa' })
  @Autenticado()
  @HttpCode(200)
  @ApiOperation({
    summary: 'Gerar códigos de recuperação novos',
    description: 'Confirma com o código do app (nunca com código de recuperação); os códigos que ainda valiam deixam de valer. Os novos aparecem uma vez só.',
  })
  @ApiOkResponse({ standardSchema: RecoveryCodesResponse })
  @ApiUnauthorizedResponse({ standardSchema: ProblemDetails })
  regenerate(@Auth() auth: AuthContext, @Body({ schema: TotpCodeRequest }) body: TotpCodeRequest): Promise<RecoveryCodesResponse> {
    return this.mfa.regenerateRecoveryCodes(auth, body.code);
  }

  @Post('change-request')
  @Auditar('segundo_fator.pedir_troca', { escopo: 'pessoa' })
  @Autenticado()
  @HttpCode(202)
  @ApiOperation({
    summary: 'Pedir a troca do app (aparelho perdido)',
    description: 'Depois de entrar com um código de recuperação: o pedido vale em 24 horas, com aviso por e-mail (ADR-013).',
  })
  @ApiAcceptedResponse({ description: 'Pedido registrado' })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  async changeRequest(@Auth() auth: AuthContext): Promise<void> {
    await this.mfa.requestChange(auth);
  }
}
