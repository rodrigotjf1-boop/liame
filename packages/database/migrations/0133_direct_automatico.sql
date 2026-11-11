-- 0133 · Direct do Instagram: o atendimento automático (A6, Z12, parte 5a; protótipo P39 versão 2, aprovado em
-- 11/11/2026; D-A6-115 e D-A6-119; `plano-a6.md` Z12). Com ele ligado numa marca (pelo Dono ou por um Administrador,
-- com o código do app), o Liame responde sozinho, sem uma pessoa ver antes, as conversas do Direct dos tipos marcados:
-- nesta parte, o elogio, a resposta ao story e a menção no story, com a resposta pronta, sem IA (o tipo `pronta`); a
-- pergunta que ele sabe responder com certeza entra com o Social media (parte 4b). Toda resposta automática termina com
-- o aviso de resposta automática e o caminho para uma pessoa. A reclamação, o golpe, quem pede uma pessoa e a terceira
-- resposta automática seguida na mesma conversa sempre esperam uma pessoa. Desligar vale na hora, sem código.
-- (1) O ajuste da marca (`direct_auto_reply`): ligado, os tipos e quem mudou por último. Cada mudança fica também na
--     auditoria. Nada da conversa nem de quem escreveu.
-- (2) Na conversa, a última mensagem da pessoa que o automático já decidiu (`auto_checked_message`): a mesma mensagem
--     não é olhada duas vezes, e a seguinte da pessoa é.
-- (3) A função de escrita `direct_automatico`, desligada: sem ela, nada responde sozinho, mesmo com a marca ligada.
-- Das empresas (o ajuste e a conversa) e da distribuição (a função). Idempotente; uma transação por arquivo (ADR-018).

-- A RLS forçada vale também para o dono das tabelas: a semente da função entra no escopo de sistema (V20).
select set_config('app.scope', 'sistema', true);

-- ------------------------------------------------------------ (1) o ajuste da marca

create table if not exists liame.direct_auto_reply (
  brand_id    uuid primary key references liame.brand (id) on delete cascade,
  tenant_id   uuid not null references liame.organization (id) on delete cascade,
  -- Ligado ou não. Nasce desligado em cada marca, mesmo com a função ligada para a empresa.
  enabled     boolean not null default false,
  -- O que ele responde sozinho: a resposta pronta (o elogio, a resposta ao story, a menção) e, com o Social media, a
  -- pergunta que ele sabe responder com certeza.
  kinds       text[] not null default '{}' check (kinds <@ '{pronta,pergunta}'::text[] and cardinality(kinds) <= 2),
  -- Quem mudou por último e quando (a auditoria guarda cada mudança, com o antes e o depois).
  updated_by  uuid references liame.app_user (id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  -- Ligado é ligado para pelo menos um tipo.
  constraint direct_auto_reply_ligado check (not enabled or cardinality(kinds) >= 1)
);
create index if not exists idx_direct_auto_reply_tenant on liame.direct_auto_reply (tenant_id);

alter table liame.direct_auto_reply enable row level security;
alter table liame.direct_auto_reply force row level security;
drop policy if exists direct_auto_reply_isolamento on liame.direct_auto_reply;
create policy direct_auto_reply_isolamento on liame.direct_auto_reply
  using (tenant_id = liame.current_tenant_id() or liame.system_scope())
  with check (tenant_id = liame.current_tenant_id() or liame.system_scope());
grant select, insert, update on liame.direct_auto_reply to liame_app;

-- ------------------------------------------------------------ (2) a mensagem que o automático já decidiu

alter table liame.direct_conversation add column if not exists auto_checked_message text;

-- ------------------------------------------------------------ (3) a função

-- Liga, por empresa, o atendimento automático do Direct (D-A6-115). Nasce desligada. Manda mensagem em nome da marca
-- sem uma pessoa ver antes (só o que a marca escolheu, com o aviso de resposta automática): é de escrita. Depende também
-- do Direct (`direct`) e da resposta pelo Liame (`direct_responder` e `social_write`), que o código confere.
insert into liame.feature_flag (key, kind, default_value, description, owner, is_write)
values ('direct_automatico', 'boolean', 'false', 'Direct: o atendimento automático (A6, Z12, D-A6-115). Com a marca ligada pelo Dono ou por um Administrador, com o código do app, o Liame responde sozinho os tipos marcados, com o aviso de resposta automática; a reclamação, o golpe e quem pede uma pessoa sempre esperam a equipe', 'social', true)
on conflict (key) do nothing;

-- ------------------------------------------------------------ conferência

do $$ begin
  if not exists (select 1 from liame.feature_flag where key = 'direct_automatico' and default_value = 'false'::jsonb and is_write) then
    raise exception '0133: a função direct_automatico não entrou desligada';
  end if;
  if not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                  where n.nspname = 'liame' and c.relname = 'direct_auto_reply' and c.relrowsecurity and c.relforcerowsecurity) then
    raise exception '0133: a tabela do automático não entrou com a RLS forçada';
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'liame.direct_auto_reply'::regclass and conname = 'direct_auto_reply_ligado') then
    raise exception '0133: a regra de ligado com um tipo não entrou';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'liame' and table_name = 'direct_conversation' and column_name = 'auto_checked_message') then
    raise exception '0133: a coluna da mensagem decidida não entrou';
  end if;
end $$;
