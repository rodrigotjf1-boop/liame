-- 0055 · Conversões para o Google (A5, Y1; `plano-a5.md` D-A5-5 a D-A5-8 e o ajuste da D-A5-7).
-- A venda confirmada no caixa, que veio de um clique num anúncio do Google, é informada ao Google pela Data Manager
-- API, com o valor. Sai só o id do clique, o instante, o valor e o id do pedido no Liame: nenhum telefone ou e-mail, e
-- a margem nunca sai (D-A5-5 e D-A5-6).
-- (1) O destino: para qual ação de conversão de cada conta do Google Ads o Liame informa as vendas. Quem escolhe é uma
--     pessoa da empresa. Sem a linha, ou com ela parada, nada sai daquela conta.
-- (2) O envio: uma linha por pedido e por conta de destino, com a situação, o valor informado e o que o Google
--     respondeu. É a prova de que cada pedido saiu uma vez só, e do que saiu. O id do clique não é copiado para cá:
--     fica no ponto de contato, que tem o prazo de guarda dele (D-A2.5-10).
-- (3) A flag `conversoes_google`, por empresa, desligada.
-- (4) Capability Registry: a ingestão de eventos da Data Manager API (a versão é dado).
-- Idempotente; uma transação por arquivo (ADR-018).

-- As sementes gravam em tabelas com RLS forçada (V20).
select set_config('app.scope', 'sistema', true);

-- ------------------------------------------------------------ o destino

create table if not exists liame.conversion_destination (
  connected_account_id    uuid primary key references liame.connected_account (id) on delete cascade,
  tenant_id               uuid not null references liame.organization (id) on delete cascade,
  brand_id                uuid not null references liame.brand (id) on delete cascade,
  -- A ação de conversão da conta (o "destino" da Data Manager API): o id e o nome como o Google os tem.
  conversion_action_id    text not null check (conversion_action_id ~ '^[0-9]{1,20}$'),
  conversion_action_name  text not null check (length(conversion_action_name) between 1 and 200),
  -- Só entram os pedidos confirmados a partir daqui: não há carga do passado.
  starts_at               timestamptz not null default now(),
  -- Parado por uma pessoa: nada novo sai; o que já saiu continua registrado.
  stopped_at              timestamptz,
  set_by                  uuid references liame.app_user (id) on delete set null,
  -- A rotina: quando a conta volta para a fila, a última passagem, a última que deu certo e a última falha (sem dado
  -- pessoal). Fica aqui, e não em `sync_state`, porque o frescor das fontes lê todas as linhas de `sync_state` da conta.
  next_run_at             timestamptz not null default now(),
  last_run_at             timestamptz,
  last_ok_at              timestamptz,
  last_error              text check (length(last_error) between 1 and 300),
  failures                integer not null default 0 check (failures >= 0),
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);
create index if not exists idx_conversion_destination_tenant on liame.conversion_destination (tenant_id);
-- A rotina reserva as contas devidas, a mais atrasada primeiro.
create index if not exists idx_conversion_destination_fila on liame.conversion_destination (next_run_at) where stopped_at is null;

alter table liame.conversion_destination enable row level security;
alter table liame.conversion_destination force row level security;
drop policy if exists conversion_destination_isolamento on liame.conversion_destination;
create policy conversion_destination_isolamento on liame.conversion_destination
  using (tenant_id = liame.current_tenant_id() or liame.system_scope())
  with check (tenant_id = liame.current_tenant_id() or liame.system_scope());
-- Parar é marcar `stopped_at`: a linha não se apaga (sai com a empresa ou com a conta).
grant select, insert, update on liame.conversion_destination to liame_app;

-- ------------------------------------------------------------ o envio

