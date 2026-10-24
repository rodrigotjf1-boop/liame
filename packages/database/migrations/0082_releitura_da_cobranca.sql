-- 0082 · A releitura da cobrança no Asaas (A7, W2a, parte 2; `plano-a7.md` D-A7-28 a D-A7-30; `base-conhecimento.md`
-- §18.5). O aviso do Asaas só marca a fatura para reler; a rotina do worker relê a cobrança na API e decide: paga,
-- cobrança removida, valor que mudou no Liame, fatura cancelada no Liame. A fila usa as colunas da 0081: depois que a
-- cobrança existe, a `charge_next_at` é a próxima releitura (na hora, quando chega um aviso; senão, uma vez por dia), e
-- a `charge_locked_until` é a trava da vez, como na criação.
-- Só o índice da fila nova: nenhuma tabela, coluna ou dado muda. Idempotente; uma transação por arquivo (ADR-018).

-- A fila da releitura: as faturas que já têm a cobrança no meio de pagamento e uma próxima vez marcada.
create index if not exists idx_billing_invoice_a_reler on liame.billing_invoice (charge_next_at)
  where external_id is not null and charge_next_at is not null;
