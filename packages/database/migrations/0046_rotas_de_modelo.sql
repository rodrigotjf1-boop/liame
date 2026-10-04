-- 0046 · Rotas de modelo das cinco tarefas de IA (A3, I3; ADR-006 item 8; `ai-architecture.md` §3 e §9; `evals/README.md`).
-- Regra do produto: modelo só entra numa tarefa depois de passar no eval dela. As cinco passaram no portão na rodada
-- com modelo de verdade de 04/10/2026 (Sonnet 5.5, esforço baixo, só nos Estados Unidos: D-A3-13), e cada rota entra
-- com a nota dessa rodada. Sem reserva e sem modelo econômico: nenhum outro modelo tem eval aprovado nessas tarefas (o
-- Haiku 4.5 não roda só nos Estados Unidos). Com o principal fora do ar, cada tela mostra o texto sem IA, que já existe.
-- O limite de saída e o prazo são os da rodada do eval; o teto de custo é o de UMA chamada (uma rodada do laço), com
-- folga sobre o que a rodada mediu: passou dele, o gateway avisa no log.
-- Nada muda para ninguém com esta migration: a flag `ia` continua desligada para todos, e a rota só é usada na empresa
-- em que a distribuição ligar a flag (comando `ligar-flag`). O revisor (`compliance_revisao`) pede também a flag `revisor`.
-- Idempotente. A tarefa que já tem outra rota ativa (um banco de desenvolvimento com rota de teste) recebe a desta
-- rodada como rascunho, sem tirar a que está valendo; em produção não há rota nenhuma, e as cinco entram ativas.
-- Uma transação por arquivo (ADR-018).

-- As rotas são da distribuição, em tabela com RLS forçada (V20).
select set_config('app.scope', 'sistema', true);

insert into liame.ai_model_route (id, task, version, status, purpose, provider, model, effort, max_output_tokens, timeout_ms,
                                  max_cost_usd_micros, fallback, eval_threshold, eval_score, created_by, deployed_at)
select v.id::uuid, v.task, 1, case when o.task is null then 'ativa' else 'rascunho' end, v.purpose, 'anthropic', 'claude-sonnet-5-5', 'low',
       v.max_output_tokens, v.timeout_ms, v.max_cost_usd_micros, '[]'::jsonb, 0.95, v.eval_score,
       'distribuição: evals de 04/10/2026 (migration 0046)', case when o.task is null then now() end
  from (values
    ('0199a301-0000-7000-8000-000000000001', 'explicar_resultados', 'analise',  2000,  60000,  50000, 1.0000),
    ('0199a301-0000-7000-8000-000000000002', 'conversa_lia',        'conversa', 3000,  60000, 120000, 1.0000),
    ('0199a301-0000-7000-8000-000000000003', 'estrategista_plano',  'analise',  4000, 120000, 150000, 1.0000),
    ('0199a301-0000-7000-8000-000000000004', 'pesquisador_pagina',  'analise',  2000,  60000,  60000, 1.0000),
    ('0199a301-0000-7000-8000-000000000005', 'compliance_revisao',  'analise',  2000,  30000,  20000, 1.0000)
  ) as v(id, task, purpose, max_output_tokens, timeout_ms, max_cost_usd_micros, eval_score)
  left join (select distinct task from liame.ai_model_route where status = 'ativa') o on o.task = v.task
on conflict do nothing;
