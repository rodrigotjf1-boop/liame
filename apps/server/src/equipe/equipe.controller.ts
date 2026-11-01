import {
  PauseTeamMemberRequest,
  ProblemDetails,
  ResumeTeamMemberRequest,
  SetTeamModelRequest,
  TeamActivityQuery,
  TeamActivityResponse,
  TeamMemberKey,
  TeamModelPurpose,
  TeamModelsResponse,
  TeamQuery,
  TeamResponse,
  TeamShadowQuery,
  TeamShadowResponse,
} from '@liame/contracts';
import { Body, Controller, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
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
import { Auth, DuranteSuspensao, Permissao } from '../auth/access.js';
import type { AuthContext } from '../context/request-context.js';
import { EquipeService } from './equipe.service.js';
import { ModelosDaEquipeService } from './modelos.service.js';

// Sua equipe (A3, I13b; protótipo P7, aprovado em 03/10/2026). Os números do Gestor de tráfego vêm do
// caixa: ver pede `campanhas.ver` e `vendas.ver`. Desligar e ligar um funcionário pede `agentes.gerenciar`. Parar a
// equipe inteira é a parada da empresa (`/v1/kill-switches`, nível `tenant`).

@ApiTags('equipe')
@ApiCookieAuth('liame_sessao')
@Controller('team')
export class EquipeController {
  constructor(
    private readonly equipe: EquipeService,
    private readonly modelos: ModelosDaEquipeService,
  ) {}

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

  @Get('members/:key/activity')
  @Permissao('campanhas.ver', 'vendas.ver')
  @ApiOperation({
    summary: 'O que o funcionário fez',
    description:
      'Os acontecimentos do funcionário nesta marca nos últimos 90 dias, do mais novo para o mais antigo, lidos do que já está guardado: respostas e explicações da IA, demandas, planos e decisões, revisões da semana, páginas lidas, recomendações em sombra e propostas de autonomia, textos que a conferência não deixou aparecer (sem o texto) e as vezes em que a empresa desligou ou ligou. O nome do que foi tratado só vem para quem pode vê-lo na tela de origem; quem perguntou à IA só aparece para a própria pessoa.',
  })
  @ApiOkResponse({ standardSchema: TeamActivityResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  activity(
    @Auth() auth: AuthContext,
    @Param('key', { schema: TeamMemberKey }) key: string,
    @Query({ schema: TeamActivityQuery }) query: TeamActivityQuery,
  ): Promise<TeamActivityResponse> {
    return this.equipe.atividade(auth, key, query);
  }

  @Get('shadow')
  @Permissao('campanhas.ver', 'vendas.ver')
  @ApiOperation({
    summary: 'A sombra do Gestor de tráfego',
    description:
      'O que ele teria feito em cada campanha (nada é executado), o que a pessoa fez na plataforma depois e, passada a janela, o resultado da comparação com os números do caixa. Da recomendação mais nova para a mais antiga, com a vez mais recente da rotina nesta marca.',
  })
  @ApiOkResponse({ standardSchema: TeamShadowResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  shadow(@Auth() auth: AuthContext, @Query({ schema: TeamShadowQuery }) query: TeamShadowQuery): Promise<TeamShadowResponse> {
    return this.equipe.sombra(auth, query);
  }

  @Post('members/:key/pause')
  @HttpCode(200)
  @Permissao('agentes.gerenciar', 'campanhas.ver', 'vendas.ver')
  // O freio nunca trava: vale para o Dono com a marca suspensa (D-A7-40), como a parada.
  @DuranteSuspensao()
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
  // Com a marca suspensa, ligar de novo não faz ninguém trabalhar: a parada da cobrança segura a marca (D-A7-38, D-A7-40).
  @DuranteSuspensao()
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

  @Get('models')
  @Permissao('campanhas.ver', 'vendas.ver')
  @ApiOperation({
    summary: 'Os modelos de IA da empresa (Pro)',
    description:
      'Para cada finalidade (conversa, análise e textos): as tarefas e os funcionários que a usam, o automático (o modelo das rotas), os modelos do catálogo do Liame que a empresa pode escolher (os de TODAS as tarefas da finalidade, com a velocidade, a nota na rodada de confirmação e o custo estimado pelo uso dos últimos 30 dias completos, em micros de dólar) e a escolha da empresa. Vale para a empresa inteira. `enabled` falso: a função `escolha_de_modelo` está desligada, e tudo fica no automático.',
  })
  @ApiOkResponse({ standardSchema: TeamModelsResponse })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  models(@Auth() auth: AuthContext): Promise<TeamModelsResponse> {
    return this.modelos.ver(auth);
  }

  @Put('models/:purpose')
  @HttpCode(200)
  @Permissao('politicas.gerenciar', 'campanhas.ver', 'vendas.ver')
  @Auditar('equipe.escolher_modelo', { recurso: 'ai_model_choice' })
  @ApiOperation({
    summary: 'Trocar o modelo de uma finalidade',
    description:
      'Um modelo do catálogo da finalidade, ou `null` para voltar ao automático; vale a partir da próxima resposta, para a empresa inteira. Só o Dono e o Administrador. Função desligada: 409 `funcao-desligada`; modelo fora do catálogo da finalidade: 422 `fora-do-catalogo`.',
  })
  @ApiOkResponse({ standardSchema: TeamModelsResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  @ApiConflictResponse({ standardSchema: ProblemDetails })
  @ApiUnprocessableEntityResponse({ standardSchema: ProblemDetails })
  setModel(
    @Auth() auth: AuthContext,
    @Param('purpose', { schema: TeamModelPurpose }) purpose: TeamModelPurpose,
    @Body({ schema: SetTeamModelRequest }) body: SetTeamModelRequest,
  ): Promise<TeamModelsResponse> {
    return this.modelos.escolher(auth, purpose, body);
  }
}
