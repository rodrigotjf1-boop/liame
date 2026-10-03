-- 0039 · Desligar um funcionário pela empresa (A3, I13b; protótipo P7, aguardando aprovação).
-- QUAL funcionário trabalha para a empresa é decisão da distribuição (`agent_activation`, 0029, pelo plano). Aqui fica a
-- escolha da própria empresa: desligar um funcionário numa marca e ligar de novo, com quem fez, quando e o motivo.
-- Cada vez que alguém desliga nasce uma linha; ligar de novo fecha a linha, e o histórico fica. O Compliance não
-- desliga: sem ele, nenhum texto de IA aparece. Parar a equipe inteira é a parada da empresa (kill switch, A1).
-- Idempotente; uma transação por arquivo (ADR-018).

create table if not exists liame.agent_pause (
  id          uuid primary key,
  tenant_id   uuid not null references liame.organization (id) on delete cascade,
  brand_id    uuid not null references liame.brand (id) on delete cascade,
  -- O membro da equipe: `lia`, `analista`, `relatorios`, `estrategista`, `pesquisador` ou `trafego`.
  agent_key   text not null check (agent_key ~ '^[a-z][a-z0-9_]{2,60}$' and agent_key <> 'compliance'),
  paused_by   uuid references liame.app_user (id) on delete set null,
  paused_at   timestamptz not null default now(),
  -- O motivo, sem dado pessoal.
  reason      text check (length(reason) between 3 and 300),
  resumed_by  uuid references liame.app_user (id) on delete set null,
  resumed_at  timestamptz,
  check (resumed_at is null or resumed_at >= paused_at)
);
-- Uma pausa aberta por marca e funcionário.
create unique index if not exists uq_agent_pause_aberta on liame.agent_pause (brand_id, agent_key) where resumed_at is null;
create index if not exists idx_agent_pause_marca on liame.agent_pause (tenant_id, brand_id, paused_at desc);

alter table liame.agent_pause enable row level security;
alter table liame.agent_pause force row level security;
drop policy if exists agent_pause_isolamento on liame.agent_pause;
create policy agent_pause_isolamento on liame.agent_pause
  using (tenant_id = liame.current_tenant_id() or liame.system_scope())
  with check (tenant_id = liame.current_tenant_id() or liame.system_scope());
grant select, insert, update on liame.agent_pause to liame_app;
