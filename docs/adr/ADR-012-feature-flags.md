# ADR-012 — Feature flags com OpenFeature e provider próprio no Postgres

- **Status:** Proposto · 24/09/2026
- **Base:** base de conhecimento §14.2

## Contexto

Funcionalidades de risco (`meta_write`, `google_write`, `autopilot`, `mcp_write`, `creative_generation`, `whatsapp_campaign`) precisam ligar por ambiente, plano, marca, tenant, conta e usuário, sem serviço novo no início e sem prender o código a um fornecedor.

## Opções resumidas

| Opção | Serviço novo? | Multi-tenant | Veredito |
| --- | --- | --- | --- |
| **OpenFeature + tabela própria no Postgres** | Não | Total (nós modelamos) | **Início** |
| Flagsmith self-host (BSD-3, Postgres) | Sim | Identities e segments | Escala |
| Unleash | Sim | Sim | OSS limitado a 2 ambientes; Enterprise pago |
| flagd | Sidecar | JSON Logic | Se a preferência virar flags-as-code |
| GrowthBook | Sim (exige MongoDB) | Sim | Só se A/B virar prioridade |
| PostHog | Cloud | Sim | Self-host sem suporte oficial |

## Decisão

- **Padrão OpenFeature** no servidor (`@openfeature/server-sdk`). O `nestjs-sdk` ainda é 0.x: usar o server-sdk com um provider nosso.
- **Provider próprio no Postgres:**
  - `feature_flag` (chave, tipo, default, dono, expiração);
  - `feature_flag_rule` (`scope_type` ∈ ambiente/plano/marca/tenant/conta/usuário, `scope_id`, valor, % de rollout, janela de datas);
  - **precedência:** usuário > conta > tenant > marca > plano > ambiente > default;
  - cache em memória invalidado por `LISTEN/NOTIFY`, com TTL de segurança;
  - mudanças auditadas.
- **Front:** endpoint **OFREP** no Nest + provider OFREP oficial no Next. O front só recebe flags já avaliadas.
- **Entitlements ≠ flags:** o que o plano libera (billing) é outra tabela, não flag de release.
- Flags de escrita **nascem desligadas**. Kill switch (ADR-007) é mecanismo separado e prevalece sobre qualquer flag.

## Consequências

Migrar para Flagsmith ou Unleash depois = trocar o provider (multi-provider do OpenFeature permite migrar aos poucos).
