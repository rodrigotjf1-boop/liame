-- 0084 · Rota de modelo do Social media nas respostas às avaliações (A6, Z6; critério A6-12, o portão da função;
-- ADR-006 item 8; `evals/README.md`). Regra do produto: modelo só entra numa tarefa depois de passar no eval dela. A tarefa
-- `social_resposta` passou no portão na rodada com modelo de verdade de 29/10/2026 (Sonnet 5.5, esforço baixo, só nos
-- Estados Unidos: D-A3-13), 26 de 26 com o prompt `social.resposta` v3, e a rota entra com essa nota. A finalidade é
-- `texto` (texto criativo, ADR-016), como a do Criativo e a do CRM. Sem reserva e sem modelo econômico: o Haiku 5.5
-- reprovou na mesma rodada (grupo `injecao`). O limite de saída é o da rodada do eval; o teto de custo é o de UMA
-- chamada (as sugestões de uma avaliação), com folga sobre o que a rodada mediu (perto de US$ 0,01 por avaliação).
-- Nada muda para ninguém com esta migration: a função `respostas_sugeridas` continua desligada para todos, e a rotina
-- só chama o modelo na empresa em que a distribuição ligar a função (comando `ligar-flag`), com a IA, a resposta pelo
-- Liame e o Social media ligados na marca (D-A6-30).
-- Idempotente. Se a tarefa já tiver outra rota ativa (um banco de desenvolvimento com rota de teste), esta entra como
-- rascunho, sem tirar a que está valendo; em produção não há rota nenhuma, e ela entra ativa.
-- Uma transação por arquivo (ADR-018).

-- As rotas são da distribuição, em tabela com RLS forçada (V20).
select set_config('app.scope', 'sistema', true);

insert into liame.ai_model_route (id, task, version, status, purpose, provider, model, effort, max_output_tokens, timeout_ms,
                                  max_cost_usd_micros, fallback, eval_threshold, eval_score, created_by, deployed_at)
select v.id::uuid, v.task, 1, case when o.task is null then 'ativa' else 'rascunho' end, v.purpose, 'anthropic', 'claude-sonnet-5-5', 'low',
       v.max_output_tokens, v.timeout_ms, v.max_cost_usd_micros, '[]'::jsonb, 0.95, v.eval_score,
       'distribuição: eval de 29/10/2026 (migration 0084)', case when o.task is null then now() end
  from (values
    ('019a2e00-0000-7000-8000-000000000008', 'social_resposta', 'texto', 1500, 60000, 40000, 1.0000)
  ) as v(id, task, purpose, max_output_tokens, timeout_ms, max_cost_usd_micros, eval_score)
  left join (select distinct task from liame.ai_model_route where status = 'ativa') o on o.task = v.task
on conflict do nothing;
