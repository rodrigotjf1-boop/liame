-- 0117 · A verba do mês dividida por plataforma (A4, X9; `plano-a4.md` D-A4-36 a D-A4-39; protótipo P36, aprovado pelo
-- dono em 04/11/2026). A empresa pode, se quiser, dividir o teto do mês entre as plataformas com conta de anúncio lida
-- (hoje a Meta e o Google): cada uma ganha uma parte em micros, e o teto do mês passa a ser a soma das partes. O pedido
-- que aumenta a verba ou volta a gastar numa plataforma é negado quando a previsão dela passa da parte, mesmo com o
-- total cabendo. Sem divisão (a coluna nula), vale só o teto do mês, como antes.
-- A divisão é só da empresa inteira (o envelope sem marca): a parte da marca não existe. O formato é um objeto
-- `{ "meta_ads": 3700000000, "google_ads": 1800000000 }`; quem confere as chaves e os valores é o código (a rota dos
-- limites), e o banco garante só que é um objeto, e que mora no envelope da empresa.
-- Nada usa a coluna enquanto a função `verba_por_plataforma` estiver desligada. Idempotente; uma transação por arquivo
-- (ADR-018). A semente da flag grava em tabela com RLS forçada (V20).
select set_config('app.scope', 'sistema', true);

alter table liame.budget_policy add column if not exists platform_parts jsonb;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'budget_policy_platform_parts_check' and conrelid = 'liame.budget_policy'::regclass) then
    alter table liame.budget_policy add constraint budget_policy_platform_parts_check
      check (platform_parts is null or (brand_id is null and jsonb_typeof(platform_parts) = 'object'));
  end if;
end $$;

-- ------------------------------------------------------------ a função

-- Liga, por empresa, a divisão do teto do mês por plataforma (D-A4-36). Nasce desligada: o texto dos Termos 2.3 (que
-- hoje descreve o teto do mês e o teto por campanha) muda antes de ligar. Não escreve em plataforma nenhuma.
insert into liame.feature_flag (key, kind, default_value, description, owner, is_write)
values ('verba_por_plataforma', 'boolean', 'false', 'Verba do mês: dividir o teto do mês entre as plataformas de anúncio, com a parte de cada uma travando o aumento e a retomada nela (A4, X9)', 'midia', false)
on conflict (key) do nothing;

-- ------------------------------------------------------------ conferência

do $$ begin
  if not exists (select 1 from information_schema.columns where table_schema = 'liame' and table_name = 'budget_policy' and column_name = 'platform_parts') then
    raise exception '0117: a coluna platform_parts não entrou';
  end if;
  if not exists (select 1 from pg_constraint where conname = 'budget_policy_platform_parts_check') then
    raise exception '0117: a regra da coluna platform_parts não entrou';
  end if;
  if not exists (select 1 from liame.feature_flag where key = 'verba_por_plataforma' and default_value = 'false'::jsonb) then
    raise exception '0117: a função verba_por_plataforma não entrou desligada';
  end if;
end $$;
