-- 0003 · Cofre (ADR-011, ADR-014, critério A1-13)
-- A chave mestra (KEK) nunca fica no banco: aqui só há chaves de dados EMBRULHADAS por ela.

-- Segredos: tokens de integração, segredo do app autenticador. Cada linha tem a própria chave de dados
-- (envelope), amarrada ao registro pelo contexto de cifragem: trocar o texto cifrado de linha não decifra.
create table if not exists liame.secret (
  id             uuid primary key,
  tenant_id      uuid references liame.organization (id) on delete cascade,
  owner_user_id  uuid references liame.app_user (id) on delete cascade,
  purpose        text not null check (purpose ~ '^[a-z_]+$'),
  key_version    integer not null check (key_version > 0),
  wrapped_dek    text not null,
  iv             text not null,
  ciphertext     text not null,
  created_at     timestamptz not null default now(),
  rotated_at     timestamptz,
  revoked_at     timestamptz,
  check (tenant_id is not null or owner_user_id is not null)
);
create unique index if not exists uq_secret_usuario_finalidade
  on liame.secret (owner_user_id, purpose) where tenant_id is null and revoked_at is null;
create index if not exists idx_secret_tenant on liame.secret (tenant_id);
create index if not exists idx_secret_versao on liame.secret (key_version) where revoked_at is null;

-- Chave de dados de cada empresa, para os dados pessoais (ADR-014). Fica embrulhada pela chave própria
-- da empresa no KMS (key_ref); destruir a chave no KMS torna ilegível até o que sobrar em backup.
create table if not exists liame.tenant_key (
  tenant_id     uuid primary key references liame.organization (id) on delete cascade,
  key_ref       text not null,
  wrapped_dek   text not null,
  created_at    timestamptz not null default now(),
  destroyed_at  timestamptz
);

alter table liame.secret enable row level security;
alter table liame.secret force row level security;
drop policy if exists secret_isolamento on liame.secret;
create policy secret_isolamento on liame.secret
  using (
    tenant_id = liame.current_tenant_id()
    or (tenant_id is null and owner_user_id = liame.current_user_id())
    or liame.system_scope()
  )
  with check (
    tenant_id = liame.current_tenant_id()
    or (tenant_id is null and owner_user_id = liame.current_user_id())
    or liame.system_scope()
  );

alter table liame.tenant_key enable row level security;
alter table liame.tenant_key force row level security;
drop policy if exists tenant_key_isolamento on liame.tenant_key;
create policy tenant_key_isolamento on liame.tenant_key
  using (tenant_id = liame.current_tenant_id() or liame.system_scope())
  with check (tenant_id = liame.current_tenant_id() or liame.system_scope());

grant select, insert, update on liame.secret to liame_app;
grant select, insert, update on liame.tenant_key to liame_app;
