-- 0069 · A resposta a uma avaliação do Perfil da Empresa no Google: as capacidades e a flag de escrita (A6, Z2;
-- `plano-a6.md` D-A6-3 e D-A6-4).
-- (1) Duas capacidades novas no registro: ler UMA avaliação na hora (o trilho confere a avaliação antes de publicar a
--     resposta aprovada: critério A6-4) e gravar ou apagar a resposta da empresa. As duas usam a mesma versão das
--     avaliações (`reviews`). A leitura das avaliações (0066) segue só leitura.
-- (2) A flag `perfil_google_write`, por empresa, desligada. É flag de escrita: nasce desligada e a parada geral a
--     alcança. Sem ela nenhuma resposta é publicada. A função de leitura (`perfil_google`, 0067) não publica nada.
-- Nenhuma ferramenta usa o conector nesta entrega: a resposta só sai pelo trilho de ação, depois de uma pessoa aprovar
-- com o código do app (a de 1 ou 2 estrelas, só o dono).
-- Conferido na referência oficial em 11/10/2026 (base de conhecimento §3.3): `GET …/reviews/{reviewId}`;
-- `PUT …/reviews/{reviewId}/reply`, com `ReviewReply` no corpo e na volta ("A reply is created if one does not
-- exist"); `DELETE …/reviews/{reviewId}/reply`; os três "only valid if the specified location is verified".
-- Da distribuição (sem empresa). Idempotente; uma transação por arquivo (ADR-018).

-- As sementes gravam em tabelas com RLS forçada (V20).
select set_config('app.scope', 'sistema', true);

insert into liame.connector_capability (provider, capability, api_version, read, write, required_scope, access_level, sunset_at, source_url, verified_at, notes) values
  ('google_business', 'review_state', 'v4', true, false, '{https://www.googleapis.com/auth/business.manage}', 'Acesso básico à API, liberado por pedido (0 QPM antes)', null,
   'https://developers.google.com/my-business/reference/rest/v4/accounts.locations.reviews/get', '2026-10-11', 'My Business API v4: uma avaliação pelo nome, lida na hora de publicar a resposta; só loja verificada'),
  ('google_business', 'review_reply', 'v4', false, true, '{https://www.googleapis.com/auth/business.manage}', 'Acesso básico à API, liberado por pedido (0 QPM antes)', null,
   'https://developers.google.com/my-business/reference/rest/v4/accounts.locations.reviews/updateReply', '2026-10-11', 'My Business API v4: gravar (PUT) e apagar (DELETE) a resposta da empresa a uma avaliação; o Google confere a resposta antes de mostrar; só loja verificada; só pelo trilho de ação, com a flag perfil_google_write')
on conflict (provider, capability) do nothing;

insert into liame.feature_flag (key, kind, default_value, description, owner, is_write)
values ('perfil_google_write', 'boolean', 'false', 'Perfil da Empresa no Google: publicar e apagar a resposta da empresa a uma avaliação, sempre depois da aprovação de uma pessoa com o código do app (A6, Z2)', 'social', true)
on conflict (key) do nothing;
