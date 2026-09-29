-- 0022 · Pontos de contato e atribuição (A2.5, F2; data-model §4; ADR-019 e ADR-020): links e cupons de
-- campanha, cupons da loja (espelho do Regem), toques (clique no cardápio, conversa aberta por anúncio),
-- modelo de atribuição como dado versionado, execuções e o resultado de cada pedido.
-- Idempotente; uma transação por arquivo (ADR-018).

-- A semente do modelo grava com a RLS forçada (ERR-011).
select set_config('app.scope', 'sistema', true);

-- ------------------------------------------------------------ link de campanha (F5)

-- O link do cardápio da loja que vai no anúncio: `code` é o `lk` da URL, guardado pelo cardápio até o
-- pedido (C3a). A campanha e o anúncio são os do Liame (sincronizados na A2).
create table if not exists liame.tracking_link (
  id               uuid primary key,
  tenant_id        uuid not null references liame.organization (id) on delete cascade,
  brand_id         uuid not null references liame.brand (id) on delete cascade,
  unit_id          uuid references liame.unit (id) on delete set null,
  code             text not null check (code ~ '^[A-Za-z0-9]{6,32}$'),
  name             text not null check (length(name) between 1 and 200),
  provider         text not null check (provider ~ '^[a-z0-9_]+$'),
  campaign_id      uuid references liame.campaign (id) on delete set null,
  ad_group_id      uuid references liame.ad_group (id) on delete set null,
  ad_id            uuid references liame.ad (id) on delete set null,
  destination_url  text not null check (length(destination_url) between 8 and 2048),
  utm_source       text not null check (length(utm_source) between 1 and 100),
  utm_medium       text not null check (length(utm_medium) between 1 and 100),
  utm_campaign     text check (length(utm_campaign) between 1 and 300),
  utm_content      text check (length(utm_content) between 1 and 300),
  utm_term         text check (length(utm_term) between 1 and 300),
  created_by       uuid references liame.app_user (id) on delete set null,
  created_at       timestamptz not null default now(),
  archived_at      timestamptz,
  unique (tenant_id, code)
);
create index if not exists idx_tracking_link_marca on liame.tracking_link (tenant_id, brand_id) where archived_at is null;

-- ------------------------------------------------------------ cupons da loja (espelho) e cupom de campanha

-- Cupom cadastrado no Regem (a fonte da verdade, D-A2.5-3), lido pelo contrato de cupons: código, regra,
-- validade e usos. O Liame não altera: criar e desativar vão pelo Action Service até a origem.
create table if not exists liame.coupon (
  id                    uuid primary key,
  tenant_id             uuid not null references liame.organization (id) on delete cascade,
  brand_id              uuid not null references liame.brand (id) on delete cascade,
  connected_account_id  uuid not null references liame.connected_account (id) on delete cascade,
  external_id           text not null check (length(external_id) between 1 and 100),
  code                  text not null check (length(code) between 1 and 60 and code = upper(code)),
  description           text check (length(description) <= 500),
  kind                  text not null check (kind in ('percentual', 'valor', 'frete_gratis', 'outro')),
  percent               numeric(5, 2) check (percent > 0 and percent <= 100),
  value_micros          bigint check (value_micros >= 0),
  min_order_micros      bigint check (min_order_micros >= 0),
  valid_from            timestamptz,
  valid_until           timestamptz,
  active                boolean not null,
  max_uses              integer check (max_uses >= 0),
  uses_count            integer not null default 0 check (uses_count >= 0),
  source_version        bigint not null check (source_version >= 0),
  source_updated_at     timestamptz not null,
  first_seen_at         timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (connected_account_id, external_id)
);
create index if not exists idx_coupon_codigo on liame.coupon (connected_account_id, code);

-- Cupom ligado a uma campanha. Só o cupom EXCLUSIVO da campanha é evidência (ADR-020): cupom de uso geral
-- não diz de onde veio o pedido. Um cupom fica ligado a uma campanha por vez; desligar encerra o período.
create table if not exists liame.campaign_coupon (
  id            uuid primary key,
  tenant_id     uuid not null references liame.organization (id) on delete cascade,
  brand_id      uuid not null references liame.brand (id) on delete cascade,
  coupon_id     uuid not null references liame.coupon (id) on delete cascade,
  campaign_id   uuid not null references liame.campaign (id) on delete cascade,
  exclusive     boolean not null default true,
  linked_at     timestamptz not null default now(),
  unlinked_at   timestamptz,
  created_by    uuid references liame.app_user (id) on delete set null,
  constraint campaign_coupon_periodo_check check (unlinked_at is null or unlinked_at > linked_at)
);
create unique index if not exists uq_campaign_coupon_ativo on liame.campaign_coupon (coupon_id) where unlinked_at is null;
create index if not exists idx_campaign_coupon_campanha on liame.campaign_coupon (campaign_id);

