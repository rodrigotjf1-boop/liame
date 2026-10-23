-- 0080 · Os planos e a assinatura (A7, W1; `plano-a7.md` D-A7-4 a D-A7-6, D-A7-13 a D-A7-19 e as decisões da W1,
-- D-A7-20 a D-A7-26; protótipo P26, aprovado em 22/10/2026). Três tabelas:
--   `billing_plan`     os planos do produto, versionados: o preço, os funcionários e a franquia de IA de cada versão. A
--                      assinatura fica presa à versão que contratou: um preço novo é uma versão nova, para quem assina
--                      depois, e o reajuste de quem já assina é outro passo, com o aviso de 30 dias (Termos 10.3);
--   `subscription`     a assinatura de cada marca, com a vida dela: esperando o primeiro pagamento, ativa, em atraso
--                      (do 1º ao 9º dia), com as ações paradas (do 10º ao 29º), suspensa (do 30º em diante) e encerrada
--                      (Termos 10.4 e 11; D-A7-6);
--   `billing_invoice`  as faturas: a mensalidade de cada período e a diferença da troca para um plano maior (D-A7-16),
--                      uma vez só por período.
-- Nenhum dado de cartão: o cartão fica só no meio de pagamento (A7-1). Aqui ficam a forma (cartão, PIX ou Pix
-- Automático) e, a partir da W2, a referência da cobrança no meio de pagamento.
-- Nada usa estas tabelas enquanto a função `cobranca` estiver desligada.
-- Idempotente; uma transação por arquivo (ADR-018).

-- As sementes (os planos e a flag) gravam em tabela com RLS forçada (V20).
select set_config('app.scope', 'sistema', true);

-- ------------------------------------------------------------ os planos (do produto, sem empresa)

create table if not exists liame.billing_plan (
  id                     uuid primary key,
  -- `essencial` ou `completo`: a chave fica a mesma entre as versões.
  key                    text not null check (key ~ '^[a-z][a-z_]{2,29}$'),
  version                integer not null check (version >= 1),
  name                   text not null check (length(name) between 2 and 40),
  -- Por mês, em centavos (data-model §1).
  price_cents            bigint not null check (price_cents > 0),
  currency               text not null default 'BRL' check (currency = 'BRL'),
  -- Os funcionários de IA incluídos, pelas chaves do registro (`lia`, `trafego`…).
  -- (O tamanho é conferido à parte: a expressão regular do Postgres não aceita repetição acima de 255.)
  agents                 text[] not null check (cardinality(agents) between 1 and 30 and array_to_string(agents, ',') ~ '^[a-z_,]+$' and length(array_to_string(agents, ',')) <= 600),
  -- A franquia de IA do dia e do mês, em micros de dólar (a moeda do teto da empresa, D-A3-3). Vazia: vale o teto padrão
  -- do servidor. O valor de cada plano se fixa com um mês de uso de verdade (D-A7-5).
  ai_daily_usd_micros    bigint check (ai_daily_usd_micros > 0),
  ai_monthly_usd_micros  bigint,
  -- A versão que uma assinatura nova recebe: uma por chave.
  offered                boolean not null default true,
  sort                   smallint not null default 0,
  created_at             timestamptz not null default now(),
  constraint billing_plan_versao unique (key, version),
  -- A franquia vem inteira (o dia e o mês) ou não vem, e o mês cabe o dia.
  constraint billing_plan_franquia check ((ai_daily_usd_micros is null) = (ai_monthly_usd_micros is null)
                                          and (ai_monthly_usd_micros is null or ai_monthly_usd_micros >= ai_daily_usd_micros))
);
create unique index if not exists uq_billing_plan_oferecido on liame.billing_plan (key) where offered;

-- ------------------------------------------------------------ a assinatura (uma viva por marca)

