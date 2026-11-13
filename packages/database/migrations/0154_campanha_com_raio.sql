-- 0154 · A campanha com raio (plano da região, R6: a X5 ampliada; revisão R6 da P42 aprovada pelo dono em 13/11/2026,
-- D-RG-48 a D-RG-52). A campanha nova na Meta ganha dois objetivos e guarda a estimativa de público do raio:
--   * `objective`: além de `cardapio` e `whatsapp`, `alcance` (ser conhecido no raio: OUTCOME_AWARENESS otimizado para
--     REACH, com a frequência limitada; o botão leva ao cardápio) e `seguidores` (seguidores no Instagram: o destino é o
--     perfil do Instagram ligado à Página).
--   * `link`: o cardápio da loja em `cardapio` e em `alcance`; nulo no WhatsApp e em seguidores (o destino é o perfil).
--   * `audience_lower` e `audience_upper`: a estimativa de público da Meta para o raio quando a pessoa pediu
--     (`reachestimate`, 18 anos ou mais), para a aprovação ver o mesmo número; nulas quando a Meta não estimou.
-- Idempotente; uma transação por arquivo (ADR-018).

alter table liame.ad_campaign_new add column if not exists audience_lower bigint;
alter table liame.ad_campaign_new add column if not exists audience_upper bigint;

do $$ begin
  -- O objetivo: a regra de antes (só cardápio e WhatsApp) sai, a nova entra.
  if exists (select 1 from pg_constraint where conrelid = 'liame.ad_campaign_new'::regclass and conname = 'ad_campaign_new_objective_check'
              and pg_get_constraintdef(oid) not like '%alcance%') then
    alter table liame.ad_campaign_new drop constraint ad_campaign_new_objective_check;
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'liame.ad_campaign_new'::regclass and conname = 'ad_campaign_new_objective_check') then
    alter table liame.ad_campaign_new add constraint ad_campaign_new_objective_check check (objective in ('cardapio', 'whatsapp', 'alcance', 'seguidores'));
  end if;
  -- O link: o cardápio em cardápio e em alcance.
  if exists (select 1 from pg_constraint where conrelid = 'liame.ad_campaign_new'::regclass and conname = 'ad_campaign_new_link'
              and pg_get_constraintdef(oid) not like '%alcance%') then
    alter table liame.ad_campaign_new drop constraint ad_campaign_new_link;
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'liame.ad_campaign_new'::regclass and conname = 'ad_campaign_new_link') then
    alter table liame.ad_campaign_new add constraint ad_campaign_new_link check ((objective in ('cardapio', 'alcance')) = (link is not null));
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'liame.ad_campaign_new'::regclass and conname = 'ad_campaign_new_publico') then
    alter table liame.ad_campaign_new add constraint ad_campaign_new_publico
      check ((audience_lower is null) = (audience_upper is null) and coalesce(audience_lower, 0) >= 0 and coalesce(audience_upper, 0) >= coalesce(audience_lower, 0));
  end if;
end $$;

-- ------------------------------------------------------------ conferência

do $$ begin
  if (select count(*) from information_schema.columns where table_schema = 'liame' and table_name = 'ad_campaign_new'
       and column_name in ('audience_lower', 'audience_upper')) <> 2 then
    raise exception '0154: as colunas da estimativa de público não entraram';
  end if;
  if (select pg_get_constraintdef(oid) from pg_constraint where conrelid = 'liame.ad_campaign_new'::regclass and conname = 'ad_campaign_new_objective_check') not like '%seguidores%' then
    raise exception '0154: os objetivos novos não entraram';
  end if;
  if (select pg_get_constraintdef(oid) from pg_constraint where conrelid = 'liame.ad_campaign_new'::regclass and conname = 'ad_campaign_new_link') not like '%alcance%' then
    raise exception '0154: a regra do link não entrou';
  end if;
end $$;
