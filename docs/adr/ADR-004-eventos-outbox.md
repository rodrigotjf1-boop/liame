# ADR-004 — Eventos com outbox, inbox e webhooks assinados

- **Status:** Proposto · 24/09/2026
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
