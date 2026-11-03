-- 0112 · Os Termos novos, parte 14c: os e-mails do aviso, do lembrete e da retirada (A7, W14; P35; D-A7-90; D-A7-103).
-- No dia em que a versão relevante é avisada, um e-mail para cada pessoa com acesso ativo e e-mail confirmado; 7 dias
-- antes do dia, um lembrete só para quem ainda não aceitou; e, se a versão for retirada antes do dia, um e-mail para quem
-- tinha recebido o aviso. Esta tabela guarda cada entrega: a versão, o tipo, a pessoa, a situação (enviando, enviado ou
-- falhou), as tentativas e o tipo do erro, **sem o endereço nem o texto**. Uma por versão, tipo e pessoa: a rotina que
-- roda de novo não manda em dobro, e a que caiu no meio volta a tentar. Nada usa esta tabela enquanto a função
-- `termos_novos` estiver desligada. Idempotente; uma transação por arquivo (ADR-018).

create table if not exists liame.terms_notice (
  id          uuid primary key,
  version     text not null references liame.terms_version (version),
  kind        text not null check (kind in ('aviso', 'lembrete', 'retirada')),
  user_id     uuid not null references liame.app_user (id) on delete cascade,
  -- `enviando`: reservada por uma volta da rotina (a que caiu no meio é retomada depois de um tempo); `enviado`;
  -- `falhou` (tenta de novo até o limite de tentativas).
  status      text not null check (status in ('enviando', 'enviado', 'falhou')),
  attempts    integer not null default 1 check (attempts between 1 and 10),
  -- O tipo do erro do envio (o nome da exceção), nunca o endereço nem a mensagem do provedor.
  error       text check (error is null or length(error) between 1 and 100),
  claimed_at  timestamptz not null,
  sent_at     timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  -- Uma entrega por versão, tipo e pessoa.
  constraint terms_notice_uma_vez unique (version, kind, user_id),
  -- A enviada tem a hora em que saiu; as outras, não.
  constraint terms_notice_enviado check ((status = 'enviado') = (sent_at is not null))
);
create index if not exists idx_terms_notice_pessoa on liame.terms_notice (user_id);

-- Da distribuição (como as versões): só o worker, no escopo de sistema.
alter table liame.terms_notice enable row level security;
alter table liame.terms_notice force row level security;
drop policy if exists terms_notice_sistema on liame.terms_notice;
create policy terms_notice_sistema on liame.terms_notice using (liame.system_scope()) with check (liame.system_scope());
grant select, insert, update on liame.terms_notice to liame_app;

-- Conferência no mesmo arquivo (ADR-018).
do $$
begin
  if not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                  where n.nspname = 'liame' and c.relname = 'terms_notice' and c.relrowsecurity and c.relforcerowsecurity) then
    raise exception '0112: a tabela das entregas dos Termos sem a RLS forçada';
  end if;
end $$;
