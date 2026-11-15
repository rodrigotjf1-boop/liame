-- 0164 · Os melhores momentos: o vídeo montado com os cortes (A6, Z16, parte 4; o item 7 do dono de 07/11/2026; D-A6-82 e
-- D-A6-150 a D-A6-154, do protótipo P46, seguidas como recomendadas). Depois da 0163 (o pedido dos cortes ao Social media e a
-- função `video_momentos`): a pessoa confere ou muda os cortes propostos e manda montar; o serviço de montagem (liame-render)
-- monta os cortes em sequência, com a legenda de cada um.
-- (1) O modelo `momentos` na fila do vídeo montado.
-- (2) A duração: 10, 15 ou 20 segundos nos "Melhores momentos" (o vídeo dura a soma dos cortes); 6, 10 ou 15 nos outros.
-- (3) A chamada: os "Melhores momentos" não levam (vazia); nos outros, de 1 a 30 letras, como antes.
-- (4) `cuts`: os cortes conferidos, na ordem do vídeo (`[{"media_id", "start_ms", "end_ms", "caption"}]`, de 2 a 6), só nos
--     "Melhores momentos" e obrigatórios neles.
-- Só a tabela das empresas, sem dado novo. Idempotente; uma transação por arquivo (ADR-018). As regras escritas na linha da
-- 0143 têm o nome que o Postgres deu (`<tabela>_<coluna>_check`); saem e voltam com nome.

alter table liame.video_montage add column if not exists cuts jsonb;

-- ------------------------------------------------------------ (1) o modelo

alter table liame.video_montage drop constraint if exists video_montage_template_check;
alter table liame.video_montage drop constraint if exists video_montage_modelo;
alter table liame.video_montage add constraint video_montage_modelo check (template in ('destaque', 'combo', 'novidade', 'momentos'));

-- ------------------------------------------------------------ (2) a duração

alter table liame.video_montage drop constraint if exists video_montage_duration_s_check;
alter table liame.video_montage drop constraint if exists video_montage_duracao;
alter table liame.video_montage add constraint video_montage_duracao check (
  case when template = 'momentos' then duration_s in (10, 15, 20) else duration_s in (6, 10, 15) end
);

-- ------------------------------------------------------------ (3) a chamada

alter table liame.video_montage drop constraint if exists video_montage_cta_check;
alter table liame.video_montage drop constraint if exists video_montage_chamada;
alter table liame.video_montage add constraint video_montage_chamada check (
  case when template = 'momentos' then cta = '' else char_length(cta) between 1 and 30 end
);

-- ------------------------------------------------------------ (4) os cortes

-- O nulo cai no `else false` (um nulo na regra passaria, ERR-241); o tamanho só se mede de uma lista (o `and` do SQL não
-- garante a ordem, e `jsonb_array_length` de outra coisa dá erro em vez da recusa).
alter table liame.video_montage drop constraint if exists video_montage_cortes;
alter table liame.video_montage add constraint video_montage_cortes check (
  case
    when template = 'momentos' then (case when jsonb_typeof(cuts) = 'array' then jsonb_array_length(cuts) between 2 and 6 else false end)
    else cuts is null
  end
);
