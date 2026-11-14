import { CreateCreativeTestRequest, CreativeTestResponse, ProblemDetails, ResourceId } from '@liame/contracts';
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
import { TestesDeCriativoService } from './testes-de-criativo.service.js';

// O teste de criativo (plano da região, R8; protótipo dos testes aprovado pelo dono em 13/11/2026; D-RG-76 a D-RG-80).
// A rota grava o pedido, que espera o código do app em Aprovações; a leitura diz em que pé o teste está. Só com a função
// `teste_de_criativo` ligada para a empresa.

@ApiTags('testes-de-criativo')
@ApiCookieAuth('liame_sessao')
@Controller('creative-tests')
export class TestesDeCriativoController {
  constructor(private readonly testes: TestesDeCriativoService) {}

  @Post()
  @HttpCode(201)
  @Permissao('campanhas.operar')
  @Auditar('teste_de_criativo.pedir', { recurso: 'campaign_test' })
  @ApiOperation({
    summary: 'Pedir um teste de criativo na Meta, criado pausado',
    description:
      'Duas peças aprovadas em Criativos, cada uma com uma foto ou um vídeo pronto de Fotos, viram um pedido em Aprovações (a ferramenta `teste_de_criativo_criar`): uma campanha de teste com dois conjuntos iguais (o mesmo público, a metade da verba do teste para cada um) e um anúncio em cada um, tudo pausado. Cada criativo tem o seu cupom, com o mesmo desconto: o código vai no fim do texto do anúncio, e o Liame cria os dois cupons no Regem depois da aprovação. A rota confere as peças, as mídias, a conta de anúncios e a Página, a loja com o ponto no endereço e o cardápio dela, a verba (a metade exata em centavos, dentro do teto por campanha), os cupons (a loja liberou criar cupom e os códigos estão livres) e o texto de cada anúncio com a linha do cupom, que passa de novo pelas regras de texto e não é cortado. Um teste por marca por vez. Não é o teste dividido da Meta: os dois conjuntos têm o mesmo público, e a mesma pessoa pode ver os dois anúncios; o cupom e o link separam o pedido, não a exposição (D-RG-92). Só com a função `teste_de_criativo` ligada.',
  })
  @ApiCreatedResponse({ standardSchema: CreativeTestResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  @ApiConflictResponse({ standardSchema: ProblemDetails })
  @ApiUnprocessableEntityResponse({ standardSchema: ProblemDetails })
  criar(@Auth() auth: AuthContext, @Body({ schema: CreateCreativeTestRequest }) body: CreateCreativeTestRequest): Promise<CreativeTestResponse> {
    return this.testes.criar(auth, body);
  }

  @Post(':id/activate')
  @HttpCode(201)
  @Permissao('campanhas.operar')
  @Auditar('teste_de_criativo.ativar', { recurso: 'campaign_test' })
  @ApiOperation({
    summary: 'Pedir para ativar a campanha de teste',
    description:
      'O teste pronto (a campanha de teste criada e pausada na Meta, e os dois cupons criados no Regem) passa a rodar: um pedido em Aprovações (a ferramenta `teste_de_criativo_ativar`) que espera o código do app e, por ser verba nova, pede os limites da empresa e cabe na verba do mês, com a verba do teste inteiro. O primeiro dia do teste é o dia seguinte ao da ativação, no fuso da loja. Recusado quando o teste não está pronto, quando já existe um pedido de ativar esperando, ou quando os cupons venceriam antes do fim do teste.',
  })
  @ApiCreatedResponse({ standardSchema: CreativeTestResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  @ApiConflictResponse({ standardSchema: ProblemDetails })
  @ApiUnprocessableEntityResponse({ standardSchema: ProblemDetails })
  ativar(@Auth() auth: AuthContext, @Param('id', { schema: ResourceId }) id: string): Promise<CreativeTestResponse> {
    return this.testes.ativar(auth, id);
  }

  @Post(':id/stop')
  @HttpCode(201)
  @Permissao('campanhas.operar')
  @Auditar('teste_de_criativo.encerrar', { recurso: 'campaign_test' })
  @ApiOperation({
    summary: 'Encerrar o teste',
    description:
      'Encerra o teste antes da hora: o Liame para de medir. Com a campanha de teste no ar, ela é pausada na Meta (a ferramenta `teste_de_criativo_pausar`): para de gastar, e por isso não pede o código do app. Com o teste pronto e ainda não ativado, só o teste é marcado como encerrado, e nada muda na Meta. Os dois cupons continuam valendo até a validade deles. O teste já encerrado ou cancelado devolve como está.',
  })
  @ApiCreatedResponse({ standardSchema: CreativeTestResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  @ApiConflictResponse({ standardSchema: ProblemDetails })
  @ApiUnprocessableEntityResponse({ standardSchema: ProblemDetails })
  encerrar(@Auth() auth: AuthContext, @Param('id', { schema: ResourceId }) id: string): Promise<CreativeTestResponse> {
    return this.testes.encerrar(auth, id);
  }

  @Get(':id')
  @Permissao('campanhas.ver')
  @ApiOperation({
    summary: 'Ler um teste de criativo',
    description:
      'O teste com os dois criativos (a peça, a mídia, o texto que sai no anúncio e o cupom de cada um, com a situação dele), o desconto e até quando os cupons valem, quem vê, a verba, os dias, a situação e o que já existe na Meta.',
  })
  @ApiOkResponse({ standardSchema: CreativeTestResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  obter(@Auth() auth: AuthContext, @Param('id', { schema: ResourceId }) id: string): Promise<CreativeTestResponse> {
    return this.testes.obter(auth, id);
  }
}
