import {
  CreatePasskeyRequest,
  CreatePasskeyResponse,
  PasskeyAssertion,
  PasskeyCeremony,
  PasskeyRegistrationOptionsRequest,
  PasskeysResponse,
  ProblemDetails,
  RenamePasskeyRequest,
  ResourceId,
} from '@liame/contracts';
import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Auditar, SemAuditoria } from '../../audit/auditar.js';
import { aparelhoDaRequisicao, type AuthContext } from '../../context/request-context.js';
import { Auth, Autenticado } from '../access.js';
import { ChavesService } from './chaves.service.js';

/** As rotas que só abrem a cerimônia: o desafio vale 5 minutos e não muda a conta; o que muda audita na rota seguinte. */
const SO_O_DESAFIO = 'só cria o desafio da cerimônia (5 minutos, uso único); o que muda a conta é auditado na rota seguinte';

// As chaves de acesso em Segurança da conta e na entrada (A7, W9, parte 9a; P28; D-A7-54 a D-A7-58; D-A7-87). As rotas
// do segundo fator valem antes dele (a sessão só da senha); as de Segurança da conta pedem a sessão completa.
@ApiTags('me')
@ApiCookieAuth('liame_sessao')
@Controller('me')
export class ChavesController {
  constructor(private readonly chaves: ChavesService) {}

  @Get('passkeys')
  @Autenticado()
  @ApiOperation({ summary: 'As minhas chaves de acesso', description: 'O nome, se sincroniza, quando foi criada e o último uso; o máximo por pessoa e se ela tem o app.' })
  @ApiOkResponse({ standardSchema: PasskeysResponse })
  listar(@Auth() auth: AuthContext): Promise<PasskeysResponse> {
    return this.chaves.listar(auth);
  }

  @Post('passkeys/registration-options')
  @SemAuditoria(SO_O_DESAFIO)
  @HttpCode(200)
  @Autenticado()
  @ApiOperation({
    summary: 'Começar a criar uma chave de acesso',
    description:
      'Antes, a pessoa confirma que é ela: o código do app (`code`) ou uma chave que já tem (`passkey`, com o desafio de `confirmation-options`); sem nenhum, 400 `confirme-que-e-voce`. Quem ainda não tem segundo fator cria a primeira sem confirmar. Até 10 chaves (409 `limite-de-chaves`). Devolve o desafio (5 minutos, uso único) e as opções para o navegador.',
  })
  @ApiOkResponse({ standardSchema: PasskeyCeremony })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiUnauthorizedResponse({ standardSchema: ProblemDetails })
  @ApiConflictResponse({ standardSchema: ProblemDetails })
  opcoesDeCadastro(
    @Auth() auth: AuthContext,
    @Body({ schema: PasskeyRegistrationOptionsRequest }) body: PasskeyRegistrationOptionsRequest,
  ): Promise<PasskeyCeremony> {
    return this.chaves.opcoesDeCadastro(auth, body, aparelhoDaRequisicao() ?? undefined);
  }

  @Post('passkeys/confirmation-options')
  @SemAuditoria(SO_O_DESAFIO)
  @HttpCode(200)
  @Autenticado()
  @ApiOperation({ summary: 'Confirmar com uma chave que já tenho', description: 'O desafio para confirmar com uma chave da pessoa (antes de criar outra). Sem chave, 404 `sem-chave`.' })
  @ApiOkResponse({ standardSchema: PasskeyCeremony })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  opcoesDeConfirmacao(@Auth() auth: AuthContext): Promise<PasskeyCeremony> {
    return this.chaves.opcoesDeConfirmacao(auth);
  }

  @Post('passkeys')
  @HttpCode(201)
  @Autenticado()
  @Auditar('segundo_fator.chave_criar', { escopo: 'pessoa', recurso: 'passkey' })
  @ApiOperation({
    summary: 'Criar a chave de acesso',
    description:
      'O que o aparelho criou, com o desafio de `registration-options` (400 `desafio-vencido`; o aparelho que não confirma a pessoa, 400 `chave-recusada`). O nome vem do gerenciador e dá para trocar. O mesmo gerenciador não repete (409 `mesmo-gerenciador`). A primeira chave de quem não tem o app traz os 10 códigos de recuperação, mostrados uma vez. E-mail de aviso.',
  })
  @ApiCreatedResponse({ standardSchema: CreatePasskeyResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiConflictResponse({ standardSchema: ProblemDetails })
  cadastrar(@Auth() auth: AuthContext, @Body({ schema: CreatePasskeyRequest }) body: CreatePasskeyRequest): Promise<CreatePasskeyResponse> {
    return this.chaves.cadastrar(auth, body, aparelhoDaRequisicao() ?? undefined);
  }

  @Patch('passkeys/:id')
  @Autenticado()
  @Auditar('segundo_fator.chave_renomear', { escopo: 'pessoa', recurso: 'passkey' })
  @ApiOperation({ summary: 'Trocar o nome da chave', description: 'O nome que a lista mostra, de 1 a 60 letras. Só a dona da chave (404 `nao-encontrado`).' })
  @ApiOkResponse({ standardSchema: PasskeysResponse })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  renomear(@Auth() auth: AuthContext, @Param('id', { schema: ResourceId }) id: string, @Body({ schema: RenamePasskeyRequest }) body: RenamePasskeyRequest): Promise<PasskeysResponse> {
    return this.chaves.renomear(auth, id, body.name);
  }

  @Delete('passkeys/:id')
  @Autenticado()
  @Auditar('segundo_fator.chave_tirar', { escopo: 'pessoa', recurso: 'passkey' })
  @ApiOperation({
    summary: 'Tirar a chave',
    description: 'A última não sai sem o app ativo (409 `ultima-chave`). A chave continua no gerenciador do aparelho, mas não abre mais o Liame. E-mail de aviso.',
  })
  @ApiOkResponse({ standardSchema: PasskeysResponse })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  @ApiConflictResponse({ standardSchema: ProblemDetails })
  tirar(@Auth() auth: AuthContext, @Param('id', { schema: ResourceId }) id: string): Promise<PasskeysResponse> {
    return this.chaves.tirar(auth, id);
  }

  @Post('mfa/passkey-options')
  @SemAuditoria(SO_O_DESAFIO)
  @HttpCode(200)
  @Autenticado({ antesDoSegundoFator: true })
  @ApiOperation({ summary: 'Confirmar a entrada com a chave', description: 'O desafio para o segundo fator com uma chave da pessoa. Sem chave, 404 `sem-chave`.' })
  @ApiOkResponse({ standardSchema: PasskeyCeremony })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  opcoesDoSegundoFator(@Auth() auth: AuthContext): Promise<PasskeyCeremony> {
    return this.chaves.opcoesDoSegundoFator(auth);
  }

  @Post('mfa/passkey')
  @HttpCode(204)
  @Autenticado({ antesDoSegundoFator: true })
  @Auditar('segundo_fator.verificar', { escopo: 'pessoa' })
  @ApiOperation({
    summary: 'Segundo fator com a chave',
    description: 'O que o aparelho assinou, com o desafio de `passkey-options`. A sessão fica verificada, como com o código do app; o pedido de recuperação em andamento cai sozinho.',
  })
  @ApiNoContentResponse({ description: 'Sessão verificada' })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  async verificar(@Auth() auth: AuthContext, @Body({ schema: PasskeyAssertion }) body: PasskeyAssertion): Promise<void> {
    await this.chaves.verificarSegundoFator(auth, body, aparelhoDaRequisicao() ?? undefined);
  }
}
