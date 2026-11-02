-- 0106 · A recuperação da conta do Dono (A7, W8, parte 4a; ADR-013; P34; D-A7-62, D-A7-64; D-A7-85): quem perdeu o
-- celular e os códigos de recuperação pede na própria entrada, depois da senha, com o documento com foto. A DMS confere
-- quem é (o documento, o nome no quadro de sócios pelo CNPJ e uma videochamada curta) pelo comando da distribuição;
-- depois, 7 dias de espera, e o pedido cai sozinho se o Dono entrar com o app ou com um código. O documento fica numa
-- tabela à parte, lacrado com a chave pública da DMS: o servidor guarda e apaga, mas não abre (só o comando da DMS, com
-- a chave privada, abre). Idempotente; uma transação por arquivo (ADR-018).

create sequence if not exists liame.account_recovery_numero;
grant usage on sequence liame.account_recovery_numero to liame_app;

create table if not exists liame.account_recovery (
  id                   uuid primary key,
  user_id              uuid not null references liame.app_user (id) on delete cascade,
  -- O protocolo que a pessoa e a DMS citam, como REC-2026-0042.
  protocol             text not null check (protocol ~ '^REC-[0-9]{4}-[0-9]{4,}$'),
  reason               text not null check (reason in ('perdi_celular_e_codigos', 'celular_roubado_ou_quebrado', 'outro')),
  -- pedido → conferido (a espera de 7 dias) → aplicado; ou recusado (pela DMS), cancelado (pelo Dono, ou sozinho quando
  -- ele entrou com o app ou com um código) ou parado (um Administrador não reconheceu; só a DMS retoma).
  status               text not null default 'pedido' check (status in ('pedido', 'conferido', 'parado', 'aplicado', 'recusado', 'cancelado')),
  -- As empresas de que a pessoa era a dona quando pediu (nome e CNPJ), para a DMS conferir na Receita.
  companies            jsonb not null default '[]'::jsonb check (jsonb_typeof(companies) = 'array'),
  -- A conferência da DMS: quando, quem e o que conferiu (o documento, o quadro de sócios, a videochamada), sem a imagem.
  checked_at           timestamptz,
  checked_by           text check (checked_by is null or length(checked_by) between 2 and 120),
  checks               jsonb check (checks is null or jsonb_typeof(checks) = 'object'),
  -- Quando o app antigo deixa de valer, se nada mudar (a conferência + 7 dias).
  applies_at           timestamptz,
  refusal_reason       text check (refusal_reason is null or length(refusal_reason) between 3 and 500),
  cancelled_by         text check (cancelled_by is null or cancelled_by in ('voce', 'entrou')),
  closed_at            timestamptz,
  -- Um Administrador de uma empresa da pessoa não reconheceu o pedido e o parou (D-A7-64; a tela chega na parte 4b).
  stopped_at           timestamptz,
  stopped_by_user_id   uuid references liame.app_user (id) on delete set null,
  stopped_tenant_id    uuid references liame.organization (id) on delete set null,
  -- A última situação já avisada por e-mail: o que muda fora da API (a DMS pelo comando, a espera que vence) o worker
  -- avisa depois (parte 4b).
  notified_status      text check (notified_status is null or notified_status in ('pedido', 'conferido', 'parado', 'aplicado', 'recusado', 'cancelado')),
  -- Os documentos saem 30 dias depois da decisão (D-A7-64): a conferência, a recusa ou o cancelamento.
  documents_expire_at  timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint account_recovery_fechado check ((status in ('aplicado', 'recusado', 'cancelado')) = (closed_at is not null)),
  constraint account_recovery_espera check (status <> 'conferido' or (applies_at is not null and checked_at is not null)),
  constraint account_recovery_recusa check ((status = 'recusado') = (refusal_reason is not null)),
  constraint account_recovery_cancelamento check ((status = 'cancelado') = (cancelled_by is not null))
);
create unique index if not exists uq_account_recovery_protocol on liame.account_recovery (protocol);
-- Um pedido em andamento por pessoa.
create unique index if not exists uq_account_recovery_aberto on liame.account_recovery (user_id) where status in ('pedido', 'conferido', 'parado');
create index if not exists idx_account_recovery_user on liame.account_recovery (user_id, created_at desc);
create index if not exists idx_account_recovery_espera on liame.account_recovery (applies_at) where status = 'conferido';
create index if not exists idx_account_recovery_documentos on liame.account_recovery (documents_expire_at) where documents_expire_at is not null;
drop trigger if exists tg_account_recovery_touch on liame.account_recovery;
create trigger tg_account_recovery_touch before update on liame.account_recovery for each row execute function liame.touch_updated_at();

