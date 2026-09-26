import type { ActionProposal, PolicyDecision, PolicyDocument, PolicyListResponse, PolicyVersionResponse, PublishPolicyRequest } from '@liame/contracts';
import { type Tx, uuidv7 } from '@liame/database';
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { type AuthContext, auditDetail, currentTx } from '../context/request-context.js';
import { AppProblem } from '../errors/problems.js';
import { evaluatePolicy, type LoadedPolicy, PLATFORM_POLICY } from './engine.js';

type Row = {
  id: string;
  brand_id: string | null;
  version: number;
  status: 'ativa' | 'arquivada';
  document: PolicyDocument;
  created_at: Date | string;
};

/** Políticas versionadas da empresa e da marca (ADR-007). A da distribuição vem do código. */
@Injectable()
export class PolicyService {
  /** Plataforma + empresa + marca ativas, nessa ordem (da menos para a mais específica). */
  async load(tx: Tx, tenantId: string, brandId?: string | null): Promise<{ policies: LoadedPolicy[]; timezone: string }> {
    const r = await tx.execute<{ brand_id: string | null; version: number; document: PolicyDocument }>(sql`
      select brand_id, version, document from liame.policy
       where tenant_id = ${tenantId} and status = 'ativa' and (brand_id is null or brand_id = ${brandId ?? null})`);
    const org = await tx.execute<{ timezone: string }>(sql`select timezone from liame.organization where id = ${tenantId}`);
    const tenantPolicy = r.rows.find((x) => x.brand_id === null);
    const brandPolicy = r.rows.find((x) => x.brand_id !== null);
    return {
      policies: [
        PLATFORM_POLICY,
        ...(tenantPolicy ? [{ source: 'tenant' as const, version: tenantPolicy.version, document: tenantPolicy.document }] : []),
        ...(brandPolicy ? [{ source: 'brand' as const, version: brandPolicy.version, document: brandPolicy.document }] : []),
      ],
      timezone: org.rows[0]?.timezone ?? 'America/Sao_Paulo',
    };
  }

  async evaluate(tx: Tx, tenantId: string, proposal: ActionProposal, at = new Date()): Promise<PolicyDecision> {
    if (proposal.brand_id) await this.assertBrand(tx, tenantId, proposal.brand_id);
    const { policies, timezone } = await this.load(tx, tenantId, proposal.brand_id);
    return evaluatePolicy(policies, proposal, { at, timezone });
  }

  async list(auth: AuthContext): Promise<PolicyListResponse> {
    const r = await currentTx().execute<Row>(sql`
      select id, brand_id, version, status, document, created_at from liame.policy
       where tenant_id = ${tenantOf(auth)} order by brand_id nulls first, version desc limit 200`);
    return { platform: { version: PLATFORM_POLICY.version, document: PLATFORM_POLICY.document }, items: r.rows.map(toResponse) };
  }

  /** Publica uma versão nova (a anterior do mesmo escopo é arquivada). Versão publicada não muda. */
  async publish(auth: AuthContext, input: PublishPolicyRequest): Promise<PolicyVersionResponse> {
    const tx = currentTx();
    const tenantId = tenantOf(auth);
    if (input.brand_id) await this.assertBrand(tx, tenantId, input.brand_id);
    // Trava o escopo: duas publicações ao mesmo tempo não pegam o mesmo número de versão.
    await tx.execute(sql`select id from liame.policy where tenant_id = ${tenantId} and brand_id is not distinct from ${input.brand_id} for update`);
    const current = await tx.execute<{ version: number }>(sql`
      select coalesce(max(version), 0)::int as version from liame.policy
       where tenant_id = ${tenantId} and brand_id is not distinct from ${input.brand_id}`);
    const version = (current.rows[0]?.version ?? 0) + 1;
    await tx.execute(sql`
      update liame.policy set status = 'arquivada', archived_at = now()
       where tenant_id = ${tenantId} and brand_id is not distinct from ${input.brand_id} and status = 'ativa'`);
    const id = uuidv7();
    const r = await tx.execute<Row>(sql`
      insert into liame.policy (id, tenant_id, brand_id, version, status, document, created_by)
      values (${id}, ${tenantId}, ${input.brand_id}, ${version}, 'ativa', ${JSON.stringify(input.document)}::jsonb, ${auth.userId})
      returning id, brand_id, version, status, document, created_at`);
    auditDetail({ resourceId: id, after: { brand_id: input.brand_id, version, rules: input.document.rules.length } });
    return toResponse(r.rows[0]!);
  }

  private async assertBrand(tx: Tx, tenantId: string, brandId: string): Promise<void> {
    const b = await tx.execute(sql`select 1 from liame.brand where id = ${brandId} and tenant_id = ${tenantId}`);
    if (!b.rows[0]) throw new AppProblem(404, 'nao-encontrado', 'Não encontramos', 'Marca não encontrada nesta empresa.');
  }
}

function tenantOf(auth: AuthContext): string {
  if (!auth.tenantId) throw new AppProblem(403, 'sem-empresa-ativa', 'Escolha uma empresa', 'Selecione uma empresa com acesso ativo.');
  return auth.tenantId;
}

function toResponse(r: Row): PolicyVersionResponse {
  return {
    id: r.id,
    brand_id: r.brand_id,
    version: Number(r.version),
    status: r.status,
    document: r.document,
    created_at: new Date(r.created_at).toISOString(),
  };
}
