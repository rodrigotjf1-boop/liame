-- Conferência do catálogo depois de aplicar migrations (docs/configuracao.md, "Banco na nuvem").
-- Lê só o catálogo do Postgres: roda no SQL Editor do Supabase (usuário postgres) e no banco local.
-- Os dois resultados precisam ser idênticos; a referência vem do banco local com as mesmas migrations.
select
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'liame' and c.relkind in ('r', 'p')) as tabelas,
  (select count(*) from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'liame' and c.relkind in ('r', 'p') and a.attnum > 0 and not a.attisdropped) as colunas,
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'liame' and c.relkind in ('r', 'p') and not c.relrowsecurity) as tabelas_sem_rls,
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'liame' and c.relkind in ('r', 'p') and not c.relforcerowsecurity) as tabelas_sem_rls_forcado,
  (select count(*) from pg_policy p join pg_class c on c.oid = p.polrelid join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'liame') as politicas,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'liame') as funcoes,
  (select count(*) from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'liame' and not t.tgisinternal) as gatilhos,
  (select count(*) from pg_index i join pg_class c on c.oid = i.indrelid join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'liame') as indices,
  (select string_agg(distinct pg_get_userbyid(c.relowner), ',') from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'liame' and c.relkind in ('r', 'p')) as dono,
  (select md5(string_agg(c.relname || '.' || a.attname || ':' || format_type(a.atttypid, a.atttypmod) || ':' || a.attnotnull::text, ',' order by c.relname, a.attname))
     from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'liame' and c.relkind in ('r', 'p') and a.attnum > 0 and not a.attisdropped) as assinatura_colunas,
  (select md5(string_agg(c.relname || ':' || p.polname || ':' || p.polcmd::text || ':' || p.polpermissive::text, ',' order by c.relname, p.polname))
     from pg_policy p join pg_class c on c.oid = p.polrelid join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'liame') as assinatura_politicas,
  (select md5(string_agg(c.relname || ':' || x.privilege_type, ',' order by c.relname, x.privilege_type))
     from pg_class c join pg_namespace n on n.oid = c.relnamespace, aclexplode(c.relacl) x
    where n.nspname = 'liame' and x.grantee = (select oid from pg_roles where rolname = 'liame_app')) as assinatura_permissoes_app;
