-- 0143 · A previsão do tempo por município (plano da região, R2, parte 5: a semana que vem; protótipo P40, aprovado pelo
-- dono em 11/11/2026; base de conhecimento §19.2). A rotina `regiao-fontes` do worker lê a previsão por dia do CPTEC/INPE,
-- pela BrasilAPI, para cada município com loja no mapa (a cada 6 horas) e guarda aqui os próximos dias; o código da
-- cidade no CPTEC fica na `region_fact` (`cptec_cidade`). Tabela do SISTEMA, no padrão da 0137 (D-RG-1): sem empresa,
-- todos leem, só o sistema grava. Nada da loja nem de pessoa: o município e o tempo de cada dia.
-- Idempotente, sem `drop`: as regras de acesso entram só se ainda não existem. Uma transação por arquivo (ADR-018).

create table if not exists liame.region_weather (
  -- O município no código do IBGE.
  geo_code       text not null check (geo_code ~ '^[0-9]{7}$'),
  day            date not null,
  -- O código da condição no CPTEC ("c" chuva, "pn" parcialmente nublado, "ps" predomínio de sol…) e o texto dele.
  condition      text not null check (condition ~ '^[a-z]{1,4}$'),
  condition_desc text not null check (length(btrim(condition_desc)) between 1 and 80),
  -- A mínima e a máxima do dia, em graus Celsius.
  min_c          smallint not null check (min_c between -30 and 60),
  max_c          smallint not null check (max_c between -30 and 60 and max_c >= min_c),
  fetched_at     timestamptz not null default now(),
  primary key (geo_code, day)
);

alter table liame.region_weather enable row level security;
alter table liame.region_weather force row level security;

do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'liame' and tablename = 'region_weather' and policyname = 'region_weather_leitura') then
    create policy region_weather_leitura on liame.region_weather for select using (true);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'liame' and tablename = 'region_weather' and policyname = 'region_weather_sistema') then
    create policy region_weather_sistema on liame.region_weather using (liame.system_scope()) with check (liame.system_scope());
  end if;
end $$;

-- Os dias passados saem a cada leitura: pede `delete`.
grant select, insert, update, delete on liame.region_weather to liame_app;

-- ------------------------------------------------------------ conferência

do $$ begin
  if not exists (select 1 from information_schema.tables where table_schema = 'liame' and table_name = 'region_weather') then
    raise exception '0143: a tabela da previsão do tempo não entrou';
  end if;
  if (select count(*) from pg_policies where schemaname = 'liame' and tablename = 'region_weather') <> 2 then
    raise exception '0143: as regras de acesso da previsão do tempo não entraram';
  end if;
  if not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                  where n.nspname = 'liame' and c.relname = 'region_weather' and c.relrowsecurity and c.relforcerowsecurity) then
    raise exception '0143: a RLS da previsão do tempo não está forçada';
  end if;
end $$;
