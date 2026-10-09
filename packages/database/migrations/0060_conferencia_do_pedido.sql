-- 0060 · A conferência que o Liame faz sozinho no pedido que espera (A5, Y5; `plano-a5.md` D-A5-12 e critério A5-12).
-- O pedido de envio de mensagem que tem um impedimento (o modelo ainda em análise na Meta, o custo acima do teto de
-- gasto de mensagens) espera em Aprovações. Até aqui, só uma pessoa conferia de novo, pelo botão. Agora a rotina do
-- worker lê o plano de agora de tempos em tempos e avisa quando o impedimento sai. A coluna guarda QUANDO a rotina
-- olhou o pedido pela última vez: é por ela que cada pedido é conferido uma vez por intervalo, e não a cada volta.
-- Nula no pedido que a rotina ainda não olhou. Nenhum outro caminho precisa mantê-la.
-- Idempotente; uma transação por arquivo (ADR-018).

alter table liame.action_request add column if not exists plan_checked_at timestamptz;
