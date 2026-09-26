-- 0011 · Pedido de ação, aprovação amarrada ao plano, orçamento com reserva e conector sandbox (ADR-007).
-- Idempotente; uma transação por arquivo (ADR-018).

-- A semente das permissões grava com a RLS forçada (ERR-011).
select set_config('app.scope', 'sistema', true);

-- ------------------------------------------------------------ conector sandbox

-- Um provedor de mentira dentro do banco, por empresa: prova o fluxo inteiro sem tocar plataforma real
-- (A1-9) e serve de demonstração. Os connectors reais chegam na A2.
create table if not exists liame.sandbox_resource (
  tenant_id    uuid not null references liame.organization (id) on delete cascade,
  account_id   text not null check (length(account_id) between 1 and 100),
  resource_id  text not null check (length(resource_id) between 1 and 100),
  state        jsonb not null,
  version      integer not null default 1,
  updated_at   timestamptz not null default now(),
  primary key (tenant_id, account_id, resource_id)
);
alter table liame.sandbox_resource enable row level security;
alter table liame.sandbox_resource force row level security;
drop policy if exists sandbox_resource_isolamento on liame.sandbox_resource;
create policy sandbox_resource_isolamento on liame.sandbox_resource
  using (tenant_id = liame.current_tenant_id() or liame.system_scope())
  with check (tenant_id = liame.current_tenant_id() or liame.system_scope());
grant select, insert, update on liame.sandbox_resource to liame_app;

-- ------------------------------------------------------------ pedido de ação

