-- 0058 · Mensageria: a leitura do RegemCast para a tela Mensagens (A5, Y4; D-A5-10 e D-A5-12).
-- A flag `mensageria`, por empresa, desligada. Ligada, as rotas `GET /v1/messaging` e `GET /v1/messaging/campaigns/:id`
-- leem do RegemCast, na hora em que a pessoa abre a tela, se a conta do WhatsApp pode enviar, o teto de gasto de
-- mensagens, quantos modelos aprovados e públicos há (só contagens) e as campanhas de mensagens com os números e o
-- custo. Nada disso é guardado no Liame, e nenhum telefone ou nome de contato chega a ele.
-- Não é flag de escrita: por ela nada é enviado. O pedido de mensagem (Y5) depende também da `whatsapp_campaign`, que
-- existe desde a 0009 e é de escrita.
-- Idempotente; uma transação por arquivo (ADR-018).

-- A semente da flag grava em tabela com RLS forçada (V20).
select set_config('app.scope', 'sistema', true);

insert into liame.feature_flag (key, kind, default_value, description, owner, is_write)
values ('mensageria', 'boolean', 'false', 'Mensageria: a tela Mensagens lê do RegemCast a situação da conta do WhatsApp, o teto de gasto, os modelos, os públicos (só contagens) e as campanhas de mensagens (A5, Y4)', 'mensageria', false)
on conflict (key) do nothing;
