-- 0045 · A volta de uma ação (A4, X2): o pedido que desfaz outro.
-- (1) `action_request.compensates_action_id`: a ação que este pedido desfaz. A volta é um pedido comum (passa pela
--     trava, pela política, pela reserva, pela aprovação com o código do app, pela validação e pela escrita), ligado
--     ao pedido que desfaz. Só é aceita se o objeto está como a ação o deixou; isso é conferido pelo serviço, na hora
--     do pedido e de novo na execução.
-- (2) Uma volta viva por ação: enquanto houver uma esperando aprovação, aprovada, em execução ou executada, não
--     entra outra. A volta cancelada, recusada, expirada ou que falhou não impede a seguinte.
-- Idempotente; uma transação por arquivo (ADR-018).

alter table liame.action_request add column if not exists compensates_action_id uuid;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'action_request_compensates_fk' and conrelid = 'liame.action_request'::regclass) then
    alter table liame.action_request add constraint action_request_compensates_fk
      foreign key (compensates_action_id) references liame.action_request (id) on delete set null;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'action_request_compensates_check' and conrelid = 'liame.action_request'::regclass) then
    alter table liame.action_request add constraint action_request_compensates_check check (compensates_action_id is null or compensates_action_id <> id);
  end if;
end $$;

create unique index if not exists uq_action_volta_viva on liame.action_request (compensates_action_id)
  where compensates_action_id is not null and status in ('aguardando_aprovacao', 'aprovada', 'executando', 'executada');
create index if not exists idx_action_request_volta on liame.action_request (compensates_action_id) where compensates_action_id is not null;
