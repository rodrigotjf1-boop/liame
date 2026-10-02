-- 0028 · Uso de IA, preços, rotas de modelo e teto por empresa (A3, I1; ADR-006, ADR-016;
-- `ai-architecture.md` §2, §3 e §10; data-model §7 e §8). Nenhum SDK informa custo em dinheiro: o
-- custo de cada chamada sai da tabela de preços versionada × tokens (contando o cache), em micros de
-- dólar (a fatura do fornecedor é em dólar). No fim, a página de aposentadoria de modelos da Anthropic
-- entra nas fontes do Vigia de integrações. Idempotente; uma transação por arquivo (ADR-018).

-- A semente da flag grava com a RLS forçada (ERR-011).
select set_config('app.scope', 'sistema', true);

-- ------------------------------------------------------------ preços (da distribuição)

-- Preço por milhão de tokens, em micros de dólar (US$ 4 = 4000000). Uma linha por modelo e data de
-- início: preço novo entra como linha nova, e a chamada usa o que valia no dia dela.
create table if not exists liame.ai_model_price (
  id                                  uuid primary key,
  provider                            text not null check (provider ~ '^[a-z0-9_]+$'),
  model                               text not null check (length(model) between 1 and 100),
  valid_from                          date not null,
  input_usd_micros_per_mtok           bigint not null check (input_usd_micros_per_mtok >= 0),
  output_usd_micros_per_mtok          bigint not null check (output_usd_micros_per_mtok >= 0),
  cache_read_usd_micros_per_mtok      bigint not null check (cache_read_usd_micros_per_mtok >= 0),
  cache_write_5m_usd_micros_per_mtok  bigint not null check (cache_write_5m_usd_micros_per_mtok >= 0),
  cache_write_1h_usd_micros_per_mtok  bigint not null check (cache_write_1h_usd_micros_per_mtok >= 0),
  -- De onde veio o preço e quando foi conferido (base de conhecimento §10).
  source                              text not null check (length(source) between 8 and 300),
  checked_on                          date not null,
  created_at                          timestamptz not null default now(),
  unique (provider, model, valid_from)
);

-- Página oficial de preços da Anthropic, conferida em 02/10/2026.
insert into liame.ai_model_price (id, provider, model, valid_from, input_usd_micros_per_mtok, output_usd_micros_per_mtok,
                                  cache_read_usd_micros_per_mtok, cache_write_5m_usd_micros_per_mtok, cache_write_1h_usd_micros_per_mtok,
                                  source, checked_on)
values
  ('0199a300-0000-7000-8000-000000000001', 'anthropic', 'claude-fable-5-1', '2026-10-01', 10000000, 50000000, 250000, 12500000, 20000000,
   'https://platform.claude.com/docs/en/about-claude/pricing', '2026-10-02'),
  ('0199a300-0000-7000-8000-000000000002', 'anthropic', 'claude-opus-5-5', '2026-10-01', 4000000, 20000000, 200000, 5000000, 8000000,
   'https://platform.claude.com/docs/en/about-claude/pricing', '2026-10-02'),
  ('0199a300-0000-7000-8000-000000000003', 'anthropic', 'claude-sonnet-5-5', '2026-10-01', 2000000, 10000000, 200000, 2500000, 4000000,
   'https://platform.claude.com/docs/en/about-claude/pricing', '2026-10-02'),
  ('0199a300-0000-7000-8000-000000000004', 'anthropic', 'claude-haiku-4-5-20251001', '2026-10-01', 1000000, 5000000, 100000, 1250000, 2000000,
   'https://platform.claude.com/docs/en/about-claude/pricing', '2026-10-02')
on conflict (provider, model, valid_from) do nothing;

-- ------------------------------------------------------------ rotas de modelo (da distribuição)

