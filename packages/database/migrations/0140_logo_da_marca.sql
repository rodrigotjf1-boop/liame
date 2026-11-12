-- 0140 · A logo do restaurante em Minha marca (A6 · Z15, parte 1; P43 aprovado em 11/11/2026; D-A6-138). A marca guarda a
-- logo enviada pela empresa, regravada pelo servidor em JPEG sobre fundo branco (como a logo da agência, D-A7-69): o
-- vídeo montado pelo Liame põe a logo quando a pessoa liga a opção. O arquivo fica no armazenamento de imagens, no
-- prefixo da marca (sai junto quando a marca ou a empresa é apagada); aqui, só qual é e as medidas.
-- Das empresas. Idempotente; uma transação por arquivo (ADR-018).

alter table liame.brand add column if not exists logo_id uuid;
alter table liame.brand add column if not exists logo_width integer;
alter table liame.brand add column if not exists logo_height integer;
alter table liame.brand add column if not exists logo_updated_at timestamptz;
alter table liame.brand add column if not exists logo_updated_by uuid;

do $$ begin
  -- A logo vem inteira: o id, as duas medidas e quando, ou nada.
  if not exists (select 1 from pg_constraint where conrelid = 'liame.brand'::regclass and conname = 'brand_logo_inteira') then
    alter table liame.brand add constraint brand_logo_inteira check (
      (logo_id is null and logo_width is null and logo_height is null and logo_updated_at is null)
      or (logo_id is not null and logo_width between 1 and 512 and logo_height between 1 and 512 and logo_updated_at is not null)
    );
  end if;
end $$;

-- ------------------------------------------------------------ conferência

do $$ begin
  if (select count(*) from information_schema.columns
       where table_schema = 'liame' and table_name = 'brand'
         and column_name in ('logo_id', 'logo_width', 'logo_height', 'logo_updated_at', 'logo_updated_by')) <> 5 then
    raise exception '0140: as colunas da logo não entraram';
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'liame.brand'::regclass and conname = 'brand_logo_inteira') then
    raise exception '0140: a regra da logo inteira não entrou';
  end if;
end $$;
