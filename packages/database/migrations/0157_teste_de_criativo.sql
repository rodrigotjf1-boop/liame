-- 0157 · O teste de criativo (plano da região, R8; protótipo dos testes aprovado pelo dono em 13/11/2026, D-RG-76 a
-- D-RG-80 e D-RG-83). Uma pessoa pede, em Criativos, o teste de duas peças aprovadas: o Liame cria na Meta uma campanha
-- de teste pausada, com dois conjuntos iguais (o mesmo público, a mesma verba, o mesmo objetivo), um anúncio em cada um
-- e um cupom do Regem para cada criativo. Quem decide é o caixa: os pedidos confirmados de cada criativo.
-- (1) A função `teste_de_criativo`, desligada.
-- (2) `campaign_test`: o teste de uma marca (o tipo, o plano que a pessoa aprova, em que pé está, a campanha de teste na
--     Meta, os dias e o resultado guardado em números somados). Um teste vivo por marca. O tipo `regiao` (o bairro 14
--     dias sem anúncio, D-RG-81) usa a mesma tabela quando chegar.
-- (3) `campaign_test_arm`: cada criativo do teste (A e B): a peça e a mídia, o cupom e o que já existe na Meta.
-- Da distribuição (a função) e das empresas (o teste e os criativos). Idempotente; uma transação por arquivo (ADR-018).

-- A semente grava em tabela com RLS forçada (V20).
select set_config('app.scope', 'sistema', true);

-- ------------------------------------------------------------ (1) a função

insert into liame.feature_flag (key, kind, default_value, description, owner, is_write)
values ('teste_de_criativo', 'boolean', 'false', 'Teste de criativo: duas peças aprovadas lado a lado numa campanha de teste da Meta, com um cupom para cada uma; quem decide é o caixa (plano da região, R8)', 'midia', false)
on conflict (key) do nothing;

-- ------------------------------------------------------------ (2) o teste

create table if not exists liame.campaign_test (
  id                   uuid primary key,
  tenant_id            uuid not null references liame.organization (id) on delete cascade,
  brand_id             uuid not null references liame.brand (id) on delete cascade,
  -- A loja (o raio ou os bairros, o fuso e os pedidos do caixa).
  unit_id              uuid not null references liame.unit (id) on delete cascade,
  -- A conta de anúncios da Meta e a Página que assina os anúncios.
  ad_account_id        uuid not null references liame.connected_account (id) on delete cascade,
  page_account_id      uuid references liame.connected_account (id) on delete cascade,
  -- `criativo` (duas peças lado a lado) ou `regiao` (um bairro sem anúncio).
  kind                 text not null,
  -- `pedido` (espera a aprovação), `criando` (aprovado: a campanha de teste e os cupons estão sendo criados), `pronto`
  -- (tudo criado e pausado: o teste começa quando a campanha for ativada), `rodando`, `terminado` (chegou ao fim, com ou
  -- sem vencedor), `encerrado` (uma pessoa encerrou antes), `interrompido` (mexeram por fora ou a plataforma recusou: o
  -- Liame não conclui) ou `cancelado` (o pedido foi recusado ou expirou, ou a campanha não foi criada).
  status               text not null default 'pedido',
  name                 text not null,
  -- A verba diária do teste inteiro, em micros (no teste de criativo, metade para cada conjunto); nula no de região.
  daily_budget_micros  bigint,
  -- O mínimo e o máximo de dias (criativo: 7 e 28; região: 14 e 14).
  min_days             smallint not null,
  max_days             smallint not null,
  -- O plano que a pessoa aprova (o estado do pedido, como foi mostrado).
  plan                 jsonb not null,
  -- O pedido em Aprovações; fica nulo se o pedido for apagado (o teste guarda a situação dele).
  action_id            uuid references liame.action_request (id) on delete set null,
  version              integer not null default 1,
  -- A campanha de teste na Meta, e se o Liame a ativou.
  meta_campaign_id     text,
  active               boolean not null default false,
  error                text,
  -- O primeiro dia inteiro com os dois conjuntos no ar, e o último dia do teste, no fuso da loja.
  started_on           date,
  ended_on             date,
  -- Os números guardados no fim (somas; nunca um pedido nem um cliente).
  result               jsonb,
  reason               text,
  created_by           uuid references liame.app_user (id) on delete set null,
  approved_at          timestamptz,
  -- Quem encerrou; a hora vale pelo estado (a chave pode ficar nula depois, V185).
  stopped_by           uuid references liame.app_user (id) on delete set null,
  stopped_at           timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint campaign_test_tipo check (kind in ('criativo', 'regiao')),
  constraint campaign_test_situacao check (status in ('pedido', 'criando', 'pronto', 'rodando', 'terminado', 'encerrado', 'interrompido', 'cancelado')),
  constraint campaign_test_nome check (length(name) between 1 and 80),
  constraint campaign_test_verba check (daily_budget_micros is null or daily_budget_micros > 0),
  constraint campaign_test_do_criativo check (kind <> 'criativo' or (daily_budget_micros is not null and page_account_id is not null)),
  constraint campaign_test_dias check (min_days between 1 and max_days and max_days <= 60),
  constraint campaign_test_plano check (jsonb_typeof(plan) = 'object'),
  constraint campaign_test_resultado check (result is null or jsonb_typeof(result) = 'object'),
  constraint campaign_test_versao check (version >= 1),
  constraint campaign_test_periodo check (ended_on is null or (started_on is not null and ended_on >= started_on)),
  constraint campaign_test_textos check (coalesce(length(error), 0) <= 2000 and coalesce(length(reason), 0) <= 500 and coalesce(length(meta_campaign_id), 0) <= 40),
  constraint campaign_test_encerrado check ((status = 'encerrado') = (stopped_at is not null))
);
create index if not exists idx_campaign_test_tenant on liame.campaign_test (tenant_id);
create index if not exists idx_campaign_test_marca on liame.campaign_test (brand_id, created_at desc);
create index if not exists idx_campaign_test_vivos on liame.campaign_test (status) where status in ('criando', 'pronto', 'rodando');
-- Um teste vivo por marca (D-RG-81: nunca dois testes nas mesmas campanhas): o segundo pedido espera o primeiro acabar.
create unique index if not exists campaign_test_um_vivo_por_marca on liame.campaign_test (brand_id) where status in ('pedido', 'criando', 'pronto', 'rodando');

