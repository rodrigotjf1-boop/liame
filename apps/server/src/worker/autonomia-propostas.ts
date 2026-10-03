import { type Tx, uuidv7 } from '@liame/database';
import { sql } from 'drizzle-orm';
import { activeTraceId, writeAudit } from '../audit/audit.js';
import { carregarPoliticas } from '../policy/policy.service.js';
import { ACAO_DA_FERRAMENTA, AMOSTRA_DEPOIS_DA_RECUSA, modoDaAcao, vezDaProposta } from '../sombra/autonomia.js';
import type { AcaoSombra } from '../sombra/regras.js';

// As propostas de promoção de autonomia (A3, I13). Ficam na pasta do worker porque gravam em escopo de sistema
// (regra `liame-escopo-sistema`): rodam logo depois do retrato da prontidão do dia, na mesma transação da sombra, com
// a empresa explícita em cada instrução. O sistema só PROPÕE (de Sombra para Sugerir, quando os cinco portões
// passam); quem aprova é uma pessoa, pela rota `/v1/autonomy`.

type Retrato = {
  id: string;
  connected_account_id: string;
  provider: string;
  tool: string;
  sample_size: number;
  missing: string[];
  rule_version: number;
  agreement_rate: string | null;
  worse_rate: string | null;
  regret: string;
  confidence_avg: string | null;
};
type Ultima = { id: string; connected_account_id: string; tool: string; status: string; next_sample_size: number | null };

export type ResultadoDasPropostas = { propostas: number; retiradas: number; encerradas: number };

const ehDaSombra = (tool: string): tool is AcaoSombra => tool in ACAO_DA_FERRAMENTA;

/**
 * A vez das propostas da marca depois do retrato do dia (`readiness_snapshot` de hoje): propõe onde os portões
 * passam e a ação ainda está em Sombra, retira a pendente que deixou de valer e encerra a aprovada que perdeu efeito
 * (a política voltou para Sombra por outro caminho). Cada mudança fica na auditoria, como o sistema.
 */
export async function proporPromocoes(tx: Tx, alvo: { tenantId: string; brandId: string; hoje: string }): Promise<ResultadoDasPropostas> {
  const resultado: ResultadoDasPropostas = { propostas: 0, retiradas: 0, encerradas: 0 };
  const retratos = (
    await tx.execute<Retrato>(sql`
      select r.id, r.connected_account_id, a.provider, r.tool, r.sample_size, r.missing, r.rule_version,
             r.agreement_rate::text as agreement_rate, r.worse_rate::text as worse_rate, r.regret_sum_micros::text as regret,
             r.confidence_avg::text as confidence_avg
        from liame.readiness_snapshot r join liame.connected_account a on a.id = r.connected_account_id
       where r.tenant_id = ${alvo.tenantId} and r.brand_id = ${alvo.brandId} and r.computed_on = ${alvo.hoje}::date and a.disconnected_at is null
       order by r.connected_account_id, r.tool`)
  ).rows;
  if (!retratos.length) return resultado;
  const ultimas = new Map(
    (
      await tx.execute<Ultima>(sql`
        select distinct on (connected_account_id, tool) id, connected_account_id, tool, status, next_sample_size
          from liame.autonomy_proposal
         where tenant_id = ${alvo.tenantId} and brand_id = ${alvo.brandId}
         order by connected_account_id, tool, (status = 'pendente') desc, created_at desc, id desc`)
    ).rows.map((u) => [`${u.connected_account_id}|${u.tool}`, u]),
  );
  const { policies } = await carregarPoliticas(tx, alvo.tenantId, alvo.brandId);

  for (const r of retratos) {
    if (!ehDaSombra(r.tool)) continue;
    const modo = modoDaAcao(policies, { tool: r.tool, brandId: alvo.brandId, provider: r.provider, accountId: r.connected_account_id }).mode;
    const ultima = ultimas.get(`${r.connected_account_id}|${r.tool}`) ?? null;
    const vez = vezDaProposta({ sampleSize: r.sample_size, missing: r.missing }, modo, ultima ? { status: ultima.status, nextSampleSize: ultima.next_sample_size } : null);
    const base = { connected_account_id: r.connected_account_id, tool: r.tool, action: ACAO_DA_FERRAMENTA[r.tool], sample_size: r.sample_size };

    if (vez === 'propor') {
      const id = uuidv7();
      const sinais = { agreement_rate: r.agreement_rate, worse_rate: r.worse_rate, regret_sum_micros: r.regret, confidence_avg: r.confidence_avg };
      const feito = await tx.execute(sql`
        insert into liame.autonomy_proposal (id, tenant_id, brand_id, connected_account_id, tool, action, from_mode, to_mode,
                                             readiness_snapshot_id, rule_version, sample_size, signals, status)
        values (${id}, ${alvo.tenantId}, ${alvo.brandId}, ${r.connected_account_id}, ${r.tool}, ${ACAO_DA_FERRAMENTA[r.tool]}, 'SHADOW', 'SUGGEST',
                ${r.id}, ${r.rule_version}, ${r.sample_size}, ${JSON.stringify(sinais)}::jsonb, 'pendente')
        on conflict do nothing`);
      if (!feito.rowCount) continue;
      await auditar(tx, alvo.tenantId, 'autonomia.propor', id, { ...base, from_mode: 'SHADOW', to_mode: 'SUGGEST' });
      resultado.propostas++;
    } else if (vez === 'retirar' && ultima) {
      const motivo = modo === 'SHADOW' ? 'Os portões da prontidão deixaram de passar.' : 'O modo da ação mudou por outro caminho.';
      const feito = await tx.execute(sql`
        update liame.autonomy_proposal set status = 'retirada', decided_at = now(), reason = ${motivo}, updated_at = now()
         where id = ${ultima.id} and tenant_id = ${alvo.tenantId} and status = 'pendente'`);
      if (!feito.rowCount) continue;
      await auditar(tx, alvo.tenantId, 'autonomia.retirar', ultima.id, { ...base, reason: motivo });
      resultado.retiradas++;
    } else if (vez === 'encerrar' && ultima) {
      const motivo = 'A política da marca voltou a ação para Sombra por outro caminho.';
      const feito = await tx.execute(sql`
        update liame.autonomy_proposal
           set status = 'desfeita', undone_at = now(), reason = ${motivo}, next_sample_size = ${r.sample_size + AMOSTRA_DEPOIS_DA_RECUSA}, updated_at = now()
         where id = ${ultima.id} and tenant_id = ${alvo.tenantId} and status = 'aprovada'`);
      if (!feito.rowCount) continue;
      await auditar(tx, alvo.tenantId, 'autonomia.encerrar', ultima.id, { ...base, reason: motivo });
      resultado.encerradas++;
    }
  }
  return resultado;
}

function auditar(tx: Tx, tenantId: string, action: string, id: string, after: Record<string, unknown>) {
  return writeAudit(tx, {
    tenantId,
    actorType: 'system',
    actorId: null,
    actorLabel: 'Liame',
    action,
    resourceType: 'autonomy_proposal',
    resourceId: id,
    after,
    traceId: activeTraceId(),
    origin: 'worker',
  });
}
