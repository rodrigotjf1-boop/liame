-- 0086 · O post no trilho, parte 1 (A6, Z5b; `plano-a6.md` §3 Z5, D-A6-3, D-A6-6 a D-A6-8, D-A6-21 e D-A6-23; as decisões
-- técnicas D-A6-32 a D-A6-37 estão em `decisoes-design.md`, 29/10/2026).
-- (1) `social_post`: o post da marca, um por pedido em Aprovações (a ferramenta `post_publicar`, recurso `post:<id>`):
--     a foto das Fotos (pelo resumo do arquivo, para o que sai ser o aprovado, A6-10), o recorte do Instagram (D-A6-21)
--     e a hora marcada (D-A6-8: quem segura a hora é o Liame; o pedido aprovado espera por ela no trilho).
-- (2) `social_post_channel`: um canal do post (o Instagram ou a Página do Facebook, cada um com a conta ligada à marca e
--     o texto dele) e o que aconteceu nele: a situação, o código da rede (o contêiner do Instagram antes de publicar e o
--     post publicado), o endereço e o erro. É o que garante que o post sai uma vez só em cada canal (A6-9).
-- Nenhum post sai nesta entrega: a publicação nas redes entra na parte seguinte, e a função `social_write` (0085) segue
-- desligada para todos. Nada de dado pessoal: o texto é o que a empresa escreve em nome dela.
-- RLS forçada desde a criação (V115). Idempotente; uma transação por arquivo (ADR-018).

select set_config('app.scope', 'sistema', true);

create table if not exists liame.social_post (
  id                   uuid primary key,
  tenant_id            uuid not null references liame.organization (id) on delete cascade,
  brand_id             uuid not null references liame.brand (id) on delete cascade,
  -- O pedido em Aprovações; nulo só entre criar o post e o pedido, na mesma transação.
  action_id            uuid references liame.action_request (id) on delete set null,
  -- A foto das Fotos; nula quando ela é apagada depois (o plano muda e o post não sai).
  photo_id             uuid references liame.brand_photo (id) on delete set null,
  -- O resumo do arquivo da foto na hora do pedido: o que sai é o aprovado (A6-10).
  photo_sha256         text not null check (photo_sha256 ~ '^[0-9a-f]{64}$'),
  -- A posição do recorte do Instagram, de 0 a 100 ao longo do lado comprido; nula = a foto cabe inteira.
  crop_pos             smallint check (crop_pos between 0 and 100),
  -- O arquivo do recorte que vai ao Instagram (parte seguinte), no armazenamento de imagens, ao lado da foto.
  instagram_object_key text check (instagram_object_key is null or length(instagram_object_key) between 1 and 300),
  publish_at           timestamptz not null,
  -- Sobe a cada mudança do post ou de um canal: é a versão que o trilho confere antes de escrever na rede.
  version              integer not null default 1 check (version >= 1),
  created_by           uuid references liame.app_user (id) on delete set null,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create unique index if not exists social_post_pedido on liame.social_post (action_id) where action_id is not null;
create index if not exists idx_social_post_agenda on liame.social_post (tenant_id, brand_id, publish_at);

create table if not exists liame.social_post_channel (
  id                   uuid primary key,
  tenant_id            uuid not null references liame.organization (id) on delete cascade,
  post_id              uuid not null references liame.social_post (id) on delete cascade,
  channel              text not null check (channel in ('instagram', 'facebook')),
  -- A conta ligada do canal (a Página ou o Instagram); nula quando ela some.
  connected_account_id uuid references liame.connected_account (id) on delete set null,
  body                 text not null check (length(body) between 1 and 10000),
  status               text not null default 'aguardando'
                       check (status in ('aguardando', 'publicando', 'publicado', 'falhou', 'cancelado', 'apagado')),
  -- O contêiner do Instagram, criado antes de publicar (a tentativa seguinte confere nele, em vez de criar outro).
  container_id         text check (container_id is null or length(container_id) between 1 and 60),
  -- O post publicado na rede e o endereço dele.
  external_id          text check (external_id is null or length(external_id) between 1 and 120),
  permalink            text check (permalink is null or length(permalink) between 1 and 500),
  -- O motivo da falha, em palavras do Liame (nunca o texto da rede, que é de quem programa).
  error                text check (error is null or length(error) between 1 and 500),
  attempted_at         timestamptz,
  published_at         timestamptz,
  removed_at           timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (post_id, channel)
);

create index if not exists idx_social_post_channel_tenant on liame.social_post_channel (tenant_id, post_id);

alter table liame.social_post enable row level security;
alter table liame.social_post force row level security;
drop policy if exists social_post_isolamento on liame.social_post;
create policy social_post_isolamento on liame.social_post
  using (tenant_id = liame.current_tenant_id() or liame.system_scope())
  with check (tenant_id = liame.current_tenant_id() or liame.system_scope());
drop policy if exists social_post_apaga_so_sistema on liame.social_post;
create policy social_post_apaga_so_sistema on liame.social_post as restrictive for delete using (liame.system_scope());
grant select, insert, update, delete on liame.social_post to liame_app;

alter table liame.social_post_channel enable row level security;
alter table liame.social_post_channel force row level security;
drop policy if exists social_post_channel_isolamento on liame.social_post_channel;
create policy social_post_channel_isolamento on liame.social_post_channel
  using (tenant_id = liame.current_tenant_id() or liame.system_scope())
  with check (tenant_id = liame.current_tenant_id() or liame.system_scope());
drop policy if exists social_post_channel_apaga_so_sistema on liame.social_post_channel;
create policy social_post_channel_apaga_so_sistema on liame.social_post_channel as restrictive for delete using (liame.system_scope());
grant select, insert, update, delete on liame.social_post_channel to liame_app;
