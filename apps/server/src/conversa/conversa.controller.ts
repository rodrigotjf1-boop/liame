import {
  ConversationListQuery,
  ConversationListResponse,
  ConversationResponse,
  type ConversationStreamEvent,
  ConversationStreamEvent as EventoDoFluxo,
  DemandResponse,
  ProblemDetails,
  ResourceId,
  SendConversationMessageRequest,
} from '@liame/contracts';
import { Body, Controller, Get, HttpCode, Logger, Param, Post, Query, Res } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCookieAuth,
  ApiExtension,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import type { ServerResponse } from 'node:http';
import { Auditar, SemAuditoria } from '../audit/auditar.js';
import { Auth, Permissao } from '../auth/access.js';
import type { AuthContext } from '../context/request-context.js';
import { SemTransacao } from '../context/sem-transacao.js';
import { currentTraceId, toProblem } from '../errors/problems.js';
import { ConversaService, evento } from './conversa.service.js';
import { DemandasService } from './demandas.service.js';

// Conversa com a LIA (A3, I10; protótipo P5, aguardando aprovação; sem tela ainda). A mensagem nova responde por um
// fluxo de eventos (`text/event-stream`): a tela lê com `fetch` e um leitor do corpo, e "Parar" é fechar a leitura.

/**
 * De quanto em quanto tempo o fluxo manda uma linha só para a conexão não cair enquanto o modelo pensa: a Cloudflare
 * corta a leitura da origem parada em 125 s (Proxy Read Timeout, `base-conhecimento.md` §15.2), e outro proxy no
 * caminho pode cortar antes.
 */
const MANTER_A_CADA_MS = 15_000;

@ApiTags('conversa')
@ApiCookieAuth('liame_sessao')
@Controller('conversations')
export class ConversaController {
  private readonly logger = new Logger('conversa');

  constructor(private readonly conversas: ConversaService) {}

