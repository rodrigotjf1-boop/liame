-- 0097 · O resumo da semana do que cada pessoa fez na conta, por e-mail ao Dono (A7, W8; ADR-017; `plano-a7.md`
-- D-A7-53). Toda segunda-feira, a partir das 8h no fuso da empresa, o Dono recebe as contagens, por pessoa e por grupo,
-- do que cada pessoa além dele fez na semana que fechou no domingo (lidas na auditoria), sem o conteúdo de nenhuma
-- ação. Esta tabela guarda cada entrega: a semana, o Dono, a situação (enviando, enviado, falhou ou sem_atividade, a
-- semana em que ninguém além dele fez nada), as tentativas e o tipo do erro, **sem o endereço nem o texto**. Uma por
-- empresa, semana e Dono. Nada usa esta tabela enquanto a função `resumo_das_pessoas` estiver desligada.
-- Idempotente; uma transação por arquivo (ADR-018).

-- A semente da flag grava em tabela com RLS forçada (V20).
select set_config('app.scope', 'sistema', true);

create table if not exists liame.people_digest (
  id          uuid primary key,
  tenant_id   uuid not null references liame.organization (id) on delete cascade,
  -- A segunda-feira da semana do resumo (no calendário da empresa).
  week_start  date not null,
  -- O Dono que recebe.
  user_id     uuid not null references liame.app_user (id) on delete cascade,
  -- `enviando`: reservada por uma volta da rotina (a que caiu no meio é retomada depois de um tempo); `enviado`;
  -- `falhou` (tenta de novo até o limite de tentativas); `sem_atividade`: ninguém além do Dono fez nada, e nada sai.
  status      text not null check (status in ('enviando', 'enviado', 'falhou', 'sem_atividade')),
  attempts    integer not null default 1 check (attempts between 1 and 10),
  -- O tipo do erro do envio (o nome da exceção), nunca o endereço nem a mensagem do provedor.
  error       text check (error is null or length(error) between 1 and 100),
  claimed_at  timestamptz not null,
  sent_at     timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  -- Uma entrega por empresa, semana e Dono.
  constraint people_digest_uma_vez unique (tenant_id, week_start, user_id),
  -- A semana começa na segunda-feira.
  constraint people_digest_segunda check (extract(isodow from week_start) = 1),
  -- A enviada tem a hora em que saiu; as outras, não.
  constraint people_digest_enviado check ((status = 'enviado') = (sent_at is not null))
);
create index if not exists idx_people_digest_user on liame.people_digest (user_id);

alter table liame.people_digest enable row level security;
alter table liame.people_digest force row level security;
drop policy if exists people_digest_isolamento on liame.people_digest;
create policy people_digest_isolamento on liame.people_digest
  using (tenant_id = liame.current_tenant_id() or liame.system_scope())
  with check (tenant_id = liame.current_tenant_id() or liame.system_scope());
grant select, insert, update on liame.people_digest to liame_app;

-- ------------------------------------------------------------ a função

-- Liga, por empresa, o resumo da semana ao Dono. Nasce desligada.
insert into liame.feature_flag (key, kind, default_value, description, owner, is_write)
values ('resumo_das_pessoas', 'boolean', 'false', 'Pessoas e acessos: o resumo da semana, por e-mail ao Dono, do que cada pessoa além dele fez na conta (as contagens por grupo, sem o conteúdo), toda segunda-feira (A7, W8; ADR-017)', 'acesso', false)
on conflict (key) do nothing;
