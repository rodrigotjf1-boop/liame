-- 0166 · A conferência do ritmo gravada pela rotina (plano da região, R7; D-RG-75, "antes de ligar além do piloto").
-- Os avisos do ritmo da semana (a campanha que saiu do ritmo, a que não voltou à verba de antes e a que gastou mais do que
-- o ritmo permite) saíam calculados a cada leitura da Atenção, com um laço por marca e conta e leituras do gasto a cada
-- abertura de tela (e o número do menu passa pela Atenção). Agora a rotina do worker os calcula depois da leitura da manhã
-- de cada conta e grava o resultado do dia, refazendo a linha quando uma entrada muda (o ritmo, um passo, uma leitura
-- nova da conta); a Atenção só lê a gravada, a mais nova de cada ritmo dentro da janela dele (a conta que não foi lida
-- não cala o aviso de dinheiro, D-RG-94).
-- (1) `budget_rhythm_check`: uma linha por ritmo e dia, com os avisos (as contas puras de `campanhas/ritmo-avisos.ts`).
-- (2) O índice por marca em `budget_rhythm`, que serve aos parados e encerrados (o único de hoje é parcial).
-- Das empresas. Idempotente; uma transação por arquivo (ADR-018).

-- ------------------------------------------------------------ (1) a conferência do dia

create table if not exists liame.budget_rhythm_check (
  id           uuid primary key,
  tenant_id    uuid not null references liame.organization (id) on delete cascade,
  rhythm_id    uuid not null references liame.budget_rhythm (id) on delete cascade,
  brand_id     uuid not null references liame.brand (id) on delete cascade,
  -- O dia da conferência, no fuso da loja do ritmo.
  checked_on   date not null,
  -- Os avisos do ritmo nesse dia: `[{ "conta", "campanha", "aviso" }]`, com os valores em dinheiro como texto (micros).
  warnings     jsonb not null default '[]'::jsonb,
  -- Quando a rotina calculou (refeita quando uma entrada muda depois disso) ou, com `error`, quando tentou.
  computed_at  timestamptz not null default clock_timestamp(),
  -- A conta que falhou nesta tentativa (os avisos ficam os da conferência de antes, para o aviso de dinheiro não sumir);
  -- a rotina tenta de novo depois de uma hora, sem passar na frente de quem nunca foi conferido (V84). Nulo quando calculou.
  error        text,
  created_at   timestamptz not null default clock_timestamp(),
  constraint budget_rhythm_check_avisos check (jsonb_typeof(warnings) = 'array'),
  constraint budget_rhythm_check_erro check (coalesce(char_length(error), 0) <= 500),
  constraint budget_rhythm_check_um_por_dia unique (rhythm_id, checked_on)
);
create index if not exists idx_budget_rhythm_check_tenant on liame.budget_rhythm_check (tenant_id);
create index if not exists idx_budget_rhythm_check_marca on liame.budget_rhythm_check (brand_id, checked_on desc);

alter table liame.budget_rhythm_check enable row level security;
alter table liame.budget_rhythm_check force row level security;
drop policy if exists budget_rhythm_check_isolamento on liame.budget_rhythm_check;
create policy budget_rhythm_check_isolamento on liame.budget_rhythm_check
  using (tenant_id = liame.current_tenant_id() or liame.system_scope())
  with check (tenant_id = liame.current_tenant_id() or liame.system_scope());
grant select, insert, update on liame.budget_rhythm_check to liame_app;

-- ------------------------------------------------------------ (2) o índice por marca

create index if not exists idx_budget_rhythm_marca on liame.budget_rhythm (brand_id, week_start);
