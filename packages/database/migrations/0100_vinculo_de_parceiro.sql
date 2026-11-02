-- 0100 · O vínculo de parceiro (A7, W6, parte 2; ADR-017; D-A7-46 a D-A7-50): o pedido da agência ao Dono de uma
-- empresa, o aceite com o nível máximo e o limite, a recusa, e o desfazer pelos dois lados. O time da agência dentro
-- da empresa vem na parte 3; até lá, o vínculo aceito não dá acesso a ninguém.
-- Idempotente; uma transação por arquivo (ADR-018).

-- A semente da função grava em tabela com RLS forçada (V20).
select set_config('app.scope', 'sistema', true);

-- ------------------------------------------------------------ o pedido e o vínculo

-- Uma linha por pedido. Enquanto é pedido, vai para um e-mail (o do Dono) e ainda não tem empresa: a empresa é a que
-- o Dono escolhe ao aceitar. `owner_user_id` é a pessoa daquele e-mail, quando ela tem conta (nula se não tem: o pedido
-- existe do mesmo jeito e vence, para a agência não saber quem usa o Liame).
create table if not exists liame.partner_link (
  id                    uuid primary key,
  partner_org_id        uuid not null references liame.organization (id) on delete cascade,
  client_org_id         uuid references liame.organization (id) on delete cascade,
  owner_email           text not null check (owner_email = lower(owner_email) and position('@' in owner_email) > 1),
  owner_user_id         uuid references liame.app_user (id) on delete set null,
  -- O que a agência pede e o máximo que o Dono dá: nunca o Dono, nunca "só relatórios" (D-A7-47).
  requested_role        text not null check (requested_role in ('administrador', 'gestor', 'aprovador', 'somente_leitura')),
  message               text check (message is null or length(message) <= 300),
  -- pedido → ativo (aceito) | recusado | cancelado (pela agência) | substituido (pedido de novo ao mesmo e-mail);
  -- ativo → desfeito (por um dos lados) | vencido (a data de fim passou e outro vínculo entrou no lugar).
  status                text not null default 'pedido'
                        check (status in ('pedido', 'ativo', 'recusado', 'cancelado', 'substituido', 'desfeito', 'vencido')),
  request_expires_at    timestamptz not null,
  max_role              text check (max_role in ('administrador', 'gestor', 'aprovador', 'somente_leitura')),
  approve_limit_micros  bigint check (approve_limit_micros >= 0),
  dual_approval         boolean not null default true,
  ends_at               timestamptz,
  requested_by          uuid not null references liame.app_user (id),
  decided_by            uuid references liame.app_user (id),
  decided_at            timestamptz,
  ended_by              uuid references liame.app_user (id),
  ended_at              timestamptz,
  ended_side            text check (ended_side in ('empresa', 'agencia')),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  -- O vínculo aceito tem a empresa, o máximo e quem decidiu; a recusa guarda a empresa que recusou.
  constraint partner_link_aceito_check
    check (status not in ('ativo', 'desfeito', 'vencido') or (client_org_id is not null and max_role is not null and decided_at is not null)),
  constraint partner_link_recusa_check check (status <> 'recusado' or (client_org_id is not null and decided_at is not null)),
  constraint partner_link_fim_check check ((status in ('desfeito', 'vencido')) = (ended_at is not null)),
  constraint partner_link_lado_check check ((status = 'desfeito') = (ended_side is not null)),
  constraint partner_link_outra_org_check check (client_org_id is null or client_org_id <> partner_org_id)
);
-- Um pedido em aberto por agência e e-mail: pedir de novo troca o anterior (D-A7-46).
create unique index if not exists uq_partner_link_pedido on liame.partner_link (partner_org_id, owner_email) where status = 'pedido';
-- Um vínculo vivo por agência e empresa.
create unique index if not exists uq_partner_link_ativo on liame.partner_link (partner_org_id, client_org_id) where status = 'ativo';
create index if not exists idx_partner_link_cliente on liame.partner_link (client_org_id, created_at desc) where client_org_id is not null;
create index if not exists idx_partner_link_agencia on liame.partner_link (partner_org_id, created_at desc);
create index if not exists idx_partner_link_dono on liame.partner_link (owner_user_id) where status = 'pedido';
-- A política da pessoa procura por quem pediu (o nome que o Dono vê).
create index if not exists idx_partner_link_quem_pediu on liame.partner_link (requested_by);

