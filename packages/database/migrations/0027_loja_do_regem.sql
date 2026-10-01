-- 0027 · A loja do Regem ligada sem loja do Liame ganha a loja dela (A2.5; ERR-047). O link de campanha, o
-- cupom informado e a plataforma de pedidos são por loja do Liame, e não havia onde criar uma: a conta do
-- piloto nasceu sem loja. A partir desta versão, ligar a loja do Regem cria a loja do Liame; aqui, as que já
-- estavam ligadas ganham a delas (nome e fuso da loja no Regem) e os pedidos já lidos passam a apontar para ela.
-- Idempotente (só mexe em conta sem loja); uma transação por arquivo (ADR-018).

-- Dado de todas as empresas: a RLS é forçada também para o dono das tabelas.
select set_config('app.scope', 'sistema', true);

with sem_loja as materialized (
  select a.id as conta_id, a.tenant_id, a.brand_id,
         coalesce(nullif(left(btrim(a.name), 200), ''), 'Loja') as nome,
         coalesce(nullif(a.timezone, ''), 'America/Sao_Paulo') as fuso,
         gen_random_uuid() as unit_id
    from liame.connected_account a
   where a.provider = 'regem' and a.unit_id is null and a.disconnected_at is null
),
novas as (
  insert into liame.unit (id, tenant_id, brand_id, name, timezone)
  select unit_id, tenant_id, brand_id, nome, fuso from sem_loja
  returning id
),
ligadas as (
  update liame.connected_account a set unit_id = s.unit_id, updated_at = now()
    from sem_loja s
   where a.id = s.conta_id
  returning a.id, s.unit_id
)
update liame.order_fact o set unit_id = l.unit_id
  from ligadas l
 where o.connected_account_id = l.id and o.unit_id is null;
