-- 0050 · Peças do Criativo (A4, X6 parte b; `plano-a4.md` D-A4-28 a D-A4-34, propostas; protótipo P10, aguardando
-- aprovação). Quem opera campanhas pede peças para uma oferta de Minha marca; o Criativo (um funcionário de IA, sem
-- ferramenta nenhuma) escreve o título, o texto principal e o botão; o código confere cada peça, item por item, e a
-- pessoa decide: aprova (a peça vai para a biblioteca), edita (nasce uma versão nova, conferida de novo), pede outra ou
-- recusa. Nada vai para a Meta por aqui: a campanha nova (X5) é outro pedido, com aprovação e o código do app.
-- O nome é `ad_piece` porque `liame.creative` já existe e é outra coisa: o criativo lido da plataforma de anúncios.
-- Com a flag `criativo` desligada (como nasce), nada disto é usado. Idempotente; uma transação por arquivo (ADR-018).

-- A semente da flag grava em tabela com RLS forçada (V20).
select set_config('app.scope', 'sistema', true);

-- ------------------------------------------------------------ o pedido de peças (a fila do Criativo)

create table if not exists liame.ad_piece_request (
  id               uuid primary key,
  tenant_id        uuid not null references liame.organization (id) on delete cascade,
  brand_id         uuid not null references liame.brand (id) on delete cascade,
  -- O que se pede: `texto` (título, texto principal e botão). A imagem entra com a X7.
  kind             text not null default 'texto' check (kind in ('texto')),
  -- A oferta como estava escrita em Minha marca na hora do pedido, e a versão do dossiê de onde ela veio.
  offer            text not null check (length(offer) between 1 and 160),
  dossier_version  integer not null check (dossier_version >= 1),
  -- Para onde o anúncio leva: o cardápio online da loja ou uma conversa no WhatsApp.
  destination      text not null check (destination in ('cardapio', 'whatsapp')),
  variations       integer not null check (variations between 1 and 4),
  -- O que a peça precisa dizer ou evitar, nas palavras de quem pediu (sem dado pessoal).
  instruction      text check (length(instruction) between 1 and 300),
  -- O anúncio de referência (um anúncio da própria marca que já trouxe pedidos) e o nome dele na hora do pedido.
  reference_ad_id  uuid references liame.ad (id) on delete set null,
  reference_name   text check (length(reference_name) between 1 and 300),
  -- "Pedir outra": a peça que este pedido refaz (a versão nova entra nela). Nulo no pedido de peças novas.
  piece_id         uuid,
  -- `pendente` (na fila), `gerando` (reservado pelo worker), `concluido` (as peças saíram, conferidas), `recusado` (o
  -- Criativo não escreve sobre aquilo, ou nenhuma peça serviu) ou `falhou` (não deu para chamar a IA, ou ela falhou).
  status           text not null default 'pendente' check (status in ('pendente', 'gerando', 'concluido', 'recusado', 'falhou')),
  -- O porquê, quando recusado ou falhou (`politica`, `bebida_alcoolica`, `categoria_proibida`, `sem_peca`, `formato`,
  -- `ia_fora_do_ar`, `ia_desligada`, `teto`…); o código, não o texto do erro.
  reason           text check (reason ~ '^[a-z_]{2,40}$'),
  attempts         integer not null default 0 check (attempts >= 0),
  next_attempt_at  timestamptz,
  -- Quantas peças saíram deste pedido e quantas o código não deixou aparecer, por motivo (sem o texto delas).
  pieces           integer not null default 0 check (pieces >= 0),
  discards         jsonb check (discards is null or jsonb_typeof(discards) = 'object'),
  usage_id         uuid references liame.ai_usage (id),
  requested_by     uuid references liame.app_user (id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  finished_at      timestamptz
);
create index if not exists idx_ad_piece_request_tenant on liame.ad_piece_request (tenant_id);
create index if not exists idx_ad_piece_request_brand on liame.ad_piece_request (brand_id, created_at desc);
create index if not exists idx_ad_piece_request_fila on liame.ad_piece_request (next_attempt_at) where status in ('pendente', 'gerando');
-- Um lote de peças novas por marca de cada vez, e um "pedir outra" por peça de cada vez (V24).
create unique index if not exists uq_ad_piece_request_lote on liame.ad_piece_request (brand_id) where status in ('pendente', 'gerando') and piece_id is null;
create unique index if not exists uq_ad_piece_request_outra on liame.ad_piece_request (piece_id) where status in ('pendente', 'gerando') and piece_id is not null;

-- ------------------------------------------------------------ a peça, as versões e as decisões

create table if not exists liame.ad_piece (
  id             uuid primary key,
  tenant_id      uuid not null references liame.organization (id) on delete cascade,
  brand_id       uuid not null references liame.brand (id) on delete cascade,
  -- O pedido de onde a peça nasceu.
  request_id     uuid not null references liame.ad_piece_request (id) on delete cascade,
  -- `decidir` (espera a pessoa), `aprovada` (na biblioteca) ou `recusada`.
  status         text not null default 'decidir' check (status in ('decidir', 'aprovada', 'recusada')),
  -- A versão atual (a última de `ad_piece_version`) e o resultado da conferência dela, para a lista não abrir a versão.
  version        integer not null check (version >= 1),
  review_status  text not null check (review_status in ('passou', 'aviso', 'barrou')),
  decided_by     uuid references liame.app_user (id) on delete set null,
  decided_at     timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists idx_ad_piece_tenant on liame.ad_piece (tenant_id);
create index if not exists idx_ad_piece_brand on liame.ad_piece (brand_id, status, created_at desc);
create index if not exists idx_ad_piece_request on liame.ad_piece (request_id);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'ad_piece_request_piece_id_fkey' and conrelid = 'liame.ad_piece_request'::regclass) then
    alter table liame.ad_piece_request add constraint ad_piece_request_piece_id_fkey foreign key (piece_id) references liame.ad_piece (id) on delete cascade;
  end if;
end $$;

create table if not exists liame.ad_piece_version (
  id             uuid primary key,
  tenant_id      uuid not null references liame.organization (id) on delete cascade,
  piece_id       uuid not null references liame.ad_piece (id) on delete cascade,
  version        integer not null check (version >= 1),
  title          text not null check (length(title) between 1 and 60),
  body           text not null check (length(body) between 1 and 400),
  button         text not null check (button in ('pedir_agora', 'ver_cardapio', 'enviar_mensagem')),
  -- A conferência desta versão, item por item (o formato do contrato), o resultado e as versões das regras que a
  -- fizeram (`{"texto": 2, "anuncio": 1}`): regra que muda não reescreve a conferência antiga.
  review         jsonb not null check (jsonb_typeof(review) = 'object'),
  review_status  text not null check (review_status in ('passou', 'aviso', 'barrou')),
  rules_version  jsonb not null check (jsonb_typeof(rules_version) = 'object'),
  -- sha256 do título, do texto e do botão em JSON canônico: a decisão vale para este hash.
  content_hash   text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  -- `criativo` (a IA escreveu) ou `pessoa` (alguém editou); quem editou fica em `created_by`.
  author         text not null check (author in ('criativo', 'pessoa')),
  created_by     uuid references liame.app_user (id) on delete set null,
  -- O pedido que gerou esta versão (o das peças novas, ou o "pedir outra"); nulo na edição de uma pessoa.
  request_id     uuid references liame.ad_piece_request (id) on delete set null,
  usage_id       uuid references liame.ai_usage (id),
  created_at     timestamptz not null default now(),
  unique (piece_id, version)
);
create index if not exists idx_ad_piece_version_tenant on liame.ad_piece_version (tenant_id);

create table if not exists liame.ad_piece_decision (
  id            uuid primary key,
  tenant_id     uuid not null references liame.organization (id) on delete cascade,
  piece_id      uuid not null references liame.ad_piece (id) on delete cascade,
  version       integer not null check (version >= 1),
  -- O hash da versão que a pessoa viu ao decidir.
  content_hash  text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  -- `aprovada`, `recusada` ou `contestada` ("a conferência errou?": guarda o motivo e não destrava a peça).
  decision      text not null check (decision in ('aprovada', 'recusada', 'contestada')),
  reason        text check (reason ~ '^[a-z_]{2,40}$'),
  comment       text check (length(comment) between 1 and 500),
  decided_by    uuid references liame.app_user (id) on delete set null,
  created_at    timestamptz not null default now()
);
create index if not exists idx_ad_piece_decision_piece on liame.ad_piece_decision (piece_id, created_at);
create index if not exists idx_ad_piece_decision_tenant on liame.ad_piece_decision (tenant_id);

-- ------------------------------------------------------------ RLS e grants

do $$
declare t text;
begin
  foreach t in array array['ad_piece_request', 'ad_piece', 'ad_piece_version', 'ad_piece_decision']
  loop
    execute format('alter table liame.%I enable row level security', t);
    execute format('alter table liame.%I force row level security', t);
    execute format('drop policy if exists %I on liame.%I', t || '_isolamento', t);
    execute format(
      'create policy %I on liame.%I using (tenant_id = liame.current_tenant_id() or liame.system_scope()) with check (tenant_id = liame.current_tenant_id() or liame.system_scope())',
      t || '_isolamento', t);
  end loop;
end $$;
grant select, insert, update on liame.ad_piece_request to liame_app;
grant select, insert, update on liame.ad_piece to liame_app;
-- Versões e decisões não mudam depois de gravadas.
grant select, insert on liame.ad_piece_version to liame_app;
grant select, insert on liame.ad_piece_decision to liame_app;

-- ------------------------------------------------------------ a flag

-- Liga, por empresa, o Criativo: pedir peças, vê-las conferidas e decidir. Nasce desligada. Não escreve em plataforma
-- nenhuma (a campanha nova tem a flag dela, `meta_write`) e só chama modelo com a flag `ia` ligada.
insert into liame.feature_flag (key, kind, default_value, description, owner, is_write)
values ('criativo', 'boolean', 'false', 'Criativo: peças de anúncio (título, texto principal e botão) feitas a pedido, conferidas pelo código, para uma pessoa decidir (A4, X6)', 'midia', false)
on conflict (key) do nothing;
