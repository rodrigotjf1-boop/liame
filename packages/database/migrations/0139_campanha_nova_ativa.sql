-- 0139 · Ativar a campanha nova e a volta (A4, X5, parte 3; P10 aprovado em 05/10/2026; D-A4-31). A campanha nova
-- que o Liame criou pausada (0138) passa a ser ativada por outro pedido, com os limites e a verba do mês; a volta é
-- pausar. A campanha nova guarda se está ativa e desde quando: é o estado que o pedido de ativar e o de pausar planejam.
-- As chamadas à Meta são as de sempre da situação dos objetos (`entity_state` e `entity_update`, já no registro).
-- Das empresas. Idempotente; uma transação por arquivo (ADR-018).

alter table liame.ad_campaign_new add column if not exists active boolean not null default false;
alter table liame.ad_campaign_new add column if not exists activated_at timestamptz;

do $$ begin
  -- Só a campanha criada na Meta pode estar ativa.
  if not exists (select 1 from pg_constraint where conrelid = 'liame.ad_campaign_new'::regclass and conname = 'ad_campaign_new_ativa_criada') then
    alter table liame.ad_campaign_new add constraint ad_campaign_new_ativa_criada check (not active or status = 'criada');
  end if;
end $$;

-- ------------------------------------------------------------ conferência

do $$ begin
  if (select count(*) from information_schema.columns
       where table_schema = 'liame' and table_name = 'ad_campaign_new' and column_name in ('active', 'activated_at')) <> 2 then
    raise exception '0139: as colunas de ativar não entraram';
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'liame.ad_campaign_new'::regclass and conname = 'ad_campaign_new_ativa_criada') then
    raise exception '0139: a regra de só a criada estar ativa não entrou';
  end if;
end $$;
