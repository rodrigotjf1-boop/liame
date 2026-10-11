-- 0066 · O Perfil da Empresa no Google no registro de capacidades (A6, Z1; `plano-a6.md` D-A6-1 e D-A6-17).
-- As quatro leituras que o conector faz, cada uma com a versão da API dela: as contas, as lojas, as avaliações e os
-- números do perfil (vistas, rotas, ligações, cliques no site). Só leitura: responder avaliação é a Z2.
-- Todas pedem a permissão `business.manage`, que o Liame só pede à empresa com a função ligada (D-A6-17). O acesso à
-- API é liberado pelo Google por pedido: até lá a cota é zero, e toda chamada volta como limite.
-- Versões e campos conferidos na referência oficial em 09/10 e 11/10/2026 (base de conhecimento §3.3).
-- Da distribuição (sem empresa). Idempotente; uma transação por arquivo (ADR-018).

select set_config('app.scope', 'sistema', true);

insert into liame.connector_capability (provider, capability, api_version, read, write, required_scope, access_level, sunset_at, source_url, verified_at, notes) values
  ('google_business', 'accounts', 'v1', true, false, '{https://www.googleapis.com/auth/business.manage}', 'Acesso básico à API, liberado por pedido (0 QPM antes)', null,
   'https://developers.google.com/my-business/reference', '2026-10-09', 'Account Management API: as contas do Perfil da Empresa que a autorização alcança; pageSize até 20'),
  ('google_business', 'locations', 'v1', true, false, '{https://www.googleapis.com/auth/business.manage}', 'Acesso básico à API, liberado por pedido (0 QPM antes)', null,
   'https://developers.google.com/my-business/reference', '2026-10-09', 'Business Information API: as lojas de cada conta; readMask obrigatório; pageSize até 100'),
  ('google_business', 'reviews', 'v4', true, false, '{https://www.googleapis.com/auth/business.manage}', 'Acesso básico à API, liberado por pedido (0 QPM antes)', null,
   'https://developers.google.com/my-business/reference/rest/v4/accounts.locations.reviews', '2026-10-11', 'My Business API v4: as avaliações da loja (nota, texto, datas e a resposta com a situação dela); pageSize até 50; só loja verificada'),
  ('google_business', 'performance_daily', 'v1', true, false, '{https://www.googleapis.com/auth/business.manage}', 'Acesso básico à API, liberado por pedido (0 QPM antes)', null,
   'https://developers.google.com/my-business/reference/performance/rest/v1/locations/fetchMultiDailyMetricsTimeSeries', '2026-10-11', 'Business Profile Performance API: os números do perfil por dia; o valor zero não vem na resposta')
on conflict (provider, capability) do nothing;
