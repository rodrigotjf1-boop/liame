import { MessagingCampaignDetailResponse, MessagingCampaignId, MessagingCampaignQuery, MessagingQuery, MessagingResponse, ProblemDetails } from '@liame/contracts';
import { Controller, Get, Param, Query } from '@nestjs/common';
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
import { Auth, Permissao } from '../auth/access.js';
import type { AuthContext } from '../context/request-context.js';
import { SemTransacao } from '../context/sem-transacao.js';
import { MensageriaService } from './mensageria.service.js';

// Mensageria (A5, Y4; protótipo P15, aguardando aprovação; sem tela ainda): o que a tela Mensagens lê do RegemCast na
// hora, sem guardar nada. As duas rotas só leem: nenhuma mensagem é criada, enviada ou pausada por aqui. Nenhum
// telefone e nenhum nome de contato passam por elas.

const FALA_COM_O_REGEMCAST = 'lê do RegemCast na hora, por até 15 segundos cada leitura: o banco numa transação curta e o RegemCast depois, sem transação aberta';

@ApiTags('mensageria')
@ApiCookieAuth('liame_sessao')
@Controller('messaging')
export class MensageriaController {
  constructor(private readonly mensageria: MensageriaService) {}

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
