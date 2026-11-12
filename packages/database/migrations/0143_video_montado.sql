-- 0143 · O vídeo montado pelo Liame: os pedidos e a fila (A6 · Z15, parte 2a; P43 aprovado em 11/11/2026; D-A6-133 a
-- D-A6-138). A pessoa escolhe o modelo, as fotos ou o vídeo de Fotos, o formato, os textos (conferidos pelo Compliance), a
-- logo, a duração e o som; o pedido entra na fila (esta tabela) e o serviço de montagem (`liame-render`, parte 2b) pega
-- um por vez, o mais antigo primeiro, monta o vídeo e o põe em Fotos. Até 10 por marca por dia; o que não deu não conta.
-- A função `video_montado` nasce desligada. Das empresas. Idempotente; uma transação por arquivo (ADR-018).

-- As sementes gravam em tabelas com RLS forçada (V20).
select set_config('app.scope', 'sistema', true);

-- ------------------------------------------------------------ (1) a função

insert into liame.feature_flag (key, kind, default_value, description, owner, is_write)
values ('video_montado', 'boolean', 'false', 'O vídeo montado pelo Liame: modelos sobre as fotos e os vídeos de Fotos, numa fila na VPS (A6, Z15)', 'social', false)
on conflict (key) do nothing;

-- ------------------------------------------------------------ (2) os pedidos (e a fila)

create table if not exists liame.video_montage (
  id             uuid primary key,
  tenant_id      uuid not null references liame.organization (id) on delete cascade,
  brand_id       uuid not null references liame.brand (id) on delete cascade,
  template       text not null check (template in ('destaque', 'combo', 'novidade')),
  format         text not null check (format in ('9x16', '4x5', '1x1')),
  duration_s     integer not null check (duration_s in (6, 10, 15)),
  -- As fotos ou o vídeo de Fotos, na ordem em que entram no vídeo (de 1 a 4).
  media_ids      uuid[] not null check (cardinality(media_ids) between 1 and 4),
  title          text not null check (char_length(title) between 1 and 40),
  price_line     text check (char_length(price_line) between 1 and 24),
  cta            text not null check (char_length(cta) between 1 and 30),
  with_logo      boolean not null default false,
  sound          text not null default 'sem' check (sound in ('sem', 'original')),
  -- na_fila (espera a vez), montando (o serviço pegou), pronto (o vídeo está em Fotos), nao_deu (o porquê em `error`).
  status         text not null default 'na_fila' check (status in ('na_fila', 'montando', 'pronto', 'nao_deu')),
  progress       integer not null default 0 check (progress between 0 and 100),
  error          text check (char_length(error) <= 500),
  -- O vídeo pronto em Fotos (a linha de `brand_photo`).
  photo_id       uuid references liame.brand_photo (id) on delete set null,
  requested_by   uuid references liame.app_user (id) on delete set null,
  created_at     timestamptz not null default clock_timestamp(),
  started_at     timestamptz,
  finished_at    timestamptz,
  updated_at     timestamptz not null default now(),
  constraint video_montage_pronto_com_video check (status <> 'pronto' or photo_id is not null),
  constraint video_montage_nao_deu_com_motivo check (status <> 'nao_deu' or error is not null)
);

-- O vídeo pronto em Fotos sabe de qual pedido veio: a etiqueta "Montado pelo Liame", e o montado não entra de novo
-- numa montagem (D-A6-136).
alter table liame.brand_photo add column if not exists montage_id uuid;

-- A fila: o mais antigo que espera primeiro (o serviço pega com `for update skip locked`); a posição sai da contagem.
create index if not exists video_montage_fila on liame.video_montage (created_at, id) where status in ('na_fila', 'montando');
-- O limite do dia e a lista da marca.
create index if not exists video_montage_marca on liame.video_montage (brand_id, created_at desc);

alter table liame.video_montage enable row level security;
alter table liame.video_montage force row level security;
drop policy if exists video_montage_isolamento on liame.video_montage;
create policy video_montage_isolamento on liame.video_montage
  using (tenant_id = liame.current_tenant_id() or liame.system_scope())
  with check (tenant_id = liame.current_tenant_id() or liame.system_scope());
grant select, insert, update on liame.video_montage to liame_app;

-- ------------------------------------------------------------ conferência

do $$ begin
  if not exists (select 1 from liame.feature_flag where key = 'video_montado' and default_value = 'false'::jsonb and not is_write) then
    raise exception '0143: a função video_montado não entrou desligada';
  end if;
  if not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                  where n.nspname = 'liame' and c.relname = 'video_montage' and c.relrowsecurity and c.relforcerowsecurity) then
    raise exception '0143: a tabela video_montage não entrou com a RLS forçada';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'liame' and table_name = 'brand_photo' and column_name = 'montage_id') then
    raise exception '0143: a coluna montage_id das Fotos não entrou';
  end if;
  if (select count(*) from pg_indexes where schemaname = 'liame' and indexname in ('video_montage_fila', 'video_montage_marca')) <> 2 then
    raise exception '0143: os índices da fila não entraram';
  end if;
end $$;
