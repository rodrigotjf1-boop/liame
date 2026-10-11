-- 0063 · O desconto padrão do cupom das mensagens (A5, Y6; decisão do dono em 10/10/2026; protótipo P15, parte D,
-- aguardando aprovação). O cupom de cada mensagem de WhatsApp tem o mesmo desconto, e quem o define é a empresa, uma
-- vez: o funcionário de CRM e mensageria usa este desconto em toda proposta e não inventa oferta nem preço. Sem a
-- linha da marca, ele não propõe.
-- Uma linha por marca: o que o cupom dá (percentual, valor fixo ou entrega grátis, os três tipos do cupom de campanha
-- do Regem), o pedido mínimo, por quantos dias vale (contando o dia do envio) e a loja do Regem onde ele nasce.
-- Os limites daqui são os do contrato de cupons do Regem. Os do produto, mais estreitos (até 50%, até R$ 100,00, até
-- 14 dias), ficam no servidor: ainda esperam o aceite do dono, e mudar um deles não pode pedir migration.
-- Nenhum dado de cliente. Quem definiu por último (`updated_by`) é uma pessoa da própria empresa.
-- Nada usa esta tabela enquanto a rotina do CRM não existir; as rotas dela ficam atrás da flag `mensageria`.
-- Idempotente; uma transação por arquivo (ADR-018).

create table if not exists liame.message_discount (
  id                 uuid primary key,
  tenant_id          uuid not null references liame.organization (id) on delete cascade,
  brand_id           uuid not null references liame.brand (id) on delete cascade,
  -- A loja do Regem onde o cupom de cada mensagem nasce (a conta conectada, no Liame).
  coupon_account_id  uuid not null references liame.connected_account (id) on delete cascade,
  kind               text not null check (kind in ('percentual', 'valor', 'frete_gratis')),
  -- O percentual, só no cupom percentual; o valor em centavos, só no de valor fixo.
  percent            integer check (percent between 1 and 100),
  value_cents        integer check (value_cents between 1 and 100000000),
  -- Nulo = o cupom vale para qualquer pedido.
  min_order_cents    integer check (min_order_cents between 1 and 100000000),
  -- Por quantos dias o cupom vale, contando o dia do envio.
  valid_days         integer not null check (valid_days between 1 and 90),
  created_by         uuid references liame.app_user (id) on delete set null,
  updated_by         uuid references liame.app_user (id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint message_discount_tipo check ((kind = 'percentual') = (percent is not null) and (kind = 'valor') = (value_cents is not null)),
  -- Com desconto em reais, o pedido mínimo é obrigatório e maior que o desconto (senão o cupom zeraria um pedido pequeno).
  constraint message_discount_valor_com_minimo check (kind <> 'valor' or (min_order_cents is not null and min_order_cents > value_cents)),
  constraint message_discount_uma_por_marca unique (brand_id)
);
create index if not exists idx_message_discount_tenant on liame.message_discount (tenant_id);

-- ------------------------------------------------------------ RLS e grants

alter table liame.message_discount enable row level security;
alter table liame.message_discount force row level security;
drop policy if exists message_discount_isolamento on liame.message_discount;
create policy message_discount_isolamento on liame.message_discount
  using (tenant_id = liame.current_tenant_id() or liame.system_scope())
  with check (tenant_id = liame.current_tenant_id() or liame.system_scope());
grant select, insert, update on liame.message_discount to liame_app;