-- Qual modelo atende cada tarefa (`ai-architecture.md` §3): dado versionado, nunca código. Só UMA
-- versão ativa por tarefa. `fallback` e `economy_*` só aceitam modelo com eval aprovado na tarefa: a
-- conferência é do processo (I3); aqui fica o registro da nota e de quem publicou.
create table if not exists liame.ai_model_route (
  id                    uuid primary key,
  task                  text not null check (task ~ '^[a-z][a-z0-9_]{2,60}$'),
  version               integer not null check (version >= 1),
  status                text not null check (status in ('rascunho', 'ativa', 'aposentada')),
  purpose               text not null check (purpose in ('conversa', 'analise', 'texto', 'imagem', 'video', 'voz')),
  provider              text not null check (provider ~ '^[a-z0-9_]+$'),
  model                 text not null check (length(model) between 1 and 100),
  effort                text check (effort in ('low', 'medium', 'high', 'xhigh', 'max')),
  max_output_tokens     integer not null check (max_output_tokens between 1 and 128000),
  timeout_ms            integer not null default 60000 check (timeout_ms between 1000 and 600000),
  -- Teto de custo de UMA chamada: não há como cortar no meio; passou dele, o gateway avisa no log e a
  -- conferência compara o custo da linha de `ai_usage` com o teto da versão da rota.
  max_cost_usd_micros   bigint not null check (max_cost_usd_micros > 0),
  -- Lista ordenada de {provider, model}: só entra quando o principal falha.
  fallback              jsonb not null default '[]'::jsonb check (jsonb_typeof(fallback) = 'array'),
  -- Modelo mais barato usado quando a empresa passa de 80% do teto (degradação antes do bloqueio).
  economy_provider      text check (economy_provider ~ '^[a-z0-9_]+$'),
  economy_model         text check (length(economy_model) between 1 and 100),
  eval_threshold        numeric(5, 4) check (eval_threshold between 0 and 1),
  eval_score            numeric(5, 4) check (eval_score between 0 and 1),
  created_by            text not null check (length(created_by) between 2 and 120),
  deployed_at           timestamptz,
  created_at            timestamptz not null default now(),
  unique (task, version),
  check ((economy_provider is null) = (economy_model is null)),
  check (status <> 'ativa' or deployed_at is not null)
);
create unique index if not exists uq_ai_model_route_ativa on liame.ai_model_route (task) where status = 'ativa';

-- ------------------------------------------------------------ teto por empresa

-- Quem define é a distribuição (como as flags); a empresa só lê. Sem linha, vale o padrão da
-- configuração do servidor.
create table if not exists liame.ai_budget (
  tenant_id            uuid primary key references liame.organization (id) on delete cascade,
  daily_usd_micros     bigint not null check (daily_usd_micros > 0),
  monthly_usd_micros   bigint not null check (monthly_usd_micros >= daily_usd_micros),
  set_by               text not null check (length(set_by) between 2 and 120),
  reason               text check (length(reason) between 3 and 300),
  updated_at           timestamptz not null default now()
);

-- ------------------------------------------------------------ uso (uma linha por chamada)

create table if not exists liame.ai_usage (
  id                   uuid primary key,
  tenant_id            uuid not null references liame.organization (id) on delete cascade,
  brand_id             uuid references liame.brand (id) on delete set null,
  -- Quem pediu (nulo em rotina do sistema).
  user_id              uuid references liame.app_user (id) on delete set null,
  workflow             text not null check (workflow ~ '^[a-z][a-z0-9_.]{1,60}$'),
  task                 text not null check (task ~ '^[a-z][a-z0-9_]{2,60}$'),
  route_version        integer,
  prompt_version       text check (length(prompt_version) between 1 and 60),
  provider             text check (provider ~ '^[a-z0-9_]+$'),
  model                text check (length(model) between 1 and 100),
  -- Como a chamada foi atendida: o modelo da rota, o reserva (o principal falhou) ou o econômico (teto).
  served_by            text check (served_by in ('principal', 'reserva', 'economico')),
  inference_geo        text check (inference_geo in ('us', 'global')),
  input_tokens         bigint not null default 0 check (input_tokens >= 0),
  cache_read_tokens    bigint not null default 0 check (cache_read_tokens >= 0),
  cache_write_tokens   bigint not null default 0 check (cache_write_tokens >= 0),
  output_tokens        bigint not null default 0 check (output_tokens >= 0),
  reasoning_tokens     bigint not null default 0 check (reasoning_tokens >= 0),
  cost_usd_micros      bigint not null default 0 check (cost_usd_micros >= 0),
  latency_ms           integer check (latency_ms >= 0),
  tool_calls           integer not null default 0 check (tool_calls >= 0),
  tool_failures        integer not null default 0 check (tool_failures >= 0),
  outcome              text not null check (outcome in ('ok', 'erro', 'teto', 'limite_usuario')),
  error_code           text check (length(error_code) between 1 and 80),
  pii_removed          integer not null default 0 check (pii_removed >= 0),
  trace_id             text check (trace_id ~ '^[0-9a-f]{32}$'),
  occurred_at          timestamptz not null default now(),
  -- Chamada atendida tem modelo; a barrada pelo teto ou pelo limite não chegou a nenhum.
  check ((outcome in ('teto', 'limite_usuario')) = (model is null))
);
create index if not exists idx_ai_usage_periodo on liame.ai_usage (tenant_id, occurred_at);
create index if not exists idx_ai_usage_usuario on liame.ai_usage (tenant_id, user_id, occurred_at) where user_id is not null;

