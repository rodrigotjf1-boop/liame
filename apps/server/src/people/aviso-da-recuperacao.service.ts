import type { AccountRecoveryNotice, AccountRecoveryNoticeResponse } from '@liame/contracts';
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { auditDetail, type AuthContext, currentTx } from '../context/request-context.js';
import { AppProblem } from '../errors/problems.js';

// O aviso aos Administradores na espera da recuperação da conta do Dono (A7, W8, parte 4b; P34; D-A7-62, D-A7-64;
// D-A7-85). Roda na transação da requisição, com a empresa ativa: a RLS deixa a empresa de que a pessoa é a dona ler o
// pedido e pará-lo (`account_recovery_da_empresa`, `account_recovery_para`). Só os Administradores da própria empresa
// (não os que vêm de uma agência) veem o aviso e param o pedido; parado, só a DMS retoma, depois de falar com o Dono.
// O e-mail ao Dono e à DMS sai pelo worker (a situação `parado` ainda não avisada).

type Linha = {
  id: string;
  protocol: string;
  status: 'conferido' | 'parado';
  owner_name: string;
  created_at: Date | string;
  checked_at: Date | string;
  applies_at: Date | string | null;
  stopped_at: Date | string | null;
  stopped_by_user_id: string | null;
};

const iso = (v: Date | string): string => (v instanceof Date ? v : new Date(v)).toISOString();

/** Quem vê o aviso e para o pedido: um Administrador da própria empresa. */
const ehAdministrador = (auth: AuthContext): boolean => auth.roleKey === 'administrador' && !auth.partner;

@Injectable()
export class AvisoDaRecuperacaoService {
  /** O pedido do Dono desta empresa na espera (ou parado); nulo para quem não é Administrador e sem pedido. */
  async ler(auth: AuthContext): Promise<AccountRecoveryNoticeResponse> {
    if (!ehAdministrador(auth) || !auth.tenantId) return { notice: null };
    const r = await currentTx().execute<Linha>(sql`
      select r.id, r.protocol, r.status, u.name as owner_name, r.created_at, r.checked_at, r.applies_at, r.stopped_at, r.stopped_by_user_id
        from liame.account_recovery r
        join liame.membership m on m.user_id = r.user_id and m.tenant_id = ${auth.tenantId} and m.role_key = 'dono' and m.revoked_at is null
        join liame.app_user u on u.id = r.user_id
       where r.status in ('conferido', 'parado')
       order by r.created_at desc
       limit 1`);
    const l = r.rows[0];
    return { notice: l ? aviso(l, auth.userId) : null };
  }

  /** "Não reconheço este pedido": o pedido para, e só a DMS o retoma, depois de falar com o Dono. */
  async parar(auth: AuthContext, id: string): Promise<AccountRecoveryNoticeResponse> {
    if (!ehAdministrador(auth) || !auth.tenantId) {
      throw new AppProblem(403, 'so-administrador', 'Só um Administrador', 'Só um Administrador da empresa para o pedido de recuperação do Dono.');
    }
    const r = await currentTx().execute<{ protocol: string }>(sql`
      update liame.account_recovery r
         set status = 'parado', stopped_at = now(), stopped_by_user_id = ${auth.userId}, stopped_tenant_id = ${auth.tenantId}, applies_at = null
       where r.id = ${id} and r.status = 'conferido'
         and exists (select 1 from liame.membership m
                      where m.user_id = r.user_id and m.tenant_id = ${auth.tenantId} and m.role_key = 'dono' and m.revoked_at is null)
       returning r.protocol`);
    const linha = r.rows[0];
    if (!linha) throw new AppProblem(404, 'nao-encontrado', 'Não encontramos', 'Este pedido de recuperação não existe ou já não está na espera.');
    auditDetail({ after: { protocolo: linha.protocol, situacao: 'parado' } });
    return this.ler(auth);
  }
}

function aviso(l: Linha, eu: string): AccountRecoveryNotice {
  return {
    id: l.id,
    protocol: l.protocol,
    owner_name: l.owner_name,
    status: l.status,
    created_at: iso(l.created_at),
    checked_at: iso(l.checked_at),
    applies_at: l.status === 'conferido' && l.applies_at ? iso(l.applies_at) : null,
    stopped_at: l.stopped_at ? iso(l.stopped_at) : null,
    stopped_by_me: l.stopped_by_user_id === eu,
  };
}
