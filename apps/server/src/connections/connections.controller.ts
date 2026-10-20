import {
  ConnectionListQuery,
  ConnectionListResponse,
  ConnectionResponse,
  LinkAccountsRequest,
  LinkAccountsResponse,
  OAuthCallbackQuery,
  ProblemDetails,
  ResourceId,
  StartConnectionRequest,
  StartConnectionResponse,
  UnitListQuery,
  UnitListResponse,
} from '@liame/contracts';
import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query, Redirect } from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBadGatewayResponse,
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { Auditar } from '../audit/auditar.js';
import { Auth, Permissao } from '../auth/access.js';
import type { AuthContext } from '../context/request-context.js';
import { SemTransacao } from '../context/sem-transacao.js';
import { ACAO_INICIAR, ConnectionsService } from './connections.service.js';

// Contas conectadas (A2, G3): autorizar a plataforma, escolher as contas de cada marca, desligar e revogar.
@ApiTags('connections')
@ApiCookieAuth('liame_sessao')
@Controller()
export class ConnectionsController {
  constructor(private readonly connections: ConnectionsService) {}

  @Post('connections')
  @SemTransacao(
    'o RegemCast pede o pedido empurrado (RFC 9126) ao servidor de lá antes de a pessoa ir: o banco numa transação curta, o pedido depois, sem transação aberta, e a conexão com o evento de auditoria noutra transação curta',
  )
  @Auditar(ACAO_INICIAR, { recurso: 'oauth_connection', manual: true })
  @Permissao('contas.conectar')
  @HttpCode(201)
  @ApiOperation({
    summary: 'Começar a conectar uma plataforma',
    description:
      'Devolve a página da plataforma onde a pessoa autoriza (Meta; Google, que cobre Google Ads e GA4; Regem; ou RegemCast, pela autorização por clique, quando `available` o traz). A autorização precisa voltar em 10 minutos. Nenhum token passa pelo navegador. No RegemCast, o Liame registra o pedido lá antes (pedido empurrado, RFC 9126) e a página leva só o número dele; o RegemCast fora do ar responde 502 `plataforma-indisponivel`.',
  })
  @ApiCreatedResponse({ standardSchema: StartConnectionResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  @ApiBadGatewayResponse({ standardSchema: ProblemDetails })
  @ApiServiceUnavailableResponse({ standardSchema: ProblemDetails })
  start(@Auth() auth: AuthContext, @Body({ schema: StartConnectionRequest }) body: StartConnectionRequest): Promise<StartConnectionResponse> {
    return this.connections.iniciar(auth, body);
  }

  @Get('oauth/callback')
  @Auditar('conexao.autorizar', { recurso: 'oauth_connection' })
  @Permissao('contas.conectar')
  @Redirect()
  @ApiOperation({
    summary: 'Volta da autorização',
    description:
      'Endereço registrado nos apps da Meta e do Google, no cliente do Regem e no catálogo da autorização por clique do RegemCast. Confere o estado (só a pessoa que começou, uma vez, dentro do prazo) e, no RegemCast, o `iss` (RFC 9207: a volta tem de vir do RegemCast); guarda o código cifrado e leva de volta para a tela de contas; a troca pelo token e a descoberta das contas acontecem em segundo plano.',
  })
  @ApiResponse({ status: 303, description: 'Volta para a tela de contas conectadas' })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  async callback(@Auth() auth: AuthContext, @Query({ schema: OAuthCallbackQuery }) query: OAuthCallbackQuery): Promise<{ url: string; statusCode: number }> {
    return { url: await this.connections.receber(auth, query), statusCode: 303 };
  }

  @Get('connections')
  @Permissao('contas.ver')
  @ApiOperation({ summary: 'Conexões e contas', description: 'Autorizações da empresa (ou da marca), as contas ligadas a cada uma e as descobertas para escolher.' })
  @ApiOkResponse({ standardSchema: ConnectionListResponse })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  list(@Auth() auth: AuthContext, @Query({ schema: ConnectionListQuery }) query: ConnectionListQuery): Promise<ConnectionListResponse> {
    return this.connections.listar(auth, query.brand_id);
  }

  @Get('units')
  @Permissao('contas.ver')
  @ApiOperation({ summary: 'Lojas da marca', description: 'Lojas do Liame de uma marca, por nome: a escolha de "Loja no Liame" ao ligar as lojas do Regem.' })
  @ApiOkResponse({ standardSchema: UnitListResponse })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  units(@Query({ schema: UnitListQuery }) query: UnitListQuery): Promise<UnitListResponse> {
    return this.connections.lojasDaMarca(query.brand_id);
  }

  @Get('connections/:id')
  @Permissao('contas.ver')
  @ApiOperation({ summary: 'Uma conexão', description: 'Situação da autorização, contas descobertas e contas ligadas.' })
  @ApiOkResponse({ standardSchema: ConnectionResponse })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  get(@Param('id', { schema: ResourceId }) id: string): Promise<ConnectionResponse> {
    return this.connections.detalhe(id);
  }

  @Post('connections/:id/accounts')
  @Auditar('conta.conectar', { recurso: 'oauth_connection' })
  @Permissao('contas.conectar')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Ligar contas à marca',
    description: 'Liga à marca da conexão as contas escolhidas entre as descobertas. Conta já ligada a uma marca desta empresa fica como está e volta em `already_linked`.',
  })
  @ApiOkResponse({ standardSchema: LinkAccountsResponse })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  @ApiConflictResponse({ standardSchema: ProblemDetails })
  @ApiUnprocessableEntityResponse({ standardSchema: ProblemDetails })
  link(@Auth() auth: AuthContext, @Param('id', { schema: ResourceId }) id: string, @Body({ schema: LinkAccountsRequest }) body: LinkAccountsRequest): Promise<LinkAccountsResponse> {
    return this.connections.ligarContas(auth, id, body);
  }

  @Post('connections/:id/discover')
  @Auditar('conexao.redescobrir', { recurso: 'oauth_connection' })
  @Permissao('contas.conectar')
  @HttpCode(202)
  @ApiOperation({ summary: 'Procurar as contas de novo', description: 'Com a mesma autorização, procura de novo as contas que ela alcança (em segundo plano).' })
  @ApiAcceptedResponse({ standardSchema: ConnectionResponse })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  @ApiConflictResponse({ standardSchema: ProblemDetails })
  discover(@Param('id', { schema: ResourceId }) id: string): Promise<ConnectionResponse> {
    return this.connections.redescobrir(id);
  }

  @Delete('connections/:id')
  @Auditar('conexao.revogar', { recurso: 'oauth_connection' })
  @Permissao('contas.conectar')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Revogar a autorização',
    description:
      'O token sai do cofre e as contas desta autorização param de ser lidas (o histórico fica). No Google, o token é revogado lá também; na Meta, a empresa remove o app nas Configurações do negócio.',
  })
  @ApiNoContentResponse({ description: 'Autorização revogada' })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  async revoke(@Param('id', { schema: ResourceId }) id: string): Promise<void> {
    await this.connections.revogar(id);
  }

  @Delete('connected-accounts/:id')
  @Auditar('conta.desconectar', { recurso: 'connected_account' })
  @Permissao('contas.conectar')
  @HttpCode(204)
  @ApiOperation({ summary: 'Desligar uma conta', description: 'A conta para de ser lida para esta marca; o histórico de números fica.' })
  @ApiNoContentResponse({ description: 'Conta desligada' })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  async disconnect(@Param('id', { schema: ResourceId }) id: string): Promise<void> {
    await this.connections.desligarConta(id);
  }
}
