-- 0115 · Os Termos novos ligados para todos (A7, W14; P35; D-A7-97 e D-A7-100).
-- O dono aprovou o texto da Política sobre o aceite (#434, 03/11/2026), escolheu a data de 07/12/2026 e aprovou a lista
-- "O que muda" (04/11/2026). Os três textos da versão foram publicados no site em endereços próprios
-- (agencialiame.com/termos/2026-12-07/, /privacidade/2026-12-07/ e /operador/2026-12-07/), e a distribuição declarou a
-- versão "2026-12-07" pelo comando, com a impressão digital de cada página (04/11/2026, 04h30 de Brasília).
-- A regra do ambiente de produção liga a função `termos_novos` para todas as empresas: o worker manda o e-mail do aviso a
-- cada pessoa, a faixa aparece no alto das telas por 30 dias (âmbar nos últimos 7), o cadastro e o convite citam também a
-- versão nova, e, em 07/12/2026, quem não aceitou vê a tela do aceite antes das outras.
-- Desligar de novo: apagar esta regra; o servidor volta a seguir a versão do ambiente (TERMS_VERSION), e os aceites dados
-- ficam guardados.
-- Idempotente; uma transação por arquivo (ADR-018). Sem tabela nova e sem coluna nova.

-- A regra grava em tabela com RLS forçada (V20).
select set_config('app.scope', 'sistema', true);

insert into liame.feature_flag_rule (id, flag_key, scope_type, scope_id, value, created_by)
values (gen_random_uuid(), 'termos_novos', 'environment', 'production', 'true'::jsonb, 'migration 0115 (decisão do dono em 04/11/2026)')
on conflict (flag_key, scope_type, scope_id) do update set value = excluded.value;

do $$
begin
  if not exists (
    select 1 from liame.feature_flag_rule
    where flag_key = 'termos_novos' and scope_type = 'environment' and scope_id = 'production' and value = 'true'::jsonb
  ) then
    raise exception '0115: a regra do ambiente dos Termos novos não ficou ligada';
  end if;
end $$;
