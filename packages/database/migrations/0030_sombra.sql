-- 0030 · Sombra de verdade e prontidão (A3, I5; `ai-architecture.md` §4.2 e §4.3, data-model §6).
-- O Liame ainda não executa nada em anúncio (isso é a A4). Aqui fica o que ele TERIA recomendado, com a
-- confiança e o retrato do estado; o que a pessoa fez na plataforma, visto pela leitura diária; e, passada
-- a janela, o resultado e o arrependimento ("se tivesse sido autorizado, teria melhorado ou piorado?").
-- Quem grava é o worker, em escopo de sistema; a empresa só lê o que é dela. Nada aqui tem dado pessoal
-- de cliente. Idempotente; uma transação por arquivo (ADR-018).

-- A semente da flag grava em tabela com RLS forçada (V20).
select set_config('app.scope', 'sistema', true);

-- ------------------------------------------------------------ a recomendação em sombra

create table if not exists liame.shadow_decision (
  id                    uuid primary key,
  tenant_id             uuid not null references liame.organization (id) on delete cascade,
  brand_id              uuid not null references liame.brand (id) on delete cascade,
  connected_account_id  uuid not null references liame.connected_account (id) on delete cascade,
  campaign_id           uuid not null references liame.campaign (id) on delete cascade,
  provider              text not null check (provider ~ '^[a-z0-9_]+$'),
  -- Quem recomendou: regra do código (I5) ou, mais adiante, um funcionário de IA.
  source                text not null check (source in ('regra', 'agente')),
  -- A ação que só será executável na A4: `campanha_pausar`, `orcamento_reduzir`, `orcamento_aumentar`.
  tool                  text not null check (tool ~ '^[a-z][a-z0-9_]{2,60}$'),
  rule_key              text not null check (rule_key ~ '^[a-z][a-z0-9_]{2,60}$'),
  rule_version          integer not null check (rule_version >= 1),
  params                jsonb not null default '{}'::jsonb check (jsonb_typeof(params) = 'object'),
  confidence            numeric(4, 3) not null check (confidence between 0 and 1),
  -- Retrato do estado na decisão: situação e verba da campanha, a janela olhada, os números do caixa e
  -- da plataforma, o veredito e o frescor de cada fonte.
  state_snapshot        jsonb not null check (jsonb_typeof(state_snapshot) = 'object'),
  -- Dias no fuso da loja: o da decisão, a janela olhada e o primeiro dia em que dá para comparar.
  decided_on            date not null,
  window_from           date not null,
  window_to             date not null,
  evaluate_on           date not null,
  status                text not null check (status in ('aberta', 'avaliada', 'descartada')),
  -- O que a pessoa fez na plataforma: a primeira mudança que a leitura diária viu.
  human_action          text check (human_action in ('pausou', 'reduziu_verba', 'aumentou_verba', 'nenhuma')),
  human_action_on       date,
  agreement             text check (agreement in ('igual', 'mesma_direcao', 'contraria', 'nenhuma')),
  -- O resultado da campanha nos dias depois da decisão e a comparação.
  outcome               jsonb check (jsonb_typeof(outcome) = 'object'),
  -- Resultado de verdade menos o estimado se a recomendação tivesse sido executada: negativo = o Liame
  -- teria feito melhor. Nulo sem dado para comparar.
  action_regret_micros  bigint,
  regret_label          text check (regret_label in ('teria_melhorado', 'teria_piorado', 'igual', 'sem_dado')),
  evaluated_at          timestamptz,
  discard_reason        text check (length(discard_reason) between 3 and 200),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  check (window_from <= window_to and window_to < decided_on and evaluate_on > decided_on),
  check ((status = 'avaliada') = (evaluated_at is not null)),
  check (status <> 'avaliada' or (regret_label is not null and human_action is not null and agreement is not null)),
  check ((status = 'descartada') = (discard_reason is not null))
);
-- Uma recomendação em aberto por campanha: a mesma recomendação repetida todo dia não é amostra nova.
create unique index if not exists uq_shadow_decision_aberta on liame.shadow_decision (campaign_id) where status = 'aberta';
create unique index if not exists uq_shadow_decision_dia on liame.shadow_decision (campaign_id, decided_on);
create index if not exists idx_shadow_decision_marca on liame.shadow_decision (tenant_id, brand_id, status, evaluate_on);
create index if not exists idx_shadow_decision_conta on liame.shadow_decision (connected_account_id, tool, status);

-- ------------------------------------------------------------ a vez de cada marca

-- Uma linha por marca: quando a rotina olhou por último e quando volta. É a linha que a reserva trava
-- (SKIP LOCKED) e altera (V35).
create table if not exists liame.shadow_state (
  brand_id         uuid primary key references liame.brand (id) on delete cascade,
  tenant_id        uuid not null references liame.organization (id) on delete cascade,
  last_run_on      date,
  last_status      text check (last_status ~ '^[a-z][a-z0-9_]{1,40}$'),
  next_at          timestamptz not null default now(),
  last_attempt_at  timestamptz,
  updated_at       timestamptz not null default now()
);
create index if not exists idx_shadow_state_proxima on liame.shadow_state (next_at);
create index if not exists idx_shadow_state_tenant on liame.shadow_state (tenant_id);

