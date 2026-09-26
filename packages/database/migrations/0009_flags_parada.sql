-- 0009 · Feature flags (ADR-012) e kill switch (ADR-007, security-model §10).
-- Idempotente; uma transação por arquivo (ADR-018).

-- A semente grava com a RLS forçada (ERR-011).
select set_config('app.scope', 'sistema', true);

-- ------------------------------------------------------------ feature flags (da distribuição)

-- Flags são configuração da distribuição Regem/DMS: a empresa não lê nem edita a regra; recebe só
-- o valor avaliado para ela.
create table if not exists liame.feature_flag (
  key            text primary key check (key ~ '^[a-z][a-z0-9_]*$'),
  kind           text not null check (kind in ('boolean', 'string', 'number')),
  default_value  jsonb not null,
  description    text not null,
  owner          text not null,
  -- Flag que libera escrita em plataforma externa: nasce e fica desligada até decisão explícita.
  is_write       boolean not null default false,
  expires_on     date,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  check (not is_write or default_value = 'false'::jsonb)
);

create table if not exists liame.feature_flag_rule (
  id               uuid primary key,
  flag_key         text not null references liame.feature_flag (key) on delete cascade,
  -- Precedência: user > account > tenant > brand > plan > environment > padrão.
  scope_type       text not null check (scope_type in ('environment', 'plan', 'brand', 'tenant', 'account', 'user')),
  scope_id         text not null,
  value            jsonb not null,
  rollout_percent  integer check (rollout_percent between 0 and 100),
  starts_at        timestamptz,
  ends_at          timestamptz,
  created_by       text not null,
  created_at       timestamptz not null default now(),
  unique (flag_key, scope_type, scope_id)
);

alter table liame.feature_flag enable row level security;
alter table liame.feature_flag force row level security;
drop policy if exists feature_flag_sistema on liame.feature_flag;
create policy feature_flag_sistema on liame.feature_flag using (liame.system_scope()) with check (liame.system_scope());

alter table liame.feature_flag_rule enable row level security;
alter table liame.feature_flag_rule force row level security;
drop policy if exists feature_flag_rule_sistema on liame.feature_flag_rule;
create policy feature_flag_rule_sistema on liame.feature_flag_rule using (liame.system_scope()) with check (liame.system_scope());

grant select on liame.feature_flag, liame.feature_flag_rule to liame_app;

-- Flags de risco (ADR-012): todas de escrita, todas desligadas.
insert into liame.feature_flag (key, kind, default_value, description, owner, is_write) values
  ('meta_write', 'boolean', 'false', 'Escrita nas contas de anúncio da Meta', 'midia', true),
  ('google_write', 'boolean', 'false', 'Escrita nas contas do Google Ads', 'midia', true),
  ('autopilot', 'boolean', 'false', 'Execução automática sem aprovação (LIMITED_AUTO/AUTO)', 'produto', true),
  ('mcp_write', 'boolean', 'false', 'Ferramentas de escrita pelo MCP', 'plataforma', true),
  ('creative_generation', 'boolean', 'false', 'Geração de criativos com IA publicada nas plataformas', 'criacao', true),
  ('whatsapp_campaign', 'boolean', 'false', 'Campanhas de WhatsApp (via RegemCast)', 'mensageria', true)
on conflict (key) do nothing;

-- ------------------------------------------------------------ kill switch

-- Níveis: global · provider · tenant · brand · account · tool. Prevalece sobre qualquer flag.
create table if not exists liame.kill_switch (
  id              uuid primary key,
  level           text not null check (level in ('global', 'provider', 'tenant', 'brand', 'account', 'tool')),
  -- Global e provider são da distribuição (sem empresa); os demais são da empresa.
  tenant_id       uuid references liame.organization (id) on delete cascade,
  provider        text check (provider ~ '^[a-z0-9_]+$'),
  brand_id        uuid,
  account_id      text,
  tool            text,
  reason          text not null check (length(reason) between 3 and 500),
  activated_by    uuid,
  activated_at    timestamptz not null default now(),
  deactivated_by  uuid,
  deactivated_at  timestamptz,
  check (
    (level = 'global' and tenant_id is null and provider is null and brand_id is null and account_id is null and tool is null)
    or (level = 'provider' and tenant_id is null and provider is not null and brand_id is null and account_id is null and tool is null)
    or (level = 'tenant' and tenant_id is not null and brand_id is null and account_id is null and tool is null)
    or (level = 'brand' and tenant_id is not null and brand_id is not null and account_id is null and tool is null)
    or (level = 'account' and tenant_id is not null and provider is not null and account_id is not null and tool is null)
    or (level = 'tool' and tenant_id is not null and tool is not null and brand_id is null and account_id is null)
  )
);
create index if not exists idx_kill_switch_ativo on liame.kill_switch (tenant_id, level) where deactivated_at is null;

alter table liame.kill_switch enable row level security;
alter table liame.kill_switch force row level security;
-- Todos leem as travas da distribuição (sem empresa); cada empresa lê e aciona as suas.
drop policy if exists kill_switch_isolamento on liame.kill_switch;
create policy kill_switch_isolamento on liame.kill_switch
  using (tenant_id is null or tenant_id = liame.current_tenant_id() or liame.system_scope())
  with check (tenant_id = liame.current_tenant_id() or liame.system_scope());
grant select, insert, update on liame.kill_switch to liame_app;
