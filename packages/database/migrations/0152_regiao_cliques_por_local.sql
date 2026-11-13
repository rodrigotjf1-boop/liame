-- 0152 · Os cliques por local mais específico, para medir os bairros (plano da região, R4; pedido do dono em 12/11/2026:
-- "os cliques não dá para vir por bairro?"). A Meta só informa o estado; o Google informa, na mesma `user_location_view`
-- da cidade, o local mais específico de quem viu e clicou (`segments.geo_target_most_specific_location`): o bairro ou o
-- CEP quando o Google tem o lugar, senão a cidade. Esta entrega só lê e guarda, sem tela, para medir quanto dos cliques
-- vem com bairro na conta da loja; a tela ("Município | Bairro") vem depois, numa revisão do P40.
--   * `ad_local_daily`: por conta de anúncio do Google, por dia e pelo local mais específico (o id em
--     `region_geo_target`, com o tipo: City, Neighborhood, Postal Code…), os mesmos números de `ad_city_daily`.
-- A leitura é a da rotina `regiao-midia` (uma vez por dia, só com a função `regiao` ligada); a leitura que vem substitui a
-- guardada; a que falha deixa a de antes; a conta desligada leva junto o que foi lido dela.
-- A medição sai logo depois do deploy pelo código, não por aqui: a leitura da mídia ganhou uma versão no cursor, e a
-- conta lida pela versão anterior fica devida quando o worker novo sobe (esta migration entra antes do merge, e
-- antecipar a leitura daqui faria o worker antigo ler sem o local).
-- Idempotente; uma transação por arquivo (ADR-018).

create table if not exists liame.ad_local_daily (
  connected_account_id  uuid not null references liame.connected_account (id) on delete cascade,
  tenant_id             uuid not null references liame.organization (id) on delete cascade,
  brand_id              uuid not null references liame.brand (id) on delete cascade,
  provider              text not null,
  day                   date not null,
  -- O id do local mais específico no Google (`geo_target_constant`); o nome e o tipo ficam em `region_geo_target`.
  geo_target_id         bigint not null,
  impressions           bigint not null default 0,
  clicks                bigint not null default 0,
  spend                 numeric(20, 6) not null default 0,
  conversions           numeric(20, 6),
  read_at               timestamptz not null default now(),
  primary key (connected_account_id, day, geo_target_id),
  constraint ad_local_daily_provider check (provider = 'google_ads'),
  constraint ad_local_daily_lugar check (geo_target_id > 0),
  constraint ad_local_daily_numeros check (impressions >= 0 and clicks >= 0 and spend >= 0 and coalesce(conversions, 0) >= 0)
);
create index if not exists idx_ad_local_daily_marca on liame.ad_local_daily (tenant_id, brand_id, day);

-- ------------------------------------------------------------ acesso

alter table liame.ad_local_daily enable row level security;
alter table liame.ad_local_daily force row level security;

do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'liame' and tablename = 'ad_local_daily' and policyname = 'ad_local_daily_isolamento') then
    create policy ad_local_daily_isolamento on liame.ad_local_daily
      using (tenant_id = liame.current_tenant_id() or liame.system_scope())
      with check (tenant_id = liame.current_tenant_id() or liame.system_scope());
  end if;
end $$;

-- A leitura que vem substitui a guardada, e a conta desligada leva junto o que foi lido dela: o `delete`.
grant select, insert, update, delete on liame.ad_local_daily to liame_app;

-- ------------------------------------------------------------ conferência

do $$ begin
  if not exists (select 1 from information_schema.tables where table_schema = 'liame' and table_name = 'ad_local_daily') then
    raise exception '0152: a tabela dos cliques por local não entrou';
  end if;
  if (select count(*) from pg_policies where schemaname = 'liame' and tablename = 'ad_local_daily') <> 1 then
    raise exception '0152: a regra de acesso dos cliques por local não entrou';
  end if;
  if not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                  where n.nspname = 'liame' and c.relname = 'ad_local_daily' and c.relrowsecurity and c.relforcerowsecurity) then
    raise exception '0152: a RLS dos cliques por local não está forçada';
  end if;
end $$;
