-- 0002 · Identidade e tenancy (ADR-003, ADR-013, ADR-017, plano da A1 E2)
--
-- Contexto por transação (set_config(..., true)), nunca por sessão (LIC-004):
--   app.tenant_id -> organização do request
--   app.user_id   -> pessoa que age
--   app.scope     -> 'tenant' (padrão) ou 'sistema'
-- Sem contexto, as políticas não casam e nada aparece: fail-closed.
-- O escopo 'sistema' existe só para o que precisa enxergar antes de saber o tenant
-- (login, sessão, convite, jobs). No código, só por withSystem() (regra do Semgrep).

create or replace function liame.current_user_id() returns uuid
  language sql stable
  as $$ select nullif(current_setting('app.user_id', true), '')::uuid $$;

create or replace function liame.system_scope() returns boolean
  language sql stable
  as $$ select coalesce(current_setting('app.scope', true), 'tenant') = 'sistema' $$;

revoke all on function liame.current_user_id() from public;
revoke all on function liame.system_scope() from public;
grant execute on function liame.current_user_id(), liame.system_scope() to liame_app;

create or replace function liame.touch_updated_at() returns trigger
  language plpgsql
  as $$ begin new.updated_at = now(); return new; end $$;

-- ------------------------------------------------------------ organização (tenant)

