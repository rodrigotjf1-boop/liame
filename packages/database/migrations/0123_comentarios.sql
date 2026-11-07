-- 0123 · Comentários: a leitura (A6, Z11, parte 1; protótipo P38, D-A6-84 a D-A6-94; `plano-a6.md` Z11).
-- Os comentários dos posts publicados nos últimos 30 dias no Instagram e na Página do Facebook ligados a uma marca (as
-- contas `instagram` e `facebook_page`), lidos pela rotina `comentarios` do worker, só para a empresa com a função
-- `comentarios` ligada (nasce desligada: antes de ligar, o texto da Política, V172). O frescor fica em `sync_state`, com
-- o conjunto `comentarios`.
-- (1) Três capacidades novas no registro, na versão das outras da Meta (v26.0), conferidas nas páginas oficiais em
--     07/11/2026 (base de conhecimento §2.2): `instagram_comments` (GET /{ig-media-id}/comments), `pagina_posts`
--     (GET /{page-id}/posts) e `pagina_comments` (GET /{page-post-id}/comments, com o token da Página).
-- (2) A função `comentarios`, desligada.
-- (3) Os posts de onde vêm os comentários (`social_comment_post`) e os comentários (`social_comment`), com o texto, o @
--     ou o nome de quem comentou, a hora, as curtidas e se está oculto; sem a foto do perfil. O comentário sai 90 dias
--     depois de feito (o expurgo `comentario` do worker), antes se for apagado na rede ou se a conta for desligada.
-- Da distribuição (o registro e a função) e das empresas (os posts e os comentários). Idempotente; uma transação por
-- arquivo (ADR-018).

-- As sementes gravam em tabelas com RLS forçada (V20).
select set_config('app.scope', 'sistema', true);

-- ------------------------------------------------------------ (1) as capacidades

insert into liame.connector_capability (provider, capability, api_version, read, write, required_scope, access_level, sunset_at, source_url, verified_at, notes) values
  ('meta_ads', 'instagram_comments', 'v26.0', true, false, '{instagram_basic,instagram_manage_comments,pages_read_engagement}', 'Standard (testadores) ou Advanced', null,
   'https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-media/comments', '2026-11-07',
   'Graph API: os comentários de um post do Instagram (GET /{ig-media-id}/comments; até 50 por consulta, do mais novo para o mais velho; só os de primeiro nível, as respostas pelo campo replies; sem filtro por data; username exige instagram_manage_comments; quem a conta restringiu não aparece)'),
  ('meta_ads', 'pagina_posts', 'v26.0', true, false, '{pages_read_engagement,pages_read_user_content}', 'Standard (testadores) ou Advanced', null,
   'https://developers.facebook.com/docs/graph-api/reference/page/feed', '2026-11-07',
   'Graph API: os posts da Página (GET /{page-id}/posts; até 100 por consulta; volta também o agendado e o rascunho, filtrados por is_published; token da Página de quem pode CREATE_CONTENT, MANAGE ou MODERATE)'),
  ('meta_ads', 'pagina_comments', 'v26.0', true, false, '{pages_read_engagement,pages_read_user_content}', 'Standard (testadores) ou Advanced', null,
   'https://developers.facebook.com/docs/pages-api/comments-mentions', '2026-11-07',
   'Graph API: os comentários de um post da Página (GET /{page-post-id}/comments; filter=stream traz todos os níveis com o parent; token da Página de quem pode MODERATE, desde a v11.0; o from com o nome e o id da Página para quem comentou, a conferir no teste)')
on conflict (provider, capability) do nothing;

-- ------------------------------------------------------------ (2) a função

insert into liame.feature_flag (key, kind, default_value, description, owner, is_write)
values ('comentarios', 'boolean', 'false', 'Comentários: ler os comentários dos posts dos últimos 30 dias do Instagram e da Página ligados à marca, para a tela Comentários (A6, Z11). Só leitura; responder e ocultar vêm à parte', 'social', false)
on conflict (key) do nothing;

-- ------------------------------------------------------------ (3) os posts e os comentários

create table if not exists liame.social_comment_post (
  connected_account_id  uuid not null references liame.connected_account (id) on delete cascade,
  tenant_id             uuid not null references liame.organization (id) on delete cascade,
  brand_id              uuid not null references liame.brand (id) on delete cascade,
  -- O id do post na rede (a mídia do Instagram; na Página, `{página}_{post}`).
  post_id               text not null,
  -- `instagram` ou `facebook` (a Página).
  channel               text not null,
  -- No Instagram, `reels`, `foto`, `carrossel` ou `video`; na Página, nulo.
  kind                  text,
  -- A legenda (no Instagram, até 2.200 caracteres, o limite de lá; na Página, cortada nesse tamanho).
  caption               text not null default '',
  permalink             text,
  -- A miniatura no endereço da Meta.
  thumbnail_url         text,
  published_at          timestamptz not null,
  -- Quantos comentários a rede diz que o post tem.
  comment_count         integer,
  -- A última leitura dos comentários deste post (a fila: até 7 dias, a cada leitura; de 8 a 30, de hora em hora).
  comments_read_at      timestamptz,
  read_at               timestamptz not null default now(),
  primary key (connected_account_id, post_id),
  constraint social_comment_post_id check (length(post_id) between 1 and 80),
  constraint social_comment_post_canal check (channel in ('instagram', 'facebook')),
  constraint social_comment_post_tipo check (kind is null or kind in ('reels', 'foto', 'carrossel', 'video')),
  constraint social_comment_post_legenda check (length(caption) <= 2200),
  constraint social_comment_post_endereco check (permalink is null or length(permalink) between 1 and 500),
  constraint social_comment_post_miniatura check (thumbnail_url is null or length(thumbnail_url) between 1 and 2000),
  constraint social_comment_post_contagem check (comment_count is null or comment_count >= 0)
);
create index if not exists idx_social_comment_post_marca on liame.social_comment_post (tenant_id, brand_id, published_at desc);

