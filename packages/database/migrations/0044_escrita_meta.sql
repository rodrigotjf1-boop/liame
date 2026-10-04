-- 0044 · Escrita na Meta (A4, X1): as capacidades no registro e a espera da execução.
-- (1) Capability Registry: ler o estado de um objeto de anúncio (situação e verba diária) logo antes de escrever, e
--     mudar a situação e a verba. A versão da API é dado. A escrita só acontece pelo Action Service, depois da
--     aprovação de uma pessoa, com a flag `meta_write` (0009; nasce desligada) e com `validate_only` antes.
-- (2) Quando a plataforma pede para esperar (limite de uso, fora do ar), a ação aprovada volta para a fila com a hora
--     da próxima tentativa, em vez de insistir: `next_attempt_at` e `attempts` no pedido. A tentativa adiada fica
--     registrada em `action_execution`, com a situação `adiada` e o motivo.
-- (3) O Vigia de integrações (0020) passa a acompanhar a página oficial dos limites de uso da Marketing API: os
--     códigos de erro que fazem a execução esperar vêm dela.
-- Idempotente; uma transação por arquivo (ADR-018).

-- As sementes gravam em tabelas com RLS forçada (V20).
select set_config('app.scope', 'sistema', true);

-- ------------------------------------------------------------ Capability Registry

-- Conferido nas páginas oficiais em 04/10/2026 (base de conhecimento §2.1): `POST /{id}` com `status` e, na campanha
-- e no conjunto, `daily_budget` na menor unidade da moeda; `execution_options=["validate_only"]` não faz a mudança.
insert into liame.connector_capability (provider, capability, api_version, read, write, required_scope, access_level, sunset_at, source_url, verified_at, notes) values
  ('meta_ads', 'entity_state', 'v26.0', true, false, '{ads_read}', 'Standard (testadores) ou Advanced', null, 'https://developers.facebook.com/docs/marketing-api/reference/ad-campaign-group', '2026-10-04', 'situação e verba diária de uma campanha, conjunto ou anúncio, lidas logo antes de escrever'),
  ('meta_ads', 'entity_update', 'v26.0', false, true, '{ads_management}', 'Standard (testadores) ou Advanced', null, 'https://developers.facebook.com/docs/marketing-api/reference/ad-campaign-group', '2026-10-04', 'ativar, pausar e mudar a verba diária; só pelo Action Service, com a flag meta_write e validate_only antes')
on conflict (provider, capability) do nothing;

-- ------------------------------------------------------------ a espera da execução

alter table liame.action_request add column if not exists next_attempt_at timestamptz;
alter table liame.action_request add column if not exists attempts integer not null default 0;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'action_request_attempts_check' and conrelid = 'liame.action_request'::regclass) then
    alter table liame.action_request add constraint action_request_attempts_check check (attempts >= 0);
  end if;
end $$;

-- A tentativa que a plataforma mandou esperar: nada foi escrito, e a ação volta para a fila.
alter table liame.action_execution drop constraint if exists action_execution_status_check;
alter table liame.action_execution add constraint action_execution_status_check
  check (status in ('executada', 'falhou', 'estado_mudou', 'bloqueada', 'adiada'));

-- ------------------------------------------------------------ Vigia: limites de uso da Marketing API

insert into liame.watch_source (id, provider, kind, title, url) values
  ('0199a400-0000-7000-8000-000000000001', 'meta_ads', 'politica', 'Marketing API: limites de uso', 'https://developers.facebook.com/docs/marketing-api/overview/rate-limiting')
on conflict (url) do nothing;
