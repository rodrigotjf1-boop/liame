import {
  BrandDossierQuery,
  BrandDossierResponse,
  BrandDossierSuggestionListResponse,
  BrandDossierVersionListResponse,
  BrandDossierVersionResponse,
  CheckBrandPhraseRequest,
  CheckBrandPhraseResponse,
  DossierVersionNumber,
  ProblemDetails,
  ResourceId,
  RestoreBrandDossierRequest,
  SaveBrandDossierRequest,
  UseBrandDossierSuggestionRequest,
} from '@liame/contracts';
import { Body, Controller, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { Auditar, SemAuditoria } from '../audit/auditar.js';
import { Auth, Permissao } from '../auth/access.js';
import type { AuthContext } from '../context/request-context.js';
import { MarcaService } from './marca.service.js';

// Minha marca (A3, I8; protótipo P6, aguardando aprovação; a tela espera a aprovação). O dossiê da marca que os
// funcionários de IA leem, as versões, o teste de frase e as sugestões do sistema. Ver: quem acompanha as
// campanhas (`dossie.ver`); salvar, voltar a uma versão e usar ou descartar sugestão: o dono e o administrador
// (`dossie.editar`). Nenhuma versão é alterada nem apagada.
@ApiTags('marca')
@ApiCookieAuth('liame_sessao')
@Controller('brand-dossier')
export class MarcaController {
  constructor(private readonly marca: MarcaService) {}

  @Get()
  @Permissao('dossie.ver')
  @ApiOperation({
    summary: 'O dossiê da marca',
    description:
      'A versão atual do dossiê (identidade, voz, produtos, ofertas, provas, o que não pode dizer, concorrentes, região e datas), as provas que o sistema calcula, a situação de cada parte, o texto que os funcionários de IA leem (em ordem fixa, com o hash) e se a pessoa pode editar. Sem versão salva, o conteúdo vem vazio. As sugestões do sistema são refeitas aqui, pelos números de hoje.',
  })
  @ApiOkResponse({ standardSchema: BrandDossierResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  get(@Auth() auth: AuthContext, @Query({ schema: BrandDossierQuery }) query: BrandDossierQuery): Promise<BrandDossierResponse> {
    return this.marca.dossie(auth, query.brand_id);
  }

  @Put()
  @Auditar('marca.dossie_salvar', { recurso: 'brand_dossier_version' })
  @Permissao('dossie.editar')
  @ApiOperation({
    summary: 'Salvar o dossiê da marca',
    description:
      'Salva o dossiê inteiro a partir da versão que a pessoa abriu (`base_version`; 0 quando estava vazio): nasce a versão seguinte, com o que mudou. Sem mudança, nada nasce. Se outra pessoa salvou depois, volta 409 e a pessoa junta as mudanças na versão nova (`merged`). Telefone, e-mail, documento ou CEP em qualquer campo: 400, com os campos.',
  })
  @ApiOkResponse({ standardSchema: BrandDossierResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  @ApiConflictResponse({ standardSchema: ProblemDetails })
  save(@Auth() auth: AuthContext, @Body({ schema: SaveBrandDossierRequest }) body: SaveBrandDossierRequest): Promise<BrandDossierResponse> {
    return this.marca.salvar(auth, body);
  }

  @Get('versions')
  @Permissao('dossie.ver')
  @ApiOperation({ summary: 'As versões do dossiê', description: 'Da mais nova à mais antiga (até 200): quem salvou, quando, como (pessoa, sugestão, volta a uma anterior ou mescla) e o que mudou.' })
  @ApiOkResponse({ standardSchema: BrandDossierVersionListResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  versions(@Query({ schema: BrandDossierQuery }) query: BrandDossierQuery): Promise<BrandDossierVersionListResponse> {
    return this.marca.versoes(query.brand_id);
  }

  @Get('versions/:version')
  @Permissao('dossie.ver')
  @ApiOperation({ summary: 'Uma versão do dossiê', description: 'O conteúdo de uma versão, como foi salva, para comparar ou voltar a ela.' })
  @ApiOkResponse({ standardSchema: BrandDossierVersionResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  version(@Param('version', { schema: DossierVersionNumber }) version: number, @Query({ schema: BrandDossierQuery }) query: BrandDossierQuery): Promise<BrandDossierVersionResponse> {
    return this.marca.versao(query.brand_id, version);
  }

  @Post('restore')
  @HttpCode(200)
  @Auditar('marca.dossie_voltar', { recurso: 'brand_dossier_version' })
  @Permissao('dossie.editar')
  @ApiOperation({
    summary: 'Voltar a uma versão anterior do dossiê',
    description: 'O conteúdo da versão escolhida vira a versão seguinte (nada é apagado). `base_version` é a versão atual que a pessoa via; se mudou, 409.',
  })
  @ApiOkResponse({ standardSchema: BrandDossierResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  @ApiConflictResponse({ standardSchema: ProblemDetails })
  @ApiUnprocessableEntityResponse({ standardSchema: ProblemDetails })
  restore(@Auth() auth: AuthContext, @Body({ schema: RestoreBrandDossierRequest }) body: RestoreBrandDossierRequest): Promise<BrandDossierResponse> {
    return this.marca.voltar(auth, body);
  }

  @Post('check')
  @HttpCode(200)
  @Permissao('dossie.ver')
  @SemAuditoria('testar uma frase não muda dado; nada fica guardado')
  @ApiOperation({
    summary: 'Testar uma frase nas regras',
    description:
      'Confere a frase nas regras da Liame (conteúdo político, promessa de resultado, categoria proibida, dado pessoal) e nas da marca ("o que não pode dizer"), sem IA. Com `forbidden`, vale a lista em edição; sem, a da versão atual.',
  })
  @ApiOkResponse({ standardSchema: CheckBrandPhraseResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  check(@Body({ schema: CheckBrandPhraseRequest }) body: CheckBrandPhraseRequest): Promise<CheckBrandPhraseResponse> {
    return this.marca.conferirFrase(body);
  }

  @Get('suggestions')
  @Permissao('dossie.ver')
  @ApiOperation({
    summary: 'Sugestões esperando conferência',
    description:
      'As sugestões para o dossiê que esperam uma pessoa: as do sistema saem dos números (produtos mais vendidos no Regem que faltam, produto do dossiê sem pedido em 30 dias, cupons exclusivos ligados a campanhas), refeitas agora. O que foi recusado nos últimos 30 dias não volta.',
  })
  @ApiOkResponse({ standardSchema: BrandDossierSuggestionListResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  suggestions(@Query({ schema: BrandDossierQuery }) query: BrandDossierQuery): Promise<BrandDossierSuggestionListResponse> {
    return this.marca.sugestoes(query.brand_id);
  }

  @Post('suggestions/:id/use')
  @HttpCode(200)
  @Auditar('marca.sugestao_usar', { recurso: 'brand_dossier_suggestion' })
  @Permissao('dossie.editar')
  @ApiOperation({
    summary: 'Usar os itens marcados de uma sugestão',
    description: 'Os itens escolhidos entram no dossiê e nasce a versão seguinte; os deixados desmarcados não voltam por 30 dias. `base_version` é a versão que a pessoa via; se mudou, 409.',
  })
  @ApiOkResponse({ standardSchema: BrandDossierResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  @ApiConflictResponse({ standardSchema: ProblemDetails })
  @ApiUnprocessableEntityResponse({ standardSchema: ProblemDetails })
  use(
    @Auth() auth: AuthContext,
    @Param('id', { schema: ResourceId }) id: string,
    @Body({ schema: UseBrandDossierSuggestionRequest }) body: UseBrandDossierSuggestionRequest,
  ): Promise<BrandDossierResponse> {
    return this.marca.usarSugestao(auth, id, body);
  }

  @Post('suggestions/:id/discard')
  @HttpCode(204)
  @Auditar('marca.sugestao_descartar', { recurso: 'brand_dossier_suggestion' })
  @Permissao('dossie.editar')
  @ApiOperation({ summary: 'Descartar uma sugestão', description: 'A sugestão sai da lista e os itens dela não voltam por 30 dias.' })
  @ApiNoContentResponse({ description: 'Sugestão descartada' })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  @ApiConflictResponse({ standardSchema: ProblemDetails })
  async discard(@Auth() auth: AuthContext, @Param('id', { schema: ResourceId }) id: string): Promise<void> {
    await this.marca.descartarSugestao(auth, id);
  }
}
