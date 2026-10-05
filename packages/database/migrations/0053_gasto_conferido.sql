-- 0053 · O gasto conferido (A4, X4 parte 2; `plano-a4.md` D-A4-24 e critério A4-8). Todo dia, depois da leitura da
-- plataforma, cada mudança que o Liame fez numa conta de anúncio e que continua valendo ganha uma linha: como ele
-- deixou o objeto (execução), como a leitura do dia o mostra (informado) e quanto ele gastou (gasto real), com a semana
-- comparada à soma da verba de cada dia. Só cresce: é o registro do que foi conferido em cada dia, e de quando a
-- conferência passou a dizer "mudado na plataforma" ou "gastou a mais". Idempotente; uma transação por arquivo
-- (ADR-018).

create table if not exists liame.action_spend_check (
  id                     uuid primary key,
  tenant_id              uuid not null references liame.organization (id) on delete cascade,
  action_request_id      uuid not null references liame.action_request (id) on delete cascade,
  connected_account_id   uuid not null references liame.connected_account (id) on delete cascade,
  -- O dia da conferência, no fuso da conta de anúncio: uma por mudança e por dia.
  checked_on             date not null,
  -- Execução: como o Liame deixou o objeto (a verba é nula quando não mora nele).
  expected_status        text not null check (expected_status in ('ativo', 'pausado')),
  expected_daily_micros  bigint check (expected_daily_micros > 0),
  -- Informado: como a leitura do dia mostra o objeto; a situação é nula quando ele saiu da lista da conta.
  informed_status        text check (informed_status ~ '^[a-z_]{1,30}$'),
  informed_daily_micros  bigint check (informed_daily_micros > 0),
  -- Gasto real: os dias comparados, o gasto neles e o que a verba permite (nulo quando não há com o que comparar).
  window_from            date not null,
  window_to              date not null,
  spend_micros           bigint not null check (spend_micros >= 0),
  allowed_micros         bigint check (allowed_micros >= 0),
  -- Os dias inteiros depois do dia da mudança, e o gasto neles (a média "depois da mudança" que a tela mostra).
  days_after             integer not null check (days_after >= 0),
  spend_after_micros     bigint not null check (spend_after_micros >= 0),
  status                 text not null check (status in ('confere', 'mudou', 'acima')),
  created_at             timestamptz not null default now(),
  check (window_from <= window_to),
  unique (action_request_id, checked_on)
);
-- A rotina procura o que ainda não foi conferido hoje em cada conta; a Atenção, o que deu "acima" nos últimos dias.
create index if not exists idx_action_spend_check_conta on liame.action_spend_check (connected_account_id, checked_on desc);

alter table liame.action_spend_check enable row level security;
alter table liame.action_spend_check force row level security;
drop policy if exists action_spend_check_isolamento on liame.action_spend_check;
create policy action_spend_check_isolamento on liame.action_spend_check
  using (tenant_id = liame.current_tenant_id() or liame.system_scope())
  with check (tenant_id = liame.current_tenant_id() or liame.system_scope());
-- Só cresce: o que foi conferido num dia não é reescrito nem apagado (sai com a empresa, com a conta ou com o pedido).
grant select, insert on liame.action_spend_check to liame_app;
