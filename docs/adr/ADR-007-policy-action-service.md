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

## Implementação do kill switch (E6a, 26/09/2026)

- Tabela `kill_switch` (migration 0009) com os seis níveis e a forma de cada um checada no banco. `KillSwitchService.check(tx, alvo)` devolve a trava mais ampla que pega o alvo (empresa, provedor, marca, conta, ferramenta); o Action Service (E6c) chama antes de executar, e a trava prevalece sobre flags e autonomia.
- A empresa aciona e desliga as suas (`/v1/kill-switches`, permissão `parada.acionar`: Dono, Administrador e Gestor), com auditoria (`parada.acionar`, `parada.desligar`) e evento `liame.kill_switch.activated`/`deactivated` (a pausa das entidades criadas pelos agentes entra com os connectors, A2). Global e provedor são da distribuição (escopo de sistema); a empresa vê, mas não desliga.

## Implementação do motor de políticas (E6b, 26/09/2026)

- **Documento** (`PolicyDocument`, contrato em Zod): regras `max_value`, `max_change_percent`, `allowed_hours`, `allowed_accounts`, `allowed_scope`, `forbidden_categories`, `forbidden_words`, `rate_limit` e `autonomy`. Ações em português com curinga (`orcamento.*`).
- **Motor** (`apps/server/src/policy/engine.ts`): função pura. Qualquer violação nega; o modo vem da regra de autonomia mais específica (seletores de ação, ferramenta, conta, risco e faixa; no empate, marca > empresa > plataforma), ESCALATE vence sempre, e sem regra o modo é SHADOW. A contagem para `rate_limit` vem de quem pede (o Action Service conta as execuções).
- **Camadas:** a política da **plataforma** fica no código (versão 1: conteúdo político bloqueado, Meta no máximo 3 mudanças de orçamento por hora, `campanha.apagar` escala) e vale sempre; a da **empresa** e a da **marca** ficam em `liame.policy` (migration 0010), versionadas, uma ativa por escopo, documento imutável.
- **`@Politica(ação, proposta)`** (ADR-013): interceptor logo depois da unidade de trabalho avalia na transação da requisição; negou → 422 `politica-negou` com cada regra em `errors`; permitiu → o handler lê o modo com `currentPolicyDecision()`.
- **Ainda não:** Revisor de Compliance de IA (A3), Policy Templates com priors das skills e presets por segmento (A2/A3).

## Implementação do pedido de ação (E6c, 26/09/2026)

- **Registro de ferramentas** no código (`apps/server/src/actions/tools.ts`): nome, risco, provedores, compensação, parâmetros (Zod) e uma função pura `plan(estado, parâmetros)` que dá a ação para a política (`orcamento.aumentar`/`reduzir`), o impacto, os valores e o estado desejado. Quem pede manda só ferramenta, alvo e parâmetros.
- **Conector sandbox** (`sandbox_resource`, migration 0011): provedor de mentira no banco, com versão (concorrência otimista) e `validateOnly`; os reais chegam na A2 pela mesma interface.
- **Pedido** (`POST /v1/actions`): trava (423) → flag de escrita do provedor → estado lido no provedor → política com a contagem recente na maior janela que casa (422) → `action_fingerprint` único entre os ativos (409; simultâneos esperam o índice e caem em 409) → reserva no envelope do mês, com a linha do envelope travada (422) → plano com `plan_hash` (ferramenta, alvo, parâmetros, valores, estado desejado e versão lida).
- **Modos:** `SHADOW` registra e não reserva; `LIMITED_AUTO`/`AUTO` só saem aprovados com a flag `autopilot` ligada (nasce desligada); os demais esperam aprovação; `ESCALATE` só o dono.
- **Aprovação** (`POST /v1/actions/{id}/approve`): código do app agora (step-up, sem código de recuperação, sem repetir passo) + o `plan_hash` visto. Basta quando o limite de quem aprova cobre a reserva; senão fica registrada e o dono é avisado. Alterar o pedido gera hash novo e a aprovação antiga deixa de valer.
- **Orçamento:** `budget_policy` (envelope do mês da empresa e da marca, no fuso da empresa) e `budget_ledger_entry` só de inserção (`reserva`, `liberacao`, `execucao`); cancelar devolve a reserva.
- **Falta (E6d):** execução no worker, workflow durável, expiração e o teste ponta a ponta do A1-9.
