-- 0147 · A campanha nova a partir de um Reels já publicado (A4 · X5, parte 6; P42 aprovado em 11/11/2026; D-A4-46).
-- Em Fotos › Do seu Instagram, o Reels da loja vira a campanha nova pela mesma gaveta: o vídeo e a legenda ficam como
-- estão (a Meta usa o próprio post, `source_instagram_media_id`), o Liame põe o botão e o rastreio, e ela nasce pausada.
-- A campanha nova passa a ter duas origens: a peça aprovada com a foto ou o vídeo de Fotos (como antes) ou o Reels (o id
-- dele no Instagram, `instagram_media`), nunca as duas. Um pedido em aberto por Reels, como por peça. Idempotente; uma
-- transação por arquivo (ADR-018).

alter table liame.ad_campaign_new alter column piece_id drop not null;
alter table liame.ad_campaign_new alter column piece_version drop not null;
alter table liame.ad_campaign_new alter column media_id drop not null;
alter table liame.ad_campaign_new add column if not exists instagram_media_id text;

do $$ begin
  if not exists (select 1 from pg_constraint c join pg_namespace n on n.oid = c.connamespace
                  where n.nspname = 'liame' and c.conname = 'ad_campaign_new_instagram_media_check') then
    alter table liame.ad_campaign_new add constraint ad_campaign_new_instagram_media_check
      check (instagram_media_id is null or (length(instagram_media_id) between 1 and 40 and instagram_media_id ~ '^[0-9]+$'));
  end if;
  if not exists (select 1 from pg_constraint c join pg_namespace n on n.oid = c.connamespace
                  where n.nspname = 'liame' and c.conname = 'ad_campaign_new_origem') then
    alter table liame.ad_campaign_new add constraint ad_campaign_new_origem
      check ((instagram_media_id is null and piece_id is not null and piece_version is not null and media_id is not null)
          or (instagram_media_id is not null and piece_id is null and piece_version is null and media_id is null));
  end if;
end $$;

-- Um pedido em aberto por Reels da marca (o de peça continua no `ad_campaign_new_peca_em_aberto`).
create unique index if not exists ad_campaign_new_reels_em_aberto
  on liame.ad_campaign_new (brand_id, instagram_media_id) where status in ('pedida', 'criando') and instagram_media_id is not null;

-- ------------------------------------------------------------ a conferência

do $$ begin
  if exists (select 1 from information_schema.columns
              where table_schema = 'liame' and table_name = 'ad_campaign_new' and column_name in ('piece_id', 'piece_version', 'media_id') and is_nullable = 'NO') then
    raise exception '0147: a peça e a mídia de Fotos continuam obrigatórias';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'liame' and table_name = 'ad_campaign_new' and column_name = 'instagram_media_id') then
    raise exception '0147: a coluna instagram_media_id não entrou';
  end if;
  if not exists (select 1 from pg_constraint c join pg_namespace n on n.oid = c.connamespace where n.nspname = 'liame' and c.conname = 'ad_campaign_new_origem') then
    raise exception '0147: a regra das duas origens não entrou';
  end if;
  if not exists (select 1 from pg_indexes where schemaname = 'liame' and indexname = 'ad_campaign_new_reels_em_aberto') then
    raise exception '0147: o índice do Reels em aberto não entrou';
  end if;
end $$;
