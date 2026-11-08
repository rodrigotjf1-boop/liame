-- 0124 · Comentários: responder, apagar a resposta, ocultar e mostrar (A6, Z11, parte 2; P38, D-A6-88, D-A6-89 e
-- D-A6-91; `plano-a6.md` Z11).
-- (1) Duas capacidades novas no registro, na versão das outras da Meta (v26.0), conferidas nas páginas oficiais em
--     07/11/2026 (base de conhecimento §2.2): `instagram_comment_moderate` (POST /{ig-comment-id}/replies com
--     `message`, só ao comentário de primeiro nível e nunca ao oculto; POST /{ig-comment-id} com `hide`; DELETE
--     /{ig-comment-id}, só o dono da mídia) e `pagina_comment_moderate` (POST /{comment-id}/comments com `message`;
--     POST /{comment-id} com `is_hidden`; DELETE /{comment-id}; com o token da Página de quem pode MODERATE, ou com
--     `pages_manage_engagement`).
-- (2) A função `comentarios_responder`, desligada e de escrita: a parada geral a alcança. É a flag das ferramentas do
--     comentário, conferida junto com a do conector da conta (`social_write`).
-- Só da distribuição. Idempotente; uma transação por arquivo (ADR-018).

-- As sementes gravam em tabelas com RLS forçada (V20).
select set_config('app.scope', 'sistema', true);

insert into liame.connector_capability (provider, capability, api_version, read, write, required_scope, access_level, sunset_at, source_url, verified_at, notes) values
  ('meta_ads', 'instagram_comment_moderate', 'v26.0', false, true, '{instagram_basic,instagram_manage_comments,pages_read_engagement}', 'Standard (testadores) ou Advanced', null,
   'https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-comment/replies', '2026-11-07',
   'Graph API: responder (POST /{ig-comment-id}/replies, message; só ao comentário de primeiro nível; não ao oculto nem ao de transmissão ao vivo; volta o id da resposta), ocultar e mostrar (POST /{ig-comment-id}?hide=true|false, com o token de quem é dono da mídia) e apagar (DELETE /{ig-comment-id}, só o dono da mídia)'),
  ('meta_ads', 'pagina_comment_moderate', 'v26.0', false, true, '{pages_read_engagement,pages_read_user_content,pages_manage_engagement}', 'Standard (testadores) ou Advanced', null,
   'https://developers.facebook.com/docs/pages-api/comments-mentions', '2026-11-07',
   'Graph API: responder (POST /{comment-id}/comments, message; volta o id), ocultar e mostrar (POST /{comment-id}, is_hidden) e apagar (DELETE /{comment-id}); token da Página de quem pode MODERATE, ou pages_manage_engagement')
on conflict (provider, capability) do nothing;

insert into liame.feature_flag (key, kind, default_value, description, owner, is_write)
values ('comentarios_responder', 'boolean', 'false', 'Comentários: responder, apagar a resposta, ocultar e mostrar de novo um comentário dos posts da marca no Instagram e na Página, sempre por um pedido com a aprovação de uma pessoa (A6, Z11). Precisa também da escrita dos posts (social_write)', 'social', true)
on conflict (key) do nothing;

-- ------------------------------------------------------------ conferência

do $$ begin
  if (select count(*) from liame.connector_capability
       where provider = 'meta_ads' and capability in ('instagram_comment_moderate', 'pagina_comment_moderate') and write) <> 2 then
    raise exception '0124: as capacidades de moderar os comentários não entraram';
  end if;
  if not exists (select 1 from liame.feature_flag where key = 'comentarios_responder' and default_value = 'false'::jsonb and is_write) then
    raise exception '0124: a função comentarios_responder não entrou desligada e de escrita';
  end if;
end $$;