alter table liame.campaign_test enable row level security;
alter table liame.campaign_test force row level security;
drop policy if exists campaign_test_isolamento on liame.campaign_test;
create policy campaign_test_isolamento on liame.campaign_test
  using (tenant_id = liame.current_tenant_id() or liame.system_scope())
  with check (tenant_id = liame.current_tenant_id() or liame.system_scope());
grant select, insert, update on liame.campaign_test to liame_app;

-- ------------------------------------------------------------ (3) os criativos do teste

create table if not exists liame.campaign_test_arm (
  id                   uuid primary key,
  tenant_id            uuid not null references liame.organization (id) on delete cascade,
  test_id              uuid not null references liame.campaign_test (id) on delete cascade,
  -- A ou B.
  letter               text not null,
  -- A peça de texto aprovada, na versão que a pessoa viu, e a foto ou o vídeo da loja (Fotos).
  piece_id             uuid not null references liame.ad_piece (id) on delete cascade,
  piece_version        integer not null,
  media_id             uuid not null references liame.brand_photo (id) on delete cascade,
  -- O cupom deste criativo no Regem: o código, o pedido de ação que o cria e em que pé está.
  coupon_code          text not null,
  coupon_status        text not null default 'a_criar',
  coupon_action_id     uuid references liame.action_request (id) on delete set null,
  -- O que já existe na Meta, passo a passo.
  meta_adset_id        text,
  meta_video_id        text,
  video_waiting_since  timestamptz,
  meta_creative_id     text,
  meta_ad_id           text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint campaign_test_arm_letra check (letter in ('A', 'B')),
  constraint campaign_test_arm_versao check (piece_version >= 1),
  constraint campaign_test_arm_cupom check (length(coupon_code) between 1 and 60 and coupon_code = upper(coupon_code)),
  constraint campaign_test_arm_cupom_situacao check (coupon_status in ('a_criar', 'pedido', 'criado', 'falhou')),
  constraint campaign_test_arm_ids check (
    coalesce(length(meta_adset_id), 0) <= 40 and coalesce(length(meta_video_id), 0) <= 40 and coalesce(length(meta_creative_id), 0) <= 40 and coalesce(length(meta_ad_id), 0) <= 40),
  unique (test_id, letter),
  -- Um cupom por criativo: os dois do mesmo teste nunca têm o mesmo código.
  unique (test_id, coupon_code)
);
create index if not exists idx_campaign_test_arm_tenant on liame.campaign_test_arm (tenant_id);
create index if not exists idx_campaign_test_arm_peca on liame.campaign_test_arm (piece_id);

alter table liame.campaign_test_arm enable row level security;
alter table liame.campaign_test_arm force row level security;
drop policy if exists campaign_test_arm_isolamento on liame.campaign_test_arm;
create policy campaign_test_arm_isolamento on liame.campaign_test_arm
  using (tenant_id = liame.current_tenant_id() or liame.system_scope())
  with check (tenant_id = liame.current_tenant_id() or liame.system_scope());
grant select, insert, update on liame.campaign_test_arm to liame_app;

-- ------------------------------------------------------------ conferência

do $$ begin
  if not exists (select 1 from liame.feature_flag where key = 'teste_de_criativo' and default_value = 'false'::jsonb and not is_write) then
    raise exception '0157: a função teste_de_criativo não entrou desligada';
  end if;
  if (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'liame' and c.relname in ('campaign_test', 'campaign_test_arm') and c.relrowsecurity and c.relforcerowsecurity) <> 2 then
    raise exception '0157: as tabelas do teste não entraram com a RLS forçada';
  end if;
  if (select count(*) from pg_policies where schemaname = 'liame' and tablename in ('campaign_test', 'campaign_test_arm')) <> 2 then
    raise exception '0157: as regras de acesso do teste não entraram';
  end if;
  if not exists (select 1 from pg_indexes where schemaname = 'liame' and indexname = 'campaign_test_um_vivo_por_marca') then
    raise exception '0157: o índice de um teste vivo por marca não entrou';
  end if;
end $$;
