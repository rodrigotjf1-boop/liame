-- 0127 · Rota de modelo do Social media no tipo do comentário (A6, Z11, parte 2d-4b; D-A6-87 e D-A6-101; critério A6-12,
-- o portão da função; ADR-006 item 8; `evals/README.md`). Regra do produto: modelo só entra numa tarefa depois de passar
-- no eval dela, e a regra dos testes pede duas rodadas aprovadas. A tarefa `social_comentario_tipo` rodou em 10/11/2026,
-- com o gasto autorizado pelo dono (teto de US$ 0,50): o Haiku 5.5 passou nas duas rodadas (24 de 24 nas duas) e o
-- Sonnet 5.5 na primeira (24 de 24), esforço baixo, só nos Estados Unidos (D-A3-13). Pela D-A6-87 ("a IA, com o modelo
-- econômico"), entra o mais barato que passou nas duas: o **Haiku 5.5** é o modelo da rota, sem reserva (o tipo que não
-- sai fica para a próxima volta da rotina) e sem modelo econômico (ele já é o econômico). A finalidade é `analise`
-- (classificar, não escrever: ADR-016). O limite de saída é o da rodada (a resposta é uma palavra); o teto de custo é o
-- de UMA chamada, com folga sobre o que a rodada mediu (perto de US$ 0,0002 por comentário).
-- Nada muda para ninguém com esta migration: nenhuma rotina chama a tarefa ainda (a rotina vem na parte 2d-4c, e só
-- anda na empresa com a função `comentarios_sugeridos` ligada).
-- Idempotente. Se a tarefa já tiver outra rota ativa (um banco de desenvolvimento com rota de teste), esta entra como
-- rascunho, sem tirar a que está valendo; em produção não há rota nenhuma, e ela entra ativa.
-- Uma transação por arquivo (ADR-018).

-- As rotas são da distribuição, em tabela com RLS forçada (V20).
select set_config('app.scope', 'sistema', true);

insert into liame.ai_model_route (id, task, version, status, purpose, provider, model, effort, max_output_tokens, timeout_ms,
                                  max_cost_usd_micros, fallback, eval_threshold, eval_score, created_by, deployed_at)
select v.id::uuid, v.task, 1, case when o.task is null then 'ativa' else 'rascunho' end, v.purpose, 'anthropic', 'claude-haiku-5-5', 'low',
       v.max_output_tokens, v.timeout_ms, v.max_cost_usd_micros, '[]'::jsonb, 0.95, v.eval_score,
       'distribuição: evals de 10/11/2026 (migration 0127)', case when o.task is null then now() end
  from (values
    ('019a4e00-0000-7000-8000-000000000001', 'social_comentario_tipo', 'analise', 300, 30000, 2000, 1.0000)
  ) as v(id, task, purpose, max_output_tokens, timeout_ms, max_cost_usd_micros, eval_score)
  left join (select distinct task from liame.ai_model_route where status = 'ativa') o on o.task = v.task
on conflict do nothing;

do $$
begin
  if not exists (select 1 from liame.ai_model_route where task = 'social_comentario_tipo' and created_by = 'distribuição: evals de 10/11/2026 (migration 0127)') then
    raise exception '0127: a rota do tipo do comentário não entrou';
  end if;
end $$;
