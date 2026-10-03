-- 0033 · Conhecimento: o dossiê da marca e a base da agência (A3, I8; `ai-architecture.md` §5; data-model §7).
-- O dossiê é dado da EMPRESA: o que a marca é, como fala, o que vende, o que pode provar e o que nunca diz.
-- Cada vez que alguém salva, nasce uma versão nova; nenhuma versão muda nem é apagada pela aplicação, e voltar
-- a uma anterior é salvar outra (protótipo P6, aguardando aprovação). As sugestões (do sistema, pelas vendas
-- e cupons; da LIA ou do Pesquisador, quando houver IA) ficam à parte, esperando uma pessoa conferir.
-- A base da agência é dado do PRODUTO (da distribuição Liame): regras de marketing adaptadas ao Brasil, com a
-- licença de cada texto; como `prompt_version` (0029), o worker grava a partir do código e a empresa não edita.
-- Nenhuma tabela aqui guarda dado de cliente da loja: o dossiê recusa telefone, e-mail e documento ao salvar.
-- Idempotente; uma transação por arquivo (ADR-018).

-- As permissões gravam em tabela com RLS forçada (V20).
select set_config('app.scope', 'sistema', true);

-- ------------------------------------------------------------ versões do dossiê

create table if not exists liame.brand_dossier_version (
  id               uuid primary key,
  tenant_id        uuid not null references liame.organization (id) on delete cascade,
  brand_id         uuid not null references liame.brand (id) on delete cascade,
  version          integer not null check (version >= 1),
  -- O dossiê inteiro (contrato `BrandDossierContent`), na versão do contrato em que foi salvo.
  content          jsonb not null check (jsonb_typeof(content) = 'object'),
  content_version  integer not null check (content_version >= 1),
  -- sha256 do texto que vai ao modelo, montado em ordem fixa: muda só quando o que a IA lê muda.
  text_hash        text not null check (text_hash ~ '^[0-9a-f]{64}$'),
  -- O que mudou sobre a versão anterior, em frases curtas ("O que não pode dizer: + gourmet").
  changes          jsonb not null default '[]' check (jsonb_typeof(changes) = 'array'),
  -- Como a versão nasceu: salva por uma pessoa, a partir de uma sugestão conferida, voltando a uma anterior ou
  -- mesclada depois de duas pessoas salvarem ao mesmo tempo.
  source           text not null check (source in ('pessoa', 'sugestao', 'restaurada', 'mesclada')),
  restored_from    integer check (restored_from >= 1),
  created_by       uuid references liame.app_user (id) on delete set null,
  created_at       timestamptz not null default now(),
  check ((source = 'restaurada') = (restored_from is not null)),
  -- Duas pessoas salvando a partir da mesma versão: a segunda bate aqui e recebe a versão nova para mesclar.
  unique (brand_id, version)
);
create index if not exists idx_brand_dossier_version_tenant on liame.brand_dossier_version (tenant_id);

-- ------------------------------------------------------------ sugestões a conferir

create table if not exists liame.brand_dossier_suggestion (
  id                uuid primary key,
  tenant_id         uuid not null references liame.organization (id) on delete cascade,
  brand_id          uuid not null references liame.brand (id) on delete cascade,
  section           text not null check (section in ('identidade', 'voz', 'produtos', 'ofertas', 'provas', 'proibido', 'concorrentes', 'regiao', 'datas')),
  -- Quem sugeriu: o sistema (pelas vendas e cupons, sem IA), a LIA ou o Pesquisador.
  source            text not null check (source in ('sistema', 'lia', 'pesquisador')),
  -- Os itens (contrato `BrandDossierSuggestionItem`): incluir, tirar ou trocar, cada um com o porquê.
  items             jsonb not null check (case when jsonb_typeof(items) = 'array' then jsonb_array_length(items) between 1 and 20 else false end),
  -- A versão do dossiê que a sugestão olhou (0 = dossiê ainda vazio).
  based_on_version  integer not null check (based_on_version >= 0),
  -- `substituida`: o sistema olhou de novo e a sugestão pendente mudou (a antiga sai da lista).
  status            text not null check (status in ('pendente', 'usada', 'descartada', 'substituida')),
  -- Os itens usados (posições em `items`) e a versão que eles geraram.
  used              jsonb check (jsonb_typeof(used) = 'array'),
  result_version    integer check (result_version >= 1),
  decided_by        uuid references liame.app_user (id) on delete set null,
  decided_at        timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  check ((status in ('usada', 'descartada')) = (decided_at is not null)),
  check ((status = 'usada') = (used is not null and result_version is not null))
);
create index if not exists idx_brand_dossier_suggestion_tenant on liame.brand_dossier_suggestion (tenant_id);
-- Uma sugestão pendente por marca, parte e autor: a nova substitui a velha.
create unique index if not exists uq_brand_dossier_suggestion_pendente
  on liame.brand_dossier_suggestion (brand_id, section, source) where status = 'pendente';

