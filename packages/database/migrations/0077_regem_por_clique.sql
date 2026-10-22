-- 0077 · Hub DMS (F3, parte C, PR 4): conectar o Regem por clique.
-- O presidente da empresa no Regem autoriza o Liame numa página de lá, confirmando com a senha do Regem (decisões C-1 a
-- C-5 do dono, 21/10/2026; Regem #706 e #708). O Liame registra o pedido antes (pedido empurrado, RFC 9126), com o
-- token do DMS ID do aplicativo dele, e leva a pessoa à página só com o número do pedido; na volta, confere o `iss`
-- (RFC 9207); o worker troca o código por uma ligação por loja (a credencial `regem_ligacao`, no cofre). O Regem segue
-- com a autorização de 01/10 (C1b: código e PKCE com o segredo de cliente do Liame), que volta ao mesmo endereço: a
-- conexão guarda por qual das duas começou, para a volta e a troca seguirem a mesma.
-- - a flag `regem_por_clique`, por empresa, desligada: com ela, "Conectar Regem" vai pela autorização por clique. Não é
--   de escrita: criar cupom continua pela flag `regem_write` e pela aprovação do Action Service.
-- - `oauth_connection.authorization_flow`: `clique` na conexão que começou pela autorização por clique; nula nas outras
--   (as de antes desta coluna, a do Regem de 01/10 e as das outras plataformas).
-- Idempotente; uma transação por arquivo (ADR-018). Sem instrução destrutiva (V52).

alter table liame.oauth_connection add column if not exists authorization_flow text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'oauth_connection_authorization_flow_check' and conrelid = 'liame.oauth_connection'::regclass) then
    alter table liame.oauth_connection add constraint oauth_connection_authorization_flow_check
      check (authorization_flow is null or authorization_flow = 'clique');
  end if;
end $$;

-- A semente em tabela com RLS forçada pede o escopo de sistema (V20).
select set_config('app.scope', 'sistema', true);

insert into liame.feature_flag (key, kind, default_value, description, owner, is_write)
values ('regem_por_clique', 'boolean', 'false', 'Hub DMS (F3, parte C): conectar o Regem por clique, com o presidente confirmando com a senha numa página do Regem (pedido empurrado e iss; uma ligação por loja). Da distribuição', 'hub_dms', false)
on conflict (key) do nothing;
