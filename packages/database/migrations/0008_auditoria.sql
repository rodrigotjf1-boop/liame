-- 0008 · Auditoria append-only com hash encadeado e âncora diária externa (ADR-011, security-model §7).
-- Idempotente; uma transação por arquivo (ADR-018).

-- ------------------------------------------------------------ cadeias

-- Uma cadeia por empresa (o que acontece nela) e uma por pessoa (entrar, sair, segundo fator).
-- Cadeias separadas: uma empresa não trava a outra ao gravar (escala é premissa).
create table if not exists liame.audit_chain (
  chain_key   uuid primary key,
  last_seq    bigint not null default 0,
  last_hash   text not null,
  updated_at  timestamptz not null default now()
);

alter table liame.audit_chain enable row level security;
alter table liame.audit_chain force row level security;
drop policy if exists audit_chain_isolamento on liame.audit_chain;
create policy audit_chain_isolamento on liame.audit_chain
  using (chain_key = liame.current_tenant_id() or chain_key = liame.current_user_id() or liame.system_scope())
  with check (chain_key = liame.current_tenant_id() or chain_key = liame.current_user_id() or liame.system_scope());
grant select, insert, update on liame.audit_chain to liame_app;

-- ------------------------------------------------------------ eventos

create table if not exists liame.audit_event (
  id             uuid primary key,
  chain_key      uuid not null,
  chain_seq      bigint not null,
  -- Sem FK: a auditoria tem retenção própria (5 anos) e o expurgo é decidido no ciclo de vida (ADR-014).
  tenant_id      uuid,
  actor_type     text not null check (actor_type in ('human', 'agent', 'integration', 'system', 'partner')),
  actor_id       uuid,
  -- Quem era no momento ("Juliana, Administrador"), para responder "quem mandou fazer isso?".
  actor_label    text,
  actor_role     text,
  action         text not null check (action ~ '^[a-z_]+\.[a-z_]+$'),
  resource_type  text,
  resource_id    text,
  before         jsonb,
  after          jsonb,
  reason         text,
  approval_id    uuid,
  trace_id       text,
  origin         text not null check (origin in ('api', 'worker', 'mcp', 'console')),
  tool           text,
  agent          text,
  model          text,
  occurred_at    timestamptz not null,
  prev_hash      text not null,
  hash           text not null,
  unique (chain_key, chain_seq)
);
create index if not exists idx_audit_event_tenant on liame.audit_event (tenant_id, occurred_at desc) where tenant_id is not null;
create index if not exists idx_audit_event_dia on liame.audit_event (chain_key, occurred_at);

alter table liame.audit_event enable row level security;
alter table liame.audit_event force row level security;
drop policy if exists audit_event_isolamento on liame.audit_event;
create policy audit_event_isolamento on liame.audit_event
  using (
    tenant_id = liame.current_tenant_id()
    or (tenant_id is null and actor_id = liame.current_user_id())
    or liame.system_scope()
  )
  with check (
    tenant_id = liame.current_tenant_id()
    or (tenant_id is null and actor_id = liame.current_user_id())
    or liame.system_scope()
  );
-- Só inserir e ler: nada de UPDATE nem DELETE para a aplicação.
grant select, insert on liame.audit_event to liame_app;

-- Imutável também para o dono das tabelas: alterar ou apagar exige desligar isto de propósito
-- (o expurgo do fim de contrato é decidido no ciclo de vida, ADR-014).
create or replace function liame.audit_event_imutavel() returns trigger
language plpgsql as $$
begin
  raise exception 'auditoria é só de inserção (%)', tg_op using errcode = '42501';
end;
$$;
drop trigger if exists audit_event_imutavel on liame.audit_event;
create trigger audit_event_imutavel before update or delete on liame.audit_event
  for each row execute function liame.audit_event_imutavel();

-- ------------------------------------------------------------ âncora diária

-- Uma raiz por dia (UTC), encadeada à do dia anterior e publicada fora do banco.
create table if not exists liame.audit_anchor (
  day              date primary key,
  root_hash        text not null,
  prev_root_hash   text not null,
  chains           integer not null,
  events           bigint not null,
  created_at       timestamptz not null default now(),
  rekor_log_index  bigint,
  rekor_entry      text,
  tsa_response     text,
  s3_version_id    text,
  published_at     timestamptz
);

alter table liame.audit_anchor enable row level security;
alter table liame.audit_anchor force row level security;
drop policy if exists audit_anchor_sistema on liame.audit_anchor;
create policy audit_anchor_sistema on liame.audit_anchor
  using (liame.system_scope()) with check (liame.system_scope());
grant select, insert on liame.audit_anchor to liame_app;
-- A raiz não muda depois de gravada: a aplicação só completa os comprovantes da publicação.
grant update (rekor_log_index, rekor_entry, tsa_response, s3_version_id, published_at) on liame.audit_anchor to liame_app;
