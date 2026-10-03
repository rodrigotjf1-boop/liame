-- 0036 · Planos agendados do Estrategista (A3, I11b; protótipo P8, aguardando aprovação).
-- Na segunda-feira de manhã, no fuso da loja, a rotina do worker pede ao Estrategista a pauta da semana e, a cada
-- 12 semanas, o plano de 90 dias, como uma demanda aberta pela própria rotina (sem pessoa: `requested_by` nulo). A
-- chave da rotina (`pauta:2026-10-05`, `noventa_dias:2026-10-05`) faz a mesma segunda pedir uma vez só, mesmo com
-- dois workers ou o laço repetindo (V24). A fila e a conferência são as da demanda que a LIA registra.
-- Idempotente; uma transação por arquivo (ADR-018).

alter table liame.demand add column if not exists routine_key text check (routine_key ~ '^[a-z_]+:\d{4}-\d{2}-\d{2}$');
create unique index if not exists uq_demand_rotina on liame.demand (brand_id, routine_key) where routine_key is not null;
