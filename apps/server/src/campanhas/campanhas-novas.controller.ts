import {
  CreateNewCampaignRequest,
  NewCampaignAudienceQuery,
  NewCampaignAudienceResponse,
  NewCampaignDistrictSearchQuery,
  NewCampaignDistrictSearchResponse,
  NewCampaignDistrictsQuery,
  NewCampaignDistrictsResponse,
  NewCampaignOptionsQuery,
  NewCampaignOptionsResponse,
  NewCampaignResponse,
  ProblemDetails,
  ResourceId,
} from '@liame/contracts';
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
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { Auditar } from '../audit/auditar.js';
import { Auth, Permissao } from '../auth/access.js';
import type { AuthContext } from '../context/request-context.js';
import { CampanhasNovasService } from './campanhas-novas.service.js';

// A campanha nova na Meta, criada pausada (A4, X5, parte 1; P10 aprovado em 05/10/2026; D-A4-31, D-A4-35, D-A4-40 e
// D-A4-41). Sem tela ainda (a tela vem pelo protótipo P42): a rota grava o pedido, que espera o código do app em
// Aprovações, e a leitura diz em que pé a criação está.

@ApiTags('campanhas-novas')
@ApiCookieAuth('liame_sessao')
@Controller('new-campaigns')
export class CampanhasNovasController {
  constructor(private readonly campanhas: CampanhasNovasService) {}

