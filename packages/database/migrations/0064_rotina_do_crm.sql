-- 0064 · A rotina do funcionário de CRM e mensageria: quando ele olha cada marca (A5, Y6; `plano-a5.md` D-A5-14;
-- protótipo P16). Ele propõe uma mensagem quando há motivo: uma oferta de Minha marca para divulgar (a promoção) ou
-- clientes que pararam de pedir (o "volte a pedir"). Para saber se há motivo, a rotina olha a marca: as chaves, o
-- desconto padrão, as ofertas e, no RegemCast, quantas pessoas há no público e o teto de gasto de mensagens.
-- Esta tabela é a fila desse olhar: uma linha por marca e por tipo de mensagem, com quando ele olha de novo, quando
-- olhou por último e o que decidiu, em código (`proposta_aberta`, `sem_oferta`, `sem_publico`, `intervalo`…).
-- Por que uma tabela: na maior parte das vezes ele olha e não propõe. Sem um registro dessa olhada, a marca que não
-- tem o que propor voltaria ao lote a cada volta do worker, chamando o RegemCast sem parar e tirando a vez das outras.
-- Nenhum dado de cliente e nenhum texto: só a marca, o tipo de mensagem, as horas e um código.
-- Nada usa esta tabela enquanto a flag `crm` estiver desligada.
-- Idempotente; uma transação por arquivo (ADR-018).

create table if not exists liame.message_routine (
  id             uuid primary key,
  tenant_id      uuid not null references liame.organization (id) on delete cascade,
  brand_id       uuid not null references liame.brand (id) on delete cascade,
  -- O tipo de mensagem (D-A5-14): os mesmos da proposta (`message_proposal.motive`).
  motive         text not null check (motive in ('promocao', 'volte_a_pedir')),
  -- Quando ele olha esta marca de novo. A reserva do worker empurra para a frente antes de olhar: se o worker cair
  -- no meio, a linha volta sozinha.
  next_check_at  timestamptz not null default now(),
  -- A última vez em que ele olhou e o que decidiu: o código, nunca um texto.
  checked_at     timestamptz,
  outcome        text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint message_routine_uma_por_motivo unique (brand_id, motive),
  constraint message_routine_resultado check (outcome ~ '^[a-z_]{2,40}$'),
  -- Quem olhou diz o que decidiu, e só quem olhou.
  constraint message_routine_olhada check ((checked_at is null) = (outcome is null))
);
-- A fila: as linhas devidas, da mais atrasada para a mais nova.
create index if not exists idx_message_routine_devidas on liame.message_routine (next_check_at, id);
create index if not exists idx_message_routine_tenant on liame.message_routine (tenant_id);

-- ------------------------------------------------------------ RLS e grants

alter table liame.message_routine enable row level security;
alter table liame.message_routine force row level security;
drop policy if exists message_routine_isolamento on liame.message_routine;
create policy message_routine_isolamento on liame.message_routine
  using (tenant_id = liame.current_tenant_id() or liame.system_scope())
  with check (tenant_id = liame.current_tenant_id() or liame.system_scope());
grant select, insert, update on liame.message_routine to liame_app;
