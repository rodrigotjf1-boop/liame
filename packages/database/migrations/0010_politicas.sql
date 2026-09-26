-- 0010 · Políticas da empresa e da marca, versionadas (ADR-007, A1-11).
-- Idempotente; uma transação por arquivo (ADR-018).

-- A semente da permissão nova grava com a RLS forçada (ERR-011).
select set_config('app.scope', 'sistema', true);

create table if not exists liame.policy (
  id          uuid primary key,
  tenant_id   uuid not null references liame.organization (id) on delete cascade,
  -- Nula = política da empresa; preenchida = política da marca (mais específica).
  brand_id    uuid references liame.brand (id) on delete cascade,
  version     integer not null check (version >= 1),
  status      text not null check (status in ('ativa', 'arquivada')),
  document    jsonb not null,
  created_by  uuid not null references liame.app_user (id),
  created_at  timestamptz not null default now(),
  archived_at timestamptz
);
-- Versão única por escopo e uma só ativa por escopo.
create unique index if not exists uq_policy_versao on liame.policy (tenant_id, brand_id, version) nulls not distinct;
create unique index if not exists uq_policy_ativa on liame.policy (tenant_id, brand_id) nulls not distinct where status = 'ativa';

alter table liame.policy enable row level security;
alter table liame.policy force row level security;
drop policy if exists policy_isolamento on liame.policy;
create policy policy_isolamento on liame.policy
  using (tenant_id = liame.current_tenant_id() or liame.system_scope())
  with check (tenant_id = liame.current_tenant_id() or liame.system_scope());
-- Versão publicada não muda: só arquiva (status e archived_at).
grant select, insert on liame.policy to liame_app;
grant update (status, archived_at) on liame.policy to liame_app;

insert into liame.role_permission (tenant_id, role_key, permission)
values (null, 'dono', 'politicas.gerenciar'), (null, 'administrador', 'politicas.gerenciar')
on conflict do nothing;
