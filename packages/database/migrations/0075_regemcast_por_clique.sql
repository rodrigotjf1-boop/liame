-- 0075 · Hub DMS (F2, parte B, B1): conectar o RegemCast por clique.
-- O dono da conta do RegemCast autoriza o Liame numa página de lá, confirmando com a senha (decisões B1-1 a B1-9 do
-- Hub DMS, 20/10/2026). O Liame registra o pedido antes (pedido empurrado, RFC 9126), com o token do DMS ID do
-- aplicativo dele, e leva a pessoa à página só com o número do pedido; na volta, confere o `iss` (RFC 9207); o worker
-- troca o código pelo segredo da ligação, que vai para o cofre. A conexão é uma `oauth_connection` como as outras
-- (provider `regemcast`, origem `oauth`): o banco já aceita tudo isso, e só a flag é nova.
-- - a flag `regemcast_por_clique`, por empresa, desligada: com ela, "Contas conectadas" oferece o RegemCast. Não é de
--   escrita: a autorização só libera leituras (a escrita fica para a F5, decisão B1-3).
-- Idempotente; uma transação por arquivo (ADR-018). Sem instrução destrutiva (V52).

-- A semente em tabela com RLS forçada pede o escopo de sistema (V20).
select set_config('app.scope', 'sistema', true);

insert into liame.feature_flag (key, kind, default_value, description, owner, is_write)
values ('regemcast_por_clique', 'boolean', 'false', 'Hub DMS (F2, B1): conectar o RegemCast por clique, com o dono da conta confirmando com a senha numa página do RegemCast (pedido empurrado e iss). Só leituras; da distribuição', 'hub_dms', false)
on conflict (key) do nothing;
