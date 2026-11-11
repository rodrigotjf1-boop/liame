-- 0136 · Os Stories (A6, Z13, parte 1; protótipo P41, com as decisões recomendadas D-A6-126 a D-A6-130, pela regra do
-- dono de seguir a recomendada; `plano-a6.md` Z13). O Story sai pelo mesmo trilho do post: aprovado com o código do app,
-- uma vez só, na hora marcada, no Instagram e na Página, sem texto e sem link, e fica 24 horas no ar.
-- (1) Duas capacidades no registro, na versão das outras da Meta (v26.0), conferidas nas páginas oficiais em 11/11/2026:
--     `pagina_story` (a foto: `POST /{page-id}/photos` com `published=false` e `POST /{page-id}/photo_stories`; o vídeo:
--     `POST /{page-id}/video_stories` em duas fases, com o envio pelo `rupload`) e `pagina_story_media` (`GET
--     /{page-id}/stories`). No Instagram, o Story usa o mesmo contêiner e o mesmo `media_publish` do post
--     (`instagram_publish`), com `media_type=STORIES`.
-- (2) A função `stories`, desligada (de leitura: a escrita é a `social_write` do post).
-- (3) `social_post.format`: `post` ou `story`. O Story é um post do Liame (não o pacote), sem recorte e sem capa.
-- (4) O texto do canal pode ficar vazio (o Story não leva texto); o post continua pedindo o texto pelo serviço e pelo
--     plano do trilho.
-- Da distribuição (o registro e a função) e das empresas (o post). Idempotente; uma transação por arquivo (ADR-018).

-- As sementes gravam em tabelas com RLS forçada (V20).
select set_config('app.scope', 'sistema', true);

-- ------------------------------------------------------------ (1) as capacidades

insert into liame.connector_capability (provider, capability, api_version, read, write, required_scope, access_level, sunset_at, source_url, verified_at, notes) values
  ('meta_ads', 'pagina_story', 'v26.0', false, true, '{pages_manage_posts,pages_read_engagement,pages_show_list}', 'Standard (testadores) ou Advanced', null,
   'https://developers.facebook.com/docs/page-stories-api', '2026-11-11',
   'Graph API: o Story da Página. A foto: POST /{page-id}/photos com published=false (a foto fica sem post) e POST /{page-id}/photo_stories com photo_id, que devolve post_id. O vídeo: POST /{page-id}/video_stories com upload_phase=start (video_id e upload_url), o envio pelo rupload.facebook.com com file_url e POST com upload_phase=finish e video_id. Token da Página de quem tem a tarefa CREATE_CONTENT. Foto até 10 MB; vídeo 9:16, de 3 a 90 s'),
  ('meta_ads', 'pagina_story_media', 'v26.0', true, false, '{pages_manage_posts,pages_read_engagement,pages_show_list}', 'Standard (testadores) ou Advanced', null,
   'https://developers.facebook.com/docs/page-stories-api', '2026-11-11',
   'Graph API: os Stories da Página (GET /{page-id}/stories: post_id, status PUBLISHED ou ARCHIVED, creation_time, media_type photo ou video, media_id, url; since e until filtram)')
on conflict (provider, capability) do nothing;

-- ------------------------------------------------------------ (2) a função

insert into liame.feature_flag (key, kind, default_value, description, owner, is_write)
values ('stories', 'boolean', 'false', 'Stories: o Story com a foto ou o vídeo de Fotos no Instagram e na Página, pelo trilho do post, sem texto, 24 horas no ar (A6, Z13)', 'social', false)
on conflict (key) do nothing;

-- ------------------------------------------------------------ (3) o formato do post

alter table liame.social_post add column if not exists format text not null default 'post';
do $$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'liame.social_post'::regclass and conname = 'social_post_format_check') then
    alter table liame.social_post add constraint social_post_format_check check (format in ('post', 'story'));
  end if;
  -- O Story é um post do Liame, sem recorte e sem capa: a mídia vai inteira.
  if not exists (select 1 from pg_constraint where conrelid = 'liame.social_post'::regclass and conname = 'social_post_story_check') then
    alter table liame.social_post add constraint social_post_story_check check (
      format <> 'story' or (kind = 'post' and crop_pos is null and cover_photo_id is null and cover_version is null and cover_offset_ms is null)
    );
  end if;
end $$;

-- ------------------------------------------------------------ (4) o texto do canal pode ficar vazio

do $$ begin
  if exists (select 1 from pg_constraint where conrelid = 'liame.social_post_channel'::regclass and conname = 'social_post_channel_body_check') then
    alter table liame.social_post_channel drop constraint social_post_channel_body_check;
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'liame.social_post_channel'::regclass and conname = 'social_post_channel_texto') then
    alter table liame.social_post_channel add constraint social_post_channel_texto check (length(body) <= 10000);
  end if;
end $$;

-- ------------------------------------------------------------ conferência

do $$ begin
  if (select count(*) from liame.connector_capability where provider = 'meta_ads' and capability in ('pagina_story', 'pagina_story_media')) <> 2 then
    raise exception '0136: as capacidades do Story da Página não entraram';
  end if;
  if not exists (select 1 from liame.feature_flag where key = 'stories' and default_value = 'false'::jsonb and not is_write) then
    raise exception '0136: a função stories não entrou desligada';
  end if;
  if (select count(*) from pg_constraint where conrelid = 'liame.social_post'::regclass and conname in ('social_post_format_check', 'social_post_story_check')) <> 2 then
    raise exception '0136: as regras do formato do post não entraram';
  end if;
  if exists (select 1 from pg_constraint where conrelid = 'liame.social_post_channel'::regclass and conname = 'social_post_channel_body_check')
     or not exists (select 1 from pg_constraint where conrelid = 'liame.social_post_channel'::regclass and conname = 'social_post_channel_texto') then
    raise exception '0136: o texto do canal não ficou opcional';
  end if;
end $$;