create table if not exists liame.organization (
  id          uuid primary key,
  name        text not null check (length(trim(name)) between 1 and 200),
  cnpj        text check (cnpj ~ '^[0-9]{14}$'),
  timezone    text not null default 'America/Sao_Paulo',
  status      text not null default 'ativa' check (status in ('ativa', 'suspensa', 'encerrada')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ------------------------------------------------------------ pessoa (global: uma pessoa, várias empresas)

create table if not exists liame.app_user (
  id                 uuid primary key,
  email              text not null unique check (email = lower(email) and position('@' in email) > 1),
  name               text not null check (length(trim(name)) between 1 and 200),
  password_hash      text not null,
  email_verified_at  timestamptz,
  disabled_at        timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- ------------------------------------------------------------ vínculo pessoa × empresa (ADR-017)

create table if not exists liame.membership (
  id                    uuid primary key,
  tenant_id             uuid not null references liame.organization (id) on delete cascade,
  user_id               uuid not null references liame.app_user (id) on delete cascade,
  role_key              text not null,
  approve_limit_micros  bigint check (approve_limit_micros >= 0),
  dual_approval         boolean not null default true,
  billing_access        boolean not null default false,
  expires_at            timestamptz,
  invited_by            uuid references liame.app_user (id),
  created_at            timestamptz not null default now(),
  revoked_at            timestamptz
);
create unique index if not exists uq_membership_ativa on liame.membership (tenant_id, user_id) where revoked_at is null;
create unique index if not exists uq_membership_dono on liame.membership (tenant_id) where role_key = 'dono' and revoked_at is null;
create index if not exists idx_membership_user on liame.membership (user_id) where revoked_at is null;

-- ------------------------------------------------------------ marca e unidade

create table if not exists liame.brand (
  id          uuid primary key,
  tenant_id   uuid not null references liame.organization (id) on delete cascade,
  name        text not null check (length(trim(name)) between 1 and 200),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists idx_brand_tenant on liame.brand (tenant_id);

create table if not exists liame.unit (
  id          uuid primary key,
  tenant_id   uuid not null references liame.organization (id) on delete cascade,
  brand_id    uuid not null references liame.brand (id) on delete cascade,
  name        text not null check (length(trim(name)) between 1 and 200),
  timezone    text not null default 'America/Sao_Paulo',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists idx_unit_tenant on liame.unit (tenant_id);

-- ------------------------------------------------------------ sessão (cookie opaco; o banco guarda só o hash)

create table if not exists liame.session (
  id                uuid primary key,
  token_hash        text not null unique,
  user_id           uuid not null references liame.app_user (id) on delete cascade,
  active_tenant_id  uuid references liame.organization (id) on delete set null,
  mfa_verified_at   timestamptz,
  ip                inet,
  user_agent        text,
  created_at        timestamptz not null default now(),
  last_seen_at      timestamptz not null default now(),
  expires_at        timestamptz not null,
  revoked_at        timestamptz
);
create index if not exists idx_session_user on liame.session (user_id) where revoked_at is null;

-- ------------------------------------------------------------ tokens de uso único (confirmar e-mail, redefinir senha)

create table if not exists liame.user_token (
  id          uuid primary key,
  user_id     uuid not null references liame.app_user (id) on delete cascade,
  purpose     text not null check (purpose in ('confirmar_email', 'redefinir_senha')),
  token_hash  text not null unique,
  expires_at  timestamptz not null,
  used_at     timestamptz,
  created_at  timestamptz not null default now()
);
create index if not exists idx_user_token_user on liame.user_token (user_id, purpose);

-- ------------------------------------------------------------ limite de tentativas (login, cadastro, reenvio)

create table if not exists liame.rate_limit (
  key           text not null,
  window_start  timestamptz not null,
  hits          integer not null default 0,
  primary key (key, window_start)
);

-- ------------------------------------------------------------ gatilhos

drop trigger if exists tg_organization_touch on liame.organization;
create trigger tg_organization_touch before update on liame.organization for each row execute function liame.touch_updated_at();
drop trigger if exists tg_app_user_touch on liame.app_user;
create trigger tg_app_user_touch before update on liame.app_user for each row execute function liame.touch_updated_at();
drop trigger if exists tg_brand_touch on liame.brand;
create trigger tg_brand_touch before update on liame.brand for each row execute function liame.touch_updated_at();
drop trigger if exists tg_unit_touch on liame.unit;
create trigger tg_unit_touch before update on liame.unit for each row execute function liame.touch_updated_at();

-- ------------------------------------------------------------ RLS (ENABLE + FORCE + política, na mesma migration: ADR-003)

alter table liame.organization enable row level security;
alter table liame.organization force row level security;
drop policy if exists organization_isolamento on liame.organization;
create policy organization_isolamento on liame.organization
  using (
    id = liame.current_tenant_id()
    or liame.system_scope()
    or exists (select 1 from liame.membership m
                where m.tenant_id = organization.id and m.user_id = liame.current_user_id() and m.revoked_at is null)
  )
  with check (id = liame.current_tenant_id() or liame.system_scope());

alter table liame.app_user enable row level security;
alter table liame.app_user force row level security;
drop policy if exists app_user_isolamento on liame.app_user;
create policy app_user_isolamento on liame.app_user
  using (
    id = liame.current_user_id()
    or liame.system_scope()
    or exists (select 1 from liame.membership m
                where m.user_id = app_user.id and m.tenant_id = liame.current_tenant_id())
  )
  with check (id = liame.current_user_id() or liame.system_scope());

alter table liame.membership enable row level security;
alter table liame.membership force row level security;
drop policy if exists membership_isolamento on liame.membership;
create policy membership_isolamento on liame.membership
  using (tenant_id = liame.current_tenant_id() or user_id = liame.current_user_id() or liame.system_scope())
  with check (tenant_id = liame.current_tenant_id() or liame.system_scope());

alter table liame.brand enable row level security;
alter table liame.brand force row level security;
drop policy if exists brand_isolamento on liame.brand;
create policy brand_isolamento on liame.brand
  using (tenant_id = liame.current_tenant_id() or liame.system_scope())
  with check (tenant_id = liame.current_tenant_id() or liame.system_scope());

alter table liame.unit enable row level security;
alter table liame.unit force row level security;
drop policy if exists unit_isolamento on liame.unit;
create policy unit_isolamento on liame.unit
  using (tenant_id = liame.current_tenant_id() or liame.system_scope())
  with check (tenant_id = liame.current_tenant_id() or liame.system_scope());

alter table liame.session enable row level security;
alter table liame.session force row level security;
drop policy if exists session_isolamento on liame.session;
create policy session_isolamento on liame.session
  using (user_id = liame.current_user_id() or liame.system_scope())
  with check (user_id = liame.current_user_id() or liame.system_scope());

alter table liame.user_token enable row level security;
alter table liame.user_token force row level security;
drop policy if exists user_token_sistema on liame.user_token;
create policy user_token_sistema on liame.user_token
  using (liame.system_scope()) with check (liame.system_scope());

alter table liame.rate_limit enable row level security;
alter table liame.rate_limit force row level security;
drop policy if exists rate_limit_sistema on liame.rate_limit;
create policy rate_limit_sistema on liame.rate_limit
  using (liame.system_scope()) with check (liame.system_scope());

-- ------------------------------------------------------------ GRANTs (só o necessário, tabela por tabela: ADR-018)

grant select, insert, update on liame.organization to liame_app;
grant select, insert, update on liame.app_user to liame_app;
grant select, insert, update on liame.membership to liame_app;
grant select, insert, update, delete on liame.brand to liame_app;
grant select, insert, update, delete on liame.unit to liame_app;
grant select, insert, update on liame.session to liame_app;
grant select, insert, update on liame.user_token to liame_app;
grant select, insert, update, delete on liame.rate_limit to liame_app;
