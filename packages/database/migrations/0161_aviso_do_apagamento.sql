-- 0161 · O fim da assinatura, parte 4b: o aviso do apagamento por e-mail (A7, W3; Termos 11.2; `plano-a7.md` D-A7-106 e
-- D-A7-107). Apagar não tem volta: 7 dias antes e na véspera do dia do apagamento, quem paga (o Dono e o Administrador com
-- a cobrança liberada) recebe um e-mail. Vale para a assinatura paga que terminou (o dia gravado no fim, `purge_on`) e para
-- a que segue em atraso (o 60º dia de atraso da mensalidade mais antiga em aberto, quando ela termina e os dados saem no
-- mesmo dia). Esta tabela guarda cada entrega: a assinatura, o dia do apagamento de que o aviso fala, o aviso (7 ou 1), a
-- pessoa, a situação (enviando, enviado ou falhou), as tentativas e o tipo do erro, **sem o endereço nem o texto**. Uma
-- por assinatura, dia do apagamento, aviso e pessoa: a rotina que roda de novo não manda em dobro, e a que caiu no meio
-- volta a tentar; o dia que muda (pagou parte do atraso) é outro aviso. Nada usa esta tabela enquanto a função `cobranca`
-- estiver desligada. Das empresas. Idempotente; uma transação por arquivo (ADR-018).

create table if not exists liame.subscription_purge_notice (
  id               uuid primary key,
  tenant_id        uuid not null references liame.organization (id) on delete cascade,
  subscription_id  uuid not null references liame.subscription (id) on delete cascade,
  -- O dia do apagamento de que o aviso fala (calendário da empresa).
  purge_on         date not null,
  -- O aviso: 7 (dias antes) ou 1 (a véspera).
  day              smallint not null check (day in (7, 1)),
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
  -- Uma entrega por assinatura, dia do apagamento, aviso e pessoa.
  constraint subscription_purge_notice_uma_vez unique (subscription_id, purge_on, day, user_id),
  -- A enviada tem a hora em que saiu; as outras, não.
  constraint subscription_purge_notice_enviado check ((status = 'enviado') = (sent_at is not null))
);
create index if not exists idx_subscription_purge_notice_tenant on liame.subscription_purge_notice (tenant_id);

alter table liame.subscription_purge_notice enable row level security;
alter table liame.subscription_purge_notice force row level security;
drop policy if exists subscription_purge_notice_isolamento on liame.subscription_purge_notice;
create policy subscription_purge_notice_isolamento on liame.subscription_purge_notice
  using (tenant_id = liame.current_tenant_id() or liame.system_scope())
  with check (tenant_id = liame.current_tenant_id() or liame.system_scope());
grant select, insert, update on liame.subscription_purge_notice to liame_app;

-- ------------------------------------------------------------ conferência

do $$ begin
  if to_regclass('liame.subscription_purge_notice') is null then
    raise exception '0161: a tabela do aviso do apagamento não entrou';
  end if;
  if not exists (select 1 from pg_class where oid = 'liame.subscription_purge_notice'::regclass and relrowsecurity and relforcerowsecurity) then
    raise exception '0161: a tabela do aviso do apagamento ficou sem a RLS forçada';
  end if;
  if (select count(*) from pg_constraint
       where conrelid = 'liame.subscription_purge_notice'::regclass
         and conname in ('subscription_purge_notice_uma_vez', 'subscription_purge_notice_enviado')) <> 2 then
    raise exception '0161: as regras do aviso do apagamento não entraram';
  end if;
end $$;
