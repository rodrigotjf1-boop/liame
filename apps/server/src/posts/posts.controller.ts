import { CreatePostRequest, PostListQuery, PostListResponse, PostPhotoResponse, PostResponse, ProblemDetails, ResourceId } from '@liame/contracts';
import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { Auditar } from '../audit/auditar.js';
import { Auth, Permissao } from '../auth/access.js';
import type { AuthContext } from '../context/request-context.js';
import { ACAO_CRIAR_POST, ACAO_PACOTE_PUBLICADO, ACAO_PACOTE_TIRADO, ACAO_TENTAR_DE_NOVO, PostsService, RECURSO_DO_POST } from './posts.service.js';

// Os posts da marca (A6, Z5b; protótipo P19, aprovado em 21/10/2026). A Agenda (os posts de um período) e o novo post,
// que vira um pedido em Aprovações: nada sai sem a aprovação de uma pessoa, com o código do app, na hora marcada. A
// publicação nas redes entra na parte seguinte da Z5; a função `social_write` nasce desligada.

@ApiTags('posts')
@ApiCookieAuth('liame_sessao')
@Controller('posts')
export class PostsController {
  constructor(private readonly posts: PostsService) {}

  @Get()
  @Permissao('campanhas.ver')
  @ApiOperation({
    summary: 'Os posts da marca num período (a Agenda)',
    description:
      'Os posts marcados de `from` a `to` (os dois dias inclusive, no fuso da empresa; até 62 dias, senão 422 `periodo-invalido`), na ordem da hora, cada um com os canais (a conta, o texto, a situação, o endereço do que saiu) e a situação do post (`status`: esperando a aprovação, agendado, publicando, publicado, em parte, não saiu, cancelado, recusado ou expirado). Com a função `social_write` desligada para a empresa, `enabled` é `false` e a lista vem vazia.',
  })
  @ApiOkResponse({ standardSchema: PostListResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  @ApiUnprocessableEntityResponse({ standardSchema: ProblemDetails })
  listar(@Auth() auth: AuthContext, @Query({ schema: PostListQuery }) query: PostListQuery): Promise<PostListResponse> {
    return this.posts.listar(auth, query);
  }

  @Get(':id')
  @Permissao('campanhas.ver')
  @ApiOperation({ summary: 'Um post', description: 'O post, com os canais e a situação; o de outra empresa, ou que não existe, 404 `post-nao-encontrado`.' })
  @ApiOkResponse({ standardSchema: PostResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  obter(@Auth() auth: AuthContext, @Param('id', { schema: ResourceId }) id: string): Promise<PostResponse> {
    return this.posts.obter(auth, id);
  }

  @Get(':id/photo')
  @Permissao('campanhas.operar')
  @ApiOperation({
    summary: 'A foto do pacote pronto, para baixar',
    description:
      'Só para o pacote (`kind: pacote`; o post do Liame, 409 `nao-e-pacote`), pronto ou publicado (o tirado da Agenda, 409 `pacote-tirado`): o endereço da cópia que o Liame guarda (JPEG, sem os dados do celular), que baixa como arquivo (`filename`, `liame-<rede>-<dia>.jpg`) e vale 5 minutos (`expires_at`). A foto que saiu das Fotos, ou mudou, 409 `foto-apagada`; o armazenamento fora do ar, 503 `fotos-indisponiveis`. Precisa da função `social_write` ligada (409 `funcao-desligada`).',
  })
  @ApiOkResponse({ standardSchema: PostPhotoResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  @ApiConflictResponse({ standardSchema: ProblemDetails })
  @ApiServiceUnavailableResponse({ standardSchema: ProblemDetails })
  foto(@Auth() auth: AuthContext, @Param('id', { schema: ResourceId }) id: string): Promise<PostPhotoResponse> {
    return this.posts.fotoDoPacote(auth, id);
  }

  @Post()
  @HttpCode(201)
  @Permissao('campanhas.operar')
  @Auditar(ACAO_CRIAR_POST, { recurso: RECURSO_DO_POST })
  @ApiOperation({
    summary: 'Novo post: o post e o pedido em Aprovações',
    description:
      'Grava o post (a foto das Fotos da marca, os canais com o texto de cada um, a hora e o recorte do Instagram) e faz o pedido em Aprovações (a ferramenta `post_publicar`), que só sai com a aprovação de uma pessoa, com o código do app, na hora marcada. O TikTok e o YouTube não entram no pedido: cada um vira um pacote pronto (`kind: pacote`), na mesma hora, sem pedido e sem o código, que a pessoa publica e marca (A6, Z8). Devolve o post do Liame ou, sem ele, o primeiro pacote. Precisa da função `social_write` ligada (409 `funcao-desligada`). Recusas (422): `canal-repetido`, `texto-longo-demais` (o Instagram e o TikTok aceitam até 2.200 caracteres; o YouTube, 5.000), `foto-fora-da-marca` (a foto não é uma pronta das Fotos desta marca), `hora-no-passado`, `hora-longe-demais` (até 60 dias), `hora-fora-da-janela` (das 8h às 22h, no fuso da empresa), `canal-nao-conectado` (a Página ou o Instagram não está ligado à marca em Contas conectadas), `canal-com-duas-contas` e `politica-negou` (o texto do pacote com uma palavra que a política proíbe). O recorte (`crop_pos`, de 0 a 100) só vale quando o Instagram está no post e a foto não cabe nele; sem ele, no centro. O trilho também pode recusar o pedido (a política, a trava).',
  })
  @ApiCreatedResponse({ standardSchema: PostResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  @ApiConflictResponse({ standardSchema: ProblemDetails })
  @ApiUnprocessableEntityResponse({ standardSchema: ProblemDetails })
  criar(@Auth() auth: AuthContext, @Body({ schema: CreatePostRequest }) body: CreatePostRequest): Promise<PostResponse> {
    return this.posts.criar(auth, body);
  }

  @Post(':id/published')
  @HttpCode(200)
  @Permissao('campanhas.operar')
  @Auditar(ACAO_PACOTE_PUBLICADO, { recurso: RECURSO_DO_POST })
  @ApiOperation({
    summary: '"Publiquei": o pacote pronto foi publicado pela pessoa',
    description:
      'Só para o pacote (`kind: pacote`; o post do Liame, 409 `nao-e-pacote`): o pacote pronto fica publicado, com a hora. A segunda vez não muda nada; o pacote tirado da Agenda, 409 `pacote-tirado`. O Liame não confere na rede (não lê o TikTok nem o YouTube). Sem o código do app (D-A6-25).',
  })
  @ApiOkResponse({ standardSchema: PostResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  @ApiConflictResponse({ standardSchema: ProblemDetails })
  marcarPublicado(@Auth() auth: AuthContext, @Param('id', { schema: ResourceId }) id: string): Promise<PostResponse> {
    return this.posts.marcarPublicado(auth, id);
  }

  @Post(':id/remove')
  @HttpCode(200)
  @Permissao('campanhas.operar')
  @Auditar(ACAO_PACOTE_TIRADO, { recurso: RECURSO_DO_POST })
  @ApiOperation({
    summary: 'Tirar o pacote pronto da Agenda',
    description:
      'Só para o pacote (`kind: pacote`; o post do Liame, 409 `nao-e-pacote`, e ele se cancela pelo pedido): o pacote pronto sai da Agenda, e nada foi publicado pelo Liame. A segunda vez não muda nada; o já marcado como publicado, 409 `pacote-ja-publicado`.',
  })
  @ApiOkResponse({ standardSchema: PostResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  @ApiConflictResponse({ standardSchema: ProblemDetails })
  tirar(@Auth() auth: AuthContext, @Param('id', { schema: ResourceId }) id: string): Promise<PostResponse> {
    return this.posts.tirar(auth, id);
  }

  @Post(':id/retry')
  @HttpCode(200)
  @Permissao('campanhas.operar')
  @Auditar(ACAO_TENTAR_DE_NOVO, { recurso: RECURSO_DO_POST })
  @ApiOperation({
    summary: '"Tentar de novo": o post no canal em que ele não saiu',
    description:
      'Só para o post que saiu num canal e não no outro (A6, Z5d; P19; D-A6-54): manda o MESMO post aprovado só no canal que faltou, sem o código do app (a ferramenta `post_tentar_de_novo`, pedida pela pessoa: a política da distribuição v10 a deixa direta). O canal volta para a espera, e o pedido novo nasce aprovado e sai agora, entre 8h e 22h no fuso da empresa; ele passa a ser o pedido do post (`action_id`). Vale até 24 horas depois de o post sair no outro canal (`retry_until` em cada canal diz até quando). Recusas (409): `post-ainda-sai` (o pedido ainda espera a aprovação ou a hora, ou está saindo), `post-nao-sai` (cancelado, recusado ou expirado), `post-nao-saiu` (não saiu em nenhum canal), `post-ja-saiu`, `tentar-nao-adianta` (o motivo pede um post novo: a foto recusada, o arquivo que sumiu, a foto grande demais para a Página, a tentativa que não deu para conferir), `prazo-da-tentativa`, `e-pacote` e `funcao-desligada`; 422 `canal-nao-conectado`. O trilho também pode recusar (a trava do post, a política, o plano: a conta que saiu da marca, a foto apagada).',
  })
  @ApiOkResponse({ standardSchema: PostResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  @ApiConflictResponse({ standardSchema: ProblemDetails })
  @ApiUnprocessableEntityResponse({ standardSchema: ProblemDetails })
  tentarDeNovo(@Auth() auth: AuthContext, @Param('id', { schema: ResourceId }) id: string): Promise<PostResponse> {
    return this.posts.tentarDeNovo(auth, id);
  }
}
