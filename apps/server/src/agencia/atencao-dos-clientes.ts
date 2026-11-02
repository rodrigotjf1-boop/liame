import type { AgencyClientAttention } from '@liame/contracts';
import { type Database, withContext } from '@liame/database';
import { sql } from 'drizzle-orm';
import { pessoaPode } from '../auth/pessoa-pode.js';
import { FLAG_COBRANCA } from '../cobranca/assinatura.js';
import { passosDoAtraso } from '../cobranca/vida.js';
import type { FlagService } from '../flags/flag.service.js';

// O que pede atenção num cliente da agência (A7, W7, parte 1; D-A7-52). A leitura roda no contexto do próprio cliente,
// com a pessoa da agência que está no time dele: a RLS da empresa vale como em qualquer tela dela, e só entra o que o
// nível da pessoa ali deixa ver. A cobrança nunca aparece: a conta suspensa aparece só como "suspensa", com o Dono.

/** Os clientes lidos ao mesmo tempo (cada um numa transação curta, no contexto dele). */
export const CLIENTES_POR_VEZ = 5;

export async function atencaoDoCliente(
  database: Database,
  flags: FlagService,
  alvo: { tenantId: string; userId: string },
): Promise<AgencyClientAttention[]> {
  const { tenantId, userId } = alvo;
  return withContext(database.db, { tenantId, userId }, async (tx) => {
    const itens: AgencyClientAttention[] = [];
    // A conta suspensa (30º dia de atraso, com a função da cobrança ligada na marca): só o Dono entra, e a agência vê
    // desde quando e com quem falar (D-A7-52). O valor e a fatura ficam de fora. Com todas as marcas vivas suspensas, a
    // empresa inteira fecha para o time (D-A7-40): o aviso é `suspensa` e nada mais conta, porque ninguém da agência
    // entra para agir. Com só parte das marcas, `marca_suspensa`, e o resto segue.
    const suspensas = await tx.execute<{ brand_id: string; venc: string | null; vivas: number }>(sql`
      select s.brand_id,
             (select min(i.due_date)::text from liame.billing_invoice i
               where i.subscription_id = s.id and i.kind = 'mensalidade' and i.status = 'aberta') as venc,
             (select count(*)::int from liame.brand v where v.tenant_id = s.tenant_id and v.archived_at is null) as vivas
        from liame.subscription s join liame.brand b on b.id = s.brand_id and b.archived_at is null
       where s.tenant_id = ${tenantId} and s.status = 'suspensa'`);
    const desde: string[] = [];
    for (const s of suspensas.rows) {
      if (!s.venc) continue;
      if (!(await flags.isEnabled(FLAG_COBRANCA, flags.context({ tenantId, userId, brandId: s.brand_id })))) continue;
      desde.push(passosDoAtraso(s.venc).suspendeEm);
    }
    if (desde.length) {
      const dono = await tx.execute<{ name: string }>(sql`
        select u.name from liame.membership m join liame.app_user u on u.id = m.user_id
         where m.tenant_id = ${tenantId} and m.role_key = 'dono' and m.revoked_at is null
         limit 1`);
      const inteira = desde.length === suspensas.rows[0]!.vivas;
      const item: AgencyClientAttention = {
        kind: inteira ? 'suspensa' : 'marca_suspensa',
        count: desde.length,
        since: desde.sort()[0]!,
        owner_name: dono.rows[0]?.name ?? null,
      };
      if (inteira) return [item];
      itens.push(item);
    }
    // Os pedidos esperando, para quem aprova (a mesma conta do contador de Aprovações da empresa).
    if (await pessoaPode(tx, { tenantId, userId, permissao: 'acoes.aprovar' })) {
      const r = await tx.execute<{ n: number }>(sql`
        select count(*)::int as n from liame.action_request a
          left join liame.brand b on b.id = a.brand_id
         where a.tenant_id = ${tenantId} and a.status = 'aguardando_aprovacao' and (b.id is null or b.archived_at is null)`);
      const n = r.rows[0]?.n ?? 0;
      if (n > 0) itens.push({ kind: 'aprovacoes', count: n, since: null, owner_name: null });
    }
    // As contas que perderam o acesso, para quem opera.
    if (await pessoaPode(tx, { tenantId, userId, permissao: 'campanhas.operar' })) {
      const r = await tx.execute<{ n: number }>(sql`
        select count(*)::int as n from liame.connected_account c join liame.brand b on b.id = c.brand_id and b.archived_at is null
         where c.tenant_id = ${tenantId} and c.status in ('desconectada', 'sem_permissao', 'erro')`);
      const n = r.rows[0]?.n ?? 0;
      if (n > 0) itens.push({ kind: 'conta_desconectada', count: n, since: null, owner_name: null });
    }
    if (!itens.length) itens.push({ kind: 'em_dia', count: null, since: null, owner_name: null });
    return itens;
  });
}
