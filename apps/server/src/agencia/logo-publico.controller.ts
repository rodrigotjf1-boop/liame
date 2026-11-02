import { type Database, withTenant } from '@liame/database';
import { Controller, Get, Inject, Logger, Param, Res } from '@nestjs/common';
import { ApiNotFoundResponse, ApiOkResponse, ApiOperation, ApiProduces, ApiTags } from '@nestjs/swagger';
import { sql } from 'drizzle-orm';
import { Publico } from '../auth/access.js';
import { SemTransacao } from '../context/sem-transacao.js';
import { DATABASE } from '../database/database.module.js';
import { AppProblem } from '../errors/problems.js';
import { ARMAZEM_DE_IMAGENS, type ArmazemDeImagens } from '../imagens/armazem.js';
import { chaveDoLogo } from './logo-da-agencia.js';

// O logo da agência num endereço público (A7, W7, parte 4a; D-A7-82): a imagem do alto do relatório que a agência manda
// ao cliente, que o programa de e-mail busca sem login. O endereço é um só por agência (`/v1/agency-logos/{id}.jpg`) e
// sempre responde o logo de agora: o e-mail antigo mostra o logo novo, e sem logo a imagem some (404). A leitura roda no
// contexto da agência do endereço (a RLS só deixa ver a linha dela), sem o escopo de sistema.

const ARQUIVO = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jpg$/;

/** O endereço público do logo de uma agência, que vai no e-mail e na tela do Dono. */
export function enderecoPublicoDoLogo(apiUrl: string, agencyId: string): string {
  return `${apiUrl.replace(/\/+$/, '')}/v1/agency-logos/${agencyId}.jpg`;
}

interface RespostaCrua {
  setHeader(nome: string, valor: string): void;
  status(codigo: number): RespostaCrua;
  end(corpo: Buffer): void;
}

const naoEncontrado = () => new AppProblem(404, 'nao-encontrado', 'Não encontramos', 'Logo não encontrado.');

@ApiTags('agency')
@Controller('agency-logos')
export class AgencyLogoPublicController {
  private readonly logger = new Logger('logo-da-agencia');

  constructor(
    @Inject(DATABASE) private readonly database: Database | null,
    @Inject(ARMAZEM_DE_IMAGENS) private readonly armazem: ArmazemDeImagens,
  ) {}

  @Get(':arquivo')
  @Publico()
  @SemTransacao('lê o logo de agora no contexto da agência do endereço, numa transação curta, e os bytes no armazenamento de imagens, sem transação aberta')
  @ApiProduces('image/jpeg')
  @ApiOperation({
    summary: 'O logo da agência (público)',
    description:
      'A imagem do logo de agora da agência, em JPEG (`{id da agência}.jpg`), para o e-mail do relatório que ela manda ao cliente. Sem logo, ou num endereço errado, 404. Guardável em cache por um dia.',
  })
  @ApiOkResponse({ description: 'O logo, em JPEG' })
  @ApiNotFoundResponse({ description: 'Logo não encontrado' })
  async ler(@Param('arquivo') arquivo: string, @Res() res: RespostaCrua): Promise<void> {
    const agencyId = ARQUIVO.exec(arquivo)?.[1];
    if (!agencyId || !this.database) throw naoEncontrado();
    const logoId = await withTenant(this.database.db, agencyId, async (tx) => {
      const r = await tx.execute<{ logo_id: string | null }>(sql`select logo_id from liame.agency_brand where tenant_id = ${agencyId}`);
      return r.rows[0]?.logo_id ?? null;
    });
    if (!logoId || !this.armazem.disponivel) throw naoEncontrado();
    let bytes: Buffer;
    try {
      bytes = await this.armazem.ler(chaveDoLogo(agencyId, logoId));
    } catch (err) {
      this.logger.warn(`logo da agência ${agencyId}: não leu do armazenamento (${err instanceof Error ? err.message : String(err)})`);
      throw naoEncontrado();
    }
    // A imagem é pública e pode ser mostrada em outro site (o webmail): sem o `same-site` da API. Continua sem ser
    // farejada nem embutida como página (os outros cabeçalhos ficam).
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.status(200).end(bytes);
  }
}
