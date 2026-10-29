-- 0090 · O pacote pronto (A6, Z8, parte a; `plano-a6.md` §3 Z8, D-A6-12 e D-A6-25; protótipo P22, aprovado pelo dono em
-- 21/10/2026; as decisões técnicas D-A6-40 a D-A6-42 estão no `plano-a6.md` §4, 29/10/2026). No TikTok e no YouTube o
-- Liame não publica (A6-14): ele monta o pacote (o texto, a foto e a hora), e quem publica é a pessoa, que marca
-- "Publiquei" ou tira o pacote da Agenda. O pacote não pede o código do app nem vira pedido em Aprovações (D-A6-25).
-- (1) `social_post.kind`: `post` (o que o Liame publica, com o pedido em Aprovações) ou `pacote` (um por rede, sem
--     pedido). O post de antes desta migration é `post`.
-- (2) `social_post_channel`: os canais do pacote (`tiktok` e `youtube`), sem conta ligada, e a situação `pronto` (o
--     pacote espera a pessoa publicar), só deles. As regras antigas do canal e da situação saem e voltam com os valores
--     novos (o nome é o que o Postgres deu à regra da coluna na 0086).
-- Nada de dado pessoal: o texto é o que a empresa escreve em nome dela. Idempotente; uma transação por arquivo (ADR-018).

alter table liame.social_post add column if not exists kind text not null default 'post';
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'social_post_kind_check' and conrelid = 'liame.social_post'::regclass) then
    alter table liame.social_post add constraint social_post_kind_check check (kind in ('post', 'pacote'));
  end if;
  -- O pacote nunca tem pedido em Aprovações (D-A6-25), nem recorte do Instagram (a foto vai inteira).
  if not exists (select 1 from pg_constraint where conname = 'social_post_pacote_check' and conrelid = 'liame.social_post'::regclass) then
    alter table liame.social_post add constraint social_post_pacote_check check (kind <> 'pacote' or (action_id is null and crop_pos is null));
  end if;
end $$;

alter table liame.social_post_channel drop constraint if exists social_post_channel_channel_check;
alter table liame.social_post_channel add constraint social_post_channel_channel_check check (channel in ('instagram', 'facebook', 'tiktok', 'youtube'));
alter table liame.social_post_channel drop constraint if exists social_post_channel_status_check;
alter table liame.social_post_channel add constraint social_post_channel_status_check
  check (status in ('aguardando', 'publicando', 'publicado', 'falhou', 'cancelado', 'apagado', 'pronto'));

do $$
begin
  -- O canal do pacote não tem conta ligada (o Liame não fala com a rede), e só ele fica `pronto`; o canal que o Liame
  -- publica nunca fica `pronto`.
  if not exists (select 1 from pg_constraint where conname = 'social_post_channel_pacote_check' and conrelid = 'liame.social_post_channel'::regclass) then
    alter table liame.social_post_channel add constraint social_post_channel_pacote_check check (
      (status <> 'pronto' or channel in ('tiktok', 'youtube'))
      and (channel not in ('tiktok', 'youtube')
           or (status in ('pronto', 'publicado', 'cancelado') and connected_account_id is null and container_id is null and external_id is null))
    );
  end if;
end $$;
