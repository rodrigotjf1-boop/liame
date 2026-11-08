-- 0125 · As sugestões de resposta aos comentários, pelo Social media (A6, Z11, parte 2d-2; `plano-a6.md` D-A6-88,
-- D-A6-89, D-A6-94 e D-A6-98; protótipo P38, aprovado em 07/11/2026). Para cada comentário dos posts dos últimos 30 dias
-- que pede uma ação da marca, a rotina do worker monta o pedido em Aprovações, em nome do dono, com a aprovação de uma
-- pessoa pelo código do app: no elogio e na marcação, com a resposta pronta (sem IA); na pergunta e na reclamação, com
-- as sugestões do Social media que a conferência deixou passar; no golpe e no ofensivo, o pedido de ocultar. Esta
-- tabela guarda onde cada comentário está nesse caminho, para a rotina retomar de onde parou e para as telas dizerem a
-- verdade (esperando a IA, em Aprovações, barrada pela conferência).
-- O que fica aqui: a situação, o porquê em código, o que a conferência barrou (só os nomes das regras) e o pedido que
-- saiu. NENHUM texto: o das sugestões que passaram fica no pedido (`action_request.params`), e o que a conferência
-- barrou não é guardado. Nada de quem comentou: a linha aponta o comentário, que tem a guarda de 90 dias dele, e sai
-- com ele. Nada usa esta tabela enquanto a função `comentarios_sugeridos` estiver desligada.
-- Idempotente; uma transação por arquivo (ADR-018).

-- A semente da flag grava em tabela com RLS forçada (V20).
select set_config('app.scope', 'sistema', true);

create table if not exists liame.comment_suggestion (
  id                    uuid primary key,
  tenant_id             uuid not null references liame.organization (id) on delete cascade,
  brand_id              uuid not null references liame.brand (id) on delete cascade,
  -- O comentário (a conta da rede e o id dele): a linha sai com ele, na guarda de 90 dias dele.
  connected_account_id  uuid not null,
  comment_id            text not null,
  -- 1: o pedido do comentário; 2: o "Pedir outra", uma vez por comentário (D-A6-88).
  round                 smallint not null default 1 check (round in (1, 2)),
  -- Onde o comentário está:
  --   `esperando`   na fila (também quando a função, a IA, a resposta ou o Social media estão desligados, sem a rota do
  --                 modelo ou no limite de IA: o porquê fica em `reason`, e a vez volta mais tarde, sem contar tentativa);
  --   `pronta`      o pedido está em Aprovações;
  --   `barrada`     a conferência não deixou passar nenhuma sugestão (nada foi para Aprovações);
  --   `descartada`  não vai ter pedido (já respondido, oculto, antigo, com pedido de uma pessoa, sumiu da rede…);
  --   `falhou`      não deu para chamar a IA ou criar o pedido, depois das tentativas;
  --   `retirada`    o pedido saiu de Aprovações porque o comentário mudou ou foi respondido direto na rede.
  status                text not null default 'esperando' check (status in ('esperando', 'pronta', 'barrada', 'descartada', 'falhou', 'retirada')),
  -- O que a vez faz com o comentário: `responder` (com a resposta pronta ou as sugestões) ou `ocultar` (golpe, ofensivo).
  operation             text not null check (operation in ('responder', 'ocultar')),
  -- O porquê (`ia_sem_rota`, `funcao_desligada`, `respondido`, `antigo`, `ia_fora_do_ar`…): o código, não o texto do erro.
  reason                text check (reason ~ '^[a-z_]{2,40}$'),
  -- O que a conferência apontou quando barrou: só os nomes das regras, nunca o texto barrado.
  barred_by             text[] check (barred_by is null or (cardinality(barred_by) between 1 and 20 and array_to_string(barred_by, ',') ~ '^[a-z_,]+$' and length(array_to_string(barred_by, ',')) <= 840)),
  -- Quantas sugestões foram para o pedido de responder (uma; três na reclamação, D-A6-94); nulo no de ocultar.
  suggestions           smallint check (suggestions between 1 and 3),
  -- O pedido em Aprovações que saiu desta linha.
  action_id             uuid references liame.action_request (id) on delete set null,
  usage_id              uuid references liame.ai_usage (id),
  attempts              integer not null default 0 check (attempts >= 0),
  next_attempt_at       timestamptz,
  -- Quem pediu outra sugestão (a rodada 2); nulo na rodada 1, que é da rotina.
  requested_by          uuid references liame.app_user (id) on delete set null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  finished_at           timestamptz,
  foreign key (connected_account_id, comment_id) references liame.social_comment (connected_account_id, comment_id) on delete cascade,
  -- Uma linha por comentário e por rodada: a rotina que roda duas vezes não pede em dobro.
  constraint comment_suggestion_rodada unique (connected_account_id, comment_id, round),
  -- A que está em Aprovações aponta o pedido (até o pedido sair do banco); a de responder diz quantas sugestões foram.
  constraint comment_suggestion_pronta check (status <> 'pronta' or operation = 'ocultar' or suggestions is not null),
  constraint comment_suggestion_ocultar check (operation <> 'ocultar' or suggestions is null),
  -- A barrada diz o que barrou, e só ela.
  constraint comment_suggestion_barrada check ((status = 'barrada') = (barred_by is not null)),
  -- Quem acabou tem a hora em que acabou; quem espera, não.
  constraint comment_suggestion_fim check ((finished_at is not null) = (status <> 'esperando'))
);
create index if not exists idx_comment_suggestion_tenant on liame.comment_suggestion (tenant_id);
create index if not exists idx_comment_suggestion_brand on liame.comment_suggestion (brand_id, created_at desc);
-- A fila da rotina: as que esperam a vez.
create index if not exists idx_comment_suggestion_fila on liame.comment_suggestion (next_attempt_at) where status = 'esperando';
-- O pedido em Aprovações é de uma linha só.
create unique index if not exists uq_comment_suggestion_pedido on liame.comment_suggestion (action_id) where action_id is not null;

-- ------------------------------------------------------------ RLS e grants

alter table liame.comment_suggestion enable row level security;
alter table liame.comment_suggestion force row level security;
drop policy if exists comment_suggestion_isolamento on liame.comment_suggestion;
create policy comment_suggestion_isolamento on liame.comment_suggestion
  using (tenant_id = liame.current_tenant_id() or liame.system_scope())
  with check (tenant_id = liame.current_tenant_id() or liame.system_scope());
grant select, insert, update on liame.comment_suggestion to liame_app;

-- ------------------------------------------------------------ a função

-- Liga, por empresa, os pedidos do Social media para os comentários (D-A6-88 e D-A6-98). Nasce desligada. Depende também
-- da leitura (`comentarios`), da resposta pelo Liame (`comentarios_responder` e `social_write`), da IA (`ia`, só para a
-- pergunta e a reclamação) e do Social media ativo na marca, que o código confere. Não publica nada sozinha: todo pedido
-- espera a aprovação de uma pessoa com o código do app (o atendimento automático, D-A6-92, é uma parte própria).
insert into liame.feature_flag (key, kind, default_value, description, owner, is_write)
values ('comentarios_sugeridos', 'boolean', 'false', 'Social media: os pedidos para os comentários dos posts (a resposta pronta ao elogio e à marcação, as sugestões da IA à pergunta e à reclamação, e ocultar o golpe e o ofensivo), conferidos pelo código, para uma pessoa aprovar com o código do app (A6, Z11)', 'social', false)
on conflict (key) do nothing;
