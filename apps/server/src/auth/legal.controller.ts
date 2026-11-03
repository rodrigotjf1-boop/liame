import { LegalTermsResponse } from '@liame/contracts';
import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Publico } from './access.js';
import { TermosService } from './termos/termos.service.js';

// Termos vigentes (A0-6): o cadastro e o convite mostram os links e devolvem a versão aceita. Com os Termos novos (A7,
// W14), também a versão relevante que vem, para quem se cadastra no meio do aviso aceitar as duas (D-A7-94).
@ApiTags('auth')
@Controller('legal')
export class LegalController {
  constructor(private readonly termos: TermosService) {}

  @Get('terms')
  @Publico()
  @ApiOperation({
    summary: 'Termos vigentes',
    description:
      'Versão e endereços dos Termos de Uso e da Política de Privacidade. O cadastro envia a versão que a pessoa aceitou. `next` é a versão relevante que vem (avisada, ainda não vale): quem se cadastra no meio do aviso manda também `next_terms_version`. Nulo sem versão a caminho, ou com a função `termos_novos` desligada.',
  })
  @ApiOkResponse({ standardSchema: LegalTermsResponse })
  async terms(): Promise<LegalTermsResponse> {
    const { vigente, aVir } = await this.termos.publico();
    return { version: vigente.version, terms_url: vigente.termsUrl, privacy_url: vigente.privacyUrl, next: aVir };
  }
}
