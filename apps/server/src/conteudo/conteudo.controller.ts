import { ContentDatesQuery, ContentDatesResponse, ContentProductsQuery, ContentProductsResponse, ProblemDetails } from '@liame/contracts';
import { Controller, Get, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse,
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
import { ConteudoService } from './conteudo.service.js';

// O plano de conteúdo (`docs/plano-conteudo.md`, aprovado pelo dono em 28/11/2026). A PC4 não tem tela nova: as rotas
// alimentam o plano do Estrategista (PC5) e as telas dos protótipos P47 e P48. A função `plano_conteudo` nasce desligada.

@ApiTags('conteudo')
@ApiCookieAuth('liame_sessao')
@Controller()
export class ConteudoController {
  constructor(private readonly conteudo: ConteudoService) {}

  @Get('content/products')
  @Permissao('dossie.ver')
  @ApiOperation({
    summary: 'Os produtos do cardápio para o conteúdo',
    description:
      'O ranking dos produtos do cardápio do Regem nas 4 semanas completas até ontem (no fuso da loja), contra as 4 semanas antes, agrupado pelo código do produto do Regem (cada canal escreve o mesmo produto de um jeito; o item sem código fica fora, só na contagem de `without_code`): os pedidos, a quantidade, a receita dos itens, a tendência, a margem (só com o custo do Regem, maior que zero, em todas as linhas), onde a marca já mostrou o produto (as legendas do Instagram; as fotos de Fotos só como informação) e os destaques (`vende_bem_nunca_apareceu`, `margem_boa_pouca_venda`, `subindo`). Só leitura. Com a função `plano_conteudo` desligada, sem o Regem ou sem `vendas.ver`, `availability.status` diz o motivo e `ranking` vem nulo.',
  })
  @ApiOkResponse({ standardSchema: ContentProductsResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  produtos(@Auth() auth: AuthContext, @Query({ schema: ContentProductsQuery }) query: ContentProductsQuery): Promise<ContentProductsResponse> {
    return this.conteudo.produtos(auth, query.brand_id, query.unit_id);
  }

  @Get('content/dates')
  @Permissao('dossie.ver')
  @SemTransacao('chama o Pulso (até 8 segundos por tentativa): a marca, a função, a loja, o calendário e os nomes do cardápio numa transação curta, e o Pulso depois, sem transação aberta; não grava nada')
  @ApiOperation({
    summary: 'As datas e as tendências do período',
    description:
      'As datas do período (até 62 dias; sem `from`, hoje no fuso da loja; sem `to`, 30 dias depois) para o plano de conteúdo: o calendário comercial do Liame (feriados nacionais e datas do varejo, cada uma com a lei ou a regra) e, com o Liame ligado ao Pulso (o produto da DMS que lê as fontes públicas brasileiras), os eventos do município da loja no mapa: feriados e pontos facultativos do estado e da cidade, os dias de comida (com `menu_match` quando o tema aparece no cardápio da marca), os jogos, as estreias e o dinheiro no bolso, sem repetir o que o Liame já tem; e os assuntos em alta no Brasil e no estado (só com manchete de portal brasileiro: título, endereço e fonte). O Pulso recebe só o código do município. `pulse_status`: `em_dia`, `desligado`, `sem_municipio` ou `falhou` (as datas do Liame valem do mesmo jeito). Com a função `plano_conteudo` desligada, `availability.status` é `desligado_pela_liame` e as listas vêm vazias.',
  })
  @ApiOkResponse({ standardSchema: ContentDatesResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  @ApiUnprocessableEntityResponse({ standardSchema: ProblemDetails })
  datas(@Auth() auth: AuthContext, @Query({ schema: ContentDatesQuery }) query: ContentDatesQuery): Promise<ContentDatesResponse> {
    return this.conteudo.datas(auth, query);
  }
}
