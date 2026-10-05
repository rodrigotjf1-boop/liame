-- 0052 · A verba do mês (A4, X4 parte 1; `plano-a4.md` D-A4-19 e D-A4-22). O envelope do mês da empresa
-- (`budget_policy`, 0011) passa a ser o teto de tudo o que as contas conectadas gastam em anúncios no mês, e quem o
-- define é o Dono ou o Administrador, na tela Verba do mês. A tela mostra quem definiu por último, e a linha guardava só
-- quem a criou. Idempotente; uma transação por arquivo (ADR-018).

-- A semente abaixo grava numa tabela com RLS forçada: vale o escopo de sistema, só nesta transação.
select set_config('app.scope', 'sistema', true);

alter table liame.budget_policy add column if not exists updated_by uuid references liame.app_user (id) on delete set null;

-- Nas linhas que já existem, quem criou foi quem definiu.
update liame.budget_policy set updated_by = created_by where updated_by is null;
