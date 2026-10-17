-- 0074 · Hub DMS (F2, A3, parte 2): comparar as duas credenciais do RegemCast.
-- A leitura de hoje usa o token de integração da conta (`rct_it_`); a nova, o token do DMS ID do aplicativo do Liame
-- com o segredo da ligação (cabeçalho `DMS-Ligacao`), que o RegemCast entrega em troca do `rct_it_` (decisão F2-3). A
-- rotina `comparacao-dms-id` do worker chama as 10 ferramentas de leitura pelas duas vias, uma logo depois da outra, e
-- guarda se o resultado foi igual, só com o caminho dos campos que diferem (nunca o valor: a lista de conversas traz
-- telefone). A via nova só passa a valer com 14 dias seguidos sem diferença e 50 comparações ou mais por ferramenta
-- (F2-7).
-- - a flag `comparacao_dms_id`, por empresa, desligada; não é de escrita (nada muda no RegemCast);
-- - `connected_account.ligacao_secret_id`: o segredo da ligação, no cofre (como o `inbox_secret_id` da 0023);
-- - `credential_comparison_state`: a vez de cada conta na rotina (e a reserva), fora do `sync_state`, que a tela de
--   frescor mostra inteiro: a comparação é da distribuição e não aparece para a pessoa;
-- - `credential_comparison`: cada comparação, 90 dias.
-- Idempotente; uma transação por arquivo (ADR-018). Sem instrução destrutiva: as políticas nascem só quando faltam (V52).

-- A semente e as tabelas com RLS forçada pedem o escopo de sistema (V20).
select set_config('app.scope', 'sistema', true);

insert into liame.feature_flag (key, kind, default_value, description, owner, is_write)
values ('comparacao_dms_id', 'boolean', 'false', 'Hub DMS (F2, A3): a rotina compara as 10 leituras do RegemCast pela credencial de hoje e pela do DMS ID com a ligação, e guarda se deu igual (só o caminho do que difere). Só leitura; da distribuição', 'hub_dms', false)
on conflict (key) do nothing;

-- O segredo da ligação de cada conta do RegemCast. Revogar o segredo (desligar a conta, trocar a credencial) o tira de uso.
alter table liame.connected_account add column if not exists ligacao_secret_id uuid references liame.secret (id) on delete set null;

-- A vez de cada conta na rotina: a reserva (SKIP LOCKED na mesma linha) empurra `next_at`; o fim da comparação grava a
-- próxima vez e o último erro (texto do Liame, sem dado da plataforma).
create table if not exists liame.credential_comparison_state (
  connected_account_id  uuid primary key references liame.connected_account (id) on delete cascade,
  tenant_id             uuid not null references liame.organization (id) on delete cascade,
  next_at               timestamptz not null default now(),
  last_at               timestamptz,
  last_error            text constraint credential_comparison_state_erro_curto check (last_error is null or length(last_error) <= 300),
  updated_at            timestamptz not null default now()
);
create index if not exists idx_credential_comparison_state_vez on liame.credential_comparison_state (next_at, connected_account_id);

alter table liame.credential_comparison_state enable row level security;
alter table liame.credential_comparison_state force row level security;
do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'liame' and tablename = 'credential_comparison_state' and policyname = 'credential_comparison_state_isolamento') then
    create policy credential_comparison_state_isolamento on liame.credential_comparison_state
      using (tenant_id = liame.current_tenant_id() or liame.system_scope())
      with check (tenant_id = liame.current_tenant_id() or liame.system_scope());
  end if;
end $$;
grant select, insert, update on liame.credential_comparison_state to liame_app;

-- Cada comparação de uma ferramenta: como terminou, o caminho do que difere (até 20, sem valor), se repetiu e o motivo
-- da falha (o tipo e o nome do problema, nunca o corpo da resposta).
create table if not exists liame.credential_comparison (
  id                    uuid primary key,
  tenant_id             uuid not null references liame.organization (id) on delete cascade,
  connected_account_id  uuid not null references liame.connected_account (id) on delete cascade,
  tool                  text not null constraint credential_comparison_ferramenta check (tool ~ '^[a-z_]{3,64}$'),
  outcome               text not null constraint credential_comparison_desfecho check (outcome in ('igual', 'diferente', 'sem_dado', 'atual_falhou', 'nova_falhou')),
  differences           jsonb not null default '[]'::jsonb
                        constraint credential_comparison_caminhos check (jsonb_typeof(differences) = 'array' and jsonb_array_length(differences) <= 20),
  retried               boolean not null default false,
  failure               text constraint credential_comparison_falha_curta check (failure is null or length(failure) <= 200),
  duration_ms           integer constraint credential_comparison_duracao check (duration_ms is null or duration_ms >= 0),
  compared_at           timestamptz not null default now()
);
create index if not exists idx_credential_comparison_ferramenta on liame.credential_comparison (tool, compared_at desc);
create index if not exists idx_credential_comparison_conta on liame.credential_comparison (tenant_id, connected_account_id, compared_at desc);

alter table liame.credential_comparison enable row level security;
alter table liame.credential_comparison force row level security;
do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'liame' and tablename = 'credential_comparison' and policyname = 'credential_comparison_isolamento') then
    create policy credential_comparison_isolamento on liame.credential_comparison
      using (tenant_id = liame.current_tenant_id() or liame.system_scope())
      with check (tenant_id = liame.current_tenant_id() or liame.system_scope());
  end if;
  -- Só o expurgo (90 dias) apaga.
  if not exists (select 1 from pg_policies where schemaname = 'liame' and tablename = 'credential_comparison' and policyname = 'credential_comparison_apaga_so_sistema') then
    create policy credential_comparison_apaga_so_sistema on liame.credential_comparison as restrictive for delete using (liame.system_scope());
  end if;
end $$;
grant select, insert, delete on liame.credential_comparison to liame_app;

comment on table liame.credential_comparison is
  'Hub DMS (F2, A3): cada comparação das leituras do RegemCast pela credencial de hoje (rct_it_) e pela do DMS ID com a ligação. Só o caminho do que difere, nunca o valor. Da distribuição; 90 dias.';
comment on column liame.connected_account.ligacao_secret_id is
  'O segredo da ligação do Hub DMS desta conta do RegemCast, no cofre (troca automática do rct_it_, decisão F2-3).';
