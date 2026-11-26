-- 0168 · O horário do ritmo da semana (plano da região, R7, parte 2; protótipo do ritmo aprovado pelo dono em 13/11/2026,
-- D-RG-61; D-RG-104). Com o ritmo aprovado, os anúncios ficam ligados de 1 hora antes do bloco dos pedidos da loja até
-- o fim dele, todos os dias da semana, e pausados fora disso (a Meta só programa horário com verba de período, que o
-- Liame recusa: D-RG-5). Entra depois da primeira semana do ritmo só com a verba do dia.
-- (1) A função `ritmo_horario`, desligada: com ela, o Gestor de tráfego põe a janela no pedido da semana (a parte 2a
--     mostra a janela; ligar e pausar na Meta vem na 2b, com os passos próprios). Quem liga é o dono, por empresa.
-- Da distribuição. Idempotente; uma transação por arquivo (ADR-018).

-- A semente grava em tabela com RLS forçada (V20).
select set_config('app.scope', 'sistema', true);

-- ------------------------------------------------------------ (1) a função

insert into liame.feature_flag (key, kind, default_value, description, owner, is_write)
values ('ritmo_horario', 'boolean', 'false', 'Horário do ritmo da semana: os anúncios ligados só de 1 hora antes do bloco dos pedidos da loja até o fim dele, e pausados fora disso (plano da região, R7, parte 2)', 'midia', false)
on conflict (key) do nothing;

-- ------------------------------------------------------------ conferência

do $$ begin
  if not exists (select 1 from liame.feature_flag where key = 'ritmo_horario' and default_value = 'false'::jsonb and not is_write) then
    raise exception '0168: a função ritmo_horario não entrou desligada';
  end if;
end $$;
