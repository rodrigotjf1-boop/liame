-- 0067 · A conexão do Perfil da Empresa no Google (A6, Z1, parte b; `plano-a6.md` D-A6-1 e D-A6-17).
-- (1) A flag `perfil_google`, por empresa, desligada. Ligada, a autorização do Google daquela empresa passa a pedir
--     também a permissão do Perfil da Empresa (`business.manage`), e a procura das contas inclui as lojas do Perfil.
--     Quem não usa a função não vê tela de permissão a mais. Não é flag de escrita: por ela nada é publicado no
--     Google (responder avaliação é a Z2, pelo trilho de ação, com a flag dela).
-- (2) `oauth_connection.discovery_notes`: como terminou a procura dos tipos de conta que podem falhar sem derrubar a
--     conexão. Hoje, só as lojas do Perfil: a cota do Perfil é do app do Liame no Google (zero até o Google liberar o
--     acesso), e a conexão do Google Ads e do GA4 não pode parar por causa dela. Formato:
--     `{"google_business": {"resultado": "ok" | "limite" | "sem_permissao" | "falhou", "em": "<instante>", "lojas": 0}}`.
--     Sem a chave = o Liame não procurou (função desligada ou permissão não concedida).
-- Idempotente; uma transação por arquivo (ADR-018).

-- A semente da flag grava em tabela com RLS forçada (V20).
select set_config('app.scope', 'sistema', true);

insert into liame.feature_flag (key, kind, default_value, description, owner, is_write)
values ('perfil_google', 'boolean', 'false', 'Perfil da Empresa no Google: a autorização do Google pede também a permissão do Perfil, e o Liame lê as lojas, as avaliações e os números do perfil (A6, Z1). Só leitura', 'social', false)
on conflict (key) do nothing;

alter table liame.oauth_connection add column if not exists discovery_notes jsonb not null default '{}'::jsonb;
alter table liame.oauth_connection drop constraint if exists oauth_connection_procura_objeto;
alter table liame.oauth_connection add constraint oauth_connection_procura_objeto check (jsonb_typeof(discovery_notes) = 'object');
