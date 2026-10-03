-- 0037 · Pesquisador: leitura de páginas que a empresa informa (A3, I12; `ai-architecture.md` §6; base §16.6).
-- A pessoa informa o endereço do site da marca, do cardápio ou de um concorrente; o worker lê a página (só https, sem
-- rede interna, respeitando o robots.txt), tira o texto, e o leitor em quarentena (um modelo sem ferramenta nenhuma)
-- devolve só rótulos (produtos e preços, ofertas, diferenciais). O código confere cada rótulo contra o texto da
-- página e o que sobra vira SUGESTÃO no dossiê (Minha marca), que uma pessoa confere. A página não é guardada: só o
-- pedido, a situação e os rótulos conferidos.
-- Idempotente; uma transação por arquivo (ADR-018).

create table if not exists liame.research_request (
  id              uuid primary key,
  tenant_id       uuid not null references liame.organization (id) on delete cascade,
  brand_id        uuid not null references liame.brand (id) on delete cascade,
  -- `site` (o da marca), `cardapio` (o da marca) ou `concorrente`.
  kind            text not null check (kind in ('site', 'cardapio', 'concorrente')),
  url             text not null check (length(url) between 9 and 2048 and url ~ '^https?://'),
  host            text not null check (length(host) between 1 and 255),
  -- `pendente` (na fila), `lendo` (reservado pelo worker), `concluida` (rótulos conferidos e, quando houve o que
  -- sugerir, a sugestão gravada), `recusada` (robots.txt, texto que tenta dar ordens, página sem texto) ou `falhou`.
  status          text not null default 'pendente' check (status in ('pendente', 'lendo', 'concluida', 'recusada', 'falhou')),
  -- O porquê, quando recusada ou falhou (`robots`, `instrucao_na_pagina`, `sem_texto`, `nao_e_pagina`, `grande_demais`,
  -- `fora_do_ar`, `rede_interna`, `sem_ia`, `formato`…); o código, não o texto do erro.
  reason          text check (reason ~ '^[a-z_]{2,40}$'),
  attempts        integer not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz,
  -- Os rótulos que passaram na conferência (sem a página), e as partes do dossiê que ganharam sugestão.
  result          jsonb check (result is null or jsonb_typeof(result) = 'object'),
  sections        text[] not null default '{}',
  usage_id        uuid references liame.ai_usage (id),
  requested_by    uuid references liame.app_user (id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  finished_at     timestamptz
);
create index if not exists idx_research_request_tenant on liame.research_request (tenant_id);
create index if not exists idx_research_request_brand on liame.research_request (brand_id, created_at desc);
create index if not exists idx_research_request_fila on liame.research_request (next_attempt_at) where status in ('pendente', 'lendo');
-- O mesmo endereço não entra duas vezes na fila da mesma marca (V24).
create unique index if not exists uq_research_request_na_fila on liame.research_request (brand_id, url) where status in ('pendente', 'lendo');

alter table liame.research_request enable row level security;
alter table liame.research_request force row level security;
drop policy if exists research_request_isolamento on liame.research_request;
create policy research_request_isolamento on liame.research_request
  using (tenant_id = liame.current_tenant_id() or liame.system_scope())
  with check (tenant_id = liame.current_tenant_id() or liame.system_scope());
grant select, insert, update on liame.research_request to liame_app;
