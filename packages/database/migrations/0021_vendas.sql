-- 0021 · Modelo de vendas (A2.5, F1; data-model §4; ADR-019): a loja do Regem ligada à loja do Liame,
-- pedidos confirmados e cancelados com itens e custo, e o cliente só como índice cego do telefone.
-- Dinheiro em micros (bigint), como o ledger e a mídia. Idempotente; uma transação por arquivo (ADR-018).

-- ------------------------------------------------------------ conta conectada ↔ loja do Liame

-- A loja do Regem (ou a conta do RegemCast) aponta para a loja do Liame: o corte de dia dos pedidos usa
-- o fuso da loja (V34, LIC-006).
alter table liame.connected_account add column if not exists unit_id uuid references liame.unit (id) on delete set null;
create index if not exists idx_connected_account_loja on liame.connected_account (tenant_id, unit_id) where unit_id is not null;

-- ------------------------------------------------------------ cliente pseudonimizado

-- A mesma pessoa vista no Regem e no RegemCast: só o HMAC do telefone em E.164 com a chave da empresa
-- (ADR-014, D-A2.5-10). O telefone não é guardado; a destruição da chave da empresa apaga a ligação.
create table if not exists liame.customer_ref (
  id             uuid primary key,
  tenant_id      uuid not null references liame.organization (id) on delete cascade,
  phone_index    text check (phone_index ~ '^[0-9a-f]{64}$'),
  first_seen_at  timestamptz not null default now(),
  last_seen_at   timestamptz not null default now()
);
create unique index if not exists uq_customer_ref_telefone on liame.customer_ref (tenant_id, phone_index) where phone_index is not null;

-- O id do cliente no sistema de origem, para achar o customer_ref quando a origem anonimiza o cliente
-- (o aviso não traz telefone). Apagar o customer_ref apaga a ligação.
create table if not exists liame.customer_ref_link (
  connected_account_id  uuid not null references liame.connected_account (id) on delete cascade,
  external_id           text not null check (length(external_id) between 1 and 100),
  tenant_id             uuid not null references liame.organization (id) on delete cascade,
  customer_ref_id       uuid not null references liame.customer_ref (id) on delete cascade,
  updated_at            timestamptz not null default now(),
  primary key (connected_account_id, external_id)
);
create index if not exists idx_customer_ref_link_ref on liame.customer_ref_link (customer_ref_id);

-- ------------------------------------------------------------ pedidos e itens

-- Pedido confirmado (ou cancelado depois) na loja. O Regem é a autoridade (Metric Authority Matrix): a
-- receita é a da definição única de faturamento dele (D-A2.5-6), e o Liame não recalcula. A versão do
-- recurso decide a ordem, nunca a chegada (ADR-004): versão menor ou igual não altera a linha.
create table if not exists liame.order_fact (
  id                    uuid primary key,
  tenant_id             uuid not null references liame.organization (id) on delete cascade,
  brand_id              uuid not null references liame.brand (id) on delete cascade,
  unit_id               uuid references liame.unit (id) on delete set null,
  connected_account_id  uuid not null references liame.connected_account (id) on delete cascade,
  provider              text not null check (provider ~ '^[a-z0-9_]+$'),
  external_id           text not null check (length(external_id) between 1 and 100),
  channel               text not null check (channel ~ '^[a-z0-9_]{1,40}$'),
  channel_group         text not null check (channel_group in ('cardapio', 'whatsapp', 'presencial', 'marketplace', 'outro')),
  status                text not null check (status in ('confirmado', 'cancelado')),
  currency              text not null check (currency ~ '^[A-Z]{3}$'),
  timezone              text not null check (length(timezone) between 1 and 64),
  revenue_micros        bigint not null check (revenue_micros >= 0),
  discount_micros       bigint not null default 0 check (discount_micros >= 0),
  refunded_micros       bigint not null default 0 check (refunded_micros >= 0),
  coupon_code           text check (length(coupon_code) between 1 and 60 and coupon_code = upper(coupon_code)),
  customer_ref_id       uuid references liame.customer_ref (id) on delete set null,
  is_new_customer       boolean,
  placed_at             timestamptz,
  confirmed_at          timestamptz not null,
  cancelled_at          timestamptz,
  source_version        bigint not null check (source_version >= 0),
  source_updated_at     timestamptz not null,
  raw_ref               uuid,
  first_seen_at         timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (connected_account_id, external_id),
  constraint order_fact_cancelado_check check ((status = 'cancelado') = (cancelled_at is not null)),
  -- Marketplace (iFood, 99Food, Keeta) chega sem nenhum identificador do cliente (D-A2.5-11).
  constraint order_fact_marketplace_sem_cliente check (channel_group <> 'marketplace' or customer_ref_id is null)
);
create index if not exists idx_order_fact_periodo on liame.order_fact (tenant_id, brand_id, confirmed_at);
create index if not exists idx_order_fact_cliente on liame.order_fact (customer_ref_id) where customer_ref_id is not null;
create index if not exists idx_order_fact_cupom on liame.order_fact (tenant_id, coupon_code) where coupon_code is not null;

