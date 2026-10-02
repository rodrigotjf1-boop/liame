-- 0029 · Registros da IA (A3, I2; arquitetura §3, `ai-architecture.md` §1 e §8, data-model §7): cada
-- ferramenta, prompt e funcionário é uma definição com versão. A definição vive no código (revisada em
-- PR, com um teste que reprova mudança sem subir a versão); aqui fica o registro de cada versão que foi
-- ao ar, com o conteúdo e o hash, para reproduzir depois o que valia em cada resposta. Quem grava é o
-- worker, na subida, em escopo de sistema. A ativação de funcionário por empresa é dado da empresa.
-- Idempotente; uma transação por arquivo (ADR-018).

-- ------------------------------------------------------------ ferramentas

create table if not exists liame.tool_registry (
  name            text not null check (name ~ '^[a-z][a-z0-9_]{2,60}$'),
  version         integer not null check (version >= 1),
  status          text not null check (status in ('ativa', 'aposentada')),
  -- R0 leitura · R1 escrita reversível · R2 irreversível ou mensagem a clientes · R3 financeira.
  risk            text not null check (risk in ('R0', 'R1', 'R2', 'R3')),
  -- Permissão que a pessoa precisa ter para a ferramenta ser oferecida (a mesma da rota equivalente).
  permission      text check (permission ~ '^[a-z_]+\.[a-z_]+$'),
  description     text not null check (length(description) between 10 and 2000),
  input_schema    jsonb not null,
  owner           text not null check (length(owner) between 2 and 60),
  content_hash    text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  deployed_at     timestamptz not null default now(),
  retired_at      timestamptz,
  primary key (name, version),
  check ((status = 'aposentada') = (retired_at is not null))
);
create unique index if not exists uq_tool_registry_ativa on liame.tool_registry (name) where status = 'ativa';

-- ------------------------------------------------------------ prompts

create table if not exists liame.prompt_version (
  key             text not null check (key ~ '^[a-z][a-z0-9_.]{2,60}$'),
  version         integer not null check (version >= 1),
  status          text not null check (status in ('ativa', 'aposentada')),
  -- Tarefa que o prompt atende (a mesma da rota de modelo, `ai_model_route.task`).
  task            text not null check (task ~ '^[a-z][a-z0-9_]{2,60}$'),
  content         text not null check (length(content) between 1 and 100000),
  content_hash    text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  -- Nota do eval da tarefa com esta versão (I3); nula enquanto não houver.
  eval_score      numeric(5, 4) check (eval_score between 0 and 1),
  deployed_at     timestamptz not null default now(),
  retired_at      timestamptz,
  primary key (key, version),
  check ((status = 'aposentada') = (retired_at is not null))
);
create unique index if not exists uq_prompt_version_ativa on liame.prompt_version (key) where status = 'ativa';

-- ------------------------------------------------------------ funcionários

create table if not exists liame.agent_definition (
  key             text not null check (key ~ '^[a-z][a-z0-9_]{2,60}$'),
  version         integer not null check (version >= 1),
  status          text not null check (status in ('ativa', 'aposentada')),
  name            text not null check (length(name) between 2 and 80),
  -- Cargo, responsabilidades, ferramentas permitidas, tarefas e prompts, modo de autonomia, KPIs.
  definition      jsonb not null check (jsonb_typeof(definition) = 'object'),
  content_hash    text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  eval_score      numeric(5, 4) check (eval_score between 0 and 1),
  deployed_at     timestamptz not null default now(),
  retired_at      timestamptz,
  primary key (key, version),
  check ((status = 'aposentada') = (retired_at is not null))
);
create unique index if not exists uq_agent_definition_ativa on liame.agent_definition (key) where status = 'ativa';

-- Do produto, sem dado de empresa: leitura para todos, escrita só do escopo de sistema (V51).
do $$
declare t text;
begin
  foreach t in array array['tool_registry', 'prompt_version', 'agent_definition']
  loop
    execute format('alter table liame.%I enable row level security', t);
    execute format('alter table liame.%I force row level security', t);
    execute format('drop policy if exists %I on liame.%I', t || '_leitura', t);
    execute format('create policy %I on liame.%I for select using (true)', t || '_leitura', t);
    execute format('drop policy if exists %I on liame.%I', t || '_sistema', t);
    execute format('create policy %I on liame.%I using (liame.system_scope()) with check (liame.system_scope())', t || '_sistema', t);
    -- O registro nunca é apagado: versão antiga fica como "aposentada".
    execute format('grant select, insert, update on liame.%I to liame_app', t);
  end loop;
end $$;

-- ------------------------------------------------------------ ativação por empresa

-- Qual funcionário está ligado para qual empresa (e, se for o caso, para uma marca só). Sem linha, vale o
-- padrão da definição. Quem decide é a distribuição (plano); a empresa lê. A pausa pela própria empresa
-- chega com a tela Sua equipe (I13).
create table if not exists liame.agent_activation (
  id              uuid primary key,
  tenant_id       uuid not null references liame.organization (id) on delete cascade,
  brand_id        uuid references liame.brand (id) on delete cascade,
  agent_key       text not null check (agent_key ~ '^[a-z][a-z0-9_]{2,60}$'),
  enabled         boolean not null,
  set_by          text not null check (length(set_by) between 2 and 120),
  reason          text check (length(reason) between 3 and 300),
  updated_at      timestamptz not null default now()
);
create unique index if not exists uq_agent_activation_empresa on liame.agent_activation (tenant_id, agent_key) where brand_id is null;
create unique index if not exists uq_agent_activation_marca on liame.agent_activation (tenant_id, agent_key, brand_id) where brand_id is not null;

alter table liame.agent_activation enable row level security;
alter table liame.agent_activation force row level security;
drop policy if exists agent_activation_isolamento on liame.agent_activation;
create policy agent_activation_isolamento on liame.agent_activation
  using (tenant_id = liame.current_tenant_id() or liame.system_scope())
  with check (liame.system_scope());
grant select on liame.agent_activation to liame_app;
