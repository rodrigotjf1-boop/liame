import type { SecurityEventsResponse, SecuritySummaryResponse, SessionListResponse } from '@liame/contracts';
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { type AuthContext, auditDetail, currentTx } from '../context/request-context.js';
import { AppProblem } from '../errors/problems.js';
import { descreverAparelho, mascararIp } from './aparelho.js';

// Segurança da conta (tela "Segurança da conta"): tudo na transação da requisição, pela RLS da própria
// pessoa — sessões (session_isolamento), códigos (recovery_code_isolamento), pedido de troca
// (user_token_troca_propria) e a trilha pessoal da auditoria (audit_event, tenant_id nulo).

const IDLE_DAYS = 7;

/** Ações da trilha pessoal que a tela mostra como "Atividade de segurança". */
const ACOES_DE_SEGURANCA = [
  'sessao.abrir',
  'sessao.falhar',
  'sessao.encerrar',
  'sessao.encerrar_outras',
  'segundo_fator.verificar',
  'segundo_fator.ativar',
  'segundo_fator.pedir_troca',
  'segundo_fator.gerar_codigos',
  'senha.redefinir',
  'email.confirmar',
];

type LinhaSessao = { id: string; user_agent: string | null; ip: string | null; created_at: Date | string; last_seen_at: Date | string };
type LinhaEvento = { action: string; occurred_at: Date | string; after: Record<string, unknown> | null };

const iso = (v: Date | string) => new Date(v).toISOString();

@Injectable()
export class SecurityService {
  async summary(auth: AuthContext): Promise<SecuritySummaryResponse> {
    const tx = currentTx();
    const r = await tx.execute<{ mfa_enabled_at: Date | string | null; restantes: string; usable_after: Date | string | null; expires_at: Date | string | null }>(sql`
      select u.mfa_enabled_at,
             (select count(*) from liame.recovery_code c where c.user_id = u.id and c.used_at is null) as restantes,
             t.usable_after, t.expires_at
        from liame.app_user u
        left join lateral (
          select usable_after, expires_at from liame.user_token
           where user_id = u.id and purpose = 'trocar_segundo_fator' and used_at is null and expires_at > now()
           order by created_at desc limit 1
        ) t on true
       where u.id = ${auth.userId}`);
    const row = r.rows[0];
    return {
      mfa_enabled_since: row?.mfa_enabled_at ? iso(row.mfa_enabled_at) : null,
      session_mfa_method: auth.mfaVerifiedAt ? auth.mfaMethod : null,
      recovery_codes_left: Number(row?.restantes ?? 0),
      change_request: row?.usable_after && row.expires_at ? { usable_after: iso(row.usable_after), expires_at: iso(row.expires_at) } : null,
    };
  }

  /** Aparelhos com a conta aberta: sessões não encerradas, dentro da validade e do prazo de inatividade. */
  async sessions(auth: AuthContext): Promise<SessionListResponse> {
    const r = await currentTx().execute<LinhaSessao>(sql`
      select id, user_agent, host(ip) as ip, created_at, last_seen_at from liame.session
       where user_id = ${auth.userId} and revoked_at is null and expires_at > now()
         and last_seen_at > now() - make_interval(days => ${IDLE_DAYS})
       order by (id = ${auth.sessionId}) desc, last_seen_at desc`);
    return {
      sessions: r.rows.map((s) => ({
        id: s.id,
        device: descreverAparelho(s.user_agent),
        ip: mascararIp(s.ip),
        created_at: iso(s.created_at),
        last_seen_at: iso(s.last_seen_at),
        current: s.id === auth.sessionId,
      })),
    };
  }

  /** Encerra um aparelho: a próxima requisição dele já é recusada. */
  async revoke(auth: AuthContext, id: string): Promise<void> {
    const r = await currentTx().execute<{ user_agent: string | null }>(sql`
      update liame.session set revoked_at = now()
       where id = ${id} and user_id = ${auth.userId} and revoked_at is null
       returning user_agent`);
    if (!r.rows[0]) throw new AppProblem(404, 'nao-encontrado', 'Não encontramos', 'Esse aparelho já saiu da conta.');
    auditDetail({ resourceId: id, after: { aparelho: descreverAparelho(r.rows[0].user_agent) } });
  }

  /** Sai de todos os outros aparelhos; este continua. */
  async revokeOthers(auth: AuthContext): Promise<number> {
    const r = await currentTx().execute(sql`
      update liame.session set revoked_at = now()
       where user_id = ${auth.userId} and id <> ${auth.sessionId} and revoked_at is null`);
    const revoked = r.rowCount ?? 0;
    auditDetail({ after: { encerradas: revoked } });
    return revoked;
  }

  /** Atividade de segurança dos últimos 30 dias, da trilha pessoal da auditoria (sem nada de empresa). */
  async events(auth: AuthContext): Promise<SecurityEventsResponse> {
    const r = await currentTx().execute<LinhaEvento>(sql`
      select action, occurred_at, after from liame.audit_event
       where tenant_id is null and actor_id = ${auth.userId}
         and occurred_at > now() - interval '30 days'
         and action in ${ACOES_DE_SEGURANCA}
       order by occurred_at desc, chain_seq desc
       limit 50`);
    return {
      events: r.rows.map((e) => {
        const depois = e.after ?? {};
        const texto = (k: string) => (typeof depois[k] === 'string' ? (depois[k] as string) : null);
        return {
          action: e.action,
          occurred_at: iso(e.occurred_at),
          device: texto('aparelho'),
          ip: texto('ip'),
          detail: texto('metodo'),
        };
      }),
    };
  }
}
