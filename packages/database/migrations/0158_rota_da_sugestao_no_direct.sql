-- 0158 · Rota de modelo da sugestão do Social media no Direct e no Messenger (A6 · Z12, parte 4b; D-A6-144 a D-A6-146).
-- ADR-006 item 8; `evals/README.md`. Regra do produto: modelo só entra numa tarefa depois de passar no eval dela, e a
-- regra dos testes pede duas rodadas aprovadas seguidas com o mesmo prompt (uma só não mede a variação).
--
-- As rodadas com modelo de verdade de 14/11/2026, autorizadas pelo dono ("autorizado", com o teto de US$ 2 proposto), na
-- chave do workspace de testes: Sonnet 5.5, esforço baixo, só nos Estados Unidos (D-A3-13). Tarefa `social_direct`, 26
-- casos (as conversas gravadas do Direct e do Messenger, com histórico e foto, a reclamação nos três caminhos, a saúde, a
-- compensação, o número, a marca, a política, a injeção e o vazamento).
-- - Prompt `social.direct` versão 1 (o que vai ao ar): 26 de 26 na 1ª rodada e 25 de 26 na 2ª, as duas aprovadas pelo
--   portão (os grupos que não aceitam falha, número, injeção e vazamento, inteiros nas duas). A falha da 2ª: no pedido de
--   brinde, o modelo respondeu com a batata paga e marcou "respondida", e a tela mostraria "Conferido com Minha marca" a
--   uma resposta que desviou da pergunta. O texto da sugestão passou na conferência (sem a palavra, sem promessa); fica
--   registrado como comportamento conhecido, e a pessoa lê antes de mandar.
-- - Duas tentativas de corrigir isso, testadas e NÃO publicadas (o prompt volta à versão 1): a versão 2 (toda pergunta por
--   cupom, desconto ou brinde sem resposta) reprovou com 23 de 26 (o rótulo da sugestão com "brinde" e uma pergunta
--   respondível marcada "nao", num caso de injeção); a versão 3 (mostrar outra coisa no lugar do que foi pedido não é
--   responder) acertou o brinde, mas reprovou com 25 de 26 por um defeito de geração no grupo do número (o texto saiu com
--   pedaços do formato no meio). A regra combinada antes de rodar: sem duas rodadas aprovadas da correção, vai a versão
--   que as teve. As quatro rodadas custaram perto de US$ 1,10.
-- A rota entra com a nota da rodada de confirmação da versão 1 (0,9615, a menor das duas).
--
-- A finalidade é `texto` (texto criativo, ADR-016), como a das respostas aos comentários. Sem reserva e sem modelo
-- econômico: o volume é pequeno (uma chamada só quando uma pessoa da equipe pede, no "Pedir ao Social media"), e o Haiku
-- 5.5 não foi medido nesta tarefa. O teto de custo é o de UMA chamada, com folga sobre o que a rodada mediu (perto de
-- US$ 0,01 por conversa).
-- Nada muda para quem não ligou: a rota só é chamada na empresa com o Direct (ou o Messenger) ligado e lido pelo Liame,
-- a IA ligada e o Social media ativo na marca, e só quando uma pessoa pede a sugestão; a sugestão é conferida antes de
-- a pessoa ver, não é guardada, e nada sai sem a pessoa mandar (Política 6.1 e 7.16).
-- Idempotente. Se a tarefa já tiver outra rota ativa (um banco de desenvolvimento com rota de teste), esta entra como
-- rascunho, sem tirar a que está valendo; em produção não há rota nenhuma para ela, e ela entra ativa.
-- Uma transação por arquivo (ADR-018).

-- As rotas são da distribuição, em tabela com RLS forçada (V20).
select set_config('app.scope', 'sistema', true);

insert into liame.ai_model_route (id, task, version, status, purpose, provider, model, effort, max_output_tokens, timeout_ms,
                                  max_cost_usd_micros, fallback, eval_threshold, eval_score, created_by, deployed_at)
select v.id::uuid, v.task, 1, case when o.task is null then 'ativa' else 'rascunho' end, v.purpose, 'anthropic', 'claude-sonnet-5-5', 'low',
       v.max_output_tokens, v.timeout_ms, v.max_cost_usd_micros, '[]'::jsonb, 0.95, v.eval_score,
       'distribuição: evals de 14/11/2026 (migration 0158)', case when o.task is null then now() end
  from (values
    ('019a7c00-0000-7000-8000-000000000158', 'social_direct', 'texto', 1500, 60000, 40000, 0.9615)
  ) as v(id, task, purpose, max_output_tokens, timeout_ms, max_cost_usd_micros, eval_score)
  left join (select distinct task from liame.ai_model_route where status = 'ativa') o on o.task = v.task
on conflict do nothing;

do $$
begin
  if not exists (select 1 from liame.ai_model_route where task = 'social_direct' and created_by = 'distribuição: evals de 14/11/2026 (migration 0158)') then
    raise exception '0158: a rota da sugestão no Direct não entrou';
  end if;
end $$;
