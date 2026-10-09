-- 0059 · O pedido de mensagem (A5, Y5, parte 4; `plano-a5.md` D-A5-10 a D-A5-16; protótipo P15 aprovado em 09/10/2026).
-- O que o Liame montou para uma mensagem de WhatsApp antes de pedir a aprovação: a campanha em rascunho no RegemCast
-- (o id de lá), o modelo como a Meta o aprovou (o texto que a pessoa aprova), o valor de cada variável, o público (o
-- nome, a regra e a conta de quem recebe), a janela de envio (sempre dentro de 9h às 20h) e o cupom da mensagem.
-- É o retrato do pedido: os números que mudam (as pessoas, o custo, o que impede) continuam vindo do plano do disparo,
-- lido no RegemCast e guardado no pedido de ação. Nenhum telefone e nenhum nome de contato: o público é sempre um que
-- já existe no RegemCast, e quem põe o nome de cada pessoa na mensagem é ele.
-- Nada usa esta tabela enquanto o conector do RegemCast está fora do registro de ações.
-- Idempotente; uma transação por arquivo (ADR-018).

create table if not exists liame.message_request (
  id                    uuid primary key,
  tenant_id             uuid not null references liame.organization (id) on delete cascade,
  brand_id              uuid not null references liame.brand (id) on delete cascade,
  -- A conta do RegemCast por onde a mensagem sai.
  connected_account_id  uuid not null references liame.connected_account (id) on delete cascade,
  -- O id, no RegemCast, da campanha em rascunho que o Liame montou.
  campaign_id           text not null check (campaign_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  -- O pedido de envio no trilho de ação. Nulo só entre montar o rascunho e pedir, na mesma transação.
  action_request_id     uuid references liame.action_request (id) on delete set null,
  name                  text not null check (length(name) between 2 and 120),
  -- O modelo como a Meta o aprovou, na hora do pedido. Conteúdo escrito pela loja.
  template_name         text not null check (length(template_name) between 1 and 512),
  template_language     text not null check (length(template_language) between 2 and 20),
  template_category     text check (length(template_category) between 1 and 60),
  template_header       text check (length(template_header) <= 2000),
  template_body         text not null check (length(template_body) between 1 and 5000),
  template_footer       text check (length(template_footer) <= 500),
  template_buttons      jsonb not null default '[]'::jsonb check (jsonb_typeof(template_buttons) = 'array'),
  -- O valor de cada variável do texto, em ordem ({{1}}, {{2}}…): `fixo` com o valor, ou o que o RegemCast preenche na
  -- hora do envio (`primeiro_nome`…). O Liame nunca guarda o nome de ninguém.
  variables             jsonb not null default '[]'::jsonb check (jsonb_typeof(variables) = 'array'),
  header_variable       jsonb check (header_variable is null or jsonb_typeof(header_variable) = 'object'),
  -- De onde sai o público (a origem e o id do RegemCast), o nome e a regra dele, e a conta de quem recebe na hora do
  -- pedido: quantos podem receber, quantos ficam de fora por terem recebido marketing há pouco, e o descanso da conta.
  audience              jsonb not null check (jsonb_typeof(audience) = 'object'),
  audience_name         text not null check (length(audience_name) between 1 and 300),
  audience_rule         text check (length(audience_rule) <= 1000),
  people_can_receive    integer not null check (people_can_receive >= 0),
  people_resting        integer not null check (people_resting >= 0),
  rest_days             integer check (rest_days >= 0),
  -- A janela de envio, no fuso da conta do RegemCast: os dias (0 = domingo) e o horário, sempre dentro de 09:00 a
  -- 20:00 (D-A5-13). A comparação de texto vale porque o formato é HH:MM com dois dígitos.
  window_days           smallint[] not null check (cardinality(window_days) between 1 and 7 and window_days <@ array[0, 1, 2, 3, 4, 5, 6]::smallint[]),
  window_start          text not null check (window_start ~ '^[0-2][0-9]:[0-5][0-9]$' and window_start >= '09:00'),
  window_end            text not null check (window_end ~ '^[0-2][0-9]:[0-5][0-9]$' and window_end <= '20:00'),
  -- O cupom da mensagem (D-A5-16): a loja do Regem onde ele nasce, o código e a regra (contrato de cupons §3.3). Ele é
  -- criado junto com o envio, depois da aprovação; `coupon_id` é o cupom na lista do Liame, quando existir.
  coupon_account_id     uuid references liame.connected_account (id) on delete set null,
  coupon_code           text check (coupon_code ~ '^[A-Z0-9]{4,20}$'),
  coupon_rule           jsonb check (coupon_rule is null or jsonb_typeof(coupon_rule) = 'object'),
  coupon_id             uuid references liame.coupon (id) on delete set null,
  coupon_created_at     timestamptz,
  -- Quem propôs: um funcionário de IA (`agent`, com a chave dele), em nome da pessoa de `requested_by`, ou a pessoa.
  actor_type            text not null check (actor_type in ('human', 'agent')),
  agent_key             text check (agent_key ~ '^[a-z][a-z0-9_]{1,40}$'),
  requested_by          uuid references liame.app_user (id) on delete set null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint message_request_janela check (window_start < window_end),
  constraint message_request_cupom_inteiro check ((coupon_code is null) = (coupon_rule is null)),
  constraint message_request_ator check ((actor_type = 'agent') = (agent_key is not null)),
  -- Uma campanha do RegemCast é de um pedido só (V24).
  unique (connected_account_id, campaign_id)
);
create index if not exists idx_message_request_tenant on liame.message_request (tenant_id);
create index if not exists idx_message_request_brand on liame.message_request (brand_id, created_at desc);
create unique index if not exists uq_message_request_acao on liame.message_request (action_request_id) where action_request_id is not null;
-- O cupom da mensagem é só dela: o mesmo código não entra em dois pedidos da mesma loja.
create unique index if not exists uq_message_request_cupom on liame.message_request (coupon_account_id, coupon_code) where coupon_code is not null and coupon_account_id is not null;

-- ------------------------------------------------------------ RLS e grants

alter table liame.message_request enable row level security;
alter table liame.message_request force row level security;
drop policy if exists message_request_isolamento on liame.message_request;
create policy message_request_isolamento on liame.message_request
  using (tenant_id = liame.current_tenant_id() or liame.system_scope())
  with check (tenant_id = liame.current_tenant_id() or liame.system_scope());
grant select, insert, update on liame.message_request to liame_app;