-- ------------------------------------------------------------ pontos de contato

-- Um toque que pode levar a um pedido. Clique: captado pelo cardápio da loja no primeiro acesso e guardado
-- até o checkout (C3a), ligado ao pedido pelo id dele na origem. Conversa: aberta por anúncio de clique para
-- WhatsApp (referral do RegemCast), ligada ao pedido pelo cliente pseudonimizado. `provenance` diz de onde
-- veio cada campo (url, regemcast, google_ads…): dado das APIs do Google nunca segue para a Meta, nem o da
-- Meta para o Google (ADR-019 item 9). Ids de clique são dado pessoal: 90 dias (D-A2.5-10).
create table if not exists liame.touchpoint (
  id                    uuid primary key,
  tenant_id             uuid not null references liame.organization (id) on delete cascade,
  brand_id              uuid not null references liame.brand (id) on delete cascade,
  connected_account_id  uuid not null references liame.connected_account (id) on delete cascade,
  external_id           text not null check (length(external_id) between 1 and 100),
  kind                  text not null check (kind in ('clique', 'conversa')),
  occurred_at           timestamptz not null,
  order_external_id     text check (length(order_external_id) between 1 and 100),
  customer_ref_id       uuid references liame.customer_ref (id) on delete set null,
  provider              text check (provider ~ '^[a-z0-9_]+$'),
  link_code             text check (link_code ~ '^[A-Za-z0-9]{6,32}$'),
  campaign_external_id  text check (length(campaign_external_id) between 1 and 100),
  ad_group_external_id  text check (length(ad_group_external_id) between 1 and 100),
  ad_external_id        text check (length(ad_external_id) between 1 and 100),
  gclid                 text check (length(gclid) between 1 and 1024),
  gbraid                text check (length(gbraid) between 1 and 1024),
  wbraid                text check (length(wbraid) between 1 and 1024),
  fbclid                text check (length(fbclid) between 1 and 1024),
  ctwa_clid             text check (length(ctwa_clid) between 1 and 1024),
  utm_source            text check (length(utm_source) between 1 and 300),
  utm_medium            text check (length(utm_medium) between 1 and 300),
  utm_campaign          text check (length(utm_campaign) between 1 and 300),
  utm_content           text check (length(utm_content) between 1 and 300),
  utm_term              text check (length(utm_term) between 1 and 300),
  provenance            jsonb not null default '{}'::jsonb,
  first_seen_at         timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (connected_account_id, external_id),
  constraint touchpoint_clique_pedido_check check (kind <> 'clique' or order_external_id is not null),
  constraint touchpoint_conversa_sem_pedido_check check (kind <> 'conversa' or order_external_id is null)
);
create index if not exists idx_touchpoint_pedido on liame.touchpoint (connected_account_id, order_external_id) where order_external_id is not null;
create index if not exists idx_touchpoint_cliente on liame.touchpoint (tenant_id, customer_ref_id, occurred_at) where customer_ref_id is not null;
create index if not exists idx_touchpoint_prazo on liame.touchpoint (occurred_at);

-- ------------------------------------------------------------ modelo, execução e resultado

-- O modelo é dado, imutável por versão (ADR-020): mudar a regra cria versão nova. `tenant_id` nulo =
-- modelo da distribuição, que vale para todas as empresas.
create table if not exists liame.attribution_model (
  id           uuid primary key,
  tenant_id    uuid references liame.organization (id) on delete cascade,
  key          text not null check (key ~ '^[a-z0-9_]{1,60}$'),
  version      integer not null check (version >= 1),
  window_days  integer not null check (window_days between 1 and 90),
  rules        jsonb not null,
  description  text not null,
  created_at   timestamptz not null default now()
);
create unique index if not exists uq_attribution_model_distribuicao on liame.attribution_model (key, version) where tenant_id is null;
create unique index if not exists uq_attribution_model_empresa on liame.attribution_model (tenant_id, key, version) where tenant_id is not null;

