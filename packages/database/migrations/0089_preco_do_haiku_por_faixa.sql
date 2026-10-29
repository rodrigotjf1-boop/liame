-- 0089 · O preço do Haiku 5.5, com a faixa do prompt longo (A3, I13; `ai-architecture.md` §10; base de conhecimento §10).
-- A página oficial de preços da Anthropic, lida em 29/10/2026, cobra o Haiku 5.5 pelo tamanho do prompt: até 100.000
-- tokens, US$ 0,10 a entrada, US$ 0,125 e US$ 0,20 a escrita do cache (5 minutos e 1 hora), US$ 0,01 a leitura e
-- US$ 0,50 a saída, por milhão; acima de 100.000, US$ 0,50, 0,625, 1, 0,05 e 2,50. "O tamanho do prompt conta todos os
-- tokens de entrada, inclusive a leitura e a escrita do cache", e cada pedido é cobrado por si: o pedido acima da faixa
-- paga o preço alto em tudo, a saída também. O endereço de dados nos Estados Unidos (`inference_geo: us`) multiplica as
-- duas faixas por 1,1, e o lote pela metade, como nos outros modelos (o cálculo já faz).
-- A tabela ganha a faixa como colunas opcionais: o modelo sem faixa (todos os outros) deixa as seis vazias, e o que tem
-- faixa preenche as seis juntas. O Haiku 5.5 entra com início em 29/10/2026 (nenhuma rota o usa ainda; a primeira que
-- usar, pela tabela de rotas, já é cobrada pela faixa certa).
-- Idempotente; uma transação por arquivo (ADR-018).

alter table liame.ai_model_price add column if not exists long_prompt_above_tokens integer;
alter table liame.ai_model_price add column if not exists long_input_usd_micros_per_mtok bigint;
alter table liame.ai_model_price add column if not exists long_output_usd_micros_per_mtok bigint;
alter table liame.ai_model_price add column if not exists long_cache_read_usd_micros_per_mtok bigint;
alter table liame.ai_model_price add column if not exists long_cache_write_5m_usd_micros_per_mtok bigint;
alter table liame.ai_model_price add column if not exists long_cache_write_1h_usd_micros_per_mtok bigint;

-- A faixa vem inteira ou não vem: as seis colunas vazias, ou as seis preenchidas, com o limite acima de zero e os preços
-- sem negativo. A contagem dos nulos é explícita (`num_nulls`): um `check` que compara um nulo dá "desconhecido", e o
-- Postgres aceita a linha (a faixa pela metade passaria; ERR-187).
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'ai_model_price_faixa_check' and conrelid = 'liame.ai_model_price'::regclass) then
    alter table liame.ai_model_price add constraint ai_model_price_faixa_check check (
      num_nulls(long_prompt_above_tokens, long_input_usd_micros_per_mtok, long_output_usd_micros_per_mtok, long_cache_read_usd_micros_per_mtok,
                long_cache_write_5m_usd_micros_per_mtok, long_cache_write_1h_usd_micros_per_mtok) in (0, 6)
      and coalesce(long_prompt_above_tokens, 1) > 0
      and coalesce(long_input_usd_micros_per_mtok, 0) >= 0 and coalesce(long_output_usd_micros_per_mtok, 0) >= 0
      and coalesce(long_cache_read_usd_micros_per_mtok, 0) >= 0 and coalesce(long_cache_write_5m_usd_micros_per_mtok, 0) >= 0
      and coalesce(long_cache_write_1h_usd_micros_per_mtok, 0) >= 0
    );
  end if;
end $$;

-- Os preços são da distribuição, em tabela com RLS forçada (V20).
select set_config('app.scope', 'sistema', true);

insert into liame.ai_model_price (id, provider, model, valid_from, input_usd_micros_per_mtok, output_usd_micros_per_mtok,
                                  cache_read_usd_micros_per_mtok, cache_write_5m_usd_micros_per_mtok, cache_write_1h_usd_micros_per_mtok,
                                  long_prompt_above_tokens, long_input_usd_micros_per_mtok, long_output_usd_micros_per_mtok,
                                  long_cache_read_usd_micros_per_mtok, long_cache_write_5m_usd_micros_per_mtok, long_cache_write_1h_usd_micros_per_mtok,
                                  source, checked_on)
values
  ('019a3000-0000-7000-8000-000000000001', 'anthropic', 'claude-haiku-5-5', '2026-10-29', 100000, 500000, 10000, 125000, 200000,
   100000, 500000, 2500000, 50000, 625000, 1000000,
   'https://platform.claude.com/docs/en/about-claude/pricing', '2026-10-29')
on conflict (provider, model, valid_from) do nothing;
