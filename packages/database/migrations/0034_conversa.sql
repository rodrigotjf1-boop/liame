-- 0034 · Conversa com a LIA e demandas (A3, I10; `ai-architecture.md` §12; data-model §7; protótipo P5, aguardando
-- aprovação). A conversa é de quem a abriu: só a própria pessoa vê as dela (a regra de acesso usa a empresa E a
-- pessoa). O que a pessoa escreve entra já sem dado pessoal (a mesma limpeza do envio ao modelo); a resposta da
-- LIA entra já conferida (números, Compliance, o que a marca não diz). Conversa e mensagens ficam 30 dias (D-A3-4),
-- pelo expurgo diário. A demanda é o pedido que a LIA registra para a equipe (o Estrategista monta promoção, plano
-- e pauta, I11): é trabalho da empresa e fica depois que a conversa some.
-- Idempotente; uma transação por arquivo (ADR-018).

-- As permissões gravam em tabela com RLS forçada (V20).
select set_config('app.scope', 'sistema', true);

-- ------------------------------------------------------------ conversas

create table if not exists liame.conversation (
  id               uuid primary key,
  tenant_id        uuid not null references liame.organization (id) on delete cascade,
  brand_id         uuid not null references liame.brand (id) on delete cascade,
  user_id          uuid not null references liame.app_user (id) on delete cascade,
  -- A primeira mensagem da pessoa, já sem dado pessoal e cortada: é o nome da conversa na lista.
  title            text not null check (length(title) between 1 and 120),
  -- Respostas da LIA nesta conversa: é o que o limite por conversa conta (A3-9).
  lia_answers      integer not null default 0 check (lia_answers >= 0),
  -- Uma resposta por vez em cada conversa: quem responde marca aqui e desmarca no fim. Marca velha (de uma
  -- resposta que caiu no meio) não segura ninguém: quem vem depois a ignora depois de alguns minutos.
  busy_since       timestamptz,
  created_at       timestamptz not null default now(),
  last_message_at  timestamptz not null default now()
);
create index if not exists idx_conversation_tenant on liame.conversation (tenant_id);
create index if not exists idx_conversation_user on liame.conversation (user_id, last_message_at desc);
create index if not exists idx_conversation_last on liame.conversation (last_message_at);

create table if not exists liame.conversation_message (
  id               uuid primary key,
  tenant_id        uuid not null references liame.organization (id) on delete cascade,
  conversation_id  uuid not null references liame.conversation (id) on delete cascade,
  -- A dona da conversa, repetida aqui para a regra de acesso (só ela vê as mensagens).
  user_id          uuid not null references liame.app_user (id) on delete cascade,
  role             text not null check (role in ('pessoa', 'lia', 'sistema')),
  -- `pessoa`: o texto, já sem dado pessoal, e quantos dados saíram. `lia`: os blocos conferidos, os números com a
  -- fonte, o que ela leu e os cartões (demanda aberta). `sistema`: o aviso (dado velho, limite, falar com uma
  -- pessoa…), escrito pelo código. Nada aqui tem dado de cliente.
  content          jsonb not null check (jsonb_typeof(content) = 'object'),
  -- Na resposta da LIA: `ok` (conferida e entregue) ou `parada` (a pessoa parou antes de a resposta ficar pronta).
  status           text not null default 'ok' check (status in ('ok', 'parada')),
  -- A chamada que gerou a resposta da LIA: o retorno da pessoa ("Fez sentido", "Discordo") referencia esta linha.
  usage_id         uuid references liame.ai_usage (id),
  created_at       timestamptz not null default now(),
  check ((role = 'lia') or (usage_id is null and status = 'ok'))
);
create index if not exists idx_conversation_message_conversa on liame.conversation_message (conversation_id, created_at, id);
create index if not exists idx_conversation_message_tenant on liame.conversation_message (tenant_id);
create index if not exists idx_conversation_message_created on liame.conversation_message (created_at);

-- ------------------------------------------------------------ demandas

