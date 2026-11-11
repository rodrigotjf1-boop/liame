import {
  CommentAutoReplyPreviewResponse,
  CommentAutoReplyQuery,
  CommentAutoReplyRequest,
  CommentAutoReplyResponse,
  CommentsQuery,
  CommentsRefreshRequest,
  CommentsRefreshResponse,
  CommentsResponse,
  CommentsWaitingResponse,
  ProblemDetails,
} from '@liame/contracts';
import { Body, Controller, Get, HttpCode, Post, Put, Query } from '@nestjs/common';
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
import { Auditar } from '../audit/auditar.js';
import { Auth, Permissao } from '../auth/access.js';
import type { AuthContext } from '../context/request-context.js';
import { ComentariosService } from './comentarios.service.js';

// Comentários (A6, Z11, parte 1; protótipo P38): o que a tela Comentários lê e o "Ler agora". As duas rotas só leem o que
// o Liame guardou ou adiantam a leitura: responder e ocultar são pedidos de ação (Z11, parte 2), com aprovação.

@ApiTags('comentarios')
@ApiCookieAuth('liame_sessao')
@Controller('comments')
export class ComentariosController {
  constructor(private readonly comentarios: ComentariosService) {}

  @Get()
  @Permissao('campanhas.ver')
  @ApiOperation({
    summary: 'Os comentários dos posts da marca',
    description:
      'O que o Liame guardou dos comentários dos posts publicados nos últimos 30 dias no Instagram e na Página do Facebook ligados à marca, lidos a cada 15 minutos (os posts de 8 a 30 dias, de hora em hora). `state`: `desligada` (a função não está ligada para a empresa), `sem_conta` (nem Instagram nem Página ligados à marca) ou `pronta`. Com `pronta`: cada conta com a situação da leitura, as contagens por situação (no canal escolhido, sem a busca) e até 200 comentários de primeiro nível de outras pessoas, os que pedem resposta primeiro, cada um com o tipo, a situação e as respostas, mais os posts deles. O Liame guarda o texto, o @ ou o nome de quem comentou, a hora, as curtidas e se está oculto, **por 90 dias e sem a foto do perfil**. Só leitura.',
  })
  @ApiOkResponse({ standardSchema: CommentsResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  ver(@Auth() auth: AuthContext, @Query({ schema: CommentsQuery }) query: CommentsQuery): Promise<CommentsResponse> {
    return this.comentarios.ver(auth, query);
  }

  @Get('waiting')
  @Permissao('campanhas.ver')
  @ApiOperation({
    summary: 'Quantos comentários pedem resposta',
    description:
      'O contador do menu (A6, Z11, parte 3c; P38): quantos comentários pedem resposta, somadas as marcas da empresa com a função `comentarios` ligada. A mesma regra de "Pedem resposta" em `GET /v1/comments` (de primeiro nível, de outras pessoas, à vista, sem resposta da marca, pergunta ou reclamação). Sem a função ou sem conta, 0. Só leitura, sem os textos.',
  })
  @ApiOkResponse({ standardSchema: CommentsWaitingResponse })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  esperando(@Auth() auth: AuthContext): Promise<CommentsWaitingResponse> {
    return this.comentarios.esperando(auth);
  }

  @Get('auto-reply')
  @Permissao('campanhas.ver')
  @ApiOperation({
    summary: 'O atendimento automático da marca',
    description:
      'Como está o atendimento automático dos comentários da marca (A6, Z11, parte 2e-1; P38 versão 2; D-A6-92): `available` (a função `comentarios_automatico` liberada para a empresa), ligado ou não, os tipos que ele responde sozinho (`elogio` e `marcacao` hoje), quem pode ligar (`can_enable`: o Dono ou um Administrador) e desligar (`can_disable`: quem aprova), a última mudança e as respostas automáticas da última hora, com o teto. Nasce desligado. Só leitura.',
  })
  @ApiOkResponse({ standardSchema: CommentAutoReplyResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  verAutomatico(@Auth() auth: AuthContext, @Query({ schema: CommentAutoReplyQuery }) query: CommentAutoReplyQuery): Promise<CommentAutoReplyResponse> {
    return this.comentarios.verAutomatico(auth, query);
  }

  @Get('auto-reply/preview')
  @Permissao('campanhas.ver')
  @ApiOperation({
    summary: 'Como o atendimento automático teria respondido',
    description:
      'A prévia antes de ligar (A6, Z11, parte 2e-4; P38 versão 2): até 3 elogios e marcações das últimas 24 horas da marca, de outras pessoas, à vista e ainda sem resposta da marca, os mais novos primeiro, cada um com a resposta pronta que sairia (com o aviso " · resposta automática"). Nada disto é publicado. Com a leitura dos comentários desligada, vazia. Só leitura.',
  })
  @ApiOkResponse({ standardSchema: CommentAutoReplyPreviewResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  previaDoAutomatico(@Auth() auth: AuthContext, @Query({ schema: CommentAutoReplyQuery }) query: CommentAutoReplyQuery): Promise<CommentAutoReplyPreviewResponse> {
    return this.comentarios.previaDoAutomatico(auth, query);
  }

  @Put('auto-reply')
  @Permissao('acoes.aprovar')
  @Auditar('comentarios.atendimento_automatico', { recurso: 'brand' })
  @ApiOperation({
    summary: 'Ligar, desligar ou mudar o atendimento automático',
    description:
      'Liga, desliga ou muda os tipos do atendimento automático da marca (D-A6-92). Com ele ligado, o Liame responde sozinho, sem pedido de aprovação, os comentários dos tipos marcados, com o aviso " · resposta automática" no fim; a reclamação, o golpe e a ofensa sempre esperam uma pessoa; uma resposta por pessoa em cada post; no máximo 30 por hora. **Ligar e somar um tipo:** o Dono ou um Administrador (403 `so-dono-ou-administrador`), com a função liberada para a empresa (409 `funcao-desligada`) e a confirmação (`code` do app ou `passkey`). **Desligar e tirar um tipo:** quem aprova, na hora e sem código; desligar segura também o que já estava na fila. Ligado pede pelo menos um tipo (422 `sem-tipo`). A mudança fica na auditoria, com o antes e o depois.',
  })
  @ApiOkResponse({ standardSchema: CommentAutoReplyResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  @ApiConflictResponse({ standardSchema: ProblemDetails })
  @ApiUnprocessableEntityResponse({ standardSchema: ProblemDetails })
  @ApiTooManyRequestsResponse({ standardSchema: ProblemDetails })
  mudarAutomatico(@Auth() auth: AuthContext, @Body({ schema: CommentAutoReplyRequest }) body: CommentAutoReplyRequest): Promise<CommentAutoReplyResponse> {
    return this.comentarios.mudarAutomatico(auth, body);
  }

  @Post('refresh')
  @HttpCode(202)
  @Permissao('campanhas.ver')
  @Auditar('comentarios.ler_agora', { recurso: 'brand' })
  @ApiOperation({
    summary: 'Ler agora',
    description:
      'Adianta a leitura dos comentários do Instagram e da Página da marca, com todos os posts dos últimos 30 dias: o worker lê em até um minuto. A leitura terminou quando o `read_at` de cada conta, em `GET /v1/comments`, passa de `requested_at`. Uma vez por janela de 5 minutos por marca (429 `leitura-recente`, com `retry-after`); a conta que já está sendo lida fica como está. Precisa da função `comentarios` ligada (409 `funcao-desligada`).',
  })
  @ApiAcceptedResponse({ standardSchema: CommentsRefreshResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  @ApiConflictResponse({ standardSchema: ProblemDetails })
  @ApiTooManyRequestsResponse({ standardSchema: ProblemDetails })
  lerAgora(@Auth() auth: AuthContext, @Body({ schema: CommentsRefreshRequest }) body: CommentsRefreshRequest): Promise<CommentsRefreshResponse> {
    return this.comentarios.lerAgora(auth, body);
  }
}
