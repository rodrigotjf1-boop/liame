-- 0095 · A cobrança, W3, parte 2: o aviso do atraso por e-mail (A7; `plano-a7.md` D-A7-15 e D-A7-39; Termos 10.4).
-- Quem paga (o Dono e o Administrador com a cobrança liberada) recebe um e-mail no 1º, no 7º, no 10º e no 30º dia de
-- atraso da mensalidade mais antiga em aberto de uma marca. Esta tabela guarda cada entrega: a fatura, o dia do aviso, a
-- pessoa, a situação (enviando, enviado ou falhou), as tentativas e o tipo do erro, **sem o endereço nem o texto**. Uma
-- por fatura, dia e pessoa: a rotina que roda de novo não manda em dobro, e a que caiu no meio volta a tentar. Nada usa
-- esta tabela enquanto a função `cobranca` estiver desligada. Idempotente; uma transação por arquivo (ADR-018).

create table if not exists liame.billing_notice (
  id               uuid primary key,
  tenant_id        uuid not null references liame.organization (id) on delete cascade,
  subscription_id  uuid not null references liame.subscription (id) on delete cascade,
  -- A mensalidade em atraso de que o aviso fala (a mais antiga em aberto, quando ele saiu).
  invoice_id       uuid not null references liame.billing_invoice (id) on delete cascade,
  -- O dia de atraso do aviso: 1, 7, 10 (as ações param) ou 30 (a conta é suspensa).
  day              smallint not null check (day in (1, 7, 10, 30)),
  user_id          uuid not null references liame.app_user (id) on delete cascade,
  -- `enviando`: reservada por uma volta da rotina (a que caiu no meio é retomada depois de um tempo); `enviado`;
  -- `falhou` (tenta de novo até o limite de tentativas).
  status           text not null check (status in ('enviando', 'enviado', 'falhou')),
  attempts         integer not null default 1 check (attempts between 1 and 10),
  -- O tipo do erro do envio (o nome da exceção), nunca o endereço nem a mensagem do provedor.
  error            text check (error is null or length(error) between 1 and 100),
  claimed_at       timestamptz not null,
  sent_at          timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  -- Uma entrega por fatura, dia e pessoa.
  constraint billing_notice_uma_vez unique (invoice_id, day, user_id),
  -- A enviada tem a hora em que saiu; as outras, não.
  constraint billing_notice_enviado check ((status = 'enviado') = (sent_at is not null))
);
create index if not exists idx_billing_notice_tenant on liame.billing_notice (tenant_id);
create index if not exists idx_billing_notice_subscription on liame.billing_notice (subscription_id);

alter table liame.billing_notice enable row level security;
alter table liame.billing_notice force row level security;
drop policy if exists billing_notice_isolamento on liame.billing_notice;
create policy billing_notice_isolamento on liame.billing_notice
  using (tenant_id = liame.current_tenant_id() or liame.system_scope())
  with check (tenant_id = liame.current_tenant_id() or liame.system_scope());
grant select, insert, update on liame.billing_notice to liame_app;
