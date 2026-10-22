-- 0079 · As sugestões de resposta às avaliações, pelo Social media (A6, Z6, parte 2; `plano-a6.md` D-A6-26 a D-A6-30;
-- protótipo P31, aprovado em 21/10/2026). Para cada avaliação nova sem resposta dos últimos 30 dias, o Social media
-- escreve uma ou duas sugestões, o código confere cada uma, e as que passam vão num pedido só em Aprovações (a
-- ferramenta `avaliacao_responder`), onde uma pessoa escolhe, ajusta e aprova com o código do app. Esta tabela guarda
-- onde cada avaliação está nesse caminho, para a rotina retomar de onde parou e para a tela Avaliações dizer a verdade
-- (sendo escrita, esperando em Aprovações, barrada pela conferência, o limite de IA).
-- O que fica aqui: a situação, o porquê em código, o que a conferência barrou (só os nomes das regras) e o pedido que
-- saiu. NENHUM texto: o texto das sugestões que passaram fica no pedido (`action_request.params`), e o que a
-- conferência barrou não é guardado. Nenhum dado de quem avaliou: o nome dele o Liame não guarda (D-A6-29).
-- Nada usa esta tabela enquanto a função `respostas_sugeridas` estiver desligada.
-- Idempotente; uma transação por arquivo (ADR-018).

-- A semente da flag grava em tabela com RLS forçada (V20).
select set_config('app.scope', 'sistema', true);

create table if not exists liame.review_suggestion (
  id                uuid primary key,
  tenant_id         uuid not null references liame.organization (id) on delete cascade,
  brand_id          uuid not null references liame.brand (id) on delete cascade,
  -- A avaliação: a linha sai com ela (a avaliação tem a guarda de 12 meses dela).
  review_id         uuid not null references liame.profile_review (id) on delete cascade,
  -- 1: as sugestões da avaliação nova; 2: as do "Pedir outras", uma vez por avaliação (D-A6-27).
  round             smallint not null default 1 check (round in (1, 2)),
  -- Onde a avaliação está:
  --   `esperando`   na fila do Social media (também quando a função, a IA ou ele estão desligados, ou no limite de IA:
  --                 o porquê fica em `reason`, e a vez volta mais tarde, sem contar tentativa);
  --   `pronta`      o pedido com as sugestões que passaram está em Aprovações;
  --   `barrada`     a conferência não deixou passar nenhuma sugestão (nada foi para Aprovações);
  --   `descartada`  não vai ter sugestão (já respondida, antiga, com pedido de uma pessoa, sumiu do Google…);
  --   `falhou`      não deu para chamar a IA ou criar o pedido, depois das tentativas;
  --   `retirada`    o pedido saiu de Aprovações porque a avaliação mudou ou foi respondida direto no Google.
  status            text not null default 'esperando' check (status in ('esperando', 'pronta', 'barrada', 'descartada', 'falhou', 'retirada')),
  -- O porquê (`ia_teto`, `funcao_desligada`, `respondida`, `antiga`, `ia_fora_do_ar`…): o código, não o texto do erro.
  reason            text check (reason ~ '^[a-z_]{2,40}$'),
  -- O que a conferência apontou quando barrou: só os nomes das regras, nunca o texto barrado.
  -- (O tamanho é conferido à parte: a expressão regular do Postgres não aceita repetição acima de 255.)
  barred_by         text[] check (barred_by is null or (cardinality(barred_by) between 1 and 20 and array_to_string(barred_by, ',') ~ '^[a-z_,]+$' and length(array_to_string(barred_by, ',')) <= 840)),
  -- Quantas sugestões foram para o pedido (uma ou duas, D-A6-26).
  suggestions       smallint check (suggestions between 1 and 2),
  -- O pedido em Aprovações que saiu desta linha.
  action_id         uuid references liame.action_request (id) on delete set null,
  usage_id          uuid references liame.ai_usage (id),
  attempts          integer not null default 0 check (attempts >= 0),
  next_attempt_at   timestamptz,
  -- Quem pediu outras sugestões (a rodada 2); nulo na rodada 1, que é da rotina.
  requested_by      uuid references liame.app_user (id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  finished_at       timestamptz,
  -- Uma linha por avaliação e por rodada: a rotina que roda duas vezes não sugere em dobro.
  constraint review_suggestion_rodada unique (review_id, round),
  -- A que está em Aprovações diz quantas sugestões foram; a barrada diz o que barrou.
  constraint review_suggestion_pronta check (status <> 'pronta' or suggestions is not null),
  constraint review_suggestion_barrada check ((status = 'barrada') = (barred_by is not null)),
  -- Quem acabou tem a hora em que acabou; quem espera, não.
  constraint review_suggestion_fim check ((finished_at is not null) = (status <> 'esperando'))
);
create index if not exists idx_review_suggestion_tenant on liame.review_suggestion (tenant_id);
create index if not exists idx_review_suggestion_brand on liame.review_suggestion (brand_id, created_at desc);
-- A fila da rotina: as que esperam a vez.
create index if not exists idx_review_suggestion_fila on liame.review_suggestion (next_attempt_at) where status = 'esperando';
-- O pedido em Aprovações é de uma linha só.
create unique index if not exists uq_review_suggestion_pedido on liame.review_suggestion (action_id) where action_id is not null;

-- ------------------------------------------------------------ RLS e grants

alter table liame.review_suggestion enable row level security;
alter table liame.review_suggestion force row level security;
drop policy if exists review_suggestion_isolamento on liame.review_suggestion;
create policy review_suggestion_isolamento on liame.review_suggestion
  using (tenant_id = liame.current_tenant_id() or liame.system_scope())
  with check (tenant_id = liame.current_tenant_id() or liame.system_scope());
grant select, insert, update on liame.review_suggestion to liame_app;

-- ------------------------------------------------------------ a função

-- Liga, por empresa, as sugestões de resposta do Social media (D-A6-30). Nasce desligada. Depende também da IA (`ia`)
-- e da resposta pelo Liame (`perfil_google_write`), que o código confere, e do Social media ativo na marca. Não
-- publica nada sozinha: a resposta só sai com a aprovação de uma pessoa, com o código do app (a de 1 ou 2 estrelas,
-- só do dono; D-A6-4).
insert into liame.feature_flag (key, kind, default_value, description, owner, is_write)
values ('respostas_sugeridas', 'boolean', 'false', 'Social media: sugestões de resposta às avaliações do perfil no Google, escritas pela IA e conferidas pelo código, num pedido para uma pessoa escolher, ajustar e aprovar (A6, Z6)', 'social', false)
on conflict (key) do nothing;
