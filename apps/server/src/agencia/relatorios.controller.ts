import {
  AgencyReportDetailResponse,
  AgencyReportSentResponse,
  AgencyReportsQuery,
  AgencyReportsResponse,
  ProblemDetails,
  ResourceId,
  SendAgencyReportRequest,
} from '@liame/contracts';
import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import {
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
import { AgencyReportsService } from './relatorios.service.js';

// O relatório do mês que a agência manda ao cliente (A7, W7, parte 4a; P29; D-A7-65 a D-A7-68; D-A7-82). Quem é da
// agência chega pela permissão `agencia.ver`; o que vale de verdade é o time e o nível dela dentro de cada cliente.

const LE_EM_CADA_CLIENTE =
  'lê cada cliente no contexto dele, com a pessoa da agência (a RLS e o nível dela ali decidem), uma transação curta por cliente: a requisição está na agência e o relatório é do cliente';
const MANDA_OS_EMAILS =
  'confere no cliente e grava o envio e as entregas na agência, em transações curtas, com a auditoria (manual); os e-mails saem sem transação aberta, e o resultado de cada um é gravado noutra transação curta';

@ApiTags('agency')
@ApiCookieAuth('liame_sessao')
@Controller('agency')
export class AgencyReportsController {
  constructor(private readonly relatorios: AgencyReportsService) {}

  @Get('reports')
  @Permissao('agencia.ver')
  @SemTransacao(LE_EM_CADA_CLIENTE)
  @ApiOperation({
    summary: 'Os relatórios do mês dos clientes',
    description:
      'O relatório do mês de cada marca de cada cliente vivo (o membro vê só os clientes em que está), com a situação: `esperando` (pronto, a agência ainda não mandou; com até quando o e-mail do próprio Liame espera), `mandado` (o último envio), `suspensa` (a conta do cliente está suspensa: o relatório fica só com o Dono, com o nome dele e desde quando), `sem_relatorio`, `sem_acesso` (o nível da pessoa no cliente não vê os resultados) e `fora_do_time`. Sem `month`, o último mês fechado.',
  })
  @ApiOkResponse({ standardSchema: AgencyReportsResponse })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  lista(@Auth() auth: AuthContext, @Query({ schema: AgencyReportsQuery }) query: AgencyReportsQuery): Promise<AgencyReportsResponse> {
    return this.relatorios.lista(auth, query.month);
  }

  @Get('clients/:id/reports/:reportId')
  @Permissao('agencia.ver')
  @SemTransacao(LE_EM_CADA_CLIENTE)
  @ApiOperation({
    summary: 'Um relatório do cliente, para revisar e mandar',
    description:
      'O relatório do mês, o mesmo que o Dono vê (só o que o nível da pessoa no cliente deixa ver), a marca da agência que vai no alto, quem da empresa pode receber (o Dono sempre; os Administradores e "Só relatórios por e-mail", com o e-mail confirmado) e os envios anteriores desta agência. Precisa estar no time do cliente com um nível que vê os resultados (403 `sem-acesso-ao-relatorio`).',
  })
  @ApiOkResponse({ standardSchema: AgencyReportDetailResponse })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  detalhe(
    @Auth() auth: AuthContext,
    @Param('id', { schema: ResourceId }) id: string,
    @Param('reportId', { schema: ResourceId }) reportId: string,
  ): Promise<AgencyReportDetailResponse> {
    return this.relatorios.detalhe(auth, id, reportId);
  }

  @Post('clients/:id/reports/:reportId/send')
  @HttpCode(200)
  @Permissao('agencia.ver')
  @SemTransacao(MANDA_OS_EMAILS)
  @Auditar('agencia.relatorio_mandar', { manual: true, recurso: 'agency_report_send' })
  @ApiOperation({
    summary: 'Mandar o relatório ao cliente',
    description:
      'Manda o relatório do mês por e-mail, com o nome e o logo da agência no alto e o comentário assinado por quem mandou; o remetente é "Agência pelo Liame" e o "Responder" vai para o e-mail de resposta confirmado da agência. O Dono sempre recebe; `recipient_ids` são os outros, entre os que podem receber (422 `destinatario-fora`). Mandar de novo cria a versão seguinte, e o e-mail diz que é uma versão corrigida; o mesmo relatório duas vezes em menos de um minuto, 409 `acabou-de-mandar`. Com a conta do cliente suspensa, 409 `conta-suspensa`. Quem recebe o da agência não recebe o e-mail do Liame daquele mês.',
  })
  @ApiOkResponse({ standardSchema: AgencyReportSentResponse })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  @ApiConflictResponse({ standardSchema: ProblemDetails })
  @ApiUnprocessableEntityResponse({ standardSchema: ProblemDetails })
  mandar(
    @Auth() auth: AuthContext,
    @Param('id', { schema: ResourceId }) id: string,
    @Param('reportId', { schema: ResourceId }) reportId: string,
    @Body({ schema: SendAgencyReportRequest }) body: SendAgencyReportRequest,
  ): Promise<AgencyReportSentResponse> {
    return this.relatorios.mandar(auth, id, reportId, body);
  }
}
