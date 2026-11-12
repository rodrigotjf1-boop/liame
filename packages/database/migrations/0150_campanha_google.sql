-- 0150 · A campanha nova no Google, criada pausada: o pedido (A5, Y9, parte 2; P45 pré-aprovado em 12/11/2026; D-A5-21
-- a D-A5-26; `plano-a5.md` Y9). A peça de texto aprovada em Criativos, com os textos nos tamanhos do Google e a foto da
-- loja (Fotos), vira um pedido de criar uma campanha Performance Max no Google, pausada; ativar é outro pedido.
-- (1) A capacidade no registro, na versão das outras do Google (v25), pela documentação lida em 12/11/2026 (base de
--     conhecimento §3.1: a criação da Performance Max, os grupos de recursos e os requisitos de cada recurso).
-- (2) A função `campanha_google`, desligada.
-- (3) A campanha nova do Google (`google_campaign_new`): o que a pessoa pediu (a peça e a versão, os textos, a foto, o
--     nome da loja, o raio em volta da loja, a verba diária e o fim) e o que já existe no Google. A criação é uma
--     requisição só (D-A5-25): o Google cria tudo ou nada. Um pedido em aberto por peça.
-- Da distribuição (o registro e a função) e das empresas (a campanha nova). Idempotente; uma transação por arquivo
-- (ADR-018).

-- As sementes gravam em tabelas com RLS forçada (V20).
select set_config('app.scope', 'sistema', true);

-- ------------------------------------------------------------ (1) a capacidade

insert into liame.connector_capability (provider, capability, api_version, read, write, required_scope, access_level, sunset_at, source_url, verified_at, notes) values
  ('google_ads', 'campanha_criar', 'v25', false, true, '{https://www.googleapis.com/auth/adwords}', 'Explorer', null,
   'https://developers.google.com/google-ads/api/performance-max/create-campaign', '2026-11-12',
   'Google Ads API: a Performance Max numa requisição só (GoogleAdsService.Mutate, conferida antes com validate_only): o orçamento, a campanha PAUSED com MaximizeConversions, o raio em volta da loja, o nome e a logo da loja (as diretrizes da marca), e o grupo de recursos com os títulos, os títulos longos, as descrições, as imagens deitada e quadrada e a URL final; tudo ou nada')
on conflict (provider, capability) do nothing;

-- ------------------------------------------------------------ (2) a função

insert into liame.feature_flag (key, kind, default_value, description, owner, is_write)
values ('campanha_google', 'boolean', 'false', 'Campanha nova no Google: a peça aprovada vira uma Performance Max criada pausada, com aprovação e o código do app (A5, Y9)', 'midia', false)
on conflict (key) do nothing;

-- ------------------------------------------------------------ (3) a campanha nova do Google

create table if not exists liame.google_campaign_new (
  id                    uuid primary key,
  tenant_id             uuid not null references liame.organization (id) on delete cascade,
  brand_id              uuid not null references liame.brand (id) on delete cascade,
  -- A conta do Google Ads da marca (uma só).
  ad_account_id         uuid not null references liame.connected_account (id) on delete cascade,
  -- A peça de texto aprovada, na versão que a pessoa viu, e os textos nos tamanhos do Google (D-A5-22: de 3 a 15
  -- títulos de até 30 caracteres, de 1 a 5 títulos longos de até 90, de 2 a 5 descrições de até 90; a rota confere os
  -- tamanhos, aqui ficam as quantidades).
  piece_id              uuid not null references liame.ad_piece (id) on delete cascade,
  piece_version         integer not null check (piece_version >= 1),
  headlines             text[] not null check (cardinality(headlines) between 3 and 15),
  long_headlines        text[] not null check (cardinality(long_headlines) between 1 and 5),
  descriptions          text[] not null check (cardinality(descriptions) between 2 and 5),
  -- O nome da loja que o Google mostra (até 25 caracteres) e a foto de Fotos que o Liame recorta (D-A5-23).
  business_name         text not null check (length(business_name) between 1 and 25),
  media_id              uuid not null references liame.brand_photo (id) on delete cascade,
  -- A loja do raio (o mesmo da campanha da Meta: o ponto no endereço) e o cardápio de destino (D-A5-26).
  unit_id               uuid not null references liame.unit (id) on delete cascade,
  link                  text not null check (length(link) between 1 and 2000),
  name                  text not null check (length(name) between 1 and 80),
  radius_km             numeric(3, 1) not null check (radius_km between 1 and 15),
  daily_budget_micros   bigint not null check (daily_budget_micros > 0),
  end_date              date,
  action_id             uuid references liame.action_request (id) on delete set null,
  status                text not null default 'pedida' check (status in ('pedida', 'criando', 'criada', 'nao_criada', 'cancelada')),
  version               integer not null default 1,
  -- O que existe no Google depois da criação (a requisição é uma só: ou os três, ou nenhum).
  google_budget_id      text,
  google_campaign_id    text,
  google_asset_group_id text,
  error                 text check (error is null or length(error) <= 2000),
  active                boolean not null default false,
  activated_at          timestamptz,
  created_by            uuid references liame.app_user (id) on delete set null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint google_campaign_new_ativa_criada check (not active or status = 'criada'),
  constraint google_campaign_new_no_google check (
    (google_campaign_id is null and google_budget_id is null and google_asset_group_id is null)
    or (google_campaign_id is not null and google_budget_id is not null and google_asset_group_id is not null))
);
create index if not exists idx_google_campaign_new_tenant on liame.google_campaign_new (tenant_id);
create index if not exists idx_google_campaign_new_brand on liame.google_campaign_new (brand_id, created_at desc);
-- Um pedido em aberto por peça: o segundo pedido com a mesma peça espera o primeiro ser decidido.
create unique index if not exists google_campaign_new_peca_em_aberto on liame.google_campaign_new (piece_id) where status in ('pedida', 'criando');

alter table liame.google_campaign_new enable row level security;
alter table liame.google_campaign_new force row level security;
drop policy if exists google_campaign_new_isolamento on liame.google_campaign_new;
create policy google_campaign_new_isolamento on liame.google_campaign_new
  using (tenant_id = liame.current_tenant_id() or liame.system_scope())
  with check (tenant_id = liame.current_tenant_id() or liame.system_scope());
grant select, insert, update on liame.google_campaign_new to liame_app;

-- ------------------------------------------------------------ conferência

do $$ begin
  if not exists (select 1 from liame.connector_capability where provider = 'google_ads' and capability = 'campanha_criar' and write) then
    raise exception '0150: a capacidade da campanha nova no Google não entrou';
  end if;
  if not exists (select 1 from liame.feature_flag where key = 'campanha_google' and default_value = 'false'::jsonb and not is_write) then
    raise exception '0150: a função campanha_google não entrou desligada';
  end if;
  if not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                  where n.nspname = 'liame' and c.relname = 'google_campaign_new' and c.relrowsecurity and c.relforcerowsecurity) then
    raise exception '0150: a campanha nova do Google não entrou com a RLS forçada';
  end if;
  if not exists (select 1 from pg_indexes where schemaname = 'liame' and indexname = 'google_campaign_new_peca_em_aberto') then
    raise exception '0150: o índice de um pedido em aberto por peça não entrou';
  end if;
end $$;
