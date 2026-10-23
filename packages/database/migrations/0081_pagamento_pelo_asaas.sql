-- 0081 · O PIX pelo Asaas (A7, W2a, parte 1; `plano-a7.md` D-A7-27 a D-A7-33; `base-conhecimento.md` §18.5). Três coisas:
--   `billing_customer`  a empresa como cliente no meio de pagamento, uma por empresa e por meio (D-A7-31);
--   na `billing_invoice`, a cobrança da fatura no meio de pagamento: o endereço da fatura hospedada, a situação que o
--                       meio informou por último e a fila da criação (a trava da vez, as tentativas, a próxima vez e o
--                       porquê da última falha, em código). A referência da cobrança (`provider`, `external_id`) já veio
--                       com a 0080;
--   a permissão `cobranca.pagar` do Dono: pagar e trocar a forma de pagamento. O Administrador com a cobrança liberada a
--                       recebe pela sessão (`PERMISSOES_DA_COBRANCA_LIBERADA`, D-A7-13).
-- Nenhum dado de cartão (A7-1). Nada usa estas colunas enquanto a função `cobranca` estiver desligada e o Asaas não
-- estiver configurado.
-- Idempotente; uma transação por arquivo (ADR-018).

-- A semente da permissão grava em tabela com RLS forçada (V20).
select set_config('app.scope', 'sistema', true);

-- ------------------------------------------------------------ a empresa no meio de pagamento

create table if not exists liame.billing_customer (
  tenant_id     uuid not null references liame.organization (id) on delete cascade,
  -- `asaas` (D-A7-2). Outro meio entraria aqui sem mudar a tabela (a interface do meio de pagamento, D-A7-27).
  provider      text not null check (provider ~ '^[a-z0-9_]{2,30}$'),
  -- O id do cliente no meio de pagamento (`cus_…` no Asaas).
  external_id   text not null check (length(external_id) between 1 and 100),
  created_at    timestamptz not null default now(),
  constraint billing_customer_pk primary key (tenant_id, provider),
  constraint billing_customer_externo unique (provider, external_id)
);

-- ------------------------------------------------------------ a cobrança da fatura no meio de pagamento

-- O endereço da fatura hospedada (o `invoiceUrl` do Asaas): é por ele que se paga fora do Liame.
alter table liame.billing_invoice add column if not exists provider_url text
  check (provider_url is null or (length(provider_url) between 12 and 500 and provider_url like 'https://%'));
-- A situação da cobrança como o meio de pagamento a informou por último (`PENDING`, `RECEIVED`, `CONFIRMED`…).
alter table liame.billing_invoice add column if not exists provider_status text
  check (provider_status is null or provider_status ~ '^[A-Z_]{2,60}$');
-- A fila da criação: só um caminho cria a cobrança de cada vez (o worker ou a pessoa pedindo o QR Code). A trava vence
-- sozinha: se o processo cair no meio, a próxima vez procura a cobrança pelo id da fatura antes de criar outra (a API do
-- Asaas não tem chave de idempotência, base §18.5).
alter table liame.billing_invoice add column if not exists charge_locked_until timestamptz;
alter table liame.billing_invoice add column if not exists charge_attempts integer not null default 0 check (charge_attempts >= 0);
alter table liame.billing_invoice add column if not exists charge_next_at timestamptz;
-- O porquê da última falha, em código (`sem_cnpj`, `meio_fora_do_ar`, `chave_recusada`…); nunca o texto do erro.
alter table liame.billing_invoice add column if not exists charge_error text
  check (charge_error is null or charge_error ~ '^[a-z_]{2,40}$');

-- A fila da rotina: as faturas em aberto ainda sem cobrança no meio de pagamento.
create index if not exists idx_billing_invoice_a_cobrar on liame.billing_invoice (charge_next_at nulls first)
  where status = 'aberta' and external_id is null;

-- ------------------------------------------------------------ RLS e grants

alter table liame.billing_customer enable row level security;
alter table liame.billing_customer force row level security;
drop policy if exists billing_customer_isolamento on liame.billing_customer;
create policy billing_customer_isolamento on liame.billing_customer
  using (tenant_id = liame.current_tenant_id() or liame.system_scope())
  with check (tenant_id = liame.current_tenant_id() or liame.system_scope());
grant select, insert on liame.billing_customer to liame_app;

-- ------------------------------------------------------------ a permissão de pagar (D-A7-13)

insert into liame.role_permission (tenant_id, role_key, permission)
values (null, 'dono', 'cobranca.pagar')
on conflict do nothing;
