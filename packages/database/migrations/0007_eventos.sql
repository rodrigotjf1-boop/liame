-- 0007 · Eventos e idempotência (ADR-004): outbox, webhooks de saída, inbox e Idempotency-Key.
-- Idempotente; uma transação por arquivo (ADR-018).

-- A semente da permissão nova grava com a RLS forçada (ERR-011).
select set_config('app.scope', 'sistema', true);

-- ------------------------------------------------------------ outbox (mesma transação da mutação)

create table if not exists liame.outbox_event (
  id            uuid primary key,
  tenant_id     uuid references liame.organization (id) on delete cascade,
  -- CloudEvents `type`: contrato público, em inglês (liame.<recurso>.<fato>).
  type          text not null check (type ~ '^liame\.[a-z_]+\.[a-z_]+$'),
  subject       text,
  data          jsonb not null,
  occurred_at   timestamptz not null default now(),
  published_at  timestamptz,
  created_at    timestamptz not null default now()
);
create index if not exists idx_outbox_pendente on liame.outbox_event (created_at) where published_at is null;

alter table liame.outbox_event enable row level security;
alter table liame.outbox_event force row level security;
drop policy if exists outbox_event_isolamento on liame.outbox_event;
create policy outbox_event_isolamento on liame.outbox_event
  using (tenant_id = liame.current_tenant_id() or liame.system_scope())
  with check (tenant_id = liame.current_tenant_id() or liame.system_scope());
grant select, insert, update on liame.outbox_event to liame_app;

-- ------------------------------------------------------------ webhooks de saída (Standard Webhooks)

create table if not exists liame.webhook_endpoint (
  id           uuid primary key,
  tenant_id    uuid not null references liame.organization (id) on delete cascade,
  url          text not null check (url ~ '^https?://'),
  description  text,
  -- Vazio = todos os tipos de evento.
  event_types  text[] not null default '{}',
  -- O segredo de assinatura fica no cofre (ADR-011), nunca em texto no banco.
  secret_id    uuid not null references liame.secret (id),
  created_by   uuid not null references liame.app_user (id),
  created_at   timestamptz not null default now(),
  disabled_at  timestamptz
);
create index if not exists idx_webhook_endpoint_tenant on liame.webhook_endpoint (tenant_id) where disabled_at is null;

create table if not exists liame.webhook_delivery (
  id                uuid primary key,
  tenant_id         uuid not null references liame.organization (id) on delete cascade,
  endpoint_id       uuid not null references liame.webhook_endpoint (id) on delete cascade,
  event_id          uuid not null references liame.outbox_event (id) on delete cascade,
  -- pendente → entregue | morta (fila de mortos: esgotou as tentativas; reenvio manual volta a pendente).
  status            text not null default 'pendente' check (status in ('pendente', 'entregue', 'morta')),
  attempts          integer not null default 0,
  next_attempt_at   timestamptz not null default now(),
  last_status_code  integer,
  last_error        text,
  delivered_at      timestamptz,
  created_at        timestamptz not null default now(),
  unique (endpoint_id, event_id)
);
create index if not exists idx_webhook_delivery_devida on liame.webhook_delivery (next_attempt_at) where status = 'pendente';
create index if not exists idx_webhook_delivery_tenant on liame.webhook_delivery (tenant_id, created_at desc);

alter table liame.webhook_endpoint enable row level security;
alter table liame.webhook_endpoint force row level security;
drop policy if exists webhook_endpoint_isolamento on liame.webhook_endpoint;
create policy webhook_endpoint_isolamento on liame.webhook_endpoint
  using (tenant_id = liame.current_tenant_id() or liame.system_scope())
  with check (tenant_id = liame.current_tenant_id() or liame.system_scope());

alter table liame.webhook_delivery enable row level security;
alter table liame.webhook_delivery force row level security;
drop policy if exists webhook_delivery_isolamento on liame.webhook_delivery;
create policy webhook_delivery_isolamento on liame.webhook_delivery
  using (tenant_id = liame.current_tenant_id() or liame.system_scope())
  with check (tenant_id = liame.current_tenant_id() or liame.system_scope());

grant select, insert, update on liame.webhook_endpoint to liame_app;
grant select, insert, update on liame.webhook_delivery to liame_app;

-- ------------------------------------------------------------ inbox (webhooks recebidos)

-- receber → verificar assinatura → persistir cru → deduplicar → ACK → processar depois (ADR-004).
create table if not exists liame.inbox_event (
  id                 uuid primary key,
  provider           text not null check (provider ~ '^[a-z0-9_-]+$'),
  external_event_id  text not null,
  tenant_id          uuid references liame.organization (id) on delete cascade,
  type               text,
  headers            jsonb not null default '{}',
  body               text not null,
  received_at        timestamptz not null default now(),
  processed_at       timestamptz,
  attempts           integer not null default 0,
  last_error         text,
  unique (provider, external_event_id)
);
create index if not exists idx_inbox_pendente on liame.inbox_event (received_at) where processed_at is null;

alter table liame.inbox_event enable row level security;
alter table liame.inbox_event force row level security;
-- Chega antes de saber a empresa: grava no escopo de sistema; a empresa lê o que já é dela.
drop policy if exists inbox_event_isolamento on liame.inbox_event;
create policy inbox_event_isolamento on liame.inbox_event
  using (tenant_id = liame.current_tenant_id() or liame.system_scope())
  with check (liame.system_scope());
grant select, insert, update on liame.inbox_event to liame_app;

-- ------------------------------------------------------------ Idempotency-Key

-- A resposta é gravada na MESMA transação da mutação: ou as duas ficam, ou nenhuma.
create table if not exists liame.idempotency_key (
  user_id          uuid not null references liame.app_user (id) on delete cascade,
  tenant_id        uuid references liame.organization (id) on delete cascade,
  key              text not null check (length(key) between 1 and 255),
  method           text not null,
  path             text not null,
  request_hash     text not null,
  response_status  integer not null,
  response_body    jsonb,
  created_at       timestamptz not null default now(),
  expires_at       timestamptz not null
);
create unique index if not exists uq_idempotency_key on liame.idempotency_key (user_id, tenant_id, key) nulls not distinct;
create index if not exists idx_idempotency_key_vencida on liame.idempotency_key (expires_at);

alter table liame.idempotency_key enable row level security;
alter table liame.idempotency_key force row level security;
drop policy if exists idempotency_key_isolamento on liame.idempotency_key;
create policy idempotency_key_isolamento on liame.idempotency_key
  using ((user_id = liame.current_user_id() and tenant_id is not distinct from liame.current_tenant_id()) or liame.system_scope())
  with check ((user_id = liame.current_user_id() and tenant_id is not distinct from liame.current_tenant_id()) or liame.system_scope());
grant select, insert, update, delete on liame.idempotency_key to liame_app;

-- ------------------------------------------------------------ permissão nova

insert into liame.role_permission (tenant_id, role_key, permission)
values (null, 'dono', 'webhooks.gerenciar'), (null, 'administrador', 'webhooks.gerenciar')
on conflict do nothing;
