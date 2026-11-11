-- 0130 · Direct do Instagram: a leitura (A6, Z12, parte 1; protótipo P39, aprovado em 11/11/2026; D-A6-106 a D-A6-115;
-- `plano-a6.md` Z12). As conversas do Direct da conta do Instagram ligada a uma marca, lidas pela rotina `direct` do
-- worker a cada minuto (D-A6-108: por consulta, enquanto o app do Liame estiver em desenvolvimento na Meta), só para a
-- empresa com a função `direct` ligada (nasce desligada: antes de ligar para clientes, o texto da Política, V172) e a
-- marca com o Direct ligado (o ajuste da marca, com o código do app). O frescor fica em `sync_state`, com o conjunto
-- `direct`; a conferência com o Regem (D-A6-107) fica no cursor dele.
-- (1) Uma capacidade nova no registro, na versão das outras da Meta (v26.0), conferida nas páginas oficiais em 11/11/2026
--     (base de conhecimento §2.2): `instagram_conversas` (GET /{page-id}/conversations?platform=instagram e as mensagens
--     de cada conversa, com o token da Página).
-- (2) A função `direct`, desligada (só leitura; responder vem à parte, com a função de escrita).
-- (3) O ajuste da marca (`direct_setting`: ligado, e a confirmação de que nenhum outro programa responde aquele Direct),
--     as conversas (`direct_conversation`) e as mensagens (`direct_message`), com o texto, o @ de quem escreveu e a hora;
--     sem foto, vídeo, áudio nem story (D-A6-112). A mensagem sai 90 dias depois de enviada (o expurgo `direct_mensagem`
--     do worker), antes se a conta for desligada ou se o Regem passar a atender o Direct dela.
-- Da distribuição (o registro e a função) e das empresas (o ajuste, as conversas e as mensagens). Idempotente; uma
-- transação por arquivo (ADR-018).

-- As sementes gravam em tabelas com RLS forçada (V20).
select set_config('app.scope', 'sistema', true);

-- ------------------------------------------------------------ (1) a capacidade

insert into liame.connector_capability (provider, capability, api_version, read, write, required_scope, access_level, sunset_at, source_url, verified_at, notes) values
  ('meta_ads', 'instagram_conversas', 'v26.0', true, false, '{instagram_basic,instagram_manage_messages,pages_manage_metadata}', 'Standard (testadores) ou Advanced', null,
   'https://developers.facebook.com/documentation/business-messaging/messenger-platform/conversations', '2026-11-11',
   'Graph API: as conversas do Direct da conta do Instagram ligada à Página (GET /{page-id}/conversations?platform=instagram; token da Página de quem tem a tarefa MODERATE); só as 20 mensagens mais novas de cada conversa têm o texto; 2 chamadas por segundo por conta; sem paginação por data; os Pedidos parados há 30 dias não voltam; pede o app de um negócio verificado e, para quem não tem papel no app, o acesso avançado')
on conflict (provider, capability) do nothing;

-- ------------------------------------------------------------ (2) a função

insert into liame.feature_flag (key, kind, default_value, description, owner, is_write)
values ('direct', 'boolean', 'false', 'Direct: ler as conversas do Direct do Instagram ligado à marca, para a tela Direct (A6, Z12). Só leitura; responder vem à parte', 'social', false)
on conflict (key) do nothing;

-- ------------------------------------------------------------ (3) o ajuste, as conversas e as mensagens

create table if not exists liame.direct_setting (
  brand_id                uuid primary key references liame.brand (id) on delete cascade,
  tenant_id               uuid not null references liame.organization (id) on delete cascade,
  -- Ligado na marca (nasce desligado; ligar pede o Dono ou um Administrador e a confirmação).
  enabled                 boolean not null default false,
  -- Quem ligou confirmou que nenhum outro programa responde aquele Direct (D-A6-107; com o Regem ligado, o Liame
  -- confere com ele também).
  sem_outro_programa      boolean not null default false,
  updated_by              uuid,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  constraint direct_setting_ligado_confirmado check (not enabled or sem_outro_programa)
);

create table if not exists liame.direct_conversation (
  connected_account_id  uuid not null references liame.connected_account (id) on delete cascade,
  tenant_id             uuid not null references liame.organization (id) on delete cascade,
  brand_id              uuid not null references liame.brand (id) on delete cascade,
  -- O id da conversa na Meta.
  conversation_id       text not null,
  -- O id de quem escreveu no Instagram, como a Meta o dá a este app (IGSID): é para onde a resposta vai.
  participant_id        text not null,
  -- O @ de quem escreveu; nulo quando a Meta não manda.
  username              text,
  -- A última mensagem da conversa e a última da pessoa (a janela da Meta conta 24 horas a partir dela).
  last_message_at       timestamptz not null,
  last_inbound_at       timestamptz,
  -- De quem é a última mensagem: da pessoa (`entrada`) ou da marca (`saida`, pelo Liame ou pelo app do Instagram).
  last_direction        text not null,
  -- Chegou mensagem da pessoa que ninguém abriu no Liame.
  unread                boolean not null default false,
  -- Concluída no Liame sem resposta; a mensagem nova da pessoa reabre.
  concluded_at          timestamptz,
  -- A hora da última mudança que a Meta deu à conversa (a leitura só relê as que mudaram).
  meta_updated_at       timestamptz not null,
  read_at               timestamptz not null default now(),
  primary key (connected_account_id, conversation_id),
  constraint direct_conversation_id check (length(conversation_id) between 1 and 200),
  constraint direct_conversation_pessoa check (length(participant_id) between 1 and 100),
  constraint direct_conversation_usuario check (username is null or length(username) between 1 and 100),
  constraint direct_conversation_direcao check (last_direction in ('entrada', 'saida'))
);
create index if not exists idx_direct_conversation_marca on liame.direct_conversation (tenant_id, brand_id, last_message_at desc);

