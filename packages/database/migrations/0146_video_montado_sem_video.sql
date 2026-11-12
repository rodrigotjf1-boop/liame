-- 0146 · O vídeo montado: o pedido pronto pode perder o vídeo (A6 · Z15, parte 2b; D-A6-140). A 0143 exigia o vídeo em
-- todo pedido `pronto` (`video_montage_pronto_com_video`), mas o vídeo é de Fotos: quando a pessoa o apaga, a rotina de
-- Fotos tira a linha, o `photo_id` vira nulo (`on delete set null`) e a regra recusava a exclusão, travando a rotina na
-- primeira linha (provado no banco local em 12/11/2026, antes de existir qualquer vídeo montado). Agora o pedido pronto
-- sem vídeo quer dizer "o vídeo saiu de Fotos". Idempotente; uma transação por arquivo (ADR-018).

alter table liame.video_montage drop constraint if exists video_montage_pronto_com_video;

-- ------------------------------------------------------------ a conferência

do $$ begin
  if exists (select 1 from pg_constraint c join pg_namespace n on n.oid = c.connamespace
              where n.nspname = 'liame' and c.conname = 'video_montage_pronto_com_video') then
    raise exception '0146: a regra do pronto com o vídeo continua';
  end if;
  if not exists (select 1 from pg_constraint c join pg_namespace n on n.oid = c.connamespace
                  where n.nspname = 'liame' and c.conname = 'video_montage_nao_deu_com_motivo') then
    raise exception '0146: a regra do "não deu" com o motivo sumiu';
  end if;
end $$;
