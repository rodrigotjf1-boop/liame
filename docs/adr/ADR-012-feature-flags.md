# ADR-012 — Feature flags com OpenFeature e provider próprio no Postgres

- **Status:** Aceito · 26/09/2026 (proposto em 24/09/2026; aprovado com o plano completo pelo dono)
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

## Implementação (E6a, 26/09/2026)

- Tabelas `feature_flag` e `feature_flag_rule` (migration 0009), só no escopo de sistema: a empresa não lê regra, recebe só o valor avaliado. O banco recusa flag de escrita com padrão ligado.
- `FlagService` registra o provider `liame-postgres` no OpenFeature (domínio `liame`) e mantém um retrato das flags em memória por **15 segundos** (sem LISTEN/NOTIFY por ora: a API usa o pooler em modo transação). Rollout pelo balde estável `sha256(flag:empresa) % 100`.
- **OFREP** em `/v1/ofrep/v1/evaluate/flags` (lote, com `ETag`/304) e `/v1/ofrep/v1/evaluate/flags/{key}`: empresa e pessoa vêm da sessão; do contexto enviado, só a marca, e só se for da empresa ativa.
- Seis flags de escrita semeadas e desligadas: `meta_write`, `google_write`, `autopilot`, `mcp_write`, `creative_generation`, `whatsapp_campaign`. Criar ou mudar regra é da distribuição (console, A1/A7); a auditoria da mudança entra com o console. Enquanto o console não existe, a distribuição liga e desliga por empresa com `scripts/ligar-flag` (01/10/2026), que usa o papel dono do banco (o do aplicativo continua sem poder gravar regra) e registra na auditoria da empresa quem decidiu e por quê (`flag.ligar`, `flag.desligar`).
