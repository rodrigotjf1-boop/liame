import type { Tx } from '@liame/database';
import { sql } from 'drizzle-orm';
import { NIVEL_DA_COBRANCA_LIBERADA, PERMISSOES_DA_COBRANCA_LIBERADA } from './permissions.js';

/**
 * A permissão vem também do acesso à cobrança que o Dono libera ao Administrador (ADR-017; D-A7-13), como na sessão:
 * o ramo só entra quando a permissão pedida é uma das que esse acesso dá.
 */
function pelaCobrancaLiberada(permissao: string) {
  return (PERMISSOES_DA_COBRANCA_LIBERADA as readonly string[]).includes(permissao)
    ? sql`(m.billing_access and m.role_key = ${NIVEL_DA_COBRANCA_LIBERADA})`
    : sql`false`;
}

/**
 * A pessoa tem esta permissão na empresa, agora? O vínculo precisa estar ativo (não revogado, não vencido), a conta
 * dela não pode estar desativada, e o papel dela precisa ter a permissão: pelo conjunto próprio da empresa para o
 * papel, se houver; senão, pelo padrão do Liame; ou pelo acesso à cobrança liberado pelo Dono (o mesmo critério da
 * sessão, `session.service.ts`).
 *
 * Serve a quem age em nome de uma pessoa sem a sessão dela (a rotina que faz o pedido do funcionário de IA): o que é
 * feito em nome de alguém nunca vale mais do que essa pessoa pode agora.
 */
export async function pessoaPode(tx: Tx, alvo: { tenantId: string; userId: string; permissao: string }): Promise<boolean> {
  const r = await tx.execute<{ pode: boolean }>(sql`
    select exists (
      select 1
        from liame.membership m
        join liame.app_user u on u.id = m.user_id and u.disabled_at is null
       where m.tenant_id = ${alvo.tenantId} and m.user_id = ${alvo.userId}
         and m.revoked_at is null and (m.expires_at is null or m.expires_at > now())
         and (exists (
           select 1 from liame.role_permission rp
            where rp.role_key = m.role_key and rp.permission = ${alvo.permissao}
              and rp.tenant_id is not distinct from (select t.tenant_id from liame.role_permission t
                                                       where t.tenant_id = m.tenant_id and t.role_key = m.role_key limit 1))
              or ${pelaCobrancaLiberada(alvo.permissao)})
    ) as pode`);
  return r.rows[0]?.pode === true;
}

/**
 * Quem tem esta permissão na empresa, agora, e pode receber um aviso por e-mail: o mesmo critério de `pessoaPode`
 * (vínculo ativo, conta não desativada, o papel com a permissão ou o acesso à cobrança liberado), mais o e-mail
 * confirmado. Serve à rotina que avisa as pessoas certas sem a sessão de ninguém (o pedido que passou a poder ser
 * aprovado).
 */
export async function pessoasQuePodem(tx: Tx, alvo: { tenantId: string; permissao: string }): Promise<Array<{ id: string; email: string }>> {
  const r = await tx.execute<{ id: string; email: string }>(sql`
    select u.id, u.email
      from liame.membership m
      join liame.app_user u on u.id = m.user_id and u.disabled_at is null and u.email_verified_at is not null
     where m.tenant_id = ${alvo.tenantId}
       and m.revoked_at is null and (m.expires_at is null or m.expires_at > now())
       and (exists (
         select 1 from liame.role_permission rp
          where rp.role_key = m.role_key and rp.permission = ${alvo.permissao}
            and rp.tenant_id is not distinct from (select t.tenant_id from liame.role_permission t
                                                     where t.tenant_id = m.tenant_id and t.role_key = m.role_key limit 1))
            or ${pelaCobrancaLiberada(alvo.permissao)})
     order by u.id`);
  return r.rows;
}
