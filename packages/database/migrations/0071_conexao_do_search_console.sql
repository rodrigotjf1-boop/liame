-- 0071 · A conexão do Search Console (A6, Z3, parte b; `plano-a6.md` D-A6-1 e, como no Perfil, D-A6-17).
-- A flag `search_console`, por empresa, desligada. Ligada, a autorização do Google daquela empresa passa a pedir também
-- a permissão de só leitura do Search Console (`webmasters.readonly`), e a procura das contas inclui os sites que a
-- empresa pode ler. Quem não usa a função não vê tela de permissão a mais. Não é flag de escrita: o Liame não escreve
-- no Search Console (critério A6-6).
-- Como terminou a procura dos sites fica em `oauth_connection.discovery_notes`, na chave `search_console` (a coluna é a
-- da migration 0067), no mesmo formato da procura das lojas do Perfil.
-- Idempotente; uma transação por arquivo (ADR-018).

-- A semente da flag grava em tabela com RLS forçada (V20).
select set_config('app.scope', 'sistema', true);

insert into liame.feature_flag (key, kind, default_value, description, owner, is_write)
values ('search_console', 'boolean', 'false', 'Search Console: a autorização do Google pede também a permissão de só leitura do Search Console, e o Liame lê os sites e as buscas no Google que levaram a eles (A6, Z3). Só leitura', 'social', false)
on conflict (key) do nothing;
