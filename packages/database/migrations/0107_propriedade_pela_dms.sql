-- 0107 · A propriedade pedida à DMS quando o Dono não está mais (A7, W8, parte 6a; P34; D-A7-63, D-A7-64; D-A7-86): um
-- Administrador da empresa pede a propriedade à DMS, com o documento com foto e o documento da empresa que mostra quem a
-- representa (contrato social, alteração ou certidão da Junta). A DMS confere; o Dono é avisado no e-mail dele e há 14
-- dias de espera; se ele responder ("Ainda cuido da conta"), a DMS fala com os dois antes de decidir. Aprovado, quem
-- pediu vira a dona, e o acesso do Dono antigo sai. Os documentos vão lacrados com a chave pública da DMS, como na
-- recuperação (0106). Idempotente; uma transação por arquivo (ADR-018).

create sequence if not exists liame.ownership_claim_numero;
grant usage on sequence liame.ownership_claim_numero to liame_app;

create table if not exists liame.ownership_claim (
  id                   uuid primary key,
  tenant_id            uuid not null references liame.organization (id) on delete cascade,
  requester_user_id    uuid not null references liame.app_user (id) on delete cascade,
  -- O Dono quando o pedido foi feito (a aprovação confere que ainda é ele).
  owner_user_id        uuid references liame.app_user (id) on delete set null,
  -- O protocolo que a pessoa e a DMS citam, como PROP-2026-0007.
  protocol             text not null check (protocol ~ '^PROP-[0-9]{4}-[0-9]{4,}$'),
  reason               text not null check (reason in ('saiu_da_sociedade', 'faleceu', 'perdeu_acesso')),
  note                 text check (note is null or length(note) between 1 and 600),
  -- A versão dos Termos que quem pede aceitou como dona, se a DMS aprovar.
  terms_version        text not null check (length(terms_version) between 1 and 60),
  -- rascunho (falta documento) → pedido → conferido (a espera de 14 dias, até decide_from) → aprovado; contestado (o
  -- Dono respondeu: a DMS fala com os dois); recusado (pela DMS, com o motivo); cancelado (por quem pediu).
  status               text not null default 'rascunho'
                       check (status in ('rascunho', 'pedido', 'conferido', 'contestado', 'aprovado', 'recusado', 'cancelado')),
  -- Os documentos já enviados (o app não lê a tabela dos documentos; a tela precisa saber o que falta).
  documents            text[] not null default '{}'::text[]
                       check (documents <@ array['documento_com_foto', 'documento_da_empresa']::text[]),
  checked_at           timestamptz,
  checked_by           text check (checked_by is null or length(checked_by) between 2 and 120),
  checks               jsonb check (checks is null or jsonb_typeof(checks) = 'object'),
  -- A partir de quando a DMS pode aprovar (a conferência + 14 dias).
  decide_from          timestamptz,
  contested_at         timestamptz,
  refusal_reason       text check (refusal_reason is null or length(refusal_reason) between 3 and 500),
  sent_at              timestamptz,
  closed_at            timestamptz,
  -- A última situação já avisada por e-mail (o que muda fora da API, o worker avisa).
  notified_status      text check (notified_status is null
                                   or notified_status in ('rascunho', 'pedido', 'conferido', 'contestado', 'aprovado', 'recusado', 'cancelado')),
  -- Os documentos saem 30 dias depois da decisão (D-A7-64).
  documents_expire_at  timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint ownership_claim_fechado check ((status in ('aprovado', 'recusado', 'cancelado')) = (closed_at is not null)),
  constraint ownership_claim_espera check (status not in ('conferido', 'contestado') or (decide_from is not null and checked_at is not null)),
  constraint ownership_claim_recusa check ((status = 'recusado') = (refusal_reason is not null)),
  constraint ownership_claim_enviado check ((status = 'rascunho') = (sent_at is null) or status = 'cancelado')
);
create unique index if not exists uq_ownership_claim_protocol on liame.ownership_claim (protocol);
-- Um pedido em andamento por empresa (o rascunho conta).
create unique index if not exists uq_ownership_claim_aberto on liame.ownership_claim (tenant_id)
  where status in ('rascunho', 'pedido', 'conferido', 'contestado');
create index if not exists idx_ownership_claim_tenant on liame.ownership_claim (tenant_id, created_at desc);
create index if not exists idx_ownership_claim_quem on liame.ownership_claim (requester_user_id);
create index if not exists idx_ownership_claim_documentos on liame.ownership_claim (documents_expire_at) where documents_expire_at is not null;
drop trigger if exists tg_ownership_claim_touch on liame.ownership_claim;
create trigger tg_ownership_claim_touch before update on liame.ownership_claim for each row execute function liame.touch_updated_at();

