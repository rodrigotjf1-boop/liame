-- 0032 · Revisão da semana (A3, I7; protótipo P4 aprovado em 02/10/2026).
-- Toda segunda-feira de manhã, no fuso da loja, o worker fecha a semana que terminou no domingo: os números
-- do ciclo fechado, o que mudou sobre a semana anterior, o que precisa de decisão e a leitura (da LIA ou,
-- sem ela, do sistema). A revisão fica guardada como foi gerada: a tela e o e-mail mostram os mesmos
-- números, mesmo que a plataforma reveja os dela depois. Quem grava é o worker, em escopo de sistema; a
-- empresa só lê o que é dela. O envio por e-mail nasce desligado para todos (flag `revisao_email`).
-- Nenhuma tabela aqui tem dado de cliente da loja. Idempotente; uma transação por arquivo (ADR-018).

-- A semente da flag grava em tabela com RLS forçada (V20).
select set_config('app.scope', 'sistema', true);

-- ------------------------------------------------------------ a revisão

create table if not exists liame.weekly_review (
  id                uuid primary key,
  tenant_id         uuid not null references liame.organization (id) on delete cascade,
  brand_id          uuid not null references liame.brand (id) on delete cascade,
  -- A semana da loja, de segunda a domingo, no fuso dela.
  week_from         date not null,
  week_to           date not null,
  timezone          text not null check (length(timezone) between 3 and 64),
  generated_at      timestamptz not null,
  -- Quem escreveu a leitura da semana e, quando foi o sistema, por quê (`desligada`, `dado_velho`, `teto`…).
  reading_source    text not null check (reading_source in ('lia', 'sistema')),
  reading_reason    text check (reading_reason ~ '^[a-z][a-z0-9_]{1,40}$'),
  -- A chamada que gerou a leitura da LIA: é a ela que o retorno da pessoa ("Fez sentido", "Discordo") se liga.
  usage_id          uuid references liame.ai_usage (id) on delete set null,
  -- A revisão como a tela e o e-mail mostram (contrato `WeeklyReview`), na versão em que foi gerada.
  content           jsonb not null check (jsonb_typeof(content) = 'object'),
  content_version   integer not null check (content_version >= 1),
  -- O envio por e-mail. `pendente`: espera a hora de enviar (ou a próxima tentativa); `enviado`: chegou a
  -- pelo menos uma pessoa; `desligado`: a empresa não tem o envio ligado; `sem_destinatario`: ninguém com
  -- nível para receber; `falhou`: nenhuma entrega deu certo depois das tentativas; `expirado`: a semana
  -- seguinte acabou antes de dar para enviar.
  email_status      text not null check (email_status in ('pendente', 'enviado', 'desligado', 'sem_destinatario', 'falhou', 'expirado')),
  email_next_at     timestamptz,
  email_sent_at     timestamptz,
  email_recipients  integer not null default 0 check (email_recipients >= 0),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  check (week_to = week_from + 6 and extract(isodow from week_from) = 1),
  check ((reading_source = 'sistema') = (reading_reason is not null)),
  check ((email_status = 'pendente') = (email_next_at is not null)),
  check (email_status <> 'enviado' or email_sent_at is not null),
  -- Uma revisão por marca e semana: gerar de novo não cria outra.
  unique (brand_id, week_from)
);
create index if not exists idx_weekly_review_tenant on liame.weekly_review (tenant_id);
create index if not exists idx_weekly_review_email on liame.weekly_review (email_next_at) where email_status = 'pendente';
create index if not exists idx_weekly_review_uso on liame.weekly_review (usage_id) where usage_id is not null;

-- ------------------------------------------------------------ quem recebeu

-- Uma linha por pessoa e revisão: repetir o envio não manda duas vezes para a mesma pessoa, e todo envio
-- deixa o resultado gravado (enviado ou falhou, com o motivo curto e sem o endereço).
create table if not exists liame.weekly_review_delivery (
  id          uuid primary key,
  tenant_id   uuid not null references liame.organization (id) on delete cascade,
  review_id   uuid not null references liame.weekly_review (id) on delete cascade,
  user_id     uuid not null references liame.app_user (id) on delete cascade,
  -- O nível da pessoa na hora do envio (`dono`, `administrador`, `so_relatorios`).
  role_key    text not null check (role_key ~ '^[a-z][a-z0-9_]{1,40}$'),
  status      text not null check (status in ('enviado', 'falhou')),
  attempts    integer not null default 1 check (attempts >= 1),
  error       text check (length(error) between 1 and 300),
  sent_at     timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  check ((status = 'enviado') = (sent_at is not null)),
  unique (review_id, user_id)
);
create index if not exists idx_weekly_review_delivery_tenant on liame.weekly_review_delivery (tenant_id);
create index if not exists idx_weekly_review_delivery_pessoa on liame.weekly_review_delivery (user_id);

-- ------------------------------------------------------------ a vez de cada marca

-- Uma linha por marca: quando o worker olhou por último e quando volta. É a linha que a reserva trava
-- (SKIP LOCKED) e altera (V35).
create table if not exists liame.weekly_review_state (
  brand_id         uuid primary key references liame.brand (id) on delete cascade,
  tenant_id        uuid not null references liame.organization (id) on delete cascade,
  last_status      text check (last_status ~ '^[a-z][a-z0-9_]{1,40}$'),
  -- A segunda-feira da última semana com revisão gerada.
  last_week_from   date,
  next_at          timestamptz not null default now(),
  last_attempt_at  timestamptz,
  updated_at       timestamptz not null default now()
);
create index if not exists idx_weekly_review_state_proxima on liame.weekly_review_state (next_at);
create index if not exists idx_weekly_review_state_tenant on liame.weekly_review_state (tenant_id);

-- ------------------------------------------------------------ RLS e grants

-- A empresa lê o que é dela; quem grava é a rotina do worker, em escopo de sistema.
do $$
declare t text;
begin
  foreach t in array array['weekly_review', 'weekly_review_delivery', 'weekly_review_state']
  loop
    execute format('alter table liame.%I enable row level security', t);
    execute format('alter table liame.%I force row level security', t);
    execute format('drop policy if exists %I on liame.%I', t || '_isolamento', t);
    execute format(
      'create policy %I on liame.%I using (tenant_id = liame.current_tenant_id() or liame.system_scope()) with check (liame.system_scope())',
      t || '_isolamento', t);
    execute format('grant select, insert, update on liame.%I to liame_app', t);
  end loop;
end $$;

-- ------------------------------------------------------------ flag

-- O envio por e-mail nasce desligado para todos: a distribuição liga por empresa (comando `ligar-flag`).
-- A revisão na tela não depende desta flag.
insert into liame.feature_flag (key, kind, default_value, description, owner, is_write)
values ('revisao_email', 'boolean', 'false', 'Revisão da semana por e-mail: na segunda-feira de manhã, para o dono, os administradores e quem só recebe relatórios (A3, I7)', 'ia', false)
on conflict (key) do nothing;