create table if not exists liame.subscription (
  id                     uuid primary key,
  tenant_id              uuid not null references liame.organization (id) on delete cascade,
  brand_id               uuid not null references liame.brand (id) on delete cascade,
  -- A versão do plano em vigor, e a que entra no período seguinte quando o Dono desce de plano (D-A7-16).
  plan_id                uuid not null references liame.billing_plan (id),
  next_plan_id           uuid references liame.billing_plan (id),
  -- Onde a assinatura está:
  --   `aguardando_pagamento`  contratada, esperando o primeiro pagamento (sem ele em 7 dias, termina sozinha, D-A7-24);
  --   `ativa`                 em dia (também a cancelada que ainda vai até o fim do período pago);
  --   `em_atraso`             do 1º ao 9º dia depois do vencimento de uma mensalidade em aberto;
  --   `acoes_paradas`         do 10º ao 29º dia: os funcionários de IA param (a parada da empresa, W3);
  --   `suspensa`              do 30º dia em diante: só o Dono entra, para pagar ou exportar os dados (W3);
  --   `encerrada`             terminou; o porquê fica em `end_reason`.
  status                 text not null default 'aguardando_pagamento'
                         check (status in ('aguardando_pagamento', 'ativa', 'em_atraso', 'acoes_paradas', 'suspensa', 'encerrada')),
  -- A forma das próximas cobranças: `cartao`, `pix` (a cobrança de cada mês, D-A7-17) ou `pix_automatico` (só com a
  -- função própria ligada, e nunca antes de 30/12/2026).
  method                 text not null check (method in ('cartao', 'pix', 'pix_automatico')),
  -- O dia do mês do vencimento: o do primeiro pagamento; no mês sem esse dia, o último dia do mês (D-A7-21).
  anchor_day             smallint check (anchor_day between 1 and 31),
  -- O período em vigor, em datas do fuso da empresa: começa num vencimento e vai até o próximo, sem incluí-lo.
  period_start           date,
  period_end             date,
  first_paid_at          timestamptz,
  -- Até quando o Dono pode desistir com a devolução integral: o 7º dia depois do primeiro pagamento, só na primeira
  -- contratação da empresa (Termos 11.1; D-A7-19). Vazio: não pode.
  withdraw_until         date,
  -- Cancelada pelo Dono: termina no fim do período pago (Termos 11.1; D-A7-25 para a que está em atraso).
  cancel_at_period_end   boolean not null default false,
  cancel_requested_at    timestamptz,
  cancel_requested_by    uuid references liame.app_user (id) on delete set null,
  ended_at               timestamptz,
  --   `cancelada`    pelo Dono, no fim do período pago (ou na hora, se o período em vigor não foi pago);
  --   `desistencia`  em até 7 dias depois do primeiro pagamento, com a devolução integral (Termos 11.1);
  --   `nao_paga`     sem o primeiro pagamento em 7 dias;
  --   `substituida`  por uma assinatura nova da mesma marca, antes do primeiro pagamento.
  end_reason             text check (end_reason in ('cancelada', 'desistencia', 'nao_paga', 'substituida')),
  -- Quando a rotina olha de novo: o começo do dia seguinte no fuso da empresa (os dias de atraso, a fatura do período
  -- seguinte, o fim do período) ou o prazo do primeiro pagamento.
  next_check_at          timestamptz not null default now(),
  created_by             uuid references liame.app_user (id) on delete set null,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  -- A encerrada tem a hora e o porquê; a viva, nenhum dos dois.
  constraint subscription_fim check ((status = 'encerrada') = (ended_at is not null) and (ended_at is null) = (end_reason is null)),
  -- Depois do primeiro pagamento, tem o período e o dia do vencimento; antes, nada disso.
  constraint subscription_periodo check ((first_paid_at is null) = (period_start is null)
                                         and (period_start is null) = (period_end is null)
                                         and (period_start is null) = (anchor_day is null)
                                         and (period_end is null or period_end > period_start)),
  -- A que espera o primeiro pagamento ainda não foi paga; a que está em dia ou em atraso já foi. (Uma regra por
  -- coisa: a situação fora da lista é a `subscription_status_check` que recusa.)
  constraint subscription_espera check ((status <> 'aguardando_pagamento' or first_paid_at is null)
                                        and (status not in ('ativa', 'em_atraso', 'acoes_paradas', 'suspensa') or first_paid_at is not null)),
  -- A desistência só existe depois do primeiro pagamento.
  constraint subscription_desistencia check (withdraw_until is null or first_paid_at is not null),
  -- O cancelamento pedido tem a hora do pedido.
  constraint subscription_cancelada check (cancel_at_period_end = (cancel_requested_at is not null))
);
-- Uma assinatura viva por marca: o pedido repetido não contrata duas vezes.
create unique index if not exists uq_subscription_viva on liame.subscription (brand_id) where status <> 'encerrada';
create index if not exists idx_subscription_tenant on liame.subscription (tenant_id);
create index if not exists idx_subscription_marca on liame.subscription (brand_id, created_at desc);
-- A fila da rotina: as vivas cuja vez chegou.
create index if not exists idx_subscription_fila on liame.subscription (next_check_at) where status <> 'encerrada';

