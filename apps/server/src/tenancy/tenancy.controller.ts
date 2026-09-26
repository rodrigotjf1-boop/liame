import {
  BrandListQuery,
  BrandListResponse,
  BrandResponse,
  CreateBrandRequest,
  OrganizationResponse,
  ProblemDetails,
  ResourceId,
} from '@liame/contracts';
import { uuidv7 } from '@liame/database';
import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiCookieAuth, ApiCreatedResponse, ApiForbiddenResponse, ApiNotFoundResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { sql } from 'drizzle-orm';
import { Auditar } from '../audit/auditar.js';
import { Auth, Permissao } from '../auth/access.js';
import { auditDetail, type AuthContext, currentTx } from '../context/request-context.js';
import { AppProblem } from '../errors/problems.js';
import { emitEvent } from '../events/outbox.js';

/** Marca arquivada é expurgada depois deste prazo (ADR-014). */
const BRAND_PURGE_MONTHS = 12;

type BrandRow = { id: string; name: string; archived_at: Date | string | null; purge_after: Date | string | null };
const isoOrNull = (v: Date | string | null) => (v === null ? null : new Date(v).toISOString());
const toBrand = (r: BrandRow): BrandResponse => ({ id: r.id, name: r.name, archived_at: isoOrNull(r.archived_at), purge_after: isoOrNull(r.purge_after) });

// Empresa ativa e marcas. A RLS filtra pelo tenant da transação; a rota ainda assim filtra (defesa em camadas, ADR-003).
@ApiTags('organization')
@ApiCookieAuth('liame_sessao')
@Controller()
export class TenancyController {
  @Get('organization')
  @Permissao('empresa.ver')
  @ApiOperation({ summary: 'Empresa ativa', description: 'Dados da empresa ativa da sessão, com a situação do ciclo de vida.' })
  @ApiOkResponse({ standardSchema: OrganizationResponse })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  async organization(@Auth() auth: AuthContext): Promise<OrganizationResponse> {
    const r = await currentTx().execute<{
      id: string;
      name: string;
      cnpj: string | null;
      timezone: string;
      status: OrganizationResponse['status'];
      suspended_at: Date | string | null;
      purge_after: Date | string | null;
    }>(sql`select id, name, cnpj, timezone, status, suspended_at, purge_after from liame.organization where id = ${auth.tenantId}`);
    const o = r.rows[0]!;
    return { ...o, suspended_at: isoOrNull(o.suspended_at), purge_after: isoOrNull(o.purge_after) };
  }

  @Get('brands')
  @Permissao('marcas.ver')
  @ApiOperation({ summary: 'Marcas', description: 'Marcas ativas da empresa; `include_archived=true` traz também as arquivadas.' })
  @ApiOkResponse({ standardSchema: BrandListResponse })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  async brands(@Auth() auth: AuthContext, @Query({ schema: BrandListQuery }) query: BrandListQuery): Promise<BrandListResponse> {
    const r = await currentTx().execute<BrandRow>(sql`
      select id, name, archived_at, purge_after from liame.brand
       where tenant_id = ${auth.tenantId} ${query.include_archived === 'true' ? sql`` : sql`and archived_at is null`}
       order by name`);
    return { items: r.rows.map(toBrand) };
  }

  @Post('brands')
  @Permissao('marcas.gerenciar')
  @Auditar('marca.criar', { recurso: 'brand' })
  @HttpCode(201)
  @ApiOperation({ summary: 'Criar marca', description: 'Cria uma marca na empresa ativa.' })
  @ApiCreatedResponse({ standardSchema: BrandResponse })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  async createBrand(@Auth() auth: AuthContext, @Body({ schema: CreateBrandRequest }) body: CreateBrandRequest): Promise<BrandResponse> {
    const id = uuidv7();
    const tx = currentTx();
    await tx.execute(sql`insert into liame.brand (id, tenant_id, name) values (${id}, ${auth.tenantId}, ${body.name})`);
    await emitEvent(tx, { tenantId: auth.tenantId!, type: 'liame.brand.created', subject: id, data: { brand_id: id, name: body.name } });
    auditDetail({ after: { name: body.name } });
    return { id, name: body.name, archived_at: null, purge_after: null };
  }

  @Post('brands/:id/archive')
  @Permissao('marcas.gerenciar')
  @Auditar('marca.arquivar', { recurso: 'brand' })
  @HttpCode(200)
  @ApiOperation({ summary: 'Arquivar marca', description: `Só leitura e fora das telas; reativável. Expurgo em ${BRAND_PURGE_MONTHS} meses (ADR-014).` })
  @ApiOkResponse({ standardSchema: BrandResponse })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  async archive(@Auth() auth: AuthContext, @Param('id', { schema: ResourceId }) id: string): Promise<BrandResponse> {
    const r = await currentTx().execute<BrandRow>(sql`
      update liame.brand set archived_at = now(), purge_after = now() + make_interval(months => ${BRAND_PURGE_MONTHS}),
             purge_reason = 'marca arquivada'
       where id = ${id} and tenant_id = ${auth.tenantId} and archived_at is null
       returning id, name, archived_at, purge_after`);
    if (!r.rows[0]) throw new AppProblem(404, 'nao-encontrado', 'Não encontramos', 'Marca ativa não encontrada nesta empresa.');
    auditDetail({ after: { purge_after: isoOrNull(r.rows[0].purge_after) } });
    return toBrand(r.rows[0]);
  }

  @Post('brands/:id/reactivate')
  @Permissao('marcas.gerenciar')
  @Auditar('marca.reativar', { recurso: 'brand' })
  @HttpCode(200)
  @ApiOperation({ summary: 'Reativar marca', description: 'Volta a marca arquivada para o uso normal e cancela o expurgo.' })
  @ApiOkResponse({ standardSchema: BrandResponse })
  @ApiNotFoundResponse({ standardSchema: ProblemDetails })
  async reactivate(@Auth() auth: AuthContext, @Param('id', { schema: ResourceId }) id: string): Promise<BrandResponse> {
    const r = await currentTx().execute<BrandRow>(sql`
      update liame.brand set archived_at = null, purge_after = null, purge_reason = null
       where id = ${id} and tenant_id = ${auth.tenantId} and archived_at is not null
       returning id, name, archived_at, purge_after`);
    if (!r.rows[0]) throw new AppProblem(404, 'nao-encontrado', 'Não encontramos', 'Marca arquivada não encontrada nesta empresa.');
    return toBrand(r.rows[0]);
  }
}
