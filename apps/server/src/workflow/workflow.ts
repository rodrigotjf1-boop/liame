import { type Tx, uuidv7 } from '@liame/database';
import { sql } from 'drizzle-orm';

// Estado durável de workflow (ADR-005): cada passo registra status e saída na transação de quem o
// executa. O passo que espera (aprovação) fica 'aguardando' sem job preso; o evento de retomada
// (aprovação, execução) grava o passo seguinte. Nada aqui chama serviço externo. A ordem dos passos é a
// do primeiro registro (`started_at` pelo relógio, não pelo início da transação).

export type RunStatus = 'em_andamento' | 'aguardando' | 'concluido' | 'falhou' | 'cancelado';
export type StepStatus = 'aguardando' | 'concluido' | 'falhou' | 'pulado';

export interface StepView {
  name: string;
  status: StepStatus;
  attempts: number;
  finished_at: string | null;
}

/** Garante o run do assunto (um por tipo e assunto) e devolve o id. */
export async function ensureRun(tx: Tx, input: { tenantId: string; kind: string; subjectId: string }): Promise<string> {
  const r = await tx.execute<{ id: string }>(sql`
    insert into liame.workflow_run (id, tenant_id, kind, subject_id, status)
    values (${uuidv7()}, ${input.tenantId}, ${input.kind}, ${input.subjectId}, 'em_andamento')
    on conflict (kind, subject_id) do update set updated_at = now()
    returning id`);
  return r.rows[0]!.id;
}

/** Grava (ou regrava, somando a tentativa) um passo. */
export async function recordStep(
  tx: Tx,
  input: { tenantId: string; runId: string; name: string; status: StepStatus; output?: Record<string, unknown> | null },
): Promise<void> {
  const finished = input.status === 'aguardando' ? null : new Date().toISOString();
  await tx.execute(sql`
    insert into liame.workflow_step (id, tenant_id, run_id, name, status, output, attempts, started_at, finished_at)
    values (${uuidv7()}, ${input.tenantId}, ${input.runId}, ${input.name}, ${input.status},
            ${input.output ? JSON.stringify(input.output) : null}::jsonb, 1, clock_timestamp(), ${finished})
    on conflict (run_id, name) do update
      set status = excluded.status, output = excluded.output, attempts = liame.workflow_step.attempts + 1,
          finished_at = excluded.finished_at`);
}

export async function setRun(tx: Tx, runId: string, status: RunStatus, currentStep: string | null): Promise<void> {
  await tx.execute(sql`update liame.workflow_run set status = ${status}, current_step = ${currentStep}, updated_at = now() where id = ${runId}`);
}

/** Atalho: garante o run, grava os passos em ordem e define o status. */
export async function advance(
  tx: Tx,
  input: { tenantId: string; kind: string; subjectId: string; steps: Array<{ name: string; status: StepStatus; output?: Record<string, unknown> | null }>; run: RunStatus },
): Promise<void> {
  const runId = await ensureRun(tx, input);
  for (const step of input.steps) await recordStep(tx, { tenantId: input.tenantId, runId, ...step });
  const waiting = input.steps.find((s) => s.status === 'aguardando');
  await setRun(tx, runId, input.run, waiting?.name ?? input.steps.at(-1)?.name ?? null);
}

export async function workflowOf(tx: Tx, kind: string, subjectIds: string[]): Promise<Map<string, { status: RunStatus; steps: StepView[] }>> {
  const out = new Map<string, { status: RunStatus; steps: StepView[] }>();
  if (!subjectIds.length) return out;
  const r = await tx.execute<{ subject_id: string; run_status: RunStatus; name: string | null; status: StepStatus | null; attempts: number | null; finished_at: Date | string | null }>(sql`
    select r.subject_id, r.status as run_status, s.name, s.status, s.attempts, s.finished_at
      from liame.workflow_run r left join liame.workflow_step s on s.run_id = r.id
     where r.kind = ${kind} and r.subject_id in ${subjectIds}
     order by r.subject_id, s.started_at, s.name`);
  for (const row of r.rows) {
    const entry = out.get(row.subject_id) ?? { status: row.run_status, steps: [] };
    if (row.name && row.status) {
      entry.steps.push({
        name: row.name,
        status: row.status,
        attempts: Number(row.attempts ?? 0),
        finished_at: row.finished_at ? new Date(row.finished_at).toISOString() : null,
      });
    }
    out.set(row.subject_id, entry);
  }
  return out;
}
