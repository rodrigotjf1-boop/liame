-- 0146 · Hub DMS (F5, parte D): o Liame pede o disparo ao RegemCast e espera o destino.
-- Na mensagem cuja aprovação é do destino (decisão F5-9), o Liame não pede a própria aprovação: ele monta a campanha
-- em rascunho, cria o cupom e pede o disparo ao RegemCast (`campanha_disparo_pedir`), onde uma pessoa da conta aprova
-- com o código do aplicativo autenticador e o teto de gasto. O Liame mostra "esperando o destino", com o prazo e o
-- link da tela de lá, e acompanha o pedido (`acao_pedido_ler`). Recusado, vencido, cancelado ou falhou: o cupom que
-- nasceu para a mensagem é desativado no Regem (decisão F5-5).
-- - a flag `regemcast_pede_ao_destino`, por empresa, desligada: com ela, a conta do RegemCast ligada pela autorização
--   por clique grava (rascunho, pedido, pausa) e o envio vai como pedido ao destino. É de escrita;
-- - no `message_request`, o pedido no destino: o id, a situação, o prazo, o link, o motivo e quando ler de novo; e
--   quando o cupom foi desativado.
-- Idempotente; uma transação por arquivo (ADR-018). Sem instrução destrutiva (V52).

-- A semente em tabela com RLS forçada pede o escopo de sistema (V20).
select set_config('app.scope', 'sistema', true);

insert into liame.feature_flag (key, kind, default_value, description, owner, is_write)
values ('regemcast_pede_ao_destino', 'boolean', 'false', 'Hub DMS (F5, D): na conta do RegemCast ligada por clique, o envio de mensagem vai como pedido ao RegemCast, aprovado lá por uma pessoa da conta (o Liame não pede a própria aprovação); da distribuição', 'hub_dms', true)
on conflict (key) do nothing;

alter table liame.message_request add column if not exists destination_request_id text;
alter table liame.message_request add column if not exists destination_status text;
alter table liame.message_request add column if not exists destination_expires_at timestamptz;
alter table liame.message_request add column if not exists destination_url text;
alter table liame.message_request add column if not exists destination_reason text;
alter table liame.message_request add column if not exists destination_requested_at timestamptz;
alter table liame.message_request add column if not exists destination_checked_at timestamptz;
alter table liame.message_request add column if not exists destination_next_check_at timestamptz;
alter table liame.message_request add column if not exists coupon_deactivated_at timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'message_request_destino_situacao' and conrelid = 'liame.message_request'::regclass) then
    alter table liame.message_request add constraint message_request_destino_situacao check (
      destination_status is null
      or destination_status in ('aguardando', 'aprovado', 'executando', 'executado', 'recusado', 'vencido', 'cancelado', 'falhou'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'message_request_destino_inteiro' and conrelid = 'liame.message_request'::regclass) then
    alter table liame.message_request add constraint message_request_destino_inteiro check ((destination_request_id is null) = (destination_status is null));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'message_request_destino_tamanhos' and conrelid = 'liame.message_request'::regclass) then
    alter table liame.message_request add constraint message_request_destino_tamanhos check (
      (destination_request_id is null or length(destination_request_id) between 1 and 100)
      and (destination_url is null or (destination_url ~ '^https://' and length(destination_url) <= 500))
      and (destination_reason is null or length(destination_reason) <= 600));
  end if;
end $$;

-- A rotina que acompanha o pedido: o que ainda espera e está na hora de ler.
create index if not exists idx_message_request_destino_a_ler on liame.message_request (destination_next_check_at)
  where destination_status in ('aguardando', 'aprovado', 'executando');
-- O aviso do destino (`acao.alterada`) traz só o id do pedido.
create index if not exists idx_message_request_destino_id on liame.message_request (destination_request_id)
  where destination_request_id is not null;
