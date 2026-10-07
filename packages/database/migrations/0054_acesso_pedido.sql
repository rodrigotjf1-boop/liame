-- 0054 · O que a autorização pediu à plataforma (A4, X8; `plano-a4.md` D-A4-18 e D-A4-20). Na Meta há duas configurações
-- do mesmo login: a de leitura e a de escrita (que também pede para gerenciar anúncios). Quem escolhe é a flag
-- `meta_write` da empresa, na hora de conectar. A conexão passa a guardar qual foi usada, para a tela do pedido de
-- mudança dizer "conecte a Meta de novo" antes de a pessoa preencher um pedido que a Meta recusaria por falta de
-- permissão. Nula = conexão de antes desta coluna (todas pela configuração de leitura) ou plataforma em que essa
-- diferença não existe. É o que foi PEDIDO, não o que a plataforma concedeu: a recusa de verdade continua vindo dela,
-- na validação antes de escrever. Idempotente; uma transação por arquivo (ADR-018).

alter table liame.oauth_connection add column if not exists requested_access text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'oauth_connection_requested_access_check' and conrelid = 'liame.oauth_connection'::regclass) then
    alter table liame.oauth_connection add constraint oauth_connection_requested_access_check
      check (requested_access is null or requested_access in ('leitura', 'escrita'));
  end if;
end $$;
