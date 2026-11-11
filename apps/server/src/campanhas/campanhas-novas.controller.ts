import { CreateNewCampaignRequest, NewCampaignResponse, ProblemDetails, ResourceId } from '@liame/contracts';
import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
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
      'A peça aprovada em Criativos, com a foto ou o vídeo pronto de Fotos, vira um pedido em Aprovações (a ferramenta `campanha_criar`): depois da aprovação com o código do app, o Liame cria na Meta a campanha, o conjunto (o raio em volta da loja, de 1 a 15 km, 18 anos ou mais, a verba diária e o fim, se houver) e o anúncio, todos pausados, em nome da Página da marca e com as melhorias automáticas da Meta desligadas. "Pedidos pelo cardápio" leva ao cardápio da loja, com o rastreio do Liame nos parâmetros de URL; "conversas no WhatsApp" abre a conversa no WhatsApp da Página. Ativar é outro pedido. Precisa da função `campanha_nova` (409 `funcao-desligada`); a escrita na Meta (`meta_write`) vale na execução. Conflitos (409): `sem-conta-de-anuncios`, `varias-contas-de-anuncios`, `sem-pagina`, `varias-paginas`, `ja-pedida` (a peça já tem um pedido em aberto). Recusas (422): `peca-nao-encontrada`, `peca-nao-aprovada`, `midia-fora-das-fotos`, `video-sem-capa`, `verba-invalida`, `loja-nao-encontrada`, `loja-sem-endereco` (o ponto da loja não está no endereço), `sem-cardapio`, `acima-do-teto` (a verba passa do teto por campanha) e `fim-no-passado`. O trilho também pode recusar (a política, a trava).',
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
