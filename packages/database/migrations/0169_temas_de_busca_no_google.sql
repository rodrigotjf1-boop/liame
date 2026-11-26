-- 0169 · Os temas de busca na campanha nova do Google (plano da região, R9; protótipo do Google pela região aprovado
-- pelo dono em 13/11/2026; D-RG-85, D-RG-86 e D-RG-89). A Performance Max criada pelo Liame passa a levar os temas de
-- busca que a pessoa vê e aprova na gaveta: a lista montada por regra (os termos de Minha marca com "perto de mim" e
-- "delivery", e os bairros das áreas de entrega da loja), que a pessoa pode mudar, conferida pela rota com a mesma regra
-- dos textos. Eles vão ao Google no grupo de recursos da campanha (um sinal por tema), na mesma requisição da criação.
-- A lista vazia é a campanha de hoje: os pedidos de antes desta coluna saem sem temas.
-- O limite de 25 temas é o da constante `SEARCH_THEMES_MAX` do contrato (o menor entre a referência da API e a ajuda do
-- Google Ads, até a conta real dizer outro, D-RG-89); a rota e o estado da ferramenta conferem o mesmo número e o tamanho
-- de cada tema. Das empresas. Idempotente; uma transação por arquivo (ADR-018).

alter table liame.google_campaign_new add column if not exists search_themes text[] not null default '{}';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'google_campaign_new_temas' and conrelid = 'liame.google_campaign_new'::regclass) then
    alter table liame.google_campaign_new
      add constraint google_campaign_new_temas check (cardinality(search_themes) <= 25);
  end if;
end
$$;

-- ------------------------------------------------------------ conferência

do $$ begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'liame' and table_name = 'google_campaign_new' and column_name = 'search_themes') then
    raise exception '0169: a coluna dos temas de busca não entrou';
  end if;
  if not exists (select 1 from pg_constraint where conname = 'google_campaign_new_temas' and conrelid = 'liame.google_campaign_new'::regclass) then
    raise exception '0169: o limite dos temas de busca não entrou';
  end if;
end $$;
