-- 0049 · A proposta de Sugerir para Aprovação (A4, X3 parte 2b; `plano-a4.md` §3 e as propostas D-A4-25 e D-A4-27).
-- A proposta de autonomia (0038) só conhecia um passo: de Sombra para Sugerir. Agora ela guarda também o segundo, de
-- Sugerir para Aprovação: o sistema propõe quando os cinco portões da sombra continuam passando e os pedidos mais
-- recentes que nasceram de uma recomendação foram aprovados sem erro; uma pessoa aprova, recusa ou, depois, volta um
-- passo. Uma proposta pendente por conta e ação continua valendo para os dois passos (o índice da 0038).
-- Sem a flag `modo_aprovacao` (0048), nenhuma proposta do segundo passo é criada. Idempotente; uma transação por
-- arquivo (ADR-018).

-- Os dois passos que existem. As checagens de coluna da 0038 (um modo só em cada ponta) dão lugar a uma do par.
alter table liame.autonomy_proposal drop constraint if exists autonomy_proposal_from_mode_check;
alter table liame.autonomy_proposal drop constraint if exists autonomy_proposal_to_mode_check;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'autonomy_proposal_passo_check' and conrelid = 'liame.autonomy_proposal'::regclass) then
    alter table liame.autonomy_proposal add constraint autonomy_proposal_passo_check
      check ((from_mode = 'SHADOW' and to_mode = 'SUGGEST') or (from_mode = 'SUGGEST' and to_mode = 'APPROVAL'));
  end if;
end $$;

-- No passo para a Aprovação, recusada, desfeita ou retirada: o sistema só propõe de novo quando a conta e a ação
-- tiverem este número de pedidos decididos (os nascidos de recomendação). No primeiro passo vale `next_sample_size`.
alter table liame.autonomy_proposal add column if not exists next_request_count integer;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'autonomy_proposal_next_request_count_check' and conrelid = 'liame.autonomy_proposal'::regclass) then
    alter table liame.autonomy_proposal add constraint autonomy_proposal_next_request_count_check
      check (next_request_count is null or next_request_count >= 0);
  end if;
end $$;

-- A última proposta de cada passo, por conta e ação (a rotina e a tela leem por aqui).
create index if not exists idx_autonomy_proposal_passo on liame.autonomy_proposal (connected_account_id, tool, to_mode, created_at desc);
