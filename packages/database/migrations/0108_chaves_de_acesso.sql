-- 0108 · As chaves de acesso (passkeys, WebAuthn; A7, W9, parte 9a; ADR-013; P28; D-A7-54 a D-A7-58; D-A7-87; base
-- §17.7): a pessoa cadastra uma chave em Segurança da conta e a usa no lugar do código do app. O Liame guarda a chave
-- PÚBLICA, o contador de assinaturas, o gerenciador (AAGUID), se ela sincroniza e o último uso; nada da biometria, que
-- não sai do aparelho. Cada cerimônia (cadastrar, confirmar, entrar) usa um desafio de uso único, que vence em 5 minutos.
-- Idempotente; uma transação por arquivo (ADR-018).

-- O identificador WebAuthn da pessoa (o "user handle"): aleatório, sem dado pessoal, separado do id interno.
alter table liame.app_user add column if not exists webauthn_user_id text;
alter table liame.app_user drop constraint if exists app_user_webauthn_user_id_check;
alter table liame.app_user add constraint app_user_webauthn_user_id_check
  check (webauthn_user_id is null or webauthn_user_id ~ '^[A-Za-z0-9_-]{16,128}$');
create unique index if not exists uq_app_user_webauthn_user_id on liame.app_user (webauthn_user_id) where webauthn_user_id is not null;

create table if not exists liame.passkey (
  id              uuid primary key,
  user_id         uuid not null references liame.app_user (id) on delete cascade,
  -- O id da credencial, em base64url, como o navegador manda.
  -- (A repetição da expressão regular do Postgres vai até 255: o tamanho é conferido à parte, V119.)
  credential_id   text not null check (credential_id ~ '^[A-Za-z0-9_-]+$' and length(credential_id) between 16 and 1366),
  public_key      bytea not null,
  -- O contador de assinaturas do aparelho (muitos mandam sempre 0).
  counter         bigint not null default 0 check (counter >= 0),
  transports      text[] not null default '{}'::text[],
  -- `multiDevice` (sincroniza entre os aparelhos da mesma conta, como Google e Apple) ou `singleDevice` (só naquele
  -- aparelho ou chave física); e se a cópia já está guardada.
  device_type     text not null check (device_type in ('singleDevice', 'multiDevice')),
  backed_up       boolean not null,
  -- O gerenciador que guarda a chave (zeros quando o aparelho não diz).
  aaguid          text not null check (aaguid ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  name            text not null check (length(name) between 1 and 60),
  created_at      timestamptz not null default now(),
  last_used_at    timestamptz,
  -- Onde foi o último uso, como a pessoa reconhece ("Chrome no Windows").
  last_used_where text check (last_used_where is null or length(last_used_where) between 1 and 80)
);
create unique index if not exists uq_passkey_credential on liame.passkey (credential_id);
create index if not exists idx_passkey_user on liame.passkey (user_id);

-- A pessoa lê e grava só as próprias chaves; a entrada sem senha (que ainda não sabe quem é) acha a chave no escopo de
-- sistema, pela credencial.
alter table liame.passkey enable row level security;
alter table liame.passkey force row level security;
drop policy if exists passkey_propria on liame.passkey;
create policy passkey_propria on liame.passkey
  using (user_id = liame.current_user_id() or liame.system_scope())
  with check (user_id = liame.current_user_id() or liame.system_scope());
grant select, insert, update, delete on liame.passkey to liame_app;

create table if not exists liame.webauthn_challenge (
  id          uuid primary key,
  -- A pessoa da cerimônia; nulo na entrada sem senha (a chave diz quem é).
  user_id     uuid references liame.app_user (id) on delete cascade,
  purpose     text not null check (purpose in ('cadastrar', 'confirmar', 'segundo_fator', 'entrar')),
  challenge   text not null check (challenge ~ '^[A-Za-z0-9_-]{16,128}$'),
  expires_at  timestamptz not null,
  used_at     timestamptz,
  created_at  timestamptz not null default now(),
  constraint webauthn_challenge_dono check ((purpose = 'entrar') = (user_id is null))
);
create index if not exists idx_webauthn_challenge_vence on liame.webauthn_challenge (expires_at);

-- O desafio da pessoa é dela; o da entrada sem senha (sem pessoa), só no escopo de sistema.
alter table liame.webauthn_challenge enable row level security;
alter table liame.webauthn_challenge force row level security;
drop policy if exists webauthn_challenge_proprio on liame.webauthn_challenge;
create policy webauthn_challenge_proprio on liame.webauthn_challenge
  using (user_id = liame.current_user_id() or liame.system_scope())
  with check (user_id = liame.current_user_id() or liame.system_scope());
grant select, insert, update, delete on liame.webauthn_challenge to liame_app;

-- A sessão também prova o segundo fator com a chave.
alter table liame.session drop constraint if exists session_mfa_method_check;
alter table liame.session add constraint session_mfa_method_check check (mfa_method in ('totp', 'recuperacao', 'chave'));

-- Conferência no mesmo arquivo (ADR-018): as duas tabelas com a RLS forçada e a credencial única.
do $$
begin
  if (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'liame' and c.relname in ('passkey', 'webauthn_challenge')
         and c.relrowsecurity and c.relforcerowsecurity) <> 2 then
    raise exception '0108: as tabelas das chaves sem a RLS forçada';
  end if;
  if not exists (select 1 from pg_indexes where schemaname = 'liame' and indexname = 'uq_passkey_credential') then
    raise exception '0108: falta o índice da credencial única';
  end if;
end $$;
