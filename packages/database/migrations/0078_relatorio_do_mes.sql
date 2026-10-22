-- 0078 · Relatório do mês (A3, I7; protótipo P24 aprovado em 21/10/2026, decisões D-A3-18 a D-A3-22).
-- No dia 1º, a partir das 5h no fuso da loja, o worker fecha o mês que terminou na véspera: os números do ciclo
-- fechado contra os do mês anterior, semana a semana (as semanas cortadas no mês), o que cada campanha trouxe no
-- caixa, o que melhorou e o que piorou, o que fica para o mês seguinte e a leitura (da LIA ou, sem ela, do
-- sistema). O relatório fica guardado como foi gerado, como a revisão da semana (0032): a tela e o e-mail mostram
-- os mesmos números, mesmo que a plataforma reveja os dela depois. Quem grava é o worker, em escopo de sistema; a
-- empresa só lê o que é dela. O envio por e-mail nasce desligado para todos (flag `relatorio_email`, D-A3-20).
-- Nenhuma tabela aqui tem dado de cliente da loja. Idempotente; uma transação por arquivo (ADR-018).

-- A semente da flag grava em tabela com RLS forçada (V20).
select set_config('app.scope', 'sistema', true);

-- ------------------------------------------------------------ o relatório

create table if not exists liame.monthly_report (
  id                uuid primary key,
  tenant_id         uuid not null references liame.organization (id) on delete cascade,
  brand_id          uuid not null references liame.brand (id) on delete cascade,
  -- O mês da loja, do dia 1º ao último, no fuso dela.
  month_from        date not null,
  month_to          date not null,
  timezone          text not null check (length(timezone) between 3 and 64),
  generated_at      timestamptz not null,
  -- Quem escreveu a leitura do mês e, quando foi o sistema, por quê (`desligada`, `dado_velho`, `teto`…).
  reading_source    text not null check (reading_source in ('lia', 'sistema')),
  reading_reason    text check (reading_reason ~ '^[a-z][a-z0-9_]{1,40}$'),
  -- A chamada que gerou a leitura da LIA: é a ela que o retorno da pessoa ("Fez sentido", "Discordo") se liga.
  usage_id          uuid references liame.ai_usage (id) on delete set null,
  -- O relatório como a tela e o e-mail mostram (contrato `MonthlyReport`), na versão em que foi gerado.
  content           jsonb not null check (jsonb_typeof(content) = 'object'),
  content_version   integer not null check (content_version >= 1),
  -- O envio por e-mail, como o da revisão da semana. `expirado`: o prazo de enviar (até o dia 7 do mês seguinte)
  -- acabou antes de dar para enviar.
  email_status      text not null check (email_status in ('pendente', 'enviado', 'desligado', 'sem_destinatario', 'falhou', 'expirado')),
  email_next_at     timestamptz,
  email_sent_at     timestamptz,
  email_recipients  integer not null default 0 check (email_recipients >= 0),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint monthly_report_mes check (extract(day from month_from) = 1 and month_to = (month_from + interval '1 month' - interval '1 day')::date),
  constraint monthly_report_leitura check ((reading_source = 'sistema') = (reading_reason is not null)),
  constraint monthly_report_envio check ((email_status = 'pendente') = (email_next_at is not null)),
  constraint monthly_report_enviado check (email_status <> 'enviado' or email_sent_at is not null),
  -- Um relatório por marca e mês: gerar de novo não cria outro.
  constraint monthly_report_um_por_mes unique (brand_id, month_from)
);
create index if not exists idx_monthly_report_tenant on liame.monthly_report (tenant_id);
create index if not exists idx_monthly_report_email on liame.monthly_report (email_next_at) where email_status = 'pendente';
create index if not exists idx_monthly_report_uso on liame.monthly_report (usage_id) where usage_id is not null;

-- ------------------------------------------------------------ quem recebeu

-- Uma linha por pessoa e relatório: repetir o envio não manda duas vezes para a mesma pessoa, e todo envio deixa
-- o resultado gravado (enviado ou falhou, com o tipo do erro e sem o endereço).
create table if not exists liame.monthly_report_delivery (
  id          uuid primary key,
  tenant_id   uuid not null references liame.organization (id) on delete cascade,
  report_id   uuid not null references liame.monthly_report (id) on delete cascade,
  user_id     uuid not null references liame.app_user (id) on delete cascade,
  -- O nível da pessoa na hora do envio (`dono`, `administrador`, `so_relatorios`).
  role_key    text not null check (role_key ~ '^[a-z][a-z0-9_]{1,40}$'),
  status      text not null check (status in ('enviado', 'falhou')),
  attempts    integer not null default 1 check (attempts >= 1),
  error       text check (length(error) between 1 and 300),
  sent_at     timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint monthly_report_delivery_enviado check ((status = 'enviado') = (sent_at is not null)),
  constraint monthly_report_delivery_uma_por_pessoa unique (report_id, user_id)
);
create index if not exists idx_monthly_report_delivery_tenant on liame.monthly_report_delivery (tenant_id);
create index if not exists idx_monthly_report_delivery_pessoa on liame.monthly_report_delivery (user_id);

-- ------------------------------------------------------------ a vez de cada marca

-- Uma linha por marca: quando o worker olhou por último e quando volta. É a linha que a reserva trava (SKIP LOCKED)
-- e altera (V35).
create table if not exists liame.monthly_report_state (
  brand_id         uuid primary key references liame.brand (id) on delete cascade,
  tenant_id        uuid not null references liame.organization (id) on delete cascade,
  last_status      text check (last_status ~ '^[a-z][a-z0-9_]{1,40}$'),
  -- O dia 1º do último mês com relatório gerado.
  last_month_from  date,
  next_at          timestamptz not null default now(),
  last_attempt_at  timestamptz,
  updated_at       timestamptz not null default now()
);
create index if not exists idx_monthly_report_state_proxima on liame.monthly_report_state (next_at);
create index if not exists idx_monthly_report_state_tenant on liame.monthly_report_state (tenant_id);

-- ------------------------------------------------------------ RLS e grants

-- A empresa lê o que é dela; quem grava é a rotina do worker, em escopo de sistema.
do $$
declare t text;
begin
  foreach t in array array['monthly_report', 'monthly_report_delivery', 'monthly_report_state']
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

-- O envio por e-mail nasce desligado para todos: a distribuição liga por empresa (comando `ligar-flag`), depois de o
-- dono aprovar o texto do e-mail (D-A3-20). O relatório na tela não depende desta flag, e ela não depende da
-- `revisao_email`: uma chave para cada e-mail.
insert into liame.feature_flag (key, kind, default_value, description, owner, is_write)
values ('relatorio_email', 'boolean', 'false', 'Relatório do mês por e-mail: no dia 1º de manhã, para o dono, os administradores e quem só recebe relatórios (A3, I7; D-A3-20)', 'ia', false)
on conflict (key) do nothing;
