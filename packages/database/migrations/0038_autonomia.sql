-- 0038 · Promoção de autonomia (A3, I13; `ai-architecture.md` §4.1 e §4.2; protótipo P7, aguardando aprovação).
-- O modo de cada ação numa conta é uma REGRA DE AUTONOMIA da política da marca (`liame.policy`, versionada desde a
-- 0010): promover é publicar a versão seguinte da política com a regra, e voltar para sombra também. Aqui fica a
-- PROPOSTA: o sistema propõe quando os cinco portões da prontidão passam (`readiness_snapshot`, 0030), e uma pessoa
-- aprova, recusa ou, depois, desfaz. Uma linha guarda a vida inteira da proposta: pendente → aprovada → desfeita,
-- pendente → recusada, ou pendente → retirada (os portões deixaram de passar, ou o modo mudou por outro caminho).
-- Nada é executado em plataforma nenhuma: na A3, "Sugerir" quer dizer que a recomendação aparece na Atenção.
-- Idempotente; uma transação por arquivo (ADR-018).

create table if not exists liame.autonomy_proposal (
  id                     uuid primary key,
  tenant_id              uuid not null references liame.organization (id) on delete cascade,
  brand_id               uuid not null references liame.brand (id) on delete cascade,
  connected_account_id   uuid not null references liame.connected_account (id) on delete cascade,
  -- A ferramenta da sombra (`campanha_pausar`, `orcamento_reduzir`, `orcamento_aumentar`) e a ação da política.
  tool                   text not null check (tool ~ '^[a-z][a-z0-9_]{2,60}$'),
  action                 text not null check (action ~ '^[a-z_]+\.[a-z_]+$'),
  from_mode              text not null check (from_mode in ('SHADOW')),
  to_mode                text not null check (to_mode in ('SUGGEST')),
  -- O retrato da prontidão que passou nos portões, e o que ele dizia na hora.
  readiness_snapshot_id  uuid not null references liame.readiness_snapshot (id) on delete cascade,
  rule_version           integer not null check (rule_version >= 1),
  sample_size            integer not null check (sample_size >= 0),
  signals                jsonb not null check (jsonb_typeof(signals) = 'object'),
  status                 text not null check (status in ('pendente', 'aprovada', 'recusada', 'retirada', 'desfeita')),
  -- A decisão da pessoa (aprovada ou recusada) e a versão da política da marca que a aprovação publicou.
  decided_by             uuid references liame.app_user (id) on delete set null,
  decided_at             timestamptz,
  policy_version         integer check (policy_version >= 1),
  -- A volta para sombra, depois de aprovada, com a versão da política que a publicou.
  undone_by              uuid references liame.app_user (id) on delete set null,
  undone_at              timestamptz,
  undone_policy_version  integer check (undone_policy_version >= 1),
  -- O motivo da recusa, da volta para sombra ou da retirada, sem dado pessoal.
  reason                 text check (length(reason) between 3 and 300),
  -- Recusada, desfeita ou retirada: o sistema só propõe de novo para a mesma conta e ação com esta amostra.
  next_sample_size       integer check (next_sample_size >= 0),
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  check ((status in ('aprovada', 'desfeita')) = (policy_version is not null)),
  check ((status = 'desfeita') = (undone_at is not null)),
  check (status = 'pendente' or decided_at is not null)
);
-- Uma proposta pendente por conta e ação.
create unique index if not exists uq_autonomy_proposal_pendente on liame.autonomy_proposal (connected_account_id, tool) where status = 'pendente';
create index if not exists idx_autonomy_proposal_acao on liame.autonomy_proposal (connected_account_id, tool, created_at desc);
create index if not exists idx_autonomy_proposal_marca on liame.autonomy_proposal (tenant_id, brand_id, created_at desc);

-- A empresa lê as dela; só o sistema propõe; a decisão (pessoa) e a retirada (sistema) alteram a linha.
alter table liame.autonomy_proposal enable row level security;
alter table liame.autonomy_proposal force row level security;
drop policy if exists autonomy_proposal_ler on liame.autonomy_proposal;
create policy autonomy_proposal_ler on liame.autonomy_proposal for select
  using (tenant_id = liame.current_tenant_id() or liame.system_scope());
drop policy if exists autonomy_proposal_propor on liame.autonomy_proposal;
create policy autonomy_proposal_propor on liame.autonomy_proposal for insert
  with check (liame.system_scope());
drop policy if exists autonomy_proposal_decidir on liame.autonomy_proposal;
create policy autonomy_proposal_decidir on liame.autonomy_proposal for update
  using (tenant_id = liame.current_tenant_id() or liame.system_scope())
  with check (tenant_id = liame.current_tenant_id() or liame.system_scope());
grant select, insert, update on liame.autonomy_proposal to liame_app;
