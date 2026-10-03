-- 0035 · Planos do Estrategista (A3, I11; `ai-architecture.md` §9; data-model §7; protótipo P8, aguardando aprovação).
-- O Estrategista propõe; a pessoa aprova (com o código do app), edita (nasce uma versão nova), recusa (com o motivo) ou
-- pede nova análise. Nada é executado: o plano é uma proposta com evidências, versões e hash (a aprovação vale para o
-- hash que a pessoa viu; plano alterado derruba a aprovação antiga). Três tipos: plano de 90 dias (objetivos, mês a
-- mês, verba por canal, calendário comercial), pauta da semana (dia a dia) e oferta (a promoção pedida).
-- O calendário comercial é dado do PRODUTO (feriados nacionais e datas do varejo, cada data com a fonte): as datas que
-- o Estrategista usa vêm daqui, nunca da memória do modelo (base de conhecimento §16.5).
-- Idempotente; uma transação por arquivo (ADR-018).

-- As permissões e o calendário gravam em tabela com RLS forçada (V20).
select set_config('app.scope', 'sistema', true);

-- ------------------------------------------------------------ calendário comercial (do produto)

create table if not exists liame.commercial_date (
  id      uuid primary key,
  day     date not null,
  name    text not null check (length(name) between 2 and 120),
  -- `feriado_nacional` (lei federal) ou `varejo` (data do comércio, sem feriado).
  kind    text not null check (kind in ('feriado_nacional', 'varejo')),
  -- A lei ou a regra de onde a data vem.
  source  text not null check (length(source) between 3 and 300),
  unique (day, name)
);
create index if not exists idx_commercial_date_day on liame.commercial_date (day);

alter table liame.commercial_date enable row level security;
alter table liame.commercial_date force row level security;
drop policy if exists commercial_date_leitura on liame.commercial_date;
create policy commercial_date_leitura on liame.commercial_date for select using (true);
drop policy if exists commercial_date_sistema on liame.commercial_date;
create policy commercial_date_sistema on liame.commercial_date using (liame.system_scope()) with check (liame.system_scope());
grant select on liame.commercial_date to liame_app;

