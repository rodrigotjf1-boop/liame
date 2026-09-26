import { CloseOrganizationRequest, ExportResponse, ProblemDetails } from '@liame/contracts';
import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { ApiConflictResponse, ApiCookieAuth, ApiNoContentResponse, ApiOkResponse, ApiOperation, ApiTags, ApiUnauthorizedResponse } from '@nestjs/swagger';
import { Auditar } from '../audit/auditar.js';
import { Auth, DuranteEncerramento, Permissao } from '../auth/access.js';
import type { AuthContext } from '../context/request-context.js';
import { GRACE_DAYS, LifecycleService } from './lifecycle.service.js';

// Ciclo de vida da conta (ADR-014): encerrar com 30 dias de graça, reativar, exportar.
@ApiTags('organization')
@ApiCookieAuth('liame_sessao')
@Controller()
export class LifecycleController {
  constructor(private readonly lifecycle: LifecycleService) {}

  @Post('organization/close')
  @Permissao('empresa.encerrar')
  @Auditar('empresa.encerrar', { recurso: 'organization' })
  @HttpCode(204)
  @ApiOperation({
    summary: 'Encerrar a conta',
    description: `Só o dono, com o nome da empresa e o código do app. Começa ${GRACE_DAYS} dias de graça (ver, exportar, reativar); depois os dados são expurgados e a chave da empresa é destruída.`,
  })
  @ApiNoContentResponse({ description: 'Encerramento iniciado' })
  @ApiUnauthorizedResponse({ standardSchema: ProblemDetails })
  @ApiConflictResponse({ standardSchema: ProblemDetails })
  async close(@Auth() auth: AuthContext, @Body({ schema: CloseOrganizationRequest }) body: CloseOrganizationRequest): Promise<void> {
    await this.lifecycle.close(auth, body);
  }

  @Post('organization/reactivate')
  @Permissao('empresa.encerrar')
  @DuranteEncerramento()
  @Auditar('empresa.reativar', { recurso: 'organization' })
  @HttpCode(204)
  @ApiOperation({ summary: 'Reativar a conta', description: 'Durante a graça, cancela o encerramento.' })
  @ApiNoContentResponse({ description: 'Conta reativada' })
  @ApiConflictResponse({ standardSchema: ProblemDetails })
  async reactivate(@Auth() auth: AuthContext): Promise<void> {
    await this.lifecycle.reactivate(auth);
  }

  @Get('export')
  @Permissao('empresa.exportar')
  @ApiOperation({ summary: 'Exportar os dados', description: 'Tudo o que é da empresa, em JSON, sem segredo, senha, token ou sessão. Fica na auditoria.' })
  @ApiOkResponse({ standardSchema: ExportResponse })
  export(@Auth() auth: AuthContext): Promise<ExportResponse> {
    return this.lifecycle.export(auth);
  }
}
