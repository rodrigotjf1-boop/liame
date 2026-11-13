-- 0156 · O ritmo da semana (plano da região, R7, parte 1b; protótipo aprovado pelo dono em 13/11/2026, D-RG-58 a
-- D-RG-65). O Gestor de tráfego monta, uma vez por semana, a verba de cada dia das campanhas da Meta (pelos pedidos da
-- loja, a chuva e as datas, sem gastar mais na semana) e pede em Aprovações; uma aprovação com o código do app vale para
-- os 7 dias, e o Liame muda a verba no começo de cada dia.
-- (1) A função `ritmo_da_semana`, desligada.
-- (2) `budget_rhythm`: o ritmo de uma semana de uma marca (a loja de onde vêm os pedidos, a conta de anúncios, a semana
--     de segunda a domingo, o plano que a pessoa aprova e em que pé está). Um ritmo em aberto por marca e semana.
-- (3) `budget_rhythm_step`: cada passo (a verba de um dia numa campanha, ou a volta à verba de antes), com o pedido de
--     ação que o executou: uma tentativa por passo; a campanha mexida por fora sai do ritmo e fica como a pessoa deixou.
-- Da distribuição (a função) e das empresas (o ritmo e os passos). Idempotente; uma transação por arquivo (ADR-018).

-- A semente grava em tabela com RLS forçada (V20).
select set_config('app.scope', 'sistema', true);

-- ------------------------------------------------------------ (1) a função

insert into liame.feature_flag (key, kind, default_value, description, owner, is_write)
values ('ritmo_da_semana', 'boolean', 'false', 'Ritmo da semana: o Gestor de tráfego propõe a verba de cada dia das campanhas da Meta, com uma aprovação por semana (plano da região, R7)', 'midia', false)
on conflict (key) do nothing;

-- ------------------------------------------------------------ (2) o ritmo

create table if not exists liame.budget_rhythm (
  id             uuid primary key,
  tenant_id      uuid not null references liame.organization (id) on delete cascade,
  brand_id       uuid not null references liame.brand (id) on delete cascade,
  -- A loja de onde vêm os pedidos por dia da semana, a previsão do tempo e o fuso.
  unit_id        uuid not null references liame.unit (id) on delete cascade,
  -- A conta de anúncios da Meta das campanhas do ritmo.
  ad_account_id  uuid not null references liame.connected_account (id) on delete cascade,
  -- A semana: de segunda a domingo.
  week_start     date not null,
  week_end       date not null,
  -- `pedido` (espera a aprovação), `aprovado` (por começar ou rodando), `parado` (uma pessoa parou), `encerrado` (a
  -- semana acabou e a verba voltou à de antes) ou `cancelado` (o pedido foi recusado ou expirou).
  status         text not null default 'pedido',
  -- De onde veio o peso de cada dia: `loja` (os pedidos dela) ou `setor` (a referência, sem pedidos que bastem).
  source         text not null,
  -- O plano que a pessoa aprova: os 7 dias (o peso e os porquês) e as campanhas (a verba de hoje e a de cada dia).
  plan           jsonb not null,
  -- O pedido em Aprovações; fica nulo se o pedido for apagado (o ritmo guarda a situação dele).
  action_id      uuid references liame.action_request (id) on delete set null,
  version        integer not null default 1,
  approved_at    timestamptz,
  -- Quem parou; nulo enquanto ninguém parou (e se a pessoa sair da base, o ritmo parado continua parado: `stopped_at`).
  stopped_by     uuid references liame.app_user (id) on delete set null,
  stopped_at     timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint budget_rhythm_situacao check (status in ('pedido', 'aprovado', 'parado', 'encerrado', 'cancelado')),
  constraint budget_rhythm_fonte check (source in ('loja', 'setor')),
  constraint budget_rhythm_semana check (week_end = week_start + 6 and extract(isodow from week_start) = 1),
  constraint budget_rhythm_plano check (jsonb_typeof(plan) = 'object'),
  constraint budget_rhythm_versao check (version >= 1),
  -- A hora vale pelo estado: a chave de quem parou pode ficar nula depois (V185), a hora não.
  constraint budget_rhythm_parado check ((status = 'parado') = (stopped_at is not null))
);
create index if not exists idx_budget_rhythm_tenant on liame.budget_rhythm (tenant_id);
create index if not exists idx_budget_rhythm_abertos on liame.budget_rhythm (status, week_start) where status in ('pedido', 'aprovado', 'parado');
-- Um ritmo em aberto por marca e semana: o segundo pedido da mesma semana espera o primeiro ser decidido.
create unique index if not exists budget_rhythm_um_por_semana on liame.budget_rhythm (brand_id, week_start) where status in ('pedido', 'aprovado');