-- Outubro de 2026 a dezembro de 2027. Feriados: Lei 662/1949 (redação da Lei 10.607/2002), Lei 6.802/1980 e
-- Lei 14.759/2023. Datas do varejo: a regra de cada uma. Feriado estadual e municipal não entra aqui.
insert into liame.commercial_date (id, day, name, kind, source) values
  (gen_random_uuid(), '2026-10-12', 'Nossa Senhora Aparecida', 'feriado_nacional', 'Lei 6.802/1980'),
  (gen_random_uuid(), '2026-10-12', 'Dia das Crianças', 'varejo', 'Data do varejo: 12 de outubro'),
  (gen_random_uuid(), '2026-10-31', 'Halloween', 'varejo', 'Data do varejo: 31 de outubro'),
  (gen_random_uuid(), '2026-11-02', 'Finados', 'feriado_nacional', 'Lei 662/1949, com a redação da Lei 10.607/2002'),
  (gen_random_uuid(), '2026-11-15', 'Proclamação da República', 'feriado_nacional', 'Lei 662/1949, com a redação da Lei 10.607/2002'),
  (gen_random_uuid(), '2026-11-20', 'Dia Nacional de Zumbi e da Consciência Negra', 'feriado_nacional', 'Lei 14.759/2023'),
  (gen_random_uuid(), '2026-11-27', 'Black Friday', 'varejo', 'Data do varejo: a sexta depois do Dia de Ação de Graças dos Estados Unidos'),
  (gen_random_uuid(), '2026-11-30', 'Cyber Monday', 'varejo', 'Data do varejo: a segunda depois da Black Friday'),
  (gen_random_uuid(), '2026-12-24', 'Véspera de Natal', 'varejo', 'Data do varejo: 24 de dezembro'),
  (gen_random_uuid(), '2026-12-25', 'Natal', 'feriado_nacional', 'Lei 662/1949, com a redação da Lei 10.607/2002'),
  (gen_random_uuid(), '2026-12-31', 'Réveillon', 'varejo', 'Data do varejo: 31 de dezembro'),
  (gen_random_uuid(), '2027-01-01', 'Confraternização Universal', 'feriado_nacional', 'Lei 662/1949, com a redação da Lei 10.607/2002'),
  (gen_random_uuid(), '2027-02-09', 'Carnaval', 'varejo', 'Data do varejo: a terça 47 dias antes da Páscoa (não é feriado nacional)'),
  (gen_random_uuid(), '2027-03-28', 'Páscoa', 'varejo', 'Data do varejo: o domingo de Páscoa do ano'),
  (gen_random_uuid(), '2027-04-21', 'Tiradentes', 'feriado_nacional', 'Lei 662/1949, com a redação da Lei 10.607/2002'),
  (gen_random_uuid(), '2027-05-01', 'Dia do Trabalho', 'feriado_nacional', 'Lei 662/1949, com a redação da Lei 10.607/2002'),
  (gen_random_uuid(), '2027-05-09', 'Dia das Mães', 'varejo', 'Data do varejo: o segundo domingo de maio'),
  (gen_random_uuid(), '2027-06-12', 'Dia dos Namorados', 'varejo', 'Data do varejo: 12 de junho'),
  (gen_random_uuid(), '2027-08-08', 'Dia dos Pais', 'varejo', 'Data do varejo: o segundo domingo de agosto'),
  (gen_random_uuid(), '2027-09-07', 'Independência do Brasil', 'feriado_nacional', 'Lei 662/1949, com a redação da Lei 10.607/2002'),
  (gen_random_uuid(), '2027-10-12', 'Nossa Senhora Aparecida', 'feriado_nacional', 'Lei 6.802/1980'),
  (gen_random_uuid(), '2027-10-12', 'Dia das Crianças', 'varejo', 'Data do varejo: 12 de outubro'),
  (gen_random_uuid(), '2027-10-31', 'Halloween', 'varejo', 'Data do varejo: 31 de outubro'),
  (gen_random_uuid(), '2027-11-02', 'Finados', 'feriado_nacional', 'Lei 662/1949, com a redação da Lei 10.607/2002'),
  (gen_random_uuid(), '2027-11-15', 'Proclamação da República', 'feriado_nacional', 'Lei 662/1949, com a redação da Lei 10.607/2002'),
  (gen_random_uuid(), '2027-11-20', 'Dia Nacional de Zumbi e da Consciência Negra', 'feriado_nacional', 'Lei 14.759/2023'),
  (gen_random_uuid(), '2027-11-26', 'Black Friday', 'varejo', 'Data do varejo: a sexta depois do Dia de Ação de Graças dos Estados Unidos'),
  (gen_random_uuid(), '2027-11-29', 'Cyber Monday', 'varejo', 'Data do varejo: a segunda depois da Black Friday'),
  (gen_random_uuid(), '2027-12-24', 'Véspera de Natal', 'varejo', 'Data do varejo: 24 de dezembro'),
  (gen_random_uuid(), '2027-12-25', 'Natal', 'feriado_nacional', 'Lei 662/1949, com a redação da Lei 10.607/2002'),
  (gen_random_uuid(), '2027-12-31', 'Réveillon', 'varejo', 'Data do varejo: 31 de dezembro')
on conflict (day, name) do nothing;

-- ------------------------------------------------------------ planos

