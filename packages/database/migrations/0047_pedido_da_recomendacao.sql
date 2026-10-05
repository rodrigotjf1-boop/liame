-- 0047 · O pedido que nasce de uma recomendação (A4, X3; `plano-a4.md` §3 e D-A4-27).
-- Em Sugerir, a recomendação do Gestor de tráfego aparece na Atenção e a pessoa pede a mudança. O pedido passa a
-- guardar de qual recomendação nasceu (`shadow_decision`): é com essa ligação que a tela de Aprovações mostra o
-- porquê do pedido (os números do retrato da recomendação) e que a prontidão para o modo Aprovação conta os pedidos
-- que a pessoa aprovou ou recusou. No pedido comum, a coluna fica nula e nada muda.
-- Idempotente; uma transação por arquivo (ADR-018).

alter table liame.action_request add column if not exists shadow_decision_id uuid;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'action_request_recomendacao_fk' and conrelid = 'liame.action_request'::regclass) then
    -- A recomendação apagada (a marca ou a conta saiu) não leva o pedido junto: ele fica, sem a ligação.
    alter table liame.action_request add constraint action_request_recomendacao_fk
      foreign key (shadow_decision_id) references liame.shadow_decision (id) on delete set null;
  end if;
end $$;

-- Os pedidos de uma recomendação, do mais novo para o mais antigo (a Atenção mostra o mais recente).
create index if not exists idx_action_request_recomendacao on liame.action_request (shadow_decision_id, created_at desc)
  where shadow_decision_id is not null;
