-- A6 · Z4: as fotos dos produtos que a empresa envia (ADR-021; protótipo P20, aprovado em 21/10/2026; D-A6-19).
-- A foto fica no armazenamento de imagens (S3 em São Paulo, privado). Aqui fica o registro:
-- - a empresa, a marca e a chave do objeto;
-- - o hash do arquivo enviado, para a mesma foto não entrar duas vezes;
-- - as medidas da cópia guardada (JPEG com o lado maior em até 2.048 px, sem os dados do celular);
-- - o produto de Minha marca e o que aparece nela.
-- O nome do arquivo não é guardado.
-- A linha nasce `enviando`, antes de o arquivo ir ao armazenamento: assim todo arquivo guardado tem linha, e o envio
-- que não terminou é limpo pela rotina `fotos` do worker. Apagar marca a linha (`removed_at`): a foto some da lista
-- na hora, e a rotina tira o arquivo do armazenamento e só depois a linha (ADR-021, item 6).
-- A função `fotos` nasce desligada para todos. As permissões: `fotos.ver` (quem tem acesso à empresa vê) e
-- `fotos.enviar` (o Dono, o Administrador e o Gestor enviam, mudam o produto e apagam; D-A6-19).
-- Idempotente; uma transação por arquivo (ADR-018).

-- As sementes gravam em tabelas com RLS forçada (V20).
select set_config('app.scope', 'sistema', true);

create table if not exists liame.brand_photo (
  id           uuid primary key,
  tenant_id    uuid not null references liame.organization (id) on delete cascade,
  brand_id     uuid not null references liame.brand (id) on delete cascade,
  -- O que é: por ora, só a foto de produto enviada pela empresa (a imagem do Criativo, X7, entra depois).
  kind         text not null default 'foto_produto' check (kind in ('foto_produto')),
  origin       text not null default 'envio' check (origin in ('envio')),
  -- `enviando`: a linha existe e o arquivo ainda vai ao armazenamento (ou não chegou); `pronta`: a foto está guardada.
  status       text not null default 'enviando' check (status in ('enviando', 'pronta')),
  -- A chave do objeto no armazenamento: `t/{empresa}/b/{marca}/foto_produto/{id}.jpg` (a miniatura troca `.jpg` por `-mini.jpg`).
  object_key   text not null check (length(object_key) between 1 and 300),
  -- O sha256 do arquivo que a pessoa enviou: a mesma foto não entra duas vezes na marca.
  sha256       text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  -- A cópia guardada (JPEG): o tamanho e as medidas.
  bytes        integer not null check (bytes between 1 and 10485760),
  width        integer not null check (width between 1 and 2048),
  height       integer not null check (height between 1 and 2048),
  -- O produto de Minha marca que aparece na foto, como estava escrito lá; nulo = sem produto.
  product      text check (product is null or length(product) between 1 and 160),
  description  text not null default '' check (length(description) <= 120),
  uploaded_by  uuid references liame.app_user (id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  -- Quem apagou e quando: a foto some da lista na hora; a rotina tira o arquivo e depois a linha.
  removed_at   timestamptz,
  removed_by   uuid references liame.app_user (id) on delete set null
);

create unique index if not exists brand_photo_chave on liame.brand_photo (object_key);
-- A mesma foto não entra duas vezes na marca (a que foi apagada não conta).
create unique index if not exists brand_photo_repetida on liame.brand_photo (brand_id, sha256) where removed_at is null;
create index if not exists idx_brand_photo_lista on liame.brand_photo (tenant_id, brand_id, created_at desc) where removed_at is null;
-- A rotina de limpeza: as fotos apagadas e os envios que não terminaram, pela data da última mudança (a que falhou no
-- armazenamento volta para o fim da fila e não segura as outras, V106).
create index if not exists idx_brand_photo_limpeza on liame.brand_photo (updated_at) where removed_at is not null or status = 'enviando';

alter table liame.brand_photo enable row level security;
alter table liame.brand_photo force row level security;
drop policy if exists brand_photo_isolamento on liame.brand_photo;
create policy brand_photo_isolamento on liame.brand_photo
  using (tenant_id = liame.current_tenant_id() or liame.system_scope())
  with check (tenant_id = liame.current_tenant_id() or liame.system_scope());
-- Só a rotina (escopo de sistema) apaga a linha, depois de tirar o arquivo do armazenamento.
drop policy if exists brand_photo_apaga_so_sistema on liame.brand_photo;
create policy brand_photo_apaga_so_sistema on liame.brand_photo as restrictive for delete using (liame.system_scope());
grant select, insert, update, delete on liame.brand_photo to liame_app;

-- ------------------------------------------------------------ a função, desligada para todos

insert into liame.feature_flag (key, kind, default_value, description, owner, is_write)
values ('fotos', 'boolean', 'false',
        'Fotos dos produtos (A6, Z4): a empresa envia, vê e apaga as fotos de verdade dos produtos, guardadas no armazenamento de imagens (S3 em São Paulo, privado). Não publica em nenhuma rede.',
        'social', false)
on conflict (key) do nothing;

-- ------------------------------------------------------------ as permissões (D-A6-19)

insert into liame.role_permission (tenant_id, role_key, permission)
values (null, 'dono', 'fotos.ver'), (null, 'dono', 'fotos.enviar'),
       (null, 'administrador', 'fotos.ver'), (null, 'administrador', 'fotos.enviar'),
       (null, 'gestor', 'fotos.ver'), (null, 'gestor', 'fotos.enviar'),
       (null, 'aprovador', 'fotos.ver'), (null, 'somente_leitura', 'fotos.ver')
on conflict do nothing;
