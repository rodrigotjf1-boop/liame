-- 0138 · A campanha nova na Meta, criada pausada: o pedido (A4, X5, parte 1; P10 aprovado em 05/10/2026; D-A4-31,
-- D-A4-35, D-A4-40 e D-A4-41; `plano-a4.md` X5). A peça de texto aprovada em Criativos, com a foto ou o vídeo da loja
-- (Fotos), vira um pedido de criar a campanha, o conjunto e o anúncio na Meta, tudo pausado; ativar é outro pedido.
-- (1) Duas capacidades no registro, na versão das outras da Meta (v26.0), conferidas nas páginas oficiais em
--     11/11/2026 (base de conhecimento §2.1): `anuncio_criar` (POST /act_{id}/campaigns, adsets, adcreatives e ads, com
--     `validate_only` antes; a foto e a capa do vídeo vão pelo endereço assinado do armazenamento, que a Meta guarda na
--     biblioteca da conta) e `anuncio_video` (POST /act_{id}/advideos com `file_url` e a situação do vídeo).
-- (2) A função `campanha_nova`, desligada.
-- (3) A campanha nova do Liame (`ad_campaign_new`): o que a pessoa pediu (a peça e a versão, a mídia, o nome, o
--     objetivo, o raio em volta da loja, a verba diária e o fim) e o que já foi criado na Meta, passo a passo, para a
--     tentativa seguinte continuar dali (D-A4-31: o que existe fica pausado, e nada se apaga). Um pedido em aberto por
--     peça.
-- Da distribuição (o registro e a função) e das empresas (a campanha nova). Idempotente; uma transação por arquivo
-- (ADR-018).

-- As sementes gravam em tabelas com RLS forçada (V20).
select set_config('app.scope', 'sistema', true);

-- ------------------------------------------------------------ (1) as capacidades

insert into liame.connector_capability (provider, capability, api_version, read, write, required_scope, access_level, sunset_at, source_url, verified_at, notes) values
  ('meta_ads', 'anuncio_criar', 'v26.0', false, true, '{ads_management,pages_manage_ads,pages_read_engagement,pages_show_list}', 'Standard (testadores) ou Advanced', null,
   'https://developers.facebook.com/docs/marketing-api/reference/ad-account/campaigns/', '2026-11-11',
   'Marketing API: a campanha (POST /act_{id}/campaigns), o conjunto (adsets), o criativo (adcreatives, com a foto em link_data.picture ou a capa em video_data.image_url) e o anúncio (ads), todos com status PAUSED, cada um conferido antes com execution_options=["validate_only"] e mandado com o cabeçalho X-Client-Idempotent-Key; a verba diária no conjunto (is_adset_budget_sharing_enabled=false), o raio em custom_locations com distance_unit=kilometer, advantage_audience=0 e as melhorias do criativo em OPT_OUT'),
  ('meta_ads', 'anuncio_video', 'v26.0', true, true, '{ads_management}', 'Standard (testadores) ou Advanced', null,
   'https://developers.facebook.com/docs/marketing-api/reference/ad-account/advideos/', '2026-11-11',
   'Marketing API: o vídeo do anúncio (POST /act_{id}/advideos com file_url, o endereço assinado do armazenamento) e a situação dele (GET /{video-id}?fields=status: pronto com video_status = ready); sem validate_only')
on conflict (provider, capability) do nothing;

-- ------------------------------------------------------------ (2) a função

insert into liame.feature_flag (key, kind, default_value, description, owner, is_write)
values ('campanha_nova', 'boolean', 'false', 'Campanha nova na Meta: a peça aprovada vira uma campanha criada pausada, com aprovação e o código do app (A4, X5)', 'midia', false)
on conflict (key) do nothing;

-- ------------------------------------------------------------ (3) a campanha nova

