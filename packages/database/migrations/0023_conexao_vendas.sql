-- 0023 · Conectar Regem e RegemCast (A2.5, F3; ADR-019): a autorização do produto DMS vira uma conexão
-- como as da Meta e do Google (token por loja no cofre), também quando a distribuição emite o token no
-- piloto; a entrada de webhooks passa a ter um segredo por conexão; permissões do ciclo fechado e a flag
-- de escrita no Regem, que nasce desligada. Idempotente; uma transação por arquivo (ADR-018).

-- A semente das permissões e da flag grava com a RLS forçada (ERR-011).
select set_config('app.scope', 'sistema', true);

-- ------------------------------------------------------------ conexão com os produtos DMS

alter table liame.oauth_connection drop constraint if exists oauth_connection_provider_check;
alter table liame.oauth_connection add constraint oauth_connection_provider_check
  check (provider in ('meta', 'google', 'regem', 'regemcast'));

-- Como a conexão nasceu: pela autorização da pessoa (`oauth`) ou pela distribuição, que emitiu o token
-- no produto e o gravou direto no cofre (`distribuicao`, piloto; D-A2.5-4).
alter table liame.oauth_connection add column if not exists origin text not null default 'oauth';
alter table liame.oauth_connection drop constraint if exists oauth_connection_origin_check;
alter table liame.oauth_connection add constraint oauth_connection_origin_check check (origin in ('oauth', 'distribuicao'));

-- Segredo que assina os eventos que o produto manda para esta conexão (Standard Webhooks), no cofre.
alter table liame.oauth_connection add column if not exists inbox_secret_id uuid references liame.secret (id) on delete set null;

-- ------------------------------------------------------------ entrada de webhooks por conexão

-- `POST /v1/inbox/{provider}/{connection_id}`: o evento fica ligado à conexão que o assinou.
alter table liame.inbox_event add column if not exists connection_id uuid references liame.oauth_connection (id) on delete set null;
create index if not exists idx_inbox_event_conexao on liame.inbox_event (connection_id) where connection_id is not null;

-- ------------------------------------------------------------ permissões do ciclo fechado (ADR-013)

-- vendas.ver: pedidos, receita, margem e ROAS confirmado (quem vê campanhas);
-- atribuicao.gerenciar: ligar cupom a campanha e recalcular; links.gerenciar: links de campanha;
-- cupons.criar: pedir a criação de cupom no Regem (que ainda passa pela aprovação da política).
insert into liame.role_permission (tenant_id, role_key, permission)
values (null, 'dono', 'vendas.ver'), (null, 'dono', 'atribuicao.gerenciar'), (null, 'dono', 'links.gerenciar'), (null, 'dono', 'cupons.criar'),
       (null, 'administrador', 'vendas.ver'), (null, 'administrador', 'atribuicao.gerenciar'), (null, 'administrador', 'links.gerenciar'), (null, 'administrador', 'cupons.criar'),
       (null, 'gestor', 'vendas.ver'), (null, 'gestor', 'atribuicao.gerenciar'), (null, 'gestor', 'links.gerenciar'), (null, 'gestor', 'cupons.criar'),
       (null, 'aprovador', 'vendas.ver'), (null, 'somente_leitura', 'vendas.ver')
on conflict do nothing;

-- ------------------------------------------------------------ Capability Registry dos produtos DMS

-- Contratos da casa (docs/integracoes), versão 1 de 29/09/2026: a versão fica no registro, nunca no código.
insert into liame.connector_capability (provider, capability, api_version, read, write, required_scope, access_level, sunset_at, source_url, verified_at, notes) values
  ('regem', 'loja', 'v1', true, false, '{}', 'token por loja', null, 'docs/integracoes/regem.md', '2026-09-29', 'quem é a loja do token (nome, fuso, moeda, escopos)'),
  ('regem', 'pedidos', 'v1', true, false, '{pedidos.ler}', 'token por loja', null, 'docs/integracoes/regem.md', '2026-09-29', 'confirmados e cancelados, com itens, cupom e origem do clique; custo com custos.ler; cliente com clientes.telefone.ler'),
  ('regem', 'clientes_anonimizados', 'v1', true, false, '{clientes.anonimizacao.ler}', 'token por loja', null, 'docs/integracoes/regem.md', '2026-09-29', 'o Liame apaga o cliente pseudonimizado em até 1 dia'),
  ('regem', 'cupons', 'v1', true, false, '{cupons.ler}', 'token por loja', null, 'docs/integracoes/cupons.md', '2026-09-29', 'contrato de cupons'),
  ('regem', 'cupons_usos', 'v1', true, false, '{cupons.uso.ler}', 'token por loja', null, 'docs/integracoes/cupons.md', '2026-09-29', 'contrato de cupons'),
  ('regem', 'cupom_criar', 'v1', false, true, '{cupons.criar}', 'token por loja', null, 'docs/integracoes/cupons.md', '2026-09-29', 'só pelo Action Service, com a flag regem_write'),
  ('regemcast', 'conversas_anuncio', 'v1', true, false, '{conversas.anuncio.ler}', 'token por conta', null, 'docs/integracoes/regemcast.md', '2026-09-29', 'referral da primeira mensagem, sem conteúdo')
on conflict (provider, capability) do nothing;

-- ------------------------------------------------------------ flag de escrita no Regem (ADR-012)

insert into liame.feature_flag (key, kind, default_value, description, owner, is_write)
values ('regem_write', 'boolean', 'false', 'Escrita no Regem (criar e desativar cupom de campanha)', 'vendas', true)
on conflict (key) do nothing;
