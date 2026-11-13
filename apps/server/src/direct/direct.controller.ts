import {
  DirectAiSuggestionRequest,
  DirectAiSuggestionResponse,
  DirectAttendanceRequest,
  DirectAttendanceResponse,
  DirectAutoReplyPreviewResponse,
  DirectAutoReplyRequest,
  DirectAutoReplyResponse,
  DirectBrandRequest,
  DirectConversationId,
  DirectReplyRequest,
  DirectReplyResponse,
  DirectConversationResponse,
  DirectConversationsQuery,
  DirectConversationsResponse,
  DirectSettingsQuery,
  DirectSettingsRequest,
  DirectSettingsResponse,
  DirectWaitingResponse,
  ProblemDetails,
} from '@liame/contracts';
import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { Auditar, SemAuditoria } from '../audit/auditar.js';
import { Auth, Permissao } from '../auth/access.js';
import type { AuthContext } from '../context/request-context.js';
import { SemTransacao } from '../context/sem-transacao.js';
import { DirectService } from './direct.service.js';
import { DirectSuggestionService } from './sugestao.service.js';

// O Direct do Instagram (A6, Z12; protótipo P39): o ajuste da marca, o que a tela Direct lê e o contador do menu. As
// rotas de leitura só leem o que a rotina `direct` do worker guardou; responder, com o atendimento aberto, é a parte 2.

@ApiTags('direct')
@ApiCookieAuth('liame_sessao')
@Controller('direct')
export class DirectController {
  constructor(
    private readonly direct: DirectService,
    private readonly sugestoes: DirectSuggestionService,
  ) {}

