# ADR-005 — Runtime de workflows: pg-boss para entrega, estado durável no Postgres

- **Status:** Proposto · 24/09/2026
- **Decide:** como rodam os processos longos (sync, relatórios, planos que esperam aprovação, ações, compensações)

## Contexto

"Fila não é workflow." Um plano pode esperar aprovação por dias, e um relatório tem 7 passos com um só de IA. As ações financeiras exigem exatamente-uma-vez efetivo (idempotência) e retomada após queda. As diretrizes vetam Temporal, Redis e BullMQ sem necessidade comprovada.

## Opções

| Critério | A) **pg-boss + tabelas de workflow próprias** | B) Temporal | C) BullMQ + Redis | D) Supabase Queues (pgmq) + tabelas próprias |
| --- | --- | --- | --- | --- |
| Maturidade | pg-boss 12.34 (Postgres, SKIP LOCKED) | Alta | Alta | Nova |
| Complexidade | **Baixa**: um banco só | Alta (cluster, SDK, determinismo de workflow) | Média (+ Redis) | Baixa |
| Custo | Zero a mais | Serviço novo ou cloud | Redis | Zero |
| Transação com o domínio | Enfileirar na mesma transação (**confirmado**: `db: fromDrizzle(tx, sql)`) | Não | Não | Sim (SQL) |
| Observabilidade | Tabelas consultáveis + OTel | Excelente | Boa | Tabelas |
| Lock-in | Baixo | Médio | Baixo | Supabase |

## Decisão

**Opção A.**

- **pg-boss** entrega jobs, com retry exponencial, dead letter, agendamento (cron e `startAfter`) e singleton/throttle por chave, em filas separadas por criticidade (`actions`, `sync`, `ai`, `reports`, `webhooks-out`, `anchor`).
- **Estado do workflow em tabelas nossas:** `workflow_run`, `workflow_step`, `workflow_event`, `approval`, `tool_execution`, `action_execution`.
  - Cada passo é idempotente e registra entrada e saída.
  - O passo que espera (aprovação, janela de horário, dado fresco) fica `waiting` **sem job preso**.
  - O evento de retomada (aprovação concedida, timer) agenda o próximo passo.
- **Timers:** `startAfter` do pg-boss. **Aprovações expiram** por job agendado.
- **Contexto de tenant por job:** todo job carrega `tenant_id` e roda sob RLS (ADR-003); `traceparent` propagado (ADR-010).
- **Concorrência:** `worker_concurrency`, `provider_concurrency` e `tenant_concurrency` por fila, com justiça entre tenants (as cotas das plataformas são do app).
- **Sem Redis, BullMQ ou Temporal.** Reavaliar Temporal só se aparecerem workflows com dezenas de passos, versionamento de lógica em voo e SLAs que o modelo acima não sustente.

## Confirmado na pesquisa (pg-boss 12.34, inspeção do pacote)

- **Envio transacional:** `send(..., { db: fromDrizzle(tx, sql) })`. Se a transação sofrer rollback, o job também é desfeito. É o outbox sem tabela extra para jobs internos.
- **Justiça entre tenants:** `group: { id: tenant_id, tier }` no envio + `groupConcurrency` no worker, controlado globalmente pelo banco.
- **`flow()`:** DAG criado de forma atômica; dependentes nascem `blocked`, sem worker preso.
- **Políticas de fila:** `singleton`, `stately`, `exclusive`, `key_strict_fifo` (FIFO por chave); `sendThrottled` e `sendDebounced`; DLQ com `redrive`.
- **Aprovação:** o pg-boss não tem "sinal" como o Temporal. Decisão: **máquina de estados em tabela nossa** + `send` disparado pelo evento de aprovação + job de prazo com `startAfter`. É mais explícito que completar job na fila (`complete(..., { includeQueued: true })`). `retentionSeconds` ajustado para esperas longas.
- **Conexões:** o LISTEN/NOTIFY do pg-boss usa um `pg.Client` dedicado e precisa de **conexão direta (IPv4 add-on) ou Supavisor em modo sessão**. Os envios pela `tx` da aplicação funcionam no modo transação (locks são `pg_advisory_xact_lock`).

## A validar no spike da A0

Throughput com os limites de conexão do plano (Supabase Micro: 60 diretas, 200 no pooler) e separação das conexões: app pelo pooler, pg-boss e migrations em sessão ou direta.

## Consequências

Mais código nosso para o motor de passos, com o ganho de ser simples, transacional e observável no mesmo banco. O schema do pg-boss fica fora da RLS (é infraestrutura), mas **os payloads não carregam PII**: só IDs.