  @Post()
  @HttpCode(201)
  @Permissao('campanhas.operar')
  @Auditar('campanha_nova.pedir', { recurso: 'ad_campaign_new' })
  @ApiOperation({
    summary: 'Pedir uma campanha nova na Meta, criada pausada',
    description:
      'A peça aprovada em Criativos, com a foto ou o vídeo pronto de Fotos (`piece_id` e `media_id`), ou um Reels já publicado no Instagram da Página (`instagram_media_id`, de Fotos › Do seu Instagram; o anúncio usa o post como está, o vídeo e a legenda, e antes de criar o Liame pergunta à Meta se ele pode virar anúncio), vira um pedido em Aprovações (a ferramenta `campanha_criar`): depois da aprovação com o código do app, o Liame cria na Meta a campanha, o conjunto (o raio em volta da loja, de 1 a 15 km, 18 anos ou mais, a verba diária e o fim, se houver) e o anúncio, todos pausados, em nome da Página da marca e com as melhorias automáticas da Meta desligadas. "Pedidos pelo cardápio" leva ao cardápio da loja, com o rastreio do Liame nos parâmetros de URL; "conversas no WhatsApp" abre a conversa no WhatsApp da Página. Ativar é outro pedido. Precisa da função `campanha_nova` (409 `funcao-desligada`); a escrita na Meta (`meta_write`) vale na execução. Conflitos (409): `sem-conta-de-anuncios`, `varias-contas-de-anuncios`, `sem-pagina`, `varias-paginas`, `ja-pedida` (a peça, ou o Reels, já tem um pedido em aberto). Recusas (422): `peca-nao-encontrada`, `peca-nao-aprovada`, `midia-fora-das-fotos`, `video-sem-capa`, `sem-instagram-na-pagina` (o Reels sem o Instagram ligado à Página), `reels-nao-encontrado` (fora de Fotos › Do seu Instagram, ou de outro perfil), `nao-e-reels`, `verba-invalida`, `loja-nao-encontrada`, `loja-sem-endereco` (o ponto da loja não está no endereço), `sem-cardapio`, `acima-do-teto` (a verba passa do teto por campanha) e `fim-no-passado`. O trilho também pode recusar (a política, a trava).',
  })
  @ApiCreatedResponse({ standardSchema: NewCampaignResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  @ApiConflictResponse({ standardSchema: ProblemDetails })
  @ApiUnprocessableEntityResponse({ standardSchema: ProblemDetails })
  criar(@Auth() auth: AuthContext, @Body({ schema: CreateNewCampaignRequest }) body: CreateNewCampaignRequest): Promise<NewCampaignResponse> {
    return this.campanhas.criar(auth, body);
  }

  @Post(':id/activate')
  @HttpCode(201)
  @Permissao('campanhas.operar')
  @Auditar('campanha_nova.ativar', { recurso: 'ad_campaign_new' })
  @ApiOperation({
    summary: 'Pedir para ativar a campanha nova',
    description:
      'A campanha nova criada e pausada passa a rodar: um pedido em Aprovações (a ferramenta `campanha_nova_ativar`) que espera o código do app e, por voltar a gastar, pede os limites da empresa e cabe na verba do mês. Aprovado, o Liame lê o anúncio, o conjunto e a campanha na Meta (o que foi apagado ou arquivado lá não volta) e põe os três em ativo; a Meta revisa o anúncio antes de mostrar. A volta é pausar (`POST /v1/actions/{id}/undo`). `pending_action_id` traz o pedido. Precisa da função `campanha_nova` (409 `funcao-desligada`). Conflitos (409): `ainda-nao-criada`, `ja-ativa`, `pedido-em-aberto`. Recusa (422): `acima-do-teto`. O trilho também pode recusar (os limites, a política, a trava).',
  })
  @ApiCreatedResponse({ standardSchema: NewCampaignResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  @ApiConflictResponse({ standardSchema: ProblemDetails })
  @ApiUnprocessableEntityResponse({ standardSchema: ProblemDetails })
  ativar(@Auth() auth: AuthContext, @Param('id', { schema: ResourceId }) id: string): Promise<NewCampaignResponse> {
    return this.campanhas.ativar(auth, id);
  }

  @Get('options')
  @Permissao('campanhas.ver')
  @ApiOperation({
    summary: 'As opções da gaveta da campanha nova',
    description:
      'Para a gaveta "Campanha nova, pausada" (P42): se a função `campanha_nova` está ligada para a marca; o que impede pedir agora (`blocks`, com o mesmo `code` e as mesmas palavras da recusa do pedido: `funcao-desligada`, `sem-conta-de-anuncios`, `varias-contas-de-anuncios`, `sem-pagina`, `varias-paginas`); a conta de anúncios, a Página que assina o anúncio e o Instagram ligado a ela; as lojas da marca, cada uma com o endereço, se o ponto está no endereço (a campanha só nasce assim), o raio de entrega e se "pedidos pelo cardápio" vale para ela (com o porquê, quando não); o teto por campanha da Meta; e a campanha nova mais recente de cada peça (a cancelada fica fora). Só leitura. Marca de outra empresa, 404.',
  })
  @ApiOkResponse({ standardSchema: NewCampaignOptionsResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  opcoes(@Auth() auth: AuthContext, @Query({ schema: NewCampaignOptionsQuery }) query: NewCampaignOptionsQuery): Promise<NewCampaignOptionsResponse> {
    return this.campanhas.opcoes(auth, query);
  }

  @Get('audience-estimate')
  @Permissao('campanhas.ver')
  @ApiOperation({
    summary: 'A estimativa de público no raio da loja',
    description:
      'Para a gaveta da campanha nova (R6, D-RG-50): quantas pessoas de 18 anos ou mais há no raio em volta do ponto da loja, pela estimativa da Meta (`reachestimate`) lida agora com a conta de anúncios da marca: `pronta` (o mínimo e o máximo, e `enough`: o máximo a partir de `minimum`, 1.000 pessoas; abaixo disso, o pedido é recusado com `publico-pequeno`), `sem_estimativa` (a Meta não estimou, o que não quer dizer público vazio) ou `indisponivel` (sem uma conta de anúncios, sem o ponto da loja no endereço, ou a Meta não respondeu agora). Só leitura. Marca ou loja de outra empresa, 404.',
  })
  @ApiOkResponse({ standardSchema: NewCampaignAudienceResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  estimarPublico(@Auth() auth: AuthContext, @Query({ schema: NewCampaignAudienceQuery }) query: NewCampaignAudienceQuery): Promise<NewCampaignAudienceResponse> {
    return this.campanhas.estimarPublico(auth, query);
  }

  @Get('districts')
  @Permissao('campanhas.ver')
  @ApiOperation({
    summary: 'Os bairros da gaveta da campanha nova',
    description:
      'Para "Quem vê: Bairros" (R6, parte 3; D-RG-53 a D-RG-55): os bairros do IBGE do município da loja que a gaveta sugere, as áreas de entrega da loja primeiro (`delivery_area`, marcadas ao abrir), depois os bairros com pedidos na última leitura do Regem (`orders`, nos `orders_days` dela) e os escolhidos pela busca (`extra`). Cada um diz como vai para a Meta (`how`): `meta` (o bairro dela, achado pelo mesmo nome na mesma cidade), `circulo` (um círculo no centro do bairro, pelo OpenStreetMap, com o raio pelo tamanho do bairro no IBGE, de 1 a 3 km), `procurando` (o centro ainda não foi achado: `pending` e a gaveta pergunta de novo) ou `sem_centro` (o mapa não achou o bairro). O centro vem a partir da loja, em km (`x_km` para leste, `y_km` para norte), para a prévia em escala. `unmatched`: as áreas de entrega que não estão entre os bairros do IBGE. A loja sem o ponto no endereço ou sem o município: `sem_cidade`. Marca ou loja de outra empresa, 404.',
  })
  @ApiOkResponse({ standardSchema: NewCampaignDistrictsResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  bairros(@Auth() auth: AuthContext, @Query({ schema: NewCampaignDistrictsQuery }) query: NewCampaignDistrictsQuery): Promise<NewCampaignDistrictsResponse> {
    return this.campanhas.bairros(auth, query);
  }

  @Get('districts/search')
  @Permissao('campanhas.ver')
  @ApiOperation({
    summary: 'A busca de outro bairro do município da loja',
    description: 'Os bairros do IBGE do município da loja com o nome procurado (`q`, sem diferença de acento e de maiúscula), até 10: os que começam com o texto primeiro. Para "Outro bairro da cidade" na gaveta (D-RG-55); o escolhido volta em `GET /v1/new-campaigns/districts?extra=`. Marca ou loja de outra empresa, 404.',
  })
  @ApiOkResponse({ standardSchema: NewCampaignDistrictSearchResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  buscarBairros(
    @Auth() auth: AuthContext,
    @Query({ schema: NewCampaignDistrictSearchQuery }) query: NewCampaignDistrictSearchQuery,
  ): Promise<NewCampaignDistrictSearchResponse> {
    return this.campanhas.buscarBairros(auth, query);
  }

  @Get(':id')
  @Permissao('campanhas.ver')
  @ApiOperation({
    summary: 'Uma campanha nova',
    description: 'O que foi pedido, a situação (`pedida`, `criando`, `criada`, `nao_criada` com o porquê, ou `cancelada`) e o que já existe na Meta. A de outra empresa, ou que não existe, 404.',
  })
  @ApiOkResponse({ standardSchema: NewCampaignResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  obter(@Auth() auth: AuthContext, @Param('id', { schema: ResourceId }) id: string): Promise<NewCampaignResponse> {
    return this.campanhas.obter(auth, id);
  }
}