alter table liame.budget_rhythm enable row level security;
alter table liame.budget_rhythm force row level security;
drop policy if exists budget_rhythm_isolamento on liame.budget_rhythm;
create policy budget_rhythm_isolamento on liame.budget_rhythm
  using (tenant_id = liame.current_tenant_id() or liame.system_scope())
  with check (tenant_id = liame.current_tenant_id() or liame.system_scope());
grant select, insert, update on liame.budget_rhythm to liame_app;

-- ------------------------------------------------------------ (3) os passos

create table if not exists liame.budget_rhythm_step (
  id             uuid primary key,
  tenant_id      uuid not null references liame.organization (id) on delete cascade,
  rhythm_id      uuid not null references liame.budget_rhythm (id) on delete cascade,
  -- O dia do passo, no fuso da loja.
  day            date not null,
  -- O objeto na Meta, como o trilho de ações o chama: `campanha:<id>` ou `conjunto:<id>`.
  resource_id    text not null,
  -- `ritmo` (a verba do dia) ou `volta` (a verba de antes: no fim da semana, ou quando alguém para o ritmo).
  kind           text not null,
  -- A verba que o passo deixa, em micros; e a que ele espera encontrar (a que o Liame deixou no passo anterior).
  target_micros  bigint not null,
  expected_micros bigint not null,
  -- `pedido` (o pedido de ação saiu), `feito`, `fora` (a verba estava diferente: alguém mexeu por fora, e a campanha sai
  -- do ritmo), `bloqueado` (não coube nos limites de agora, ou a Meta recusou) ou `igual` (a verba já era a do dia).
  status         text not null,
  reason         text,
  action_id      uuid references liame.action_request (id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint budget_rhythm_step_recurso check (resource_id ~ '^(campanha|conjunto):[0-9]{1,25}$'),
  constraint budget_rhythm_step_tipo check (kind in ('ritmo', 'volta')),
  constraint budget_rhythm_step_situacao check (status in ('pedido', 'feito', 'fora', 'bloqueado', 'igual')),
  constraint budget_rhythm_step_valores check (target_micros > 0 and expected_micros > 0),
  constraint budget_rhythm_step_motivo check (reason is null or length(reason) between 1 and 500),
  -- Uma tentativa por passo: o mesmo dia, o mesmo objeto, o mesmo tipo.
  unique (rhythm_id, day, resource_id, kind)
);
create index if not exists idx_budget_rhythm_step_tenant on liame.budget_rhythm_step (tenant_id);

alter table liame.budget_rhythm_step enable row level security;
alter table liame.budget_rhythm_step force row level security;
drop policy if exists budget_rhythm_step_isolamento on liame.budget_rhythm_step;
create policy budget_rhythm_step_isolamento on liame.budget_rhythm_step
  using (tenant_id = liame.current_tenant_id() or liame.system_scope())
  with check (tenant_id = liame.current_tenant_id() or liame.system_scope());
grant select, insert, update on liame.budget_rhythm_step to liame_app;

-- ------------------------------------------------------------ conferência

do $$ begin
  if not exists (select 1 from liame.feature_flag where key = 'ritmo_da_semana' and default_value = 'false'::jsonb and not is_write) then
    raise exception '0156: a função ritmo_da_semana não entrou desligada';
  end if;
  if (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'liame' and c.relname in ('budget_rhythm', 'budget_rhythm_step') and c.relrowsecurity and c.relforcerowsecurity) <> 2 then
    raise exception '0156: as tabelas do ritmo não entraram com a RLS forçada';
  end if;
  if (select count(*) from pg_policies where schemaname = 'liame' and tablename in ('budget_rhythm', 'budget_rhythm_step')) <> 2 then
    raise exception '0156: as regras de acesso do ritmo não entraram';
  end if;
  if not exists (select 1 from pg_indexes where schemaname = 'liame' and indexname = 'budget_rhythm_um_por_semana') then
    raise exception '0156: o índice de um ritmo em aberto por marca e semana não entrou';
  end if;
end $$;
