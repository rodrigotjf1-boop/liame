-- 0109 · As chaves de acesso nascem desligadas (A7, W9, parte 9d; P28; D-A7-87, item 13).
-- A flag `chaves_de_acesso`, desligada. Ela segura o CADASTRO de chave (Segurança da conta) e o "Entrar com chave de
-- acesso" na entrada, até o texto da Política sobre as chaves ser aprovado pelo dono (docs/juridico/README.md, a linha
-- da W9, parte 9a). O que já existir continua valendo (o segundo fator, as confirmações, tirar e renomear): desligar
-- não tranca ninguém do lado de fora.
-- Ligar: por empresa, pelo `ligar-flag` (o cadastro e o uso para quem é dela); para todos, uma regra do ambiente (a
-- entrada sem senha só aparece com ela, porque ninguém entrou ainda).
-- Idempotente; uma transação por arquivo (ADR-018). Sem tabela nova e sem coluna nova.

-- A semente grava em tabela com RLS forçada (V20).
select set_config('app.scope', 'sistema', true);

insert into liame.feature_flag (key, kind, default_value, description, owner, is_write)
values ('chaves_de_acesso', 'boolean', 'false', 'As chaves de acesso (passkeys, P28): criar uma chave em Segurança da conta e "Entrar com chave de acesso" na entrada. Desligada até o texto da Política sobre as chaves; o que já existe continua valendo', 'acesso', false)
on conflict (key) do nothing;

do $$
begin
  if not exists (select 1 from liame.feature_flag where key = 'chaves_de_acesso' and default_value = 'false'::jsonb) then
    raise exception '0109: a flag chaves_de_acesso não nasceu desligada';
  end if;
end $$;
