-- 0131 · Direct do Instagram: responder (A6, Z12, parte 2; protótipo P39, aprovado em 11/11/2026; D-A6-109 e
-- D-A6-111; `plano-a6.md` Z12). Uma pessoa da equipe manda a resposta numa conversa do Direct, pelo trilho de ações
-- (a ferramenta `direct_responder`, direta para quem pede, sem pedido em Aprovações), com o atendimento aberto: o código
-- do app uma vez, e por 8 horas (ou até fechar) as respostas dela saem sem código.
-- (1) Uma capacidade nova no registro, na versão das outras da Meta (v26.0), conferida nas páginas oficiais em 11/11/2026
--     (base de conhecimento §2.2): `instagram_mensagem` (POST /{page-id}/messages, com o token da Página).
-- (2) A função de escrita `direct_responder`, desligada.
-- (3) O atendimento aberto de cada pessoa na empresa (`direct_attendance`): quando abriu, até quando vale e quando fechou.
-- Da distribuição (o registro e a função) e das empresas (o atendimento). Idempotente; uma transação por arquivo
-- (ADR-018).

-- As sementes gravam em tabelas com RLS forçada (V20).
select set_config('app.scope', 'sistema', true);

-- ------------------------------------------------------------ (1) a capacidade

insert into liame.connector_capability (provider, capability, api_version, read, write, required_scope, access_level, sunset_at, source_url, verified_at, notes) values
  ('meta_ads', 'instagram_mensagem', 'v26.0', false, true, '{instagram_basic,instagram_manage_messages,pages_manage_metadata}', 'Standard (testadores) ou Advanced', null,
   'https://developers.facebook.com/documentation/business-messaging/instagram-messaging/features/send-message', '2026-11-11',
   'Graph API: a mensagem da marca numa conversa do Direct (POST /{page-id}/messages com recipient.id = o IGSID e message.text, até 1.000 bytes em UTF-8; token da Página de quem tem a tarefa MESSAGING); só dentro da janela de 24 horas depois da última mensagem da pessoa (fora dela, o erro 10/2534022); com o Conversation Routing, só o app dono da conversa responde (o erro 2534037)')
on conflict (provider, capability) do nothing;

-- ------------------------------------------------------------ (2) a função

insert into liame.feature_flag (key, kind, default_value, description, owner, is_write)
values ('direct_responder', 'boolean', 'false', 'Direct: uma pessoa da equipe responde as conversas do Direct do Instagram pelo Liame, com o atendimento aberto (A6, Z12, parte 2)', 'social', true)
on conflict (key) do nothing;

-- ------------------------------------------------------------ (3) o atendimento aberto

create table if not exists liame.direct_attendance (
  tenant_id     uuid not null references liame.organization (id) on delete cascade,
  user_id       uuid not null references liame.app_user (id) on delete cascade,
  opened_at     timestamptz not null,
  -- Até quando as respostas desta pessoa saem sem o código (8 horas depois de abrir).
  expires_at    timestamptz not null,
  -- Fechado antes da hora pela própria pessoa.
  closed_at     timestamptz,
  primary key (tenant_id, user_id),
  constraint direct_attendance_prazo check (expires_at > opened_at and expires_at <= opened_at + interval '12 hours'),
  constraint direct_attendance_fechado check (closed_at is null or closed_at >= opened_at)
);

alter table liame.direct_attendance enable row level security;
alter table liame.direct_attendance force row level security;
drop policy if exists direct_attendance_isolamento on liame.direct_attendance;
create policy direct_attendance_isolamento on liame.direct_attendance
  using (tenant_id = liame.current_tenant_id() or liame.system_scope())
  with check (tenant_id = liame.current_tenant_id() or liame.system_scope());

-- Abrir regrava a linha da pessoa; fechar marca a hora. Nada se apaga (sai com a pessoa ou a empresa).
grant select, insert, update on liame.direct_attendance to liame_app;

-- ------------------------------------------------------------ conferência

do $$ begin
  if not exists (select 1 from liame.connector_capability where provider = 'meta_ads' and capability = 'instagram_mensagem' and write) then
    raise exception '0131: a capacidade de mandar mensagem não entrou';
  end if;
  if not exists (select 1 from liame.feature_flag where key = 'direct_responder' and default_value = 'false'::jsonb and is_write) then
    raise exception '0131: a função direct_responder não entrou desligada';
  end if;
  if not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                  where n.nspname = 'liame' and c.relname = 'direct_attendance' and c.relrowsecurity and c.relforcerowsecurity) then
    raise exception '0131: a tabela do atendimento não entrou com a RLS forçada';
  end if;
  if (select count(*) from pg_constraint where conrelid = 'liame.direct_attendance'::regclass and conname in ('direct_attendance_prazo', 'direct_attendance_fechado')) <> 2 then
    raise exception '0131: as regras do atendimento não entraram';
  end if;
end $$;
