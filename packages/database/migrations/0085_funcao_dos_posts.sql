-- 0085 · A função dos posts e as leituras da Meta que a preparam (A6, Z5a; `plano-a6.md` §3, D-A6-3, D-A6-7 e D-A6-17).
-- (1) A flag `social_write`, por empresa, desligada. É flag de escrita: nasce desligada e a parada geral a alcança.
--     Nesta entrega ela só faz a autorização da Meta que concedeu a permissão de publicar oferecer a Página do Facebook
--     e o Instagram profissional para ligar à marca, em Contas conectadas; nenhum post sai (a ferramenta do post, no
--     trilho de aprovação, entra nas partes seguintes da Z5).
-- (2) Duas leituras novas da Meta no registro de capacidades, na versão das outras (v26.0): as permissões que a pessoa
--     concedeu na autorização (`me/permissions`, e o `debug_token` com o token do app quando aquela é recusada: a troca
--     do código da Meta não devolve as permissões, ERR-179) e as Páginas que a autorização alcança, com o Instagram de
--     cada uma (`me/accounts`). Só leitura.
-- Conferido nas páginas oficiais em 28/10/2026 (base de conhecimento §2.2: as permissões de um token, o `debug_token`)
-- e no teste da D-A6-10 no piloto (o `me/accounts` com o Instagram da Página).
-- Da distribuição (sem empresa). Idempotente; uma transação por arquivo (ADR-018).

-- As sementes gravam em tabelas com RLS forçada (V20).
select set_config('app.scope', 'sistema', true);

insert into liame.connector_capability (provider, capability, api_version, read, write, required_scope, access_level, sunset_at, source_url, verified_at, notes) values
  ('meta_ads', 'permissions', 'v26.0', true, false, '{}', 'Qualquer token da autorização (o debug_token pede o token do app)', null,
   'https://developers.facebook.com/docs/graph-api/reference/user/permissions', '2026-10-28', 'Graph API: as permissões concedidas no token (me/permissions, só granted) e, quando ele é recusado, o debug_token com o token do app (is_valid e scopes); vão para oauth_connection.scopes'),
  ('meta_ads', 'pages', 'v26.0', true, false, '{pages_show_list}', 'Standard (testadores) ou Advanced', null,
   'https://developers.facebook.com/docs/graph-api/reference/user/accounts', '2026-10-28', 'Graph API: as Páginas que a autorização alcança, com o Instagram profissional de cada uma (me/accounts com instagram_business_account); procuradas só com a função social_write e a permissão de publicar')
on conflict (provider, capability) do nothing;

insert into liame.feature_flag (key, kind, default_value, description, owner, is_write)
values ('social_write', 'boolean', 'false', 'Posts: a autorização da Meta com a permissão de publicar oferece a Página e o Instagram para ligar à marca, e o post aprovado por uma pessoa com o código do app sai neles (A6, Z5)', 'social', true)
on conflict (key) do nothing;
