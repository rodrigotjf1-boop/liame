import { AccountRecoveryNoticeResponse, ProblemDetails, ResourceId } from '@liame/contracts';
import { Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { ApiCookieAuth, ApiForbiddenResponse, ApiNotFoundResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Auditar } from '../audit/auditar.js';
import { Auth, Permissao } from '../auth/access.js';
import type { AuthContext } from '../context/request-context.js';
import { AvisoDaRecuperacaoService } from './aviso-da-recuperacao.service.js';

// O aviso aos Administradores na espera da recuperação da conta do Dono (A7, W8, parte 4b; P34; D-A7-62, D-A7-64), em
// Pessoas e acessos: ler o aviso e "Não reconheço este pedido". O serviço confere que é um Administrador da própria
// empresa (não de uma agência).
@ApiTags('people')
@ApiCookieAuth('liame_sessao')
@Controller('account-recovery')
export class AvisoDaRecuperacaoController {
  constructor(private readonly aviso: AvisoDaRecuperacaoService) {}

  @Get('notice')
  @Permissao('pessoas.ver')
  @ApiOperation({
    summary: 'O pedido de recuperação do Dono, para os Administradores',
    description:
      'Na espera de 7 dias depois da conferência da DMS (ou parado por um Administrador), o pedido do Dono desta empresa: o protocolo, quem pediu, quando a DMS conferiu e quando o app dele é trocado. Nulo para quem não é Administrador da própria empresa e sem pedido.',
  })
  @ApiOkResponse({ standardSchema: AccountRecoveryNoticeResponse })
  ler(@Auth() auth: AuthContext): Promise<AccountRecoveryNoticeResponse> {
    return this.aviso.ler(auth);
  }

  @Post(':id/stop')
  @HttpCode(200)
  @Permissao('pessoas.ver')
  @Auditar('pessoas.recuperacao_parar', { recurso: 'account_recovery' })
  @ApiOperation({
    summary: 'Não reconheço este pedido',
    description:
      'Só um Administrador da própria empresa (403 `so-administrador`), com o pedido na espera (404 `nao-encontrado`). O pedido para, e só a DMS o retoma, depois de falar com o Dono; o worker avisa o Dono e a DMS por e-mail.',
  })
  @ApiOkResponse({ standardSchema: AccountRecoveryNoticeResponse })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  parar(@Auth() auth: AuthContext, @Param('id', { schema: ResourceId }) id: string): Promise<AccountRecoveryNoticeResponse> {
    return this.aviso.parar(auth, id);
  }
}
