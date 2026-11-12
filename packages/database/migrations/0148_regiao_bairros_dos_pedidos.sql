-- 0148 · Os pedidos da loja por bairro (plano da região, R3, parte 2; D-RG-8; `plano-regiao.md` R3).
-- O que o Regem manda pela rota `GET /pedidos/bairros` (contrato `docs/integracoes/regem.md` §2.5): os pedidos de
-- entrega confirmados das 4 semanas completas até ontem, no fuso da loja, somados por bairro. O bairro com menos
-- pedidos que o mínimo do Regem vem somado em "outros", sem o nome. Nunca há cliente, telefone, rua, número nem CEP.
-- Uma linha por item da resposta, na ordem dela: os bairros, depois "outros", "sem bairro" e "retirada e balcão". A
-- leitura é da rotina das vendas do Regem (uma vez por dia por loja, só para a marca com a função `regiao` ligada) e
-- substitui a anterior; a conta desligada leva junto o que foi lido dela.
-- Idempotente; uma transação por arquivo (ADR-018).

create table if not exists liame.region_order_district (
  connected_account_id  uuid not null references liame.connected_account (id) on delete cascade,
  tenant_id             uuid not null references liame.organization (id) on delete cascade,
  brand_id              uuid not null references liame.brand (id) on delete cascade,
  unit_id               uuid references liame.unit (id) on delete cascade,
  -- A ordem na resposta do Regem (os bairros vêm do que tem mais pedidos para o que tem menos).
  position              smallint not null,
  -- `bairro`, `outros` (os bairros abaixo do mínimo, somados), `sem_bairro` ou `retirada` (retirada e balcão).
  kind                  text not null,
  district              text,
  city                  text,
  uf                    text,
  -- Em `outros`: quantos bairros foram somados.
  districts             integer,
  orders                integer not null,
  -- A receita líquida (sem a gorjeta), em micros; nula em `retirada`.
  revenue_micros        bigint,
  day_from              date not null,
  day_to                date not null,
  -- O mínimo de pedidos por bairro que o Regem usou.
  minimum               smallint not null,
  read_at               timestamptz not null default now(),
  primary key (connected_account_id, position),
  constraint region_order_district_tipo check (kind in ('bairro', 'outros', 'sem_bairro', 'retirada')),
  constraint region_order_district_nome check (
    (kind = 'bairro' and district is not null and length(district) between 1 and 120) or (kind <> 'bairro' and district is null)),
  constraint region_order_district_lugar check (coalesce(length(city), 0) <= 120 and coalesce(length(uf), 0) <= 2),
  constraint region_order_district_numeros check (
    orders >= 0 and coalesce(districts, 0) >= 0 and coalesce(revenue_micros, 0) >= 0 and minimum between 1 and 1000 and position >= 0),
  constraint region_order_district_janela check (day_from <= day_to)
);
create index if not exists idx_region_order_district_loja on liame.region_order_district (tenant_id, unit_id);

alter table liame.region_order_district enable row level security;
alter table liame.region_order_district force row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'liame' and tablename = 'region_order_district' and policyname = 'region_order_district_isolamento') then
    create policy region_order_district_isolamento on liame.region_order_district
      using (tenant_id = liame.current_tenant_id() or liame.system_scope())
      with check (tenant_id = liame.current_tenant_id() or liame.system_scope());
  end if;
end $$;

-- A leitura substitui a anterior, e a conta desligada leva junto o que foi lido dela: o `delete`.
grant select, insert, update, delete on liame.region_order_district to liame_app;

-- ------------------------------------------------------------ conferência

do $$ begin
  if not exists (select 1 from information_schema.tables where table_schema = 'liame' and table_name = 'region_order_district') then
    raise exception '0148: a tabela dos pedidos por bairro não entrou';
  end if;
  if (select count(*) from pg_policies where schemaname = 'liame' and tablename = 'region_order_district') <> 1 then
    raise exception '0148: a regra de acesso dos pedidos por bairro não entrou';
  end if;
  if not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                  where n.nspname = 'liame' and c.relname = 'region_order_district' and c.relrowsecurity and c.relforcerowsecurity) then
    raise exception '0148: a RLS dos pedidos por bairro não está forçada';
  end if;
end $$;
