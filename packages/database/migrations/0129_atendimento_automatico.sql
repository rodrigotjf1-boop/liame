-- 0129 · O atendimento automático dos comentários (A6, Z11, parte 2e-1; `plano-a6.md` D-A6-92 e D-A6-104; P38 versão
-- 2). Com ele ligado numa marca, o Liame responde sozinho, sem pedido de aprovação, os comentários dos tipos marcados
-- (o elogio e a marcação de amigo; a pergunta, só quando ele souber responder com certeza, numa parte própria), sempre
-- com o aviso de resposta automática. A reclamação, o que a conferência barrar, o golpe e a ofensa sempre esperam uma
-- pessoa. Liga o Dono ou um Administrador, com o código do app; desliga, na hora e sem código, quem pode aprovar.
-- O que fica aqui: uma linha por marca (ligado, os tipos e quem mudou por último). Cada mudança fica também na auditoria.
-- Nada de comentário nem de quem comentou. A função `comentarios_automatico` nasce desligada para todos: sem ela, nada
-- responde sozinho, mesmo com a marca ligada.
-- Idempotente; uma transação por arquivo (ADR-018).

-- A RLS forçada vale também para o dono das tabelas: a função nova entra no escopo de sistema (V20), só nesta transação.
select set_config('app.scope', 'sistema', true);

create table if not exists liame.comment_auto_reply (
  brand_id    uuid primary key references liame.brand (id) on delete cascade,
  tenant_id   uuid not null references liame.organization (id) on delete cascade,
  -- Ligado ou não. Nasce desligado em cada marca, mesmo com a função ligada para a empresa.
  enabled     boolean not null default false,
  -- O que ele responde sozinho: o elogio, a marcação de amigo e a pergunta (esta, só com a certeza; parte 2e-3).
  kinds       text[] not null default '{}' check (kinds <@ '{elogio,marcacao,pergunta}'::text[] and cardinality(kinds) <= 3),
  -- Quem mudou por último e quando (a auditoria guarda cada mudança, com o antes e o depois).
  updated_by  uuid references liame.app_user (id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  -- Ligado é ligado para pelo menos um tipo.
  constraint comment_auto_reply_ligado check (not enabled or cardinality(kinds) >= 1)
);
create index if not exists idx_comment_auto_reply_tenant on liame.comment_auto_reply (tenant_id);

-- ------------------------------------------------------------ RLS e grants

alter table liame.comment_auto_reply enable row level security;
alter table liame.comment_auto_reply force row level security;
drop policy if exists comment_auto_reply_isolamento on liame.comment_auto_reply;
create policy comment_auto_reply_isolamento on liame.comment_auto_reply
  using (tenant_id = liame.current_tenant_id() or liame.system_scope())
  with check (tenant_id = liame.current_tenant_id() or liame.system_scope());
grant select, insert, update on liame.comment_auto_reply to liame_app;

-- ------------------------------------------------------------ a função

-- Liga, por empresa, o atendimento automático dos comentários (D-A6-92). Nasce desligada. Publica em nome da marca sem
-- o código do app (só o que a marca escolheu, com o aviso de resposta automática): é de escrita. Depende também dos
-- pedidos do Social media (`comentarios_sugeridos`), da leitura (`comentarios`) e da resposta pelo Liame
-- (`comentarios_responder` e `social_write`), que o código confere.
insert into liame.feature_flag (key, kind, default_value, description, owner, is_write)
values ('comentarios_automatico', 'boolean', 'false', 'Comentários: o atendimento automático (A6, Z11, D-A6-92). Com a marca ligada pelo Dono ou por um Administrador, com o código do app, o Liame responde sozinho os tipos marcados, com o aviso de resposta automática; a reclamação, o golpe e a ofensa sempre esperam uma pessoa', 'social', true)
on conflict (key) do nothing;
