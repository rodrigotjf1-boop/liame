import { PauseTeamMemberRequest, ProblemDetails, ResumeTeamMemberRequest, TeamMemberKey, TeamQuery, TeamResponse } from '@liame/contracts';
import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { Auditar } from '../audit/auditar.js';
import { Auth, Permissao } from '../auth/access.js';
import type { AuthContext } from '../context/request-context.js';
import { EquipeService } from './equipe.service.js';

// Sua equipe (A3, I13b; protótipo P7, aguardando aprovação; sem tela ainda). Os números do Gestor de tráfego vêm do
// caixa: ver pede `campanhas.ver` e `vendas.ver`. Desligar e ligar um funcionário pede `agentes.gerenciar`. Parar a
// equipe inteira é a parada da empresa (`/v1/kill-switches`, nível `tenant`).

@ApiTags('equipe')
@ApiCookieAuth('liame_sessao')
@Controller('team')
export class EquipeController {
  constructor(private readonly equipe: EquipeService) {}

  @Get()
  @Permissao('campanhas.ver', 'vendas.ver')
  @ApiOperation({
    summary: 'Sua equipe',
    description:
      'Quem trabalha para a marca (LIA, Analista, Relatórios, Compliance, Estrategista, Pesquisador e Gestor de tráfego): a situação de cada um, se tem trabalho em andamento, quem o desligou, o custo de IA na marca no mês (micros de dólar) e o que fez no mês, contado pelo código. No topo, a IA da empresa no mês (gasto, teto e faixa) e a parada que vale agora.',
  })
  @ApiOkResponse({ standardSchema: TeamResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  ver(@Auth() auth: AuthContext, @Query({ schema: TeamQuery }) query: TeamQuery): Promise<TeamResponse> {
    return this.equipe.ver(auth, query.brand_id);
  }

  @Post('members/:key/pause')
  @HttpCode(200)
  @Permissao('agentes.gerenciar', 'campanhas.ver', 'vendas.ver')
  @Auditar('equipe.desligar_funcionario', { recurso: 'agent_pause' })
  @ApiOperation({
    summary: 'Desligar um funcionário',
    description:
      'Nesta marca: ele para de trabalhar e de custar; o histórico fica. O motivo é opcional e perde o dado pessoal. O Compliance não desliga (422 `nao-desliga`); já desligado: 409 `ja-desligado`.',
  })
  @ApiOkResponse({ standardSchema: TeamResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  @ApiConflictResponse({ standardSchema: ProblemDetails })
  @ApiUnprocessableEntityResponse({ standardSchema: ProblemDetails })
  pause(@Auth() auth: AuthContext, @Param('key', { schema: TeamMemberKey }) key: string, @Body({ schema: PauseTeamMemberRequest }) body: PauseTeamMemberRequest): Promise<TeamResponse> {
    return this.equipe.desligar(auth, key, body);
  }

  @Post('members/:key/resume')
  @HttpCode(200)
  @Permissao('agentes.gerenciar', 'campanhas.ver', 'vendas.ver')
  @Auditar('equipe.ligar_funcionario', { recurso: 'agent_pause' })
  @ApiOperation({ summary: 'Ligar de novo', description: 'Nesta marca. Não estava desligado: 409 `ja-ligado`.' })
  @ApiOkResponse({ standardSchema: TeamResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  @ApiConflictResponse({ standardSchema: ProblemDetails })
  @ApiUnprocessableEntityResponse({ standardSchema: ProblemDetails })
  resume(@Auth() auth: AuthContext, @Param('key', { schema: TeamMemberKey }) key: string, @Body({ schema: ResumeTeamMemberRequest }) body: ResumeTeamMemberRequest): Promise<TeamResponse> {
    return this.equipe.ligar(auth, key, body);
  }
}