-- Item do pedido. Custo nulo = desconhecido (sem ficha técnica ou sem permissão financeira de quem
-- autorizou): "margem desconhecida ≠ zero" (D-A2.5-7). Item que sumiu numa versão nova fica marcado,
-- nada se apaga na sincronização.
create table if not exists liame.order_item_fact (
  id                    uuid primary key,
  tenant_id             uuid not null references liame.organization (id) on delete cascade,
  order_id              uuid not null references liame.order_fact (id) on delete cascade,
  external_id           text not null check (length(external_id) between 1 and 100),
  product_external_id   text check (length(product_external_id) between 1 and 100),
  name                  text not null check (length(name) between 1 and 300),
  quantity              numeric(14, 3) not null check (quantity >= 0),
  revenue_micros        bigint not null check (revenue_micros >= 0),
  cost_micros           bigint check (cost_micros >= 0),
  cost_known            boolean generated always as (cost_micros is not null) stored,
  removed_at            timestamptz,
  updated_at            timestamptz not null default now(),
  unique (order_id, external_id)
);
create index if not exists idx_order_item_fact_tenant on liame.order_item_fact (tenant_id);

-- ------------------------------------------------------------ RLS, grants e "só o expurgo apaga"

do $$
declare t text;
begin
  foreach t in array array['customer_ref', 'customer_ref_link', 'order_fact', 'order_item_fact']
  loop
    execute format('alter table liame.%I enable row level security', t);
    execute format('alter table liame.%I force row level security', t);
    execute format('drop policy if exists %I on liame.%I', t || '_isolamento', t);
    execute format('create policy %I on liame.%I using (tenant_id = liame.current_tenant_id() or liame.system_scope()) with check (tenant_id = liame.current_tenant_id() or liame.system_scope())', t || '_isolamento', t);
    execute format('drop policy if exists %I on liame.%I', t || '_apaga_so_sistema', t);
    execute format('create policy %I on liame.%I as restrictive for delete using (liame.system_scope())', t || '_apaga_so_sistema', t);
    execute format('grant select, insert, update, delete on liame.%I to liame_app', t);
  end loop;
end $$;

drop trigger if exists tg_order_fact_touch on liame.order_fact;
create trigger tg_order_fact_touch before update on liame.order_fact for each row execute function liame.touch_updated_at();
drop trigger if exists tg_order_item_fact_touch on liame.order_item_fact;
create trigger tg_order_item_fact_touch before update on liame.order_item_fact for each row execute function liame.touch_updated_at();
drop trigger if exists tg_customer_ref_link_touch on liame.customer_ref_link;
create trigger tg_customer_ref_link_touch before update on liame.customer_ref_link for each row execute function liame.touch_updated_at();
