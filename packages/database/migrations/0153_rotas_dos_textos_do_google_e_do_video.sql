-- 0153 · Rotas de modelo dos textos da campanha nova no Google (o Criativo, A5 · Y9, parte 4; D-A5-31) e dos textos do
-- vídeo montado (o Social media, A6 · Z15, parte 3b; D-A6-143). ADR-006 item 8; `evals/README.md`. Regra do produto:
-- modelo só entra numa tarefa depois de passar no eval dela, e a regra dos testes pede duas rodadas aprovadas seguidas
-- com o mesmo prompt (uma só não mede a variação).
--
-- As rodadas com modelo de verdade de 13/11/2026, autorizadas pelo dono (teto de US$ 2; gasto perto de US$ 1,59), na
-- chave do workspace de testes: Sonnet 5.5, esforço baixo, só nos Estados Unidos (D-A3-13).
-- - `criativo_google`, prompt `criativo.google` versão 2: 19 de 19 nas rodadas 3 e 4. A versão 1 reprovou por tamanho
--   (o modelo passava de 1 a 4 caracteres do pedido de 27 e 85); a 2 pede 25 e 80, escreve os números como a oferta
--   escreve ("dois", nunca "x2") e não repete o título longo numa descrição. O eval passou a reprovar o que passa do
--   limite do Google (30 e 90), que é o que a produção tira da proposta.
-- - `social_video`, prompt `social.video` versão 2: 15 de 15 nas rodadas 4 e 5. A versão 1 reprovou em dois casos
--   reais: o preço sem a condição da oferta ("R$ 34,90" sem "sexta") e a oferta de "dois smash" não usada com duas
--   fotos do smash; a 2 diz a condição, curta, no título ou na chamada, e usa a oferta que fala do produto das fotos.
--
-- As rotas entram com essa nota. A finalidade é `texto` (texto criativo, ADR-016), como a das peças e dos posts. Sem
-- reserva e sem modelo econômico: o volume é pequeno (uma chamada a pedido da pessoa, no "Pedir ao Criativo" e no
-- "Pedir ao Social media"), e o Haiku 5.5 não foi medido nestas tarefas. O teto de custo é o de UMA chamada, com folga
-- sobre o que a rodada mediu (perto de US$ 0,01 nos textos do Google e menos que isso nos do vídeo).
-- Nada muda para quem não ligou: as rotas só são chamadas na empresa com a função `campanha_google` (os textos do
-- Google) ou `video_montado` (os do vídeo), a IA ligada e o funcionário ativo na marca; o texto é proposta, conferido
-- pelo Compliance antes de a pessoa ver, e nada vai ao ar sem a aprovação dela.
-- Idempotente. Se a tarefa já tiver outra rota ativa (um banco de desenvolvimento com rota de teste), esta entra como
-- rascunho, sem tirar a que está valendo; em produção não há rota nenhuma para as duas, e elas entram ativas.
-- Uma transação por arquivo (ADR-018).

-- As rotas são da distribuição, em tabela com RLS forçada (V20).
select set_config('app.scope', 'sistema', true);

insert into liame.ai_model_route (id, task, version, status, purpose, provider, model, effort, max_output_tokens, timeout_ms,
                                  max_cost_usd_micros, fallback, eval_threshold, eval_score, created_by, deployed_at)
select v.id::uuid, v.task, 1, case when o.task is null then 'ativa' else 'rascunho' end, v.purpose, 'anthropic', 'claude-sonnet-5-5', 'low',
       v.max_output_tokens, v.timeout_ms, v.max_cost_usd_micros, '[]'::jsonb, 0.95, v.eval_score,
       'distribuição: evals de 13/11/2026 (migration 0153)', case when o.task is null then now() end
  from (values
    ('019a7c00-0000-7000-8000-000000000153', 'criativo_google', 'texto', 1500, 60000, 40000, 1.0000),
    ('019a7c00-0000-7000-8000-000000000154', 'social_video', 'texto', 800, 60000, 30000, 1.0000)
  ) as v(id, task, purpose, max_output_tokens, timeout_ms, max_cost_usd_micros, eval_score)
  left join (select distinct task from liame.ai_model_route where status = 'ativa') o on o.task = v.task
on conflict do nothing;

do $$
begin
  if (select count(*) from liame.ai_model_route where task in ('criativo_google', 'social_video') and created_by = 'distribuição: evals de 13/11/2026 (migration 0153)') <> 2 then
    raise exception '0153: as rotas dos textos do Google e do vídeo não entraram';
  end if;
end $$;
