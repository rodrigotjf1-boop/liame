import { ContentProductsQuery, ContentProductsResponse, ProblemDetails } from '@liame/contracts';
import { Controller, Get, Query } from '@nestjs/common';
import { ApiBadRequestResponse, ApiCookieAuth, ApiForbiddenResponse, ApiNotFoundResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Auth, Permissao } from '../auth/access.js';
import type { AuthContext } from '../context/request-context.js';
import { ConteudoService } from './conteudo.service.js';

// O plano de conteúdo (`docs/plano-conteudo.md`, aprovado pelo dono em 28/11/2026). A PC4 não tem tela nova: a rota
// alimenta o plano do Estrategista (PC5) e as telas dos protótipos P47 e P48. A função `plano_conteudo` nasce desligada.

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
      'O ranking dos produtos do cardápio do Regem nas 4 semanas completas até ontem (no fuso da loja), contra as 4 semanas antes, agrupado pelo código do produto do Regem (cada canal escreve o mesmo produto de um jeito; o item sem código entra pelo nome quando o nome só aparece com um código): os pedidos, a quantidade, a receita dos itens, a tendência, a margem (só com o custo do Regem em todas as linhas), onde a marca já mostrou o produto (as legendas do Instagram e Fotos) e os destaques (`vende_bem_nunca_apareceu`, `margem_boa_pouca_venda`, `subindo`). Só leitura. Com a função `plano_conteudo` desligada, sem o Regem ou sem `vendas.ver`, `availability.status` diz o motivo e `ranking` vem nulo.',
  })
  @ApiOkResponse({ standardSchema: ContentProductsResponse })
  @ApiBadRequestResponse({ standardSchema: ProblemDetails })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  produtos(@Auth() auth: AuthContext, @Query({ schema: ContentProductsQuery }) query: ContentProductsQuery): Promise<ContentProductsResponse> {
    return this.conteudo.produtos(auth, query.brand_id, query.unit_id);
  }
}
