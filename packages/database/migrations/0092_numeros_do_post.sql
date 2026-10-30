-- 0092 · Os números de cada post nas redes (A6, Z7, parte c; `plano-a6.md` D-A6-16 e as decisões técnicas D-A6-50 a
-- D-A6-52): o alcance, as visualizações e as interações de cada canal publicado, lidos da Meta e guardados como apoio
-- (o resultado do post é o pedido pelo link dele, D-A6-16).
-- (1) Duas capacidades novas no registro, na versão das outras da Meta (v26.0), conferidas nas páginas oficiais em
--     29/10/2026 (base de conhecimento §2.2, reconferida em 21/10/2026 para a Z7):
--     `instagram_insights`: `GET /{ig-media-id}/insights` (views, reach, likes, comments, saved, shares e
--     total_interactions do post do feed; até 48 horas de atraso; o que falta volta como lista vazia);
--     `pagina_insights`: `GET /{page-post-id}/insights` (post_media_view, post_total_media_view_unique, post_clicks e
--     post_reactions_by_type_total; só na Página com 100 curtidas ou mais; atualiza a cada 24 horas).
-- (2) No canal do post: os números lidos (`metrics`), a situação da leitura (`metrics_status`), quando foi lida
--     (`metrics_read_at`) e a próxima leitura (`metrics_next_at`, a fila do worker). O canal publicado entra na fila; a
--     leitura para 30 dias depois de o post sair.
-- Da distribuição (o registro) e das empresas (o canal). Idempotente; uma transação por arquivo (ADR-018).

-- As sementes gravam em tabelas com RLS forçada (V20).
select set_config('app.scope', 'sistema', true);

insert into liame.connector_capability (provider, capability, api_version, read, write, required_scope, access_level, sunset_at, source_url, verified_at, notes) values
  ('meta_ads', 'instagram_insights', 'v26.0', true, false, '{instagram_basic,instagram_manage_insights,pages_read_engagement}', 'Standard (testadores) ou Advanced', null,
   'https://developers.facebook.com/docs/instagram-platform/reference/instagram-media/insights', '2026-10-29', 'Graph API: os números do post do feed (GET /{ig-media-id}/insights; views, reach, likes, comments, saved, shares, total_interactions; período lifetime; até 48 horas de atraso; o que falta volta como lista vazia, não zero; o carrossel tem o número do post inteiro)'),
  ('meta_ads', 'pagina_insights', 'v26.0', true, false, '{read_insights,pages_read_engagement}', 'Standard (testadores) ou Advanced', null,
   'https://developers.facebook.com/docs/graph-api/reference/insights', '2026-10-29', 'Graph API: os números do post da Página (GET /{page-post-id}/insights; post_media_view, post_total_media_view_unique, post_clicks, post_reactions_by_type_total; lifetime; só na Página com 100 curtidas ou mais; token da Página de quem pode ANALYZE; atualiza a cada 24 horas)')
on conflict (provider, capability) do nothing;

alter table liame.social_post_channel add column if not exists metrics jsonb;
alter table liame.social_post_channel add column if not exists metrics_status text;
alter table liame.social_post_channel add column if not exists metrics_read_at timestamptz;
alter table liame.social_post_channel add column if not exists metrics_next_at timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'social_post_channel_metrics_check' and conrelid = 'liame.social_post_channel'::regclass) then
    alter table liame.social_post_channel add constraint social_post_channel_metrics_check
      check ((metrics is null or jsonb_typeof(metrics) = 'object')
             and (metrics_status is null or metrics_status in ('lido', 'sem_dados', 'sem_permissao', 'sem_conta')));
  end if;
end $$;

-- A fila da leitura: só o canal com a próxima leitura marcada.
create index if not exists idx_social_post_channel_numeros on liame.social_post_channel (metrics_next_at) where metrics_next_at is not null;

-- O canal do Liame que já saiu entra na fila agora (a produção ainda não tem post publicado: a função segue desligada).
update liame.social_post_channel
   set metrics_next_at = now()
 where status = 'publicado' and channel in ('instagram', 'facebook') and external_id is not null
   and metrics_next_at is null and metrics_read_at is null;
