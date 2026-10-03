import {
  AiFeedbackRequest,
  AiFeedbackResponse,
  AiStatusQuery,
  AiStatusResponse,
  ExplainAttentionRequest,
  ExplainResultsRequest,
  ExplanationResponse,
  ProblemDetails,
} from '@liame/contracts';
import { Body, Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import { ApiBadRequestResponse, ApiCookieAuth, ApiForbiddenResponse, ApiNotFoundResponse, ApiOkResponse, ApiOperation, ApiTags, ApiUnprocessableEntityResponse } from '@nestjs/swagger';
import { SemAuditoria } from '../audit/auditar.js';
import { Auth, Permissao } from '../auth/access.js';
import type { AuthContext } from '../context/request-context.js';
import { SemTransacao } from '../context/sem-transacao.js';
import { AppProblem } from '../errors/problems.js';
import { ExplicarService } from './explicar/explicar.service.js';
import { respostaDaExplicacao } from './explicar/saida.js';
import type { ContextoDaLeitura } from './registro/leituras.js';
import { RetornoService } from './retorno.service.js';

// A IA no produto (A3, I4; protótipo P4 aprovado em 02/10/2026): o "Explicar" dos resultados e de um aviso
// da Atenção, e o retorno da pessoa. A explicação nunca falha por causa da IA: sem ela, vem a do sistema,
// no mesmo formato. Só para quem vê as vendas (`vendas.ver`), como a tela Resultados.

const ESPERA_O_MODELO = 'espera um modelo de IA por segundos: a leitura e o registro do uso abrem transações curtas';
const NAO_MUDA_DADO = 'pedir uma explicação não muda dado da empresa; cada chamada à IA fica em ai_usage';

function quem(auth: AuthContext): ContextoDaLeitura {
  if (!auth.tenantId) throw new AppProblem(403, 'sem-empresa', 'Sem empresa ativa', 'Escolha uma empresa para continuar.');
  return { tenantId: auth.tenantId, userId: auth.userId, permissions: auth.permissions };
}

@ApiTags('ia')
@ApiCookieAuth('liame_sessao')
@Controller('ai')
export class AiController {
  constructor(
    private readonly explicar: ExplicarService,
    private readonly retorno: RetornoService,
  ) {}

  @Get('status')
  @Permissao('vendas.ver')
  @ApiOperation({
    summary: 'A LIA está ligada?',
    description:
      'Diz se a LIA responde para a empresa (e a marca): a função de IA está ligada e o Analista, ativo. Com `false`, as explicações são montadas pelo sistema, por regra, com os mesmos números. Não chama modelo nenhum.',
  })
  @ApiOkResponse({ standardSchema: AiStatusResponse })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  async status(@Auth() auth: AuthContext, @Query({ schema: AiStatusQuery }) query: AiStatusQuery): Promise<AiStatusResponse> {
    return { lia: await this.explicar.liaLigada(quem(auth), query.brand_id ?? null) };
  }

  @Post('explain/results')
  @HttpCode(200)
  @Permissao('vendas.ver')
  @SemTransacao(ESPERA_O_MODELO)
  @SemAuditoria(NAO_MUDA_DADO)
  @ApiOperation({
    summary: 'Explicar os resultados do período',
    description:
      'A explicação dos resultados do ciclo fechado no período (os mesmos números de `GET /v1/results/closed-loop`), comparados com o período anterior de mesmo tamanho: o que aconteceu, os motivos com números, o risco e o que fazer. O código monta os números e diz de onde vem cada um (`numbers`); a LIA só escreve, e a resposta dela só aparece se todo número citado estiver no que o código entregou. Sem IA (desligada, fora do ar, no limite, com dado velho ou recusada na conferência), vem a explicação do sistema, com `source` `sistema` e o motivo em `reason`.',
  })
  @ApiOkResponse({ standardSchema: ExplanationResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  @ApiUnprocessableEntityResponse({ standardSchema: ProblemDetails })
  async explainResults(@Auth() auth: AuthContext, @Body({ schema: ExplainResultsRequest }) body: ExplainResultsRequest): Promise<ExplanationResponse> {
    return respostaDaExplicacao(await this.explicar.dosResultados(quem(auth), body));
  }

  @Post('explain/attention')
  @HttpCode(200)
  @Permissao('vendas.ver')
  @SemTransacao(ESPERA_O_MODELO)
  @SemAuditoria(NAO_MUDA_DADO)
  @ApiOperation({
    summary: 'Explicar um aviso da Atenção',
    description:
      'A explicação de um aviso da Atenção, identificado pelo que a tela recebeu (`brand_id`, `kind`, `connected_account_id`, `campaign_id`, `provider`), com os resultados dos últimos 7 dias completos da marca. Vale para os avisos de campanha, de medição e para o que saiu do normal; os de conexão, de leitura atrasada e de configuração voltam 422. Volta 404 se o aviso não está mais ativo. O formato e as regras são os de `POST /v1/ai/explain/results`.',
  })
  @ApiOkResponse({ standardSchema: ExplanationResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  @ApiUnprocessableEntityResponse({ standardSchema: ProblemDetails })
  async explainAttention(@Auth() auth: AuthContext, @Body({ schema: ExplainAttentionRequest }) body: ExplainAttentionRequest): Promise<ExplanationResponse> {
    return respostaDaExplicacao(await this.explicar.doAviso(quem(auth), body));
  }

  @Post('feedback')
  @HttpCode(200)
  @Permissao('vendas.ver')
  @SemAuditoria('opinião da pessoa sobre uma explicação: fica na própria linha, com quem avaliou e quando')
  @ApiOperation({
    summary: 'Dizer se a explicação fez sentido',
    description:
      'O retorno da pessoa sobre uma explicação da LIA que ela pediu (`usage_id` da resposta): `fez_sentido` ou `discordo`, este com pelo menos um motivo ou um comentário. Fica guardado no Liame, ligado à explicação, e não é enviado ao fornecedor do modelo; dado pessoal reconhecido no comentário é removido antes de gravar. Mandar de novo regrava o retorno da mesma pessoa.',
  })
  @ApiOkResponse({ standardSchema: AiFeedbackResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  @ApiUnprocessableEntityResponse({ standardSchema: ProblemDetails })
  feedback(@Auth() auth: AuthContext, @Body({ schema: AiFeedbackRequest }) body: AiFeedbackRequest): Promise<AiFeedbackResponse> {
    return this.retorno.gravar(auth, body);
  }
}
