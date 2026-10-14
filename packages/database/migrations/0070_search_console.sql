-- 0070 · O Search Console no registro de capacidades (A6, Z3; `plano-a6.md` D-A6-1).
-- As duas leituras que o conector faz, as duas na API do Search Console (`/webmasters/v3`): os sites que a autorização
-- alcança e as buscas no Google que levaram a um site (cliques, vezes em que ele apareceu e a posição média), por dia
-- ou por busca. **Só leitura** (critério A6-6): o Liame não escreve no Search Console.
-- As duas pedem a permissão de só leitura `webmasters.readonly`, que o Liame só pede à empresa com a função ligada
-- (como a do Perfil, D-A6-17). A cota é por site e por usuário (1.200 consultas por minuto), sem pedido de acesso.
-- Métodos, campos e limites conferidos na referência oficial em 14/10/2026 (base de conhecimento §3.3).
-- Da distribuição (sem empresa). Idempotente; uma transação por arquivo (ADR-018).

select set_config('app.scope', 'sistema', true);

insert into liame.connector_capability (provider, capability, api_version, read, write, required_scope, access_level, sunset_at, source_url, verified_at, notes) values
  ('search_console', 'sites', 'v3', true, false, '{https://www.googleapis.com/auth/webmasters.readonly}', 'Aberto a todo projeto; cota por usuário', null,
   'https://developers.google.com/webmaster-tools/v1/sites/list', '2026-10-14', 'sites.list: os sites da autorização, com o nível de permissão (o site sem verificação não dá acesso a dado nenhum)'),
  ('search_console', 'search_analytics', 'v3', true, false, '{https://www.googleapis.com/auth/webmasters.readonly}', 'Aberto a todo projeto; 1.200 consultas por minuto por site e por usuário', null,
   'https://developers.google.com/webmaster-tools/v1/searchanalytics/query', '2026-10-14', 'searchAnalytics.query: cliques, vezes, CTR e posição por dia ou por busca; até 25.000 linhas por pedido; dado final em 2 a 3 dias, datas no fuso do Pacífico; a busca rara só entra no total')
on conflict (provider, capability) do nothing;
