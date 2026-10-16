-- 0073 · Como os anúncios rodaram, em Resultados (P23, aprovado pelo dono em 16/10/2026; `decisoes-design.md`).
-- A flag `desempenho_anuncios`, por empresa, desligada. Ligada, Resultados ganha o cartão com o que a Meta e o Google
-- informam (impressões, alcance, cliques, gasto e o resultado da plataforma) e o botão "Ler agora", que adianta a
-- leitura das contas de anúncio da marca (uma vez a cada 15 minutos por empresa). Não é flag de escrita: o Liame só lê.
-- O alcance do período é lido da Meta como um número só (pessoas diferentes; somar o de cada dia conta a mesma pessoa
-- mais de uma vez): três métricas novas no mapa da distribuição, gravadas por campanha e pela conta.
-- Idempotente; uma transação por arquivo (ADR-018). Sem tabela nova e sem coluna nova.

-- As sementes gravam em tabela com RLS forçada (V20).
select set_config('app.scope', 'sistema', true);

insert into liame.feature_flag (key, kind, default_value, description, owner, is_write)
values ('desempenho_anuncios', 'boolean', 'false', 'Como os anúncios rodaram: o cartão de Resultados com as impressões, o alcance, os cliques, o gasto e o resultado que a Meta e o Google informam, e o botão "Ler agora" (P23). Só leitura', 'midia', false)
on conflict (key) do nothing;

insert into liame.metric_mapping (provider, provider_metric, canonical_metric, transform, confidence, notes) values
  ('meta_ads', 'reach (time_ranges: o dia da leitura)', 'reach_dia', 'identidade', 'alta', 'pessoas diferentes no dia, até a hora da leitura; estimado pela Meta; por campanha e pela conta'),
  ('meta_ads', 'reach (time_ranges: os 7 dias até a véspera)', 'reach_7d', 'identidade', 'alta', 'pessoas diferentes nos 7 dias completos; estimado pela Meta; não se soma entre campanhas'),
  ('meta_ads', 'reach (time_ranges: os 30 dias até a véspera)', 'reach_30d', 'identidade', 'alta', 'pessoas diferentes nos 30 dias completos; estimado pela Meta; não se soma entre campanhas')
on conflict (provider, provider_metric) do nothing;
