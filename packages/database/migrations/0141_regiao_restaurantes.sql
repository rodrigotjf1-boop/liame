-- 0141 · Os restaurantes ativos por município, bairro e CEP (plano da região, R2, parte 4; base de conhecimento §19.5).
-- A fonte é o cadastro aberto de CNPJ da Receita Federal (os arquivos `Estabelecimentos0..9.zip` de cada mês). Esses
-- arquivos trazem dado pessoal (nome fantasia, endereço de MEI, telefone, e-mail): a rotina do worker lê em fluxo e
-- aqui entram SÓ contagens (quantos estabelecimentos por lugar e tipo). Nenhum nome, endereço, telefone, e-mail ou
-- CNPJ é guardado. Duas tabelas do SISTEMA, no padrão da PTAX e da 0137 (D-RG-1): sem empresa, todos leem, só o
-- sistema grava.
-- (1) `region_food_count`: o retrato do mês mais novo lido por inteiro, por município (código do IBGE), por bairro do
--     Censo (o código do bairro) e por CEP (os 5 primeiros dígitos). Troca inteiro quando o mês novo termina.
-- (2) `region_food_part`: as contagens de cada um dos 10 arquivos do mês em leitura; quando os 10 entram, somam-se na
--     (1) e saem daqui. Cada arquivo é uma leitura própria: o worker que reinicia no meio refaz só aquele arquivo.
-- Idempotente, sem `drop`: as regras de acesso entram só se ainda não existem. Uma transação por arquivo (ADR-018).

-- ------------------------------------------------------------ (1) o retrato do mês

create table if not exists liame.region_food_count (
  -- O município no código do IBGE (a Receita usa um código próprio; a rotina traduz).
  geo_code          text not null check (geo_code ~ '^[0-9]{7}$'),
  -- `municipio` (área vazia), `bairro` (o código do bairro do Censo, 10 dígitos) ou `cep` (os 5 primeiros dígitos).
  area_kind         text not null check (area_kind in ('municipio', 'bairro', 'cep')),
  area_key          text not null check (
                      (area_kind = 'municipio' and area_key = '')
                      or (area_kind = 'bairro' and area_key ~ '^[0-9]{10}$')
                      or (area_kind = 'cep' and area_key ~ '^[0-9]{5}$')),
  -- O mês dos arquivos da Receita ("2026-10").
  period            text not null check (period ~ '^[0-9]{4}-[0-9]{2}$'),
  -- Ativos (situação cadastral 02) por CNAE principal: restaurante (5611-2/01), lanchonete (5611-2/03), bar (5611-2/04
  -- e 5611-2/05) e comida para casa (5620-1/04).
  active            integer not null check (active >= 0),
  active_restaurant integer not null check (active_restaurant >= 0),
  active_snack      integer not null check (active_snack >= 0),
  active_bar        integer not null check (active_bar >= 0),
  active_home       integer not null check (active_home >= 0),
  -- Abertos nos 12 meses antes do mês dos arquivos (início de atividade) e baixados no mesmo período (situação 08).
  opened_12m        integer not null check (opened_12m >= 0),
  closed_12m        integer not null check (closed_12m >= 0),
  loaded_at         timestamptz not null default now(),
  primary key (geo_code, area_kind, area_key)
);

-- ------------------------------------------------------------ (2) os arquivos do mês em leitura

create table if not exists liame.region_food_part (
  period            text not null check (period ~ '^[0-9]{4}-[0-9]{2}$'),
  -- O número do arquivo (`Estabelecimentos0.zip` a `Estabelecimentos9.zip`).
  part              smallint not null check (part between 0 and 9),
  geo_code          text not null check (geo_code ~ '^[0-9]{7}$'),
  area_kind         text not null check (area_kind in ('municipio', 'bairro', 'cep')),
  area_key          text not null check (
                      (area_kind = 'municipio' and area_key = '')
                      or (area_kind = 'bairro' and area_key ~ '^[0-9]{10}$')
                      or (area_kind = 'cep' and area_key ~ '^[0-9]{5}$')),
  active            integer not null check (active >= 0),
  active_restaurant integer not null check (active_restaurant >= 0),
  active_snack      integer not null check (active_snack >= 0),
  active_bar        integer not null check (active_bar >= 0),
  active_home       integer not null check (active_home >= 0),
  opened_12m        integer not null check (opened_12m >= 0),
  closed_12m        integer not null check (closed_12m >= 0),
  primary key (period, part, geo_code, area_kind, area_key)
);

-- ------------------------------------------------------------ acesso: todos leem, só o sistema grava

alter table liame.region_food_count enable row level security;
alter table liame.region_food_count force row level security;
alter table liame.region_food_part enable row level security;
alter table liame.region_food_part force row level security;

do $$
declare
  t text;
begin
  foreach t in array array['region_food_count', 'region_food_part'] loop
    if not exists (select 1 from pg_policies where schemaname = 'liame' and tablename = t and policyname = t || '_leitura') then
      execute format('create policy %I on liame.%I for select using (true)', t || '_leitura', t);
    end if;
    if not exists (select 1 from pg_policies where schemaname = 'liame' and tablename = t and policyname = t || '_sistema') then
      execute format('create policy %I on liame.%I using (liame.system_scope()) with check (liame.system_scope())', t || '_sistema', t);
    end if;
  end loop;
end $$;

-- O retrato do mês troca inteiro e os arquivos lidos saem depois da soma: as duas pedem `delete`.
grant select, insert, update, delete on liame.region_food_count to liame_app;
grant select, insert, update, delete on liame.region_food_part to liame_app;

-- ------------------------------------------------------------ conferência

do $$ begin
  if (select count(*) from information_schema.tables
       where table_schema = 'liame' and table_name in ('region_food_count', 'region_food_part')) <> 2 then
    raise exception '0141: as tabelas dos restaurantes não entraram';
  end if;
  if (select count(*) from pg_policies where schemaname = 'liame'
       and tablename in ('region_food_count', 'region_food_part')) <> 4 then
    raise exception '0141: as regras de acesso dos restaurantes não entraram';
  end if;
  if exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
              where n.nspname = 'liame' and c.relname in ('region_food_count', 'region_food_part')
                and not (c.relrowsecurity and c.relforcerowsecurity)) then
    raise exception '0141: a RLS dos restaurantes não está forçada';
  end if;
end $$;
