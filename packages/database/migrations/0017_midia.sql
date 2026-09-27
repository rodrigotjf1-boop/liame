-- 0017 · Modelo de mídia (A2, G1; data-model §3): contas conectadas, entidades canônicas com o que é só do
-- provider, métricas com modelo temporal (cada leitura que muda o número é uma linha), último valor por
-- chave com RLS, mapeamento de métricas, payload bruto de retenção curta e o estado da sincronização.
-- Idempotente; uma transação por arquivo (ADR-018).

-- ------------------------------------------------------------ contas conectadas

-- Conta de uma plataforma (conta de anúncio da Meta, cliente do Google Ads, propriedade do GA4) ligada a
-- uma marca. A credencial fica no cofre (liame.secret); aqui só a referência.
create table if not exists liame.connected_account (
  id                    uuid primary key,
  tenant_id             uuid not null references liame.organization (id) on delete cascade,
  brand_id              uuid not null references liame.brand (id) on delete cascade,
  provider              text not null check (provider ~ '^[a-z0-9_]+$'),
  external_id           text not null check (length(external_id) between 1 and 100),
  name                  text not null check (length(name) between 1 and 300),
  currency              text check (currency ~ '^[A-Z]{3}$'),
  timezone              text check (length(timezone) between 1 and 64),
  status                text not null default 'ativa' check (status in ('ativa', 'desconectada', 'sem_permissao', 'erro')),
  status_reason         text,
  credential_secret_id  uuid references liame.secret (id) on delete set null,
  provider_attributes   jsonb not null default '{}'::jsonb,
  connected_by          uuid references liame.app_user (id) on delete set null,
  connected_at          timestamptz not null default now(),
  disconnected_at       timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
-- A mesma conta da plataforma entra uma vez por empresa enquanto estiver ligada.
create unique index if not exists uq_connected_account_ativa
  on liame.connected_account (tenant_id, provider, external_id) where disconnected_at is null;
create index if not exists idx_connected_account_marca on liame.connected_account (tenant_id, brand_id);

-- ------------------------------------------------------------ entidades canônicas

-- Não fingir que Meta e Google têm os mesmos conceitos: colunas canônicas + provider_attributes (o que é
-- só do provider) + raw_ref (o payload bruto que originou a linha). Nada se apaga na sincronização:
-- o que some da plataforma vira 'removida'.
create table if not exists liame.campaign (
  id                    uuid primary key,
  tenant_id             uuid not null references liame.organization (id) on delete cascade,
  connected_account_id  uuid not null references liame.connected_account (id) on delete cascade,
  provider              text not null check (provider ~ '^[a-z0-9_]+$'),
  external_id           text not null check (length(external_id) between 1 and 100),
  name                  text not null,
  status                text not null check (status in ('ativa', 'pausada', 'arquivada', 'removida', 'desconhecida')),
  provider_status       text,
  objective             text,
  daily_budget_micros   bigint check (daily_budget_micros >= 0),
  lifetime_budget_micros bigint check (lifetime_budget_micros >= 0),
  provider_attributes   jsonb not null default '{}'::jsonb,
  raw_ref               uuid,
  provider_created_at   timestamptz,
  provider_updated_at   timestamptz,
  first_seen_at         timestamptz not null default now(),
  last_seen_at          timestamptz not null default now(),
  unique (connected_account_id, external_id)
);

create table if not exists liame.ad_group (
  id                    uuid primary key,
  tenant_id             uuid not null references liame.organization (id) on delete cascade,
  connected_account_id  uuid not null references liame.connected_account (id) on delete cascade,
  campaign_id           uuid references liame.campaign (id) on delete cascade,
  provider              text not null check (provider ~ '^[a-z0-9_]+$'),
  external_id           text not null check (length(external_id) between 1 and 100),
  name                  text not null,
  status                text not null check (status in ('ativa', 'pausada', 'arquivada', 'removida', 'desconhecida')),
  provider_status       text,
  daily_budget_micros   bigint check (daily_budget_micros >= 0),
  provider_attributes   jsonb not null default '{}'::jsonb,
  raw_ref               uuid,
  first_seen_at         timestamptz not null default now(),
  last_seen_at          timestamptz not null default now(),
  unique (connected_account_id, external_id)
);

create table if not exists liame.creative (
  id                    uuid primary key,
  tenant_id             uuid not null references liame.organization (id) on delete cascade,
  connected_account_id  uuid not null references liame.connected_account (id) on delete cascade,
  provider              text not null check (provider ~ '^[a-z0-9_]+$'),
  external_id           text not null check (length(external_id) between 1 and 100),
  name                  text,
  kind                  text,
  thumbnail_url         text,
  provider_attributes   jsonb not null default '{}'::jsonb,
  raw_ref               uuid,
  first_seen_at         timestamptz not null default now(),
  last_seen_at          timestamptz not null default now(),
  unique (connected_account_id, external_id)
);

create table if not exists liame.ad (
  id                    uuid primary key,
  tenant_id             uuid not null references liame.organization (id) on delete cascade,
  connected_account_id  uuid not null references liame.connected_account (id) on delete cascade,
  ad_group_id           uuid references liame.ad_group (id) on delete cascade,
  creative_id           uuid references liame.creative (id) on delete set null,
  provider              text not null check (provider ~ '^[a-z0-9_]+$'),
  external_id           text not null check (length(external_id) between 1 and 100),
  name                  text not null,
  status                text not null check (status in ('ativa', 'pausada', 'arquivada', 'removida', 'desconhecida')),
  provider_status       text,
  provider_attributes   jsonb not null default '{}'::jsonb,
  raw_ref               uuid,
  first_seen_at         timestamptz not null default now(),
  last_seen_at          timestamptz not null default now(),
  unique (connected_account_id, external_id)
);

-- ------------------------------------------------------------ métricas com modelo temporal

-- Cada linha é uma leitura que MUDOU o número (D-A2-7): "quanto a plataforma dizia naquela data" e
-- "quanto diz hoje sobre aquela data". attribution_window '' = métrica sem janela (gasto, impressões).
create table if not exists liame.metric_observation (
  id                    bigint generated always as identity primary key,
  tenant_id             uuid not null references liame.organization (id) on delete cascade,
  brand_id              uuid not null references liame.brand (id) on delete cascade,
  connected_account_id  uuid not null references liame.connected_account (id) on delete cascade,
  provider              text not null check (provider ~ '^[a-z0-9_]+$'),
  level                 text not null check (level in ('account', 'campaign', 'ad_group', 'ad')),
  entity_id             uuid,
  external_entity_id    text not null,
  metric_date           date not null,
  metric_name           text not null check (metric_name ~ '^[a-z0-9_.:]+$'),
  attribution_window    text not null default '' check (attribution_window ~ '^[a-z0-9_]*$'),
  metric_value          numeric not null,
  currency              text check (currency ~ '^[A-Z]{3}$'),
  timezone              text,
  observed_at           timestamptz not null,
  sync_run_id           uuid,
  source_version        text,
  quality               text not null default 'ok' check (quality in ('ok', 'parcial', 'estimado'))
);
create index if not exists idx_metric_observation_chave
  on liame.metric_observation (connected_account_id, level, external_entity_id, metric_name, metric_date, observed_at desc);
create index if not exists brin_metric_observation_observed on liame.metric_observation using brin (observed_at);

-- Último valor por chave, para painéis e agentes. Tabela mantida na escrita (D-A2-5): visão materializada
-- não tem RLS e abriria uma porta entre empresas.
create table if not exists liame.metric_latest (
  connected_account_id  uuid not null references liame.connected_account (id) on delete cascade,
  level                 text not null check (level in ('account', 'campaign', 'ad_group', 'ad')),
  external_entity_id    text not null,
  metric_date           date not null,
  metric_name           text not null check (metric_name ~ '^[a-z0-9_.:]+$'),
  attribution_window    text not null default '' check (attribution_window ~ '^[a-z0-9_]*$'),
  tenant_id             uuid not null references liame.organization (id) on delete cascade,
  brand_id              uuid not null references liame.brand (id) on delete cascade,
  provider              text not null,
  entity_id             uuid,
  metric_value          numeric not null,
  currency              text,
  timezone              text,
  -- observed_at: última leitura; changed_at: última vez que o número mudou.
  observed_at           timestamptz not null,
  changed_at            timestamptz not null,
  sync_run_id           uuid,
  source_version        text,
  quality               text not null default 'ok' check (quality in ('ok', 'parcial', 'estimado')),
  primary key (connected_account_id, level, external_entity_id, metric_date, metric_name, attribution_window)
);
create index if not exists idx_metric_latest_marca on liame.metric_latest (tenant_id, brand_id, metric_date);

-- Mapeamento de métricas do provider para as canônicas (da distribuição; sem tenant).
create table if not exists liame.metric_mapping (
  provider              text not null check (provider ~ '^[a-z0-9_]+$'),
  provider_metric       text not null,
  canonical_metric      text not null check (canonical_metric ~ '^[a-z0-9_.:]+$'),
  transform             text not null default 'identidade' check (transform in ('identidade', 'micros_para_unidade', 'centavos_para_unidade')),
  confidence            text not null default 'alta' check (confidence in ('alta', 'media', 'baixa')),
  notes                 text,
  primary key (provider, provider_metric)
);

-- Payload bruto (retenção curta, §9): reprocessar quando o mapeamento mudar.
create table if not exists liame.raw_payload (
  id                    uuid primary key,
  tenant_id             uuid not null references liame.organization (id) on delete cascade,
  connected_account_id  uuid not null references liame.connected_account (id) on delete cascade,
  provider              text not null,
  endpoint              text not null,
  api_version           text,
  fetched_at            timestamptz not null default now(),
  hash                  text not null check (hash ~ '^[0-9a-f]{64}$'),
  body                  jsonb not null
);
create index if not exists idx_raw_payload_prazo on liame.raw_payload (fetched_at);

-- ------------------------------------------------------------ sincronização

create table if not exists liame.sync_run (
  id                    uuid primary key,
  tenant_id             uuid not null references liame.organization (id) on delete cascade,
  connected_account_id  uuid not null references liame.connected_account (id) on delete cascade,
  dataset               text not null check (dataset ~ '^[a-z0-9_]+$'),
  kind                  text not null check (kind in ('carga_inicial', 'incremental', 'revisao', 'manual')),
  window_start          date,
  window_end            date,
  status                text not null default 'rodando' check (status in ('rodando', 'ok', 'parcial', 'falhou')),
  api_version           text,
  calls                 integer not null default 0,
  entities_written      integer not null default 0,
  observations_new      integer not null default 0,
  error                 text,
  started_at            timestamptz not null default now(),
  finished_at           timestamptz
);
create index if not exists idx_sync_run_conta on liame.sync_run (connected_account_id, dataset, started_at desc);

-- Frescor por conta e conjunto de dados: toda métrica entregue leva o seu (data-model §3.1).
create table if not exists liame.sync_state (
  connected_account_id  uuid not null references liame.connected_account (id) on delete cascade,
  dataset               text not null check (dataset ~ '^[a-z0-9_]+$'),
  tenant_id             uuid not null references liame.organization (id) on delete cascade,
  expected_every_minutes integer not null check (expected_every_minutes > 0),
  last_success_at       timestamptz,
  last_attempt_at       timestamptz,
  last_error            text,
  cursor                jsonb not null default '{}'::jsonb,
  updated_at            timestamptz not null default now(),
  primary key (connected_account_id, dataset)
);

-- ------------------------------------------------------------ RLS, grants e "só o expurgo apaga"

do $$
declare t text;
begin
  foreach t in array array['connected_account', 'campaign', 'ad_group', 'creative', 'ad', 'metric_observation', 'metric_latest', 'raw_payload', 'sync_run', 'sync_state']
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
-- O histórico de métricas não se reescreve: só entra linha nova.
revoke update on liame.metric_observation from liame_app;

alter table liame.metric_mapping enable row level security;
alter table liame.metric_mapping force row level security;
drop policy if exists metric_mapping_leitura on liame.metric_mapping;
create policy metric_mapping_leitura on liame.metric_mapping for select using (true);
drop policy if exists metric_mapping_sistema on liame.metric_mapping;
create policy metric_mapping_sistema on liame.metric_mapping using (liame.system_scope()) with check (liame.system_scope());
grant select on liame.metric_mapping to liame_app;

drop trigger if exists tg_connected_account_touch on liame.connected_account;
create trigger tg_connected_account_touch before update on liame.connected_account for each row execute function liame.touch_updated_at();
