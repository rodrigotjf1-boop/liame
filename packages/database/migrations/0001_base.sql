-- 0001 · Base do Liame (ADR-018, plano da A1 D-A1-2)
-- Roda como liame_owner. Os papéis liame_owner e liame_app já existem (bootstrap; na nuvem, o dono cria).
-- O liame_app só recebe o que cada migration conceder, tabela por tabela.

create schema if not exists liame;
revoke all on schema liame from public;
grant usage on schema liame to liame_app;

-- Tenant da transação atual: set_config('app.tenant_id', ..., true) em cada transação (ADR-003).
-- Base de todas as políticas de RLS: `using (tenant_id = liame.current_tenant_id())`.
create or replace function liame.current_tenant_id() returns uuid
  language sql
  stable
  as $$ select nullif(current_setting('app.tenant_id', true), '')::uuid $$;

revoke all on function liame.current_tenant_id() from public;
grant execute on function liame.current_tenant_id() to liame_app;
