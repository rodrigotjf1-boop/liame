-- 0042 · A chamada que respondeu (A3; Sua equipe, protótipo P7).
-- Um pedido à IA com leituras faz várias chamadas ao modelo, uma por rodada, e cada uma vira uma linha de `ai_usage`
-- com `outcome = 'ok'`. Sua equipe contava essas linhas como respostas: uma resposta com uma leitura virava duas. A
-- linha da chamada que entregou a resposta do pedido passa a dizer isso (`answered`); o custo e as chamadas seguem
-- contando todas as linhas.
-- Idempotente; uma transação por arquivo (ADR-018).

-- A RLS de `ai_usage` é forçada (vale até para o dono das tabelas): o acerto das linhas de antes roda no escopo de
-- sistema, só nesta transação.
select set_config('app.scope', 'sistema', true);

alter table liame.ai_usage add column if not exists answered boolean not null default false;

-- Só uma chamada atendida por um modelo responde.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'ai_usage_answered_check' and conrelid = 'liame.ai_usage'::regclass) then
    alter table liame.ai_usage add constraint ai_usage_answered_check check (not answered or (outcome = 'ok' and model is not null));
  end if;
end $$;

-- As linhas de antes: a chamada atendida em que o modelo não pediu ferramenta é a que respondeu.
update liame.ai_usage set answered = true where not answered and outcome = 'ok' and model is not null and tool_calls = 0;
