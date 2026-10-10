-- 0062 · A proposta de mensagem do funcionário de CRM e mensageria (A5, Y6; `plano-a5.md` D-A5-14 e D-A5-15;
-- protótipo P16, aprovado em 09/10/2026). Entre "ele decidiu propor" e "o pedido de envio está em Aprovações" passa
-- tempo: ele escreve a mensagem, o código confere o texto, o rascunho do modelo nasce no RegemCast, uma PESSOA envia o
-- modelo para a análise da Meta (D-A5-15) e só com o modelo aprovado o pedido de envio pode ser montado. Esta tabela
-- guarda onde cada proposta está nesse caminho, para a rotina retomar de onde parou e para a ficha dele em Sua equipe
-- dizer a verdade ("preparando", "o rascunho espera o modelo").
-- O que fica aqui: o que ele recebeu para escrever (o motivo, a oferta de Minha marca, o público só com nome, regra e
-- contagem, e o cupom), o que escreveu DEPOIS de conferido, o rascunho do modelo no RegemCast e o pedido que saiu. O
-- texto que a conferência barrou não é guardado: ficam só os nomes do que barrou. Nenhum telefone e nenhum nome de
-- contato: o Liame não os tem (D-A5-10).
-- Nada usa esta tabela enquanto a rotina dele não existir e a flag `crm` estiver desligada.
-- Idempotente; uma transação por arquivo (ADR-018).

