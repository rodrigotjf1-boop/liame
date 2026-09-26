import { FlagKey, OfrepBulkResponse, OfrepFailure, OfrepRequest, OfrepSuccess } from '@liame/contracts';
import { Body, Controller, Headers, HttpCode, Param, Post, Res } from '@nestjs/common';
import { ApiCookieAuth, ApiNotFoundResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { FlagNotFoundError } from '@openfeature/server-sdk';
import { sql } from 'drizzle-orm';
import { SemAuditoria } from '../audit/auditar.js';
import { Auth, Autenticado } from '../auth/access.js';
import { type AuthContext, currentTx } from '../context/request-context.js';
import { AppProblem } from '../errors/problems.js';
import type { FlagContext } from './evaluate.js';
import { FlagService } from './flag.service.js';

interface HttpResponse {
  setHeader(name: string, value: string): void;
  status(code: number): HttpResponse;
}

// OFREP (open-feature/protocol): POST /ofrep/v1/evaluate/flags e /flags/{key}, sob o prefixo /v1 da API.
@ApiTags('flags')
@ApiCookieAuth('liame_sessao')
@Controller('ofrep/v1/evaluate/flags')
export class OfrepController {
  constructor(private readonly flags: FlagService) {}

  @Post()
  @Autenticado()
  @SemAuditoria('só avalia flags; nada muda')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Avaliar todas as flags (OFREP)',
    description: 'Valores para a sessão (empresa ativa e pessoa). Responde 304 quando o ETag enviado em If-None-Match ainda vale.',
  })
  @ApiOkResponse({ standardSchema: OfrepBulkResponse })
  async bulk(
    @Auth() auth: AuthContext,
    @Body({ schema: OfrepRequest }) body: OfrepRequest,
    @Headers('if-none-match') ifNoneMatch: string | undefined,
    @Res({ passthrough: true }) res: HttpResponse,
  ): Promise<OfrepBulkResponse | undefined> {
    const ctx = await this.contextOf(auth, body);
    const { version, results } = await this.flags.evaluateAll(ctx);
    // O ETag leva a versão das flags e o contexto: outra empresa ou marca não reaproveita a resposta.
    const etag = `${version.slice(0, -1)}.${[ctx.tenantId, ctx.brandId, ctx.userId].join('.')}"`;
    res.setHeader('ETag', etag);
    if (ifNoneMatch === etag) {
      res.status(304);
      return undefined;
    }
    return { flags: results.map(toSuccess) };
  }

  @Post(':key')
  @Autenticado()
  @SemAuditoria('só avalia uma flag; nada muda')
  @HttpCode(200)
  @ApiOperation({ summary: 'Avaliar uma flag (OFREP)', description: 'Valor da flag para a sessão.' })
  @ApiOkResponse({ standardSchema: OfrepSuccess })
  @ApiNotFoundResponse({ standardSchema: OfrepFailure })
  async single(
    @Auth() auth: AuthContext,
    @Param('key', { schema: FlagKey }) key: string,
    @Body({ schema: OfrepRequest }) body: OfrepRequest,
    @Res({ passthrough: true }) res: HttpResponse,
  ): Promise<OfrepSuccess | OfrepFailure> {
    try {
      return toSuccess(await this.flags.evaluate(key, await this.contextOf(auth, body)));
    } catch (err) {
      if (!(err instanceof FlagNotFoundError)) throw err;
      res.status(404);
      return { key, errorCode: 'FLAG_NOT_FOUND', errorDetails: 'Flag não encontrada.' };
    }
  }

  /** Empresa e pessoa vêm da sessão; a marca enviada só vale se for da empresa ativa. */
  private async contextOf(auth: AuthContext, body: OfrepRequest): Promise<FlagContext> {
    const brandId = body.context.brandId;
    if (brandId) {
      const r = await currentTx().execute(sql`select 1 from liame.brand where id = ${brandId} and tenant_id = ${auth.tenantId}`);
      if (!r.rows[0]) throw new AppProblem(400, 'marca-invalida', 'Marca inválida', 'A marca não é da empresa ativa.');
    }
    return this.flags.context({ tenantId: auth.tenantId, userId: auth.userId, brandId: brandId ?? null });
  }
}

function toSuccess(r: { key: string; value: boolean | string | number; reason: OfrepSuccess['reason']; variant: string }): OfrepSuccess {
  return { key: r.key, value: r.value, reason: r.reason, variant: r.variant };
}
