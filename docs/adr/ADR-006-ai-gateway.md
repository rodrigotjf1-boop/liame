# ADR-006 — AI Gateway próprio sobre o Vercel AI SDK

- **Status:** Aceito · 26/09/2026 (proposto em 24/09/2026; aprovado com o plano completo pelo dono)
- **Decide:** como o Liame chama modelos de IA sem depender de um fornecedor
- **Base:** comparação de SDKs (base de conhecimento §14.1)

## Contexto

O produto precisa ser provider-agnostic: model routing por tarefa, fallback só para modelo avaliado, custo por tenant, PII sanitizada, aprovação humana no loop e traces. Nenhum SDK reporta custo em US$. Os SDKs mudam rápido: o AI SDK lança um major a cada ~6 meses; o `@anthropic-ai/sdk` e o `@openai/agents` ainda estão em 0.x.

## Opções

| Critério | A) Abstração própria + **Vercel AI SDK 7** por baixo + adapters diretos pontuais | B) Abstração própria + um adapter à mão por SDK oficial | C) Usar um SDK direto no código | D) Gateway externo (LiteLLM/OpenRouter) |
| --- | --- | --- | --- | --- |
| Maturidade | AI SDK Apache-2.0, v7 GA (06/2026) | Oficiais, 0.x | — | LiteLLM teve pacote comprometido no PyPI (03/2026); OpenRouter cobra 5,5% |
| Structured output (Standard Schema) | ✅ nativo | varia por SDK | — | passthrough |
| Tools paralelas, streaming, MCP client, embed, rerank | ✅ | escrever N vezes | — | parcial |
| OTel `gen_ai.*` | ✅ nativo | ❌ | — | callbacks |
| Aprovação humana | `needsApproval` | loop próprio | — | ❌ |
| Custo de manutenção | Baixo (um major a cada ~6 meses, isolado pela abstração) | Alto | Baixo no início, lock-in depois | +1 serviço |
| Lock-in | Baixo | Baixo | **Alto** | Médio; terceiro no caminho dos dados (LGPD) |

## Decisão

**Opção A.**

1. **Interface da DMS** (`apps/server/src/modules/ai`): `generate`, `stream`, `structured<T>`, `embed`, `rerank`, `toolCall`, `agent`. Nenhum módulo importa SDK de provider.
2. **Base: Vercel AI SDK 7** (`ai`), com **`createProviderRegistry` e providers explícitos**. **Proibido model id em string solta**: sem provider explícito, a chamada cai no Vercel AI Gateway.
3. **Adapters diretos** só para o que o AI SDK não expõe: Anthropic Batch (−50%), MCP connector da Anthropic, recursos exclusivos da Responses API da OpenAI e batch do Gemini.
4. **Na nossa camada, nunca no SDK:** tenant, orçamento (AI Usage Ledger), sanitização de PII, **custo** (tabela de preços versionada × tokens, contando os de cache), versões de prompt, ferramenta e modelo, e model routing com fallback só entre modelos com eval aprovado na tarefa.
5. **Durabilidade e aprovação humana no nosso Postgres** (`workflow_run`, `agent_run` com interrupções), multi-tenant. **Não usar** o `WorkflowAgent` (depende do Workflow 5, em beta).
6. **Sem LiteLLM ou OpenRouter no início.** O LiteLLM self-host só entra se aparecer a necessidade de chaves e budgets centralizados entre vários serviços.
7. **Tracing:** atributos `gen_ai.*` nativos do AI SDK exportados pelo nosso OTel (ADR-010). Nunca o tracing padrão do Agents SDK da OpenAI, que manda os dados para a OpenAI.
8. **Evals:** **promptfoo** como portão no CI (MIT; exit code, limiar de aprovação, cache, JUnit). Telemetria desligada (`PROMPTFOO_DISABLE_TELEMETRY=1`, porque foi comprado pela OpenAI em 03/2026). Datasets JSONL versionados em `evals/`. Asserts determinísticos primeiro, depois LLM-as-judge com modelo barato. Limiar inicial de ~95% por tarefa, calibrado no piloto. **Inspect** (Python) só à noite, para agentes e segurança, se precisar.

## Consequências

- Um major do AI SDK afeta um único módulo (o adapter), não o produto.
- O custo de IA é calculado por nós e bate com a fatura por reconciliação mensal.
- O semconv GenAI do OTel ainda está em *Development*: os nomes de atributo podem mudar, e o Collector normaliza.

## Revisar quando

Sair um novo major do AI SDK; um provider exigir recurso sem adapter; ou o volume justificar gateway central.
