-- 0171 · O plano de conteúdo (`docs/plano-conteudo.md`, aprovado pelo dono em 28/11/2026, com as decisões D-PC-1 a
-- D-PC-18 como recomendadas; base de conhecimento §20). PC4, parte 1: o ranking dos produtos do cardápio do Regem pelo
-- código do produto (`GET /v1/content/products`), só leitura.
-- (1) A função `plano_conteudo`, desligada: com ela, a rota do ranking responde para quem vê Resultados (`vendas.ver`)
--     na marca com o Regem ligado; as próximas entregas do plano (o raio-x, o calendário, as peças) entram sob ela.
--     Quem liga é o dono, por empresa.
-- Da distribuição. Idempotente; uma transação por arquivo (ADR-018).

-- A semente grava em tabela com RLS forçada (V20).
select set_config('app.scope', 'sistema', true);

-- ------------------------------------------------------------ (1) a função

insert into liame.feature_flag (key, kind, default_value, description, owner, is_write)
values ('plano_conteudo', 'boolean', 'false', 'Plano de conteúdo: o ranking dos produtos do cardápio pelo código do Regem e, nas próximas entregas, o raio-x do Instagram, o calendário e as peças (plano de conteúdo)', 'social', false)
on conflict (key) do nothing;

-- ------------------------------------------------------------ conferência

do $$ begin
  if not exists (select 1 from liame.feature_flag where key = 'plano_conteudo' and default_value = 'false'::jsonb and not is_write) then
    raise exception '0171: a função plano_conteudo não entrou desligada';
  end if;
end $$;
