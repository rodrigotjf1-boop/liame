-- 0104 · O lembrete do relatório da agência (A7, W7, parte 4b; D-A7-67; D-A7-83): no dia 3, às 8h no fuso da loja, o
-- time da agência que ainda não mandou o relatório do mês do cliente recebe um lembrete, uma vez por relatório e
-- agência (uma hora antes de o e-mail do próprio Liame sair, D-A7-68). O envio sozinho do dia 2 grava em
-- `agency_report_send` (0103), como `sozinho`. Quem grava é a rotina do worker, em escopo de sistema.
-- Idempotente; uma transação por arquivo (ADR-018).

create table if not exists liame.agency_report_reminder (
  id          uuid primary key,
  tenant_id   uuid not null references liame.organization (id) on delete cascade,
  agency_id   uuid not null references liame.organization (id) on delete cascade,
  report_id   uuid not null references liame.monthly_report (id) on delete cascade,
  -- Para quantas pessoas do time o lembrete saiu (zero: ninguém do time vê os resultados ou tem o e-mail confirmado).
  recipients  integer not null default 0 check (recipients >= 0),
  sent_at     timestamptz not null default now(),
  created_at  timestamptz not null default now(),
  constraint agency_report_reminder_um_por_relatorio unique (report_id, agency_id)
);
create index if not exists idx_agency_report_reminder_tenant on liame.agency_report_reminder (tenant_id);
create index if not exists idx_agency_report_reminder_agencia on liame.agency_report_reminder (agency_id);

-- A agência e a empresa leem; só a rotina grava.
alter table liame.agency_report_reminder enable row level security;
alter table liame.agency_report_reminder force row level security;
drop policy if exists agency_report_reminder_isolamento on liame.agency_report_reminder;
create policy agency_report_reminder_isolamento on liame.agency_report_reminder
  using (tenant_id = liame.current_tenant_id() or agency_id = liame.current_tenant_id() or liame.system_scope())
  with check (liame.system_scope());
grant select, insert, update on liame.agency_report_reminder to liame_app;
