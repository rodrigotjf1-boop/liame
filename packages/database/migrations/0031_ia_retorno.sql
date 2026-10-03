-- 0031 · Retorno da pessoa sobre uma explicação da IA (A3, I4; protótipo P4 aprovado em 02/10/2026).
-- "Fez sentido" ou "Discordo", com o motivo. Fica guardado no Liame, ligado à chamada que gerou a explicação
-- (`ai_usage`), para revisar os funcionários de IA e alimentar os evals. Nunca é enviado ao fornecedor do
-- modelo (base §11: avaliação enviada pela API do fornecedor fica 5 anos e pode ir para treino). O texto
-- livre é limpo de dado pessoal antes de gravar. A pessoa grava só o retorno dela, sobre uma explicação
-- que ela mesma pediu. Idempotente; uma transação por arquivo (ADR-018).

create table if not exists liame.ai_feedback (
  id          uuid primary key,
  tenant_id   uuid not null references liame.organization (id) on delete cascade,
  -- A chamada que gerou a explicação que foi para a tela.
  usage_id    uuid not null references liame.ai_usage (id) on delete cascade,
  user_id     uuid references liame.app_user (id) on delete set null,
  verdict     text not null check (verdict in ('fez_sentido', 'discordo')),
  -- Só no "discordo": `numero` (um número está errado), `motivo` (o motivo não é esse), `faltou` (faltou
  -- algo importante), `sugestao` (a sugestão não serve para a loja).
  reasons     text[] not null default '{}' check (reasons <@ array['numero', 'motivo', 'faltou', 'sugestao']::text[] and cardinality(reasons) <= 4),
  comment     text check (length(comment) between 1 and 500),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  check (verdict = 'discordo' or (cardinality(reasons) = 0 and comment is null))
);
-- Um retorno por pessoa e explicação: mudar de ideia regrava a mesma linha.
create unique index if not exists uq_ai_feedback_pessoa on liame.ai_feedback (usage_id, user_id);
create index if not exists idx_ai_feedback_tenant on liame.ai_feedback (tenant_id, created_at);

alter table liame.ai_feedback enable row level security;
alter table liame.ai_feedback force row level security;
-- A empresa lê os retornos dela; cada pessoa grava só em nome dela.
drop policy if exists ai_feedback_isolamento on liame.ai_feedback;
create policy ai_feedback_isolamento on liame.ai_feedback
  using (tenant_id = liame.current_tenant_id() or liame.system_scope())
  with check ((tenant_id = liame.current_tenant_id() and user_id = liame.current_user_id()) or liame.system_scope());
-- E só regrava o próprio retorno.
drop policy if exists ai_feedback_so_o_proprio on liame.ai_feedback;
create policy ai_feedback_so_o_proprio on liame.ai_feedback as restrictive for update
  using (user_id = liame.current_user_id() or liame.system_scope());
grant select, insert, update on liame.ai_feedback to liame_app;
