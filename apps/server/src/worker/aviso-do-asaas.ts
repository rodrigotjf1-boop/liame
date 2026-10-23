import type { Tx } from '@liame/database';
import { sql } from 'drizzle-orm';
import { PROVIDER_ASAAS } from '../connectors/asaas/api-asaas.js';
import type { InboxRow } from './inbox-processor.js';

/** Id do Liame (a fatura vai ao Asaas no `externalReference`): conferido antes de virar `uuid` no SQL. */
const EH_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** O que o aviso diz da cobrança: o id dela no Asaas e o id da fatura do Liame, quando vêm e estão no formato. */
export function cobrancaDoAviso(corpo: string): { cobranca: string | null; fatura: string | null } {
  let aviso: unknown;
  try {
    aviso = JSON.parse(corpo);
  } catch {
    return { cobranca: null, fatura: null };
  }
  const pagamento = (aviso as { payment?: { id?: unknown; externalReference?: unknown } } | null)?.payment;
  const id = typeof pagamento?.id === 'string' && pagamento.id.length >= 1 && pagamento.id.length <= 100 ? pagamento.id : null;
  const referencia = typeof pagamento?.externalReference === 'string' && pagamento.externalReference.length === 36 ? pagamento.externalReference : null;
  return { cobranca: id, fatura: referencia && EH_UUID.test(referencia) ? referencia.toLowerCase() : null };
}

/**
 * O aviso do Asaas (A7, W2a, parte 2; D-A7-28): só serve de sinal. A fatura da cobrança fica devida para reler agora, e
 * quem decide é a releitura, na API (nada do corpo do aviso vira estado da fatura). Pelo id da cobrança, a fatura que já
 * a tem; pelo id da fatura, a que ainda está criando a dela (o aviso chegou antes de a referência ser gravada): a fila
 * da criação acha a cobrança pelo `externalReference` e, se já estiver paga, relê na hora.
 */
export async function avisoDoAsaas(tx: Tx, evento: InboxRow): Promise<void> {
  const { cobranca, fatura } = cobrancaDoAviso(evento.body);
  if (!cobranca && !fatura) return;
  await tx.execute(sql`
    update liame.billing_invoice
       set charge_next_at = now(), updated_at = now()
     where (provider = ${PROVIDER_ASAAS} and external_id = ${cobranca})
        or (id = ${fatura}::uuid and external_id is null)`);
}
