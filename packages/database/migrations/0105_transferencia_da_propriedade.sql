-- 0105 · A transferência da propriedade da conta (A7, W8, parte 2; ADR-017; D-A7-59 a D-A7-61; D-A7-84): o Dono pede,
-- com o código do app, que um Administrador da empresa vire o dono; quem recebe aceita com o código do app dela e o
-- aceite dos Termos como dona, em até 7 dias. Até o aceite nada muda, e o Dono cancela quando quiser. No aceite, a dona
-- nova passa a ter tudo o que é só do Dono, e o Dono antigo fica como Administrador ou sai, como escolheu no pedido.
-- Idempotente; uma transação por arquivo (ADR-018).

create table if not exists liame.ownership_transfer (
  id               uuid primary key,
  tenant_id        uuid not null references liame.organization (id) on delete cascade,
  from_user_id     uuid not null references liame.app_user (id) on delete cascade,
  to_user_id       uuid not null references liame.app_user (id) on delete cascade,
  -- O Dono antigo fica como Administrador (sem a cobrança) ou sai quando a dona nova aceitar (D-A7-61).
  old_owner_stays  boolean not null,
  -- pedido → aceito | recusado (por quem recebe) | cancelado (pelo Dono) | vencido (7 dias sem resposta).
  status           text not null default 'pedido' check (status in ('pedido', 'aceito', 'recusado', 'cancelado', 'vencido')),
  expires_at       timestamptz not null,
  decided_at       timestamptz,
  -- A versão dos Termos que a dona nova aceitou como dona.
  terms_version    text check (terms_version is null or length(terms_version) between 1 and 60),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint ownership_transfer_outra_pessoa check (from_user_id <> to_user_id),
  constraint ownership_transfer_decidido check ((status = 'pedido') = (decided_at is null)),
  constraint ownership_transfer_termos check ((status = 'aceito') = (terms_version is not null))
);
-- Um pedido em aberto por empresa.
create unique index if not exists uq_ownership_transfer_pedido on liame.ownership_transfer (tenant_id) where status = 'pedido';
create index if not exists idx_ownership_transfer_tenant on liame.ownership_transfer (tenant_id, created_at desc);
create index if not exists idx_ownership_transfer_de on liame.ownership_transfer (from_user_id);
create index if not exists idx_ownership_transfer_para on liame.ownership_transfer (to_user_id);
drop trigger if exists tg_ownership_transfer_touch on liame.ownership_transfer;
create trigger tg_ownership_transfer_touch before update on liame.ownership_transfer for each row execute function liame.touch_updated_at();

-- A empresa lê e grava os pedidos dela (o Dono e quem recebe estão na empresa e agem com ela ativa).
alter table liame.ownership_transfer enable row level security;
alter table liame.ownership_transfer force row level security;
drop policy if exists ownership_transfer_isolamento on liame.ownership_transfer;
create policy ownership_transfer_isolamento on liame.ownership_transfer
  using (tenant_id = liame.current_tenant_id() or liame.system_scope())
  with check (tenant_id = liame.current_tenant_id() or liame.system_scope());
grant select, insert, update on liame.ownership_transfer to liame_app;
