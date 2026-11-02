-- 0099 · A agência (A7, W6, parte 1; ADR-017; D-A7-45 e D-A7-51): a organização do tipo agência, com o time dela.
-- A agência é uma organização como a empresa, mas sem marca e sem assinatura: só o time. Cada pessoa do time tem um
-- vínculo (`membership`) com a agência, com um dos três papéis dela. O pedido de vínculo a uma empresa e o time da
-- agência dentro de cada cliente vêm nas partes seguintes.
-- Idempotente; uma transação por arquivo (ADR-018).

-- A RLS é forçada até para o dono das tabelas: a semente dos papéis grava no escopo de sistema, só nesta transação.
select set_config('app.scope', 'sistema', true);

-- ------------------------------------------------------------ o tipo da organização

-- A empresa (o cliente: marcas, assinatura, campanhas) ou a agência (o time que cuida de empresas). O tipo nasce com a
-- organização e não muda.
alter table liame.organization add column if not exists kind text not null default 'empresa';
alter table liame.organization drop constraint if exists organization_kind_check;
alter table liame.organization add constraint organization_kind_check check (kind in ('empresa', 'agencia'));

create or replace function liame.tipo_da_organizacao_nao_muda() returns trigger
  language plpgsql
  as $$
begin
  if new.kind is distinct from old.kind then
    raise exception 'o tipo da organização não muda (de % para %)', old.kind, new.kind using errcode = 'check_violation';
  end if;
  return new;
end $$;
drop trigger if exists tg_organization_tipo on liame.organization;
create trigger tg_organization_tipo before update of kind on liame.organization
  for each row execute function liame.tipo_da_organizacao_nao_muda();

-- ------------------------------------------------------------ os papéis na agência (D-A7-51)

-- Dona da agência (tudo; uma por agência), Administrador da agência (pede acesso a clientes, convida o time e escolhe
-- quem entra em cada cliente) e Membro (trabalha só nos clientes em que for colocado). Na agência, ninguém tem as
-- permissões das empresas: elas vêm do vínculo com cada cliente (parte 3).
insert into liame.role (key, name) values
  ('agencia_dona', 'Dona da agência'),
  ('agencia_admin', 'Administrador da agência'),
  ('agencia_membro', 'Membro da agência')
on conflict (key) do update set name = excluded.name;

insert into liame.role_permission (tenant_id, role_key, permission)
select null, v.role_key, v.permission
  from (values
    ('agencia_dona', 'agencia.ver'), ('agencia_dona', 'agencia.time'), ('agencia_dona', 'agencia.clientes'),
    ('agencia_admin', 'agencia.ver'), ('agencia_admin', 'agencia.time'), ('agencia_admin', 'agencia.clientes'),
    ('agencia_membro', 'agencia.ver')
  ) as v (role_key, permission)
on conflict do nothing;

-- Uma dona por agência, como um dono por empresa (`uq_membership_dono`).
create unique index if not exists uq_membership_dona_agencia on liame.membership (tenant_id)
  where role_key = 'agencia_dona' and revoked_at is null;

-- O convite do time da agência: Administrador ou Membro da agência (a dona não se convida, como o dono).
alter table liame.invitation drop constraint if exists invitation_role_key_check;
alter table liame.invitation add constraint invitation_role_key_check
  check (role_key in ('administrador', 'gestor', 'aprovador', 'somente_leitura', 'so_relatorios', 'agencia_admin', 'agencia_membro'));

-- ------------------------------------------------------------ o papel combina com o tipo da organização

-- Os papéis da agência só valem numa agência, e os das empresas só numa empresa: defesa em camadas, além do serviço.
-- Quem grava sem enxergar a organização (fora do contexto dela) não é barrado aqui; nesses caminhos, quem confere é
-- o serviço.
create or replace function liame.papel_combina_com_a_organizacao() returns trigger
  language plpgsql
  as $$
declare
  tipo text;
begin
  select o.kind into tipo from liame.organization o where o.id = new.tenant_id;
  if tipo is not null
     and (tipo = 'agencia') is distinct from (new.role_key in ('agencia_dona', 'agencia_admin', 'agencia_membro')) then
    raise exception 'o papel % não vale numa organização do tipo %', new.role_key, tipo using errcode = 'check_violation';
  end if;
  return new;
end $$;
drop trigger if exists tg_membership_papel on liame.membership;
create trigger tg_membership_papel before insert or update of role_key, tenant_id on liame.membership
  for each row execute function liame.papel_combina_com_a_organizacao();
drop trigger if exists tg_invitation_papel on liame.invitation;
create trigger tg_invitation_papel before insert or update of role_key, tenant_id on liame.invitation
  for each row execute function liame.papel_combina_com_a_organizacao();
