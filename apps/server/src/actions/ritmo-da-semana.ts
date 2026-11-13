import type { Tx } from '@liame/database';
import { sql } from 'drizzle-orm';
import { EstadoDoRitmo, ritmoDoRecurso, type SituacaoDoRitmo } from '../campanhas/ritmo-plano.js';
import type { ApplyOptions, ApplyResult, Connector, ReadResult, ResourceRef } from './connectors.js';
import type { ResourceState } from './tools.js';

// O ritmo da semana no trilho de ações (plano da região, R7, parte 1b; D-RG-62): o pedido semanal que a pessoa aprova
// com o código do app. O recurso é do próprio Liame (`ritmo:<id>`, a linha de `budget_rhythm`): ler é montar o estado da
// tabela que a pessoa vê, e aplicar é só marcar o ritmo como aprovado. NADA vai à Meta aqui: cada dia sai depois como um
// passo próprio (a verba de uma campanha), pelo conector de anúncios, com as travas, os limites e a validação de sempre.
// O conector entra pelo provedor `meta_ads` (a conta do pedido é a de anúncios): a trava e a flag de escrita da Meta
// seguram o ritmo junto com o resto.

const PROVIDER = 'meta_ads';

type Linha = { id: string; status: SituacaoDoRitmo; version: number; plan: unknown };

/** A linha do ritmo com a situação de agora no estado. Nula quando o recurso não é um ritmo desta conta. */
async function lerRitmo(tx: Tx, ref: ResourceRef, travar = false): Promise<{ linha: Linha; estado: EstadoDoRitmo } | null> {
  const id = ritmoDoRecurso(ref.resourceId);
  if (!id) return null;
  const l = (
    await tx.execute<Linha>(sql`
      select id, status, version, plan from liame.budget_rhythm
       where id = ${id} and tenant_id = ${ref.tenantId} and ad_account_id = ${ref.accountId}
       ${travar ? sql`for update` : sql``}`)
  ).rows[0];
  if (!l) return null;
  // A situação mora na coluna (muda com a aprovação, a parada e o fim); o resto do estado é o plano guardado.
  const estado = EstadoDoRitmo.safeParse({ ...(l.plan as Record<string, unknown>), situacao: l.status });
  return estado.success ? { linha: { ...l, version: Number(l.version) }, estado: estado.data } : null;
}

export class RitmoDaSemanaConnector implements Connector {
  readonly provider = PROVIDER;
  readonly writeFlag = 'meta_write';
  // Aprovar o ritmo não gasta: o passo que aumenta a verba de um dia é que passa pelos limites (o conector de anúncios).
  readonly requiresSpendLimits = true;
  readonly needsWriteAuthorization = true;

  async read(tx: Tx, ref: ResourceRef): Promise<ReadResult | null> {
    const lido = await lerRitmo(tx, ref);
    return lido ? { state: lido.estado as unknown as ResourceState, version: lido.linha.version } : null;
  }

  async apply(tx: Tx, ref: ResourceRef, desired: ResourceState, expectedVersion: number, options: ApplyOptions = {}): Promise<ApplyResult> {
    const lido = await lerRitmo(tx, ref, true);
    if (!lido) return { ok: false, reason: 'recusado', mensagem: 'O ritmo da semana não está mais aqui.' };
    const { linha, estado } = lido;
    const atual = { state: estado as unknown as ResourceState, version: linha.version };
    // Já aprovado (a aprovação que terminou e a resposta se perdeu): nada a fazer.
    if (linha.status === 'aprovado' && desired.situacao === 'aprovado') return { ok: true, ...atual };
    if (linha.version !== expectedVersion || linha.status !== 'pedido') return { ok: false, reason: 'estado-mudou', current: atual };
    if (options.validateOnly) return { ok: true, state: desired, version: linha.version };
    const r = await tx.execute<{ version: number }>(sql`
      update liame.budget_rhythm set status = 'aprovado', approved_at = now(), version = version + 1, updated_at = now()
       where id = ${linha.id} and tenant_id = ${ref.tenantId} and version = ${expectedVersion} and status = 'pedido'
       returning version`);
    const novo = r.rows[0];
    if (!novo) return { ok: false, reason: 'estado-mudou', current: atual };
    return { ok: true, state: { ...estado, situacao: 'aprovado' } as unknown as ResourceState, version: Number(novo.version) };
  }
}

export const ritmoDaSemanaConnector = new RitmoDaSemanaConnector();
