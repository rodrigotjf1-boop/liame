-- 0134 · O Messenger da Página na caixa do Direct: a leitura (A6, Z14, parte 1; protótipo P39 versão 3, com as
-- decisões recomendadas D-A6-120 a D-A6-124, a regra do dono de seguir a recomendada; `plano-a6.md` Z14). As mensagens
-- que as pessoas mandam para a Página da marca no Facebook chegam à mesma caixa do Direct, como outro canal.
-- (1) Duas capacidades no registro, na versão das outras da Meta (v26.0), conferidas nas páginas oficiais em 11/11/2026
--     (base de conhecimento §2.2): `messenger_conversas` (GET /{page-id}/conversations?platform=messenger e as mensagens
--     de cada conversa) e `messenger_mensagem` (POST /{page-id}/messages com o PSID; a resposta vem na parte 2).
-- (2) A função `messenger`, de leitura, desligada.
-- (3) O ajuste da marca para o Messenger (`messenger_setting`), como o do Direct (`direct_setting`): cada canal liga
--     separado (D-A6-121).
-- (4) Na conversa, o canal (`instagram` ou `messenger`) e o nome que a Meta manda de quem escreve (`display_name`; no
--     Messenger não há @), guardados 90 dias como o resto da conversa (D-A6-123).
-- Da distribuição (o registro e a função) e das empresas (o ajuste e a conversa). Idempotente; uma transação por arquivo
-- (ADR-018).

-- As sementes gravam em tabelas com RLS forçada (V20).
select set_config('app.scope', 'sistema', true);

-- ------------------------------------------------------------ (1) as capacidades

insert into liame.connector_capability (provider, capability, api_version, read, write, required_scope, access_level, sunset_at, source_url, verified_at, notes) values
  ('meta_ads', 'messenger_conversas', 'v26.0', true, false, '{pages_messaging,pages_manage_metadata,pages_read_engagement}', 'Standard (testadores) ou Advanced', null,
   'https://developers.facebook.com/docs/graph-api/reference/page/conversations/', '2026-11-11',
   'Graph API: as conversas do Messenger da Página (GET /{page-id}/conversations?platform=messenger&fields=id,updated_time,participants) e as mensagens de cada uma (GET /{conversation-id}?fields=messages{…}); token da Página de quem tem a tarefa MESSAGING; não pagina por data'),
  ('meta_ads', 'messenger_mensagem', 'v26.0', false, true, '{pages_messaging,pages_manage_metadata,pages_read_engagement}', 'Standard (testadores) ou Advanced', null,
   'https://developers.facebook.com/docs/messenger-platform/send-messages', '2026-11-11',
   'Graph API: a mensagem da Página numa conversa do Messenger (POST /{page-id}/messages com recipient.id = o PSID, message.text e messaging_type RESPONSE); só dentro da janela de 24 horas depois da última mensagem da pessoa; token da Página com pages_messaging')
on conflict (provider, capability) do nothing;

-- ------------------------------------------------------------ (2) a função

insert into liame.feature_flag (key, kind, default_value, description, owner, is_write)
values ('messenger', 'boolean', 'false', 'Messenger: o Liame lê as mensagens da Página da marca no Facebook, na caixa do Direct (A6, Z14, parte 1)', 'social', false)
on conflict (key) do nothing;

-- ------------------------------------------------------------ (3) o ajuste da marca

create table if not exists liame.messenger_setting (
  brand_id            uuid primary key references liame.brand (id) on delete cascade,
  tenant_id           uuid not null references liame.organization (id) on delete cascade,
  -- Ligado ou não. Nasce desligado em cada marca, mesmo com a função ligada para a empresa.
  enabled             boolean not null default false,
  -- Quem ligou confirmou que nenhum outro programa responde o Messenger da Página (D-A6-121).
  sem_outro_programa  boolean not null default false,
  updated_by          uuid references liame.app_user (id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint messenger_setting_ligado check (not enabled or sem_outro_programa)
);
create index if not exists idx_messenger_setting_tenant on liame.messenger_setting (tenant_id);

alter table liame.messenger_setting enable row level security;
alter table liame.messenger_setting force row level security;
drop policy if exists messenger_setting_isolamento on liame.messenger_setting;
create policy messenger_setting_isolamento on liame.messenger_setting
  using (tenant_id = liame.current_tenant_id() or liame.system_scope())
  with check (tenant_id = liame.current_tenant_id() or liame.system_scope());
grant select, insert, update on liame.messenger_setting to liame_app;

-- ------------------------------------------------------------ (4) o canal e o nome na conversa

alter table liame.direct_conversation add column if not exists channel text not null default 'instagram';
alter table liame.direct_conversation add column if not exists display_name text;
do $$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'liame.direct_conversation'::regclass and conname = 'direct_conversation_canal') then
    alter table liame.direct_conversation add constraint direct_conversation_canal check (channel in ('instagram', 'messenger'));
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'liame.direct_conversation'::regclass and conname = 'direct_conversation_nome') then
    alter table liame.direct_conversation add constraint direct_conversation_nome check (display_name is null or length(display_name) <= 200);
  end if;
end $$;

-- ------------------------------------------------------------ conferência

do $$ begin
  if (select count(*) from liame.connector_capability where provider = 'meta_ads' and capability in ('messenger_conversas', 'messenger_mensagem')) <> 2 then
    raise exception '0134: as capacidades do Messenger não entraram';
  end if;
  if not exists (select 1 from liame.feature_flag where key = 'messenger' and default_value = 'false'::jsonb and not is_write) then
    raise exception '0134: a função messenger não entrou desligada';
  end if;
  if not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                  where n.nspname = 'liame' and c.relname = 'messenger_setting' and c.relrowsecurity and c.relforcerowsecurity) then
    raise exception '0134: o ajuste do Messenger não entrou com a RLS forçada';
  end if;
  if (select count(*) from pg_constraint where conrelid = 'liame.direct_conversation'::regclass and conname in ('direct_conversation_canal', 'direct_conversation_nome')) <> 2 then
    raise exception '0134: as regras do canal e do nome não entraram';
  end if;
end $$;
