import {
  GoogleConversionActionsQuery,
  GoogleConversionActionsResponse,
  GoogleConversionsQuery,
  GoogleConversionsResponse,
  ProblemDetails,
  SetGoogleConversionDestinationRequest,
  StopGoogleConversionDestinationRequest,
} from '@liame/contracts';
import { Body, Controller, Get, HttpCode, Post, Put, Query } from '@nestjs/common';
import {
  ApiBadGatewayResponse,
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
import { Auth, Permissao } from '../auth/access.js';
import type { AuthContext } from '../context/request-context.js';
import { SemTransacao } from '../context/sem-transacao.js';
import { ACAO_DEFINIR, ACAO_PARAR, ConversoesService } from './conversoes.service.js';

// Conversões para o Google (A5, Y1; protótipo P14, aprovado em 09/10/2026; a tela é o cartão "Vendas informadas ao
// Google" em Contas conectadas): a venda confirmada no caixa
// que veio de um clique num anúncio do Google é informada ao Google, para a conversão que uma pessoa da empresa
// escolhe em cada conta do Google Ads. Estas rotas mostram a situação de cada conta, listam as conversões da conta e
// escolhem ou param o destino. Quem envia é a rotina do worker; por aqui nada sai para o Google além da leitura da
// lista de conversões.

const FALA_COM_O_GOOGLE = 'lê as conversões da conta no Google na hora, por até 15 segundos: o banco numa transação curta e o Google depois, sem transação aberta';

@ApiTags('conversoes')
@ApiCookieAuth('liame_sessao')
@Controller('conversions/google')
export class ConversoesController {
  constructor(private readonly conversoes: ConversoesService) {}

  @Get()
  @Permissao('contas.ver')
  @ApiOperation({
    summary: 'As vendas informadas ao Google, por conta',
    description:
      'A situação de cada conta do Google Ads da marca: se a autorização do Google inclui a permissão de informar vendas (`authorized`), a conversão escolhida (`destination`, com quem escolheu, desde quando e, se parado, quem parou), a situação (`informando`, `esperando_a_plataforma`, `sem_permissao`, `sem_destino`, `parado` ou `equipe_parada`), as vendas dos últimos 30 dias (informadas, esperando a vez, com o valor corrigido e recusadas), a última e a próxima passagem, a última falha da passagem (com o tipo: `esperar`, `permissao` ou `outro`) e a recusa mais recente do Google, com o motivo sem identificador. Com a função desligada para a empresa, `enabled` é falso e `accounts` vem vazia. `can_manage` diz se quem pediu pode escolher, trocar e parar. O pedido sai `wait_minutes` minutos depois de confirmado.',
  })
  @ApiOkResponse({ standardSchema: GoogleConversionsResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  ver(@Auth() auth: AuthContext, @Query({ schema: GoogleConversionsQuery }) query: GoogleConversionsQuery): Promise<GoogleConversionsResponse> {
    return this.conversoes.ver(auth, query.brand_id);
  }

  @Get('actions')
  @Permissao('contas.conectar')
  @SemTransacao(FALA_COM_O_GOOGLE)
  @ApiOperation({
    summary: 'As conversões da conta que recebem vendas',
    description:
      'As ações de conversão ATIVAS da conta do Google Ads que recebem venda importada por clique, lidas no Google agora, por nome. É entre elas que a pessoa escolhe; a lista vazia quer dizer que a conta ainda não tem uma (cria-se no Google Ads). `primary` diz se o Google usa a conversão nos lances por padrão. Precisa da função ligada para a empresa (409 `conversoes-desligadas`) e da autorização do Google com a permissão de informar vendas (409 `google-sem-permissao`: é autorizar o Google de novo); se o Google não responder, 502 `plataforma-indisponivel` (nada muda: é tentar de novo); se ele recusar a consulta, 422 `plataforma-recusou`.',
  })
  @ApiOkResponse({ standardSchema: GoogleConversionActionsResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  @ApiConflictResponse({ standardSchema: ProblemDetails })
  @ApiUnprocessableEntityResponse({ standardSchema: ProblemDetails })
  @ApiBadGatewayResponse({ standardSchema: ProblemDetails })
  acoes(@Auth() auth: AuthContext, @Query({ schema: GoogleConversionActionsQuery }) query: GoogleConversionActionsQuery): Promise<GoogleConversionActionsResponse> {
    return this.conversoes.acoes(auth, query.connected_account_id);
  }

  @Put('destination')
  @Permissao('contas.conectar')
  @SemTransacao(FALA_COM_O_GOOGLE)
  @Auditar(ACAO_DEFINIR, { manual: true, recurso: 'conversion_destination' })
  @ApiOperation({
    summary: 'Escolher a conversão que recebe as vendas',
    description:
      'Escolhe, troca ou retoma (depois de uma parada) a conversão da conta do Google Ads para onde o Liame informa as vendas. A conversão é conferida no Google na hora: só vale uma das que `GET /v1/conversions/google/actions` lista (422 `conversao-nao-encontrada`). Só entram os pedidos confirmados a partir de agora: não há carga do passado, e trocar a conversão ou voltar de uma parada recomeça de agora. Ao trocar, o que esperava a vez para a conversão antiga não sai. Confirmar a mesma conversão, com ela informando, não muda nada. Mesmas condições e recusas da lista de conversões. Devolve a situação das contas da marca, como `GET /v1/conversions/google`.',
  })
  @ApiOkResponse({ standardSchema: GoogleConversionsResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  @ApiConflictResponse({ standardSchema: ProblemDetails })
  @ApiUnprocessableEntityResponse({ standardSchema: ProblemDetails })
  @ApiBadGatewayResponse({ standardSchema: ProblemDetails })
  definir(@Auth() auth: AuthContext, @Body({ schema: SetGoogleConversionDestinationRequest }) body: SetGoogleConversionDestinationRequest): Promise<GoogleConversionsResponse> {
    return this.conversoes.definir(auth, body);
  }

  @Post('destination/stop')
  @HttpCode(200)
  @Permissao('contas.conectar')
  @Auditar(ACAO_PARAR, { recurso: 'conversion_destination' })
  @ApiOperation({
    summary: 'Parar de informar as vendas',
    description:
      'Para de informar ao Google as vendas da conta: nenhuma venda nova sai, e a que esperava a vez também não. O que já foi informado continua no Google (ele não aceita retirar uma conversão), e nenhuma correção de valor sai enquanto estiver parado. Fica registrado quem parou. Vale também com a função desligada para a empresa. Parar o que já está parado não muda nada. Para voltar, é escolher a conversão de novo (`PUT /v1/conversions/google/destination`). Devolve a situação das contas da marca.',
  })
  @ApiOkResponse({ standardSchema: GoogleConversionsResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  parar(@Auth() auth: AuthContext, @Body({ schema: StopGoogleConversionDestinationRequest }) body: StopGoogleConversionDestinationRequest): Promise<GoogleConversionsResponse> {
    return this.conversoes.parar(auth, body);
  }
}
