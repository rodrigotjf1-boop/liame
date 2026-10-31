-- 0094 · A cobrança, W3, parte 1: a parada pela cobrança (A7; `plano-a7.md` D-A7-6, D-A7-22 e D-A7-38; Termos 10.4).
-- No 10º dia de atraso da mensalidade de uma marca, as ações dos funcionários de IA dela param: é a parada que já existe,
-- no nível da marca, acionada pela rotina da cobrança (sem pessoa), com a assinatura que a causou. A leitura e as telas
-- continuam, e nada de anúncio é pausado pelo Liame. Pagou (ou a assinatura terminou), a parada sai sozinha, na hora.
-- Uma pessoa não desliga a parada da cobrança: quem tira é o pagamento. Uma por assinatura de cada vez (o índice único
-- segura a segunda volta da rotina e o pagamento que chega junto). Nada usa esta coluna enquanto a função `cobranca`
-- estiver desligada. Idempotente; uma transação por arquivo (ADR-018).

alter table liame.kill_switch add column if not exists subscription_id uuid references liame.subscription (id) on delete cascade;

-- A parada da cobrança é sempre da marca da assinatura, acionada pela rotina (sem pessoa).
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'kill_switch_da_cobranca' and conrelid = 'liame.kill_switch'::regclass) then
    alter table liame.kill_switch
      add constraint kill_switch_da_cobranca check (subscription_id is null or (level = 'brand' and activated_by is null));
  end if;
end
$$;

-- Uma parada da cobrança viva por assinatura.
create unique index if not exists uq_kill_switch_cobranca on liame.kill_switch (subscription_id)
  where subscription_id is not null and deactivated_at is null;
