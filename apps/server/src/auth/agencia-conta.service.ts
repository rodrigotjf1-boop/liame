import type { CreateAgencyRequest, MeResponse } from '@liame/contracts';
import { type Database, uuidv7, withSystem } from '@liame/database';
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { activeTraceId, writeAudit } from '../audit/audit.js';
import type { AuthContext } from '../context/request-context.js';
import { DATABASE } from '../database/database.module.js';
import { AppProblem } from '../errors/problems.js';
import { ROLE_LABEL } from '../people/grant-rules.js';
import { AuthService } from './auth.service.js';
import { RateLimitService } from './rate-limit.service.js';

/**
 * Abrir a conta da agência para quem já tem login (A7, W6; D-A7-45: "Sua conta › Abrir a conta da agência"). A agência
 * é uma organização nova, com a pessoa como dona, sem marca e sem assinatura; vira a organização ativa da sessão. Roda
 * no escopo de sistema, como o cadastro: a organização nova ainda não é a da sessão.
 */
@Injectable()
export class AgencyAccountService {
  constructor(
    @Inject(DATABASE) private readonly database: Database | null,
    private readonly auth: AuthService,
    private readonly rateLimit: RateLimitService,
  ) {}

  private get db() {
    if (!this.database) throw new AppProblem(503, 'indisponivel', 'Serviço indisponível', 'Tente de novo em instantes.');
    return this.database.db;
  }

  async open(auth: AuthContext, input: CreateAgencyRequest): Promise<MeResponse> {
    await this.rateLimit.consume(`agencia:abrir:${auth.userId}`, 5, 86400);
    return withSystem(
      this.db,
      async (tx) => {
        // Dois pedidos ao mesmo tempo da mesma pessoa: a linha dela segura o segundo até o primeiro gravar.
        await tx.execute(sql`select 1 from liame.app_user where id = ${auth.userId} for update`);
        // Uma agência por pessoa como dona: quem já é dona de uma agência ativa não abre outra.
        const ja = await tx.execute(sql`
          select 1 from liame.membership m join liame.organization o on o.id = m.tenant_id
           where m.user_id = ${auth.userId} and m.role_key = 'agencia_dona' and m.revoked_at is null and o.status = 'ativa'`);
        if (ja.rows[0]) {
          throw new AppProblem(409, 'ja-tem-agencia', 'Você já tem uma agência', 'Você já é dona de uma agência no Liame: o time e os clientes ficam nela.');
        }
        const tenantId = uuidv7();
        const memberId = uuidv7();
        await tx.execute(sql`insert into liame.organization (id, name, cnpj, kind) values (${tenantId}, ${input.name}, ${input.cnpj ?? null}, 'agencia')`);
        await tx.execute(sql`
          insert into liame.membership (id, tenant_id, user_id, role_key, dual_approval, billing_access)
          values (${memberId}, ${tenantId}, ${auth.userId}, 'agencia_dona', false, false)`);
        await writeAudit(tx, {
          tenantId,
          actorType: 'human',
          actorId: auth.userId,
          actorLabel: `${auth.name}, ${ROLE_LABEL.agencia_dona}`,
          actorRole: 'agencia_dona',
          action: 'agencia.abrir',
          resourceType: 'organization',
          resourceId: tenantId,
          after: { company: input.name, kind: 'agencia' },
          traceId: activeTraceId(),
          origin: 'api',
        });
        await tx.execute(sql`update liame.session set active_tenant_id = ${tenantId} where id = ${auth.sessionId}`);
        return this.auth.loadMe(tx, auth.userId, tenantId, auth.mfaVerifiedAt);
      },
      { userId: auth.userId },
    );
  }
}