  @Get()
  @Permissao('conversa.usar')
  @ApiOperation({
    summary: 'Suas conversas com a LIA',
    description:
      'As conversas da pessoa nesta marca nos últimos 30 dias, da mais recente para a mais antiga (até 100), e se a LIA conversa aqui (`lia`: a IA ligada e a LIA ativa). Só a própria pessoa vê as conversas dela. Leva também o limite de respostas por conversa e o contato do atendimento da Liame ("Falar com uma pessoa").',
  })
  @ApiOkResponse({ standardSchema: ConversationListResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  list(@Auth() auth: AuthContext, @Query({ schema: ConversationListQuery }) query: ConversationListQuery): Promise<ConversationListResponse> {
    return this.conversas.lista(auth, query.brand_id);
  }

  @Get(':id')
  @Permissao('conversa.usar')
  @ApiOperation({
    summary: 'Uma conversa, com as mensagens',
    description:
      'A conversa e as mensagens dos últimos 30 dias, na ordem: as da pessoa (sem dado pessoal), as respostas da LIA (blocos conferidos, a fonte de cada número, o que ela leu e o que ela fez) e os avisos do sistema. Conversa de outra pessoa volta 404.',
  })
  @ApiOkResponse({ standardSchema: ConversationResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  get(@Auth() auth: AuthContext, @Param('id', { schema: ResourceId }) id: string): Promise<ConversationResponse> {
    return this.conversas.conversa(auth, id);
  }

  @Post('messages')
  @HttpCode(200)
  @Permissao('conversa.usar')
  @SemTransacao('espera um modelo de IA por segundos, com o fluxo aberto: grava a mensagem e a resposta em transações curtas, antes e depois')
  @SemAuditoria('conversa é conteúdo da pessoa, guardado 30 dias em conversation_message; o que a LIA registra em nome dela (a demanda) vai para a auditoria como ação do agente')
  @ApiExtension('x-liame-fluxo', { formato: 'text/event-stream', eventos: ['inicio', 'passo', 'mensagem', 'fim', 'erro'] })
  @ApiOperation({
    summary: 'Mandar uma mensagem para a LIA',
    description:
      'Grava a mensagem da pessoa (sem dado pessoal: telefone, e-mail, documento e CEP saem antes de tudo) e responde por um fluxo de eventos (`text/event-stream`), cada um com o JSON de `ConversationStreamEvent`: `inicio` (a conversa e a mensagem como foram guardadas), `passo` (o que a LIA está lendo), `mensagem` (a resposta da LIA, inteira e já conferida, ou o aviso do sistema) e `fim` (a conversa com as contas novas). A resposta só sai depois da conferência: todo número está no que a LIA leu, e o texto passou pelo Compliance e pelo que a marca não diz; senão, vem o aviso `recusada`. Falar com uma pessoa, pedido político ou eleitoral e LIA desligada são decididos por regra, sem chamar a IA. Fechar a leitura do fluxo é "Parar": nenhuma leitura nova começa, e a resposta fica como interrompida. Sem `conversation_id`, abre uma conversa nova. Antes do fluxo, os erros são os de sempre: 404 (marca ou conversa), 409 (`mensagem-repetida`, `conversa-ocupada`, `conversa-cheia`), 422 (`conversa-de-outra-marca`).',
  })
  @ApiOkResponse({ standardSchema: EventoDoFluxo, description: 'Fluxo de eventos (`text/event-stream`), um `ConversationStreamEvent` por evento.' })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  @ApiConflictResponse({ standardSchema: ProblemDetails })
  @ApiUnprocessableEntityResponse({ standardSchema: ProblemDetails })
  @ApiTooManyRequestsResponse({ standardSchema: ProblemDetails })
  async send(@Auth() auth: AuthContext, @Body({ schema: SendConversationMessageRequest }) body: SendConversationMessageRequest, @Res() res: ServerResponse): Promise<void> {
    // Erro aqui ainda é resposta HTTP comum (o filtro de problemas responde).
    const turno = await this.conversas.preparar(auth, body);

    const parar = new AbortController();
    // A pessoa tocou em "Parar" ou fechou a tela: a conexão fecha antes do fim da resposta.
    res.on('close', () => {
      if (!res.writableFinished) parar.abort();
    });
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    const escrever = (texto: string) => {
      if (!res.writableEnded && !res.destroyed) res.write(texto);
    };
    const enviar = (e: ConversationStreamEvent) => escrever(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
    const manter = setInterval(() => escrever(': segue\n\n'), MANTER_A_CADA_MS);
    try {
      enviar(evento('inicio', { conversation: turno.conversa, message: turno.pessoa }));
      await this.conversas.responder(turno, { enviar, parar: parar.signal });
    } catch (err) {
      const problema = toProblem(err, currentTraceId(), '/v1/conversations/messages');
      this.logger.error(`conversa: a resposta falhou no meio do fluxo [trace ${problema.trace_id}]: ${err instanceof Error ? err.message : String(err)}`, err instanceof Error ? err.stack : undefined);
      enviar(evento('erro', { problem: { ...problema, detail: 'A resposta não pôde ser concluída. A sua mensagem ficou guardada; tente de novo.' } }));
    } finally {
      clearInterval(manter);
      if (!res.writableEnded) res.end();
    }
  }
}

@ApiTags('conversa')
@ApiCookieAuth('liame_sessao')
@Controller('demands')
export class DemandasController {
  constructor(private readonly demandas: DemandasService) {}

  @Post(':id/cancel')
  @HttpCode(200)
  @Permissao('demanda.abrir')
  @Auditar('demanda.cancelar', { recurso: 'demand' })
  @ApiOperation({
    summary: 'Cancelar uma demanda aberta',
    description:
      'Cancela a demanda que a LIA registrou e que ainda está aberta: ninguém trabalha nela, e nada foi feito. Em andamento ou encerrada, volta 409. Quem pode: o dono, o administrador e o gestor.',
  })
  @ApiOkResponse({ standardSchema: DemandResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  @ApiConflictResponse({ standardSchema: ProblemDetails })
  cancel(@Auth() auth: AuthContext, @Param('id', { schema: ResourceId }) id: string): Promise<DemandResponse> {
    return this.demandas.cancelar(auth, id);
  }
}
