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

## Implementação (E8, 26/09/2026)

- **Redação na app:** `RedactingSpanExporter` (`packages/telemetry`) envolve o exportador OTLP; o que sai do processo não tem e-mail, telefone, CPF, CNPJ, parâmetros sensíveis de URL (`token`, `code`, `email`…) nem cabeçalho de credencial, e o IP de quem chama vira /24. O endereço do servidor chamado (`server.address`) não é dado pessoal e fica.
- **Trace de ponta a ponta:** o `traceparent` da requisição é gravado no pedido de ação e no evento (migration 0014); o executor e o entregador de webhooks do worker continuam o mesmo trace. Spans manuais: `politica.avaliar`, `orcamento.reservar`, `acao.executar`, `conector.validar`, `conector.aplicar`, `webhook.entregar` (atributos só com ids e códigos).
- **Verificação:** `dist/scripts/trace-check.js` roda no `pnpm test` do servidor com o carregamento real de módulos (OTel antes do Nest, do http e do pg).
- **Collector:** `infra/otel-collector.yaml` com `memory_limiter`, `redaction` (valores com cara de e-mail, telefone, CPF, CNPJ viram `****`), `transform` (IP /24, cookie e autorização fora), `tail_sampling` (100% de erro e de ação, 20% do resto) e exportador OTLP para o Grafana (`GRAFANA_OTLP_ENDPOINT`, `GRAFANA_OTLP_AUTH`). Validado com `otelcol-contrib validate` 0.161.0 e testado com um span de verdade.
- **Pendente:** conta do Grafana Cloud (região Brasil), contêiner do Collector no EasyPanel e o print do trace (A1-14); Sentry e Langfuse entram com a IA (A3).
