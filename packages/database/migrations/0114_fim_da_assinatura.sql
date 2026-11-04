-- 0114 · O fim da assinatura, parte 4a: o dia em que os dados da marca são apagados (A7, W3; Termos 11.2; D-A7-106).
-- Aprovado pelo dono em 03/11/2026 ("pode fazer o fim da assinatura como recomendado"): 30 dias depois do fim da
-- assinatura paga (a cancelada, no fim do período pago; a desistência em 7 dias) ou da suspensão (o 60º dia de atraso), se
-- a marca segue sem assinatura paga, os dados dela são apagados; a empresa inteira, quando todas as marcas dela estão na
-- mesma situação. A assinatura que nunca teve o primeiro pagamento não apaga nada.
-- Duas mudanças na assinatura:
--   `purge_on`   o dia do apagamento (calendário da empresa), gravado quando a assinatura paga termina: o mais cedo entre
--                o fim + 30 dias e o 60º dia de atraso da mensalidade mais antiga em aberto. Gravado no fim, ele não se
--                perde quando as faturas são canceladas;
--   `atraso`     um motivo de fim novo: no 60º dia de atraso (o 30º da suspensão), a assinatura termina sozinha.
-- Nada muda para ninguém: a função `cobranca` segue desligada, e sem ela nenhuma assinatura existe nem termina.
-- Idempotente. Uma transação por arquivo (ADR-018).

alter table liame.subscription add column if not exists purge_on date;

-- O motivo do fim ganha `atraso` (o check da 0080 é o da coluna, com o nome que o Postgres deu a ele).
alter table liame.subscription drop constraint if exists subscription_end_reason_check;
alter table liame.subscription add constraint subscription_end_reason_check
  check (end_reason in ('cancelada', 'desistencia', 'nao_paga', 'substituida', 'atraso'));

-- O dia do apagamento só existe na assinatura paga que terminou.
alter table liame.subscription drop constraint if exists subscription_apagamento;
alter table liame.subscription add constraint subscription_apagamento
  check (purge_on is null or (status = 'encerrada' and first_paid_at is not null));

-- A rotina do apagamento procura pelo dia.
create index if not exists idx_subscription_apagamento on liame.subscription (purge_on) where purge_on is not null;
