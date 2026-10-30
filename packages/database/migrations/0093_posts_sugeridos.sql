-- 0093 · Os posts do Social media, parte 2: a vez de cada dia da pauta (A6, Z6, os posts; `plano-a6.md` D-A6-58 a
-- D-A6-60; protótipo P21, aprovado em 21/10/2026). Para cada dia da pauta aprovada que tem item (o "nada novo" fica de
-- fora), amanhã e depois de amanhã no fuso da empresa, o Social media escreve o post (o texto de cada canal e a foto
-- escolhida entre as Fotos da marca), o código confere, e o que passa vira o post na Agenda e o pedido em Aprovações (a
-- ferramenta `post_publicar`), onde uma pessoa aprova com o código do app. Esta tabela guarda onde cada dia está nesse
-- caminho, para a rotina retomar de onde parou, não propor duas vezes o mesmo dia e a ficha dele dizer a verdade.
-- O que fica aqui: o dia, o plano de onde o item veio, a situação, o porquê em código, o que a conferência barrou (só os
-- nomes das regras), o post e o pedido que saíram. NENHUM texto: o do post fica no post (`social_post_channel.body`), e o
-- que a conferência barrou não é guardado. Nada usa esta tabela enquanto a função `posts_sugeridos` estiver desligada.
-- Idempotente; uma transação por arquivo (ADR-018).

-- A semente da flag grava em tabela com RLS forçada (V20).
select set_config('app.scope', 'sistema', true);

create table if not exists liame.post_suggestion (
  id                uuid primary key,
  tenant_id         uuid not null references liame.organization (id) on delete cascade,
  brand_id          uuid not null references liame.brand (id) on delete cascade,
  -- O plano de pauta aprovado de onde o item do dia veio, quando a vez abriu (o mais novo que cobria o dia).
  plan_id           uuid references liame.plan (id) on delete set null,
  -- O dia do post, no fuso da empresa.
  day               date not null,
  -- Onde o dia está:
  --   `esperando`   na fila do Social media (também quando a função, a IA ou ele estão desligados, sem rede conectada,
  --                 sem Fotos ou no limite de IA: o porquê fica em `reason`, e a vez volta mais tarde, sem contar
  --                 tentativa);
  --   `pronta`      o post está na Agenda e o pedido, em Aprovações;
  --   `barrada`     a conferência barrou o que ele escreveu (nada foi para Aprovações);
  --   `descartada`  não vai ter post dele (o dia passou, ganhou post de uma pessoa, a pauta mudou, nenhuma foto combina…);
  --   `falhou`      não deu para chamar a IA ou criar o post, depois das tentativas.
  status            text not null default 'esperando' check (status in ('esperando', 'pronta', 'barrada', 'descartada', 'falhou')),
  -- O porquê (`ia_teto`, `funcao_desligada`, `sem_canal`, `sem_fotos`, `sem_foto`, `dia_passou`…): o código, não o texto.
  reason            text check (reason ~ '^[a-z_]{2,40}$'),
  -- O que a conferência apontou quando barrou: só os nomes das regras, nunca o texto barrado.
  -- (O tamanho é conferido à parte: a expressão regular do Postgres não aceita repetição acima de 255.)
  barred_by         text[] check (barred_by is null or (cardinality(barred_by) between 1 and 20 and array_to_string(barred_by, ',') ~ '^[a-z_,]+$' and length(array_to_string(barred_by, ',')) <= 840)),
  -- O post na Agenda e o pedido em Aprovações que saíram desta linha.
  post_id           uuid references liame.social_post (id) on delete set null,
  action_id         uuid references liame.action_request (id) on delete set null,
  usage_id          uuid references liame.ai_usage (id),
  attempts          integer not null default 0 check (attempts >= 0),
  next_attempt_at   timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  finished_at       timestamptz,
  -- Uma vez por dia e por marca: a rotina que roda duas vezes não propõe em dobro, e o dia recusado não volta.
  constraint post_suggestion_dia unique (brand_id, day),
  -- A barrada diz o que barrou.
  constraint post_suggestion_barrada check ((status = 'barrada') = (barred_by is not null)),
  -- Quem acabou tem a hora em que acabou; quem espera, não.
  constraint post_suggestion_fim check ((finished_at is not null) = (status <> 'esperando'))
);
create index if not exists idx_post_suggestion_tenant on liame.post_suggestion (tenant_id);
create index if not exists idx_post_suggestion_brand on liame.post_suggestion (brand_id, day desc);
-- A fila da rotina: os dias que esperam a vez.
create index if not exists idx_post_suggestion_fila on liame.post_suggestion (next_attempt_at) where status = 'esperando';
-- O pedido em Aprovações e o post são de uma linha só.
create unique index if not exists uq_post_suggestion_pedido on liame.post_suggestion (action_id) where action_id is not null;
create unique index if not exists uq_post_suggestion_post on liame.post_suggestion (post_id) where post_id is not null;

-- ------------------------------------------------------------ RLS e grants

alter table liame.post_suggestion enable row level security;
alter table liame.post_suggestion force row level security;
drop policy if exists post_suggestion_isolamento on liame.post_suggestion;
create policy post_suggestion_isolamento on liame.post_suggestion
  using (tenant_id = liame.current_tenant_id() or liame.system_scope())
  with check (tenant_id = liame.current_tenant_id() or liame.system_scope());
grant select, insert, update on liame.post_suggestion to liame_app;

-- ------------------------------------------------------------ a função

-- Liga, por empresa, os posts do Social media (D-A6-60). Nasce desligada. Depende também da IA (`ia`) e da publicação
-- pelo Liame (`social_write`), que o código confere, e do Social media ativo na marca. Não publica nada sozinha: o post
-- só sai com a aprovação de uma pessoa, com o código do app.
insert into liame.feature_flag (key, kind, default_value, description, owner, is_write)
values ('posts_sugeridos', 'boolean', 'false', 'Social media: o post de cada dia da pauta aprovada (o texto de cada canal e a foto escolhida entre as Fotos), escrito pela IA e conferido pelo código, num pedido para uma pessoa aprovar com o código do app (A6, Z6)', 'social', false)
on conflict (key) do nothing;
