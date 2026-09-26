-- 0005 · Convites e pessoas (ADR-017): o dono convida por e-mail quem administra por ele.
-- Idempotente; uma transação por arquivo (ADR-018).

-- O nível do vínculo passa a ser checado no banco (defesa em camadas; o conjunto é o do ADR-017).
alter table liame.membership drop constraint if exists membership_role_check;
alter table liame.membership add constraint membership_role_check
  check (role_key in ('dono', 'administrador', 'gestor', 'aprovador', 'somente_leitura', 'so_relatorios'));
-- Acesso à cobrança só para Dono e Administrador.
alter table liame.membership drop constraint if exists membership_billing_check;
alter table liame.membership add constraint membership_billing_check
  check (billing_access = false or role_key in ('dono', 'administrador'));

-- ------------------------------------------------------------ convite

create table if not exists liame.invitation (
  id                    uuid primary key,
  tenant_id             uuid not null references liame.organization (id) on delete cascade,
  email                 text not null,
  -- Ninguém é convidado como dono: a propriedade só se transfere (ADR-017).
  role_key              text not null check (role_key in ('administrador', 'gestor', 'aprovador', 'somente_leitura', 'so_relatorios')),
  approve_limit_micros  bigint check (approve_limit_micros >= 0),
  dual_approval         boolean not null default true,
  billing_access        boolean not null default false check (billing_access = false or role_key = 'administrador'),
  access_expires_at     timestamptz,
  token_hash            text not null unique,
  expires_at            timestamptz not null,
  invited_by            uuid not null references liame.app_user (id),
  accepted_at           timestamptz,
  accepted_by           uuid references liame.app_user (id),
  revoked_at            timestamptz,
  created_at            timestamptz not null default now()
);
-- Um convite em aberto por e-mail em cada empresa; convidar de novo substitui o anterior.
create unique index if not exists uq_invitation_aberto on liame.invitation (tenant_id, email)
  where accepted_at is null and revoked_at is null;
create index if not exists idx_invitation_tenant on liame.invitation (tenant_id, created_at desc);

alter table liame.invitation enable row level security;
alter table liame.invitation force row level security;
-- O aceite acontece antes do contexto da empresa (a pessoa só tem o link): escopo de sistema.
drop policy if exists invitation_isolamento on liame.invitation;
create policy invitation_isolamento on liame.invitation
  using (tenant_id = liame.current_tenant_id() or liame.system_scope())
  with check (tenant_id = liame.current_tenant_id() or liame.system_scope());

grant select, insert, update on liame.invitation to liame_app;
