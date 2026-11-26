-- 0170 · Os passos do horário do ritmo da semana (plano da região, R7, parte 2b; D-RG-61 e D-RG-104). Com a janela
-- aprovada no pedido da semana (parte 2a, 0168), o Liame liga a campanha (ou o conjunto) da Meta no começo da janela dos
-- pedidos da loja e pausa no fim, todos os dias; no fim da semana, quando alguém para o ritmo ou quando a função do
-- horário é desligada, deixa ligado o dia todo. Cada um é um passo do ritmo, com o pedido de ação que o executou, como os
-- da verba: uma tentativa por momento (o ligar e o pausar de cada janela, o soltar de cada dia).
-- (1) `budget_rhythm_step.kind` aceita `ligar`, `pausar` e `soltar`, além de `ritmo` e `volta`. Nos passos de situação
--     a verba não muda: `target_micros` e `expected_micros` guardam a verba que o Liame deixou.
-- Das empresas. Idempotente; uma transação por arquivo (ADR-018).

-- ------------------------------------------------------------ (1) os tipos do passo

alter table liame.budget_rhythm_step drop constraint if exists budget_rhythm_step_tipo;
alter table liame.budget_rhythm_step add constraint budget_rhythm_step_tipo check (kind in ('ritmo', 'volta', 'ligar', 'pausar', 'soltar'));

-- ------------------------------------------------------------ conferência

do $$ begin
  if not exists (select 1 from pg_constraint
                  where conname = 'budget_rhythm_step_tipo' and conrelid = 'liame.budget_rhythm_step'::regclass
                    and pg_get_constraintdef(oid) like '%soltar%') then
    raise exception '0170: os tipos novos do passo do ritmo não entraram';
  end if;
end $$;
