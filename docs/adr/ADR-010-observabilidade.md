# ADR-010 — Observabilidade com OpenTelemetry e backends trocáveis

- **Status:** Aceito · 26/09/2026 (proposto em 24/09/2026; aprovado com o plano completo pelo dono)
- **Decide:** instrumentação, pipeline de telemetria e destinos
- **Base:** base de conhecimento §14.3

## Contexto

As diretrizes pedem um `trace_id` de ponta a ponta (Next → API → workflow → worker → agente → ferramenta → política → ação → connector → provider), métricas de infraestrutura para decidir upgrade, observabilidade de IA e nenhum acoplamento a fornecedor. O custo inicial precisa ser baixo, e há LGPD: telemetria não pode carregar PII.

## Decisão

1. **Instrumentação OpenTelemetry**:
   - `@opentelemetry/sdk-node` no Nest (API e worker);
   - instrumentation hook no Next 16;
   - auto-instrumentação de http, undici e pg;
   - spans manuais em workflow, ferramenta, política, ação e connector;
   - `gen_ai.*` vindo do AI SDK;
   - `traceparent` propagado nos jobs do pg-boss e no `_meta` do MCP.
2. **OpenTelemetry Collector (contrib)** num contêiner próprio no EasyPanel, com:
   - `memory_limiter` e `batch`;
   - **redação de PII** (processor de atributos);
   - tail sampling: 100% de erro e de ação financeira, amostragem no resto;
   - **routing**: spans `gen_ai.*` → backend de LLM, e tudo → backend geral.

   Trocar de fornecedor = trocar exporter.
3. **Backend geral: Grafana Cloud Free, região Brasil** (traces, logs, métricas; 50 GB de logs e 50 GB de traces, 10 mil séries).
   - **`tenant_id` nunca vira label de métrica** (estoura as séries); vai em traces e logs.
   - Escala: Grafana Cloud Pro (~US$19 + uso) ou SigNoz.
4. **Erros:** Sentry (Developer/Team) para exceções, source maps e releases, com o tracing do Sentry desligado ou amostrado para não duplicar.
5. **LLM:** Langfuse Cloud Hobby no início (recebe OTLP por HTTP e mapeia `gen_ai.*`), **só com conteúdo já sanitizado**.
   - Se os prompts não puderem sair da infraestrutura: Arize Phoenix self-host (contêiner único).
   - Langfuse self-host só com VM dedicada (≥ 4 cores, 16 GB).
   - **Helicone descartado:** em modo de manutenção desde a aquisição.
6. **Painel interno de IA** (métricas de produto, não só de infraestrutura), a partir do AI Usage Ledger: custo por tenant, workflow e resultado; approval rate; override; violações; sucesso; latência p95.
7. **Gatilhos de upgrade** medidos por essa telemetria (`arquitetura.md` §9).
8. **Separação:** log operacional (retenção curta) ≠ auditoria (Postgres append-only + âncora, ADR-011).

## Consequências

- Custo inicial estimado de **US$0–30/mês**.
- Mais um contêiner (Collector) para operar, e é nele que ficam as regras de PII e amostragem.
- O semconv GenAI ainda está em *Development*: normalizar nomes no Collector quando mudarem.
