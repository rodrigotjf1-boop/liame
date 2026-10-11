-- 0065 · O dia em que as datas do cupom da mensagem foram fixadas (A5, Y6; decisão do dono em 10/10/2026: o cupom de
-- cada mensagem vale por tantos dias, contando o dia do envio).
-- O pedido de mensagem nasce dias antes do envio (a Meta analisa o modelo, uma pessoa aprova o pedido), e o texto da
-- mensagem diz a validade em dias ("válido por 2 dias, contando hoje"). Por isso as datas de verdade do cupom só
-- existem no dia em que a mensagem sai: na primeira tentativa de envio, elas são contadas daquele dia, gravadas no
-- pedido (`coupon_rule`) e marcadas aqui. As tentativas seguintes usam a regra gravada: a chave de idempotência do
-- cupom no Regem sai da regra, e mudar as datas no meio criaria um segundo pedido de cupom com o mesmo código.
-- Nulo = as datas ainda não foram fixadas (o pedido espera a aprovação, ou é de antes desta migration).
-- Nenhum dado de cliente. Idempotente; uma transação por arquivo (ADR-018).

alter table liame.message_request add column if not exists coupon_dated_on date;

-- Só o pedido que leva cupom tem a data dele fixada.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'message_request_cupom_datado' and conrelid = 'liame.message_request'::regclass) then
    alter table liame.message_request add constraint message_request_cupom_datado check (coupon_dated_on is null or coupon_rule is not null);
  end if;
end $$;
