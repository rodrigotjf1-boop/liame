-- 0160 · A versão do vídeo para o Instagram (A6, Z10, parte 3b; D-A6-68 e D-A6-149). O Reels e o Story do Instagram
-- aceitam o arquivo com até 1.920 px de largura e até 25 Mbps; o 4K do celular passa disso e, até aqui, ia só na Página.
-- Agora, quando o vídeo que a loja enviou não cabe como está, o serviço de montagem (`liame-render`) faz uma cópia
-- reduzida (até 1.920 px no lado maior, na mesma proporção, em H.264 e AAC), guardada ao lado do arquivo
-- (`{id}-instagram.mp4`). O Instagram leva a cópia; a Página, o pacote do TikTok e do YouTube e o "Baixe o vídeo" seguem
-- com o arquivo como a loja gravou. A fila é esta coluna (`instagram_status`), uma só para todas as marcas: na_fila
-- (espera a vez), reduzindo (o serviço pegou), pronta (a cópia está guardada, com as medidas e o tamanho dela) e nao_deu
-- (três tentativas sem sucesso, ou o arquivo que o ffmpeg não abre: o vídeo segue só na Página, como antes). Nulo: o
-- vídeo cabe como está, ou é uma foto. Os vídeos já em Fotos que não cabem entram na fila. Das empresas. Idempotente; uma
-- transação por arquivo (ADR-018).

-- A fila dos vídeos que já estão em Fotos grava numa tabela com RLS forçada (V20).
select set_config('app.scope', 'sistema', true);

-- ------------------------------------------------------------ (1) as colunas da cópia

alter table liame.brand_photo add column if not exists instagram_status text;
alter table liame.brand_photo add column if not exists instagram_bytes bigint;
alter table liame.brand_photo add column if not exists instagram_width integer;
alter table liame.brand_photo add column if not exists instagram_height integer;
-- Quantas vezes o serviço pegou este vídeo (a terceira que falha vira `nao_deu`).
alter table liame.brand_photo add column if not exists instagram_attempts smallint not null default 0;
-- A marca desta vez: só ela termina a cópia (o serviço que parou no meio não grava por cima de outro).
alter table liame.brand_photo add column if not exists instagram_started_at timestamptz;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'brand_photo_instagram_status_check' and conrelid = 'liame.brand_photo'::regclass) then
    alter table liame.brand_photo add constraint brand_photo_instagram_status_check
      check (instagram_status is null or (kind = 'video' and instagram_status in ('na_fila', 'reduzindo', 'pronta', 'nao_deu')));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'brand_photo_instagram_attempts_check' and conrelid = 'liame.brand_photo'::regclass) then
    alter table liame.brand_photo add constraint brand_photo_instagram_attempts_check check (instagram_attempts between 0 and 10);
  end if;
end $$;

-- A cópia pronta sempre com as medidas e o tamanho (os três `is not null`: o `between` com nulo dá nulo, e a regra com
-- nulo passa); as medidas dentro do que o Instagram aceita (1.920 px no lado maior), o tamanho dentro do limite do vídeo.
-- Refeita a cada vez (a regra é a mesma; idempotente).
alter table liame.brand_photo drop constraint if exists brand_photo_instagram_pronta_check;
alter table liame.brand_photo add constraint brand_photo_instagram_pronta_check
  check (instagram_status is distinct from 'pronta'
         or (instagram_bytes is not null and instagram_width is not null and instagram_height is not null
             and instagram_bytes between 1 and 314572800 and instagram_width between 2 and 1920 and instagram_height between 2 and 1920));

-- ------------------------------------------------------------ (2) a fila

-- O mais antigo que espera primeiro (o serviço pega com `for update skip locked`), e o que parou no meio para soltar.
create index if not exists brand_photo_instagram_fila on liame.brand_photo (created_at, id)
  where instagram_status in ('na_fila', 'reduzindo') and removed_at is null;

-- Os vídeos já em Fotos que não cabem no Instagram como estão (a conta de `fitsInstagramReels` nos contratos: a largura
-- até 1.920 px e a taxa média até 25 Mbps) entram na fila.
update liame.brand_photo
   set instagram_status = 'na_fila'
 where kind = 'video' and status = 'pronta' and removed_at is null and instagram_status is null
   and duration_ms > 0
   and (width > 1920 or bytes * 8.0 / (duration_ms / 1000.0) > 25000000);

-- ------------------------------------------------------------ conferência

do $$ begin
  if (select count(*) from information_schema.columns
       where table_schema = 'liame' and table_name = 'brand_photo'
         and column_name in ('instagram_status', 'instagram_bytes', 'instagram_width', 'instagram_height', 'instagram_attempts', 'instagram_started_at')) <> 6 then
    raise exception '0160: as colunas da cópia para o Instagram não entraram';
  end if;
  if (select count(*) from pg_constraint
       where conrelid = 'liame.brand_photo'::regclass
         and conname in ('brand_photo_instagram_status_check', 'brand_photo_instagram_pronta_check', 'brand_photo_instagram_attempts_check')) <> 3 then
    raise exception '0160: as regras da cópia para o Instagram não entraram';
  end if;
  if not exists (select 1 from pg_indexes where schemaname = 'liame' and indexname = 'brand_photo_instagram_fila') then
    raise exception '0160: o índice da fila não entrou';
  end if;
  if exists (select 1 from liame.brand_photo
              where kind = 'video' and status = 'pronta' and removed_at is null and instagram_status is null and duration_ms > 0
                and (width > 1920 or bytes * 8.0 / (duration_ms / 1000.0) > 25000000)) then
    raise exception '0160: ficou vídeo grande para o Instagram fora da fila';
  end if;
end $$;
