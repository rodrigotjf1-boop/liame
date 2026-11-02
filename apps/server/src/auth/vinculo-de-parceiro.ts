import { type Database, withSystem } from '@liame/database';
import { sql } from 'drizzle-orm';

// As leituras do vínculo de parceiro que atravessam as organizações (A7, W6, parte 2; ADR-017). A agência não enxerga
// as pessoas nem as empresas de fora, e a empresa não enxerga o time da agência; para o pedido chegar ao Dono certo e
// o aviso chegar ao outro lado, estas funções leem no escopo de sistema. Só leem; o resto do vínculo roda na transação
// da requisição, com a RLS dos dois lados (migration 0100).

/** A pessoa por trás do e-mail do pedido e as empresas ativas em que ela é Dono. Nulo: o e-mail não tem conta viva. */
export async function donoDoEmail(database: Database, email: string): Promise<{ userId: string; empresas: string[] } | null> {
  return withSystem(database.db, async (tx) => {
    const r = await tx.execute<{ id: string; empresas: string[] | null }>(sql`
      select u.id,
             array_agg(m.tenant_id::text order by m.tenant_id)
               filter (where m.role_key = 'dono' and o.status = 'ativa' and o.kind = 'empresa') as empresas
        from liame.app_user u
        left join liame.membership m on m.user_id = u.id and m.revoked_at is null
        left join liame.organization o on o.id = m.tenant_id
       where u.email = ${email} and u.disabled_at is null
       group by u.id`);
    const row = r.rows[0];
    return row ? { userId: row.id, empresas: row.empresas ?? [] } : null;
  });
}

/** Quem da agência recebe os avisos do vínculo: a dona e os administradores, com o e-mail confirmado. */
export async function quemAvisarNaAgencia(database: Database, agencyId: string): Promise<string[]> {
  return withSystem(database.db, async (tx) => {
    const r = await tx.execute<{ email: string }>(sql`
      select u.email from liame.membership m join liame.app_user u on u.id = m.user_id
       where m.tenant_id = ${agencyId} and m.role_key in ('agencia_dona', 'agencia_admin') and m.revoked_at is null
         and (m.expires_at is null or m.expires_at > now())
         and u.disabled_at is null and u.email_verified_at is not null
       order by u.email`);
    return r.rows.map((x) => x.email);
  });
}

/** Quem da empresa recebe os avisos do vínculo: o Dono, com o e-mail confirmado. */
export async function quemAvisarNaEmpresa(database: Database, tenantId: string): Promise<string[]> {
  return withSystem(database.db, async (tx) => {
    const r = await tx.execute<{ email: string }>(sql`
      select u.email from liame.membership m join liame.app_user u on u.id = m.user_id
       where m.tenant_id = ${tenantId} and m.role_key = 'dono' and m.revoked_at is null
         and u.disabled_at is null and u.email_verified_at is not null
       order by u.email`);
    return r.rows.map((x) => x.email);
  });
}
