import type { AgencyReplyToConfirmedResponse } from '@liame/contracts';
import { type Database, withSystem } from '@liame/database';
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { activeTraceId, writeAudit } from '../audit/audit.js';
import { DATABASE } from '../database/database.module.js';
import { AppProblem } from '../errors/problems.js';
import { hashToken } from './tokens.js';

// A confirmação do e-mail de resposta da agência (A7, W7, parte 3; D-A7-69): quem lê aquele endereço abre o link, sem
// login (pode nem ter conta no Liame), e o e-mail passa a valer no "Responder" do relatório. O link acha a agência pelo
// hash, sem saber de quem é: por isso a leitura é de sistema e mora aqui, com as outras rotas de link (V: escopo de
// sistema só na autenticação). Uso único; vale 24 horas.

@Injectable()
export class AgencyReplyToService {
  constructor(@Inject(DATABASE) private readonly database: Database | null) {}

  async confirmar(token: string): Promise<AgencyReplyToConfirmedResponse> {
    if (!this.database) throw new Error('resposta da agência: sem banco');
    return withSystem(this.database.db, async (tx) => {
      const r = await tx.execute<{ tenant_id: string; email: string; name: string }>(sql`
        with confirmada as (
          update liame.agency_brand
             set reply_to_email = pending_reply_to, reply_to_confirmed_at = now(),
                 pending_reply_to = null, pending_token_hash = null, pending_expires_at = null, pending_requested_by = null
           where pending_token_hash = ${hashToken(token)} and pending_expires_at > now()
          returning tenant_id, reply_to_email)
        select c.tenant_id, c.reply_to_email as email, o.name
          from confirmada c join liame.organization o on o.id = c.tenant_id`);
      const linha = r.rows[0];
      if (!linha) throw new AppProblem(400, 'link-invalido', 'Link inválido ou vencido', 'Peça à agência para salvar o e-mail de novo e mandar outro link.');
      // Quem confirmou é quem lê o endereço: a auditoria da agência guarda a confirmação, sem pessoa.
      await writeAudit(tx, {
        tenantId: linha.tenant_id,
        actorType: 'system',
        actorId: null,
        actorLabel: 'link de confirmação',
        action: 'agencia.marca_resposta_confirmada',
        resourceType: 'agency_brand',
        resourceId: linha.tenant_id,
        after: { reply_to: 'confirmado' },
        traceId: activeTraceId(),
        origin: 'api',
      });
      return { agency_name: linha.name, email: linha.email };
    });
  }
}