-- ------------------------------------------------------------ as faturas

create table if not exists liame.billing_invoice (
  id                     uuid primary key,
  tenant_id              uuid not null references liame.organization (id) on delete cascade,
  brand_id               uuid not null references liame.brand (id) on delete cascade,
  subscription_id        uuid not null references liame.subscription (id) on delete cascade,
  -- `mensalidade` (um período) ou `diferenca` (a troca para um plano maior, pelos dias que faltam, D-A7-16).
  kind                   text not null check (kind in ('mensalidade', 'diferenca')),
  -- O plano cobrado; na diferença, o plano novo, que entra quando ela é paga (D-A7-23).
  plan_id                uuid not null references liame.billing_plan (id),
  -- O período coberto, em datas do fuso da empresa. A primeira mensalidade só ganha o período quando é paga (o período
  -- começa no dia do pagamento).
  period_start           date,
  period_end             date,
  due_date               date not null,
  amount_cents           bigint not null check (amount_cents > 0),
  currency               text not null default 'BRL' check (currency = 'BRL'),
  --   `aberta`     esperando o pagamento;
  --   `paga`;
  --   `cancelada`  não vai ser cobrada (a assinatura terminou antes, ou a troca de plano foi refeita);
  --   `devolvida`  devolvida na desistência em 7 dias, depois da devolução confirmada pelo meio de pagamento (W2).
  status                 text not null default 'aberta' check (status in ('aberta', 'paga', 'cancelada', 'devolvida')),
  paid_at                timestamptz,
  paid_method            text check (paid_method in ('cartao', 'pix', 'pix_automatico')),
  canceled_at            timestamptz,
  refund_requested_at    timestamptz,
  refunded_at            timestamptz,
  -- A cobrança no meio de pagamento (W2).
  provider               text check (provider ~ '^[a-z0-9_]{2,30}$'),
  external_id            text check (length(external_id) between 1 and 100),
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  -- Paga (ou paga e devolvida) tem a hora e a forma; aberta e cancelada, não.
  constraint billing_invoice_paga check ((status in ('paga', 'devolvida')) = (paid_at is not null) and (paid_at is null) = (paid_method is null)),
  constraint billing_invoice_cancelada check ((status = 'cancelada') = (canceled_at is not null)),
  -- A devolução pedida só na paga; a devolvida tem o pedido e a confirmação.
  constraint billing_invoice_devolucao check ((refund_requested_at is null or paid_at is not null)
                                              and (refunded_at is null or refund_requested_at is not null)
                                              and ((status = 'devolvida') = (refunded_at is not null))),
  constraint billing_invoice_externa check ((provider is null) = (external_id is null)),
  constraint billing_invoice_periodo check ((period_start is null) = (period_end is null) and (period_end is null or period_end > period_start)),
  -- A diferença tem o período desde o começo (de hoje ao fim do período em vigor); a mensalidade paga também.
  constraint billing_invoice_com_periodo check (period_start is not null or (kind = 'mensalidade' and status in ('aberta', 'cancelada')))
);
-- Uma mensalidade por período: a rotina que roda duas vezes não cobra em dobro. A cancelada não conta: o Dono que
-- cancela e depois mantém a assinatura recebe a fatura do período de novo.
create unique index if not exists uq_billing_invoice_periodo on liame.billing_invoice (subscription_id, period_start)
  where kind = 'mensalidade' and period_start is not null and status <> 'cancelada';