-- A pessoa lê e grava só os próprios pedidos; a DMS (comando da distribuição) e o worker, no escopo de sistema.
alter table liame.account_recovery enable row level security;
alter table liame.account_recovery force row level security;
drop policy if exists account_recovery_propria on liame.account_recovery;
create policy account_recovery_propria on liame.account_recovery
  using (user_id = liame.current_user_id() or liame.system_scope())
  with check (user_id = liame.current_user_id() or liame.system_scope());
-- Na espera, a empresa de que a pessoa é a dona vê o pedido e pode pará-lo (o aviso aos Administradores, parte 4b; o
-- serviço confere o nível de quem para).
drop policy if exists account_recovery_da_empresa on liame.account_recovery;
create policy account_recovery_da_empresa on liame.account_recovery for select
  using (exists (select 1 from liame.membership m
                  where m.user_id = account_recovery.user_id and m.tenant_id = liame.current_tenant_id()
                    and m.role_key = 'dono' and m.revoked_at is null));
drop policy if exists account_recovery_para on liame.account_recovery;
create policy account_recovery_para on liame.account_recovery for update
  using (exists (select 1 from liame.membership m
                  where m.user_id = account_recovery.user_id and m.tenant_id = liame.current_tenant_id()
                    and m.role_key = 'dono' and m.revoked_at is null))
  with check (exists (select 1 from liame.membership m
                       where m.user_id = account_recovery.user_id and m.tenant_id = liame.current_tenant_id()
                         and m.role_key = 'dono' and m.revoked_at is null));
grant select, insert, update on liame.account_recovery to liame_app;

create table if not exists liame.account_recovery_document (
  id            uuid primary key,
  recovery_id   uuid not null references liame.account_recovery (id) on delete cascade,
  kind          text not null default 'documento_com_foto' check (kind in ('documento_com_foto')),
  media_type    text not null check (media_type in ('image/jpeg', 'image/png', 'application/pdf')),
  size_bytes    integer not null check (size_bytes between 1 and 10485760),
  -- O lacre (D-A7-85): o arquivo cifrado com AES-256-GCM, e a chave dele cifrada com a chave pública da DMS (RSA-OAEP,
  -- SHA-256). `key_id` é a impressão digital da chave pública, para o comando saber qual chave privada abre.
  key_id        text not null check (key_id ~ '^[0-9a-f]{16}$'),
  wrapped_key   bytea not null,
  iv            bytea not null check (length(iv) = 12),
  tag           bytea not null check (length(tag) = 16),
  ciphertext    bytea not null,
  created_at    timestamptz not null default now()
);
create index if not exists idx_account_recovery_document_pedido on liame.account_recovery_document (recovery_id);

-- O app grava o documento do próprio pedido e nunca o lê de volta: ler e apagar, só no escopo de sistema (o comando da
-- DMS e o expurgo).
alter table liame.account_recovery_document enable row level security;
alter table liame.account_recovery_document force row level security;
drop policy if exists account_recovery_document_grava on liame.account_recovery_document;
create policy account_recovery_document_grava on liame.account_recovery_document for insert
  with check (
    liame.system_scope()
    or exists (select 1 from liame.account_recovery r where r.id = recovery_id and r.user_id = liame.current_user_id())
  );
drop policy if exists account_recovery_document_le on liame.account_recovery_document;
create policy account_recovery_document_le on liame.account_recovery_document for select using (liame.system_scope());
drop policy if exists account_recovery_document_apaga on liame.account_recovery_document;
create policy account_recovery_document_apaga on liame.account_recovery_document for delete using (liame.system_scope());
grant select, insert, delete on liame.account_recovery_document to liame_app;

-- Conferência no mesmo arquivo (ADR-018): as duas tabelas, a RLS forçada e o índice de um pedido por pessoa.
do $$
begin
  if (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'liame' and c.relname in ('account_recovery', 'account_recovery_document')
         and c.relrowsecurity and c.relforcerowsecurity) <> 2 then
    raise exception '0106: as tabelas da recuperação sem a RLS forçada';
  end if;
  if not exists (select 1 from pg_indexes where schemaname = 'liame' and indexname = 'uq_account_recovery_aberto') then
    raise exception '0106: falta o índice de um pedido por pessoa';
  end if;
end $$;
