-- 0118 · O vídeo nas Fotos (A6, Z10, parte 1; `plano-a6.md` D-A6-67 e D-A6-68; protótipo P37, aprovado pelo dono em
-- 04/11/2026). A tabela das Fotos (`brand_photo`, migration 0076) passa a guardar também o vídeo que a loja gravou: o
-- tipo `video`, ao lado da foto de produto. O vídeo vai do navegador direto para o armazenamento (o endereço de envio
-- assinado); o Liame confere o cabeçalho do arquivo (MP4 ou MOV, de 3 a 90 segundos, até 300 MB) e só então ele fica
-- pronto. Antes de conferido, o vídeo ainda não tem as medidas nem a duração (`status = 'enviando'`). O vídeo não tem o
-- sha256 do arquivo (o navegador não lê 300 MB para calcular): a regra da foto repetida segue valendo só para as fotos.
-- A capa é um quadro do vídeo, guardada como a miniatura da foto (`has_cover`).
-- Nada usa o tipo novo enquanto a função `videos` estiver desligada. Idempotente; uma transação por arquivo (ADR-018).
-- A semente da flag grava em tabela com RLS forçada (V20).
select set_config('app.scope', 'sistema', true);

-- ------------------------------------------------------------ o tipo e os limites

alter table liame.brand_photo drop constraint if exists brand_photo_kind_check;
alter table liame.brand_photo add constraint brand_photo_kind_check check (kind in ('foto_produto', 'video'));

-- A foto até 10 MB (a cópia regravada); o vídeo até 300 MB (o arquivo como a loja gravou, D-A6-68).
alter table liame.brand_photo drop constraint if exists brand_photo_bytes_check;
alter table liame.brand_photo add constraint brand_photo_bytes_check
  check (bytes >= 1 and bytes <= case when kind = 'video' then 314572800 else 10485760 end);

-- O vídeo só ganha as medidas e a duração quando é conferido; a foto as tem desde o envio.
alter table liame.brand_photo alter column sha256 drop not null;
alter table liame.brand_photo alter column width drop not null;
alter table liame.brand_photo alter column height drop not null;

alter table liame.brand_photo add column if not exists duration_ms integer;
alter table liame.brand_photo add column if not exists media_type text;
alter table liame.brand_photo add column if not exists has_audio boolean;
alter table liame.brand_photo add column if not exists has_cover boolean not null default false;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'brand_photo_duracao_check' and conrelid = 'liame.brand_photo'::regclass) then
    alter table liame.brand_photo add constraint brand_photo_duracao_check check (duration_ms is null or duration_ms between 1 and 900000);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'brand_photo_media_type_check' and conrelid = 'liame.brand_photo'::regclass) then
    alter table liame.brand_photo add constraint brand_photo_media_type_check check (media_type is null or media_type in ('video/mp4', 'video/quicktime'));
  end if;
  -- A foto: sempre com o sha256 e as medidas, sem os campos do vídeo. O vídeo: sempre com o formato; pronto, também com
  -- as medidas e a duração.
  if not exists (select 1 from pg_constraint where conname = 'brand_photo_tipo_check' and conrelid = 'liame.brand_photo'::regclass) then
    alter table liame.brand_photo add constraint brand_photo_tipo_check check (
      (kind = 'foto_produto' and sha256 is not null and width is not null and height is not null
         and duration_ms is null and media_type is null and has_audio is null)
      or (kind = 'video' and media_type is not null
         and (status = 'enviando' or (width is not null and height is not null and duration_ms is not null))));
  end if;
end $$;

-- ------------------------------------------------------------ a função

-- Liga, por empresa, o vídeo nas Fotos e nos posts (D-A6-67 a D-A6-69). Nasce desligada: o texto da Política sobre os
-- vídeos (o armazenamento, o prazo e o direito de imagem de quem aparece) vem antes de ligar. Sozinha, não publica nada.
insert into liame.feature_flag (key, kind, default_value, description, owner, is_write)
values ('videos', 'boolean', 'false', 'Fotos e vídeos: o vídeo que a loja gravou (MP4 ou MOV, de 3 a 90 s, até 300 MB), enviado direto ao armazenamento, conferido e, depois, publicado como Reels (A6, Z10)', 'social', false)
on conflict (key) do nothing;

-- ------------------------------------------------------------ conferência

do $$ begin
  if (select count(*) from information_schema.columns
       where table_schema = 'liame' and table_name = 'brand_photo' and column_name in ('duration_ms', 'media_type', 'has_audio', 'has_cover')) <> 4 then
    raise exception '0118: as colunas do vídeo não entraram';
  end if;
  if (select count(*) from pg_constraint
       where conrelid = 'liame.brand_photo'::regclass
         and conname in ('brand_photo_kind_check', 'brand_photo_bytes_check', 'brand_photo_duracao_check', 'brand_photo_media_type_check', 'brand_photo_tipo_check')) <> 5 then
    raise exception '0118: as regras do vídeo não entraram';
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'liame' and table_name = 'brand_photo' and column_name = 'sha256' and is_nullable = 'NO') then
    raise exception '0118: o sha256 continua obrigatório';
  end if;
  if not exists (select 1 from liame.feature_flag where key = 'videos' and default_value = 'false'::jsonb) then
    raise exception '0118: a função videos não entrou desligada';
  end if;
end $$;
