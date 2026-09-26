import { AuditEventListResponse, AuditEventQuery, type AuditEventResponse, AuditVerifyResponse, ProblemDetails } from '@liame/contracts';
import { Controller, Get, Query } from '@nestjs/common';
import { ApiCookieAuth, ApiForbiddenResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { sql } from 'drizzle-orm';
import { Auth, Permissao } from '../auth/access.js';
import { type AuthContext, currentTx } from '../context/request-context.js';
import { AppProblem } from '../errors/problems.js';
import { verifyChain } from './audit.js';

type Row = {
  id: string;
  chain_seq: string;
  occurred_at: Date | string;
  actor_type: AuditEventResponse['actor_type'];
  actor_label: string | null;
  action: string;
  resource_type: string | null;
  resource_id: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  reason: string | null;
  trace_id: string | null;
};

// Auditoria da empresa ativa: quem fez o quê, quando, e a prova de que nada foi mudado.
@ApiTags('audit')
@ApiCookieAuth('liame_sessao')
@Controller('audit')
export class AuditController {
  @Get('events')
  @Permissao('auditoria.ver')
  @ApiOperation({ summary: 'Eventos de auditoria', description: 'Do mais novo para o mais antigo, em páginas.' })
  @ApiOkResponse({ standardSchema: AuditEventListResponse })
  @ApiForbiddenResponse({ standardSchema: ProblemDetails })
  async events(@Auth() auth: AuthContext, @Query({ schema: AuditEventQuery }) query: AuditEventQuery): Promise<AuditEventListResponse> {
    const tenantId = tenantOf(auth);
    const r = await currentTx().execute<Row>(sql`
      select id, chain_seq, occurred_at, actor_type, actor_label, action, resource_type, resource_id, before, after, reason, trace_id
        from liame.audit_event
       where chain_key = ${tenantId} and tenant_id = ${tenantId} ${query.before_seq ? sql`and chain_seq < ${query.before_seq}` : sql``}
       order by chain_seq desc limit ${query.limit + 1}`);
    const rows = r.rows.slice(0, query.limit);
    return {
      items: rows.map((e) => ({
        id: e.id,
        seq: Number(e.chain_seq),
        occurred_at: new Date(e.occurred_at).toISOString(),
        actor_type: e.actor_type,
        actor_label: e.actor_label,
        action: e.action,
        resource_type: e.resource_type,
        resource_id: e.resource_id,
        before: e.before,
        after: e.after,
        reason: e.reason,
        trace_id: e.trace_id,
      })),
      next_before_seq: r.rows.length > query.limit ? Number(rows[rows.length - 1]!.chain_seq) : null,
    };
  }

  @Get('verify')
  @Permissao('auditoria.ver')
  @ApiOperation({
    summary: 'Verificar a auditoria',
    description: 'Recalcula o hash encadeado de todos os eventos da empresa e confere com a cabeça da cadeia.',
  })
  @ApiOkResponse({ standardSchema: AuditVerifyResponse })
  async verify(@Auth() auth: AuthContext): Promise<AuditVerifyResponse> {
    const check = await verifyChain(currentTx(), tenantOf(auth));
    return {
      ok: check.ok,
      events_checked: check.events,
      head_seq: check.headSeq,
      broken_at_seq: check.brokenAtSeq,
      reason: check.reason,
    };
  }
}

function tenantOf(auth: AuthContext): string {
  if (!auth.tenantId) throw new AppProblem(403, 'sem-empresa-ativa', 'Escolha uma empresa', 'Selecione uma empresa com acesso ativo.');
  return auth.tenantId;
}