create table if not exists liame.message_proposal (
  id                    uuid primary key,
  tenant_id             uuid not null references liame.organization (id) on delete cascade,
  brand_id              uuid not null references liame.brand (id) on delete cascade,
  -- A conta do RegemCast por onde a mensagem vai sair.
  connected_account_id  uuid not null references liame.connected_account (id) on delete cascade,
  -- Por que a mensagem existe (D-A5-14): divulgar uma oferta de Minha marca, ou chamar de volta quem não pede há tempo.
  motive                text not null check (motive in ('promocao', 'volte_a_pedir')),
  -- Como a pessoa pede depois de ler: pelo cardápio online da loja, ou respondendo a própria mensagem.
  destination           text not null check (destination in ('cardapio', 'whatsapp')),
  -- A oferta como estava escrita em Minha marca na hora, e a versão do dossiê de onde ela veio. A promoção sempre
  -- parte de uma oferta; o "volte a pedir" pode não ter.
  offer                 text check (length(offer) between 1 and 160),
  dossier_version       integer check (dossier_version >= 1),
  -- O público, como o RegemCast o descreve: de onde sai (a origem e o id de lá), o nome, a regra e quantas pessoas
  -- podiam receber quando ele propôs. Só a contagem: o Liame não vê quem são.
  audience              jsonb not null check (jsonb_typeof(audience) = 'object'),
  audience_name         text not null check (length(audience_name) between 1 and 300),
  audience_rule         text check (length(audience_rule) <= 1000),
  people                integer not null check (people >= 0),
  -- O cupom da mensagem, como vai no pedido de envio (a loja do Regem, o código, o tipo, o valor e a validade). É dado
  -- de entrada: o funcionário não inventa oferta nem preço.
  coupon                jsonb check (coupon is null or jsonb_typeof(coupon) = 'object'),
  -- Onde a proposta está:
  --   `preparando`  a rotina a abriu: ele escreve, o código confere e o rascunho do modelo vai para o RegemCast;
  --   `rascunho`    o rascunho do modelo está no RegemCast e espera uma pessoa enviar para a Meta, e a Meta aprovar;
  --   `pedido`      o modelo foi aprovado e o pedido de envio foi montado: daqui em diante quem manda é Aprovações;
  --   `barrada`     a conferência não deixou o texto passar (nada foi para o RegemCast);
  --   `descartada`  não vai virar pedido (ele não escreve sobre aquilo, a Meta recusou o modelo, o prazo acabou…);
  --   `falhou`      não deu para chamar a IA ou o RegemCast, depois das tentativas.
  status                text not null default 'preparando' check (status in ('preparando', 'rascunho', 'pedido', 'barrada', 'descartada', 'falhou')),
  -- O porquê, quando descartada ou falhou (`bebida_alcoolica`, `modelo_recusado`, `prazo`, `ia_fora_do_ar`…): o
  -- código, não o texto do erro.
  reason                text check (reason ~ '^[a-z_]{2,40}$'),
  -- O que a conferência apontou quando barrou: só os nomes dos itens e das regras, nunca o texto barrado.
  -- (O tamanho é conferido à parte: a expressão regular do Postgres não aceita repetição acima de 255.)
  barred_by             text[] check (barred_by is null or (cardinality(barred_by) between 1 and 20 and array_to_string(barred_by, ',') ~ '^[a-z_,]+$' and length(array_to_string(barred_by, ',')) <= 840)),
  -- O que ele escreveu, já conferido: o nome da mensagem (para a equipe da loja) e o corpo do modelo.
  name                  text check (length(name) between 2 and 120),
  body                  text check (length(body) between 1 and 1024),
  usage_id              uuid references liame.ai_usage (id),
  -- O rascunho do modelo no RegemCast (o id e o nome de lá) e a situação que o RegemCast informou por último, com a
  -- hora em que a rotina olhou: é por ela que cada rascunho é conferido uma vez por intervalo, e não a cada volta.
  template_id           text check (template_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  template_name         text check (length(template_name) between 1 and 512),
  template_language     text check (length(template_language) between 2 and 20),
  template_status       text check (length(template_status) between 1 and 60),
  template_checked_at   timestamptz,
  -- Quando o rascunho do modelo nasceu no RegemCast: a espera pela Meta conta daqui.
  drafted_at            timestamptz,
  -- O pedido de envio que saiu desta proposta.
  message_request_id    uuid references liame.message_request (id) on delete set null,
  attempts              integer not null default 0 check (attempts >= 0),
  next_attempt_at       timestamptz,
  -- Quem propõe é um funcionário de IA (a chave dele), em nome da pessoa de `requested_by`.
  agent_key             text not null check (agent_key ~ '^[a-z][a-z0-9_]{1,40}$'),
  requested_by          uuid references liame.app_user (id) on delete set null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  finished_at           timestamptz,
  -- A promoção sempre parte de uma oferta de Minha marca.
  constraint message_proposal_oferta check (motive <> 'promocao' or offer is not null),
  -- Só existe rascunho ou pedido do que foi escrito e conferido, e o rascunho tem o modelo de lá.
  constraint message_proposal_escrita check (status not in ('rascunho', 'pedido') or (name is not null and body is not null)),
  constraint message_proposal_modelo check (status <> 'rascunho' or (template_id is not null and template_name is not null and drafted_at is not null)),
  -- O que a conferência barrou diz o que barrou, e o texto não fica.
  constraint message_proposal_barrada check ((status = 'barrada') = (barred_by is not null)),
  constraint message_proposal_sem_texto_barrado check (status <> 'barrada' or (name is null and body is null)),
  -- Quem acabou tem a hora em que acabou; quem está no caminho, não.
  constraint message_proposal_fim check ((finished_at is not null) = (status in ('pedido', 'barrada', 'descartada', 'falhou')))
);
create index if not exists idx_message_proposal_tenant on liame.message_proposal (tenant_id);
create index if not exists idx_message_proposal_brand on liame.message_proposal (brand_id, created_at desc);
-- As duas filas da rotina: o que ainda está sendo preparado e o rascunho que espera o modelo.
create index if not exists idx_message_proposal_preparo on liame.message_proposal (next_attempt_at) where status = 'preparando';
create index if not exists idx_message_proposal_rascunho on liame.message_proposal (template_checked_at) where status = 'rascunho';
-- Uma proposta em andamento por marca e por motivo de cada vez: a rotina que roda duas vezes não propõe em dobro.
create unique index if not exists uq_message_proposal_andamento on liame.message_proposal (brand_id, motive) where status in ('preparando', 'rascunho');
-- Um pedido de envio é de uma proposta só.
create unique index if not exists uq_message_proposal_pedido on liame.message_proposal (message_request_id) where message_request_id is not null;

-- ------------------------------------------------------------ RLS e grants

alter table liame.message_proposal enable row level security;
alter table liame.message_proposal force row level security;
drop policy if exists message_proposal_isolamento on liame.message_proposal;
create policy message_proposal_isolamento on liame.message_proposal
  using (tenant_id = liame.current_tenant_id() or liame.system_scope())
  with check (tenant_id = liame.current_tenant_id() or liame.system_scope());
grant select, insert, update on liame.message_proposal to liame_app;
