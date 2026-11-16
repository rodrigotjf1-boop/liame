-- 0165 · Rota de modelo dos cortes dos melhores momentos (A6 · Z16; D-A6-150 a D-A6-155, P46 aprovado pelo dono em
-- 15/11/2026). ADR-006 item 8; `evals/README.md`. Regra do produto: modelo só entra numa tarefa depois de passar no eval
-- dela, e a regra dos testes pede duas rodadas aprovadas seguidas com o mesmo prompt (uma só não mede a variação).
--
-- As rodadas com modelo de verdade de 15/11/2026, autorizadas pelo dono ("3 aprovado, pode"), na chave do workspace de
-- testes: Sonnet 5.5, esforço baixo, só nos Estados Unidos (D-A3-13), como as outras rotas `social_*`. Tarefa
-- `social_cortes`, 18 casos (os seis grupos, as duas marcas, as três durações, de 1 a 4 vídeos, os quadros desenhados pelo
-- eval, nenhuma foto de gente de verdade), com a imagem indo ao modelo como parte `file`.
-- - Prompt `social.cortes` v1: 13 de 18 (o modelo erra a soma dos cortes e não cita o preço da oferta); o esforço médio não
--   resolveu (1 de 5 nos que falharam). v2 (os tamanhos que fecham a conta, o preço da oferta na última legenda) com o
--   ajuste do total por código (D-A6-155): 17 de 18. v3 e v4 (a oferta que inclui o produto, o dia dela, o preço só das
--   ofertas, a última legenda firme): 13 e 15 de 18, com erros novos por causa do preço obrigatório. O dono escolheu o preço
--   opcional ("Preço opcional", 15/11/2026): v5, 17 de 18 (um corte de rascunho, 1 s com a legenda "x"); com o descarte do
--   corte de rascunho (D-A6-155), **18 de 18 na rodada e 18 de 18 na confirmação**, os seis grupos inteiros nas duas (o
--   `injecao` não aceita falha). As rodadas custaram perto de US$ 1,83.
-- A rota entra com a nota da rodada de confirmação (1,0000).
--
-- A finalidade é `texto`, como a das outras tarefas do Social media (os cortes e as legendas são a peça que ele propõe; a
-- pessoa confere, muda e manda montar). Sem reserva e sem modelo econômico: o Haiku 5.5 não foi medido nesta tarefa, e
-- escolher o corte pelo quadro pede visão boa. O teto de custo é o de UMA chamada com até 16 imagens (perto de US$ 0,014
-- por pedido nas rodadas), com folga: 60000 micro-dólares (as outras `social_*` usam até 40000, só com texto). O tempo é
-- de 60 segundos, porque 16 imagens demoram mais que texto.
-- Nada muda para quem não ligou: a rota só é chamada na empresa com a função `video_momentos` ligada, a IA ligada e o Social
-- media ativo na marca, e só quando uma pessoa pede os cortes (até 10 pedidos por marca por dia); os quadros não entram no
-- registro de uso (só o tamanho e a assinatura de cada um, `paraGuardar`) e saem do armazenamento quando a proposta chega
-- (Política 7.17).
-- Idempotente. Se a tarefa já tiver outra rota ativa (um banco de desenvolvimento com rota de teste), esta entra como
-- rascunho, sem tirar a que está valendo; em produção não há rota nenhuma para ela, e ela entra ativa.
-- Uma transação por arquivo (ADR-018).

-- As rotas são da distribuição, em tabela com RLS forçada (V20).
select set_config('app.scope', 'sistema', true);

insert into liame.ai_model_route (id, task, version, status, purpose, provider, model, effort, max_output_tokens, timeout_ms,
                                  max_cost_usd_micros, fallback, eval_threshold, eval_score, created_by, deployed_at)
select v.id::uuid, v.task, 1, case when o.task is null then 'ativa' else 'rascunho' end, v.purpose, 'anthropic', 'claude-sonnet-5-5', 'low',
       v.max_output_tokens, v.timeout_ms, v.max_cost_usd_micros, '[]'::jsonb, 0.95, v.eval_score,
       'distribuição: evals de 15/11/2026 (migration 0165)', case when o.task is null then now() end
  from (values
    ('019a7c00-0000-7000-8000-000000000165', 'social_cortes', 'texto', 1500, 60000, 60000, 1.0000)
  ) as v(id, task, purpose, max_output_tokens, timeout_ms, max_cost_usd_micros, eval_score)
  left join (select distinct task from liame.ai_model_route where status = 'ativa') o on o.task = v.task
on conflict do nothing;

do $$
begin
  if not exists (select 1 from liame.ai_model_route where task = 'social_cortes' and created_by = 'distribuição: evals de 15/11/2026 (migration 0165)') then
    raise exception '0165: a rota dos cortes não entrou';
  end if;
end $$;
