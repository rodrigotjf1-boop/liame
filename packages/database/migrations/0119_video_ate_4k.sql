-- 0119 · O vídeo das Fotos acima de 1080p (A6, Z10, parte 1; D-A6-68 do protótipo P37, aprovado pelo dono em
-- 04/11/2026). O vídeo 4K do celular ENTRA em Fotos: a redução para os 1.920 px do Reels fica para quando o vídeo for
-- mandado à Meta (parte 3), como o P37 propõe. A 0118 deixou as medidas do vídeo presas às da foto (até 2.048 px, as da
-- cópia regravada); aqui o vídeo vai até 4.096 px no lado maior (o 4K), e a foto segue até 2.048. Sem dado novo; as
-- linhas que já existem (fotos) seguem dentro. Idempotente; uma transação por arquivo (ADR-018).

alter table liame.brand_photo drop constraint if exists brand_photo_width_check;
alter table liame.brand_photo add constraint brand_photo_width_check
  check (width >= 1 and width <= case when kind = 'video' then 4096 else 2048 end);

alter table liame.brand_photo drop constraint if exists brand_photo_height_check;
alter table liame.brand_photo add constraint brand_photo_height_check
  check (height >= 1 and height <= case when kind = 'video' then 4096 else 2048 end);

-- ------------------------------------------------------------ conferência

do $$ begin
  if (select count(*) from pg_constraint
       where conrelid = 'liame.brand_photo'::regclass
         and conname in ('brand_photo_width_check', 'brand_photo_height_check')
         and pg_get_constraintdef(oid) like '%4096%' and pg_get_constraintdef(oid) like '%2048%') <> 2 then
    raise exception '0119: as medidas do vídeo não entraram';
  end if;
end $$;
