-- 0026 · Cupons de campanha (A2.5, F6; protótipo P3 com a plataforma de pedidos, aprovado em 30/09/2026):
-- o cupom informado de outra plataforma de pedidos (Anota AI, CardápioWeb), que o Liame reconhece pelo
-- código nos pedidos que chegam ao Regem, e onde cada loja recebe os pedidos online. A ligação agendada
-- (início num dia que ainda não chegou) pode ser apagada; a que já valeu fica como histórico.
-- Idempotente; uma transação por arquivo (ADR-018).

-- ------------------------------------------------------------ cupom informado de outra plataforma

-- `regem`: espelho da leitura do Regem. `externo`: informado por alguém da empresa; vive na plataforma de
-- pedidos (a regra e a validade ficam lá) e o id na origem é o próprio código (`externo:<CÓDIGO>`), o que
-- torna o mesmo código informado duas vezes na mesma loja um cupom só.
alter table liame.coupon add column if not exists origin text not null default 'regem';
alter table liame.coupon drop constraint if exists coupon_origin_check;
alter table liame.coupon add constraint coupon_origin_check check (origin in ('regem', 'externo'));
alter table liame.coupon add column if not exists platform text;
alter table liame.coupon drop constraint if exists coupon_platform_check;
alter table liame.coupon add constraint coupon_platform_check check (
  (origin = 'regem' and platform is null)
  or (origin = 'externo' and platform in ('anotaai', 'cardapioweb') and external_id = 'externo:' || code));
alter table liame.coupon add column if not exists created_by uuid references liame.app_user (id) on delete set null;

-- ------------------------------------------------------------ plataforma de pedidos da loja

-- Onde a loja recebe os pedidos online, informado pela empresa (o Liame sugere pelo destino dos anúncios).
-- Nulo = não informado. `outra` leva o endereço do cardápio (só https).
alter table liame.unit add column if not exists order_platform text;
alter table liame.unit drop constraint if exists unit_order_platform_check;
alter table liame.unit add constraint unit_order_platform_check
  check (order_platform in ('regem', 'anotaai', 'cardapioweb', 'brendi', 'outra'));
alter table liame.unit add column if not exists order_platform_url text;
alter table liame.unit drop constraint if exists unit_order_platform_url_check;
-- `is (not) distinct from`: com a plataforma nula, a conferência não pode virar nula e passar.
alter table liame.unit add constraint unit_order_platform_url_check check (
  (order_platform_url is null or order_platform is not distinct from 'outra')
  and (order_platform is distinct from 'outra' or order_platform_url is not null)
  and (order_platform_url is null or (length(order_platform_url) between 12 and 1024 and order_platform_url ~ '^https://[^[:space:]]+$')));
alter table liame.unit add column if not exists order_platform_set_at timestamptz;
alter table liame.unit add column if not exists order_platform_set_by uuid references liame.app_user (id) on delete set null;

-- ------------------------------------------------------------ ligação agendada

-- Só o sistema apaga ligações (0022), exceto a agendada que ainda não começou: nenhum pedido contou por ela.
drop policy if exists campaign_coupon_apaga_so_sistema on liame.campaign_coupon;
create policy campaign_coupon_apaga_so_sistema on liame.campaign_coupon as restrictive for delete
  using (liame.system_scope() or linked_at > now());

-- Lista da loja: as ligações de cada cupom, da mais nova à mais antiga.
create index if not exists idx_campaign_coupon_cupom on liame.campaign_coupon (coupon_id, linked_at desc);
