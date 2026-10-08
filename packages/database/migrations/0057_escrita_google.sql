-- 0057 · Escrita no Google Ads: as capacidades no registro (A5, Y2; `plano-a5.md` D-A5-2 a D-A5-4).
-- O conector de escrita do Google lê a campanha com o orçamento dela e muda a situação da campanha ou a verba diária do
-- orçamento que é só dela. A versão da API é dado, não código: fica no Capability Registry, como a da Meta (0044).
-- A flag `google_write` existe desde a 0009, desligada; nenhuma ferramenta aceita `google_ads` nesta entrega.
-- Idempotente; uma transação por arquivo (ADR-018).

-- As sementes gravam em tabela com RLS forçada (V20).
select set_config('app.scope', 'sistema', true);

-- Conferido nas fontes oficiais em 08/10/2026 (base de conhecimento §3.1): `POST /v25/customers/{id}/campaigns:mutate` e
-- `…/campaignBudgets:mutate`, com `validateOnly` ("the request is validated but not executed; only errors are
-- returned"), a máscara de atualização em snake_case e o corpo em camelCase; o nível Explorer não bloqueia campanhas
-- nem orçamentos de campanha.
insert into liame.connector_capability (provider, capability, api_version, read, write, required_scope, access_level, sunset_at, source_url, verified_at, notes) values
  ('google_ads', 'entity_state', 'v25', true, false, '{https://www.googleapis.com/auth/adwords}', 'Explorer', null, 'https://developers.google.com/google-ads/api/docs/query/overview', '2026-10-08', 'a campanha com o orçamento dela (campaign_budget: amount_micros, total_amount_micros, explicitly_shared, reference_count, period), lida na hora do pedido e da escrita'),
  ('google_ads', 'entity_update', 'v25', false, true, '{https://www.googleapis.com/auth/adwords}', 'Explorer', null, 'https://developers.google.com/google-ads/api/docs/mutating/overview', '2026-10-08', 'situação da campanha (campaigns:mutate) e verba diária do orçamento que é só dela (campaignBudgets:mutate); validateOnly antes; orçamento compartilhado nunca; só com a flag google_write')
on conflict (provider, capability) do nothing;
