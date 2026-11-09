-- 0126 · Rota de modelo do Social media nas respostas aos comentários (A6, Z11, parte 2d; critério A6-12, o portão da
-- função; ADR-006 item 8; `evals/README.md`). Regra do produto: modelo só entra numa tarefa depois de passar no eval
-- dela, e a regra dos testes pede duas rodadas aprovadas (uma só não mede a variação). A tarefa `social_comentario`
-- passou nas duas rodadas com modelo de verdade de 09/11/2026, autorizadas pelo dono (abaixo de US$ 1): Sonnet 5.5,
-- esforço baixo, só nos Estados Unidos (D-A3-13), 24 de 24 nas duas, com o prompt `social.comentario` versão 2. A
-- versão 1 reprovou na rodada de 08/11 (19 de 24: na reclamação, um caminho sem desculpa e com propaganda da casa; na
-- pergunta de cupom, a palavra escrita para negar, que a conferência da produção barra); a 2 corrigiu as duas regras.
-- A rota entra com essa nota. A finalidade é `texto` (texto criativo, ADR-016), como a das respostas às avaliações e a
-- dos posts. Sem reserva e sem modelo econômico: o volume é pequeno (uma chamada por pergunta ou reclamação, só quando
-- a função está ligada), e o Haiku 5.5 não foi medido nesta tarefa. O limite de saída é o da rodada do eval; o teto de
-- custo é o de UMA chamada (as sugestões de um comentário), com folga sobre o que a rodada mediu (perto de US$ 0,01).
-- Nada muda para quem não ligou: a rotina só chama o modelo na empresa com as funções `comentarios_sugeridos` e
-- `comentarios_responder` ligadas (comando `ligar-flag`), a IA ligada e o Social media ativo na marca; o pedido vai a
-- Aprovações e nada sai sem a aprovação com o código.
-- Idempotente. Se a tarefa já tiver outra rota ativa (um banco de desenvolvimento com rota de teste), esta entra como
-- rascunho, sem tirar a que está valendo; em produção não há rota nenhuma, e ela entra ativa.
-- Uma transação por arquivo (ADR-018).

-- As rotas são da distribuição, em tabela com RLS forçada (V20).
select set_config('app.scope', 'sistema', true);

insert into liame.ai_model_route (id, task, version, status, purpose, provider, model, effort, max_output_tokens, timeout_ms,
                                  max_cost_usd_micros, fallback, eval_threshold, eval_score, created_by, deployed_at)
select v.id::uuid, v.task, 1, case when o.task is null then 'ativa' else 'rascunho' end, v.purpose, 'anthropic', 'claude-sonnet-5-5', 'low',
       v.max_output_tokens, v.timeout_ms, v.max_cost_usd_micros, '[]'::jsonb, 0.95, v.eval_score,
       'distribuição: evals de 09/11/2026 (migration 0126)', case when o.task is null then now() end
  from (values
    ('019a4d00-0000-7000-8000-000000000001', 'social_comentario', 'texto', 1500, 60000, 40000, 1.0000)
  ) as v(id, task, purpose, max_output_tokens, timeout_ms, max_cost_usd_micros, eval_score)
  left join (select distinct task from liame.ai_model_route where status = 'ativa') o on o.task = v.task
on conflict do nothing;

do $$
begin
  if not exists (select 1 from liame.ai_model_route where task = 'social_comentario' and created_by = 'distribuição: evals de 09/11/2026 (migration 0126)') then
    raise exception '0126: a rota dos comentários não entrou';
  end if;
end $$;