-- ------------------------------------------------------------ conteúdo, por 30 dias

-- O que foi enviado (já sem dado pessoal) e o que voltou, para investigar erro e abuso (Política 7.3).
-- Depois de 30 dias sobra só a linha de `ai_usage`.
create table if not exists liame.ai_exchange (
  usage_id     uuid primary key references liame.ai_usage (id) on delete cascade,
  tenant_id    uuid not null references liame.organization (id) on delete cascade,
  request      jsonb not null,
  response     jsonb,
  created_at   timestamptz not null default now()
);
create index if not exists idx_ai_exchange_prazo on liame.ai_exchange (created_at);
create index if not exists idx_ai_exchange_tenant on liame.ai_exchange (tenant_id);

-- ------------------------------------------------------------ RLS e grants

-- Preços e rotas: do produto, sem dado de empresa (como o Capability Registry e o Vigia). Leitura para
-- todos, escrita só do escopo de sistema; a aplicação só lê (quem grava é a distribuição, com o papel dono).
do $$
declare t text;
begin
  foreach t in array array['ai_model_price', 'ai_model_route']
  loop
    execute format('alter table liame.%I enable row level security', t);
    execute format('alter table liame.%I force row level security', t);
    execute format('drop policy if exists %I on liame.%I', t || '_leitura', t);
    execute format('create policy %I on liame.%I for select using (true)', t || '_leitura', t);
    execute format('drop policy if exists %I on liame.%I', t || '_sistema', t);
    execute format('create policy %I on liame.%I using (liame.system_scope()) with check (liame.system_scope())', t || '_sistema', t);
    execute format('grant select on liame.%I to liame_app', t);
  end loop;
end $$;

-- Teto: a empresa lê o dela; gravar é do escopo de sistema com o papel dono (a aplicação não tem insert).
alter table liame.ai_budget enable row level security;
alter table liame.ai_budget force row level security;
drop policy if exists ai_budget_isolamento on liame.ai_budget;
create policy ai_budget_isolamento on liame.ai_budget
  using (tenant_id = liame.current_tenant_id() or liame.system_scope())
  with check (liame.system_scope());
grant select on liame.ai_budget to liame_app;

do $$
declare t text;
begin
  foreach t in array array['ai_usage', 'ai_exchange']
  loop
    execute format('alter table liame.%I enable row level security', t);
    execute format('alter table liame.%I force row level security', t);
    execute format('drop policy if exists %I on liame.%I', t || '_isolamento', t);
    execute format('create policy %I on liame.%I using (tenant_id = liame.current_tenant_id() or liame.system_scope()) with check (tenant_id = liame.current_tenant_id() or liame.system_scope())', t || '_isolamento', t);
    execute format('drop policy if exists %I on liame.%I', t || '_apaga_so_sistema', t);
    execute format('create policy %I on liame.%I as restrictive for delete using (liame.system_scope())', t || '_apaga_so_sistema', t);
  end loop;
end $$;
-- O uso é só de inserção (o custo registrado não muda); o conteúdo é apagado pelo expurgo.
grant select, insert on liame.ai_usage to liame_app;
grant select, insert, delete on liame.ai_exchange to liame_app;

-- ------------------------------------------------------------ flag e trava

-- Os funcionários de IA nascem desligados para todos; a distribuição liga por empresa (`ligar-flag`).
-- A trava da distribuição para o fornecedor inteiro é o kill switch de provider `ai` (0009).
insert into liame.feature_flag (key, kind, default_value, description, owner, is_write)
values ('ia', 'boolean', 'false', 'Funcionários de IA: explicar, relatórios, conversa e planos (A3)', 'ia', false)
on conflict (key) do nothing;

-- ------------------------------------------------------------ Vigia: aposentadoria de modelos

-- Modelo aposentado derruba a rota que o usa: a página oficial de aposentadoria entra nas fontes do Vigia
-- de integrações (0020), que avisa quando um trecho muda. O host novo entra na lista aceita.
alter table liame.watch_source drop constraint if exists watch_source_url_check;
alter table liame.watch_source add constraint watch_source_url_check
  check (url ~ '^https://(developers\.facebook\.com|developers\.google\.com|ads-developers\.googleblog\.com|platform\.claude\.com)/');

insert into liame.watch_source (id, provider, kind, title, url) values
  ('0199a300-0000-7000-8000-000000000011', 'anthropic', 'versoes', 'Anthropic: aposentadoria de modelos', 'https://platform.claude.com/docs/en/about-claude/model-deprecations')
on conflict (url) do nothing;