-- A empresa lê e grava os pedidos dela (quem pede e o Dono estão na empresa e agem com ela ativa); a DMS (comando da
-- distribuição) e o worker, no escopo de sistema.
alter table liame.ownership_claim enable row level security;
alter table liame.ownership_claim force row level security;
drop policy if exists ownership_claim_isolamento on liame.ownership_claim;
create policy ownership_claim_isolamento on liame.ownership_claim
  using (tenant_id = liame.current_tenant_id() or liame.system_scope())
  with check (tenant_id = liame.current_tenant_id() or liame.system_scope());
grant select, insert, update, delete on liame.ownership_claim to liame_app;

create table if not exists liame.ownership_claim_document (
  id            uuid primary key,
  claim_id      uuid not null references liame.ownership_claim (id) on delete cascade,
  kind          text not null check (kind in ('documento_com_foto', 'documento_da_empresa')),
  media_type    text not null check (media_type in ('image/jpeg', 'image/png', 'application/pdf')),
  size_bytes    integer not null check (size_bytes between 1 and 10485760),
  -- O lacre (D-A7-85): o arquivo em AES-256-GCM, a chave dele em RSA-OAEP com a chave pública da DMS.
  key_id        text not null check (key_id ~ '^[0-9a-f]{16}$'),
  wrapped_key   bytea not null,
  iv            bytea not null check (length(iv) = 12),
  tag           bytea not null check (length(tag) = 16),
  ciphertext    bytea not null,
  created_at    timestamptz not null default now()
);
-- Um documento de cada tipo por pedido (mandar de novo troca o anterior, ainda no rascunho).
create unique index if not exists uq_ownership_claim_document_tipo on liame.ownership_claim_document (claim_id, kind);

-- O app grava e troca o documento do rascunho da própria empresa e nunca lê o conteúdo de volta: a leitura do app é por
-- coluna (qual documento é, o tipo e o tamanho), e só no rascunho da empresa ativa; o conteúdo lacrado, só o dono do
-- banco (o comando da DMS). Trocar precisa enxergar a linha: o `delete` passa também pela política de leitura.
alter table liame.ownership_claim_document enable row level security;
alter table liame.ownership_claim_document force row level security;
drop policy if exists ownership_claim_document_grava on liame.ownership_claim_document;
create policy ownership_claim_document_grava on liame.ownership_claim_document for insert
  with check (
    liame.system_scope()
    or exists (select 1 from liame.ownership_claim c
                where c.id = claim_id and c.tenant_id = liame.current_tenant_id() and c.status = 'rascunho')
  );
drop policy if exists ownership_claim_document_troca on liame.ownership_claim_document;
create policy ownership_claim_document_troca on liame.ownership_claim_document for delete
  using (
    liame.system_scope()
    or exists (select 1 from liame.ownership_claim c
                where c.id = claim_id and c.tenant_id = liame.current_tenant_id() and c.status = 'rascunho')
  );
drop policy if exists ownership_claim_document_le on liame.ownership_claim_document;
create policy ownership_claim_document_le on liame.ownership_claim_document for select
  using (
    liame.system_scope()
    or exists (select 1 from liame.ownership_claim c
                where c.id = claim_id and c.tenant_id = liame.current_tenant_id() and c.status = 'rascunho')
  );
revoke select on liame.ownership_claim_document from liame_app;
grant select (id, claim_id, kind, media_type, size_bytes, created_at) on liame.ownership_claim_document to liame_app;
grant insert, delete on liame.ownership_claim_document to liame_app;

-- Conferência no mesmo arquivo (ADR-018): as duas tabelas com a RLS forçada e o índice de um pedido por empresa.
do $$
begin
  if (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'liame' and c.relname in ('ownership_claim', 'ownership_claim_document')
         and c.relrowsecurity and c.relforcerowsecurity) <> 2 then
    raise exception '0107: as tabelas da propriedade pela DMS sem a RLS forçada';
  end if;
  if not exists (select 1 from pg_indexes where schemaname = 'liame' and indexname = 'uq_ownership_claim_aberto') then
    raise exception '0107: falta o índice de um pedido por empresa';
  end if;
  if has_column_privilege('liame_app', 'liame.ownership_claim_document', 'ciphertext', 'select')
     or has_column_privilege('liame_app', 'liame.ownership_claim_document', 'wrapped_key', 'select') then
    raise exception '0107: o app não pode ler o conteúdo lacrado dos documentos';
  end if;
end $$;
