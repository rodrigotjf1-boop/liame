-- 0122 · "Do seu Instagram": as publicações que a loja já fez no Instagram, lidas com os números (A6, Z10, parte 5;
-- D-A6-71 e D-A6-83; `plano-a6.md` Z10).
-- O que o Liame guarda do que lê da conta do Instagram ligada a uma marca (a conta `instagram`): as publicações mais
-- novas (até 50), cada uma com o tipo, a legenda, o endereço, a miniatura no endereço da Meta e os números. Nenhum
-- arquivo: a miniatura fica no Instagram, e o endereço dela vence em alguns dias (a leitura de cada dia traz um novo).
-- A lista espelha a conta: a publicação que sai das 50 mais novas, ou que a loja apagou no Instagram, sai daqui na
-- leitura seguinte. A leitura é da rotina `do-seu-instagram` do worker, só para a empresa com as funções `fotos` e
-- `videos` ligadas; o frescor fica em `sync_state`, com o conjunto `instagram_publicacoes`.
-- Idempotente; uma transação por arquivo (ADR-018).

create table if not exists liame.instagram_media (
  connected_account_id  uuid not null references liame.connected_account (id) on delete cascade,
  tenant_id             uuid not null references liame.organization (id) on delete cascade,
  brand_id              uuid not null references liame.brand (id) on delete cascade,
  -- O id da publicação no Instagram.
  media_id              text not null,
  -- `reels`, `foto`, `carrossel` ou `video` (o vídeo do feed de antes do Reels).
  kind                  text not null,
  -- A legenda, como está no Instagram (até 2.200 caracteres, o limite de lá).
  caption               text not null default '',
  permalink             text,
  -- A miniatura no endereço da Meta (a imagem, ou a capa do vídeo).
  thumbnail_url         text,
  -- A Meta entrega o arquivo do vídeo (falso no Reels com música do Instagram).
  has_file              boolean not null default false,
  published_at          timestamptz not null,
  -- Os números: as curtidas e os comentários vêm na lista; os outros, da leitura dos números de cada publicação.
  views                 bigint,
  reach                 bigint,
  likes                 bigint,
  comments              bigint,
  saved                 bigint,
  shares                bigint,
  metrics_read_at       timestamptz,
  read_at               timestamptz not null default now(),
  primary key (connected_account_id, media_id),
  constraint instagram_media_id check (length(media_id) between 1 and 40),
  constraint instagram_media_tipo check (kind in ('reels', 'foto', 'carrossel', 'video')),
  constraint instagram_media_legenda check (length(caption) <= 2200),
  constraint instagram_media_endereco check (permalink is null or length(permalink) between 1 and 500),
  constraint instagram_media_miniatura check (thumbnail_url is null or length(thumbnail_url) between 1 and 2000),
  constraint instagram_media_numeros check (
    coalesce(views, 0) >= 0 and coalesce(reach, 0) >= 0 and coalesce(likes, 0) >= 0
    and coalesce(comments, 0) >= 0 and coalesce(saved, 0) >= 0 and coalesce(shares, 0) >= 0)
);
create index if not exists idx_instagram_media_marca on liame.instagram_media (tenant_id, brand_id, published_at desc);

alter table liame.instagram_media enable row level security;
alter table liame.instagram_media force row level security;
drop policy if exists instagram_media_isolamento on liame.instagram_media;
create policy instagram_media_isolamento on liame.instagram_media
  using (tenant_id = liame.current_tenant_id() or liame.system_scope())
  with check (tenant_id = liame.current_tenant_id() or liame.system_scope());
-- A leitura substitui a lista da conta (a publicação que saiu do Instagram, ou das 50 mais novas, sai daqui): o `delete`.
grant select, insert, update, delete on liame.instagram_media to liame_app;