-- Uma primeira mensalidade (ainda sem período) por assinatura.
create unique index if not exists uq_billing_invoice_primeira on liame.billing_invoice (subscription_id)
  where kind = 'mensalidade' and period_start is null and status <> 'cancelada';
-- Uma diferença em aberto por assinatura: pedir de novo refaz a troca.
create unique index if not exists uq_billing_invoice_diferenca on liame.billing_invoice (subscription_id)
  where kind = 'diferenca' and status = 'aberta';
-- A cobrança do meio de pagamento é de uma fatura só (W2).
create unique index if not exists uq_billing_invoice_externa on liame.billing_invoice (provider, external_id) where provider is not null;
create index if not exists idx_billing_invoice_tenant on liame.billing_invoice (tenant_id);
create index if not exists idx_billing_invoice_marca on liame.billing_invoice (brand_id, due_date desc);
create index if not exists idx_billing_invoice_assinatura on liame.billing_invoice (subscription_id, due_date);

-- ------------------------------------------------------------ RLS e grants

-- Os planos são do produto (V51): todos leem; só o escopo de sistema grava.
alter table liame.billing_plan enable row level security;
alter table liame.billing_plan force row level security;
drop policy if exists billing_plan_leitura on liame.billing_plan;
create policy billing_plan_leitura on liame.billing_plan for select using (true);
drop policy if exists billing_plan_sistema on liame.billing_plan;
create policy billing_plan_sistema on liame.billing_plan using (liame.system_scope()) with check (liame.system_scope());
grant select on liame.billing_plan to liame_app;

alter table liame.subscription enable row level security;
alter table liame.subscription force row level security;
drop policy if exists subscription_isolamento on liame.subscription;
create policy subscription_isolamento on liame.subscription
  using (tenant_id = liame.current_tenant_id() or liame.system_scope())
  with check (tenant_id = liame.current_tenant_id() or liame.system_scope());
grant select, insert, update on liame.subscription to liame_app;

alter table liame.billing_invoice enable row level security;
alter table liame.billing_invoice force row level security;
drop policy if exists billing_invoice_isolamento on liame.billing_invoice;
create policy billing_invoice_isolamento on liame.billing_invoice
  using (tenant_id = liame.current_tenant_id() or liame.system_scope())
  with check (tenant_id = liame.current_tenant_id() or liame.system_scope());
grant select, insert, update on liame.billing_invoice to liame_app;

-- ------------------------------------------------------------ os dois planos (D-A7-4, 22/10/2026)

-- Os funcionários de cada um, como no P26 aprovado: o Essencial com a LIA, o Gestor de tráfego, o Analista de dados, os
-- Relatórios e o Compliance; o Completo com tudo do Essencial, mais o Estrategista, o Pesquisador, o Criativo, o Social
-- media e o CRM e mensageria. A franquia de IA fica vazia até a D-A7-5.
insert into liame.billing_plan (id, key, version, name, price_cents, agents, sort)
values ('019a0f00-0000-7000-8000-000000000001', 'essencial', 1, 'Essencial', 24900,
        array['lia', 'trafego', 'analista', 'relatorios', 'compliance'], 1),
       ('019a0f00-0000-7000-8000-000000000002', 'completo', 1, 'Completo', 44900,
        array['lia', 'trafego', 'analista', 'relatorios', 'compliance', 'estrategista', 'pesquisador', 'criativo', 'social', 'crm'], 2)
on conflict (key, version) do nothing;

-- ------------------------------------------------------------ a função

-- Liga, por empresa, Plano e cobrança: os planos, a assinatura da marca e a vida dela. Nasce desligada. Sozinha, não
-- cobra ninguém: o pagamento entra com a W2 (o Asaas, D-A7-2), e o Pix Automático tem função própria, que também nasce
-- desligada (D-A7-17).
insert into liame.feature_flag (key, kind, default_value, description, owner, is_write)
values ('cobranca', 'boolean', 'false', 'Plano e cobrança: os planos, a assinatura de cada marca e a vida dela (em dia, em atraso, ações paradas, suspensa, encerrada) (A7, W1)', 'cobranca', false)
on conflict (key) do nothing;
