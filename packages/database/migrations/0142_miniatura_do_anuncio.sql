-- 0142 · A miniatura do anúncio guardada pelo Liame (A3 · I14, parte 1; P44 aprovado em 11/11/2026; D-A3-29 e D-A3-30).
-- Em Resultados, "Por campanha" mostra a imagem do anúncio que mais gastou no período. O endereço da miniatura que a
-- Meta entrega expira: o Liame guarda uma cópia pequena no armazenamento de imagens (no prefixo da marca) e anota no
-- criativo qual imagem copiou (o endereço sem a assinatura, para copiar de novo só quando a imagem muda).
-- Das empresas. Idempotente; uma transação por arquivo (ADR-018).

alter table liame.creative add column if not exists thumbnail_key text;
alter table liame.creative add column if not exists thumbnail_source text;
alter table liame.creative add column if not exists thumbnail_width integer;
alter table liame.creative add column if not exists thumbnail_height integer;
alter table liame.creative add column if not exists thumbnail_copied_at timestamptz;

do $$ begin
  -- A cópia vem inteira (a chave, a origem, as medidas e quando) ou não vem.
  if not exists (select 1 from pg_constraint where conrelid = 'liame.creative'::regclass and conname = 'creative_miniatura_inteira') then
    alter table liame.creative add constraint creative_miniatura_inteira check (
      (thumbnail_key is null and thumbnail_source is null and thumbnail_width is null and thumbnail_height is null and thumbnail_copied_at is null)
      or (thumbnail_key is not null and thumbnail_source is not null and thumbnail_width between 1 and 480
          and thumbnail_height between 1 and 480 and thumbnail_copied_at is not null)
    );
  end if;
end $$;

-- ------------------------------------------------------------ conferência

do $$ begin
  if (select count(*) from information_schema.columns
       where table_schema = 'liame' and table_name = 'creative'
         and column_name in ('thumbnail_key', 'thumbnail_source', 'thumbnail_width', 'thumbnail_height', 'thumbnail_copied_at')) <> 5 then
    raise exception '0142: as colunas da miniatura não entraram';
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'liame.creative'::regclass and conname = 'creative_miniatura_inteira') then
    raise exception '0142: a regra da miniatura inteira não entrou';
  end if;
end $$;
