-- 0083 · O preço novo da leitura do cache do Sonnet 5.5 (A3, I1; `ai-architecture.md` §10; base de conhecimento §10).
-- A página oficial de preços da Anthropic, lida em 28/10/2026 e de novo em 29/10/2026, cobra a leitura do cache do
-- Sonnet 5.5 a 0,05× a entrada (US$ 0,10 por milhão de tokens); a tabela tinha US$ 0,20, o 0,1× da página de 02/10/2026.
-- O resto do preço do Sonnet 5.5 não mudou, e os outros modelos da tabela conferem com a página. Preço novo entra como
-- linha nova (0028): a de 01/10/2026 fica como está, e o custo já registrado não muda; a chamada feita depois desta
-- migration usa a linha nova (início em 28/10/2026, o dia em que a diferença foi lida).
-- O Haiku 5.5 não entra aqui: ele entra junto com a primeira rota que o usar, porque o preço dele muda quando o pedido
-- passa de 100 mil tokens de entrada, e esta tabela ainda não tem essa faixa.
-- Idempotente; uma transação por arquivo (ADR-018).

-- Os preços são da distribuição, em tabela com RLS forçada (V20).
select set_config('app.scope', 'sistema', true);

insert into liame.ai_model_price (id, provider, model, valid_from, input_usd_micros_per_mtok, output_usd_micros_per_mtok,
                                  cache_read_usd_micros_per_mtok, cache_write_5m_usd_micros_per_mtok, cache_write_1h_usd_micros_per_mtok,
                                  source, checked_on)
values
  ('019a2e00-0000-7000-8000-000000000001', 'anthropic', 'claude-sonnet-5-5', '2026-10-28', 2000000, 10000000, 100000, 2500000, 4000000,
   'https://platform.claude.com/docs/en/about-claude/pricing', '2026-10-29')
on conflict (provider, model, valid_from) do nothing;
