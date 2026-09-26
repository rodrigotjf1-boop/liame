-- 0014 · Contexto de rastreio (W3C traceparent) guardado no pedido de ação e no evento, para o
-- worker continuar o mesmo trace da requisição (ADR-010: um trace_id de ponta a ponta).
-- Idempotente; uma transação por arquivo (ADR-018).

alter table liame.action_request add column if not exists trace_context text check (trace_context ~ '^[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$');
alter table liame.outbox_event add column if not exists trace_context text check (trace_context ~ '^[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$');
