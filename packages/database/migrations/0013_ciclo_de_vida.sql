-- 0013 · Ciclo de vida dos dados: ativo → arquivado → expurgado; fim de contrato com certificado (ADR-014).
-- Idempotente; uma transação por arquivo (ADR-018).

-- A semente das permissões grava com a RLS forçada (ERR-011).
select set_config('app.scope', 'sistema', true);

-- ------------------------------------------------------------ empresa

-- Encerrar a conta: 30 dias de graça (somente leitura + exportação) e depois o expurgo.
alter table liame.organization add column if not exists suspended_at timestamptz;
alter table liame.organization add column if not exists purge_after timestamptz;
alter table liame.organization add column if not exists purge_reason text;
-- Ordem judicial, investigação ou obrigação legal suspendem o expurgo, com motivo.
alter table liame.organization add column if not exists legal_hold_at timestamptz;
alter table liame.organization add column if not exists legal_hold_reason text;
alter table liame.organization drop constraint if exists organization_legal_hold_check;
alter table liame.organization add constraint organization_legal_hold_check
  check ((legal_hold_at is null) = (legal_hold_reason is null));

-- ------------------------------------------------------------ marca

alter table liame.brand add column if not exists archived_at timestamptz;
alter table liame.brand add column if not exists purge_after timestamptz;
alter table liame.brand add column if not exists purge_reason text;
alter table liame.brand drop constraint if exists brand_lifecycle_check;
alter table liame.brand add constraint brand_lifecycle_check check (purge_after is null or archived_at is not null);

-- ------------------------------------------------------------ certificado de expurgo

-- Prova do expurgo, guardada pela distribuição depois que a empresa some (sem conteúdo, só contagens).
create table if not exists liame.purge_certificate (
  id                 uuid primary key,
  -- A empresa já não existe quando o certificado é gravado: é referência, não tenant.
  purged_tenant_id   uuid not null,
  organization_name  text not null,
  cnpj               text,
  reason             text not null,
  summary            jsonb not null,
  certificate_hash   text not null,
  purged_at          timestamptz not null default now()
);
alter table liame.purge_certificate enable row level security;
alter table liame.purge_certificate force row level security;
drop policy if exists purge_certificate_sistema on liame.purge_certificate;
create policy purge_certificate_sistema on liame.purge_certificate using (liame.system_scope()) with check (liame.system_scope());
grant select, insert on liame.purge_certificate to liame_app;

-- ------------------------------------------------------------ permissões novas (só o dono)

insert into liame.role_permission (tenant_id, role_key, permission)
values (null, 'dono', 'empresa.encerrar'), (null, 'dono', 'empresa.exportar')
on conflict do nothing;

-- ------------------------------------------------------------ quem apaga é só o expurgo

-- O job de expurgo (escopo de sistema) apaga em lotes. A política restritiva garante que nenhuma
-- transação de empresa ou pessoa apague estas linhas, nem a própria organização.
grant delete on liame.organization, liame.outbox_event, liame.inbox_event, liame.session, liame.user_token to liame_app;
-- As regras de flag de uma empresa somem com ela (a tabela já é só do escopo de sistema).
grant delete on liame.feature_flag_rule to liame_app;

drop policy if exists organization_apaga_so_sistema on liame.organization;
create policy organization_apaga_so_sistema on liame.organization as restrictive for delete using (liame.system_scope());
drop policy if exists outbox_event_apaga_so_sistema on liame.outbox_event;
create policy outbox_event_apaga_so_sistema on liame.outbox_event as restrictive for delete using (liame.system_scope());
drop policy if exists inbox_event_apaga_so_sistema on liame.inbox_event;
create policy inbox_event_apaga_so_sistema on liame.inbox_event as restrictive for delete using (liame.system_scope());
drop policy if exists session_apaga_so_sistema on liame.session;
create policy session_apaga_so_sistema on liame.session as restrictive for delete using (liame.system_scope());
drop policy if exists user_token_apaga_so_sistema on liame.user_token;
create policy user_token_apaga_so_sistema on liame.user_token as restrictive for delete using (liame.system_scope());
