import { type Db, uuidv7, withSystem } from '@liame/database';
import { sql } from 'drizzle-orm';
import { writeAudit } from '../audit/audit.js';

// Ligar ou desligar uma flag para UMA empresa é decisão da distribuição (ADR-012): não há rota nem tela para
// isso. A regra fica no escopo da empresa (`tenant`), acima do padrão da flag; desligar apaga a regra, e a
// empresa volta ao padrão. Tudo numa transação, com a auditoria na cadeia da empresa.

export type FlagDaEmpresa = {
  flag: string;
  tenantId: string;
  ligada: boolean;
  /** Quem decidiu (nome da pessoa da distribuição), para a auditoria. */
  por: string;
  /** Por quê (pedido do cliente, piloto, incidente). */
  motivo: string;
};

export type FlagDefinida = { empresa: string; antes: boolean | null; padrao: boolean; valeAgora: boolean; mudou: boolean };

export async function definirFlagDaEmpresa(db: Db, p: FlagDaEmpresa): Promise<FlagDefinida> {
  const por = p.por.trim();
  const motivo = p.motivo.trim();
  if (por.length < 2 || por.length > 80) throw new Error('diga quem decidiu (--por), de 2 a 80 letras');
  if (motivo.length < 5 || motivo.length > 200) throw new Error('diga o motivo (--motivo), de 5 a 200 letras');
  return withSystem(db, async (tx) => {
    const flag = (await tx.execute<{ kind: string; default_value: unknown }>(sql`select kind, default_value from liame.feature_flag where key = ${p.flag}`)).rows[0];
    if (!flag) throw new Error(`a flag "${p.flag}" não existe`);
    if (flag.kind !== 'boolean') throw new Error(`a flag "${p.flag}" não é de ligar e desligar`);
    const empresa = (await tx.execute<{ name: string; status: string }>(sql`select name, status from liame.organization where id = ${p.tenantId} for update`)).rows[0];
    if (!empresa) throw new Error('empresa não encontrada');
    if (p.ligada && empresa.status !== 'ativa') throw new Error(`a empresa está ${empresa.status}: não dá para ligar função nova nela`);

    const regra = (
      await tx.execute<{ value: unknown }>(sql`select value from liame.feature_flag_rule where flag_key = ${p.flag} and scope_type = 'tenant' and scope_id = ${p.tenantId}`)
    ).rows[0];
    const antes = regra ? regra.value === true : null;
    const padrao = flag.default_value === true;
    if (p.ligada) {
      await tx.execute(sql`
        insert into liame.feature_flag_rule (id, flag_key, scope_type, scope_id, value, rollout_percent, created_by)
        values (${uuidv7()}, ${p.flag}, 'tenant', ${p.tenantId}, 'true'::jsonb, null, ${`distribuição: ${por}`})
        on conflict (flag_key, scope_type, scope_id) do update set value = excluded.value, rollout_percent = null, starts_at = null, ends_at = null,
                                                                    created_by = excluded.created_by, created_at = now()`);
    } else {
      await tx.execute(sql`delete from liame.feature_flag_rule where flag_key = ${p.flag} and scope_type = 'tenant' and scope_id = ${p.tenantId}`);
    }
    const valeAgora = p.ligada ? true : padrao;
    // Ligar o que já tinha a regra ligada, ou desligar o que não tinha regra, não muda nada (nem vira auditoria).
    const mudou = p.ligada ? antes !== true : antes !== null;
    if (mudou) {
      await writeAudit(tx, {
        tenantId: p.tenantId,
        actorType: 'system',
        actorId: null,
        actorLabel: `Distribuição DMS (${por})`,
        action: p.ligada ? 'flag.ligar' : 'flag.desligar',
        resourceType: 'feature_flag',
        resourceId: p.flag,
        before: { regra_da_empresa: antes, padrao },
        after: { regra_da_empresa: p.ligada ? true : null, vale_agora: valeAgora },
        reason: motivo,
        origin: 'console',
      });
    }
    return { empresa: empresa.name, antes, padrao, valeAgora, mudou };
  });
}
