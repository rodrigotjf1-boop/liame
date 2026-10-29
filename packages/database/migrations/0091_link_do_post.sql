-- A6 · Z7, parte a: o link do post (D-A6-16; decisões técnicas D-A6-46 a D-A6-48 do plano-a6.md §4).
-- O link do post é um link com rastreio do contrato que já existe, marcado como de post (kind = 'post', sem campanha) e
-- preso a ele (post_id, um por post). A marca kind vale mesmo se a ligação com o post sumir: o motor de atribuição
-- separa o clique pelo link do post das evidências de mídia (motivo link_do_post), e ele nunca entra no ROAS dos anúncios.

alter table liame.tracking_link add column if not exists kind text not null default 'campanha';
alter table liame.tracking_link add column if not exists post_id uuid references liame.social_post (id) on delete set null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'tracking_link_kind_check' and conrelid = 'liame.tracking_link'::regclass) then
    alter table liame.tracking_link add constraint tracking_link_kind_check check (kind in ('campanha', 'post'));
  end if;
  -- O link do post não tem campanha nem anúncio; o de campanha não tem post.
  if not exists (select 1 from pg_constraint where conname = 'tracking_link_post_check' and conrelid = 'liame.tracking_link'::regclass) then
    alter table liame.tracking_link add constraint tracking_link_post_check
      check ((kind = 'post' and campaign_id is null and ad_group_id is null and ad_id is null) or (kind = 'campanha' and post_id is null));
  end if;
end $$;

-- Um link por post.
create unique index if not exists uq_tracking_link_post on liame.tracking_link (post_id) where post_id is not null;

-- O motivo novo do pedido sem origem de mídia: veio pelo link de um post (orgânico).
alter table liame.attribution_result drop constraint if exists attribution_result_reason_check;
alter table liame.attribution_result add constraint attribution_result_reason_check
  check (reason in ('sem_evidencia', 'fora_da_janela', 'canal_sem_clique', 'sem_id', 'cancelado', 'removido', 'link_do_post'));
