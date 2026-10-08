-- 0056 · Conversões para o Google: o que a tela precisa a mais (A5, Y1; protótipo P14).
-- (1) Quem parou. O cartão diz "Parado por Fulano em …" sem perder quem escolheu a conversão (`set_by` continua sendo
--     quem escolheu).
-- (2) O tipo da última falha da passagem, ao lado do texto. A tela separa "o Google pediu para esperar" (a conta volta
--     sozinha) de "falta a permissão" (é autorizar o Google de novo) sem adivinhar pelo texto:
--     `esperar` (limite, fora do ar, muitas falhas seguidas), `permissao` (a autorização não vale ou não inclui o
--     envio), `parada` (a parada da empresa ou da Liame) e `outro`.
-- Idempotente; uma transação por arquivo (ADR-018).

alter table liame.conversion_destination add column if not exists stopped_by uuid references liame.app_user (id) on delete set null;
alter table liame.conversion_destination add column if not exists last_error_kind text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'conversion_destination_last_error_kind_check' and conrelid = 'liame.conversion_destination'::regclass) then
    alter table liame.conversion_destination add constraint conversion_destination_last_error_kind_check
      check (last_error_kind in ('esperar', 'permissao', 'parada', 'outro'));
  end if;
  -- O tipo acompanha o texto: os dois existem juntos ou nenhum.
  if not exists (select 1 from pg_constraint where conname = 'conversion_destination_last_error_par_check' and conrelid = 'liame.conversion_destination'::regclass) then
    alter table liame.conversion_destination add constraint conversion_destination_last_error_par_check
      check (last_error_kind is null or last_error is not null);
  end if;
end $$;
