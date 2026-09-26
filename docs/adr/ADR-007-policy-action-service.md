# ADR-007 — Policy Engine determinístico + Action Service

- **Status:** Aceito · 26/09/2026 (proposto em 24/09/2026; aprovado com o plano completo pelo dono)
- **Decide:** como qualquer ator (humano, agente, API, automação, MCP, parceiro) muda algo fora do Liame

## Contexto

Agentes vão propor gasto de dinheiro real e envio de mensagens a clientes. Quem gasta verba sem controle, bloqueia conta de anúncio ou fere a LGPD destrói a confiança no produto. LLM não é mecanismo de controle.

## Decisão

### Fluxo único

```text
Ator → Tool (Tool Registry) → Policy Engine → Serviço de domínio → Action Request (plan_hash, action_fingerprint)
     → Budget Engine (reserva no ledger) → Approval (se exigida) → Action Service → Connector → Provider
     → Audit + Outbox
```

### Policy Engine

- **Determinístico e versionado.** Regras: orçamento, teto, % máxima de mudança, horário, conta permitida, tenant, escopo, consentimento, opt-out, frequência de envio, palavras e categorias proibidas, temas regulados, **conteúdo político** (bloqueado por padrão), ações destrutivas, limites de mudança por provider (Meta: no máximo 4 mudanças de orçamento por hora por conjunto, e o nosso limite fica abaixo).
- **Avaliação:** `Action → regras determinísticas → (Revisor de Compliance de IA, se a regra pedir) → aprovação → execução`. A IA só assessora (texto, tom, alegações). **O código decide.**
- **Forma:** políticas como dado (YAML/JSON validado por schema) avaliadas por um motor TypeScript próprio e simples. Cedar e OPA foram considerados. Adotá-los fica para quando as políticas passarem de dezenas de regras ou vierem de terceiros, porque hoje seriam mais uma linguagem e mais um runtime sem ganho proporcional.
- **Autonomia:** 6 modos (`SHADOW`, `SUGGEST`, `APPROVAL`, `LIMITED_AUTO`, `AUTO`, `ESCALATE`) por tenant, marca, conta, ferramenta, ação, valor e risco (`ai-architecture.md` §4).
- **Priors:** heurísticas de mídia como Policy Templates versionados, com fonte, confiança e override.

### Action Service

- **Única porta de escrita externa.** Nenhum agente recebe token de plataforma.
- Antes de executar, checa: kill switch (global, provider, tenant, marca, conta, ferramenta), feature flag, validade da aprovação (hash do plano), `action_fingerprint` (impede duplicata concorrente), circuit breaker do provider.
- Execução com `validate_only` quando o provider oferecer; **criação sempre pausada**; idempotência por chave ou fingerprint.
- Registra `before_state`, `expected_state`, `desired_state`, `provider_version`, `executed_at`, ator e aprovação.

### Compensação (em vez de "desfazer")

Toda ação declara `compensation_strategy`. Para reverter: `readState()` → se o estado atual **≠ `expected_state`**, alguém (provavelmente humano) mexeu depois: **não sobrescreve**, escala. Concorrência otimista quando o provider permitir (versão ou ETag).

### Orçamento

Ledger com lock por conta: `budget_policy → requested → reserved → executed → reported → actual_spend`. Orçamento configurado ≠ gasto real. Teto também dentro da plataforma (`spend_cap` na Meta) como última barreira. Disjuntor: gasto real acima do envelope → pausa e alerta.

### Aprovação

Amarrada ao `plan_hash`; plano alterado invalida a aprovação. Ações com risco ≥ R2 ou `budget_impact > 0` são aprovadas **fora do chat** (tela com login + PIN/2FA). O link de 1 toque pelo WhatsApp é de uso único, com TTL curto, amarrado a plano + usuário + aparelho, e **só** para risco baixo sem impacto financeiro.

## Consequências

- Toda ferramenta nova só entra com risco, impacto financeiro, estratégia de compensação e testes de política.
- O Action Service é a peça mais testada do sistema (critérios A1-9 a A1-11).
