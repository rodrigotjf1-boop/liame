-- 0137 · Os números da região (plano da região, R2, parte 1; protótipo P40, aprovado pelo dono em 11/11/2026; base de
-- conhecimento §19). As fontes públicas da região viram tabelas do SISTEMA, no padrão da PTAX (D-RG-1, D-A3-14): sem
-- empresa, todos leem e só o sistema grava. Nenhum dado de empresa ou de pessoa entra aqui: por empresa fica só o
-- recorte (o código do município e o bairro da loja, em `unit`, desde a 0132), e o retrato é calculado na leitura.
-- (1) `region_district`: os bairros do Censo 2022 (IBGE, agregados por bairro: pessoas, domicílios, área e a renda do
--     responsável pelo domicílio, média e mediana, em valor de 2022). Entram uma vez, do arquivo do IBGE, e não mudam.
-- (2) `region_fact`: os números por lugar (Brasil, UF, município), indicador e período, com a fonte (tabelas da API de
--     agregados do IBGE: população, densidade, estimativa, renda per capita, restaurantes).
-- (3) `region_source_read`: a última leitura de cada fonte por lugar (quando deu certo, a última tentativa, o motivo da
--     falha e a próxima vez), para a tela dizer "lido em" e "não respondeu" e a rotina saber o que ler.
-- Idempotente, sem `drop`: as regras de acesso entram só se ainda não existem. Uma transação por arquivo (ADR-018).

-- ------------------------------------------------------------ (1) os bairros do Censo

create table if not exists liame.region_district (
  -- O código do bairro no IBGE (CD_BAIRRO: o município e mais 3 dígitos).
  district_code      text primary key check (district_code ~ '^[0-9]{10}$'),
  city_code          text not null check (city_code ~ '^[0-9]{7}$'),
  name               text not null check (length(btrim(name)) between 1 and 200),
  -- O nome sem acento, em minúsculas e sem espaço sobrando: é por ele que o bairro do CEP acha o do Censo.
  name_key           text not null check (length(name_key) between 1 and 200),
  area_km2           numeric(12, 6) check (area_km2 >= 0),
  population         integer check (population >= 0),
  households         integer check (households >= 0),
  -- A renda do responsável pelo domicílio, em reais de 2022 (V06004 média, V06006 mediana); nula sem o dado.
  head_income_mean   numeric(12, 2) check (head_income_mean >= 0),
  head_income_median numeric(12, 2) check (head_income_median >= 0),
  loaded_at          timestamptz not null default now()
);
create index if not exists idx_region_district_cidade on liame.region_district (city_code, name_key);

-- ------------------------------------------------------------ (2) os números por lugar

create table if not exists liame.region_fact (
  -- `brasil`, `uf`, `municipio` ou `rm` (região metropolitana do IPCA).
  geo_level   text not null check (geo_level in ('brasil', 'uf', 'municipio', 'rm')),
  geo_code    text not null check (geo_code ~ '^[0-9]{1,7}$'),
  indicator   text not null check (indicator ~ '^[a-z][a-z0-9_]{2,60}$'),
  -- O ano ("2022") ou o mês ("2026-09") do número.
  period      text not null check (period ~ '^[0-9]{4}(-[0-9]{2})?$'),
  value       numeric(20, 4) not null,
  -- A fonte no catálogo do código (`ibge_4714`, `ibge_10295`…).
  source      text not null check (source ~ '^[a-z][a-z0-9_]{2,40}$'),
  fetched_at  timestamptz not null default now(),
  primary key (geo_level, geo_code, indicator, period)
);

-- ------------------------------------------------------------ (3) a última leitura de cada fonte

create table if not exists liame.region_source_read (
  source       text not null check (source ~ '^[a-z][a-z0-9_]{2,40}$'),
  -- O lugar lido (o código do município) ou `0` para a fonte que vale para o país inteiro (os arquivos do Censo).
  geo_code     text not null check (geo_code ~ '^[0-9]{1,7}$'),
  last_ok_at   timestamptz,
  last_try_at  timestamptz not null,
  -- O motivo da última falha (o tipo, nunca a resposta inteira), nulo quando a última deu certo.
  last_error   text check (length(last_error) <= 300),
  next_try_at  timestamptz not null,
  primary key (source, geo_code)
);
create index if not exists idx_region_source_read_proxima on liame.region_source_read (next_try_at);

-- ------------------------------------------------------------ acesso: todos leem, só o sistema grava

alter table liame.region_district enable row level security;
alter table liame.region_district force row level security;
alter table liame.region_fact enable row level security;
alter table liame.region_fact force row level security;
alter table liame.region_source_read enable row level security;
alter table liame.region_source_read force row level security;

do $$
declare
  t text;
begin
  foreach t in array array['region_district', 'region_fact', 'region_source_read'] loop
    if not exists (select 1 from pg_policies where schemaname = 'liame' and tablename = t and policyname = t || '_leitura') then
      execute format('create policy %I on liame.%I for select using (true)', t || '_leitura', t);
    end if;
    if not exists (select 1 from pg_policies where schemaname = 'liame' and tablename = t and policyname = t || '_sistema') then
      execute format('create policy %I on liame.%I using (liame.system_scope()) with check (liame.system_scope())', t || '_sistema', t);
    end if;
  end loop;
end $$;

grant select, insert, update on liame.region_district to liame_app;
grant select, insert, update on liame.region_fact to liame_app;
grant select, insert, update on liame.region_source_read to liame_app;

-- ------------------------------------------------------------ conferência

do $$ begin
  if (select count(*) from information_schema.tables
       where table_schema = 'liame' and table_name in ('region_district', 'region_fact', 'region_source_read')) <> 3 then
    raise exception '0137: as tabelas da região não entraram';
  end if;
  if (select count(*) from pg_policies where schemaname = 'liame'
       and tablename in ('region_district', 'region_fact', 'region_source_read')) <> 6 then
    raise exception '0137: as regras de acesso da região não entraram';
  end if;
  if exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
              where n.nspname = 'liame' and c.relname in ('region_district', 'region_fact', 'region_source_read')
                and not (c.relrowsecurity and c.relforcerowsecurity)) then
    raise exception '0137: a RLS da região não está forçada';
  end if;
end $$;
