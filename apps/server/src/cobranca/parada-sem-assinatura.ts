import { type Tx, uuidv7 } from '@liame/database';
import { type SQL, sql } from 'drizzle-orm';
import { writeAudit } from '../audit/audit.js';
import { VIVAS_PAGAS } from './vida.js';

// A equipe parada sem assinatura paga (A7, W3, parte 4c; D-A7-4, D-A7-6 e D-A7-108). Com a cobrança ligada, a marca sem
// assinatura paga e viva (`ativa`, `em_atraso`, `acoes_paradas` ou `suspensa`) fica com as ações dos funcionários de IA
// paradas: a que nunca assinou, a que espera o primeiro pagamento (não há período grátis, D-A7-4) e a que terminou. É a
// parada que já existe, no nível da marca, acionada sem pessoa (`no_paid_subscription`, migration 0162), como a do 10º dia
// de atraso: a leitura e as telas continuam, e nada de anúncio é pausado pelo Liame. Uma pessoa não a desliga: quem tira é
// o primeiro pagamento (na hora) ou a cobrança desligada. A marca arquivada não fica parada.

/** O motivo da parada, como a empresa lê na lista das paradas e em Sua equipe. */
export const MOTIVO_DA_PARADA_SEM_ASSINATURA =
  'Cobrança: esta marca não tem assinatura paga. As ações dos funcionários de IA voltam assim que a primeira mensalidade for paga, em Plano e cobrança.';

const vivas = sql.join(
  VIVAS_PAGAS.map((s) => sql`${s}`),
  sql`, `,
);

/** A marca tem assinatura paga e viva (o atraso é da parada da cobrança, não desta). */
export const TEM_ASSINATURA_PAGA = (marca: SQL): SQL => sql`exists (
  select 1 from liame.subscription s where s.brand_id = ${marca} and s.status in (${vivas}))`;

const ROTULO = 'Liame (cobrança)';

export type AcertoDaParada = 'parou' | 'voltou' | 'nada';

/**
 * Acerta a parada da marca: parada, se a cobrança está ligada (`ligada`), a marca não está arquivada e não tem assinatura
 * paga e viva; senão, sem parada. Idempotente (o índice único segura duas voltas e o pagamento que chega junto), com a
 * auditoria só quando muda.
 */
export async function acertarParadaSemAssinatura(tx: Tx, alvo: { tenantId: string; brandId: string }, ligada: boolean, agora: Date): Promise<AcertoDaParada> {
  const quando = agora.toISOString();
  const m = (
    await tx.execute<{ paga: boolean; arquivada: boolean }>(sql`
      select ${TEM_ASSINATURA_PAGA(sql`b.id`)} as paga, b.archived_at is not null as arquivada
        from liame.brand b where b.id = ${alvo.brandId} and b.tenant_id = ${alvo.tenantId}`)
  ).rows[0];
  const parar = Boolean(m) && ligada && !m!.paga && !m!.arquivada;
  if (parar) {
    const r = await tx.execute<{ id: string }>(sql`
      insert into liame.kill_switch (id, level, tenant_id, brand_id, reason, activated_by, activated_at, no_paid_subscription)
      values (${uuidv7()}, 'brand', ${alvo.tenantId}, ${alvo.brandId}, ${MOTIVO_DA_PARADA_SEM_ASSINATURA}, null, ${quando}::timestamptz, true)
      on conflict do nothing
      returning id`);
    const id = r.rows[0]?.id;
    if (!id) return 'nada';
    await auditar(tx, alvo, 'cobranca.parar_acoes', { motivo: 'sem_assinatura_paga', parada: id });
    return 'parou';
  }
  const r = await tx.execute<{ id: string }>(sql`
    update liame.kill_switch set deactivated_at = ${quando}::timestamptz
     where tenant_id = ${alvo.tenantId} and brand_id = ${alvo.brandId} and no_paid_subscription and deactivated_at is null
     returning id`);
  const id = r.rows[0]?.id;
  if (!id) return 'nada';
  await auditar(tx, alvo, 'cobranca.voltar_acoes', { motivo: 'sem_assinatura_paga', parada: id });
  return 'voltou';
}

async function auditar(tx: Tx, alvo: { tenantId: string; brandId: string }, acao: string, depois: Record<string, unknown>): Promise<void> {
  await writeAudit(tx, {
    tenantId: alvo.tenantId,
    actorType: 'system',
    actorId: null,
    actorLabel: ROTULO,
    action: acao,
    resourceType: 'brand',
    resourceId: alvo.brandId,
    before: null,
    after: { brand_id: alvo.brandId, ...depois },
    origin: 'worker',
  });
}
