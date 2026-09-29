-- 0025 · Emendas do contrato v1 do Regem (A2.5, F4; docs/integracoes/regem.md, leitura do código do Regem
-- de 29/09/2026): a venda que deixa de existir sozinha (`removido`, comanda que virou parte de um pedido),
-- o instante que o Painel usa para pôr a venda no dia (`faturado_em` → `billed_at`) e o cupom apagado na
-- origem (lápide). Idempotente; uma transação por arquivo (ADR-018).

-- ------------------------------------------------------------ pedido removido e dia da receita

alter table liame.order_fact drop constraint if exists order_fact_status_check;
alter table liame.order_fact add constraint order_fact_status_check check (status in ('confirmado', 'cancelado', 'removido'));
-- O dia da receita é o do Painel do Regem (critério A2.5-2): pedido pela criação, comanda pelo fechamento.
-- Nulo = o de `confirmed_at`. A janela da atribuição continua contando até `confirmed_at`.
alter table liame.order_fact add column if not exists billed_at timestamptz;

-- O motivo "removido" no resultado da atribuição (a venda saiu das contas sem ser cancelada).
alter table liame.attribution_result drop constraint if exists attribution_result_reason_check;
alter table liame.attribution_result add constraint attribution_result_reason_check
  check (reason in ('sem_evidencia', 'fora_da_janela', 'canal_sem_clique', 'sem_id', 'cancelado', 'removido'));

-- ------------------------------------------------------------ cupom apagado na origem

-- Lápide: o cupom some da lista e deixa de ligar a campanhas; o histórico de atribuição fica.
alter table liame.coupon add column if not exists removed_at timestamptz;
