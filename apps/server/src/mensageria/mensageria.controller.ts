import {
  MessageDiscountRequest,
  MessageDiscountResponse,
  MessagingCampaignDetailResponse,
  MessagingCampaignId,
  MessagingCampaignQuery,
  MessagingQuery,
  MessagingResponse,
  ProblemDetails,
} from '@liame/contracts';
import { Body, Controller, Get, Param, Put, Query } from '@nestjs/common';
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
import { DescontoDasMensagensService } from './desconto.service.js';
import { MensageriaService } from './mensageria.service.js';

// Mensageria (A5, Y4; protótipo P15, aguardando aprovação; sem tela ainda): o que a tela Mensagens lê do RegemCast na
// hora, sem guardar nada. As duas rotas só leem: nenhuma mensagem é criada, enviada ou pausada por aqui. Nenhum
// telefone e nenhum nome de contato passam por elas.
// As duas rotas do desconto padrão do cupom das mensagens (A5, Y6; protótipo P15, parte D, aguardando aprovação: sem
// tela ainda) ficam no banco do Liame e não falam com o RegemCast nem com o Regem.

const FALA_COM_O_REGEMCAST = 'lê do RegemCast na hora, por até 15 segundos cada leitura: o banco numa transação curta e o RegemCast depois, sem transação aberta';

@ApiTags('mensageria')
@ApiCookieAuth('liame_sessao')
@Controller('messaging')
export class MensageriaController {
  constructor(
    private readonly mensageria: MensageriaService,
    private readonly desconto: DescontoDasMensagensService,
  ) {}

  @Get('discount')
  @Permissao('campanhas.ver')
  @ApiOperation({
    summary: 'O desconto padrão do cupom das mensagens',
    description:
      'O desconto que o cupom de cada mensagem de WhatsApp dá, definido uma vez pela empresa: o tipo (`percentual`, `valor` ou `frete_gratis`), o valor, o pedido mínimo, por quantos dias o cupom vale (contando o dia do envio), a loja do Regem onde ele nasce e quem definiu por último. `discount` nulo: ninguém definiu ainda, e o funcionário de CRM e mensageria não propõe mensagem. Vêm também as lojas do Regem da marca (com a que liberou "criar cupom de campanha"), os limites que o Liame aceita e se quem pede pode definir. Com a função das mensagens desligada para a empresa, `enabled` vem falso e nada é lido. Nenhum dado de cliente.',
  })
  @ApiOkResponse({ standardSchema: MessageDiscountResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  verDesconto(@Auth() auth: AuthContext, @Query({ schema: MessagingQuery }) query: MessagingQuery): Promise<MessageDiscountResponse> {
    return this.desconto.ver(auth, query.brand_id);
  }

  @Put('discount')
  @Permissao('orcamento.gerenciar')
  @Auditar('mensageria.desconto', { recurso: 'message_discount' })
  @ApiOperation({
    summary: 'Definir o desconto padrão do cupom das mensagens',
    description:
      'Define ou muda o desconto da marca; quem pode é quem define os limites da Verba do mês. O Liame aceita até 50% no cupom percentual; de R$ 1,00 a R$ 100,00 no de valor fixo, sempre com pedido mínimo maior que o desconto; e validade de 1 a 14 dias, contando o dia do envio (400, com o campo). A loja do Regem pode faltar quando a marca tem uma só que cria cupom; com mais de uma, é obrigatória (400); sem nenhuma que tenha liberado "criar cupom de campanha", 409 `loja-sem-cupom`. Vale para as próximas propostas: o pedido que já espera aprovação e a mensagem enviada seguem com o cupom que tinham. A mudança fica na auditoria, com o antes e o depois. Com a função desligada para a empresa, 409 `mensageria-desligada`.',
  })
  @ApiOkResponse({ standardSchema: MessageDiscountResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  @ApiConflictResponse({ standardSchema: ProblemDetails })
  definirDesconto(@Auth() auth: AuthContext, @Body({ schema: MessageDiscountRequest }) body: MessageDiscountRequest): Promise<MessageDiscountResponse> {
    return this.desconto.definir(auth, body);
  }

  @Get()
  @Permissao('campanhas.ver')
  @SemTransacao(FALA_COM_O_REGEMCAST)
  @ApiOperation({
    summary: 'As mensagens da marca, lidas do RegemCast agora',
    description:
      'Para cada conta do RegemCast conectada à marca (até 5): se a conta do WhatsApp pode enviar (`whatsapp`, com o que a Meta aponta e o que resolve), os tetos de gasto de mensagens que o dono definiu no RegemCast e quanto já saiu (`budget`), quantos modelos aprovados e públicos há (`ready`, só contagens) e as campanhas de mensagens mais novas, com os números (`campaigns`, até 20). Cada parte diz como foi a leitura dela em `status`: `ok`, `sem_permissao` (a conexão com o RegemCast não inclui aquela leitura) ou `indisponivel` (o RegemCast não respondeu agora); uma parte que falha não derruba as outras. A conta vem com `status` `sem_autorizacao` quando o RegemCast recusa a conexão (é conectar de novo). Com a função desligada para a empresa, `enabled` é falso, `accounts` vem vazia e nada é lido; ligada e sem RegemCast conectado, `accounts` vem vazia. Nada é guardado no Liame, e nenhum telefone ou nome de contato vem na resposta.',
  })
  @ApiOkResponse({ standardSchema: MessagingResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  ver(@Auth() auth: AuthContext, @Query({ schema: MessagingQuery }) query: MessagingQuery): Promise<MessagingResponse> {
    return this.mensageria.ver(auth, query.brand_id);
  }

  @Get('campaigns/:id')
  @Permissao('campanhas.ver')
  @SemTransacao(FALA_COM_O_REGEMCAST)
  @ApiOperation({
    summary: 'Uma campanha de mensagens, de perto',
    description:
      'Uma campanha da conta do RegemCast, lida agora: os números, por que está pausada (`pause`) ou esperando (`waiting`), as falhas por motivo com o que fazer (`failures`), o custo na Meta como o RegemCast informa (`cost`: o que já foi gasto e o que ainda pode sair; é estimativa e teto) e o descanso entre mensagens de marketing da conta (`rest_days`). Não diz quem recebeu. Precisa da função ligada para a empresa (409 `mensageria-desligada`); se o RegemCast recusar a conexão, 409 `regemcast-sem-autorizacao` (é conectar de novo); se a conexão não incluir a leitura das campanhas, 409 `regemcast-sem-permissao`; se o RegemCast não encontrar a campanha nesta conta, 422 `plataforma-recusou`; se ele não responder, 502 `plataforma-indisponivel` (é tentar de novo).',
  })
  @ApiOkResponse({ standardSchema: MessagingCampaignDetailResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  @ApiConflictResponse({ standardSchema: ProblemDetails })
  @ApiUnprocessableEntityResponse({ standardSchema: ProblemDetails })
  @ApiBadGatewayResponse({ standardSchema: ProblemDetails })
  detalhar(
    @Auth() auth: AuthContext,
    @Param('id', { schema: MessagingCampaignId }) id: MessagingCampaignId,
    @Query({ schema: MessagingCampaignQuery }) query: MessagingCampaignQuery,
  ): Promise<MessagingCampaignDetailResponse> {
    return this.mensageria.detalhar(auth, query.connected_account_id, id);
  }
}
