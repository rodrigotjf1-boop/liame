-- 0111 · Os Termos novos: as versões e os aceites (A7, W14, parte 14a; P35, aprovado em 02/11/2026; D-A7-88 a D-A7-95;
-- D-A7-97 a D-A7-100). A distribuição declara cada versão nova dos Termos de Uso, da Política de Privacidade e do
-- Contrato de operador por um comando (`termos-novos`), com o dia em que vale, o endereço e a impressão digital (SHA-256)
-- de cada texto publicado e o que muda em linguagem simples; cada pessoa aceita a versão relevante com um clique, e o
-- aceite fica guardado. A função `termos_novos` nasce desligada para todos: desligada, o servidor ignora estas tabelas
-- (a versão vigente segue a do ambiente, `TERMS_VERSION`), até o texto da Política sobre o aceite ser aprovado.
-- Idempotente; uma transação por arquivo (ADR-018).

-- A versão dos Termos (da distribuição; sem empresa). `relevante` passa pelo aviso de 30 dias e pelo aceite de cada
-- pessoa; `redacao` vale na hora, sem aviso e sem aceite, e fica no histórico com o motivo (D-A7-89).
create table if not exists liame.terms_version (
  -- O dia em que vale (AAAA-MM-DD), com um sufixo curto quando há mais de uma no mesmo dia.
  version          text primary key check (version ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}(-[a-z0-9]{1,10})?$'),
  kind             text not null check (kind in ('relevante', 'redacao')),
  notice_at        timestamptz not null default now(),
  -- O começo do dia em que vale, no fuso de Brasília.
  effective_at     timestamptz not null,
  -- Os textos: [{ "document": "termos" | "privacidade" | "operador", "url": "https://…", "sha256": "…" }].
  documents        jsonb not null,
  -- O que muda: [{ "document", "section", "title", "today", "becomes" }] (uma linha por mudança; D-A7-88, D-A7-91).
  changes          jsonb not null default '[]'::jsonb,
  -- O motivo do ajuste de redação.
  reason           text,
  created_by       text not null check (length(created_by) between 1 and 120),
  created_at       timestamptz not null default now(),
  withdrawn_at     timestamptz,
  withdrawn_by     text check (withdrawn_by is null or length(withdrawn_by) between 1 and 120),
  withdrawn_reason text check (withdrawn_reason is null or length(withdrawn_reason) between 3 and 300),
  constraint terms_version_documentos check (jsonb_typeof(documents) = 'array' and jsonb_array_length(documents) between 1 and 3),
  constraint terms_version_mudancas check (
    jsonb_typeof(changes) = 'array' and (kind = 'redacao' or jsonb_array_length(changes) between 1 and 30)),
  constraint terms_version_motivo check (kind = 'relevante' or (reason is not null and length(reason) between 3 and 300)),
  -- O aviso de 30 dias, em dias do calendário de Brasília (Termos 15; D-A7-88).
  constraint terms_version_aviso check (
    kind = 'redacao'
    or (effective_at at time zone 'America/Sao_Paulo')::date >= (notice_at at time zone 'America/Sao_Paulo')::date + 30),
  constraint terms_version_retirada check ((withdrawn_at is null) = (withdrawn_by is null))
);
create index if not exists idx_terms_version_vale on liame.terms_version (effective_at desc) where withdrawn_at is null;

-- Da distribuição: o aplicativo só lê, no escopo de sistema; quem grava é o comando, com o papel dono do banco.
alter table liame.terms_version enable row level security;
alter table liame.terms_version force row level security;
drop policy if exists terms_version_sistema on liame.terms_version;
create policy terms_version_sistema on liame.terms_version using (liame.system_scope()) with check (liame.system_scope());
grant select on liame.terms_version to liame_app;

-- O aceite de cada pessoa a uma versão relevante (D-A7-92): onde ela aceitou e o aparelho, como a sessão mostra; sem o
-- IP. O aceite do Dono vale também pela empresa (o contrato é dela); a auditoria encadeada guarda o mesmo evento.
create table if not exists liame.terms_acceptance (
  user_id      uuid not null references liame.app_user (id) on delete cascade,
  version      text not null references liame.terms_version (version),
  accepted_at  timestamptz not null default now(),
  via          text not null check (via in ('aviso', 'tela_do_dia', 'cadastro', 'convite')),
  device       text check (device is null or length(device) between 1 and 80),
  primary key (user_id, version)
);
create index if not exists idx_terms_acceptance_versao on liame.terms_acceptance (version);

alter table liame.terms_acceptance enable row level security;
alter table liame.terms_acceptance force row level security;
drop policy if exists terms_acceptance_propria on liame.terms_acceptance;
create policy terms_acceptance_propria on liame.terms_acceptance
  using (user_id = liame.current_user_id() or liame.system_scope())
  with check (user_id = liame.current_user_id() or liame.system_scope());
grant select, insert on liame.terms_acceptance to liame_app;

-- A função, desligada (V20: a semente grava em tabela com RLS forçada).
select set_config('app.scope', 'sistema', true);
insert into liame.feature_flag (key, kind, default_value, description, owner, is_write)
values ('termos_novos', 'boolean', 'false', 'Os Termos novos (W14, P35): a versão declarada pela distribuição, o aviso de 30 dias, o aceite de cada pessoa e, no dia, a tela do aceite. Desligada, o servidor ignora as versões e segue a do ambiente (TERMS_VERSION). Desligada até o texto da Política sobre o aceite', 'acesso', false)
on conflict (key) do nothing;

-- Conferência no mesmo arquivo (ADR-018).
do $$
begin
  if (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'liame' and c.relname in ('terms_version', 'terms_acceptance')
         and c.relrowsecurity and c.relforcerowsecurity) <> 2 then
    raise exception '0111: as tabelas dos Termos sem a RLS forçada';
  end if;
  if not exists (select 1 from liame.feature_flag where key = 'termos_novos' and default_value = 'false'::jsonb) then
    raise exception '0111: a função termos_novos não nasceu desligada';
  end if;
end $$;
