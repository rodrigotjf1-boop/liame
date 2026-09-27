-- 0019 · Conectar contas (A2, G3; plano-a2 §2): a autorização OAuth de cada plataforma vira uma
-- "conexão" da empresa, com o estado do fluxo, a credencial no cofre e as contas descobertas para a
-- pessoa escolher quais ligar à marca. O código e o verificador PKCE ficam cifrados com a chave da
-- empresa só até a troca; o estado do OAuth fica só como hash. Idempotente; uma transação por arquivo.

select set_config('app.scope', 'sistema', true);

-- ------------------------------------------------------------ conexão (uma autorização OAuth)

create table if not exists liame.oauth_connection (
  id                    uuid primary key,
  tenant_id             uuid not null references liame.organization (id) on delete cascade,
  brand_id              uuid not null references liame.brand (id) on delete cascade,
  -- Quem autoriza: `meta` (Meta Ads) ou `google` (Google Ads e GA4 na mesma autorização).
  provider              text not null check (provider in ('meta', 'google')),
  status                text not null default 'aguardando_autorizacao' check (status in (
                          'aguardando_autorizacao', -- a pessoa foi mandada para a plataforma
                          'recebida',               -- voltou com o código; o worker conclui
                          'processando',            -- worker trocando o código e descobrindo as contas
                          'aguardando_escolha',     -- contas descobertas; falta escolher quais ligar
                          'ativa',                  -- ao menos uma conta ligada
                          'erro', 'expirada', 'revogada')),
  requested_by          uuid references liame.app_user (id) on delete set null,
  state_hash            text not null unique check (state_hash ~ '^[0-9a-f]{64}$'),
  redirect_uri          text not null,
  -- Cifrados com a chave da empresa (pii1.), apagados depois da troca.
  pkce_verifier_enc     text,
  code_enc              text,
  credential_secret_id  uuid references liame.secret (id) on delete set null,
  scopes                text[] not null default '{}',
  -- Contas que a credencial alcança (nome, moeda, fuso): para a escolha, sem segredo.
  discovered            jsonb not null default '[]'::jsonb check (jsonb_typeof(discovered) = 'array'),
  error_code            text check (error_code ~ '^[a-z_]+$'),
  attempts              integer not null default 0 check (attempts >= 0),
  -- Google em modo de teste: o refresh token vence em 7 dias [S]; a tela avisa antes.
  refresh_expires_at    timestamptz,
  expires_at            timestamptz not null,
  locked_at             timestamptz,
  completed_at          timestamptz,
  revoked_at            timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create index if not exists idx_oauth_connection_tenant on liame.oauth_connection (tenant_id, brand_id, created_at desc);
create index if not exists idx_oauth_connection_fila on liame.oauth_connection (status, updated_at) where status in ('recebida', 'processando', 'aguardando_autorizacao');

-- ------------------------------------------------------------ conta ligada à conexão

alter table liame.connected_account add column if not exists connection_id uuid references liame.oauth_connection (id) on delete set null;
-- Uma conta da plataforma fica ligada a uma marca só por vez dentro da empresa.
create unique index if not exists uq_connected_account_ativa
  on liame.connected_account (tenant_id, provider, external_id) where disconnected_at is null;

-- ------------------------------------------------------------ RLS

alter table liame.oauth_connection enable row level security;
alter table liame.oauth_connection force row level security;
drop policy if exists oauth_connection_isolamento on liame.oauth_connection;
create policy oauth_connection_isolamento on liame.oauth_connection
  using (tenant_id = liame.current_tenant_id() or liame.system_scope())
  with check (tenant_id = liame.current_tenant_id() or liame.system_scope());
drop policy if exists oauth_connection_apaga_so_sistema on liame.oauth_connection;
create policy oauth_connection_apaga_so_sistema on liame.oauth_connection as restrictive for delete using (liame.system_scope());
grant select, insert, update, delete on liame.oauth_connection to liame_app;

-- ------------------------------------------------------------ permissões (ADR-013)

insert into liame.role_permission (tenant_id, role_key, permission)
values (null, 'dono', 'contas.ver'), (null, 'dono', 'contas.conectar'),
       (null, 'administrador', 'contas.ver'), (null, 'administrador', 'contas.conectar'),
       (null, 'gestor', 'contas.ver'), (null, 'gestor', 'contas.conectar'),
       (null, 'aprovador', 'contas.ver'), (null, 'somente_leitura', 'contas.ver')
on conflict do nothing;

-- ------------------------------------------------------------ mapa de métricas (da distribuição)

-- O que cada conector grava com nome canônico (G4, G5, G6). `transform` diz a conversão já feita na
-- leitura; `confidence` diz o quanto o nome canônico equivale entre plataformas.
insert into liame.metric_mapping (provider, provider_metric, canonical_metric, transform, confidence, notes) values
  ('meta_ads', 'spend', 'spend', 'identidade', 'alta', 'na moeda da conta'),
  ('meta_ads', 'impressions', 'impressions', 'identidade', 'alta', null),
  ('meta_ads', 'reach', 'reach', 'identidade', 'alta', 'não soma entre dias nem anúncios'),
  ('meta_ads', 'clicks', 'clicks', 'identidade', 'alta', 'todos os cliques'),
  ('meta_ads', 'inline_link_clicks', 'link_clicks', 'identidade', 'alta', null),
  ('meta_ads', 'actions:onsite_conversion.messaging_conversation_started_7d', 'conversations_started', 'identidade', 'alta', 'por janela de atribuição'),
  ('meta_ads', 'actions:purchase', 'purchases', 'identidade', 'media', 'purchase > omni_purchase > pixel'),
  ('meta_ads', 'actions:lead', 'leads', 'identidade', 'media', 'lead > pixel lead'),
  ('meta_ads', 'actions:landing_page_view', 'landing_page_views', 'identidade', 'alta', null),
  ('meta_ads', 'action_values:purchase', 'purchase_value', 'identidade', 'media', 'mesma preferência de purchases'),
  ('google_ads', 'metrics.cost_micros', 'spend', 'micros_para_unidade', 'alta', 'na moeda da conta'),
  ('google_ads', 'metrics.impressions', 'impressions', 'identidade', 'alta', null),
  ('google_ads', 'metrics.clicks', 'clicks', 'identidade', 'alta', null),
  ('google_ads', 'metrics.conversions', 'conversions', 'identidade', 'media', 'conversões primárias; fracionárias no modelo de atribuição'),
  ('google_ads', 'metrics.conversions_value', 'conversions_value', 'identidade', 'media', null),
  ('ga4', 'sessions', 'sessions', 'identidade', 'alta', null),
  ('ga4', 'totalUsers', 'users', 'identidade', 'alta', 'não soma entre dias'),
  ('ga4', 'newUsers', 'new_users', 'identidade', 'alta', null),
  ('ga4', 'engagedSessions', 'engaged_sessions', 'identidade', 'alta', null),
  ('ga4', 'keyEvents', 'key_events', 'identidade', 'alta', 'antigo "conversions"'),
  ('ga4', 'ecommercePurchases', 'purchases', 'identidade', 'media', 'atribuição por sessão do GA4'),
  ('ga4', 'purchaseRevenue', 'purchase_value', 'identidade', 'media', 'atribuição por sessão do GA4')
on conflict (provider, provider_metric) do nothing;
