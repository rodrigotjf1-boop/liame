import { CreateRegionTestRequest, ProblemDetails, RegionTestResponse, ResourceId } from '@liame/contracts';
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
import { TestesDeRegiaoService } from './testes-de-regiao.service.js';

// O teste de região (plano da região, R8; protótipo dos testes aprovado pelo dono em 13/11/2026; D-RG-81 e D-RG-82). A
// rota confere a D-RG-82, grava o pedido, que espera o código do app em Aprovações, e a leitura diz em que pé o teste
// está. Só com a função `teste_de_regiao` ligada para a empresa.

@ApiTags('testes-de-regiao')
@ApiCookieAuth('liame_sessao')
@Controller('region-tests')
export class TestesDeRegiaoController {
  constructor(private readonly testes: TestesDeRegiaoService) {}

  @Post()
  @HttpCode(201)
  @Permissao('campanhas.operar')
  @Auditar('teste_de_regiao.pedir', { recurso: 'campaign_test' })
  @ApiOperation({
    summary: 'Pedir um teste de região: um bairro 14 dias sem anúncio',
    description:
      'Um bairro da área de entrega fica 14 dias sem anúncio nas campanhas que o Liame criou, e o caixa diz quanto o anúncio traz ali (a ferramenta `teste_de_regiao`, que espera o código do app em Aprovações; aprovar não muda nada na Meta). A rota recusa, com o motivo, o bairro com menos de 15 pedidos por semana nas 4 semanas ou com menos de 3 outros bairros para comparar, a marca sem os pedidos por bairro do Regem, outro teste vivo na marca, uma campanha criada fora do Liame mostrando anúncio no bairro, uma campanha do Liame que só anuncia nele e uma campanha do Google que o alcança.',
  })
  @ApiCreatedResponse({ standardSchema: RegionTestResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  @ApiConflictResponse({ standardSchema: ProblemDetails })
  @ApiUnprocessableEntityResponse({ standardSchema: ProblemDetails })
  criar(@Auth() auth: AuthContext, @Body({ schema: CreateRegionTestRequest }) body: CreateRegionTestRequest): Promise<RegionTestResponse> {
    return this.testes.criar(auth, body);
  }

  @Get(':id')
  @Permissao('campanhas.ver')
  @ApiOperation({
    summary: 'Ler um teste de região',
    description:
      'O teste com o bairro, os pedidos de entrega por bairro nas 4 semanas de antes (como a pessoa viu), os conjuntos das campanhas do Liame que o bairro deixa (com a situação de cada um), o pedido em Aprovações, os dias e, quando houver, o motivo da interrupção.',
  })
  @ApiOkResponse({ standardSchema: RegionTestResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  obter(@Auth() auth: AuthContext, @Param('id', { schema: ResourceId }) id: string): Promise<RegionTestResponse> {
    return this.testes.obter(auth, id);
  }
}
