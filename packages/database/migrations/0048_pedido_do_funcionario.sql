-- 0048 · O pedido feito por um funcionário de IA (A4, X3 parte 2; `plano-a4.md` §3 e a proposta D-A4-26).
-- No modo Aprovação, a recomendação do Gestor de tráfego vira um pedido de ação na rodada da manhã, feito por ele. O
-- pedido espera a aprovação de uma pessoa com o código do app, como qualquer outro, e os limites da empresa valem
-- para ele. Aqui ficam: quem pediu quando não foi uma pessoa (a chave do funcionário), a tentativa de pedir de cada
-- recomendação (uma só: o que não deu fica com o motivo, e ele não tenta de novo sozinho) e a flag que liga o modo.
-- Com a flag `modo_aprovacao` desligada (como nasce), nada disto é usado. Idempotente; uma transação por arquivo
-- (ADR-018).

-- A semente da flag grava em tabela com RLS forçada (V20).
select set_config('app.scope', 'sistema', true);

-- ------------------------------------------------------------ quem pediu

-- `actor_type` já existe desde a 0011 (até aqui, sempre `human`). No pedido de um funcionário de IA ele vale `agent`,
-- e esta coluna guarda qual funcionário (a chave dele em Sua equipe: `trafego`). `requested_by` continua sendo uma
-- pessoa: a que deixou o funcionário pedir (quem publicou a regra do modo Aprovação na política).
alter table liame.action_request add column if not exists agent_key text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'action_request_agent_key_check' and conrelid = 'liame.action_request'::regclass) then
    alter table liame.action_request add constraint action_request_agent_key_check
      check (agent_key is null or agent_key ~ '^[a-z][a-z0-9_]{1,40}$');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'action_request_agente_check' and conrelid = 'liame.action_request'::regclass) then
    -- O funcionário só aparece no pedido que ele fez, e o pedido dele sempre diz qual funcionário.
    alter table liame.action_request add constraint action_request_agente_check
      check ((actor_type = 'agent') = (agent_key is not null));
  end if;
end $$;

-- ------------------------------------------------------------ a tentativa de pedir

-- Uma tentativa por recomendação. Deu certo: o pedido aponta para a recomendação (`action_request.shadow_decision_id`,
-- 0047) e o erro fica nulo. Não deu: o código e o motivo, em palavras, para a Atenção mostrar por que ele não pediu.
alter table liame.shadow_decision add column if not exists request_attempted_at timestamptz;
alter table liame.shadow_decision add column if not exists request_error text;
alter table liame.shadow_decision add column if not exists request_error_detail text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'shadow_decision_request_error_check' and conrelid = 'liame.shadow_decision'::regclass) then
    alter table liame.shadow_decision add constraint shadow_decision_request_error_check
      check (request_error is null or request_error ~ '^[a-z][a-z0-9-]{1,60}$');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'shadow_decision_request_error_detail_check' and conrelid = 'liame.shadow_decision'::regclass) then
    alter table liame.shadow_decision add constraint shadow_decision_request_error_detail_check
      check (request_error_detail is null or length(request_error_detail) between 3 and 300);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'shadow_decision_tentativa_check' and conrelid = 'liame.shadow_decision'::regclass) then
    -- O erro só existe com a tentativa, e os dois campos do erro andam juntos.
    alter table liame.shadow_decision add constraint shadow_decision_tentativa_check
      check ((request_error is null or request_attempted_at is not null) and ((request_error is null) = (request_error_detail is null)));
  end if;
end $$;

-- ------------------------------------------------------------ a flag do modo

-- Liga, por empresa, o modo Aprovação do Gestor de tráfego: ele faz o pedido, e o sistema propõe a passagem de
-- Sugerir para Aprovação. Nasce desligada. Não escreve em plataforma nenhuma: o pedido espera uma pessoa, e a
-- escrita tem a flag dela (`meta_write`).
insert into liame.feature_flag (key, kind, default_value, description, owner, is_write)
values ('modo_aprovacao', 'boolean', 'false', 'Modo Aprovação do Gestor de tráfego: ele mesmo faz o pedido de mudança, que espera a aprovação de uma pessoa, e o sistema propõe a passagem de Sugerir para Aprovação (A4, X3)', 'midia', false)
on conflict (key) do nothing;