create table if not exists liame.attribution_run (
  id                 uuid primary key,
  tenant_id          uuid not null references liame.organization (id) on delete cascade,
  model_id           uuid not null references liame.attribution_model (id),
  trigger            text not null check (trigger in ('pedidos', 'toques', 'cupons', 'periodo', 'modelo', 'manual')),
  orders_considered  integer not null default 0,
  attributed         integer not null default 0,
  platform_only      integer not null default 0,
  without_origin     integer not null default 0,
  started_at         timestamptz not null default now(),
  finished_at        timestamptz
);
create index if not exists idx_attribution_run_empresa on liame.attribution_run (tenant_id, started_at desc);
create index if not exists idx_attribution_run_prazo on liame.attribution_run (started_at);

-- Um resultado por pedido e versão de modelo; o recálculo substitui (upsert), nunca duplica. `counted`:
-- entra no ROAS confirmado (pedido confirmado + evidência de confiança alta ou média, D-A2.5-8).
create table if not exists liame.attribution_result (
  order_id            uuid not null references liame.order_fact (id) on delete cascade,
  model_id            uuid not null references liame.attribution_model (id),
  tenant_id           uuid not null references liame.organization (id) on delete cascade,
  brand_id            uuid not null references liame.brand (id) on delete cascade,
  run_id              uuid references liame.attribution_run (id) on delete set null,
  status              text not null check (status in ('atribuido', 'plataforma', 'sem_origem')),
  provider            text check (provider ~ '^[a-z0-9_]+$'),
  campaign_id         uuid references liame.campaign (id) on delete set null,
  ad_id               uuid references liame.ad (id) on delete set null,
  evidence            text check (evidence ~ '^[a-z_]+$'),
  confidence          text check (confidence in ('alta', 'media')),
  touchpoint_id       uuid,
  campaign_coupon_id  uuid,
  touch_at            timestamptz,
  window_days         integer not null,
  counted             boolean not null,
  reason              text check (reason in ('sem_evidencia', 'fora_da_janela', 'canal_sem_clique', 'sem_id', 'cancelado')),
  computed_at         timestamptz not null default now(),
  primary key (order_id, model_id),
  constraint attribution_result_sem_origem_check check ((status = 'sem_origem') = (evidence is null)),
  constraint attribution_result_campanha_check check ((status = 'atribuido') = (campaign_id is not null))
);
create index if not exists idx_attribution_result_campanha on liame.attribution_result (tenant_id, model_id, campaign_id);

-- ------------------------------------------------------------ RLS, grants e "só o expurgo apaga"

do $$
declare t text;
begin
  foreach t in array array['tracking_link', 'coupon', 'campaign_coupon', 'touchpoint', 'attribution_run', 'attribution_result']
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

-- Modelo: a empresa lê o da distribuição e os próprios; só o sistema grava; nunca se altera.
alter table liame.attribution_model enable row level security;
alter table liame.attribution_model force row level security;
drop policy if exists attribution_model_leitura on liame.attribution_model;
create policy attribution_model_leitura on liame.attribution_model for select
  using (tenant_id is null or tenant_id = liame.current_tenant_id() or liame.system_scope());
drop policy if exists attribution_model_sistema on liame.attribution_model;
create policy attribution_model_sistema on liame.attribution_model for insert with check (liame.system_scope());
grant select, insert on liame.attribution_model to liame_app;

drop trigger if exists tg_coupon_touch on liame.coupon;
create trigger tg_coupon_touch before update on liame.coupon for each row execute function liame.touch_updated_at();
drop trigger if exists tg_touchpoint_touch on liame.touchpoint;
create trigger tg_touchpoint_touch before update on liame.touchpoint for each row execute function liame.touch_updated_at();

-- ------------------------------------------------------------ modelo inicial (ADR-020)

-- Último toque v1: cupom exclusivo > clique com campanha ou anúncio > conversa por anúncio > clique só da
-- plataforma > conversa só da plataforma; 7 dias; sem visualização; canais sem clique só por cupom.
insert into liame.attribution_model (id, tenant_id, key, version, window_days, rules, description)
values (
  '0199a000-0000-7000-8000-000000000001', null, 'ultimo_toque', 1, 7,
  '{"hierarquia": ["cupom", "clique_campanha", "conversa_anuncio", "clique_plataforma", "conversa_plataforma"],
    "confianca": {"cupom": "alta", "clique_campanha": "alta", "clique_plataforma": "alta", "conversa_anuncio": "media", "conversa_plataforma": "media"},
    "canais_so_cupom": ["marketplace", "presencial", "outro"],
    "conta_visualizacao": false}'::jsonb,
  'Último toque determinístico: cupom exclusivo da campanha, clique com id da campanha ou do anúncio, conversa aberta por anúncio com o mesmo telefone; janela de 7 dias do toque até a confirmação do pedido; sem visualização.'
)
on conflict do nothing;
