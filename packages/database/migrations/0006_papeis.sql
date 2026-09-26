-- 0006 · Papéis como dado (ADR-013): o papel é um conjunto de permissões guardado no banco.
-- Os conjuntos padrão do Liame têm tenant_id nulo; uma empresa pode ter o próprio conjunto para um
-- papel (linhas com o tenant_id dela), que substitui o padrão por inteiro. O vocabulário de
-- permissões, a ordem dos níveis e a exigência do app autenticador são do produto (código).
-- Idempotente; uma transação por arquivo (ADR-018).

-- A RLS é forçada até para o dono das tabelas: a semente grava no escopo de sistema, só nesta transação.
select set_config('app.scope', 'sistema', true);

create table if not exists liame.role (
  key         text primary key,
  name        text not null,
  created_at  timestamptz not null default now()
);

insert into liame.role (key, name) values
  ('dono', 'Dono'),
  ('administrador', 'Administrador'),
  ('gestor', 'Gestor'),
  ('aprovador', 'Aprovador'),
  ('somente_leitura', 'Somente leitura'),
  ('so_relatorios', 'Só relatórios por e-mail')
on conflict (key) do update set name = excluded.name;

-- O nível do vínculo e do convite passa a apontar para o papel (a lista fixa sai).
alter table liame.membership drop constraint if exists membership_role_check;
alter table liame.membership drop constraint if exists membership_role_fk;
alter table liame.membership add constraint membership_role_fk foreign key (role_key) references liame.role (key);
alter table liame.invitation drop constraint if exists invitation_role_fk;
alter table liame.invitation add constraint invitation_role_fk foreign key (role_key) references liame.role (key);

create table if not exists liame.role_permission (
  tenant_id   uuid references liame.organization (id) on delete cascade,
  role_key    text not null references liame.role (key),
  permission  text not null check (permission ~ '^[a-z_]+\.[a-z_]+$'),
  created_at  timestamptz not null default now()
);
create unique index if not exists uq_role_permission on liame.role_permission (tenant_id, role_key, permission) nulls not distinct;
create index if not exists idx_role_permission_tenant on liame.role_permission (tenant_id, role_key) where tenant_id is not null;

alter table liame.role enable row level security;
alter table liame.role force row level security;
drop policy if exists role_leitura on liame.role;
create policy role_leitura on liame.role using (true) with check (liame.system_scope());

alter table liame.role_permission enable row level security;
alter table liame.role_permission force row level security;
-- Todos leem o padrão; cada empresa lê o próprio conjunto; só o escopo de sistema grava nesta fase.
drop policy if exists role_permission_isolamento on liame.role_permission;
create policy role_permission_isolamento on liame.role_permission
  using (tenant_id is null or tenant_id = liame.current_tenant_id() or liame.system_scope())
  with check (liame.system_scope());

grant select on liame.role to liame_app;
grant select on liame.role_permission to liame_app;

-- Conjuntos padrão (ADR-017). Mudar um padrão depois é uma migration nova.
insert into liame.role_permission (tenant_id, role_key, permission)
select null, v.role_key, v.permission
  from (values
    ('dono', 'empresa.ver'), ('dono', 'empresa.editar'), ('dono', 'marcas.ver'), ('dono', 'marcas.gerenciar'),
    ('dono', 'pessoas.ver'), ('dono', 'pessoas.convidar'), ('dono', 'pessoas.remover'), ('dono', 'pessoas.alterar_nivel'),
    ('dono', 'cobranca.ver'), ('dono', 'cobranca.gerenciar'), ('dono', 'auditoria.ver'), ('dono', 'acoes.aprovar'),
    ('dono', 'campanhas.ver'), ('dono', 'campanhas.operar'), ('dono', 'relatorios.ver'), ('dono', 'agentes.gerenciar'),
    ('dono', 'parada.acionar'),

    ('administrador', 'empresa.ver'), ('administrador', 'empresa.editar'), ('administrador', 'marcas.ver'),
    ('administrador', 'marcas.gerenciar'), ('administrador', 'pessoas.ver'), ('administrador', 'pessoas.convidar'),
    ('administrador', 'pessoas.remover'), ('administrador', 'pessoas.alterar_nivel'), ('administrador', 'auditoria.ver'),
    ('administrador', 'acoes.aprovar'), ('administrador', 'campanhas.ver'), ('administrador', 'campanhas.operar'),
    ('administrador', 'relatorios.ver'), ('administrador', 'agentes.gerenciar'), ('administrador', 'parada.acionar'),

    ('gestor', 'empresa.ver'), ('gestor', 'marcas.ver'), ('gestor', 'pessoas.ver'), ('gestor', 'acoes.aprovar'),
    ('gestor', 'campanhas.ver'), ('gestor', 'campanhas.operar'), ('gestor', 'relatorios.ver'), ('gestor', 'agentes.gerenciar'),
    ('gestor', 'parada.acionar'),

    ('aprovador', 'empresa.ver'), ('aprovador', 'marcas.ver'), ('aprovador', 'acoes.aprovar'), ('aprovador', 'campanhas.ver'),
    ('aprovador', 'relatorios.ver'),

    ('somente_leitura', 'empresa.ver'), ('somente_leitura', 'marcas.ver'), ('somente_leitura', 'campanhas.ver'),
    ('somente_leitura', 'relatorios.ver')
    -- so_relatorios: nenhuma permissão; só recebe o resumo por e-mail.
  ) as v (role_key, permission)
on conflict do nothing;
