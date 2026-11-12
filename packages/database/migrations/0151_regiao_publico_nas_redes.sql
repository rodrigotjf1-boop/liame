-- 0151 · O público nas redes (plano da região, R4, parte 3; D-RG-40 a D-RG-43; base §19.7; `plano-regiao.md` R4).
-- O que o Instagram e a Página do Facebook ligados à marca dizem da conta inteira (não de um post):
--   * `social_audience`: a última leitura de cada conta, das 4 semanas completas até ontem (no fuso da loja): os
--     seguidores agora, quem seguiu e quem deixou de seguir, os toques nos botões do perfil (só o Instagram), as visitas
--     (só a Página) e, só do Instagram, as cidades dos seguidores (as 45 maiores, relidas uma vez por semana; o Instagram
--     só informa a partir de 100 seguidores). A leitura nova substitui a anterior.
--   * `social_follower_daily`: a série dos seguidores, um número por dia de leitura (o Instagram só devolve 30 dias da
--     série dele; o Liame guarda a própria, D-RG-40), 400 dias por conta.
-- A leitura é da rotina `regiao-publico` do worker, uma vez por dia, só para a marca com a função `regiao` ligada; o
-- frescor fica em `sync_state`, com o conjunto `regiao_publico`. A conta desligada leva junto o que foi lido dela. Nada
-- de pessoa: só somas da conta, como a Meta entrega.
-- Idempotente; uma transação por arquivo (ADR-018).

create table if not exists liame.social_audience (
  connected_account_id  uuid primary key references liame.connected_account (id) on delete cascade,
  tenant_id             uuid not null references liame.organization (id) on delete cascade,
  brand_id              uuid not null references liame.brand (id) on delete cascade,
  provider              text not null,
  -- As 4 semanas completas até ontem da leitura, no fuso da loja.
  day_from              date not null,
  day_to                date not null,
  -- O `followers_count` do nó no momento da leitura.
  followers             bigint,
  -- Quem seguiu e quem deixou de seguir na janela (no Instagram, nulo com menos de 100 seguidores).
  follows               bigint,
  unfollows             bigint,
  -- Só o Instagram: {"como_chegar": n, "ligar": n, "mensagem": n, "outros": n} (`profile_links_taps`).
  taps                  jsonb,
  -- Só a Página: as visitas na janela (`page_views_total`).
  page_views            bigint,
  -- Só o Instagram: [{"cidade": "Rio de Janeiro, Rio de Janeiro", "seguidores": n}], as 45 maiores.
  cities                jsonb,
  cities_read_at        timestamptz,
  read_at               timestamptz not null default now(),
  constraint social_audience_provider check (provider in ('instagram', 'facebook_page')),
  constraint social_audience_janela check (day_from <= day_to),
  constraint social_audience_numeros check (coalesce(followers, 0) >= 0 and coalesce(follows, 0) >= 0 and coalesce(unfollows, 0) >= 0 and coalesce(page_views, 0) >= 0),
  constraint social_audience_toques check (taps is null or (provider = 'instagram' and jsonb_typeof(taps) = 'object')),
  constraint social_audience_visitas check (page_views is null or provider = 'facebook_page'),
  constraint social_audience_cidades check (cities is null or (provider = 'instagram' and jsonb_typeof(cities) = 'array' and jsonb_array_length(cities) <= 45))
);
create index if not exists idx_social_audience_marca on liame.social_audience (tenant_id, brand_id);

create table if not exists liame.social_follower_daily (
  connected_account_id  uuid not null references liame.connected_account (id) on delete cascade,
  tenant_id             uuid not null references liame.organization (id) on delete cascade,
  brand_id              uuid not null references liame.brand (id) on delete cascade,
  provider              text not null,
  -- O dia da leitura, no fuso da loja.
  day                   date not null,
  followers             bigint not null,
  read_at               timestamptz not null default now(),
  primary key (connected_account_id, day),
  constraint social_follower_daily_provider check (provider in ('instagram', 'facebook_page')),
  constraint social_follower_daily_numero check (followers >= 0)
);
create index if not exists idx_social_follower_daily_marca on liame.social_follower_daily (tenant_id, brand_id, day);

-- ------------------------------------------------------------ acesso

alter table liame.social_audience enable row level security;
alter table liame.social_audience force row level security;
alter table liame.social_follower_daily enable row level security;
alter table liame.social_follower_daily force row level security;

do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'liame' and tablename = 'social_audience' and policyname = 'social_audience_isolamento') then
    create policy social_audience_isolamento on liame.social_audience
      using (tenant_id = liame.current_tenant_id() or liame.system_scope())
      with check (tenant_id = liame.current_tenant_id() or liame.system_scope());
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'liame' and tablename = 'social_follower_daily' and policyname = 'social_follower_daily_isolamento') then
    create policy social_follower_daily_isolamento on liame.social_follower_daily
      using (tenant_id = liame.current_tenant_id() or liame.system_scope())
      with check (tenant_id = liame.current_tenant_id() or liame.system_scope());
  end if;
end $$;

-- A leitura nova substitui a anterior, a série perde o que passa de 400 dias e a conta desligada leva junto o que foi
-- lido dela: o `delete`.
grant select, insert, update, delete on liame.social_audience to liame_app;
grant select, insert, update, delete on liame.social_follower_daily to liame_app;

-- ------------------------------------------------------------ conferência

do $$ begin
  if (select count(*) from information_schema.tables
       where table_schema = 'liame' and table_name in ('social_audience', 'social_follower_daily')) <> 2 then
    raise exception '0151: as tabelas do público nas redes não entraram';
  end if;
  if (select count(*) from pg_policies where schemaname = 'liame'
       and tablename in ('social_audience', 'social_follower_daily')) <> 2 then
    raise exception '0151: as regras de acesso do público nas redes não entraram';
  end if;
  if (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'liame' and c.relname in ('social_audience', 'social_follower_daily')
         and c.relrowsecurity and c.relforcerowsecurity) <> 2 then
    raise exception '0151: a RLS do público nas redes não está forçada';
  end if;
end $$;