-- ------------------------------------------------------------ prontidão

-- Os sinais do índice de prontidão por conta e ferramenta, um retrato por dia. A promoção de modo é
-- proposta pelo sistema e aprovada por uma pessoa (I13); aqui só se junta a evidência.
create table if not exists liame.readiness_snapshot (
  id                    uuid primary key,
  tenant_id             uuid not null references liame.organization (id) on delete cascade,
  brand_id              uuid not null references liame.brand (id) on delete cascade,
  connected_account_id  uuid not null references liame.connected_account (id) on delete cascade,
  tool                  text not null check (tool ~ '^[a-z][a-z0-9_]{2,60}$'),
  computed_on           date not null,
  rule_version          integer not null check (rule_version >= 1),
  -- Decisões comparáveis: avaliadas e com dado para dizer se teria melhorado ou piorado.
  sample_size           integer not null check (sample_size >= 0),
  agreement_rate        numeric(5, 4) check (agreement_rate between 0 and 1),
  worse_rate            numeric(5, 4) check (worse_rate between 0 and 1),
  regret_sum_micros     bigint not null default 0,
  confidence_avg        numeric(4, 3) check (confidence_avg between 0 and 1),
  -- O que falta para propor a promoção: `amostra`, `concordancia`, `piora`, `arrependimento`, `confianca`.
  missing               text[] not null default '{}',
  created_at            timestamptz not null default now(),
  unique (connected_account_id, tool, computed_on)
);
create index if not exists idx_readiness_snapshot_marca on liame.readiness_snapshot (tenant_id, brand_id, computed_on);

-- ------------------------------------------------------------ quando a pessoa discorda

-- A pessoa diz, na tela, que não faria o que o Liame recomendou, e por quê. A rota e a tela chegam com
-- "Sua equipe" (I13); a tabela nasce aqui para a amostra da sombra já ter onde guardar o motivo.
create table if not exists liame.human_override (
  id                  uuid primary key,
  tenant_id           uuid not null references liame.organization (id) on delete cascade,
  shadow_decision_id  uuid not null references liame.shadow_decision (id) on delete cascade,
  user_id             uuid references liame.app_user (id) on delete set null,
  recommended_action  text not null check (recommended_action ~ '^[a-z][a-z0-9_]{2,60}$'),
  -- O que a pessoa fez ou vai fazer no lugar; nulo = nada.
  executed_action     text check (executed_action ~ '^[a-z][a-z0-9_]{2,60}$'),
  reason_code         text not null check (reason_code ~ '^[a-z][a-z0-9_]{2,40}$'),
  reason_text         text check (length(reason_text) between 1 and 500),
  created_at          timestamptz not null default now()
);
create index if not exists idx_human_override_decisao on liame.human_override (shadow_decision_id);
create index if not exists idx_human_override_tenant on liame.human_override (tenant_id, created_at);

-- ------------------------------------------------------------ RLS e grants

-- A empresa lê o que é dela; quem grava é a rotina do worker, em escopo de sistema.
do $$
declare t text;
begin
  foreach t in array array['shadow_decision', 'shadow_state', 'readiness_snapshot']
  loop
    execute format('alter table liame.%I enable row level security', t);
    execute format('alter table liame.%I force row level security', t);
    execute format('drop policy if exists %I on liame.%I', t || '_isolamento', t);
    execute format(
      'create policy %I on liame.%I using (tenant_id = liame.current_tenant_id() or liame.system_scope()) with check (liame.system_scope())',
      t || '_isolamento', t);
    execute format('grant select, insert, update on liame.%I to liame_app', t);
  end loop;
end $$;

-- O motivo é da pessoa: ela grava só em nome dela, na empresa dela, e a empresa lê.
alter table liame.human_override enable row level security;
alter table liame.human_override force row level security;
drop policy if exists human_override_isolamento on liame.human_override;
create policy human_override_isolamento on liame.human_override
  using (tenant_id = liame.current_tenant_id() or liame.system_scope())
  with check ((tenant_id = liame.current_tenant_id() and user_id = liame.current_user_id()) or liame.system_scope());
grant select, insert on liame.human_override to liame_app;

-- ------------------------------------------------------------ flag

-- Nasce desligada para todos: a distribuição liga por empresa (comando `ligar-flag`).
insert into liame.feature_flag (key, kind, default_value, description, owner, is_write)
values ('sombra', 'boolean', 'false', 'Sombra de verdade: registra o que o Liame recomendaria em anúncio e compara com o que aconteceu (A3, I5)', 'ia', false)
on conflict (key) do nothing;
