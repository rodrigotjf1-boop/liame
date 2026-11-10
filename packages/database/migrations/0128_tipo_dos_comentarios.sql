-- 0128 · O tipo do comentário pela IA (A6, Z11, parte 2d-4c; `plano-a6.md` D-A6-87 e D-A6-101). A regra do Liame decide o
-- tipo do que é claro; o comentário que ela deixa sem tipo não vira pedido. Com a função `comentarios_sugeridos` ligada,
-- a leitura dos comentários abre aqui a vez de cada um deles, e a rotina do worker pede o tipo ao Social media (a tarefa
-- `social_comentario_tipo`, com o Haiku 5.5, migration 0127). Com um tipo decidido, o comentário ganha o tipo (com
-- `kind_source = 'ia'`, que a leitura mantém enquanto o texto não muda) e a vez do pedido abre na mesma transação; o
-- "nenhum" (o comentário que não pede ação da marca) fica só aqui.
-- O que fica aqui: a situação, o tipo que saiu, o porquê em código e a marca do texto julgado (o SHA-256 do texto do
-- comentário, para o mesmo texto não ir ao modelo duas vezes e o texto editado ganhar uma vez nova). NENHUM texto e nada
-- de quem comentou: a linha aponta o comentário, que tem a guarda de 90 dias dele, e sai com ele. Nada usa esta tabela
-- enquanto a função `comentarios_sugeridos` estiver desligada.
-- Idempotente; uma transação por arquivo (ADR-018).

create table if not exists liame.comment_kind_check (
  id                    uuid primary key,
  tenant_id             uuid not null references liame.organization (id) on delete cascade,
  brand_id              uuid not null references liame.brand (id) on delete cascade,
  -- O comentário (a conta da rede e o id dele): a linha sai com ele, na guarda de 90 dias dele.
  connected_account_id  uuid not null,
  comment_id            text not null,
  -- A marca do texto julgado: o SHA-256, em hexadecimal, do texto do comentário (UTF-8). Não guarda o texto.
  text_sha256           text not null check (text_sha256 ~ '^[0-9a-f]{64}$'),
  -- Onde o comentário está:
  --   `esperando`   na fila (também quando a função, a IA, a resposta ou o Social media estão desligados, sem a rota do
  --                 modelo ou no limite de IA: o porquê fica em `reason`, e a vez volta mais tarde, sem contar tentativa);
  --   `pronta`      o tipo saiu (`result`): um dos seis, que o comentário ganhou, ou `nenhum`;
  --   `descartada`  não vai ter tipo pela IA (o texto mudou, a regra decidiu, já respondido, oculto, antigo, sumiu…);
  --   `falhou`      não deu para chamar a IA, depois das tentativas.
  status                text not null default 'esperando' check (status in ('esperando', 'pronta', 'descartada', 'falhou')),
  result                text check (result in ('pergunta', 'reclamacao', 'elogio', 'marcacao', 'ofensivo', 'golpe', 'nenhum')),
  -- O porquê (`ia_sem_rota`, `funcao_desligada`, `texto_mudou`, `formato`, `marcacao_sem_perfil`…): o código, não o texto do erro.
  reason                text check (reason ~ '^[a-z_]{2,40}$'),
  usage_id              uuid references liame.ai_usage (id),
  attempts              integer not null default 0 check (attempts >= 0),
  next_attempt_at       timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  finished_at           timestamptz,
  foreign key (connected_account_id, comment_id) references liame.social_comment (connected_account_id, comment_id) on delete cascade,
  -- Uma vez por comentário e por texto: a leitura que roda duas vezes não pede em dobro, e o mesmo texto não volta ao modelo.
  constraint comment_kind_check_texto unique (connected_account_id, comment_id, text_sha256),
  -- O tipo que saiu é da que está pronta, e só dela.
  constraint comment_kind_check_pronta check ((status = 'pronta') = (result is not null)),
  -- Quem acabou tem a hora em que acabou; quem espera, não.
  constraint comment_kind_check_fim check ((finished_at is not null) = (status <> 'esperando'))
);
create index if not exists idx_comment_kind_check_tenant on liame.comment_kind_check (tenant_id);
-- A fila da rotina: as que esperam a vez.
create index if not exists idx_comment_kind_check_fila on liame.comment_kind_check (next_attempt_at) where status = 'esperando';

-- ------------------------------------------------------------ RLS e grants

alter table liame.comment_kind_check enable row level security;
alter table liame.comment_kind_check force row level security;
drop policy if exists comment_kind_check_isolamento on liame.comment_kind_check;
create policy comment_kind_check_isolamento on liame.comment_kind_check
  using (tenant_id = liame.current_tenant_id() or liame.system_scope())
  with check (tenant_id = liame.current_tenant_id() or liame.system_scope());
grant select, insert, update on liame.comment_kind_check to liame_app;
