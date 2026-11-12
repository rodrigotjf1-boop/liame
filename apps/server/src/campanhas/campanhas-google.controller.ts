import { CreateGoogleCampaignRequest, GoogleCampaignOptionsQuery, GoogleCampaignOptionsResponse, GoogleCampaignResponse, ProblemDetails, ResourceId } from '@liame/contracts';
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
import { CampanhasGoogleService } from './campanhas-google.service.js';

// A campanha nova no Google, criada pausada (A5, Y9, parte 2; P45 pré-aprovado em 12/11/2026; D-A5-21 a D-A5-26). Sem
// tela ainda (a tela é a parte 5): a rota grava o pedido, que espera o código do app em Aprovações, e a leitura diz em
// que pé a criação está. A criação no Google é a parte 3.

@ApiTags('campanhas-google')
@ApiCookieAuth('liame_sessao')
@Controller('google-campaigns')
export class CampanhasGoogleController {
  constructor(private readonly campanhas: CampanhasGoogleService) {}

  @Post()
  @HttpCode(201)
  @Permissao('campanhas.operar')
  @Auditar('campanha_google.pedir', { recurso: 'google_campaign_new' })
  @ApiOperation({
    summary: 'Pedir uma campanha nova no Google, criada pausada',
    description:
      'A peça aprovada em Criativos, com os textos nos tamanhos do Google (de 3 a 15 títulos de até 30 caracteres, de 1 a 5 títulos longos de até 90, de 2 a 5 descrições de até 90 e o nome da loja com até 25) e uma foto pronta de Fotos (o Liame recorta nas proporções 1,91:1 e 1:1; a foto pequena é recusada), vira um pedido em Aprovações (a ferramenta `campanha_google_criar`): depois da aprovação com o código do app, o Liame cria no Google uma campanha Performance Max pausada, numa requisição só (o orçamento, a campanha com o raio em volta da loja, o nome e a logo da loja, e o grupo de recursos com os textos, os recortes e o cardápio da loja como destino). Ativar é outro pedido. Precisa da função `campanha_google` (409 `funcao-desligada`); a escrita no Google (`google_write`) vale na execução. Conflitos (409): `sem-conta-do-google`, `varias-contas-do-google`, `sem-logo` (a logo de Minha marca, quadrada, de pelo menos 128 × 128), `ja-pedida` (a peça já tem um pedido em aberto). Recusas (422): `peca-nao-encontrada`, `peca-nao-aprovada`, `textos-do-google` (no campo `headlines`, `long_headlines` ou `descriptions`), `nome-da-loja-longo`, `midia-fora-das-fotos`, `nao-e-foto`, `foto-pequena`, `verba-invalida`, `loja-nao-encontrada`, `loja-sem-endereco`, `sem-cardapio`, `acima-do-teto` e `fim-no-passado`. O trilho também pode recusar (a política, a trava).',
  })
  @ApiCreatedResponse({ standardSchema: GoogleCampaignResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  @ApiConflictResponse({ standardSchema: ProblemDetails })
  @ApiUnprocessableEntityResponse({ standardSchema: ProblemDetails })
  criar(@Auth() auth: AuthContext, @Body({ schema: CreateGoogleCampaignRequest }) body: CreateGoogleCampaignRequest): Promise<GoogleCampaignResponse> {
    return this.campanhas.criar(auth, body);
  }

  @Get('options')
  @Permissao('campanhas.ver')
  @ApiOperation({
    summary: 'As opções da gaveta da campanha nova no Google',
    description:
      'Para a gaveta "Campanha nova no Google, pausada" (P45): se a função `campanha_google` está ligada para a marca; o que impede pedir agora (`blocks`, com o mesmo `code` e as mesmas palavras da recusa do pedido: `funcao-desligada`, `sem-conta-do-google`, `varias-contas-do-google` e `sem-logo`); a conta do Google Ads; o nome da marca como sugestão do nome da loja (cortado em 25 caracteres) e a logo; as lojas (o endereço, o raio de entrega e se o cardápio vale para cada uma); o teto por campanha do Google; e a campanha nova do Google de cada peça. Só leitura.',
  })
  @ApiOkResponse({ standardSchema: GoogleCampaignOptionsResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  opcoes(@Auth() auth: AuthContext, @Query({ schema: GoogleCampaignOptionsQuery }) query: GoogleCampaignOptionsQuery): Promise<GoogleCampaignOptionsResponse> {
    return this.campanhas.opcoes(auth, query);
  }

  @Get(':id')
  @Permissao('campanhas.ver')
  @ApiOperation({
    summary: 'Uma campanha nova no Google',
    description: 'O que foi pedido, a situação (`pedida`, `criando`, `criada`, `nao_criada` com o porquê, ou `cancelada`) e o que existe no Google. A de outra empresa, ou que não existe, 404.',
  })
  @ApiOkResponse({ standardSchema: GoogleCampaignResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  obter(@Auth() auth: AuthContext, @Param('id', { schema: ResourceId }) id: string): Promise<GoogleCampaignResponse> {
    return this.campanhas.obter(auth, id);
  }
}
