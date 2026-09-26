# ADR-004 — Eventos com outbox, inbox e webhooks assinados

- **Status:** Aceito · 26/09/2026 (proposto em 24/09/2026; aprovado com o plano completo pelo dono)
- **Decide:** como mutações viram eventos e como eventos externos entram

## Contexto

Mutação salva com evento perdido (ou evento publicado com a mutação desfeita) quebra auditoria, webhooks para parceiros, projeções de atribuição e workflows. As plataformas reenviam webhooks e às vezes os enviam fora de ordem.

## Opções

| Critério | A) Outbox no Postgres + pg-boss | B) Broker externo (Kafka/RabbitMQ/NATS) | C) Publicar direto após o commit |
| --- | --- | --- | --- |
| Garantia | Atômica com a mutação | Precisa de outbox mesmo assim | Perde eventos em falha |
| Complexidade | Baixa | Alta | Baixa, mas errada |
| Custo | Zero a mais | Serviço novo | Zero |
| Observabilidade | Tabelas consultáveis | Ferramentas do broker | — |

## Decisão

**Opção A.**

- **Outbox:** `BEGIN → mutação de domínio → INSERT outbox → COMMIT`. O worker lê (SKIP LOCKED) e publica em jobs, webhooks de saída e projeções. Entrega **pelo menos uma vez**, e quem consome é idempotente.
- **Inbox:** `receber → verificar assinatura → persistir cru → deduplicar (external_event_id UNIQUE) → ACK → processar assíncrono`. Nada crítico antes de persistir (LIC-009).
- **Envelope:** CloudEvents 1.0 (`id`, `source`, `type`, `specversion`, `time`, `tenantid` como extensão). Catálogo em **AsyncAPI 3**.
- **Webhooks de saída:** Standard Webhooks (HMAC-SHA256, `webhook-id`, `webhook-timestamp`, `webhook-signature`), retry exponencial por até cerca de 3 dias, DLQ, reenvio manual. Svix self-host fica como opção se o volume exigir.
- **Ordem:** consumidores não assumem ordem global; usam `occurred_at` + versão do recurso.

## Consequências

- Tabelas `outbox`, `inbox_event` e `webhook_delivery` com retenção definida (`data-model.md` §9).
- Teste de atomicidade com falha simulada entre commit e publicação (A1-7).

## Implementação (E5, 26/09/2026)

- **Outbox:** `emitEvent(tx, …)` grava em `liame.outbox_event` na transação da requisição (marca criada, convite, entrada, mudança e remoção de acesso). O publicador do worker pega lotes com `FOR UPDATE SKIP LOCKED`, cria as entregas de cada endpoint interessado e marca o evento como publicado na mesma transação.
- **Tipos de evento** em inglês, como os campos JSON (`liame.brand.created`); envelope CloudEvents 1.0 com `source` `urn:liame` e `tenantid`. Os dados levam ids, níveis e valores, sem e-mail.
- **Webhooks de saída:** segredo `whsec_` por endpoint, guardado no cofre e mostrado uma vez; `webhook-id` = id do evento (igual em todas as tentativas). Esperas de 5 s, 5 min, 30 min, 2 h, 5 h, 10 h, 14 h, 20 h e 24 h (10 tentativas, ~3 dias); depois, fila de mortos; reenvio manual volta para a fila. A chamada HTTP acontece fora da transação, com reserva de 2 minutos.
- **SSRF:** só https (http apenas em desenvolvimento e testes), sem usuário na URL, sem seguir redirecionamento, e o endereço resolvido na hora da conexão não pode ser privado, loopback, link-local, reservado, IPv4 mapeado nem NAT64.
- **Inbox:** `POST /v1/inbox/{provider}` pública; provedores e segredos por configuração (`INBOX_SECRETS`); verifica a assinatura Standard Webhooks sobre o corpo cru, grava, deduplica por (`provider`, `webhook-id`) e responde 202 (também na repetição). O worker processa só provedores com processador registrado (os connectors chegam na A2), cada evento num savepoint; falha soma tentativa e guarda o motivo.
- **Idempotency-Key** (rotas autenticadas que mudam dado): a chave é reservada e a resposta gravada na mesma transação da mutação; pedido simultâneo com a mesma chave espera o primeiro e recebe a mesma resposta (`Idempotent-Replayed: true`); outro método, caminho ou corpo com a mesma chave → 422; resposta de erro não é gravada; validade de 24 horas; chave por pessoa e empresa.
- **Ainda não:** catálogo AsyncAPI 3 e retenção/expurgo das tabelas (E7).
