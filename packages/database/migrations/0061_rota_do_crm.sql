-- 0061 · Rota de modelo e flag do funcionário de CRM e mensageria (A5, Y6; critério A5-13; ADR-006 item 8; `evals/README.md`).
-- Regra do produto: modelo só entra numa tarefa depois de passar no eval dela. A tarefa `crm_mensagem` passou no portão
-- na rodada com modelo de verdade de 09/10/2026 (Sonnet 5.5, esforço baixo, só nos Estados Unidos: D-A3-13), 24 de 24
-- em duas rodadas seguidas, e a rota entra com essa nota. A finalidade é `texto` (texto criativo, ADR-016). Sem reserva
-- e sem modelo econômico: nenhum outro modelo tem eval aprovado nesta tarefa. O limite de saída é o da rodada do eval;
-- o teto de custo é o de UMA chamada (uma mensagem), com folga sobre o que a rodada mediu.
-- Nada muda para ninguém com esta migration: nada no código chama a tarefa ainda (a rotina do funcionário é a próxima
-- entrega), e as flags `ia` e `crm` continuam desligadas para todos. Quando a rotina existir, ela só trabalha na
-- empresa em que a distribuição ligar as duas (comando `ligar-flag`), e ainda depende das flags do envio de mensagens
-- (`mensageria` e `whatsapp_campaign`).
-- Idempotente. Se a tarefa já tiver outra rota ativa (um banco de desenvolvimento com rota de teste), esta entra como
-- rascunho, sem tirar a que está valendo; em produção não há rota nenhuma, e ela entra ativa.
-- Uma transação por arquivo (ADR-018).

-- As rotas e as flags são da distribuição, em tabelas com RLS forçada (V20).
select set_config('app.scope', 'sistema', true);

insert into liame.ai_model_route (id, task, version, status, purpose, provider, model, effort, max_output_tokens, timeout_ms,
                                  max_cost_usd_micros, fallback, eval_threshold, eval_score, created_by, deployed_at)
select v.id::uuid, v.task, 1, case when o.task is null then 'ativa' else 'rascunho' end, v.purpose, 'anthropic', 'claude-sonnet-5-5', 'low',
       v.max_output_tokens, v.timeout_ms, v.max_cost_usd_micros, '[]'::jsonb, 0.95, v.eval_score,
       'distribuição: eval de 09/10/2026 (migration 0061)', case when o.task is null then now() end
  from (values
    ('0199a301-0000-7000-8000-000000000007', 'crm_mensagem', 'texto', 2000, 60000, 40000, 1.0000)
  ) as v(id, task, purpose, max_output_tokens, timeout_ms, max_cost_usd_micros, eval_score)
  left join (select distinct task from liame.ai_model_route where status = 'ativa') o on o.task = v.task
on conflict do nothing;

-- Liga, por empresa, o funcionário de CRM e mensageria: escrever o rascunho de uma mensagem de WhatsApp e propor o
-- envio, sempre como pedido em Aprovações. Nasce desligada. Não envia nada sozinha: o envio tem as flags dele
-- (`mensageria` e `whatsapp_campaign`) e só acontece com a aprovação de uma pessoa, com o código do app.
insert into liame.feature_flag (key, kind, default_value, description, owner, is_write)
values ('crm', 'boolean', 'false', 'CRM e mensageria: rascunho de mensagem de WhatsApp escrito pela IA, conferido pelo código, e proposta de envio para uma pessoa aprovar (A5, Y6)', 'mensageria', false)
on conflict (key) do nothing;
