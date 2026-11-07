import { CommentsQuery, CommentsRefreshRequest, CommentsRefreshResponse, CommentsResponse, ProblemDetails } from '@liame/contracts';
import { Body, Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
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
