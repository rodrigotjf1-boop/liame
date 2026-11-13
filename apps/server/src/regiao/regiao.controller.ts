import {
  AddressLookupRequest,
  AddressLookupResponse,
  CreateStoreRequest,
  GoogleProfileAddressRequest,
  GoogleProfileAddressResponse,
  ProblemDetails,
  RegionOverviewQuery,
  RegionOverviewResponse,
  RegionRhythmQuery,
  RegionRhythmResponse,
  RegionRhythmStopResponse,
  ResourceId,
  SaveStoreLocationRequest,
  SaveStoreLocationResponse,
  StoreLocationsQuery,
  StoreLocationsResponse,
} from '@liame/contracts';
import { Body, Controller, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { Auditar, SemAuditoria } from '../audit/auditar.js';
import { Auth, Permissao } from '../auth/access.js';
import type { AuthContext } from '../context/request-context.js';
import { SemTransacao } from '../context/sem-transacao.js';
import { RegiaoService } from './regiao.service.js';

// A loja no mapa (plano da região, R1; aprovado em 11/11/2026): onde cada loja fica, o raio e as áreas de entrega. A
// tela é a de Minha marca › Região (protótipo P40). A função `regiao` nasce desligada; o endereço da loja nunca vai
// para o modelo de IA (D-A3-4, D-RG-2).

@ApiTags('regiao')
@ApiCookieAuth('liame_sessao')
@Controller()
export class RegiaoController {
  constructor(private readonly regiao: RegiaoService) {}

  @Get('region/stores')
  @Permissao('dossie.ver')
  @ApiOperation({
    summary: 'As lojas no mapa',
    description:
      'As lojas da marca com o endereço (CEP, rua, número, bairro, município, UF e o código IBGE do município), a coordenada com a precisão dela (`endereco`, `bairro` ou `cidade`, do OpenStreetMap), de onde o endereço veio (`perfil_google` ou `cep`), o raio e as áreas de entrega, quem salvou e quando; os Perfis da Empresa no Google ligados à marca; e se a pessoa pode salvar (o Dono e o Administrador). Com a função `regiao` desligada, `availability.status` é `desligado_pela_liame` e as listas vêm vazias.',
  })
  @ApiOkResponse({ standardSchema: StoreLocationsResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  lojas(@Auth() auth: AuthContext, @Query({ schema: StoreLocationsQuery }) query: StoreLocationsQuery): Promise<StoreLocationsResponse> {
    return this.regiao.lojas(auth, query.brand_id);
  }

  @Get('region/overview')
  @Permissao('dossie.ver')
  @ApiOperation({
    summary: 'Sua região',
    description:
      'O retrato da região de uma loja, calculado pelo sistema com as fontes públicas, sem IA: o bairro da loja no Censo 2022 (pessoas, área, densidade e a renda do responsável pelo domicílio, mediana e média, em reais de 2022, com a posição entre os bairros do município), a gente das áreas de entrega e os números do município (população, estimativa, renda per capita e restaurantes da CNAE 56.11-2), cada um com a fonte e o período, e a situação de cada fonte (`em_dia`, `lendo`, `falhou`). Sem endereço, `status` é `sem_endereco`; com a função `regiao` desligada, `availability.status` é `desligado_pela_liame`.',
  })
  @ApiOkResponse({ standardSchema: RegionOverviewResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  raioX(@Auth() auth: AuthContext, @Query({ schema: RegionOverviewQuery }) query: RegionOverviewQuery): Promise<RegionOverviewResponse> {
    return this.regiao.raioX(auth, query.brand_id, query.unit_id);
  }

  @Get('region/rhythm')
  @Permissao('campanhas.ver')
  @ApiOperation({
    summary: 'O ritmo da semana, em prévia',
    description:
      'O ritmo da semana que vem (de segunda a domingo), como o Gestor de tráfego o montaria, por regra e sem IA (plano da região, R7; D-RG-58 a D-RG-60). Só leitura: nada é pedido nem executado. O peso de cada dia vem dos pedidos da loja por dia da semana nas 4 semanas de Sua região (sem pedidos que bastem, a referência do setor: mais peso de sexta a domingo), mais um acréscimo pequeno pela chuva prevista e pelas datas (o feriado nacional, a data do varejo e as vésperas delas; o prazo do salário no dia). Os limites: cada dia entre 20% abaixo e 20% acima da verba de hoje, até 10% de mudança de um dia para o outro (a política da Liame), nenhum dia acima do teto por campanha, e a semana sem gastar mais do que gastaria sem o ritmo. Entram as campanhas ativas da Meta com verba diária própria (na campanha, ou no conjunto quando a campanha não tem), em centavos inteiros; a que não cabe nas regras vem em `out`, com o porquê. `status`: `pronto`, `desligado` (a função da região), `sem_endereco` (a loja fora do mapa), `sem_permissao` (quem pergunta não vê Resultados, `vendas.ver`) ou `sem_campanhas`. Marca ou loja de outra empresa, 404.',
  })
  @ApiOkResponse({ standardSchema: RegionRhythmResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  ritmoDaSemana(@Auth() auth: AuthContext, @Query({ schema: RegionRhythmQuery }) query: RegionRhythmQuery): Promise<RegionRhythmResponse> {
    return this.regiao.ritmoDaSemana(auth, query.brand_id, query.unit_id);
  }

  @Post('region/rhythm/:id/stop')
  @HttpCode(200)
  @Permissao('campanhas.operar')
  @Auditar('ritmo.parar', { recurso: 'budget_rhythm' })
  @ApiOperation({
    summary: 'Parar o ritmo da semana',
    description:
      'Para o ritmo da semana que uma pessoa aprovou (plano da região, R7; D-RG-63). Não pede o código do aplicativo autenticador. O passo que estiver na fila não sai, e a verba de cada campanha volta à de antes pelos passos seguintes, em até 10% por dia. O ritmo que ainda espera a aprovação se recusa em Aprovações (409).',
  })
  @ApiOkResponse({ standardSchema: RegionRhythmStopResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  @ApiConflictResponse({ standardSchema: ProblemDetails })
  pararRitmo(@Auth() auth: AuthContext, @Param('id', { schema: ResourceId }) id: string): Promise<RegionRhythmStopResponse> {
    return this.regiao.pararRitmo(auth, id);
  }

  @Post('region/address-lookup')
  @HttpCode(200)
  @Permissao('dossie.editar')
  @SemAuditoria('só confere o endereço no ViaCEP e no OpenStreetMap: não grava nada')
  @SemTransacao('chama o ViaCEP e o OpenStreetMap (até uma consulta por segundo): o banco numa transação curta e os serviços depois, sem transação aberta')
  @ApiOperation({
    summary: 'Conferir um endereço pelo CEP',
    description:
      'Completa o endereço pelo CEP (ViaCEP: rua, bairro, município, UF e o código IBGE do município) e procura a coordenada no OpenStreetMap, do endereço para o bairro e a cidade, só valendo a que cai no município do CEP. Não grava nada: a pessoa confere e salva. CEP fora do formato ou que não existe volta 422; o ViaCEP fora do ar, 503. O OpenStreetMap que não acha ou não responde volta `coordinates_status` `nao_achada`, e o endereço vale do mesmo jeito.',
  })
  @ApiOkResponse({ standardSchema: AddressLookupResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  @ApiConflictResponse({ standardSchema: ProblemDetails })
  @ApiUnprocessableEntityResponse({ standardSchema: ProblemDetails })
  @ApiServiceUnavailableResponse({ standardSchema: ProblemDetails })
  conferirEndereco(@Auth() auth: AuthContext, @Body({ schema: AddressLookupRequest }) body: AddressLookupRequest): Promise<AddressLookupResponse> {
    return this.regiao.conferirEndereco(auth, body);
  }

  @Post('region/google-profile-address')
  @HttpCode(200)
  @Permissao('dossie.editar')
  @SemAuditoria('só lê o endereço no Perfil do Google, no ViaCEP e no OpenStreetMap: não grava nada')
  @SemTransacao('lê do Google na hora, por até 8 segundos, e confere no ViaCEP e no OpenStreetMap: o banco numa transação curta e os serviços depois, sem transação aberta')
  @ApiOperation({
    summary: 'Usar o endereço do Perfil do Google',
    description:
      'Lê agora o endereço e as áreas de entrega (até 20) de um Perfil da Empresa no Google ligado à marca, confere o CEP dele no ViaCEP e procura a coordenada (a do Google, quando ele a dá; senão, a do OpenStreetMap). Não grava nada e não muda nada no Google: a pessoa confere e salva. Perfil sem endereço (só atende na casa do cliente) volta `address` nulo, com as áreas. O Google fora do ar volta 503; sem acesso ao perfil, 409.',
  })
  @ApiOkResponse({ standardSchema: GoogleProfileAddressResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  @ApiConflictResponse({ standardSchema: ProblemDetails })
  @ApiServiceUnavailableResponse({ standardSchema: ProblemDetails })
  enderecoDoPerfil(@Auth() auth: AuthContext, @Body({ schema: GoogleProfileAddressRequest }) body: GoogleProfileAddressRequest): Promise<GoogleProfileAddressResponse> {
    return this.regiao.enderecoDoPerfil(auth, body);
  }

  @Put('units/:id/location')
  @Permissao('dossie.editar')
  @Auditar('loja.localizacao', { recurso: 'unit' })
  @ApiOperation({
    summary: 'Salvar onde a loja fica',
    description:
      'Salva o endereço da loja (o que a conferência pelo CEP ou pelo Perfil do Google devolveu, com a rua e o número que a pessoa completou), a coordenada, de onde o endereço veio, o raio de entrega (de 1 a 15 km, de meio em meio) e as áreas de entrega (até 20). Dado da empresa: nunca vai para o modelo de IA. Fica na auditoria, com o antes e o depois.',
  })
  @ApiOkResponse({ standardSchema: SaveStoreLocationResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  @ApiConflictResponse({ standardSchema: ProblemDetails })
  @ApiUnprocessableEntityResponse({ standardSchema: ProblemDetails })
  salvar(@Auth() auth: AuthContext, @Param('id', { schema: ResourceId }) id: string, @Body({ schema: SaveStoreLocationRequest }) body: SaveStoreLocationRequest): Promise<SaveStoreLocationResponse> {
    return this.regiao.salvar(auth, id, body);
  }

  @Post('region/stores')
  @Permissao('dossie.editar')
  @Auditar('loja.criar', { recurso: 'unit' })
  @ApiOperation({
    summary: 'Criar a loja e pôr no mapa',
    description:
      'Para a marca sem o Regem (D-RG-17): cria a loja com o nome escolhido (o do Perfil do Google ou "Loja" e o bairro) e já salva onde ela fica, como em `PUT /v1/units/{id}/location`. O Regem conectado depois se liga à loja de mesmo nome. A marca com o Regem conectado volta 409 (as lojas vêm dele); o nome que a marca já tem, 409; acima de 50 lojas, 409. Fica na auditoria.',
  })
  @ApiCreatedResponse({ standardSchema: SaveStoreLocationResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  @ApiConflictResponse({ standardSchema: ProblemDetails })
  criar(@Auth() auth: AuthContext, @Body({ schema: CreateStoreRequest }) body: CreateStoreRequest): Promise<SaveStoreLocationResponse> {
    return this.regiao.criar(auth, body);
  }
}