create table if not exists liame.conversion_upload (
  id                        uuid primary key,
  tenant_id                 uuid not null references liame.organization (id) on delete cascade,
  brand_id                  uuid not null references liame.brand (id) on delete cascade,
  order_id                  uuid not null references liame.order_fact (id) on delete cascade,
  -- A conta do Google Ads que recebe, e a ação de conversão dela na hora do envio.
  connected_account_id      uuid not null references liame.connected_account (id) on delete cascade,
  conversion_action_id      text not null check (conversion_action_id ~ '^[0-9]{1,20}$'),
  -- O clique que venceu a atribuição do pedido. Sem chave estrangeira: o ponto de contato tem o prazo de guarda dele.
  touchpoint_id             uuid not null,
  click_kind                text not null check (click_kind in ('gclid', 'gbraid', 'wbraid')),
  -- `pendente`: espera a vez; `enviado`: o Google recebeu, falta ler o resultado; `aceito`; `recusado` (pelo Google ou
  -- pela validação); `desistiu`: não foi enviado (cancelado antes, ou o clique já não existe).
  status                    text not null check (status in ('pendente', 'enviado', 'aceito', 'recusado', 'desistiu')),
  -- O valor informado por último (a receita confirmada, sem o que foi devolvido) e o instante do pedido.
  value_micros              bigint not null check (value_micros >= 0),
  currency                  text not null check (currency ~ '^[A-Z]{3}$'),
  event_at                  timestamptz not null,
  request_id                text check (length(request_id) between 1 and 200),
  attempts                  integer not null default 0 check (attempts >= 0),
  -- O motivo curto da recusa, da desistência ou da última falha (sem dado pessoal).
  last_error                text check (length(last_error) between 1 and 300),
  sent_at                   timestamptz,
  checked_at                timestamptz,
  -- A correção do valor de um pedido já informado (cancelado: zero; devolução: o valor que ficou). A Data Manager API
  -- não retira uma conversão: o mesmo id de transação só sobrescreve o valor.
  correction_status         text check (correction_status in ('pendente', 'enviado', 'recusado')),
  correction_value_micros   bigint check (correction_value_micros >= 0),
  correction_request_id     text check (length(correction_request_id) between 1 and 200),
  correction_sent_at        timestamptz,
  corrections               integer not null default 0 check (corrections >= 0),
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  unique (order_id, connected_account_id),
  constraint conversion_upload_correcao_check check ((correction_status is null) = (correction_value_micros is null))
);
-- A rotina procura, por conta, o que espera a vez e o que espera o resultado.
create index if not exists idx_conversion_upload_fila on liame.conversion_upload (connected_account_id, status) where status in ('pendente', 'enviado');
create index if not exists idx_conversion_upload_correcao on liame.conversion_upload (connected_account_id) where correction_status in ('pendente', 'enviado');
create index if not exists idx_conversion_upload_tenant on liame.conversion_upload (tenant_id, created_at desc);

alter table liame.conversion_upload enable row level security;
alter table liame.conversion_upload force row level security;
drop policy if exists conversion_upload_isolamento on liame.conversion_upload;
create policy conversion_upload_isolamento on liame.conversion_upload
  using (tenant_id = liame.current_tenant_id() or liame.system_scope())
  with check (tenant_id = liame.current_tenant_id() or liame.system_scope());
-- O registro do que saiu não se apaga (sai com a empresa, com a conta ou com o pedido).
grant select, insert, update on liame.conversion_upload to liame_app;

-- ------------------------------------------------------------ a flag

-- Liga, por empresa, o envio das vendas confirmadas ao Google. Nasce desligada. Além dela, cada conta precisa do
-- destino escolhido por uma pessoa e da autorização do Google com a permissão da Data Manager.
insert into liame.feature_flag (key, kind, default_value, description, owner, is_write)
values ('conversoes_google', 'boolean', 'false', 'Conversões para o Google: a venda confirmada no caixa, vinda de um clique em anúncio, é informada ao Google pela Data Manager API (A5, Y1)', 'midia', true)
on conflict (key) do nothing;

-- ------------------------------------------------------------ Capability Registry

-- Conferido nas páginas oficiais em 08/10/2026 (base de conhecimento §3.2): `POST /v1/events:ingest`, com
-- `validateOnly`, até 2.000 eventos por pedido, e `GET /v1/requestStatus:retrieve` para o resultado.
insert into liame.connector_capability (provider, capability, api_version, read, write, required_scope, access_level, sunset_at, source_url, verified_at, notes) values
  ('google_ads', 'conversion_ingest', 'v1', true, true, '{https://www.googleapis.com/auth/datamanager}', 'API ativada no projeto e usuário com acesso à conta', null, 'https://developers.google.com/data-manager/api/reference/rest/v1/events/ingest', '2026-10-08', 'informar a venda confirmada por clique e ler o resultado (Data Manager API); só com a flag conversoes_google, o destino escolhido e validateOnly antes')
on conflict (provider, capability) do nothing;
