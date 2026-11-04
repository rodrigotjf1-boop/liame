-- 0113 · O Haiku 5.5 como modelo econômico de três tarefas (A3; ADR-016; `ai-architecture.md` §9; `evals/README.md`).
-- Regra do produto: modelo só entra numa tarefa depois de passar no eval dela, e a regra dos testes pede duas rodadas
-- aprovadas (uma só não mede a variação). O Haiku 5.5 (esforço baixo, só nos Estados Unidos: D-A3-13) passou nas duas
-- rodadas com modelo de verdade, a de 28/10/2026 e a de 03/11/2026 (autorizada pelo dono, "pode rodar os dois"), em
-- três tarefas: o revisor do Compliance (`compliance_revisao`, 24 de 25 nas duas), o Pesquisador (`pesquisador_pagina`,
-- 12 de 12 nas duas) e o Criativo de texto (`criativo_texto`, 25 de 25 nas duas). Nas outras tarefas ele reprovou em
-- 28/10 e fica de fora. O preço dele, com a faixa do prompt longo, entrou na migration 0089.
-- O modelo econômico só é usado quando a empresa passa de 80% do teto de gasto de IA (o gateway troca o principal por ele
-- e não usa reserva nem a escolha do Pro); abaixo disso, nada muda: o Sonnet 5.5 segue como principal.
-- As rotas são versionadas: a versão que vale hoje (a da distribuição, ativa, Sonnet 5.5 sem econômico) é aposentada, e
-- entra a seguinte, igual a ela e com o Haiku 5.5 como econômico. Idempotente: rodar de novo não acha mais a versão
-- antiga ativa e não faz nada; a tarefa cuja rota ativa não é a da distribuição (um banco de desenvolvimento com rota de
-- teste) fica como está. Em produção as três estão ativas, na versão 1.
-- Uma transação por arquivo (ADR-018).

-- As rotas são da distribuição, em tabela com RLS forçada (V20).
select set_config('app.scope', 'sistema', true);

do $$
declare
  r record;
begin
  for r in
    select *
      from liame.ai_model_route
     where status = 'ativa'
       and created_by like 'distribuição:%'
       and task in ('compliance_revisao', 'pesquisador_pagina', 'criativo_texto')
       and provider = 'anthropic' and model = 'claude-sonnet-5-5'
       and economy_model is null
     order by task
       for update
  loop
    -- A versão seguinte já existe (outra rodada desta migration num banco à parte): não mexe.
    continue when exists (select 1 from liame.ai_model_route o where o.task = r.task and o.version = r.version + 1);
    update liame.ai_model_route set status = 'aposentada' where id = r.id;
    insert into liame.ai_model_route (id, task, version, status, purpose, provider, model, effort, max_output_tokens, timeout_ms,
                                      max_cost_usd_micros, fallback, economy_provider, economy_model, eval_threshold, eval_score,
                                      created_by, deployed_at)
    values (
      case r.task
        when 'compliance_revisao' then '019a4b00-0000-7000-8000-000000000001'::uuid
        when 'pesquisador_pagina' then '019a4b00-0000-7000-8000-000000000002'::uuid
        else '019a4b00-0000-7000-8000-000000000003'::uuid
      end,
      r.task, r.version + 1, 'ativa', r.purpose, r.provider, r.model, r.effort, r.max_output_tokens, r.timeout_ms,
      r.max_cost_usd_micros, r.fallback, 'anthropic', 'claude-haiku-5-5', r.eval_threshold, r.eval_score,
      'distribuição: evals de 28/10 e 03/11/2026 (migration 0113)', now()
    );
  end loop;
end $$;
