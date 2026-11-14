-- 0159 · O teste de região (plano da região, R8; protótipo dos testes aprovado pelo dono em 13/11/2026, D-RG-81 e
-- D-RG-82). Um bairro da área de entrega fica 14 dias sem anúncio nas campanhas que o Liame criou, e o caixa diz quanto
-- o anúncio traz ali. O teste usa a tabela `campaign_test` (o tipo `regiao`, da 0157); aqui entra o que só ele precisa.
-- (1) A função `teste_de_regiao`, desligada.
-- (2) `campaign_test.interrupted_at`: a hora em que o Liame parou de medir um teste (o de criativo também). Até aqui o
--     prazo do aviso do teste interrompido contava de `updated_at`; com a coluna, conta da hora certa.
-- (3) `campaign_test_target`: cada conjunto da Meta que o bairro deixa durante o teste (das campanhas que o Liame criou):
--     o público como a Meta mostrava no pedido (o `targeting` inteiro, para devolver igual), a impressão dos campos que o
--     Liame controla (para conferir, antes de cada passo, que o conjunto está como o Liame deixou) e em que pé está.
-- Da distribuição (a função) e das empresas (os conjuntos do teste). Idempotente; uma transação por arquivo (ADR-018).

-- A semente grava em tabela com RLS forçada (V20).
select set_config('app.scope', 'sistema', true);

-- ------------------------------------------------------------ (1) a função, desligada

insert into liame.feature_flag (key, kind, default_value, description, owner, is_write)
values ('teste_de_regiao', 'boolean', 'false', 'Teste de região: um bairro da área de entrega fica 14 dias sem anúncio nas campanhas que o Liame criou, e o caixa diz quanto o anúncio traz ali (plano da região, R8)', 'midia', false)
on conflict (key) do nothing;

-- ------------------------------------------------------------ (2) a hora em que o Liame parou de medir

alter table liame.campaign_test add column if not exists interrupted_at timestamptz;

-- ------------------------------------------------------------ (3) os conjuntos que o bairro deixa

create table if not exists liame.campaign_test_target (
  id                   uuid primary key,
  tenant_id            uuid not null references liame.organization (id) on delete cascade,
  test_id              uuid not null references liame.campaign_test (id) on delete cascade,
  -- A conta de anúncios da Meta, a campanha e o conjunto (os ids na Meta) e o nome do conjunto, como a pessoa viu.
  ad_account_id        uuid not null references liame.connected_account (id) on delete cascade,
  meta_campaign_id     text not null,
  meta_adset_id        text not null,
  name                 text not null,
  -- O público do conjunto como a Meta mostrava no pedido (o `targeting` inteiro): é o que volta no fim.
  targeting_before     jsonb not null,
  -- A impressão dos campos do público que o Liame controla (os lugares, a idade, os interesses que ele escreveu).
  fingerprint_before   text not null,
  -- `a_tirar` (o bairro ainda está no conjunto), `tirado`, `devolvido`, `mexido` (alguém mudou o público por fora: o
  -- Liame não mexe mais nele) ou `falhou` (a Meta recusou a saída ou a volta).
  status               text not null default 'a_tirar',
  -- Os pedidos de ação da saída e da volta do bairro (o trilho de sempre).
  out_action_id        uuid references liame.action_request (id) on delete set null,
  back_action_id       uuid references liame.action_request (id) on delete set null,
  reason               text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint campaign_test_target_situacao check (status in ('a_tirar', 'tirado', 'devolvido', 'mexido', 'falhou')),
  constraint campaign_test_target_publico check (jsonb_typeof(targeting_before) = 'object'),
  constraint campaign_test_target_textos check (
    length(meta_campaign_id) between 1 and 40 and length(meta_adset_id) between 1 and 40 and length(name) between 1 and 400
    and length(fingerprint_before) between 1 and 128 and coalesce(length(reason), 0) <= 500),
  unique (test_id, meta_adset_id)
);
create index if not exists idx_campaign_test_target_tenant on liame.campaign_test_target (tenant_id);

alter table liame.campaign_test_target enable row level security;
alter table liame.campaign_test_target force row level security;
drop policy if exists campaign_test_target_isolamento on liame.campaign_test_target;
create policy campaign_test_target_isolamento on liame.campaign_test_target
  using (tenant_id = liame.current_tenant_id() or liame.system_scope())
  with check (tenant_id = liame.current_tenant_id() or liame.system_scope());
grant select, insert, update on liame.campaign_test_target to liame_app;

-- ------------------------------------------------------------ conferência

do $$ begin
  if not exists (select 1 from liame.feature_flag where key = 'teste_de_regiao' and default_value = 'false'::jsonb and not is_write) then
    raise exception '0159: a função teste_de_regiao não entrou desligada';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'liame' and table_name = 'campaign_test' and column_name = 'interrupted_at') then
    raise exception '0159: a coluna interrupted_at não entrou';
  end if;
  if not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                  where n.nspname = 'liame' and c.relname = 'campaign_test_target' and c.relrowsecurity and c.relforcerowsecurity) then
    raise exception '0159: a tabela dos conjuntos do teste não entrou com a RLS forçada';
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'liame' and tablename = 'campaign_test_target') then
    raise exception '0159: a regra de acesso dos conjuntos do teste não entrou';
  end if;
end $$;
