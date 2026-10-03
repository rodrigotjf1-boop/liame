-- 0040 · O que a conferência recusou (A3, D-A3-15 e D-A3-16; Sua equipe, protótipo P7).
-- Todo texto de IA passa pela conferência do código antes de aparecer: as regras de texto do Compliance, os números,
-- o formato. Até aqui, o que era recusado ficava só no log. Esta tabela guarda uma linha por texto recusado, SEM o
-- texto: quando, a marca, o funcionário e o fluxo que escreveram, o porquê (a recusa) e, quando foi uma regra de texto
-- (ou o revisor de IA), quais regras e a versão delas. É daqui que Sua equipe conta os textos barrados pelo Compliance
-- e as respostas retiradas na conferência. Sem conteúdo e sem dado pessoal: nem quem pediu fica aqui (fica na linha de
-- uso da chamada). A aplicação só lê e insere. Idempotente; uma transação por arquivo (ADR-018).

create table if not exists liame.ai_refusal (
  id             uuid primary key,
  tenant_id      uuid not null references liame.organization (id) on delete cascade,
  brand_id       uuid not null references liame.brand (id) on delete cascade,
  -- A chamada ao modelo que escreveu o texto (o conteúdo dela fica 30 dias em `ai_exchange`).
  usage_id       uuid references liame.ai_usage (id) on delete set null,
  -- O funcionário que escreveu: `lia`, `analista`, `relatorios`, `estrategista`, `pesquisador`…
  member         text not null check (member ~ '^[a-z][a-z0-9_]{1,40}$'),
  workflow       text not null check (workflow ~ '^[a-z][a-z0-9_.]{1,60}$'),
  -- O porquê: `compliance` (regra de texto), `revisor` (o revisor de IA), `numero_fora`, `dado_velho`, `formato`…
  kind           text not null check (kind ~ '^[a-z][a-z0-9_]{1,40}$'),
  -- As regras de texto que bateram (ou as categorias do revisor), em ordem; vazio nas outras recusas.
  rules          jsonb not null default '[]'::jsonb check (jsonb_typeof(rules) = 'array'),
  rules_version  integer check (rules_version >= 1),
  -- Quantos textos esta linha conta: o Pesquisador descarta vários rótulos numa leitura só.
  items          integer not null default 1 check (items between 1 and 1000),
  created_at     timestamptz not null default now()
);
create index if not exists idx_ai_refusal_marca on liame.ai_refusal (tenant_id, brand_id, created_at);
create index if not exists idx_ai_refusal_uso on liame.ai_refusal (usage_id) where usage_id is not null;

alter table liame.ai_refusal enable row level security;
alter table liame.ai_refusal force row level security;
drop policy if exists ai_refusal_isolamento on liame.ai_refusal;
create policy ai_refusal_isolamento on liame.ai_refusal
  using (tenant_id = liame.current_tenant_id() or liame.system_scope())
  with check (tenant_id = liame.current_tenant_id() or liame.system_scope());
-- Só o sistema apaga (o expurgo da empresa); a aplicação lê e insere.
drop policy if exists ai_refusal_apaga_so_sistema on liame.ai_refusal;
create policy ai_refusal_apaga_so_sistema on liame.ai_refusal as restrictive for delete using (liame.system_scope());
grant select, insert on liame.ai_refusal to liame_app;
