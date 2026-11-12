-- 0146 · A mídia por região e por hora (plano da região, R4, parte 1; base §19.7; `plano-regiao.md` R4).
-- O que as plataformas de anúncio dizem, por conta de anúncio, das 4 semanas completas até ontem (no fuso da conta):
--   * `ad_hour_daily`: impressões, cliques, gasto e (no Google) conversões por dia e por hora. A Meta dá a hora pelo
--     fuso da conta (`hourly_stats_aggregated_by_advertiser_time_zone`), sem alcance; o Google, por `segments.hour`.
--   * `ad_city_daily`: o mesmo por dia e pela cidade de quem viu e clicou, só do Google (`user_location_view`). A Meta
--     não tem cidade nas quebras dela (só o estado, que o Liame não lê).
--   * `region_geo_target`: o nome de cada lugar do Google (`geo_target_constant`), uma tabela do sistema, como as outras
--     da região: todos leem, só o sistema grava.
-- A leitura é da rotina `regiao-midia` do worker, uma vez por dia, só para a marca com a função `regiao` ligada; o
-- frescor fica em `sync_state`, com o conjunto `regiao_midia`. A janela lida substitui a guardada (os números de anúncio
-- mudam até 28 dias depois). Nada de pessoa: só somas por dia, hora e lugar.
-- Idempotente; uma transação por arquivo (ADR-018).

create table if not exists liame.ad_hour_daily (
  connected_account_id  uuid not null references liame.connected_account (id) on delete cascade,
  tenant_id             uuid not null references liame.organization (id) on delete cascade,
  brand_id              uuid not null references liame.brand (id) on delete cascade,
  provider              text not null,
  -- O dia e a hora no fuso da conta de anúncio.
  day                   date not null,
  hour                  smallint not null,
  impressions           bigint not null default 0,
  clicks                bigint not null default 0,
  -- Na moeda da conta (`connected_account.currency`), com 6 casas.
  spend                 numeric(20, 6) not null default 0,
  -- Só o Google (as conversões da conta); nulo na Meta.
  conversions           numeric(20, 6),
  read_at               timestamptz not null default now(),
  primary key (connected_account_id, day, hour),
  constraint ad_hour_daily_provider check (provider in ('meta_ads', 'google_ads')),
  constraint ad_hour_daily_hora check (hour between 0 and 23),
  constraint ad_hour_daily_numeros check (impressions >= 0 and clicks >= 0 and spend >= 0 and coalesce(conversions, 0) >= 0)
);
create index if not exists idx_ad_hour_daily_marca on liame.ad_hour_daily (tenant_id, brand_id, day);

create table if not exists liame.ad_city_daily (
  connected_account_id  uuid not null references liame.connected_account (id) on delete cascade,
  tenant_id             uuid not null references liame.organization (id) on delete cascade,
  brand_id              uuid not null references liame.brand (id) on delete cascade,
  provider              text not null,
  day                   date not null,
  -- O id do lugar no Google (`geo_target_constant`); o nome fica em `region_geo_target`.
  geo_target_id         bigint not null,
  impressions           bigint not null default 0,
  clicks                bigint not null default 0,
  spend                 numeric(20, 6) not null default 0,
  conversions           numeric(20, 6),
  read_at               timestamptz not null default now(),
  primary key (connected_account_id, day, geo_target_id),
  constraint ad_city_daily_provider check (provider = 'google_ads'),
  constraint ad_city_daily_lugar check (geo_target_id > 0),
  constraint ad_city_daily_numeros check (impressions >= 0 and clicks >= 0 and spend >= 0 and coalesce(conversions, 0) >= 0)
);
create index if not exists idx_ad_city_daily_marca on liame.ad_city_daily (tenant_id, brand_id, day);

create table if not exists liame.region_geo_target (
  id              bigint primary key,
  name            text not null,
  canonical_name  text not null,
  -- City, Neighborhood, Municipality, State… como o Google escreve.
  target_type     text not null,
  country_code    text,
  fetched_at      timestamptz not null default now(),
  constraint region_geo_target_id check (id > 0),
  constraint region_geo_target_nome check (length(name) between 1 and 200 and length(canonical_name) between 1 and 400),
  constraint region_geo_target_tipo check (length(target_type) between 1 and 60),
  constraint region_geo_target_pais check (country_code is null or length(country_code) = 2)
);

-- ------------------------------------------------------------ acesso

alter table liame.ad_hour_daily enable row level security;
alter table liame.ad_hour_daily force row level security;
alter table liame.ad_city_daily enable row level security;
alter table liame.ad_city_daily force row level security;
alter table liame.region_geo_target enable row level security;
alter table liame.region_geo_target force row level security;

do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'liame' and tablename = 'ad_hour_daily' and policyname = 'ad_hour_daily_isolamento') then
    create policy ad_hour_daily_isolamento on liame.ad_hour_daily
      using (tenant_id = liame.current_tenant_id() or liame.system_scope())
      with check (tenant_id = liame.current_tenant_id() or liame.system_scope());
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'liame' and tablename = 'ad_city_daily' and policyname = 'ad_city_daily_isolamento') then
    create policy ad_city_daily_isolamento on liame.ad_city_daily
      using (tenant_id = liame.current_tenant_id() or liame.system_scope())
      with check (tenant_id = liame.current_tenant_id() or liame.system_scope());
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'liame' and tablename = 'region_geo_target' and policyname = 'region_geo_target_leitura') then
    create policy region_geo_target_leitura on liame.region_geo_target for select using (true);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'liame' and tablename = 'region_geo_target' and policyname = 'region_geo_target_sistema') then
    create policy region_geo_target_sistema on liame.region_geo_target using (liame.system_scope()) with check (liame.system_scope());
  end if;
end $$;

-- A janela lida substitui a guardada, e a conta desligada leva junto o que foi lido dela: o `delete`.
grant select, insert, update, delete on liame.ad_hour_daily to liame_app;
grant select, insert, update, delete on liame.ad_city_daily to liame_app;
grant select, insert, update on liame.region_geo_target to liame_app;

-- ------------------------------------------------------------ conferência

do $$ begin
  if (select count(*) from information_schema.tables
       where table_schema = 'liame' and table_name in ('ad_hour_daily', 'ad_city_daily', 'region_geo_target')) <> 3 then
    raise exception '0146: as tabelas da mídia por região não entraram';
  end if;
  if (select count(*) from pg_policies where schemaname = 'liame'
       and tablename in ('ad_hour_daily', 'ad_city_daily', 'region_geo_target')) <> 4 then
    raise exception '0146: as regras de acesso da mídia por região não entraram';
  end if;
  if (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'liame' and c.relname in ('ad_hour_daily', 'ad_city_daily', 'region_geo_target')
         and c.relrowsecurity and c.relforcerowsecurity) <> 3 then
    raise exception '0146: a RLS da mídia por região não está forçada';
  end if;
end $$;
