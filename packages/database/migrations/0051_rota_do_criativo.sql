-- 0051 · Rota de modelo do Criativo de texto (A4, X6; critério A4-11; ADR-006 item 8; `evals/README.md`).
-- Regra do produto: modelo só entra numa tarefa depois de passar no eval dela. A tarefa `criativo_texto` passou no
-- portão na rodada com modelo de verdade de 05/10/2026 (Sonnet 5.5, esforço baixo, só nos Estados Unidos: D-A3-13),
-- 25 de 25 em duas rodadas seguidas, e a rota entra com essa nota. A finalidade é `texto` (texto criativo, ADR-016).
-- Sem reserva e sem modelo econômico: nenhum outro modelo tem eval aprovado nesta tarefa; com o principal fora do ar, o
-- pedido de peças fecha como `falhou`, com o motivo, e a pessoa pede de novo. O limite de saída é o da rodada do eval; o
-- teto de custo é o de UMA chamada (um pedido de até quatro peças), com folga sobre o que a rodada mediu.
-- Nada muda para ninguém com esta migration: as flags `ia` e `criativo` continuam desligadas para todos, e a rota só é
-- usada na empresa em que a distribuição ligar as duas (comando `ligar-flag`).
-- Idempotente. Se a tarefa já tiver outra rota ativa (um banco de desenvolvimento com rota de teste), esta entra como
-- rascunho, sem tirar a que está valendo; em produção não há rota nenhuma, e ela entra ativa.
-- Uma transação por arquivo (ADR-018).

-- As rotas são da distribuição, em tabela com RLS forçada (V20).
select set_config('app.scope', 'sistema', true);

insert into liame.ai_model_route (id, task, version, status, purpose, provider, model, effort, max_output_tokens, timeout_ms,
                                  max_cost_usd_micros, fallback, eval_threshold, eval_score, created_by, deployed_at)
select v.id::uuid, v.task, 1, case when o.task is null then 'ativa' else 'rascunho' end, v.purpose, 'anthropic', 'claude-sonnet-5-5', 'low',
       v.max_output_tokens, v.timeout_ms, v.max_cost_usd_micros, '[]'::jsonb, 0.95, v.eval_score,
       'distribuição: eval de 05/10/2026 (migration 0051)', case when o.task is null then now() end
  from (values
    ('0199a301-0000-7000-8000-000000000006', 'criativo_texto', 'texto', 2000, 60000, 40000, 1.0000)
  ) as v(id, task, purpose, max_output_tokens, timeout_ms, max_cost_usd_micros, eval_score)
  left join (select distinct task from liame.ai_model_route where status = 'ativa') o on o.task = v.task
on conflict do nothing;
