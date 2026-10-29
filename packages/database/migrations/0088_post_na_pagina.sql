-- 0088 · O post na Página do Facebook: as capacidades da Meta que o post usa nela (A6, Z5b, parte 3; `plano-a6.md`
-- D-A6-3, D-A6-7 e D-A6-8; as decisões técnicas D-A6-32 a D-A6-39).
-- Duas capacidades novas no registro, na versão das outras da Meta (v26.0); o token da Página sai da lista das Páginas da
-- autorização (`me/accounts`, a capacidade `pages` da 0085, agora com o token e as tarefas de cada Página):
-- (1) `pagina_publish`, a escrita: a foto na Página (`POST /{página}/photos`, com o endereço da foto e a legenda), com o
--     token da Página de quem pode criar conteúdo nela. Só pelo trilho de ação, depois de uma pessoa aprovar com o código
--     do app, com a flag `social_write` (0085), que segue desligada para todos.
-- (2) `pagina_media`, as leituras que a escrita confere: as fotos da Página (`GET /{página}/photos?type=uploaded`: a que
--     já saiu não sai de novo) e o endereço do post publicado (`permalink_url`).
-- Conferido nas páginas oficiais em 29/10/2026 (base de conhecimento §2.2: a referência de `/{page-id}/photos` e do
-- `Photo`, v26.0, e o "Get a Page access token" das Pages API).
-- Da distribuição (sem empresa). Idempotente; uma transação por arquivo (ADR-018).

-- As sementes gravam em tabelas com RLS forçada (V20).
select set_config('app.scope', 'sistema', true);

insert into liame.connector_capability (provider, capability, api_version, read, write, required_scope, access_level, sunset_at, source_url, verified_at, notes) values
  ('meta_ads', 'pagina_publish', 'v26.0', false, true, '{pages_manage_posts,pages_read_engagement,pages_show_list}', 'Standard (testadores) ou Advanced', null,
   'https://developers.facebook.com/docs/graph-api/reference/page/photos/', '2026-10-29', 'Graph API: a foto na Página (POST /{page-id}/photos, url e caption; até 4 MB), com o token da Página de quem tem a tarefa CREATE_CONTENT; só pelo trilho de ação, com a flag social_write'),
  ('meta_ads', 'pagina_media', 'v26.0', true, false, '{pages_read_engagement,pages_show_list}', 'Standard (testadores) ou Advanced', null,
   'https://developers.facebook.com/docs/graph-api/reference/photo/', '2026-10-29', 'Graph API: as fotos da Página (GET /{page-id}/photos?type=uploaded: id, name = a legenda, created_time, link, page_story_id; pede a tarefa MODERATE) e o permalink_url do post publicado')
on conflict (provider, capability) do nothing;
