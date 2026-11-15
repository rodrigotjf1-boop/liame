-- 0163 · Os melhores momentos: o pedido dos cortes ao Social media (A6, Z16, parte 3; o item 7 do dono de 07/11/2026;
-- D-A6-82 e D-A6-150 a D-A6-154, do protótipo P46, seguidas como recomendadas). A pessoa escolhe de 1 a 4 vídeos de Fotos e
-- pede os cortes: o serviço de montagem (liame-render) tira os quadros e os guarda no armazém por pouco tempo; o worker manda
-- os quadros ao Social media (a tarefa `social_cortes`), confere a proposta e apaga os quadros.
-- (1) A função `video_momentos`, desligada (D-A6-154): sem ela, o pedido é recusado.
-- (2) `video_cut_request`: o pedido (os vídeos, a duração, em que pé está e a proposta conferida).
-- Da distribuição (a função) e das empresas (o pedido). Idempotente; uma transação por arquivo (ADR-018).

-- A semente grava em tabela com RLS forçada (V20).
select set_config('app.scope', 'sistema', true);

-- ------------------------------------------------------------ (1) a função

insert into liame.feature_flag (key, kind, default_value, description, owner, is_write)
values ('video_momentos', 'boolean', 'false', 'Os melhores momentos: o vídeo com os cortes escolhidos pelo Social media sobre os vídeos de Fotos (A6, Z16)', 'social', false)
on conflict (key) do nothing;

-- ------------------------------------------------------------ (2) o pedido dos cortes

create table if not exists liame.video_cut_request (
  id             uuid primary key,
  tenant_id      uuid not null references liame.organization (id) on delete cascade,
  brand_id       uuid not null references liame.brand (id) on delete cascade,
  -- Os vídeos de Fotos escolhidos, na ordem (de 1 a 4).
  media_ids      uuid[] not null,
  -- A duração do vídeo (10, 15 ou 20 segundos).
  duration_s     smallint not null,
  -- `pedido` (espera o serviço de montagem tirar os quadros), `quadros_prontos` (os quadros no armazém, esperando o Social
  -- media), `lendo` (o worker com o Social media), `pronta` (a proposta conferida) ou `falhou` (o motivo em `error`).
  status         text not null default 'pedido',
  -- Quantos quadros saíram (até 16, o teto de imagens por pedido do gateway de IA).
  frames         smallint,
  -- Quando a vez começou (o serviço de montagem ou o worker), para soltar o pedido parado, e quantas vezes ele foi pego.
  started_at     timestamptz,
  attempts       smallint not null default 0,
  -- A proposta conferida (os cortes em milissegundos, com o vídeo e a legenda de cada um, e o total); nula até ficar pronta.
  proposal       jsonb,
  error          text,
  -- O pedido de antes, quando este é o "Pedir outros cortes" (até 2 por vídeo montado, D-A6-151).
  previous_id    uuid references liame.video_cut_request (id) on delete set null,
  created_by     uuid references liame.app_user (id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint video_cut_request_situacao check (status in ('pedido', 'quadros_prontos', 'lendo', 'pronta', 'falhou')),
  constraint video_cut_request_videos check (cardinality(media_ids) between 1 and 4),
  constraint video_cut_request_duracao check (duration_s in (10, 15, 20)),
  constraint video_cut_request_quadros check (frames is null or frames between 1 and 16),
  constraint video_cut_request_tentativas check (attempts between 0 and 10),
  constraint video_cut_request_proposta check (proposal is null or jsonb_typeof(proposal) = 'object'),
  constraint video_cut_request_pronta check ((status = 'pronta') = (proposal is not null)),
  constraint video_cut_request_erro check (coalesce(length(error), 0) <= 500)
);
create index if not exists idx_video_cut_request_tenant on liame.video_cut_request (tenant_id);
create index if not exists idx_video_cut_request_marca on liame.video_cut_request (brand_id, created_at desc);
-- A fila do serviço de montagem e do worker: só os que esperam alguém.
create index if not exists idx_video_cut_request_fila on liame.video_cut_request (status, created_at) where status in ('pedido', 'quadros_prontos', 'lendo');

alter table liame.video_cut_request enable row level security;
alter table liame.video_cut_request force row level security;
drop policy if exists video_cut_request_isolamento on liame.video_cut_request;
create policy video_cut_request_isolamento on liame.video_cut_request
  using (tenant_id = liame.current_tenant_id() or liame.system_scope())
  with check (tenant_id = liame.current_tenant_id() or liame.system_scope());
grant select, insert, update on liame.video_cut_request to liame_app;
