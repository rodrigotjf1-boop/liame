-- 0012 · Execução de ações e estado durável de workflow (ADR-005, ADR-007).
-- Idempotente; uma transação por arquivo (ADR-018).

-- ------------------------------------------------------------ execução

create table if not exists liame.action_execution (
  id                 uuid primary key,
  tenant_id          uuid not null references liame.organization (id) on delete cascade,
  action_request_id  uuid not null references liame.action_request (id) on delete cascade,
  plan_hash          text not null,
  -- Estado que o pedido esperava encontrar, o lido na hora e o desejado (ADR-007).
  expected_state     jsonb,
  expected_version   integer,
  observed_state     jsonb,
  desired_state      jsonb not null,
  result_state       jsonb,
  provider_version   integer,
  status             text not null check (status in ('executada', 'falhou', 'estado_mudou', 'bloqueada')),
  error              text,
  started_at         timestamptz not null,
  finished_at        timestamptz not null default now()
);
create index if not exists idx_action_execution_pedido on liame.action_execution (action_request_id);

alter table liame.action_execution enable row level security;
alter table liame.action_execution force row level security;
drop policy if exists action_execution_isolamento on liame.action_execution;
create policy action_execution_isolamento on liame.action_execution
  using (tenant_id = liame.current_tenant_id() or liame.system_scope())
  with check (tenant_id = liame.current_tenant_id() or liame.system_scope());
-- Registro de execução não muda depois de gravado.
grant select, insert on liame.action_execution to liame_app;

-- ------------------------------------------------------------ workflow

-- Estado durável (ADR-005): o passo que espera (aprovação) fica 'aguardando' sem job preso; o evento
-- de retomada (aprovação) libera o próximo passo.
create table if not exists liame.workflow_run (
  id            uuid primary key,
  tenant_id     uuid not null references liame.organization (id) on delete cascade,
  kind          text not null check (kind ~ '^[a-z_]+$'),
  subject_id    uuid not null,
  status        text not null check (status in ('em_andamento', 'aguardando', 'concluido', 'falhou', 'cancelado')),
  current_step  text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (kind, subject_id)
);

create table if not exists liame.workflow_step (
  id           uuid primary key,
  tenant_id    uuid not null references liame.organization (id) on delete cascade,
  run_id       uuid not null references liame.workflow_run (id) on delete cascade,
  name         text not null check (name ~ '^[a-z_]+$'),
  status       text not null check (status in ('aguardando', 'concluido', 'falhou', 'pulado')),
  output       jsonb,
  attempts     integer not null default 0,
  started_at   timestamptz not null default now(),
  finished_at  timestamptz,
  unique (run_id, name)
);

alter table liame.workflow_run enable row level security;
alter table liame.workflow_run force row level security;
drop policy if exists workflow_run_isolamento on liame.workflow_run;
create policy workflow_run_isolamento on liame.workflow_run
  using (tenant_id = liame.current_tenant_id() or liame.system_scope())
  with check (tenant_id = liame.current_tenant_id() or liame.system_scope());

alter table liame.workflow_step enable row level security;
alter table liame.workflow_step force row level security;
drop policy if exists workflow_step_isolamento on liame.workflow_step;
create policy workflow_step_isolamento on liame.workflow_step
  using (tenant_id = liame.current_tenant_id() or liame.system_scope())
  with check (tenant_id = liame.current_tenant_id() or liame.system_scope());

grant select, insert, update on liame.workflow_run to liame_app;
grant select, insert, update on liame.workflow_step to liame_app;
