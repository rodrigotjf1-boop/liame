-- 0087 · O post no Instagram: as capacidades da Meta que o post usa (A6, Z5b, parte 2; `plano-a6.md` D-A6-3, D-A6-8 e
-- D-A6-21; as decisões técnicas D-A6-32 a D-A6-38).
-- Duas capacidades novas no registro, na versão das outras da Meta (v26.0):
-- (1) `instagram_publish`, a escrita: o contêiner do post (`POST /{ig}/media`, com o endereço da foto e a legenda) e a
--     publicação dele (`POST /{ig}/media_publish`). Só pelo trilho de ação, depois de uma pessoa aprovar com o código do
--     app, com a flag `social_write` (0085), que segue desligada para todos.
-- (2) `instagram_media`, as leituras que a escrita confere: a situação do contêiner (`status_code`), o limite de posts
--     pela API nas últimas 24 horas (`content_publishing_limit`), os posts recentes da conta (o que já saiu não sai de
--     novo) e o endereço do post publicado (`permalink`).
-- Conferido nas páginas oficiais em 29/10/2026 (base de conhecimento §2.2: content publishing e a referência do
-- `content_publishing_limit`, v26.0) e no teste da D-A6-10 no piloto (o contêiner com o endereço assinado de 5 minutos).
-- Da distribuição (sem empresa). Idempotente; uma transação por arquivo (ADR-018).

-- As sementes gravam em tabelas com RLS forçada (V20).
select set_config('app.scope', 'sistema', true);

insert into liame.connector_capability (provider, capability, api_version, read, write, required_scope, access_level, sunset_at, source_url, verified_at, notes) values
  ('meta_ads', 'instagram_publish', 'v26.0', false, true, '{instagram_basic,instagram_content_publish}', 'Standard (testadores) ou Advanced', null,
   'https://developers.facebook.com/docs/instagram-platform/content-publishing', '2026-10-29', 'Graph API: o contêiner do post (POST /{ig}/media, image_url e caption; a Meta busca a imagem na hora) e a publicação (POST /{ig}/media_publish, creation_id); só pelo trilho de ação, com a flag social_write'),
  ('meta_ads', 'instagram_media', 'v26.0', true, false, '{instagram_basic,instagram_content_publish}', 'Standard (testadores) ou Advanced', null,
   'https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/content_publishing_limit', '2026-10-29', 'Graph API: a situação do contêiner (status_code: FINISHED, IN_PROGRESS, ERROR, EXPIRED, PUBLISHED), o limite de posts em 24 horas (quota_usage e config.quota_total), os posts recentes (id, caption, timestamp, permalink) e o permalink do post publicado')
on conflict (provider, capability) do nothing;
