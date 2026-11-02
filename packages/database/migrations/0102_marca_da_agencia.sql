-- 0102 · A marca da agência (A7, W7, parte 3; D-A7-69; D-A7-81): o logo que os clientes da agência veem no relatório
-- do mês e no e-mail dele, o e-mail de resposta (que só vale depois do link de confirmação) e como o relatório do mês
-- sai (a agência revisa e manda, ou ele sai sozinho no dia 2). O nome é o da própria organização da agência.
-- Idempotente; uma transação por arquivo (ADR-018).

-- Uma linha por agência, criada na primeira vez que ela salva a marca. O logo fica no armazenamento de imagens
-- (ADR-021), regravado pelo servidor em JPEG sobre fundo branco, na chave `t/{agência}/agencia/logo/{logo_id}.jpg`;
-- `logo_id` muda a cada logo novo. O e-mail de resposta novo fica pendente, com o hash do link de confirmação, até a
-- pessoa daquele endereço confirmar: só então ele passa a valer no "Responder" do relatório.
create table if not exists liame.agency_brand (
  tenant_id             uuid primary key references liame.organization (id) on delete cascade,
  logo_id               uuid,
  logo_width            integer check (logo_width between 1 and 4096),
  logo_height           integer check (logo_height between 1 and 4096),
  logo_updated_at       timestamptz,
  reply_to_email        text check (reply_to_email = lower(reply_to_email) and position('@' in reply_to_email) > 1),
  reply_to_confirmed_at timestamptz,
  pending_reply_to      text check (pending_reply_to = lower(pending_reply_to) and position('@' in pending_reply_to) > 1),
  pending_token_hash    text,
  pending_expires_at    timestamptz,
  pending_requested_by  uuid references liame.app_user (id) on delete set null,
  -- `revisar`: o relatório do mês espera a agência (com o lembrete do dia 3); `sozinho`: sai no dia 2, às 9h (D-A7-67).
  report_mode           text not null default 'revisar' check (report_mode in ('revisar', 'sozinho')),
  updated_by            uuid references liame.app_user (id) on delete set null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint agency_brand_logo_check
    check ((logo_id is null) = (logo_updated_at is null) and (logo_id is null) = (logo_width is null) and (logo_id is null) = (logo_height is null)),
  constraint agency_brand_resposta_check check ((reply_to_email is null) = (reply_to_confirmed_at is null)),
  constraint agency_brand_pendente_check
    check ((pending_reply_to is null) = (pending_token_hash is null) and (pending_reply_to is null) = (pending_expires_at is null))
);
-- O link de confirmação acha a agência pelo hash, sem saber de quem é.
create unique index if not exists uq_agency_brand_link on liame.agency_brand (pending_token_hash) where pending_token_hash is not null;
create index if not exists idx_agency_brand_quem_pediu on liame.agency_brand (pending_requested_by) where pending_requested_by is not null;
create index if not exists idx_agency_brand_quem_mudou on liame.agency_brand (updated_by) where updated_by is not null;
drop trigger if exists tg_agency_brand_touch on liame.agency_brand;
create trigger tg_agency_brand_touch before update on liame.agency_brand for each row execute function liame.touch_updated_at();

-- Só a agência lê e grava a própria marca. O link de confirmação (rota pública) e o relatório que o cliente recebe leem
-- pelo escopo de sistema, só o que precisam.
alter table liame.agency_brand enable row level security;
alter table liame.agency_brand force row level security;
drop policy if exists agency_brand_isolamento on liame.agency_brand;
create policy agency_brand_isolamento on liame.agency_brand
  using (tenant_id = liame.current_tenant_id() or liame.system_scope())
  with check (tenant_id = liame.current_tenant_id() or liame.system_scope());
grant select, insert, update on liame.agency_brand to liame_app;