create table if not exists liame.action_request (
  id                    uuid primary key,
  tenant_id             uuid not null references liame.organization (id) on delete cascade,
  brand_id              uuid references liame.brand (id) on delete set null,
  tool                  text not null check (tool ~ '^[a-z0-9_]+$'),
  action                text not null check (action ~ '^[a-z_]+\.[a-z_]+$'),
  provider              text not null check (provider ~ '^[a-z0-9_]+$'),
  account_id            text not null,
  resource_id           text not null,
  params                jsonb not null,
  risk_level            text not null check (risk_level in ('R0', 'R1', 'R2', 'R3')),
  budget_impact         text not null check (budget_impact in ('none', 'increase', 'decrease', 'new_spend')),
  value_micros          bigint,
  current_value_micros  bigint,
  reserved_micros       bigint not null default 0 check (reserved_micros >= 0),
  -- Estado lido no provedor na hora do pedido: na execução, se o atual for outro, alguém mexeu e não sobrescreve.
  before_state          jsonb,
  before_version        integer,
  desired_state         jsonb not null,
  -- Hash do plano: aprovação só vale para este hash; mudou o plano, a aprovação antiga não vale.
  plan_hash             text not null,
  -- Mesma ferramenta no mesmo recurso: só um pedido ativo por vez (A1-8).
  action_fingerprint    text not null,
  mode                  text not null check (mode in ('SHADOW', 'SUGGEST', 'APPROVAL', 'LIMITED_AUTO', 'AUTO', 'ESCALATE')),
  policy_decision       jsonb not null,
  status                text not null check (status in ('sombra', 'aguardando_aprovacao', 'aprovada', 'executando', 'executada', 'falhou', 'cancelada', 'expirada')),
  status_reason         text,
  actor_type            text not null default 'human' check (actor_type in ('human', 'agent', 'integration', 'system', 'partner')),
  requested_by          uuid not null references liame.app_user (id),
  expires_at            timestamptz not null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create unique index if not exists uq_action_fingerprint_ativa on liame.action_request (tenant_id, action_fingerprint)
  where status in ('aguardando_aprovacao', 'aprovada', 'executando');
create index if not exists idx_action_request_tenant on liame.action_request (tenant_id, created_at desc);
create index if not exists idx_action_request_fila on liame.action_request (status, updated_at) where status in ('aprovada', 'aguardando_aprovacao', 'executando');

alter table liame.action_request enable row level security;
alter table liame.action_request force row level security;
drop policy if exists action_request_isolamento on liame.action_request;
create policy action_request_isolamento on liame.action_request
  using (tenant_id = liame.current_tenant_id() or liame.system_scope())
  with check (tenant_id = liame.current_tenant_id() or liame.system_scope());
grant select, insert, update on liame.action_request to liame_app;

-- ------------------------------------------------------------ aprovação

create table if not exists liame.approval (
  id                     uuid primary key,
  tenant_id              uuid not null references liame.organization (id) on delete cascade,
  action_request_id      uuid not null references liame.action_request (id) on delete cascade,
  plan_hash              text not null,
  approved_by            uuid not null references liame.app_user (id),
  approver_role          text not null,
  approver_limit_micros  bigint,
  -- A aprovação basta sozinha (limite cobre o valor), ou precisa também do dono (ADR-017).
  sufficient             boolean not null,
  method                 text not null check (method in ('totp')),
  created_at             timestamptz not null default now(),
  unique (action_request_id, approved_by, plan_hash)
);
alter table liame.approval enable row level security;
alter table liame.approval force row level security;
drop policy if exists approval_isolamento on liame.approval;
create policy approval_isolamento on liame.approval
  using (tenant_id = liame.current_tenant_id() or liame.system_scope())
  with check (tenant_id = liame.current_tenant_id() or liame.system_scope());
grant select, insert on liame.approval to liame_app;

-- ------------------------------------------------------------ orçamento

-- Envelope do mês por empresa (brand_id nulo) ou por marca. A linha também é a trava do ledger.
create table if not exists liame.budget_policy (
  id            uuid primary key,
  tenant_id     uuid not null references liame.organization (id) on delete cascade,
  brand_id      uuid references liame.brand (id) on delete cascade,
  limit_micros  bigint not null check (limit_micros >= 0),
  created_by    uuid not null references liame.app_user (id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create unique index if not exists uq_budget_policy on liame.budget_policy (tenant_id, brand_id) nulls not distinct;

-- requested → reserved → executed (ADR-007): reserva e liberação mexem no comprometido; execução registra o feito.
create table if not exists liame.budget_ledger_entry (
  id                 uuid primary key,
  tenant_id          uuid not null references liame.organization (id) on delete cascade,
  brand_id           uuid,
  period             text not null check (period ~ '^\d{4}-\d{2}$'),
  action_request_id  uuid references liame.action_request (id) on delete set null,
  kind               text not null check (kind in ('reserva', 'liberacao', 'execucao')),
  amount_micros      bigint not null check (amount_micros >= 0),
  created_at         timestamptz not null default now()
);
create index if not exists idx_budget_ledger_periodo on liame.budget_ledger_entry (tenant_id, period, brand_id);

alter table liame.budget_policy enable row level security;
alter table liame.budget_policy force row level security;
drop policy if exists budget_policy_isolamento on liame.budget_policy;
create policy budget_policy_isolamento on liame.budget_policy
  using (tenant_id = liame.current_tenant_id() or liame.system_scope())
  with check (tenant_id = liame.current_tenant_id() or liame.system_scope());

alter table liame.budget_ledger_entry enable row level security;
alter table liame.budget_ledger_entry force row level security;
drop policy if exists budget_ledger_entry_isolamento on liame.budget_ledger_entry;
create policy budget_ledger_entry_isolamento on liame.budget_ledger_entry
  using (tenant_id = liame.current_tenant_id() or liame.system_scope())
  with check (tenant_id = liame.current_tenant_id() or liame.system_scope());

grant select, insert, update on liame.budget_policy to liame_app;
-- O ledger só cresce.
grant select, insert on liame.budget_ledger_entry to liame_app;

-- ------------------------------------------------------------ permissão nova

insert into liame.role_permission (tenant_id, role_key, permission)
values (null, 'dono', 'orcamento.gerenciar'), (null, 'administrador', 'orcamento.gerenciar')
on conflict do nothing;
