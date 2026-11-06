-- 0120 · O post com vídeo (A6, Z10, parte 3a; `plano-a6.md` D-A6-69 e D-A6-70; protótipo P37, parte B, aprovado pelo
-- dono em 04/11/2026). O post da marca (`social_post`, migration 0086) passa a levar um vídeo das Fotos e vídeos
-- (`brand_photo.kind = 'video'`, migration 0118), que sai como Reels no Instagram e, na Página do Facebook, como Reels (em
-- pé) ou vídeo comum (deitado). O vídeo vai no mesmo `photo_id` (o id das Fotos e vídeos), e `media` diz o que ele é.
-- O vídeo não tem o resumo do arquivo (o navegador não lê 300 MB): o que sai é o aprovado porque o arquivo do vídeo não
-- muda depois de pronto (a chave é do id). A capa do Reels (D-A6-70) fica presa na hora do pedido: a do próprio vídeo,
-- pela versão dela (`brand_photo.cover_version`, que sobe a cada capa gravada), ou uma das Fotos, pelo resumo do arquivo.
-- Mudou depois do pedido, o post não sai.
-- Três capacidades novas da Graph API no registro, conferidas na página oficial em 06/11/2026 (o "Reels Publishing" da
-- Video API e a referência de `/{page-id}/videos`, v27.0; o Liame segue na v26.0, como o resto da publicação).
-- Nada usa isto enquanto a função `videos` estiver desligada. Idempotente; uma transação por arquivo (ADR-018).

-- As sementes gravam em tabelas com RLS forçada (V20).
select set_config('app.scope', 'sistema', true);

-- ------------------------------------------------------------ a capa do vídeo

-- Sobe a cada capa gravada (`PUT /v1/brand-photos/{id}/cover`): é por ela que o post sabe se a capa mudou.
alter table liame.brand_photo add column if not exists cover_version integer not null default 0;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'brand_photo_cover_version_check' and conrelid = 'liame.brand_photo'::regclass) then
    alter table liame.brand_photo add constraint brand_photo_cover_version_check check (cover_version >= 0);
  end if;
end $$;

-- ------------------------------------------------------------ o post com vídeo

alter table liame.social_post add column if not exists media text not null default 'foto';
alter table liame.social_post alter column photo_sha256 drop not null;
-- A capa do Reels: uma das Fotos (com o resumo do arquivo na hora do pedido) ou a do próprio vídeo (pela versão).
alter table liame.social_post add column if not exists cover_photo_id uuid references liame.brand_photo (id) on delete set null;
alter table liame.social_post add column if not exists cover_sha256 text;
alter table liame.social_post add column if not exists cover_version integer;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'social_post_media_check' and conrelid = 'liame.social_post'::regclass) then
    alter table liame.social_post add constraint social_post_media_check check (media in ('foto', 'video'));
  end if;
  -- A foto: sempre com o resumo e sem capa; o vídeo: sem o resumo e sem recorte (o Reels não recorta), com no máximo
  -- uma capa presa (a foto, com o resumo, ou a versão da capa do vídeo; nenhuma = o quadro do meio).
  if not exists (select 1 from pg_constraint where conname = 'social_post_midia_check' and conrelid = 'liame.social_post'::regclass) then
    alter table liame.social_post add constraint social_post_midia_check check (
      (media = 'foto' and photo_sha256 is not null and cover_photo_id is null and cover_sha256 is null and cover_version is null)
      or (media = 'video' and photo_sha256 is null and crop_pos is null
          and (cover_photo_id is null) = (cover_sha256 is null)
          and (cover_sha256 is null or cover_sha256 ~ '^[0-9a-f]{64}$')
          and (cover_version is null or (cover_version >= 0 and cover_photo_id is null))));
  end if;
end $$;

-- Desde quando a Meta prepara o vídeo nesta tentativa (D-A6-69: o Liame confere uma vez por minuto, por até 5 minutos).
-- Nulo fora do preparo; a nova tentativa começa a contar de novo.
alter table liame.social_post_channel add column if not exists preparing_since timestamptz;

-- ------------------------------------------------------------ as capacidades da Página

insert into liame.connector_capability (provider, capability, api_version, read, write, required_scope, access_level, sunset_at, source_url, verified_at, notes) values
  ('meta_ads', 'pagina_reels', 'v26.0', false, true, '{pages_manage_posts,pages_read_engagement,pages_show_list}', 'Standard (testadores) ou Advanced', null,
   'https://developers.facebook.com/docs/video-api/guides/reels-publishing', '2026-11-06', 'Graph API: o Reels na Página (POST /{page-id}/video_reels com upload_phase start; o arquivo pelo rupload.facebook.com com o cabeçalho file_url; upload_phase finish com video_state PUBLISHED e description), com o token da Página de quem tem a tarefa CREATE_CONTENT; até 30 por Página em 24 horas; só pelo trilho de ação, com as flags social_write e videos'),
  ('meta_ads', 'pagina_video', 'v26.0', false, true, '{pages_manage_posts,pages_read_engagement,pages_show_list}', 'Standard (testadores) ou Advanced', null,
   'https://developers.facebook.com/docs/graph-api/reference/page/videos/', '2026-11-06', 'Graph API: o vídeo comum na Página (POST /{page-id}/videos com file_url e description), para o vídeo deitado; com o token da Página de quem tem a tarefa CREATE_CONTENT; só pelo trilho de ação, com as flags social_write e videos'),
  ('meta_ads', 'pagina_video_media', 'v26.0', true, false, '{pages_read_engagement,pages_show_list}', 'Standard (testadores) ou Advanced', null,
   'https://developers.facebook.com/docs/video-api/guides/reels-publishing', '2026-11-06', 'Graph API: a situação do vídeo na Página (GET /{video-id}?fields=status: video_status, processing_phase e publishing_phase) e o permalink_url do vídeo publicado')
on conflict (provider, capability) do nothing;

-- ------------------------------------------------------------ conferência

do $$ begin
  if not exists (select 1 from information_schema.columns where table_schema = 'liame' and table_name = 'brand_photo' and column_name = 'cover_version') then
    raise exception '0120: a versão da capa não entrou';
  end if;
  if (select count(*) from information_schema.columns
       where table_schema = 'liame' and table_name = 'social_post' and column_name in ('media', 'cover_photo_id', 'cover_sha256', 'cover_version')) <> 4 then
    raise exception '0120: as colunas do post com vídeo não entraram';
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'liame' and table_name = 'social_post' and column_name = 'photo_sha256' and is_nullable = 'NO') then
    raise exception '0120: o resumo da foto continua obrigatório';
  end if;
  if (select count(*) from pg_constraint where conrelid = 'liame.social_post'::regclass and conname in ('social_post_media_check', 'social_post_midia_check')) <> 2 then
    raise exception '0120: as regras do post com vídeo não entraram';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'liame' and table_name = 'social_post_channel' and column_name = 'preparing_since') then
    raise exception '0120: o preparo do canal não entrou';
  end if;
  if (select count(*) from liame.connector_capability where provider = 'meta_ads' and capability in ('pagina_reels', 'pagina_video', 'pagina_video_media')) <> 3 then
    raise exception '0120: as capacidades do vídeo na Página não entraram';
  end if;
  -- Nenhum post antigo ficou fora da regra (todos são de foto, com o resumo).
  if exists (select 1 from liame.social_post where media = 'foto' and photo_sha256 is null) then
    raise exception '0120: há post de foto sem o resumo';
  end if;
end $$;