-- ------------------------------------------------------------ RLS e grants (empresa)

-- O dossiê: a empresa lê o dela e grava só no dela; ninguém altera nem apaga uma versão (sem UPDATE e
-- DELETE para a aplicação). As sugestões: a empresa lê e decide as dela.
do $$
declare t text;
begin
  foreach t in array array['brand_dossier_version', 'brand_dossier_suggestion']
  loop
    execute format('alter table liame.%I enable row level security', t);
    execute format('alter table liame.%I force row level security', t);
    execute format('drop policy if exists %I on liame.%I', t || '_isolamento', t);
    execute format(
      'create policy %I on liame.%I using (tenant_id = liame.current_tenant_id() or liame.system_scope()) with check (tenant_id = liame.current_tenant_id() or liame.system_scope())',
      t || '_isolamento', t);
  end loop;
end $$;
grant select, insert on liame.brand_dossier_version to liame_app;
grant select, insert, update on liame.brand_dossier_suggestion to liame_app;

-- ------------------------------------------------------------ base da agência (do produto)

create table if not exists liame.knowledge_item (
  id            uuid primary key,
  key           text not null check (key ~ '^[a-z][a-z0-9_.]{1,80}$'),
  version       integer not null check (version >= 1),
  status        text not null check (status in ('ativa', 'aposentada')),
  title         text not null check (length(title) between 1 and 200),
  content       text not null check (length(content) between 1 and 50000),
  content_hash  text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  -- A licença do texto de origem (identificador SPDX ou `proprio`) e o aviso que vai junto, como o NOTICE.
  license       text not null check (license ~ '^[A-Za-z0-9.+-]{2,40}$'),
  notice        text check (length(notice) between 1 and 4000),
  source_url    text check (source_url ~ '^https://'),
  deployed_at   timestamptz not null default now(),
  retired_at    timestamptz,
  unique (key, version),
  check ((status = 'aposentada') = (retired_at is not null))
);
create unique index if not exists uq_knowledge_item_ativa on liame.knowledge_item (key) where status = 'ativa';

-- Do produto, como os registros da 0029: a aplicação lê; só a rotina do sistema grava. Nenhuma rota entrega
-- este texto à empresa (é da distribuição); ele vai, quando houver, no contexto do modelo.
alter table liame.knowledge_item enable row level security;
alter table liame.knowledge_item force row level security;
drop policy if exists knowledge_item_leitura on liame.knowledge_item;
create policy knowledge_item_leitura on liame.knowledge_item for select using (true);
drop policy if exists knowledge_item_sistema on liame.knowledge_item;
create policy knowledge_item_sistema on liame.knowledge_item using (liame.system_scope()) with check (liame.system_scope());
grant select, insert, update on liame.knowledge_item to liame_app;

-- ------------------------------------------------------------ permissões

-- Ver o dossiê: quem acompanha as campanhas. Editar (salvar, voltar a uma versão, usar uma sugestão): o dono e
-- o administrador (protótipo P6). Quem só recebe relatórios não vê.
insert into liame.role_permission (tenant_id, role_key, permission)
values (null, 'dono', 'dossie.ver'), (null, 'dono', 'dossie.editar'),
       (null, 'administrador', 'dossie.ver'), (null, 'administrador', 'dossie.editar'),
       (null, 'gestor', 'dossie.ver'), (null, 'aprovador', 'dossie.ver'), (null, 'somente_leitura', 'dossie.ver')
on conflict do nothing;
