-- 0121 · A capa do Reels por um quadro do vídeo (A6, Z10, parte 4a; D-A6-70; protótipo P37, parte B, aprovado pelo dono
-- em 04/11/2026). No novo post com vídeo, a pessoa escolhe a capa entre os quadros do próprio vídeo (o do meio vem
-- marcado: é a capa guardada com ele) ou uma das Fotos. O quadro escolhido que não é o guardado vai à Meta como o tempo
-- dele no vídeo (o Instagram usa o `thumb_offset`, em milissegundos): o post guarda esse tempo, e ele é a capa presa no
-- pedido (o arquivo do vídeo não muda, então o mesmo tempo é o mesmo quadro). Uma capa só por post.
-- Nada usa isto enquanto a função `videos` estiver desligada. Idempotente; uma transação por arquivo (ADR-018).

alter table liame.social_post add column if not exists cover_offset_ms integer;

do $$ begin
  -- O quadro só no post com vídeo, dentro dos 90 s do vídeo (D-A6-68; com folga até os 15 min do Instagram), e no lugar
  -- das outras capas (a foto, com o resumo; a versão da capa guardada).
  if not exists (select 1 from pg_constraint where conname = 'social_post_quadro_check' and conrelid = 'liame.social_post'::regclass) then
    alter table liame.social_post add constraint social_post_quadro_check check (
      cover_offset_ms is null
      or (media = 'video' and cover_offset_ms between 0 and 900000 and cover_sha256 is null and cover_version is null));
  end if;
end $$;

-- ------------------------------------------------------------ conferência

do $$ begin
  if not exists (select 1 from information_schema.columns where table_schema = 'liame' and table_name = 'social_post' and column_name = 'cover_offset_ms') then
    raise exception '0121: o quadro da capa não entrou';
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'liame.social_post'::regclass and conname = 'social_post_quadro_check') then
    raise exception '0121: a regra do quadro da capa não entrou';
  end if;
end $$;
