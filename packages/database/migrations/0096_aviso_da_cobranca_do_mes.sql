-- 0096 · A cobrança do mês por e-mail, com o PIX (A7; `plano-a7.md` D-A7-17 e D-A7-44).
-- Quem escolheu o PIX recebe a cobrança de cada mês por e-mail, com o código do PIX (copia e cola), quando a fatura do
-- período seguinte já tem a cobrança no Asaas, até 5 dias antes do vencimento. A entrega é guardada na mesma tabela dos
-- avisos do atraso (`billing_notice`, migration 0095), com o dia 0: "antes do vencimento". Uma por fatura, dia e pessoa,
-- como os outros avisos; sem o endereço nem o texto. Nada usa o dia 0 enquanto a função `cobranca` estiver desligada.
-- Idempotente; uma transação por arquivo (ADR-018).

do $$
begin
  if exists (
    select 1 from pg_constraint
     where conrelid = 'liame.billing_notice'::regclass and conname = 'billing_notice_day_check'
       -- A regra antiga é "ARRAY[1, 7, 10, 30]"; a nova começa por "[0, ": rodar de novo não troca nada.
       and pg_get_constraintdef(oid) not like '%[0,%'
  ) then
    alter table liame.billing_notice drop constraint billing_notice_day_check;
  end if;
  if not exists (
    select 1 from pg_constraint where conrelid = 'liame.billing_notice'::regclass and conname = 'billing_notice_day_check'
  ) then
    alter table liame.billing_notice add constraint billing_notice_day_check check (day in (0, 1, 7, 10, 30));
  end if;
end $$;

comment on column liame.billing_notice.day is
  'O dia do aviso: 0 = a cobrança do mês, antes do vencimento (D-A7-44); 1, 7, 10 e 30 = os dias de atraso (D-A7-39).';
