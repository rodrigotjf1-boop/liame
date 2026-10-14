-- 0072 · As buscas do Search Console, lidas e guardadas (A6, Z3, parte c; `plano-a6.md` Z3).
-- O que o Liame guarda do que lê de cada site do Search Console ligado a uma marca (a conta `search_console`):
-- (1) `search_console_daily`: os números do site por dia (os cliques, as vezes em que ele apareceu nas buscas do Google
--     e a posição média), o total do dia, que inclui as buscas raras que o Google não mostra uma a uma. São contagens:
--     nenhum dado de pessoa. O dia é o do Search Console (fuso do Pacífico).
-- (2) `search_console_query_week`: as buscas que mais trouxeram cliques ao site em cada semana (de segunda a domingo,
--     até 100 por semana), com os mesmos números. O texto é o que as pessoas digitaram no Google: o Google não mostra a
--     busca feita por poucas pessoas, mas o texto pode trazer, raramente, algo pessoal que alguém digitou. Por isso a
--     classe é PERSONAL e a guarda é de 12 meses, contados do começo da semana (como o texto das avaliações, D-A6-5).
-- A leitura é da rotina `search-console` do worker, só para a empresa com a função `search_console` ligada. O frescor
-- fica em `sync_state`, com os conjuntos `buscas_dias` e `buscas_semanas`.
-- Idempotente; uma transação por arquivo (ADR-018).

-- ------------------------------------------------------------ os números do site por dia

create table if not exists liame.search_console_daily (
  connected_account_id  uuid not null references liame.connected_account (id) on delete cascade,
  tenant_id             uuid not null references liame.organization (id) on delete cascade,
  brand_id              uuid not null references liame.brand (id) on delete cascade,
  -- O dia como o Search Console o conta (fuso do Pacífico).
  day                   date not null,
  clicks                bigint not null check (clicks >= 0),
  impressions           bigint not null check (impressions >= 0),
  -- A posição média nas buscas (1 é o primeiro lugar); nula quando o site não apareceu.
  position              numeric(8, 2) check (position >= 1),
  read_at               timestamptz not null default now(),
  primary key (connected_account_id, day),
  constraint search_console_daily_cliques check (clicks <= impressions),
  constraint search_console_daily_posicao check (position is null or impressions > 0)
);
create index if not exists idx_search_console_daily_marca on liame.search_console_daily (tenant_id, brand_id, day);

alter table liame.search_console_daily enable row level security;
alter table liame.search_console_daily force row level security;
drop policy if exists search_console_daily_isolamento on liame.search_console_daily;
create policy search_console_daily_isolamento on liame.search_console_daily
  using (tenant_id = liame.current_tenant_id() or liame.system_scope())
  with check (tenant_id = liame.current_tenant_id() or liame.system_scope());
grant select, insert, update on liame.search_console_daily to liame_app;

-- ------------------------------------------------------------ as buscas da semana

create table if not exists liame.search_console_query_week (
  connected_account_id  uuid not null references liame.connected_account (id) on delete cascade,
  tenant_id             uuid not null references liame.organization (id) on delete cascade,
  brand_id              uuid not null references liame.brand (id) on delete cascade,
  -- A segunda-feira da semana (as datas do Search Console, fuso do Pacífico).
  week_start            date not null check (extract(isodow from week_start) = 1),
  -- O que as pessoas digitaram no Google, como ele mostra.
  query                 text not null check (length(query) between 1 and 500),
  clicks                bigint not null check (clicks >= 0),
  impressions           bigint not null check (impressions >= 0),
  position              numeric(8, 2) check (position >= 1),
  read_at               timestamptz not null default now(),
  primary key (connected_account_id, week_start, query),
  constraint search_console_query_week_cliques check (clicks <= impressions),
  constraint search_console_query_week_posicao check (position is null or impressions > 0)
);
create index if not exists idx_search_console_query_week_marca on liame.search_console_query_week (tenant_id, brand_id, week_start);
-- O expurgo varre pela semana.
create index if not exists idx_search_console_query_week_guarda on liame.search_console_query_week (week_start);

alter table liame.search_console_query_week enable row level security;
alter table liame.search_console_query_week force row level security;
drop policy if exists search_console_query_week_isolamento on liame.search_console_query_week;
create policy search_console_query_week_isolamento on liame.search_console_query_week
  using (tenant_id = liame.current_tenant_id() or liame.system_scope())
  with check (tenant_id = liame.current_tenant_id() or liame.system_scope());
-- A leitura de uma semana substitui a anterior da mesma semana (a lista do Google manda): por isso o `delete`.
grant select, insert, update, delete on liame.search_console_query_week to liame_app;
