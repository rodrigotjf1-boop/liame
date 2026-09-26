-- 0015 · O que "Pessoas e acessos" mostra de cada pessoa (ADR-017): se o app autenticador está ativo
-- e o último acesso NESTA empresa. O segredo do app e as sessões continuam só da própria pessoa (RLS);
-- aqui ficam apenas duas datas, legíveis por quem já vê a lista de pessoas da empresa.
-- Idempotente; uma transação por arquivo (ADR-018).

-- A RLS forçada vale até para o dono das tabelas: o preenchimento abaixo roda como sistema (V20).
select set_config('app.scope', 'sistema', true);

-- Gravada quando a pessoa confirma o app autenticador (e mantida quando ela troca de aparelho).
alter table liame.app_user add column if not exists mfa_enabled_at timestamptz;

-- Atualizada junto com a sessão (a cada 5 minutos de uso) na empresa ativa: atividade em outra
-- empresa não aparece aqui.
alter table liame.membership add column if not exists last_seen_at timestamptz;

-- Quem já tinha o app ativo antes desta migration.
update liame.app_user u
   set mfa_enabled_at = x.created_at
  from (select owner_user_id, min(created_at) as created_at
          from liame.secret
         where tenant_id is null and purpose = 'totp' and revoked_at is null
         group by owner_user_id) x
 where x.owner_user_id = u.id and u.mfa_enabled_at is null;

-- Último acesso conhecido, pelas sessões que estavam nesta empresa.
update liame.membership m
   set last_seen_at = s.seen
  from (select user_id, active_tenant_id, max(last_seen_at) as seen
          from liame.session
         where active_tenant_id is not null
         group by user_id, active_tenant_id) s
 where s.user_id = m.user_id and s.active_tenant_id = m.tenant_id and m.last_seen_at is null;
