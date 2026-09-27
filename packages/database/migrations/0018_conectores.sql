-- 0018 · Framework dos conectores (A2, G2; arquitetura §6): Capability Registry versionado, avisos de
-- depreciação vistos nas respostas (RFC 9745/8594, ADR-015), balde de cota por app × conta e disjuntor.
-- Tudo da distribuição (sem tenant). As chaves de cota e de disjuntor são hashes: não revelam contas.
-- Idempotente; uma transação por arquivo (ADR-018).

select set_config('app.scope', 'sistema', true);

-- ------------------------------------------------------------ Capability Registry

create table if not exists liame.connector_capability (
  provider        text not null check (provider ~ '^[a-z0-9_]+$'),
  capability      text not null check (capability ~ '^[a-z0-9_]+$'),
  api_version     text not null,
  read            boolean not null default true,
  write           boolean not null default false,
  required_scope  text[] not null default '{}',
  access_level    text,
  deprecated_at   date,
  sunset_at       date,
  replacement     text,
  source_url      text not null,
  verified_at     date not null,
  notes           text,
  primary key (provider, capability)
);

-- Versões verificadas nas páginas oficiais em 26/09/2026 (base de conhecimento §2.1, §3.1, §3.3).
insert into liame.connector_capability (provider, capability, api_version, read, write, required_scope, access_level, sunset_at, source_url, verified_at, notes) values
  ('meta_ads', 'accounts', 'v26.0', true, false, '{ads_read,business_management}', 'Standard (testadores) ou Advanced', null, 'https://developers.facebook.com/docs/graph-api/changelog', '2026-09-26', 'v24 da Marketing API expira em 06/10/2026'),
  ('meta_ads', 'entities', 'v26.0', true, false, '{ads_read}', 'Standard (testadores) ou Advanced', null, 'https://developers.facebook.com/docs/marketing-api/reference', '2026-09-26', 'campanhas, conjuntos, anúncios e criativos'),
  ('meta_ads', 'insights_daily', 'v26.0', true, false, '{ads_read}', 'Standard (testadores) ou Advanced', null, 'https://developers.facebook.com/docs/marketing-api/insights', '2026-09-26', 'por anúncio, time_increment=1, janela de atribuição declarada'),
  ('google_ads', 'accounts', 'v25', true, false, '{https://www.googleapis.com/auth/adwords}', 'Explorer (leitura)', null, 'https://developers.google.com/google-ads/api/docs/release-notes', '2026-09-26', 'major v25 (22/07/2026); menores v25.1 e v25.2'),
  ('google_ads', 'entities', 'v25', true, false, '{https://www.googleapis.com/auth/adwords}', 'Explorer (leitura)', null, 'https://developers.google.com/google-ads/api/docs/query/overview', '2026-09-26', 'GAQL por searchStream'),
  ('google_ads', 'metrics_daily', 'v25', true, false, '{https://www.googleapis.com/auth/adwords}', 'Explorer (leitura)', null, 'https://developers.google.com/google-ads/api/docs/reporting/overview', '2026-09-26', 'segments.date, cost_micros'),
  ('ga4', 'properties', 'v1beta', true, false, '{https://www.googleapis.com/auth/analytics.readonly}', 'OAuth em modo de teste', null, 'https://developers.google.com/analytics/devguides/config/admin/v1', '2026-09-26', 'Admin API para listar propriedades'),
  ('ga4', 'report_daily', 'v1beta', true, false, '{https://www.googleapis.com/auth/analytics.readonly}', 'OAuth em modo de teste', null, 'https://developers.google.com/analytics/devguides/reporting/data/v1', '2026-09-26', 'runReport com returnPropertyQuota')
on conflict (provider, capability) do nothing;

-- ------------------------------------------------------------ avisos de depreciação vistos nas respostas

create table if not exists liame.api_deprecation_notice (
  provider        text not null check (provider ~ '^[a-z0-9_]+$'),
  endpoint        text not null,
  api_version     text not null default '',
  deprecation     text,
  sunset          text,
  link            text,
  first_seen_at   timestamptz not null default now(),
  last_seen_at    timestamptz not null default now(),
  primary key (provider, endpoint, api_version)
);

-- ------------------------------------------------------------ cota e disjuntor (compartilhados entre workers)

-- Balde de fichas por chave (hash de provider × app × conta): a cota das plataformas é do app e
-- compartilhada entre as empresas, então ninguém gasta a das outras.
create table if not exists liame.quota_bucket (
  bucket_key         text primary key check (bucket_key ~ '^[0-9a-f]{64}$'),
  capacity           numeric not null check (capacity > 0),
  refill_per_second  numeric not null check (refill_per_second > 0),
  tokens             numeric not null,
  refilled_at        timestamptz not null default now()
);

-- Disjuntor: depois de falhas seguidas, para de insistir até `open_until` (espera que dobra).
create table if not exists liame.circuit_state (
  circuit_key     text primary key check (circuit_key ~ '^[0-9a-f]{64}$'),
  failures        integer not null default 0,
  opened_times    integer not null default 0,
  open_until      timestamptz,
  last_error      text,
  updated_at      timestamptz not null default now()
);

do $$
declare t text;
begin
  foreach t in array array['connector_capability', 'api_deprecation_notice', 'quota_bucket', 'circuit_state']
  loop
    execute format('alter table liame.%I enable row level security', t);
    execute format('alter table liame.%I force row level security', t);
  end loop;
end $$;

-- Registro: leitura para todos; muda só por migration ou escopo de sistema (Vigia, G8).
drop policy if exists connector_capability_leitura on liame.connector_capability;
create policy connector_capability_leitura on liame.connector_capability for select using (true);
drop policy if exists connector_capability_sistema on liame.connector_capability;
create policy connector_capability_sistema on liame.connector_capability using (liame.system_scope()) with check (liame.system_scope());
grant select on liame.connector_capability to liame_app;

-- Avisos, cota e disjuntor: estado técnico da distribuição, sem dado de empresa (chaves em hash).
drop policy if exists api_deprecation_notice_uso on liame.api_deprecation_notice;
create policy api_deprecation_notice_uso on liame.api_deprecation_notice using (true) with check (true);
grant select, insert, update on liame.api_deprecation_notice to liame_app;
drop policy if exists quota_bucket_uso on liame.quota_bucket;
create policy quota_bucket_uso on liame.quota_bucket using (true) with check (true);
grant select, insert, update on liame.quota_bucket to liame_app;
drop policy if exists circuit_state_uso on liame.circuit_state;
create policy circuit_state_uso on liame.circuit_state using (true) with check (true);
grant select, insert, update on liame.circuit_state to liame_app;
