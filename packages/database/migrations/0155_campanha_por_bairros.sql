-- 0155 · A campanha por bairros (plano da região, R6, parte 3; revisão R6-3 da P42 aprovada pelo dono em 13/11/2026,
-- D-RG-53 a D-RG-57). Quem vê a campanha nova na Meta pode ser o raio em volta da loja (como era) ou de 1 a 20 bairros
-- do município da loja:
--   * `region_district_point`: o centro de cada bairro do IBGE pelo OpenStreetMap (a mesma procura da loja na R1, com o
--     cache que as regras do Nominatim pedem) e o bairro na busca de lugares da Meta (a chave, quando a busca achou o
--     mesmo nome na mesma cidade; nula, vai um círculo no centro). Do produto, sem empresa: todos leem, só o sistema grava.
--   * `ad_campaign_new.districts`: os bairros da campanha como foram para o pedido (o código e o nome do IBGE, a chave da
--     Meta ou o círculo com o centro e o raio); o raio (`radius_km`) passa a ser nulo na campanha por bairros: um ou outro.
-- Idempotente; uma transação por arquivo (ADR-018).

create table if not exists liame.region_district_point (
  district_code   text primary key references liame.region_district (district_code) on delete cascade,
  -- `achado` (o centro no município, pelo OpenStreetMap) ou `nao_achado` (o mapa respondeu e não achou o bairro).
  located         text not null check (located in ('achado', 'nao_achado')),
  latitude        numeric(9, 6) check (latitude between -34 and 6),
  longitude       numeric(9, 6) check (longitude between -75 and -28),
  located_at      timestamptz not null default now(),
  -- A chave do bairro na busca de lugares da Meta; nula quando a busca não achou (ou a Meta não tem bairros aqui).
  meta_location   text check (length(meta_location) between 1 and 60),
  -- Quando a Meta foi perguntada; nulo: ainda não (vai o círculo até perguntar).
  meta_checked_at timestamptz,
  constraint region_district_point_centro check ((located = 'achado') = (latitude is not null and longitude is not null)),
  constraint region_district_point_meta check (meta_location is null or meta_checked_at is not null)
);

alter table liame.ad_campaign_new add column if not exists districts jsonb;
alter table liame.ad_campaign_new alter column radius_km drop not null;

do $$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'liame.ad_campaign_new'::regclass and conname = 'ad_campaign_new_quem_ve') then
    alter table liame.ad_campaign_new add constraint ad_campaign_new_quem_ve
      check ((radius_km is null) = (districts is not null)
             and (districts is null or (jsonb_typeof(districts) = 'array' and jsonb_array_length(districts) between 1 and 20)));
  end if;
end $$;

-- ------------------------------------------------------------ acesso: todos leem, só o sistema grava (V51)

alter table liame.region_district_point enable row level security;
alter table liame.region_district_point force row level security;

do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'liame' and tablename = 'region_district_point' and policyname = 'region_district_point_leitura') then
    create policy region_district_point_leitura on liame.region_district_point for select using (true);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'liame' and tablename = 'region_district_point' and policyname = 'region_district_point_sistema') then
    create policy region_district_point_sistema on liame.region_district_point using (liame.system_scope()) with check (liame.system_scope());
  end if;
end $$;

grant select, insert, update on liame.region_district_point to liame_app;

-- ------------------------------------------------------------ conferência

do $$ begin
  if not exists (select 1 from information_schema.tables where table_schema = 'liame' and table_name = 'region_district_point') then
    raise exception '0155: a tabela dos centros dos bairros não entrou';
  end if;
  if (select count(*) from pg_policies where schemaname = 'liame' and tablename = 'region_district_point') <> 2 then
    raise exception '0155: as regras de acesso dos centros dos bairros não entraram';
  end if;
  if exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
              where n.nspname = 'liame' and c.relname = 'region_district_point' and not (c.relrowsecurity and c.relforcerowsecurity)) then
    raise exception '0155: a RLS dos centros dos bairros não está forçada';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'liame' and table_name = 'ad_campaign_new' and column_name = 'districts') then
    raise exception '0155: a coluna dos bairros da campanha não entrou';
  end if;
  if (select is_nullable from information_schema.columns where table_schema = 'liame' and table_name = 'ad_campaign_new' and column_name = 'radius_km') <> 'YES' then
    raise exception '0155: o raio da campanha continua obrigatório';
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'liame.ad_campaign_new'::regclass and conname = 'ad_campaign_new_quem_ve') then
    raise exception '0155: a regra do raio ou dos bairros não entrou';
  end if;
end $$;
