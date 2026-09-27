import {
  ProblemDetails,
  ResourceId,
  RevokedSessionsResponse,
  SecurityEventsResponse,
  SecuritySummaryResponse,
  SessionListResponse,
} from '@liame/contracts';
import { Controller, Delete, Get, HttpCode, Param, Post } from '@nestjs/common';
import { ApiCookieAuth, ApiNoContentResponse, ApiNotFoundResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Auditar } from '../audit/auditar.js';
import type { AuthContext } from '../context/request-context.js';
import { Auth, Autenticado } from './access.js';
import { SecurityService } from './security.service.js';

// Segurança da conta: o que a própria pessoa vê e faz sobre o acesso dela (vale para todas as empresas).
@ApiTags('me')
@ApiCookieAuth('liame_sessao')
@Controller('me')
export class SecurityController {
  constructor(private readonly security: SecurityService) {}

  @Get('security')
  @Autenticado()
  @ApiOperation({
    summary: 'Resumo da segurança da conta',
    description: 'App autenticador (desde quando), como esta sessão foi confirmada, quantos códigos de recuperação valem e o pedido de troca do app, se houver.',
  })
  @ApiOkResponse({ standardSchema: SecuritySummaryResponse })
  summary(@Auth() auth: AuthContext): Promise<SecuritySummaryResponse> {
    return this.security.summary(auth);
  }

  @Get('security/events')
  @Autenticado()
  @ApiOperation({ summary: 'Atividade de segurança', description: 'Entradas, senha errada, troca de senha e do app, códigos usados: últimos 30 dias, só da própria pessoa.' })
  @ApiOkResponse({ standardSchema: SecurityEventsResponse })
  events(@Auth() auth: AuthContext): Promise<SecurityEventsResponse> {
    return this.security.events(auth);
  }

  @Get('sessions')
  @Autenticado()
  @ApiOperation({ summary: 'Aparelhos conectados', description: 'Onde a conta está aberta: aparelho, IP com o final escondido, quando entrou e o último acesso.' })
  @ApiOkResponse({ standardSchema: SessionListResponse })
  sessions(@Auth() auth: AuthContext): Promise<SessionListResponse> {
    return this.security.sessions(auth);
  }

  @Delete('sessions/:id')
  @Auditar('sessao.encerrar', { escopo: 'pessoa', recurso: 'session' })
  @Autenticado()
  @HttpCode(204)
  @ApiOperation({ summary: 'Encerrar um aparelho', description: 'A próxima requisição daquele aparelho já é recusada.' })
  @ApiNoContentResponse({ description: 'Aparelho desconectado' })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  async revoke(@Auth() auth: AuthContext, @Param('id', { schema: ResourceId }) id: string): Promise<void> {
    await this.security.revoke(auth, id);
  }

  @Post('sessions/revoke-others')
  @Auditar('sessao.encerrar_outras', { escopo: 'pessoa' })
  @Autenticado()
  @HttpCode(200)
  @ApiOperation({ summary: 'Sair de todos os outros aparelhos', description: 'Este aparelho continua; os outros precisam entrar de novo.' })
  @ApiOkResponse({ standardSchema: RevokedSessionsResponse })
  async revokeOthers(@Auth() auth: AuthContext): Promise<RevokedSessionsResponse> {
    return { revoked: await this.security.revokeOthers(auth) };
  }
}
