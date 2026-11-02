-- 0101 · O time da agência dentro de cada cliente (A7, W6, parte 3; ADR-017; D-A7-47 a D-A7-50): a dona ou um
-- administrador da agência coloca pessoas do time numa empresa que aceitou o vínculo, com o nível e o limite até o
-- máximo do Dono. Cada pessoa entra com um vínculo (`membership`) na empresa, ligado ao vínculo da agência, e sai junto
-- com ele.
-- Idempotente; uma transação por arquivo (ADR-018).

-- O vínculo da pessoa com a empresa diz de qual agência ela vem. Sem o vínculo da agência (a agência fechada e
-- apagada), o acesso some junto.
alter table liame.membership add column if not exists partner_link_id uuid references liame.partner_link (id) on delete cascade;
create index if not exists idx_membership_parceiro on liame.membership (partner_link_id) where partner_link_id is not null and revoked_at is null;

-- Quem vem da agência nunca é Dono, nunca tem a cobrança e nunca é "só relatórios" (D-A7-47).
alter table liame.membership drop constraint if exists membership_parceiro_check;
alter table liame.membership add constraint membership_parceiro_check
  check (partner_link_id is null or (billing_access = false and role_key in ('administrador', 'gestor', 'aprovador', 'somente_leitura')));

-- A agência lê e grava o vínculo do time dela nos clientes dela: lê os do vínculo dela; grava só no vínculo vivo, na
-- empresa do vínculo. O resto continua como na 0002 (a empresa, a própria pessoa e o escopo de sistema).
drop policy if exists membership_isolamento on liame.membership;
create policy membership_isolamento on liame.membership
  using (
    tenant_id = liame.current_tenant_id()
    or user_id = liame.current_user_id()
    or liame.system_scope()
    or (partner_link_id is not null and exists (
          select 1 from liame.partner_link l
           where l.id = membership.partner_link_id and l.partner_org_id = liame.current_tenant_id()))
  )
  with check (
    tenant_id = liame.current_tenant_id()
    or liame.system_scope()
    or (partner_link_id is not null and exists (
          select 1 from liame.partner_link l
           where l.id = membership.partner_link_id and l.partner_org_id = liame.current_tenant_id()
             and l.client_org_id = membership.tenant_id and l.status = 'ativo'))
  );