create table if not exists liame.demand (
  id                 uuid primary key,
  tenant_id          uuid not null references liame.organization (id) on delete cascade,
  brand_id           uuid not null references liame.brand (id) on delete cascade,
  -- O que foi pedido: o tipo, um título curto e o pedido, já sem dado pessoal.
  kind               text not null check (kind in ('promocao', 'plano', 'pauta', 'analise', 'outro')),
  title              text not null check (length(title) between 3 and 120),
  detail             text not null check (length(detail) between 1 and 2000),
  -- O que a LIA deixou anotado para quem cuida, quando houver.
  notes              text check (length(notes) between 1 and 2000),
  -- Quem cuida: um funcionário de IA (o Estrategista monta promoção, plano e pauta).
  assignee_agent     text not null check (assignee_agent ~ '^[a-z][a-z0-9_]{1,40}$'),
  due_on             date,
  status             text not null default 'aberta' check (status in ('aberta', 'em_andamento', 'entregue', 'cancelada')),
  requested_by       uuid references liame.app_user (id) on delete set null,
  -- Quem registrou em nome da pessoa: a LIA (`lia`); nulo quando a pessoa abrir por uma tela.
  opened_by_agent    text check (opened_by_agent ~ '^[a-z][a-z0-9_]{1,40}$'),
  -- De onde veio. A conversa some em 30 dias e a demanda fica: as duas referências viram nulo.
  conversation_id    uuid references liame.conversation (id) on delete set null,
  -- A mensagem da pessoa que gerou a demanda: uma demanda por mensagem, mesmo que o modelo peça duas vezes (V24).
  origin_message_id  uuid references liame.conversation_message (id) on delete set null,
  cancelled_by       uuid references liame.app_user (id) on delete set null,
  cancelled_at       timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  check ((status = 'cancelada') = (cancelled_at is not null))
);
create index if not exists idx_demand_tenant on liame.demand (tenant_id);
create index if not exists idx_demand_brand on liame.demand (brand_id, status, created_at desc);
create unique index if not exists uq_demand_origem on liame.demand (origin_message_id) where origin_message_id is not null;

-- ------------------------------------------------------------ RLS e grants

-- Conversa e mensagens: a empresa E a pessoa (só a dona vê e escreve). Apagar é só do expurgo (escopo de sistema).
do $$
declare t text;
begin
  foreach t in array array['conversation', 'conversation_message']
  loop
    execute format('alter table liame.%I enable row level security', t);
    execute format('alter table liame.%I force row level security', t);
    execute format('drop policy if exists %I on liame.%I', t || '_da_pessoa', t);
    execute format(
      'create policy %I on liame.%I using ((tenant_id = liame.current_tenant_id() and user_id = liame.current_user_id()) or liame.system_scope()) with check ((tenant_id = liame.current_tenant_id() and user_id = liame.current_user_id()) or liame.system_scope())',
      t || '_da_pessoa', t);
    execute format('drop policy if exists %I on liame.%I', t || '_apaga_so_sistema', t);
    execute format('create policy %I on liame.%I as restrictive for delete using (liame.system_scope())', t || '_apaga_so_sistema', t);
  end loop;
end $$;
grant select, insert, update, delete on liame.conversation to liame_app;
-- A mensagem não muda depois de gravada: sem UPDATE para a aplicação.
grant select, insert, delete on liame.conversation_message to liame_app;

-- Demanda: da empresa (quem tem a permissão vê e cancela). Ninguém apaga uma demanda pela aplicação.
alter table liame.demand enable row level security;
alter table liame.demand force row level security;
drop policy if exists demand_isolamento on liame.demand;
create policy demand_isolamento on liame.demand
  using (tenant_id = liame.current_tenant_id() or liame.system_scope())
  with check (tenant_id = liame.current_tenant_id() or liame.system_scope());
grant select, insert, update on liame.demand to liame_app;

-- ------------------------------------------------------------ permissões

-- Conversar com a LIA: quem acompanha as campanhas (cada um vê só as suas conversas). Quem só recebe relatórios
-- por e-mail não conversa. O que a LIA lê numa conversa segue a permissão de quem pergunta (cada leitura pede a
-- da tela dela). Abrir e cancelar demanda: o dono, o administrador e o gestor.
insert into liame.role_permission (tenant_id, role_key, permission)
values (null, 'dono', 'conversa.usar'), (null, 'administrador', 'conversa.usar'), (null, 'gestor', 'conversa.usar'),
       (null, 'aprovador', 'conversa.usar'), (null, 'somente_leitura', 'conversa.usar'),
       (null, 'dono', 'demanda.abrir'), (null, 'administrador', 'demanda.abrir'), (null, 'gestor', 'demanda.abrir')
on conflict do nothing;
