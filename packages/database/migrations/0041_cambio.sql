-- 0041 · Câmbio de referência (A3, D-A3-14; Sua equipe, protótipo P7).
-- O custo de IA é medido e limitado em dólar (a moeda do fornecedor e do teto). Para a tela mostrar o valor
-- aproximado em reais, o worker lê a PTAX de venda do Banco Central (dados abertos, sem credencial) e guarda uma
-- cotação por dia útil. É dado público e do produto: sem empresa, todos leem e só o sistema grava (V51). A cotação de
-- um dia não muda depois de publicada. Idempotente; uma transação por arquivo (ADR-018).

create table if not exists liame.exchange_rate (
  -- O par, pela ISO 4217: quantos `quote` valem 1 `base` (USD e BRL: reais por dólar).
  base          text not null check (base ~ '^[A-Z]{3}$'),
  quote         text not null check (quote ~ '^[A-Z]{3}$' and quote <> base),
  -- O dia do boletim, no horário de Brasília.
  rate_date     date not null,
  rate          numeric(12, 6) not null check (rate > 0),
  -- De onde veio: `bcb_ptax_venda` (PTAX de venda, boletim de fechamento do Banco Central).
  source        text not null check (source ~ '^[a-z][a-z0-9_]{2,40}$'),
  published_at  timestamptz not null,
  fetched_at    timestamptz not null default now(),
  primary key (base, quote, rate_date)
);

alter table liame.exchange_rate enable row level security;
alter table liame.exchange_rate force row level security;
drop policy if exists exchange_rate_leitura on liame.exchange_rate;
create policy exchange_rate_leitura on liame.exchange_rate for select using (true);
drop policy if exists exchange_rate_sistema on liame.exchange_rate;
create policy exchange_rate_sistema on liame.exchange_rate using (liame.system_scope()) with check (liame.system_scope());
grant select, insert on liame.exchange_rate to liame_app;