create table if not exists liame.social_comment (
  connected_account_id  uuid not null,
  tenant_id             uuid not null references liame.organization (id) on delete cascade,
  brand_id              uuid not null references liame.brand (id) on delete cascade,
  -- O id do comentário na rede.
  comment_id            text not null,
  post_id               text not null,
  channel               text not null,
  -- A resposta aponta o comentário de primeiro nível; o de primeiro nível, nulo.
  parent_comment_id     text,
  -- O @ (Instagram) ou o nome (Página) de quem comentou; nulo quando a rede não manda.
  author_name           text,
  -- O resumo (SHA-256, em hexadecimal) do id de quem comentou na rede: só para não responder duas vezes à mesma pessoa
  -- no mesmo post. Não identifica a pessoa fora do Liame; nulo quando a rede não manda o id.
  author_key            text,
  -- Feito pela própria marca (a resposta da loja, pelo app da rede ou pelo Liame).
  by_brand              boolean not null default false,
  message               text not null default '',
  published_at          timestamptz not null,
  like_count            integer,
  reply_count           integer,
  hidden                boolean not null default false,
  -- O tipo: `pergunta`, `reclamacao`, `elogio`, `marcacao`, `ofensivo` ou `golpe`; nulo = ainda não decidido.
  kind                  text,
  -- Quem decidiu o tipo: a regra do servidor ou a IA.
  kind_source           text,
  read_at               timestamptz not null default now(),
  primary key (connected_account_id, comment_id),
  foreign key (connected_account_id, post_id) references liame.social_comment_post (connected_account_id, post_id) on delete cascade,
  constraint social_comment_id check (length(comment_id) between 1 and 120),
  constraint social_comment_pai check (parent_comment_id is null or length(parent_comment_id) between 1 and 120),
  constraint social_comment_canal check (channel in ('instagram', 'facebook')),
  constraint social_comment_autor check (author_name is null or length(author_name) between 1 and 200),
  constraint social_comment_chave check (author_key is null or length(author_key) = 64),
  constraint social_comment_texto check (length(message) <= 8000),
  constraint social_comment_numeros check (coalesce(like_count, 0) >= 0 and coalesce(reply_count, 0) >= 0),
  constraint social_comment_tipo check (kind is null or kind in ('pergunta', 'reclamacao', 'elogio', 'marcacao', 'ofensivo', 'golpe')),
  constraint social_comment_quem_decidiu check (num_nulls(kind, kind_source) in (0, 2) and (kind_source is null or kind_source in ('regra', 'ia')))
);
create index if not exists idx_social_comment_marca on liame.social_comment (tenant_id, brand_id, published_at desc);
create index if not exists idx_social_comment_post on liame.social_comment (connected_account_id, post_id);
-- O expurgo de 90 dias anda pela data do comentário.
create index if not exists idx_social_comment_prazo on liame.social_comment (published_at);

alter table liame.social_comment_post enable row level security;
alter table liame.social_comment_post force row level security;
drop policy if exists social_comment_post_isolamento on liame.social_comment_post;
create policy social_comment_post_isolamento on liame.social_comment_post
  using (tenant_id = liame.current_tenant_id() or liame.system_scope())
  with check (tenant_id = liame.current_tenant_id() or liame.system_scope());

alter table liame.social_comment enable row level security;
alter table liame.social_comment force row level security;
drop policy if exists social_comment_isolamento on liame.social_comment;
create policy social_comment_isolamento on liame.social_comment
  using (tenant_id = liame.current_tenant_id() or liame.system_scope())
  with check (tenant_id = liame.current_tenant_id() or liame.system_scope());

-- A leitura espelha os posts e os comentários (o que saiu da rede sai daqui): o `delete`.
grant select, insert, update, delete on liame.social_comment_post to liame_app;
grant select, insert, update, delete on liame.social_comment to liame_app;

-- ------------------------------------------------------------ conferência

do $$ begin
  if (select count(*) from liame.connector_capability
       where provider = 'meta_ads' and capability in ('instagram_comments', 'pagina_posts', 'pagina_comments')) <> 3 then
    raise exception '0123: as capacidades dos comentários não entraram';
  end if;
  if not exists (select 1 from liame.feature_flag where key = 'comentarios' and default_value = 'false'::jsonb and not is_write) then
    raise exception '0123: a função comentarios não entrou desligada';
  end if;
  if (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'liame' and c.relname in ('social_comment_post', 'social_comment') and c.relrowsecurity and c.relforcerowsecurity) <> 2 then
    raise exception '0123: as tabelas dos comentários não entraram com a RLS forçada';
  end if;
  if (select count(*) from pg_constraint
       where conrelid = 'liame.social_comment'::regclass
         and conname in ('social_comment_id', 'social_comment_pai', 'social_comment_canal', 'social_comment_autor', 'social_comment_chave',
                         'social_comment_texto', 'social_comment_numeros', 'social_comment_tipo', 'social_comment_quem_decidiu')) <> 9 then
    raise exception '0123: as regras do comentário não entraram';
  end if;
end $$;
