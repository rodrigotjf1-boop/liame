-- 0098 · A escolha do modelo no Pro (A3, I13; D-A3-12; protótipo P7 aprovado em 03/10/2026; D-A3-25 a D-A3-28). No
-- Lite tudo fica no automático (o modelo da rota de cada tarefa). No Pro, o Dono e o Administrador podem escolher, em
-- cada finalidade (conversa, análise e texto), outro modelo do catálogo do Liame, vendo o custo estimado, a velocidade e
-- a nota no teste. Duas tabelas:
--   `ai_model_option`: o catálogo, do produto (sem empresa): os modelos que cada tarefa pode usar além do da rota, cada
--      um com a nota da rodada de confirmação que o aprovou e o teto de custo de UMA chamada. Só a distribuição grava,
--      por migration, depois da rodada (evals/README.md: "antes de oferecer um modelo no catálogo, repetir a rodada
--      inteira das tarefas dele"). Esta migration não oferece nenhum modelo: o catálogo nasce vazio.
--   `ai_model_choice`: a escolha da empresa, uma por finalidade, com quem escolheu e quando. Sem linha = automático.
-- Nada usa estas tabelas enquanto a função `escolha_de_modelo` estiver desligada.
-- Idempotente; uma transação por arquivo (ADR-018).

-- A semente da flag grava em tabela com RLS forçada (V20).
select set_config('app.scope', 'sistema', true);

create table if not exists liame.ai_model_option (
  id                   uuid primary key,
  task                 text not null check (task ~ '^[a-z][a-z0-9_]{2,60}$'),
  provider             text not null check (provider ~ '^[a-z0-9_]+$'),
  model                text not null check (length(model) between 1 and 100),
  -- O nome que a tela mostra ("Claude Opus 5.5").
  label                text not null check (length(label) between 2 and 60),
  speed                text not null check (speed in ('mais_rapido', 'rapido', 'medio', 'mais_lento')),
  -- O teto de custo de UMA chamada com este modelo (o da rota vale para o modelo da rota).
  max_cost_usd_micros  bigint not null check (max_cost_usd_micros > 0),
  -- A nota na rodada de confirmação da tarefa, e onde ela está (a data e o PR do resultado).
  eval_score           numeric(5, 4) not null check (eval_score between 0 and 1),
  eval_note            text not null check (length(eval_note) between 3 and 300),
  -- `retirada`: sai do catálogo; a empresa que o escolheu volta ao automático, e a escolha fica guardada.
  status               text not null default 'oferecida' check (status in ('oferecida', 'retirada')),
  created_by           text not null check (length(created_by) between 2 and 120),
  created_at           timestamptz not null default now(),
  constraint ai_model_option_uma_vez unique (task, provider, model)
);

-- Do produto, sem dado de empresa (como as rotas e os preços, 0028; V51): leitura para todos, escrita só do escopo de
-- sistema; a aplicação só lê.
alter table liame.ai_model_option enable row level security;
alter table liame.ai_model_option force row level security;
drop policy if exists ai_model_option_leitura on liame.ai_model_option;
create policy ai_model_option_leitura on liame.ai_model_option for select using (true);
drop policy if exists ai_model_option_sistema on liame.ai_model_option;
create policy ai_model_option_sistema on liame.ai_model_option using (liame.system_scope()) with check (liame.system_scope());
grant select on liame.ai_model_option to liame_app;

create table if not exists liame.ai_model_choice (
  id          uuid primary key,
  tenant_id   uuid not null references liame.organization (id) on delete cascade,
  purpose     text not null check (purpose in ('conversa', 'analise', 'texto')),
  provider    text not null check (provider ~ '^[a-z0-9_]+$'),
  model       text not null check (length(model) between 1 and 100),
  -- Quem escolheu (some com a pessoa; a escolha fica, e a auditoria guarda o nome).
  chosen_by   uuid references liame.app_user (id) on delete set null,
  chosen_at   timestamptz not null default now(),
  -- Uma escolha por empresa e finalidade; voltar ao automático apaga a linha.
  constraint ai_model_choice_uma_por_finalidade unique (tenant_id, purpose)
);
create index if not exists idx_ai_model_choice_chosen_by on liame.ai_model_choice (chosen_by);

alter table liame.ai_model_choice enable row level security;
alter table liame.ai_model_choice force row level security;
drop policy if exists ai_model_choice_isolamento on liame.ai_model_choice;
create policy ai_model_choice_isolamento on liame.ai_model_choice
  using (tenant_id = liame.current_tenant_id() or liame.system_scope())
  with check (tenant_id = liame.current_tenant_id() or liame.system_scope());
grant select, insert, update, delete on liame.ai_model_choice to liame_app;

-- ------------------------------------------------------------ a função

-- Liga, por empresa, a escolha do modelo no Pro (a tela e o uso da escolha nas chamadas). Nasce desligada.
insert into liame.feature_flag (key, kind, default_value, description, owner, is_write)
values ('escolha_de_modelo', 'boolean', 'false', 'Sua equipe no Pro: escolher o modelo de IA de cada finalidade entre os do catálogo do Liame, com o custo estimado (A3, I13; D-A3-12)', 'ia', false)
on conflict (key) do nothing;
