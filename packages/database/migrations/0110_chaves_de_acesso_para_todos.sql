-- 0110 · As chaves de acesso ligadas para todos (A7, W9; P28; D-A7-87, item 13).
-- O dono aprovou o texto da Política sobre as chaves (#423), testou na Mister Burgers em 03/11/2026 (criou a chave,
-- aprovou um pedido com ela e entrou com ela depois da senha) e disse "pode ligar para todos". A regra do ambiente de
-- produção liga a flag `chaves_de_acesso` para todas as empresas, e com ela o "Entrar com chave de acesso", sem senha,
-- que só olha o ambiente (na entrada ainda não há empresa). A regra da Mister Burgers (por empresa) fica como está.
-- Desligar de novo: apagar esta regra; o que já existe continua valendo (como na 0109).
-- Idempotente; uma transação por arquivo (ADR-018). Sem tabela nova e sem coluna nova.

-- A regra grava em tabela com RLS forçada (V20).
select set_config('app.scope', 'sistema', true);

insert into liame.feature_flag_rule (id, flag_key, scope_type, scope_id, value, created_by)
values (gen_random_uuid(), 'chaves_de_acesso', 'environment', 'production', 'true'::jsonb, 'migration 0110 (decisão do dono em 03/11/2026)')
on conflict (flag_key, scope_type, scope_id) do update set value = excluded.value;

do $$
begin
  if not exists (
    select 1 from liame.feature_flag_rule
    where flag_key = 'chaves_de_acesso' and scope_type = 'environment' and scope_id = 'production' and value = 'true'::jsonb
  ) then
    raise exception '0110: a regra do ambiente das chaves de acesso não ficou ligada';
  end if;
end $$;
