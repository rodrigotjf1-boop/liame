-- 0004 · Segundo fator por app autenticador (ADR-013, plano da A1 E2b)
-- O segredo TOTP fica no cofre (liame.secret, finalidade 'totp'); aqui só o controle.

-- Último passo TOTP aceito: o mesmo código não vale duas vezes.
alter table liame.app_user add column if not exists totp_last_step bigint;

-- Como a sessão provou o segundo fator. Código de recuperação não troca o fator sem espera (ADR-013).
alter table liame.session add column if not exists mfa_method text;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'session_mfa_method_check') then
    alter table liame.session add constraint session_mfa_method_check check (mfa_method in ('totp', 'recuperacao'));
  end if;
end $$;

-- 10 códigos de recuperação de uso único; o banco guarda só o hash.
create table if not exists liame.recovery_code (
  id          uuid primary key,
  user_id     uuid not null references liame.app_user (id) on delete cascade,
  code_hash   text not null,
  used_at     timestamptz,
  created_at  timestamptz not null default now()
);
create index if not exists idx_recovery_code_user on liame.recovery_code (user_id) where used_at is null;

alter table liame.recovery_code enable row level security;
alter table liame.recovery_code force row level security;
drop policy if exists recovery_code_isolamento on liame.recovery_code;
create policy recovery_code_isolamento on liame.recovery_code
  using (user_id = liame.current_user_id() or liame.system_scope())
  with check (user_id = liame.current_user_id() or liame.system_scope());

grant select, insert, update, delete on liame.recovery_code to liame_app;

-- Troca do segundo fator por quem perdeu o aparelho: pedido confirmado por e-mail, vale depois de 24 h.
alter table liame.user_token drop constraint if exists user_token_purpose_check;
alter table liame.user_token add constraint user_token_purpose_check
  check (purpose in ('confirmar_email', 'redefinir_senha', 'trocar_segundo_fator'));
alter table liame.user_token add column if not exists usable_after timestamptz;

-- A pessoa vê e grava só os próprios pedidos de troca; os demais tokens seguem só no escopo de sistema.
drop policy if exists user_token_troca_propria on liame.user_token;
create policy user_token_troca_propria on liame.user_token
  using (purpose = 'trocar_segundo_fator' and user_id = liame.current_user_id())
  with check (purpose = 'trocar_segundo_fator' and user_id = liame.current_user_id());