drop trigger if exists tg_partner_link_touch on liame.partner_link;
create trigger tg_partner_link_touch before update on liame.partner_link for each row execute function liame.touch_updated_at();

-- Os dois lados (RLS dos dois lados): a agência vê os pedidos e os vínculos dela; a empresa, os vínculos dela; e o
-- Dono vê o pedido em aberto feito ao e-mail dele, antes de escolher a empresa.
alter table liame.partner_link enable row level security;
alter table liame.partner_link force row level security;
drop policy if exists partner_link_isolamento on liame.partner_link;
create policy partner_link_isolamento on liame.partner_link
  using (
    partner_org_id = liame.current_tenant_id()
    or client_org_id = liame.current_tenant_id()
    or (status = 'pedido' and owner_user_id = liame.current_user_id())
    or liame.system_scope()
  )
  with check (partner_org_id = liame.current_tenant_id() or client_org_id = liame.current_tenant_id() or liame.system_scope());
grant select, insert, update on liame.partner_link to liame_app;

-- ------------------------------------------------------------ os nomes entre os dois lados

-- A organização: além da própria e das que a pessoa tem vínculo, a empresa vê a agência ligada a ela (e o Dono, a
-- agência que lhe fez um pedido), e a agência vê a empresa que aceitou o vínculo (vivo ou que já acabou). A recusa
-- não mostra a empresa à agência.
drop policy if exists organization_isolamento on liame.organization;
create policy organization_isolamento on liame.organization
  using (
    id = liame.current_tenant_id()
    or liame.system_scope()
    or exists (select 1 from liame.membership m
                where m.tenant_id = organization.id and m.user_id = liame.current_user_id() and m.revoked_at is null)
    or exists (select 1 from liame.partner_link l
                where l.partner_org_id = organization.id
                  and (l.client_org_id = liame.current_tenant_id()
                       or (l.status = 'pedido' and l.owner_user_id = liame.current_user_id())))
    or exists (select 1 from liame.partner_link l
                where l.client_org_id = organization.id and l.partner_org_id = liame.current_tenant_id()
                  and l.status in ('ativo', 'desfeito', 'vencido'))
  )
  with check (id = liame.current_tenant_id() or liame.system_scope());

-- A pessoa: o Dono vê o nome de quem, da agência, fez o pedido (o aberto ao e-mail dele e os vínculos da empresa).
drop policy if exists app_user_isolamento on liame.app_user;
create policy app_user_isolamento on liame.app_user
  using (
    id = liame.current_user_id()
    or liame.system_scope()
    or exists (select 1 from liame.membership m
                where m.user_id = app_user.id and m.tenant_id = liame.current_tenant_id())
    or exists (select 1 from liame.partner_link l
                where l.requested_by = app_user.id
                  and (l.client_org_id = liame.current_tenant_id()
                       or (l.status = 'pedido' and l.owner_user_id = liame.current_user_id())))
  )
  with check (id = liame.current_user_id() or liame.system_scope());

-- ------------------------------------------------------------ a função

-- Liga, por empresa, os parceiros: sem ela, a empresa não recebe pedido de agência (nem o e-mail, nem a lista em
-- Pessoas e acessos) e o Dono não aceita. Nasce desligada.
insert into liame.feature_flag (key, kind, default_value, description, owner, is_write)
values ('parceiros', 'boolean', 'false', 'Pessoas e acessos: a agência ou o consultor com time pede para cuidar da conta pelo e-mail do Dono, que aceita com o nível máximo, o limite e o código do app, muda e desfaz (A7, W6; ADR-017)', 'acesso', false)
on conflict (key) do nothing;
