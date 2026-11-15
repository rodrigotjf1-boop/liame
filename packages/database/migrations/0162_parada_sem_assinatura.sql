-- 0162 · O fim da assinatura, parte 4c: a equipe parada sem assinatura paga (A7, W3; `plano-a7.md` D-A7-4, D-A7-6 e
-- D-A7-108; Termos 10.4 e 11.2). Com a cobrança ligada, a marca sem assinatura paga e viva (a que nunca assinou, a que
-- espera o primeiro pagamento, a que terminou) fica com as ações dos funcionários de IA paradas: é a parada que já existe,
-- no nível da marca, acionada sem pessoa, como a do 10º dia de atraso (a 0094). A leitura e as telas continuam, e nada de
-- anúncio é pausado pelo Liame. Uma pessoa não a desliga: quem tira é o primeiro pagamento, na hora, ou a cobrança
-- desligada. Uma viva por marca (o índice único segura duas voltas da rotina e o pagamento que chega junto). Nada usa esta
-- coluna enquanto a função `cobranca` estiver desligada. Idempotente; uma transação por arquivo (ADR-018).

alter table liame.kill_switch add column if not exists no_paid_subscription boolean not null default false;

-- A parada sem assinatura paga é sempre da marca, acionada pela rotina (sem pessoa), e não é a da cobrança do atraso.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'kill_switch_sem_assinatura' and conrelid = 'liame.kill_switch'::regclass) then
    alter table liame.kill_switch
      add constraint kill_switch_sem_assinatura
      check (not no_paid_subscription or (level = 'brand' and brand_id is not null and activated_by is null and subscription_id is null));
  end if;
end
$$;

-- Uma parada sem assinatura viva por marca.
create unique index if not exists uq_kill_switch_sem_assinatura on liame.kill_switch (brand_id)
  where no_paid_subscription and deactivated_at is null;

-- ------------------------------------------------------------ conferência

do $$ begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'liame' and table_name = 'kill_switch' and column_name = 'no_paid_subscription') then
    raise exception '0162: a coluna da parada sem assinatura não entrou';
  end if;
  if not exists (select 1 from pg_constraint where conname = 'kill_switch_sem_assinatura' and conrelid = 'liame.kill_switch'::regclass) then
    raise exception '0162: a regra da parada sem assinatura não entrou';
  end if;
  if not exists (select 1 from pg_indexes where schemaname = 'liame' and indexname = 'uq_kill_switch_sem_assinatura') then
    raise exception '0162: o índice da parada sem assinatura não entrou';
  end if;
end $$;
