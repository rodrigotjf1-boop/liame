import {
  BillingContactsResponse,
  BillingPixResponse,
  BillingPlansResponse,
  BillingQuery,
  BillingResponse,
  CancelSubscriptionRequest,
  ChangePlanRequest,
  KeepSubscriptionRequest,
  ProblemDetails,
  ResourceId,
  SubscribeRequest,
  WithdrawSubscriptionRequest,
} from '@liame/contracts';
import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import {
  ApiBadGatewayResponse,
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Auditar } from '../audit/auditar.js';
import { AbertaNaSuspensao, Auth, DuranteSuspensao, Permissao } from '../auth/access.js';
import type { AuthContext } from '../context/request-context.js';
import { SemTransacao } from '../context/sem-transacao.js';
import { ACAO_ASSINAR, ACAO_CANCELAR, ACAO_DESISTIR, ACAO_MANTER, ACAO_TROCAR_PLANO, CobrancaService, RECURSO } from './cobranca.service.js';

// Plano e cobrança (A7, W1 e W2a; protótipo P26, aprovado em 22/10/2026): os planos, a assinatura de cada marca, as
// faturas e o PIX de cada uma, pelo Asaas. Nenhum dado de cartão passa por aqui (A7-1).

const PRECISA_DA_FUNCAO = 'Precisa da função `cobranca` ligada para a empresa (409 `funcao-desligada`).';
const CHAMA_O_MEIO_DE_PAGAMENTO =
  'lê a fatura e grava a referência da cobrança em transações curtas, com a empresa no contexto da RLS, e chama o Asaas (procurar e criar o cliente e a cobrança, ler o QR Code) sem transação aberta';
const PEDE_O_CODIGO =
  'Pede o código do app autenticador de quem pede (D-A7-14): errado, 401 `codigo-invalido`; sem o app autenticador ativo, 403 `segundo-fator-nao-configurado`; muitas tentativas, 429.';

@ApiTags('cobranca')
@ApiCookieAuth('liame_sessao')
// Com a marca suspensa no 30º dia de atraso, o Dono ainda paga, cancela e desiste por aqui (D-A7-40); o serviço decide
// se cada pedido vale na situação da assinatura.
@DuranteSuspensao()
@Controller('billing')
export class CobrancaController {
  constructor(private readonly cobranca: CobrancaService) {}

  @Get('plans')
  @Permissao('cobranca.ver')
  @ApiOperation({
    summary: 'Os planos para assinar',
    description: `Os planos que uma assinatura nova recebe (a versão oferecida de cada um), com o preço por mês e os funcionários de IA incluídos, na ordem da tela. Com a função \`cobranca\` desligada para a empresa, \`enabled\` é \`false\` e a lista vem vazia.`,
  })
  @ApiOkResponse({ standardSchema: BillingPlansResponse })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  planos(@Auth() auth: AuthContext): Promise<BillingPlansResponse> {
    return this.cobranca.planos(auth);
  }

  @Get('contacts')
  @Permissao('empresa.ver')
  @AbertaNaSuspensao()
  @ApiOperation({
    summary: 'Quem cuida da cobrança e a situação dela',
    description:
      'Para todos da empresa, também com a conta suspensa (D-A7-41, D-A7-42): o Dono e quem tem a cobrança liberada (o Dono primeiro, até 20), para a tela de quem não vê a cobrança ("Fale com um deles"); as marcas com a conta suspensa no 30º dia de atraso, com o dia em que a suspensão começou ("Quem resolve"), e se todas as marcas vivas estão suspensas; e as marcas em atraso para a faixa no alto das telas (D-A7-15): quem paga (`cobranca.pagar`) vê desde o 1º dia, com o valor e a fatura; o resto da equipe, só a partir do 10º dia, sem os dois. Com a função `cobranca` desligada, `enabled` é `false`, as listas vêm vazias e `all_suspended` é `false`.',
  })
  @ApiOkResponse({ standardSchema: BillingContactsResponse })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  contatos(@Auth() auth: AuthContext): Promise<BillingContactsResponse> {
    return this.cobranca.contatos(auth);
  }