  @Get('settings')
  @Permissao('campanhas.ver')
  @ApiOperation({
    summary: 'O Direct da marca',
    description:
      'Como está o Direct do Instagram da marca (A6, Z12; P39, D-A6-107 e D-A6-109): `available` (a função `direct` liberada para a empresa), ligado, a confirmação de que nenhum outro programa responde aquele Direct, quem pode ligar (o Dono ou um Administrador) e desligar (quem aprova), a conta do Instagram, a conferência com o Regem (`regem`: o Direct do Liame fica desligado na conta que a Central do Regem atende) e a leitura.',
  })
  @ApiOkResponse({ standardSchema: DirectSettingsResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  verAjuste(@Auth() auth: AuthContext, @Query({ schema: DirectSettingsQuery }) query: DirectSettingsQuery): Promise<DirectSettingsResponse> {
    return this.direct.verAjuste(auth, query);
  }

  @Put('settings')
  @Permissao('acoes.aprovar')
  @Auditar('direct.ajuste', { recurso: 'brand' })
  @ApiOperation({
    summary: 'Ligar ou desligar o Direct',
    description:
      'Liga ou desliga o Direct do Instagram da marca. Ligar pede o Dono ou um Administrador, a função liberada, o Instagram conectado, `no_other_app` (nenhum outro programa responde aquele Direct) e a confirmação de quem é (o código do app ou a chave de acesso); a leitura começa em até um minuto. Desligar vale na hora, sem código, para quem aprova. Fica na auditoria, com o antes e o depois.',
  })
  @ApiOkResponse({ standardSchema: DirectSettingsResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  @ApiConflictResponse({ standardSchema: ProblemDetails })
  @ApiUnprocessableEntityResponse({ standardSchema: ProblemDetails })
  @ApiTooManyRequestsResponse({ standardSchema: ProblemDetails })
  mudarAjuste(@Auth() auth: AuthContext, @Body({ schema: DirectSettingsRequest }) body: DirectSettingsRequest): Promise<DirectSettingsResponse> {
    return this.direct.mudarAjuste(auth, body);
  }

  @Put('messenger')
  @Permissao('acoes.aprovar')
  @Auditar('direct.messenger_ajuste', { recurso: 'brand' })
  @ApiOperation({
    summary: 'Ligar ou desligar o Messenger',
    description:
      'Liga ou desliga o Messenger da Página da marca na caixa do Direct, separado do Direct do Instagram. Ligar pede o Dono ou um Administrador, a função `messenger` liberada, a Página conectada, `no_other_app` (nenhum outro programa responde aquele Messenger) e a confirmação de quem é (o código do app ou a chave de acesso); a leitura começa em até um minuto. Se a Central de atendimento do Regem atende o Messenger desta Página, o Liame não mostra as conversas. Desligar vale na hora, sem código, para quem aprova. Fica na auditoria, com o antes e o depois.',
  })
  @ApiOkResponse({ standardSchema: DirectSettingsResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  @ApiConflictResponse({ standardSchema: ProblemDetails })
  @ApiUnprocessableEntityResponse({ standardSchema: ProblemDetails })
  @ApiTooManyRequestsResponse({ standardSchema: ProblemDetails })
  mudarMessenger(@Auth() auth: AuthContext, @Body({ schema: DirectSettingsRequest }) body: DirectSettingsRequest): Promise<DirectSettingsResponse> {
    return this.direct.mudarMessenger(auth, body);
  }

  @Get('auto-reply')
  @Permissao('campanhas.ver')
  @ApiOperation({
    summary: 'O atendimento automático do Direct',
    description:
      'Como está o atendimento automático do Direct da marca (A6, Z12, parte 5a; P39 versão 2; D-A6-115): `available` (a função `direct_automatico` liberada para a empresa), ligado ou não, os tipos que ele responde sozinho (`pronta` hoje: o elogio, a resposta ao story e a menção, com a resposta pronta), quem pode ligar (`can_enable`: o Dono ou um Administrador) e desligar (`can_disable`: quem aprova), a última mudança e as respostas automáticas da última hora, com o teto. Nasce desligado. Só leitura.',
  })
  @ApiOkResponse({ standardSchema: DirectAutoReplyResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  verAutomatico(@Auth() auth: AuthContext, @Query({ schema: DirectSettingsQuery }) query: DirectSettingsQuery): Promise<DirectAutoReplyResponse> {
    return this.direct.verAutomatico(auth, query);
  }

  @Get('auto-reply/preview')
  @Permissao('campanhas.ver')
  @ApiOperation({
    summary: 'Como o atendimento automático do Direct teria respondido',
    description:
      'A prévia antes de ligar (P39 versão 2): até 3 conversas da marca, das últimas 24 horas, que esperam resposta e que ele sabe responder, as mais novas primeiro, cada uma com a resposta pronta que sairia (com o aviso de resposta automática no fim). Nada disto é enviado. Com o Direct desligado ou o Regem atendendo a conta, vazia. Só leitura.',
  })
  @ApiOkResponse({ standardSchema: DirectAutoReplyPreviewResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  previaDoAutomatico(@Auth() auth: AuthContext, @Query({ schema: DirectSettingsQuery }) query: DirectSettingsQuery): Promise<DirectAutoReplyPreviewResponse> {
    return this.direct.previaDoAutomatico(auth, query);
  }

  @Put('auto-reply')
  @Permissao('acoes.aprovar')
  @Auditar('direct.atendimento_automatico', { recurso: 'brand' })
  @ApiOperation({
    summary: 'Ligar, desligar ou mudar o atendimento automático do Direct',
    description:
      'Liga, desliga ou muda os tipos do atendimento automático do Direct da marca (D-A6-115). Com ele ligado, o Liame responde sozinho, sem uma pessoa ver antes, as conversas dos tipos marcados, com o aviso de resposta automática e o caminho para uma pessoa no fim; a reclamação, o golpe, a pergunta (até a parte 4b), quem pede uma pessoa e a terceira automática seguida na mesma conversa sempre esperam a equipe; no máximo 30 por hora, e nunca fora da janela de 24 horas. **Ligar e somar um tipo:** o Dono ou um Administrador (403 `so-dono-ou-administrador`), com a função liberada (409 `funcao-desligada`), o Direct ligado na marca (409 `direct-desligado`) e a confirmação (`code` do app ou `passkey`). **Desligar e tirar um tipo:** quem aprova, na hora e sem código; desligar segura também o que já estava na fila. Ligado pede pelo menos um tipo (422 `sem-tipo`). A mudança fica na auditoria, com o antes e o depois.',
  })
  @ApiOkResponse({ standardSchema: DirectAutoReplyResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  @ApiConflictResponse({ standardSchema: ProblemDetails })
  @ApiUnprocessableEntityResponse({ standardSchema: ProblemDetails })
  @ApiTooManyRequestsResponse({ standardSchema: ProblemDetails })
  mudarAutomatico(@Auth() auth: AuthContext, @Body({ schema: DirectAutoReplyRequest }) body: DirectAutoReplyRequest): Promise<DirectAutoReplyResponse> {
    return this.direct.mudarAutomatico(auth, body);
  }

  @Get('conversations')
  @Permissao('campanhas.ver')
  @ApiOperation({
    summary: 'As conversas do Direct',
    description:
      'As conversas do Direct do Instagram da marca que a rotina `direct` guardou (A6, Z12; P39, D-A6-111), na situação pedida (`espera`, `fechando`, `respondida`, `fora` ou `todas`), com a contagem de cada uma; as que esperam resposta vêm primeiro, a que fecha a janela antes na frente. Cada conversa leva o tipo pelo que a pessoa escreveu desde a última resposta da marca (a regra dos comentários; parte 4a). A busca olha o @ e o texto. Vazia com a função desligada, o Direct desligado na marca ou o Regem atendendo a conta.',
  })
  @ApiOkResponse({ standardSchema: DirectConversationsResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  conversas(@Auth() auth: AuthContext, @Query({ schema: DirectConversationsQuery }) query: DirectConversationsQuery): Promise<DirectConversationsResponse> {
    return this.direct.conversas(auth, query);
  }

  @Get('waiting')
  @Permissao('campanhas.ver')
  @ApiOperation({
    summary: 'Quantas conversas do Direct esperam resposta',
    description:
      'O contador do menu (A6, Z12; P39): quantas conversas do Direct esperam resposta, somadas as marcas ativas da empresa em que o Liame mostra o Direct (a função `direct`, o Direct ligado na marca e o Regem sem atender a conta). A mesma regra de "Esperam resposta" em `GET /v1/direct/conversations` (a última mensagem é da pessoa, dentro da janela de 24 horas, sem "concluir" depois dela). Sem a função ou sem conta, 0. Só leitura, sem os textos.',
  })
  @ApiOkResponse({ standardSchema: DirectWaitingResponse })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  esperando(@Auth() auth: AuthContext): Promise<DirectWaitingResponse> {
    return this.direct.esperando(auth);
  }

  @Get('attendance')
  @Permissao('campanhas.ver')
  @ApiOperation({
    summary: 'O atendimento da pessoa',
    description: 'O atendimento da pessoa no Direct (A6, Z12, parte 2; D-A6-109): aberto (as respostas saem sem o código), até quando, e se ela pode responder (o Dono, os Administradores e quem aprova).',
  })
  @ApiOkResponse({ standardSchema: DirectAttendanceResponse })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  verAtendimento(@Auth() auth: AuthContext): Promise<DirectAttendanceResponse> {
    return this.direct.verAtendimento(auth);
  }

  @Post('attendance')
  @HttpCode(200)
  @Permissao('acoes.aprovar')
  @Auditar('direct.atendimento_aberto', { recurso: 'app_user' })
  @ApiOperation({
    summary: 'Abrir o atendimento',
    description: 'Abre o atendimento da pessoa no Direct, com a confirmação de quem é (o código do app ou a chave de acesso): por 8 horas, as respostas dela no Direct saem sem pedir de novo. Abrir de novo recomeça as 8 horas.',
  })
  @ApiOkResponse({ standardSchema: DirectAttendanceResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiTooManyRequestsResponse({ standardSchema: ProblemDetails })
  abrirAtendimento(@Auth() auth: AuthContext, @Body({ schema: DirectAttendanceRequest }) body: DirectAttendanceRequest): Promise<DirectAttendanceResponse> {
    return this.direct.abrirAtendimento(auth, body);
  }

  @Delete('attendance')
  @HttpCode(200)
  @Permissao('acoes.aprovar')
  @Auditar('direct.atendimento_fechado', { recurso: 'app_user' })
  @ApiOperation({ summary: 'Fechar o atendimento', description: 'Fecha o atendimento antes da hora: a próxima resposta no Direct pede o código de novo.' })
  @ApiOkResponse({ standardSchema: DirectAttendanceResponse })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  fecharAtendimento(@Auth() auth: AuthContext): Promise<DirectAttendanceResponse> {
    return this.direct.fecharAtendimento(auth);
  }

  @Post('conversations/:id/reply')
  @HttpCode(202)
  @Permissao('acoes.aprovar')
  @Auditar('direct.responder', { recurso: 'direct_conversation' })
  @ApiOperation({
    summary: 'Mandar a resposta',
    description:
      'Manda a resposta da marca numa conversa do Direct (A6, Z12, parte 2; D-A6-109 e D-A6-111): com o Direct ligado na marca e o atendimento aberto, o pedido vai pelo trilho de ações (`direct_responder`, direta para a pessoa, sem Aprovações) e nasce aprovado; o executor manda em seguida, dentro da janela de 24 horas da Meta. 409 `atendimento-fechado` sem o atendimento aberto.',
  })
  @ApiAcceptedResponse({ standardSchema: DirectReplyResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  @ApiConflictResponse({ standardSchema: ProblemDetails })
  @ApiUnprocessableEntityResponse({ standardSchema: ProblemDetails })
  responder(
    @Auth() auth: AuthContext,
    @Param('id', { schema: DirectConversationId }) id: string,
    @Body({ schema: DirectReplyRequest }) body: DirectReplyRequest,
  ): Promise<DirectReplyResponse> {
    return this.direct.responder(auth, id, body);
  }

  @Post('conversations/:id/suggestion')
  @HttpCode(200)
  @Permissao('acoes.aprovar')
  @SemTransacao('espera o Social media (um modelo de IA) por segundos: a leitura e o registro do uso abrem transações curtas')
  @SemAuditoria('pedir a sugestão não muda dado da empresa nem manda nada: cada chamada à IA fica em ai_usage, e a sugestão barrada conta em Sua equipe')
  @ApiOperation({
    summary: 'Pedir a sugestão ao Social media',
    description:
      'O Social media sugere a resposta para uma conversa do Direct ou do Messenger que espera resposta (A6, Z12, parte 4b-2; P39, "Sugestão do Social media"; D-A6-110 e D-A6-145): uma sugestão para a pergunta, só com o que Minha marca diz, e três caminhos para a reclamação. Ele recebe as dez últimas mensagens da conversa, sem o nome nem o nome de usuário de quem escreveu, e Minha marca; cada sugestão é conferida antes de voltar (a compensação prometida, o nome que aparece na conversa, as regras da Liame e da marca e o número fora da conversa e de Minha marca), e a que não passa fica de fora. `answered` diz se a pergunta foi respondida só com o que Minha marca diz; quando não, `missing` diz o que faltou ("precisa de você"). `previous` é o "Pedir outra". Nada é guardado e nada é enviado: a resposta só sai quando a pessoa manda, com o atendimento aberto. Sem a IA (desligada, sem a rota do modelo, no teto, fora do ar, o Social media desligado na marca, a conversa que não é pergunta nem reclamação), `origin` é `sem_ia`, com o motivo. 409 `conversa-nao-espera`: a conversa não espera resposta.',
  })
  @ApiOkResponse({ standardSchema: DirectAiSuggestionResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  @ApiConflictResponse({ standardSchema: ProblemDetails })
  @ApiUnprocessableEntityResponse({ standardSchema: ProblemDetails })
  sugerir(
    @Auth() auth: AuthContext,
    @Param('id', { schema: DirectConversationId }) id: string,
    @Body({ schema: DirectAiSuggestionRequest }) body: DirectAiSuggestionRequest,
  ): Promise<DirectAiSuggestionResponse> {
    return this.sugestoes.sugerir(auth, id, body);
  }

  @Post('conversations/:id/conclude')
  @HttpCode(200)
  @Permissao('acoes.aprovar')
  @Auditar('direct.concluir', { recurso: 'direct_conversation' })
  @ApiOperation({ summary: 'Concluir sem responder', description: 'Tira a conversa de "Esperam resposta" sem mandar nada (P39). A mensagem nova da pessoa reabre. O Instagram não muda.' })
  @ApiOkResponse({ standardSchema: DirectConversationResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  concluir(
    @Auth() auth: AuthContext,
    @Param('id', { schema: DirectConversationId }) id: string,
    @Body({ schema: DirectBrandRequest }) body: DirectBrandRequest,
  ): Promise<DirectConversationResponse> {
    return this.direct.concluir(auth, id, body.brand_id);
  }

  @Post('conversations/:id/read')
  @HttpCode(200)
  @Permissao('campanhas.ver')
  @SemAuditoria('só tira o "não lida" da conversa na lista do Liame, quando alguém a abre; nada muda na Meta nem no que a conversa diz')
  @ApiOperation({ summary: 'Marcar como lida', description: 'Tira o "não lida" da conversa na lista do Liame, quando alguém a abre. O Instagram não muda.' })
  @ApiOkResponse({ standardSchema: DirectConversationResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  marcarLida(
    @Auth() auth: AuthContext,
    @Param('id', { schema: DirectConversationId }) id: string,
    @Body({ schema: DirectBrandRequest }) body: DirectBrandRequest,
  ): Promise<DirectConversationResponse> {
    return this.direct.marcarLida(auth, id, body.brand_id);
  }

  @Get('conversations/:id')
  @Permissao('campanhas.ver')
  @ApiOperation({
    summary: 'Uma conversa do Direct',
    description:
      'A conversa e as mensagens guardadas dela (as 100 mais novas, da mais velha para a mais nova): o texto e, do que só a Meta guarda (a foto, o vídeo, o áudio, o story), só o tipo (D-A6-112). Esperando resposta, a sugestão sem IA (parte 4a; D-A6-118): o agradecimento pronto do elogio e da menção no story, o "como proceder" da reclamação ou o aviso do golpe.',
  })
  @ApiOkResponse({ standardSchema: DirectConversationResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  conversa(
    @Auth() auth: AuthContext,
    @Param('id', { schema: DirectConversationId }) id: string,
    @Query({ schema: DirectSettingsQuery }) query: DirectSettingsQuery,
  ): Promise<DirectConversationResponse> {
    return this.direct.conversa(auth, query.brand_id, id);
  }
}
