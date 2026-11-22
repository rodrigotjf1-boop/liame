-- O DMS Graph no Liame: editar a foto real da loja (plano "DMS Graph: recursos por produto", F4; protótipo aprovado pelo
-- dono em 22/11/2026, que muda a D-A6-6). A edição só mexe em luz, fundo, enquadramento e cenário; o produto não muda.
-- - `brand_photo`: a foto editada é uma linha NOVA, ligada à original (`edited_from_id`). Nasce `enviando` (a prévia, que
--   a rotina `fotos` limpa se ninguém guardar) e só fica `pronta` com a conferência da pessoa (`edit_confirmed_at`).
-- - `dms_graph_link`: a ligação da empresa com o Graph, uma viva por empresa; o segredo fica no cofre.
-- - `dms_graph_request`: o pedido de autorização em andamento (10 minutos, uma vez, preso a quem começou).
-- - a função `dms_graph_fotos`, desligada para todos.
-- Idempotente; uma transação por arquivo (ADR-018). Sem instrução destrutiva.

-- As sementes gravam em tabelas com RLS forçada (V20).
select set_config('app.scope', 'sistema', true);

-- ------------------------------------------------------------ a foto editada

alter table liame.brand_photo add column if not exists edited_at timestamptz;
alter table liame.brand_photo add column if not exists edited_from_id uuid references liame.brand_photo (id) on delete set null;
alter table liame.brand_photo add column if not exists edited_by uuid references liame.app_user (id) on delete set null;
alter table liame.brand_photo add column if not exists edit_options jsonb;
alter table liame.brand_photo add column if not exists edit_prompt text;
alter table liame.brand_photo add column if not exists edit_confirmed_at timestamptz;
alter table liame.brand_photo add column if not exists edit_confirmed_by uuid references liame.app_user (id) on delete set null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'brand_photo_edicao_check' and conrelid = 'liame.brand_photo'::regclass) then
    alter table liame.brand_photo add constraint brand_photo_edicao_check
      check (edited_at is null or (kind = 'foto_produto' and jsonb_typeof(edit_options) = 'object'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'brand_photo_pedido_check' and conrelid = 'liame.brand_photo'::regclass) then
    alter table liame.brand_photo add constraint brand_photo_pedido_check
      check (edit_prompt is null or char_length(edit_prompt) between 1 and 200);
  end if;
  -- A foto editada só fica pronta depois de uma pessoa conferir que o produto continua igual.
  if not exists (select 1 from pg_constraint where conname = 'brand_photo_edicao_conferida_check' and conrelid = 'liame.brand_photo'::regclass) then
    alter table liame.brand_photo add constraint brand_photo_edicao_conferida_check
      check (status <> 'pronta' or edited_at is null or edit_confirmed_at is not null);
  end if;
end $$;

create index if not exists idx_brand_photo_editada_de on liame.brand_photo (edited_from_id) where edited_from_id is not null;
create index if not exists idx_brand_photo_editada_por on liame.brand_photo (edited_by) where edited_by is not null;
create index if not exists idx_brand_photo_conferida_por on liame.brand_photo (edit_confirmed_by) where edit_confirmed_by is not null;

-- ------------------------------------------------------------ a ligação da empresa com o Graph

create table if not exists liame.dms_graph_link (
  id                  uuid primary key,
  tenant_id           uuid not null references liame.organization (id) on delete cascade,
  -- A ligação `dms_lg_graph_...`, no cofre.
  secret_id           uuid references liame.secret (id) on delete set null,
  prefix              text not null check (length(prefix) between 1 and 40),
  graph_account_id    text check (graph_account_id is null or length(graph_account_id) <= 100),
  graph_account_name  text check (graph_account_name is null or length(graph_account_name) <= 200),
  permissions         text[] not null default '{}',
  created_by          uuid references liame.app_user (id) on delete set null,
  created_by_name     text check (created_by_name is null or length(created_by_name) <= 160),
  created_at          timestamptz not null default now(),
  last_used_at        timestamptz,
  revoked_at          timestamptz,
  revoked_source      text check (revoked_source is null or revoked_source in ('pessoa', 'troca', 'graph')),
  revoked_by          text check (revoked_by is null or length(revoked_by) <= 160)
);

create unique index if not exists dms_graph_link_viva on liame.dms_graph_link (tenant_id) where revoked_at is null;
create index if not exists idx_dms_graph_link_empresa on liame.dms_graph_link (tenant_id, created_at desc);
create index if not exists idx_dms_graph_link_segredo on liame.dms_graph_link (secret_id) where secret_id is not null;
create index if not exists idx_dms_graph_link_quem on liame.dms_graph_link (created_by) where created_by is not null;

alter table liame.dms_graph_link enable row level security;
alter table liame.dms_graph_link force row level security;
do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'liame' and tablename = 'dms_graph_link' and policyname = 'dms_graph_link_isolamento') then
    create policy dms_graph_link_isolamento on liame.dms_graph_link
      using (tenant_id = liame.current_tenant_id() or liame.system_scope())
      with check (tenant_id = liame.current_tenant_id() or liame.system_scope());
  end if;
end $$;
grant select, insert, update on liame.dms_graph_link to liame_app;

-- ------------------------------------------------------------ o pedido de autorização em andamento

create table if not exists liame.dms_graph_request (
  id            uuid primary key,
  tenant_id     uuid not null references liame.organization (id) on delete cascade,
  user_id       uuid not null references liame.app_user (id) on delete cascade,
  -- O resumo do `state` (o state nunca é guardado) e o verificador do PKCE, cifrado com a chave da empresa.
  state_hash    text not null check (state_hash ~ '^[0-9a-f]{64}$'),
  verifier_enc  text not null,
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null,
  used_at       timestamptz
);

create unique index if not exists dms_graph_request_estado on liame.dms_graph_request (state_hash);
create index if not exists idx_dms_graph_request_empresa on liame.dms_graph_request (tenant_id, expires_at);
create index if not exists idx_dms_graph_request_quem on liame.dms_graph_request (user_id);

alter table liame.dms_graph_request enable row level security;
alter table liame.dms_graph_request force row level security;
do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'liame' and tablename = 'dms_graph_request' and policyname = 'dms_graph_request_isolamento') then
    create policy dms_graph_request_isolamento on liame.dms_graph_request
      using (tenant_id = liame.current_tenant_id() or liame.system_scope())
      with check (tenant_id = liame.current_tenant_id() or liame.system_scope());
  end if;
end $$;
grant select, insert, update, delete on liame.dms_graph_request to liame_app;

-- ------------------------------------------------------------ a função, desligada para todos

insert into liame.feature_flag (key, kind, default_value, description, owner, is_write)
values ('dms_graph_fotos', 'boolean', 'false',
        'DMS Graph (F4): conectar a empresa ao Graph e editar a luz, o fundo e o enquadramento da foto real, com a conferência de uma pessoa. A foto vai ao Google, fora do Brasil.',
        'social', false)
on conflict (key) do nothing;
