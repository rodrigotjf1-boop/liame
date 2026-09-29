-- 0024 · Regra completa do cupom da loja (A2.5, F4/F6; contrato de cupons §3.1): teto do desconto
-- percentual, condições de uso e se vale para todas as lojas da empresa. O espelho mostra o cupom como a
-- loja o cadastrou, para ligar a campanhas e usar no criativo. Idempotente; uma transação por arquivo.

alter table liame.coupon add column if not exists max_discount_micros bigint;
alter table liame.coupon drop constraint if exists coupon_max_discount_check;
alter table liame.coupon add constraint coupon_max_discount_check check (max_discount_micros is null or max_discount_micros >= 0);
-- somente_novos, max_por_cliente, min_dias_sem_compra (como a origem manda; sem dado pessoal).
alter table liame.coupon add column if not exists conditions jsonb not null default '{}'::jsonb;
alter table liame.coupon drop constraint if exists coupon_conditions_check;
alter table liame.coupon add constraint coupon_conditions_check check (jsonb_typeof(conditions) = 'object');
alter table liame.coupon add column if not exists all_units boolean not null default false;