create table if not exists liame.direct_message (
  connected_account_id  uuid not null,
  tenant_id             uuid not null references liame.organization (id) on delete cascade,
  brand_id              uuid not null references liame.brand (id) on delete cascade,
  conversation_id       text not null,
  -- O id da mensagem na Meta.
  message_id            text not null,
  direction             text not null,
  -- O que é: o texto, ou o tipo do que só a Meta guarda (a foto, o vídeo, o áudio, o arquivo, o compartilhamento, a
  -- resposta e a menção no story, o Reels) e o que a API não mostra (`sem_suporte`).
  kind                  text not null,
  -- O texto (até 4.000 caracteres; a Meta aceita até 1.000 bytes no envio); vazio no que não é texto.
  body                  text not null default '',
  sent_at               timestamptz not null,
  read_at               timestamptz not null default now(),
  primary key (connected_account_id, message_id),
  foreign key (connected_account_id, conversation_id) references liame.direct_conversation (connected_account_id, conversation_id) on delete cascade,
  constraint direct_message_id check (length(message_id) between 1 and 300),
  constraint direct_message_direcao check (direction in ('entrada', 'saida')),
  constraint direct_message_tipo check (kind in ('texto', 'imagem', 'video', 'audio', 'arquivo', 'compartilhamento', 'story_resposta', 'story_mencao', 'reel', 'sem_suporte')),
  constraint direct_message_texto check (length(body) <= 4000)
);
create index if not exists idx_direct_message_conversa on liame.direct_message (connected_account_id, conversation_id, sent_at);
-- O expurgo de 90 dias anda pela data da mensagem.
create index if not exists idx_direct_message_prazo on liame.direct_message (sent_at);

alter table liame.direct_setting enable row level security;
alter table liame.direct_setting force row level security;
drop policy if exists direct_setting_isolamento on liame.direct_setting;
create policy direct_setting_isolamento on liame.direct_setting
  using (tenant_id = liame.current_tenant_id() or liame.system_scope())
  with check (tenant_id = liame.current_tenant_id() or liame.system_scope());

alter table liame.direct_conversation enable row level security;
alter table liame.direct_conversation force row level security;
drop policy if exists direct_conversation_isolamento on liame.direct_conversation;
create policy direct_conversation_isolamento on liame.direct_conversation
  using (tenant_id = liame.current_tenant_id() or liame.system_scope())
  with check (tenant_id = liame.current_tenant_id() or liame.system_scope());

alter table liame.direct_message enable row level security;
alter table liame.direct_message force row level security;
drop policy if exists direct_message_isolamento on liame.direct_message;
create policy direct_message_isolamento on liame.direct_message
  using (tenant_id = liame.current_tenant_id() or liame.system_scope())
  with check (tenant_id = liame.current_tenant_id() or liame.system_scope());

-- O ajuste se muda, não se apaga (sai com a marca); a leitura espelha as conversas e as mensagens (o `delete`).
grant select, insert, update on liame.direct_setting to liame_app;
grant select, insert, update, delete on liame.direct_conversation to liame_app;
grant select, insert, update, delete on liame.direct_message to liame_app;

-- ------------------------------------------------------------ conferência

do $$ begin
  if not exists (select 1 from liame.connector_capability where provider = 'meta_ads' and capability = 'instagram_conversas') then
    raise exception '0130: a capacidade das conversas não entrou';
  end if;
  if not exists (select 1 from liame.feature_flag where key = 'direct' and default_value = 'false'::jsonb and not is_write) then
    raise exception '0130: a função direct não entrou desligada';
  end if;
  if (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'liame' and c.relname in ('direct_setting', 'direct_conversation', 'direct_message') and c.relrowsecurity and c.relforcerowsecurity) <> 3 then
    raise exception '0130: as tabelas do Direct não entraram com a RLS forçada';
  end if;
  if (select count(*) from pg_constraint
       where conrelid in ('liame.direct_setting'::regclass, 'liame.direct_conversation'::regclass, 'liame.direct_message'::regclass)
         and conname in ('direct_setting_ligado_confirmado', 'direct_conversation_id', 'direct_conversation_pessoa', 'direct_conversation_usuario',
                         'direct_conversation_direcao', 'direct_message_id', 'direct_message_direcao', 'direct_message_tipo', 'direct_message_texto')) <> 9 then
    raise exception '0130: as regras do Direct não entraram';
  end if;
end $$;