create table if not exists liame.plan (
  id            uuid primary key,
  tenant_id     uuid not null references liame.organization (id) on delete cascade,
  brand_id      uuid not null references liame.brand (id) on delete cascade,
  kind          text not null check (kind in ('noventa_dias', 'pauta', 'oferta')),
  title         text not null check (length(title) between 3 and 160),
  -- `pendente` (espera a decisão), `aprovado`, `recusado`, `nova_analise` (a pessoa pediu outra; o Estrategista
  -- prepara a versão seguinte), `expirado` (ninguém decidiu a tempo).
  status        text not null default 'pendente' check (status in ('pendente', 'aprovado', 'recusado', 'nova_analise', 'expirado')),
  -- A versão atual (a última de `plan_version`).
  version       integer not null check (version >= 1),
  -- A demanda que pediu o plano (I10), quando houver.
  demand_id     uuid references liame.demand (id) on delete set null,
  requested_by  uuid references liame.app_user (id) on delete set null,
  expires_at    timestamptz not null,
  -- Fila da nova análise (como a da demanda): quando o Estrategista tenta de novo, quantas vezes tentou e por quê. Ao
  -- reservar, `next_attempt_at` vira o prazo da reserva: a tentativa que caiu no meio volta para a fila depois dele.
  attempts      integer not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz,
  last_error    text check (length(last_error) between 1 and 200),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists idx_plan_tenant on liame.plan (tenant_id);
create index if not exists idx_plan_brand on liame.plan (brand_id, status, created_at desc);
-- Uma demanda vira um plano só (o Estrategista pode tentar de novo sem duplicar, V24).
create unique index if not exists uq_plan_demanda on liame.plan (demand_id) where demand_id is not null;
create index if not exists idx_plan_fila on liame.plan (next_attempt_at) where status = 'nova_analise';

create table if not exists liame.plan_version (
  id            uuid primary key,
  tenant_id     uuid not null references liame.organization (id) on delete cascade,
  plan_id       uuid not null references liame.plan (id) on delete cascade,
  version       integer not null check (version >= 1),
  -- O plano, no formato do tipo (contrato `PlanContent`), e os números com a fonte de cada um (dita pelo código).
  content       jsonb not null check (jsonb_typeof(content) = 'object'),
  numbers       jsonb not null default '[]' check (jsonb_typeof(numbers) = 'array'),
  -- Cada texto do plano que tem número, em trechos com a posição do número em `numbers`, pelo caminho do campo
  -- ("reasons.0", "budget.today.meta"): é o que a tela marca e liga à fonte.
  marked        jsonb not null default '[]' check (jsonb_typeof(marked) = 'array'),
  risk          text not null check (risk in ('baixo', 'medio', 'alto')),
  -- Quanto o plano muda a verba de anúncios por mês, em micros (proposta − hoje; o código calcula); nulo quando não mexe.
  money_micros  bigint,
  -- sha256 do conteúdo em JSON canônico: a aprovação vale para este hash.
  content_hash  text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  -- `estrategista` (a IA propôs) ou `pessoa` (alguém editou); quem editou fica em `created_by`.
  author        text not null check (author in ('estrategista', 'pessoa')),
  created_by    uuid references liame.app_user (id) on delete set null,
  -- O pedido de nova análise que gerou esta versão, nas palavras da pessoa (sem dado pessoal).
  reanalysis    text check (length(reanalysis) between 1 and 1000),
  usage_id      uuid references liame.ai_usage (id),
  created_at    timestamptz not null default now(),
  unique (plan_id, version)
);
create index if not exists idx_plan_version_tenant on liame.plan_version (tenant_id);

create table if not exists liame.plan_decision (
  id            uuid primary key,
  tenant_id     uuid not null references liame.organization (id) on delete cascade,
  plan_id       uuid not null references liame.plan (id) on delete cascade,
  version       integer not null check (version >= 1),
  -- O hash da versão que a pessoa viu ao decidir.
  content_hash  text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  decision      text not null check (decision in ('aprovado', 'recusado', 'nova_analise')),
  reasons       text[] not null default '{}',
  comment       text check (length(comment) between 1 and 1000),
  decided_by    uuid references liame.app_user (id) on delete set null,
  created_at    timestamptz not null default now()
);
create index if not exists idx_plan_decision_plan on liame.plan_decision (plan_id, created_at);
create index if not exists idx_plan_decision_tenant on liame.plan_decision (tenant_id);

-- A fila do Estrategista na demanda: quando tentar de novo, quantas vezes tentou e por quê. Ao reservar (a demanda
-- passa a `em_andamento`), `next_attempt_at` vira o prazo da reserva: a tentativa que caiu no meio volta para a fila.
alter table liame.demand add column if not exists attempts integer not null default 0 check (attempts >= 0);
alter table liame.demand add column if not exists next_attempt_at timestamptz;
alter table liame.demand add column if not exists last_error text check (length(last_error) between 1 and 200);
create index if not exists idx_demand_fila on liame.demand (next_attempt_at) where status in ('aberta', 'em_andamento');

-- ------------------------------------------------------------ RLS e grants

do $$
declare t text;
begin
  foreach t in array array['plan', 'plan_version', 'plan_decision']
  loop
    execute format('alter table liame.%I enable row level security', t);
    execute format('alter table liame.%I force row level security', t);
    execute format('drop policy if exists %I on liame.%I', t || '_isolamento', t);
    execute format(
      'create policy %I on liame.%I using (tenant_id = liame.current_tenant_id() or liame.system_scope()) with check (tenant_id = liame.current_tenant_id() or liame.system_scope())',
      t || '_isolamento', t);
  end loop;
end $$;
grant select, insert, update on liame.plan to liame_app;
-- Versões e decisões não mudam depois de gravadas.
grant select, insert on liame.plan_version to liame_app;
grant select, insert on liame.plan_decision to liame_app;

-- ------------------------------------------------------------ permissões

-- Ver os planos: quem acompanha as campanhas. Decidir (aprovar, editar, recusar, pedir nova análise): quem aprova as
-- ações (dono, administrador, gestor e aprovador), sempre com o código do app para aprovar.
insert into liame.role_permission (tenant_id, role_key, permission)
values (null, 'dono', 'planos.ver'), (null, 'administrador', 'planos.ver'), (null, 'gestor', 'planos.ver'),
       (null, 'aprovador', 'planos.ver'), (null, 'somente_leitura', 'planos.ver'),
       (null, 'dono', 'planos.decidir'), (null, 'administrador', 'planos.decidir'), (null, 'gestor', 'planos.decidir'),
       (null, 'aprovador', 'planos.decidir')
on conflict do nothing;
