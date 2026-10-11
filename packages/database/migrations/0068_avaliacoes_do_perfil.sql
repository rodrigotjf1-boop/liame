-- 0068 · As avaliações e os números do Perfil da Empresa no Google (A6, Z1, parte c; `plano-a6.md` D-A6-5).
-- O que o Liame guarda do que lê de cada loja do Perfil ligada a uma marca (a conta `google_business`):
-- (1) `profile_review`: a avaliação. A nota, o texto, as datas e a resposta da empresa com a situação dela no Google.
--     **O nome e a foto de quem avaliou não são guardados** (critério A6-1): a tabela não tem coluna para eles. O
--     texto é de terceiro e pode trazer dado pessoal de quem escreveu; por isso a classe é PERSONAL e a guarda é de
--     12 meses, contados da última mudança da avaliação no Google.
-- (2) `profile_summary`: a nota média e o total de avaliações da loja, como o Google informa na última leitura.
-- (3) `profile_metric_daily`: os números do perfil por dia (vistas na busca e no Maps, pedidos de rota, ligações,
--     cliques no site, reservas e cliques no cardápio). São contagens: nenhum dado de pessoa.
-- A leitura é da rotina `perfil` do worker, só para a empresa com a função `perfil_google` ligada. O frescor fica em
-- `sync_state`, com os conjuntos `avaliacoes_perfil` e `numeros_perfil`.
-- Idempotente; uma transação por arquivo (ADR-018).

-- ------------------------------------------------------------ a avaliação

create table if not exists liame.profile_review (
  id                    uuid primary key,
  tenant_id             uuid not null references liame.organization (id) on delete cascade,
  brand_id              uuid not null references liame.brand (id) on delete cascade,
  -- A loja do Perfil (a conta `google_business`): sai com ela.
  connected_account_id  uuid not null references liame.connected_account (id) on delete cascade,
  -- O id da avaliação no Google (`reviewId`).
  external_id           text not null check (length(external_id) between 1 and 200),
  stars                 smallint not null check (stars between 1 and 5),
  -- O que a pessoa escreveu; nulo quando ela só deu a nota.
  comment               text check (length(comment) between 1 and 5000),
  -- Quando a avaliação foi feita e quando mudou pela última vez no Google (a nota, o texto ou a resposta).
  reviewed_at           timestamptz not null,
  changed_at            timestamptz not null,
  -- A resposta da empresa, como o Google a tem: o texto, quando mudou, a situação (`pendente`: o Google ainda
  -- confere; `aprovada`: está no ar; `recusada`: ele não publicou) e, se recusou, o código do motivo.
  reply_text            text check (length(reply_text) between 1 and 5000),
  reply_changed_at      timestamptz,
  reply_state           text check (reply_state in ('pendente', 'aprovada', 'recusada', 'desconhecida')),
  reply_violation       text check (length(reply_violation) between 2 and 60),
  first_seen_at         timestamptz not null default now(),
  last_seen_at          timestamptz not null default now(),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (connected_account_id, external_id),
  -- A resposta existe inteira ou não existe: texto e situação juntos.
  constraint profile_review_resposta check ((reply_text is null) = (reply_state is null)),
  constraint profile_review_violacao check (reply_violation is null or reply_state is not null)
);
-- A tela lê por marca, as mais recentes primeiro; as sem resposta e as de nota baixa são as que mais importam.
create index if not exists idx_profile_review_marca on liame.profile_review (tenant_id, brand_id, changed_at desc);
create index if not exists idx_profile_review_sem_resposta on liame.profile_review (connected_account_id, stars) where reply_text is null;
-- O expurgo varre pela data da última mudança.
create index if not exists idx_profile_review_guarda on liame.profile_review (changed_at);

alter table liame.profile_review enable row level security;
alter table liame.profile_review force row level security;
drop policy if exists profile_review_isolamento on liame.profile_review;
create policy profile_review_isolamento on liame.profile_review
  using (tenant_id = liame.current_tenant_id() or liame.system_scope())
  with check (tenant_id = liame.current_tenant_id() or liame.system_scope());
-- Só o expurgo apaga (o que passou dos 12 meses): a empresa não apaga avaliação pelo Liame.
drop policy if exists profile_review_apaga_so_sistema on liame.profile_review;
create policy profile_review_apaga_so_sistema on liame.profile_review as restrictive for delete using (liame.system_scope());
grant select, insert, update, delete on liame.profile_review to liame_app;

-- ------------------------------------------------------------ o resumo da loja

create table if not exists liame.profile_summary (
  connected_account_id  uuid primary key references liame.connected_account (id) on delete cascade,
  tenant_id             uuid not null references liame.organization (id) on delete cascade,
  brand_id              uuid not null references liame.brand (id) on delete cascade,
  -- A nota média (1 a 5) e o total de avaliações que o Google informa da loja; nulos quando ele não informa.
  rating                numeric(3, 2) check (rating between 1 and 5),
  review_count          integer check (review_count >= 0),
  read_at               timestamptz not null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create index if not exists idx_profile_summary_marca on liame.profile_summary (tenant_id, brand_id);

alter table liame.profile_summary enable row level security;
alter table liame.profile_summary force row level security;
drop policy if exists profile_summary_isolamento on liame.profile_summary;
create policy profile_summary_isolamento on liame.profile_summary
  using (tenant_id = liame.current_tenant_id() or liame.system_scope())
  with check (tenant_id = liame.current_tenant_id() or liame.system_scope());
grant select, insert, update on liame.profile_summary to liame_app;

-- ------------------------------------------------------------ os números do perfil por dia

create table if not exists liame.profile_metric_daily (
  connected_account_id  uuid not null references liame.connected_account (id) on delete cascade,
  tenant_id             uuid not null references liame.organization (id) on delete cascade,
  brand_id              uuid not null references liame.brand (id) on delete cascade,
  -- O dia como o Google o conta (o dia da loja).
  day                   date not null,
  -- O nome da métrica no Liame (as nove de `METRICAS_DO_PERFIL`, no conector).
  metric                text not null check (metric in (
    'profile_views_maps_desktop', 'profile_views_search_desktop', 'profile_views_maps_mobile', 'profile_views_search_mobile',
    'direction_requests', 'call_clicks', 'website_clicks', 'bookings', 'menu_clicks')),
  value                 bigint not null check (value >= 0),
  read_at               timestamptz not null default now(),
  primary key (connected_account_id, day, metric)
);
create index if not exists idx_profile_metric_daily_marca on liame.profile_metric_daily (tenant_id, brand_id, day);

alter table liame.profile_metric_daily enable row level security;
alter table liame.profile_metric_daily force row level security;
drop policy if exists profile_metric_daily_isolamento on liame.profile_metric_daily;
create policy profile_metric_daily_isolamento on liame.profile_metric_daily
  using (tenant_id = liame.current_tenant_id() or liame.system_scope())
  with check (tenant_id = liame.current_tenant_id() or liame.system_scope());
grant select, insert, update on liame.profile_metric_daily to liame_app;