create table if not exists liame.ad_campaign_new (
  id                    uuid primary key,
  tenant_id             uuid not null references liame.organization (id) on delete cascade,
  brand_id              uuid not null references liame.brand (id) on delete cascade,
  -- A conta de anúncios da Meta e a Página que assina o anúncio (D-A4-35).
  ad_account_id         uuid not null references liame.connected_account (id) on delete cascade,
  page_account_id       uuid not null references liame.connected_account (id) on delete cascade,
  -- A peça de texto aprovada, na versão que a pessoa viu.
  piece_id              uuid not null references liame.ad_piece (id) on delete cascade,
  piece_version         integer not null check (piece_version >= 1),
  -- A foto ou o vídeo da loja (Fotos).
  media_id              uuid not null references liame.brand_photo (id) on delete cascade,
  -- A loja do raio (D-A4-41).
  unit_id               uuid not null references liame.unit (id) on delete cascade,
  name                  text not null check (length(name) between 1 and 80),
  objective             text not null check (objective in ('cardapio', 'whatsapp')),
  radius_km             numeric(3, 1) not null check (radius_km between 1 and 15),
  daily_budget_micros   bigint not null check (daily_budget_micros > 0),
  end_date              date,
  -- O cardápio da loja (o destino de "pedidos pelo cardápio"); nulo no WhatsApp.
  link                  text check (link is null or length(link) <= 2000),
  action_id             uuid references liame.action_request (id) on delete set null,
  status                text not null default 'pedida' check (status in ('pedida', 'criando', 'criada', 'nao_criada', 'cancelada')),
  version               integer not null default 1,
  -- O que já existe na Meta, passo a passo.
  meta_campaign_id      text,
  meta_adset_id         text,
  meta_video_id         text,
  -- Desde quando a Meta prepara o vídeo (o pedido espera até 15 minutos).
  video_waiting_since   timestamptz,
  meta_creative_id      text,
  meta_ad_id            text,
  error                 text check (error is null or length(error) <= 2000),
  created_by            uuid references liame.app_user (id) on delete set null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint ad_campaign_new_link check ((objective = 'cardapio') = (link is not null))
);
create index if not exists idx_ad_campaign_new_tenant on liame.ad_campaign_new (tenant_id);
create index if not exists idx_ad_campaign_new_brand on liame.ad_campaign_new (brand_id, created_at desc);
-- Um pedido em aberto por peça: o segundo pedido com a mesma peça espera o primeiro ser decidido.
create unique index if not exists ad_campaign_new_peca_em_aberto on liame.ad_campaign_new (piece_id) where status in ('pedida', 'criando');

alter table liame.ad_campaign_new enable row level security;
alter table liame.ad_campaign_new force row level security;
drop policy if exists ad_campaign_new_isolamento on liame.ad_campaign_new;
create policy ad_campaign_new_isolamento on liame.ad_campaign_new
  using (tenant_id = liame.current_tenant_id() or liame.system_scope())
  with check (tenant_id = liame.current_tenant_id() or liame.system_scope());
grant select, insert, update on liame.ad_campaign_new to liame_app;

-- ------------------------------------------------------------ conferência

do $$ begin
  if (select count(*) from liame.connector_capability where provider = 'meta_ads' and capability in ('anuncio_criar', 'anuncio_video')) <> 2 then
    raise exception '0138: as capacidades da campanha nova não entraram';
  end if;
  if not exists (select 1 from liame.feature_flag where key = 'campanha_nova' and default_value = 'false'::jsonb and not is_write) then
    raise exception '0138: a função campanha_nova não entrou desligada';
  end if;
  if not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                  where n.nspname = 'liame' and c.relname = 'ad_campaign_new' and c.relrowsecurity and c.relforcerowsecurity) then
    raise exception '0138: a campanha nova não entrou com a RLS forçada';
  end if;
  if not exists (select 1 from pg_indexes where schemaname = 'liame' and indexname = 'ad_campaign_new_peca_em_aberto') then
    raise exception '0138: o índice de um pedido em aberto por peça não entrou';
  end if;
end $$;
