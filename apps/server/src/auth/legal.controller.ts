import { LegalTermsResponse } from '@liame/contracts';
import { Controller, Get, Inject } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { Publico } from './access.js';

// Termos vigentes (A0-6): o cadastro e o convite mostram os links e devolvem a versão aceita.
@ApiTags('auth')
@Controller('legal')
export class LegalController {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  @Get('terms')
  @Publico()
  @ApiOperation({
    summary: 'Termos vigentes',
    description: 'Versão e endereços dos Termos de Uso e da Política de Privacidade. O cadastro envia a versão que a pessoa aceitou.',
  })
  @ApiOkResponse({ standardSchema: LegalTermsResponse })
  terms(): LegalTermsResponse {
    const { version, termsUrl, privacyUrl } = this.config.terms;
    return { version, terms_url: termsUrl, privacy_url: privacyUrl };
  }
}