  @Get()
  @Permissao('cobranca.ver')
  @ApiOperation({
    summary: 'A cobrança da marca',
    description:
      'A assinatura viva da marca (ou, sem ela, a última que terminou) e as faturas, a mais nova primeiro (até 36), com o dia de hoje no fuso da empresa. A situação segue os dias de atraso da mensalidade mais antiga em aberto: do 1º ao 9º dia, `em_atraso`; do 10º ao 29º, `acoes_paradas`; do 30º em diante, `suspensa` (Termos 10.4). Com a função `cobranca` desligada, `enabled` é `false`, e a assinatura e as faturas vêm vazias.',
  })
  @ApiOkResponse({ standardSchema: BillingResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  daMarca(@Auth() auth: AuthContext, @Query({ schema: BillingQuery }) query: BillingQuery): Promise<BillingResponse> {
    return this.cobranca.daMarca(auth, query.brand_id);
  }

  @Get('invoices/:id/pix')
  @Permissao('cobranca.pagar')
  @SemTransacao(CHAMA_O_MEIO_DE_PAGAMENTO)
  @ApiOperation({
    summary: 'O PIX de uma fatura',
    description: `O QR Code da cobrança da fatura no Asaas (a imagem em PNG e o copia e cola), criada na hora se ainda não existe, com o valor e o vencimento da fatura. A cobrança é uma por fatura (D-A7-30): pedir de novo devolve a mesma. Só a fatura em aberto de uma assinatura no PIX (409 \`fatura-nao-esta-em-aberto\` e \`fatura-nao-e-pix\`); a de outra empresa, 404 \`fatura-nao-encontrada\`. Sem o CNPJ da empresa, 409 \`cnpj-necessario\`. Enquanto outro caminho gera a mesma cobrança, 409 \`cobranca-em-criacao\`, com \`retry-after\`. O Asaas fora do ar, 502 \`meio-de-pagamento-fora-do-ar\`; recusando a cobrança, 502 \`meio-de-pagamento-recusou\`; pedindo pausa, 503 \`meio-de-pagamento-ocupado\`, com \`retry-after\`; sem o Asaas configurado, 503 \`pagamento-indisponivel\`. ${PRECISA_DA_FUNCAO}`,
  })
  @ApiOkResponse({ standardSchema: BillingPixResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  @ApiConflictResponse({ standardSchema: ProblemDetails })
  @ApiBadGatewayResponse({ standardSchema: ProblemDetails })
  @ApiServiceUnavailableResponse({ standardSchema: ProblemDetails })
  pix(@Auth() auth: AuthContext, @Param('id', { schema: ResourceId }) id: string): Promise<BillingPixResponse> {
    return this.cobranca.pix(auth, id);
  }

  @Post('subscription')
  @HttpCode(200)
  @Permissao('cobranca.gerenciar')
  @Auditar(ACAO_ASSINAR, { recurso: RECURSO })
  @ApiOperation({
    summary: 'Assinar um plano',
    description: `A assinatura nasce esperando o primeiro pagamento, com a primeira mensalidade vencendo hoje; sem o pagamento em 7 dias, ela termina sozinha. O mesmo pedido de novo não contrata duas vezes; outro plano ou outra forma, antes do primeiro pagamento, substitui o pedido. A marca com assinatura em andamento, 409 \`assinatura-existe\`; plano fora dos oferecidos, 400. ${PRECISA_DA_FUNCAO}`,
  })
  @ApiOkResponse({ standardSchema: BillingResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  @ApiConflictResponse({ standardSchema: ProblemDetails })
  assinar(@Auth() auth: AuthContext, @Body({ schema: SubscribeRequest }) body: SubscribeRequest): Promise<BillingResponse> {
    return this.cobranca.assinar(auth, body);
  }

  @Post('subscription/plan')
  @HttpCode(200)
  @Permissao('cobranca.gerenciar')
  @Auditar(ACAO_TROCAR_PLANO, { recurso: RECURSO })
  @ApiOperation({
    summary: 'Trocar de plano',
    description: `Subir vale quando a diferença dos dias que faltam no período é paga (a fatura da diferença vence hoje); descer vale no período seguinte; escolher de novo o plano em vigor desfaz a troca marcada. Só na assinatura em dia: antes do primeiro pagamento, 409 \`assinatura-sem-pagamento\`; com mensalidade em aberto, 409 \`assinatura-em-atraso\`; cancelada, 409 \`assinatura-cancelada\`; sem assinatura, 404 \`sem-assinatura\`. ${PEDE_O_CODIGO} ${PRECISA_DA_FUNCAO}`,
  })
  @ApiOkResponse({ standardSchema: BillingResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiUnauthorizedResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  @ApiConflictResponse({ standardSchema: ProblemDetails })
  @ApiTooManyRequestsResponse({ standardSchema: ProblemDetails })
  trocarPlano(@Auth() auth: AuthContext, @Body({ schema: ChangePlanRequest }) body: ChangePlanRequest): Promise<BillingResponse> {
    return this.cobranca.trocarPlano(auth, body);
  }

  @Post('subscription/cancel')
  @HttpCode(200)
  @Permissao('cobranca.gerenciar')
  @Auditar(ACAO_CANCELAR, { recurso: RECURSO })
  @ApiOperation({
    summary: 'Cancelar a assinatura',
    description: `Vale no fim do período pago, sem multa (Termos 11.1): até lá, tudo funciona, e a fatura do período seguinte não é cobrada. Se o período em vigor não foi pago, termina agora, e o que está em aberto não é cobrado; a que espera o primeiro pagamento também termina agora. Sem assinatura, 404 \`sem-assinatura\`. ${PEDE_O_CODIGO} ${PRECISA_DA_FUNCAO}`,
  })
  @ApiOkResponse({ standardSchema: BillingResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiUnauthorizedResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  @ApiConflictResponse({ standardSchema: ProblemDetails })
  @ApiTooManyRequestsResponse({ standardSchema: ProblemDetails })
  cancelar(@Auth() auth: AuthContext, @Body({ schema: CancelSubscriptionRequest }) body: CancelSubscriptionRequest): Promise<BillingResponse> {
    return this.cobranca.cancelar(auth, body);
  }

  @Post('subscription/keep')
  @HttpCode(200)
  @Permissao('cobranca.gerenciar')
  @Auditar(ACAO_MANTER, { recurso: RECURSO })
  @ApiOperation({
    summary: 'Manter a assinatura cancelada',
    description: `Desfaz o cancelamento antes do fim do período: a assinatura segue como estava. A que não está cancelada fica como está. Sem assinatura, 404 \`sem-assinatura\`. ${PRECISA_DA_FUNCAO}`,
  })
  @ApiOkResponse({ standardSchema: BillingResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  @ApiConflictResponse({ standardSchema: ProblemDetails })
  manter(@Auth() auth: AuthContext, @Body({ schema: KeepSubscriptionRequest }) body: KeepSubscriptionRequest): Promise<BillingResponse> {
    return this.cobranca.manter(auth, body);
  }

  @Post('subscription/withdraw')
  @HttpCode(200)
  @Permissao('cobranca.gerenciar')
  @Auditar(ACAO_DESISTIR, { recurso: RECURSO })
  @ApiOperation({
    summary: 'Desistir em 7 dias, com a devolução integral',
    description: `Só na primeira contratação da empresa, até o 7º dia depois do primeiro pagamento (Termos 11.1): a assinatura termina agora, e o que foi pago fica com a devolução pedida ao meio de pagamento. Fora do prazo, 409 \`fora-do-prazo-de-desistencia\`; sem assinatura, 404 \`sem-assinatura\`. ${PEDE_O_CODIGO} ${PRECISA_DA_FUNCAO}`,
  })
  @ApiOkResponse({ standardSchema: BillingResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiUnauthorizedResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  @ApiConflictResponse({ standardSchema: ProblemDetails })
  @ApiTooManyRequestsResponse({ standardSchema: ProblemDetails })
  desistir(@Auth() auth: AuthContext, @Body({ schema: WithdrawSubscriptionRequest }) body: WithdrawSubscriptionRequest): Promise<BillingResponse> {
    return this.cobranca.desistir(auth, body);
  }
}
