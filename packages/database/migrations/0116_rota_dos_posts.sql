-- 0116 · Rota de modelo do Social media nos posts dos dias da pauta (A6, Z6, os posts; critério A6-12, o portão da
-- função; ADR-006 item 8; `evals/README.md`). Regra do produto: modelo só entra numa tarefa depois de passar no eval
-- dela, e a regra dos testes pede duas rodadas aprovadas (uma só não mede a variação). A tarefa `social_post` passou nas
-- duas rodadas com modelo de verdade de 04/11/2026, autorizadas pelo dono ("pode"): Sonnet 5.5, esforço baixo, só nos
-- Estados Unidos (D-A3-13), 21 de 21 nas duas, com o prompt `social.post` que está no ar. A rota entra com essa nota. A
-- finalidade é `texto` (texto criativo, ADR-016), como a do Criativo, a do CRM e a das respostas às avaliações. Sem
-- reserva e sem modelo econômico: o Haiku 5.5 passou raspando na primeira rodada (20 de 21) e reprovou na segunda (19 de
-- 21), as duas vezes por citar um link no post que não tem link (a conferência da produção barra esse post). O limite de
-- saída é o da rodada do eval; o teto de custo é o de UMA chamada (o post de um dia), com folga sobre o que a rodada
-- mediu (perto de US$ 0,009 por post).
-- Nada muda para ninguém com esta migration: as funções `posts_sugeridos` e `social_write` continuam desligadas para
-- todos, e a rotina só chama o modelo na empresa em que a distribuição ligar as duas (comando `ligar-flag`), com a IA
-- ligada e o Social media ativo na marca.
-- Idempotente. Se a tarefa já tiver outra rota ativa (um banco de desenvolvimento com rota de teste), esta entra como
-- rascunho, sem tirar a que está valendo; em produção não há rota nenhuma, e ela entra ativa.
-- Uma transação por arquivo (ADR-018).

-- As rotas são da distribuição, em tabela com RLS forçada (V20).
select set_config('app.scope', 'sistema', true);

insert into liame.ai_model_route (id, task, version, status, purpose, provider, model, effort, max_output_tokens, timeout_ms,
                                  max_cost_usd_micros, fallback, eval_threshold, eval_score, created_by, deployed_at)
select v.id::uuid, v.task, 1, case when o.task is null then 'ativa' else 'rascunho' end, v.purpose, 'anthropic', 'claude-sonnet-5-5', 'low',
       v.max_output_tokens, v.timeout_ms, v.max_cost_usd_micros, '[]'::jsonb, 0.95, v.eval_score,
       'distribuição: evals de 04/11/2026 (migration 0116)', case when o.task is null then now() end
  from (values
    ('019a4c00-0000-7000-8000-000000000001', 'social_post', 'texto', 1500, 60000, 40000, 1.0000)
  ) as v(id, task, purpose, max_output_tokens, timeout_ms, max_cost_usd_micros, eval_score)
  left join (select distinct task from liame.ai_model_route where status = 'ativa') o on o.task = v.task
on conflict do nothing;

do $$
begin
  if not exists (select 1 from liame.ai_model_route where task = 'social_post' and created_by = 'distribuição: evals de 04/11/2026 (migration 0116)') then
    raise exception '0116: a rota dos posts não entrou';
  end if;
end $$;
