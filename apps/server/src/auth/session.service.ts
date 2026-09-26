import type { RoleKey } from '@liame/contracts';
import { type Database, type Tx, uuidv7, withSystem } from '@liame/database';
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { APP_CONFIG, type AppConfig } from '../config.js';
import type { AuthContext } from '../context/request-context.js';
import { DATABASE } from '../database/database.module.js';
import { hashToken, newToken } from './tokens.js';

export const SESSION_COOKIE = 'liame_sessao';
const SESSION_DAYS = 30;
const IDLE_DAYS = 7;
const TOUCH_AFTER_MS = 5 * 60 * 1000;

@Injectable()
export class SessionService {
  constructor(
    @Inject(DATABASE) private readonly database: Database | null,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  private get db() {
    if (!this.database) throw new Error('sessão sem banco');
    return this.database.db;
  }

  /** Cria a sessão dentro da transação de quem chama. Devolve o token (vai só para o cookie). */
  async create(tx: Tx, input: { userId: string; tenantId: string | null; ip: string | null; userAgent: string | null }) {
    const { token, hash } = newToken();
    await tx.execute(sql`
      insert into liame.session (id, token_hash, user_id, active_tenant_id, ip, user_agent, expires_at)
      values (${uuidv7()}, ${hash}, ${input.userId}, ${input.tenantId}, ${input.ip}::inet, ${input.userAgent?.slice(0, 300) ?? null},
              now() + make_interval(days => ${SESSION_DAYS}))`);
    return token;
  }

  /**
   * Resolve o cookie: sessão válida (não revogada, não vencida, não ociosa), pessoa ativa e o vínculo
   * com a empresa ativa (se ainda existir). Escopo de sistema: acontece antes de saber o tenant.
   */
  async resolve(token: string): Promise<AuthContext | null> {
    return withSystem(this.db, async (tx) => {
      const r = await tx.execute<{
        session_id: string;
        user_id: string;
        email: string;
        name: string;
        tenant_id: string | null;
        role_key: RoleKey | null;
        mfa_verified_at: string | null;
        mfa_method: 'totp' | 'recuperacao' | null;
        mfa_configured: boolean;
        last_seen_at: string;
        permissions: string[] | null;
      }>(sql`
        select s.id as session_id, u.id as user_id, u.email, u.name, s.mfa_verified_at, s.mfa_method, s.last_seen_at,
               m.tenant_id, m.role_key, p.permissions,
               exists (select 1 from liame.secret x
                        where x.owner_user_id = u.id and x.tenant_id is null and x.purpose = 'totp' and x.revoked_at is null) as mfa_configured
          from liame.session s
          join liame.app_user u on u.id = s.user_id
          left join liame.membership m
            on m.tenant_id = s.active_tenant_id and m.user_id = s.user_id and m.revoked_at is null
           and (m.expires_at is null or m.expires_at > now())
          -- Papel como dado (ADR-013): o conjunto da empresa, se ela tiver um para o papel; senão, o padrão.
          left join lateral (
            select array_agg(rp.permission) as permissions
              from liame.role_permission rp
             where rp.role_key = m.role_key
               and rp.tenant_id is not distinct from (select t.tenant_id from liame.role_permission t
                                                        where t.tenant_id = m.tenant_id and t.role_key = m.role_key limit 1)
          ) p on m.id is not null
         where s.token_hash = ${hashToken(token)}
           and s.revoked_at is null
           and s.expires_at > now()
           and s.last_seen_at > now() - make_interval(days => ${IDLE_DAYS})
           and u.disabled_at is null and u.email_verified_at is not null`);
      const row = r.rows[0];
      if (!row) return null;
      if (Date.now() - new Date(row.last_seen_at).getTime() > TOUCH_AFTER_MS) {
        await tx.execute(sql`update liame.session set last_seen_at = now() where id = ${row.session_id}`);
      }
      return {
        userId: row.user_id,
        sessionId: row.session_id,
        email: row.email,
        name: row.name,
        tenantId: row.tenant_id,
        roleKey: row.role_key,
        permissions: new Set(row.permissions ?? []),
        mfaVerifiedAt: row.mfa_verified_at ? new Date(row.mfa_verified_at) : null,
        mfaConfigured: row.mfa_configured,
        mfaMethod: row.mfa_method,
      };
    });
  }

  async revoke(sessionId: string): Promise<void> {
    await withSystem(this.db, (tx) => tx.execute(sql`update liame.session set revoked_at = now() where id = ${sessionId} and revoked_at is null`));
  }

  /** Derruba todas as sessões da pessoa (troca de senha, conta desativada). */
  async revokeAllForUser(tx: Tx, userId: string): Promise<void> {
    await tx.execute(sql`update liame.session set revoked_at = now() where user_id = ${userId} and revoked_at is null`);
  }

  cookie(token: string): string {
    return serializeCookie(SESSION_COOKIE, token, SESSION_DAYS * 86400, this.config.cookieSecure);
  }

  clearCookie(): string {
    return serializeCookie(SESSION_COOKIE, '', 0, this.config.cookieSecure);
  }
}

function serializeCookie(name: string, value: string, maxAge: number, secure: boolean): string {
  return [`${name}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAge}`, ...(secure ? ['Secure'] : [])].join('; ');
}

export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim() || null;
  }
  return null;
}
