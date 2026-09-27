-- 0020 · Vigia de integrações (A2, G8; ADR-015): fontes oficiais acompanhadas todo dia, trechos que
-- mudaram (por hash) e alertas do calendário de versões (60/30/7 dias antes do fim, na data, D+1 e
-- D+7), dos avisos Deprecation/Sunset vistos nas respostas e das fontes que falharam. Tudo da
-- distribuição (sem tenant): documentação pública e estado técnico. Sem IA na A2 (o resumo por
-- agente entra na A3). Idempotente; uma transação por arquivo (ADR-018).

select set_config('app.scope', 'sistema', true);

-- ------------------------------------------------------------ fontes oficiais

create table if not exists liame.watch_source (
  id                uuid primary key,
  provider          text not null check (provider ~ '^[a-z0-9_]+$'),
  kind              text not null check (kind in ('changelog', 'versoes', 'politica', 'referencia')),
  title             text not null check (length(title) between 1 and 200),
  url               text not null unique check (url ~ '^https://(developers\.facebook\.com|developers\.google\.com|ads-developers\.googleblog\.com)/'),
  active            boolean not null default true,
  last_checked_at   timestamptz,
  last_ok_at        timestamptz,
  last_error        text,
  failures          integer not null default 0 check (failures >= 0),
  created_at        timestamptz not null default now()
);

-- Última leitura de cada fonte: o hash de cada trecho (por título), para comparar com a próxima.
create table if not exists liame.watch_snapshot (
  source_id         uuid primary key references liame.watch_source (id) on delete cascade,
  fetched_at        timestamptz not null,
  content_hash      text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  sections          jsonb not null check (jsonb_typeof(sections) = 'array')
);

-- Trecho que apareceu, mudou ou sumiu: o texto novo vai junto (limitado), para quem revisar.
create table if not exists liame.watch_change (
  id                uuid primary key,
  source_id         uuid not null references liame.watch_source (id) on delete cascade,
  detected_at       timestamptz not null default now(),
  section_title     text not null,
  change            text not null check (change in ('novo', 'alterado', 'removido')),
  old_hash          text,
  new_hash          text,
  excerpt           text check (length(excerpt) <= 4000),
  reviewed_at       timestamptz
);
create index if not exists idx_watch_change_fonte on liame.watch_change (source_id, detected_at desc);

-- Alertas do Vigia: um por (tipo, provider, versão, etapa), para a rotina diária não repetir.
create table if not exists liame.watch_alert (
  id                uuid primary key,
  kind              text not null check (kind in ('versao_expirando', 'versao_expirada', 'depreciacao_vista', 'fonte_mudou', 'fonte_falhou')),
  provider          text not null check (provider ~ '^[a-z0-9_]+$'),
  api_version       text not null default '',
  stage             text not null default '' check (stage ~ '^[a-z0-9_+-]*$'),
  due_date          date,
  message           text not null check (length(message) between 1 and 1000),
  source_url        text,
  created_at        timestamptz not null default now(),
  resolved_at       timestamptz,
  unique (kind, provider, api_version, stage)
);
create index if not exists idx_watch_alert_abertos on liame.watch_alert (created_at desc) where resolved_at is null;

-- ------------------------------------------------------------ RLS (distribuição: leitura para todos, escrita só do sistema)

do $$
declare t text;
begin
  foreach t in array array['watch_source', 'watch_snapshot', 'watch_change', 'watch_alert']
  loop
    execute format('alter table liame.%I enable row level security', t);
    execute format('alter table liame.%I force row level security', t);
    execute format('drop policy if exists %I on liame.%I', t || '_leitura', t);
    execute format('create policy %I on liame.%I for select using (true)', t || '_leitura', t);
    execute format('drop policy if exists %I on liame.%I', t || '_sistema', t);
    execute format('create policy %I on liame.%I using (liame.system_scope()) with check (liame.system_scope())', t || '_sistema', t);
    execute format('grant select, insert, update, delete on liame.%I to liame_app', t);
  end loop;
end $$;

-- ------------------------------------------------------------ fontes iniciais (base de conhecimento §2.1, §3.1, §3.3)

insert into liame.watch_source (id, provider, kind, title, url) values
  ('0192f7a0-0000-7000-8000-000000000001', 'meta_ads', 'changelog', 'Graph API: changelog e versões', 'https://developers.facebook.com/docs/graph-api/changelog'),
  ('0192f7a0-0000-7000-8000-000000000002', 'meta_ads', 'changelog', 'Marketing API: changelog', 'https://developers.facebook.com/docs/marketing-api/marketing-api-changelog'),
  ('0192f7a0-0000-7000-8000-000000000003', 'google_ads', 'changelog', 'Google Ads API: notas de versão', 'https://developers.google.com/google-ads/api/docs/release-notes'),
  ('0192f7a0-0000-7000-8000-000000000004', 'google_ads', 'versoes', 'Google Ads API: descontinuação e fim das versões', 'https://developers.google.com/google-ads/api/docs/sunset-dates'),
  ('0192f7a0-0000-7000-8000-000000000005', 'google_ads', 'politica', 'Google Ads API: developer token', 'https://developers.google.com/google-ads/api/docs/api-policy/developer-token'),
  ('0192f7a0-0000-7000-8000-000000000006', 'ga4', 'changelog', 'GA4 Data API: changelog', 'https://developers.google.com/analytics/devguides/reporting/data/v1/changelog')
on conflict (url) do nothing;
