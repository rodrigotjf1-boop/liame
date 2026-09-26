import {
  BrandListResponse,
  BrandResponse,
  CreateBrandRequest,
  OrganizationResponse,
  ProblemDetails,
} from '@liame/contracts';
import { uuidv7 } from '@liame/database';
import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { ApiCookieAuth, ApiCreatedResponse, ApiForbiddenResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { sql } from 'drizzle-orm';
import { Auth, Permissao } from '../auth/access.js';
import { type AuthContext, currentTx } from '../context/request-context.js';

// Empresa ativa e marcas. A RLS filtra pelo tenant da transação; a rota ainda assim filtra (defesa em camadas, ADR-003).
@ApiTags('organization')
@ApiCookieAuth('liame_sessao')
@Controller()
export class TenancyController {
  @Get('organization')
  @Permissao('empresa.ver')
  @ApiOperation({ summary: 'Empresa ativa', description: 'Dados da empresa ativa da sessão.' })
  @ApiOkResponse({ standardSchema: OrganizationResponse })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  async organization(@Auth() auth: AuthContext): Promise<OrganizationResponse> {
    const r = await currentTx().execute<OrganizationResponse>(sql`
      select id, name, cnpj, timezone, status from liame.organization where id = ${auth.tenantId}`);
    return r.rows[0]!;
  }

  @Get('brands')
  @Permissao('marcas.ver')
  @ApiOperation({ summary: 'Marcas', description: 'Marcas da empresa ativa.' })
  @ApiOkResponse({ standardSchema: BrandListResponse })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  async brands(@Auth() auth: AuthContext): Promise<BrandListResponse> {
    const r = await currentTx().execute<BrandResponse>(sql`
      select id, name from liame.brand where tenant_id = ${auth.tenantId} order by name`);
    return { items: r.rows };
  }

  @Post('brands')
  @Permissao('marcas.gerenciar')
  @HttpCode(201)
  @ApiOperation({ summary: 'Criar marca', description: 'Cria uma marca na empresa ativa.' })
  @ApiCreatedResponse({ standardSchema: BrandResponse })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  async createBrand(@Auth() auth: AuthContext, @Body({ schema: CreateBrandRequest }) body: CreateBrandRequest): Promise<BrandResponse> {
    const id = uuidv7();
    await currentTx().execute(sql`insert into liame.brand (id, tenant_id, name) values (${id}, ${auth.tenantId}, ${body.name})`);
    return { id, name: body.name };
  }
}
