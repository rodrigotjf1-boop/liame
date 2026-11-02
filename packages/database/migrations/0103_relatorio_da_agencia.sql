-- 0103 · O relatório do mês que a agência manda ao cliente (A7, W7, parte 4a; D-A7-65 a D-A7-68; D-A7-82): cada envio
-- (a versão, o comentário assinado por quem mandou, como saiu) e cada entrega a uma pessoa da empresa. O relatório é o
-- do mês, o mesmo que o Dono vê (0078); a agência não muda os números. Quem recebeu o da agência não recebe o e-mail
-- do Liame daquele mês (o worker confere as entregas daqui).
-- Idempotente; uma transação por arquivo (ADR-018).

-- ------------------------------------------------------------ cada envio
-- `tenant_id` é a empresa (o cliente); `agency_id`, a agência que mandou, pelo vínculo. Mandar de novo cria a versão
-- seguinte do mesmo relatório (o e-mail diz que é uma versão corrigida). `sozinho`: saiu no dia 2, sem comentário e
-- sem quem assina (parte 4b).
create table if not exists liame.agency_report_send (
  id               uuid primary key,
  tenant_id        uuid not null references liame.organization (id) on delete cascade,
  agency_id        uuid not null references liame.organization (id) on delete cascade,
  partner_link_id  uuid not null references liame.partner_link (id) on delete cascade,
  report_id        uuid not null references liame.monthly_report (id) on delete cascade,
  version          integer not null check (version >= 1),
  mode             text not null check (mode in ('manual', 'sozinho')),
  comment          text check (comment is null or length(comment) between 1 and 1000),
  sent_by          uuid references liame.app_user (id) on delete set null,
  -- A assinatura como saiu no e-mail ("Juliana Prado"), para a tela mostrar o mesmo nome mesmo que a pessoa saia depois.
  sent_by_name     text check (sent_by_name is null or length(sent_by_name) between 1 and 200),
  recipients       integer not null default 0 check (recipients >= 0),
  -- A agência tinha logo quando mandou: o relatório que o Dono lê mostra o endereço público dele.
  with_logo        boolean not null default false,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint agency_report_send_versao unique (report_id, agency_id, version),
  constraint agency_report_send_quem check ((mode = 'manual') = (sent_by_name is not null)),
  constraint agency_report_send_sozinho check (mode = 'manual' or comment is null),
  constraint agency_report_send_outra_org check (agency_id <> tenant_id)
);
create index if not exists idx_agency_report_send_tenant on liame.agency_report_send (tenant_id, created_at desc);
create index if not exists idx_agency_report_send_agencia on liame.agency_report_send (agency_id, created_at desc);
create index if not exists idx_agency_report_send_vinculo on liame.agency_report_send (partner_link_id);
create index if not exists idx_agency_report_send_quem on liame.agency_report_send (sent_by) where sent_by is not null;
drop trigger if exists tg_agency_report_send_touch on liame.agency_report_send;
create trigger tg_agency_report_send_touch before update on liame.agency_report_send for each row execute function liame.touch_updated_at();

-- ------------------------------------------------------------ cada entrega
-- Uma linha por pessoa e envio, como as do e-mail do Liame (0078): o resultado gravado (enviado, falhou com o tipo do
-- erro) e nunca o endereço. `pendente`: gravada com o envio, antes de o e-mail sair.
create table if not exists liame.agency_report_delivery (
  id          uuid primary key,
  tenant_id   uuid not null references liame.organization (id) on delete cascade,
  send_id     uuid not null references liame.agency_report_send (id) on delete cascade,
  user_id     uuid not null references liame.app_user (id) on delete cascade,
  -- O nível da pessoa na empresa na hora do envio (`dono`, `administrador`, `so_relatorios`).
  role_key    text not null check (role_key ~ '^[a-z][a-z0-9_]{1,40}$'),
  status      text not null default 'pendente' check (status in ('pendente', 'enviado', 'falhou')),
  attempts    integer not null default 0 check (attempts >= 0),
  error       text check (length(error) between 1 and 300),
  sent_at     timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint agency_report_delivery_enviado check ((status = 'enviado') = (sent_at is not null)),
  constraint agency_report_delivery_uma_por_pessoa unique (send_id, user_id)
);
create index if not exists idx_agency_report_delivery_tenant on liame.agency_report_delivery (tenant_id);
create index if not exists idx_agency_report_delivery_pessoa on liame.agency_report_delivery (user_id);
create index if not exists idx_agency_report_delivery_pendente on liame.agency_report_delivery (created_at) where status = 'pendente';
drop trigger if exists tg_agency_report_delivery_touch on liame.agency_report_delivery;
create trigger tg_agency_report_delivery_touch before update on liame.agency_report_delivery for each row execute function liame.touch_updated_at();

-- ------------------------------------------------------------ RLS dos dois lados
-- A empresa vê o que a agência mandou a ela (o Dono lê o relatório com o comentário); a agência vê e grava os envios
-- dela. A entrega segue o envio.
alter table liame.agency_report_send enable row level security;
alter table liame.agency_report_send force row level security;
drop policy if exists agency_report_send_isolamento on liame.agency_report_send;
create policy agency_report_send_isolamento on liame.agency_report_send
  using (tenant_id = liame.current_tenant_id() or agency_id = liame.current_tenant_id() or liame.system_scope())
  with check (tenant_id = liame.current_tenant_id() or agency_id = liame.current_tenant_id() or liame.system_scope());
grant select, insert, update on liame.agency_report_send to liame_app;

alter table liame.agency_report_delivery enable row level security;
alter table liame.agency_report_delivery force row level security;
drop policy if exists agency_report_delivery_isolamento on liame.agency_report_delivery;
create policy agency_report_delivery_isolamento on liame.agency_report_delivery
  using (
    tenant_id = liame.current_tenant_id()
    or liame.system_scope()
    or exists (select 1 from liame.agency_report_send s where s.id = agency_report_delivery.send_id and s.agency_id = liame.current_tenant_id())
  )
  with check (
    tenant_id = liame.current_tenant_id()
    or liame.system_scope()
    or exists (select 1 from liame.agency_report_send s where s.id = agency_report_delivery.send_id and s.agency_id = liame.current_tenant_id())
  );
grant select, insert, update on liame.agency_report_delivery to liame_app;
