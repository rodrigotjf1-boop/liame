# Liame

Plataforma operacional multi-tenant de crescimento e marketing da DMS Tecnologia. Para o cliente, funciona como uma agência completa: cada agente de IA, com suas responsabilidades, é um funcionário.

> **Estado:** fase **A0** (fundação). Spike de compatibilidade montado e verde localmente; nenhuma funcionalidade de produto ainda. Andamento em [docs/andamento.md](docs/andamento.md).

## Estrutura

```text
apps/server       NestJS 12 (ESM): main.api.ts (HTTP) e main.worker.ts (pg-boss)
apps/web          Next.js 16 + React 19 + Tailwind 4
packages/config   presets de TypeScript
packages/contracts  schemas Zod (validação, OpenAPI, ferramentas, eventos)
packages/database   Drizzle + pool do Postgres + contexto de tenant por transação (RLS)
packages/telemetry  OpenTelemetry (http, undici, pg)
```

## Como rodar

Requisitos: Node **24** (o CI usa o 24; localmente, 22.22.3+ também funciona) e **pnpm 12.6**, que vem do campo `packageManager`.

O Turborepo precisa do executável `pnpm` no PATH: `npm install -g pnpm@12.6.0` (o pnpm global troca sozinho para a versão do `packageManager` de cada projeto; o corepack deixou de vir com o Node a partir do 25).

```bash
pnpm install          # lockfile congelado no CI: pnpm install --frozen-lockfile
pnpm build            # pacotes, server e web
pnpm typecheck        # tipos, incluindo os testes
pnpm test             # Vitest + verificação do spike (node dist/spike/verify.js)
```

Contrato da API (OpenAPI 3.1): `pnpm openapi` regera `docs/openapi.json` a partir do código (o CI reprova se estiver desatualizado); `pnpm openapi:lint` roda o Spectral (binário da release oficial, [spectral 6.16.3](https://github.com/stoplightio/spectral/releases/tag/v6.16.3), no PATH). O SDK `@liame/sdk` é gerado do contrato a cada build.

Migrations (ADR-018): `pnpm db:migrate` (liame_dev) e `pnpm db:migrate:test` (liame_test), depois do build. Na nuvem, o dono roda o mesmo comando com a URL do `liame_owner`.

Banco local, uma vez por máquina: `node packages/database/scripts/bootstrap.mjs --admin-env-file <.env com a URL de administrador> --write-env` cria os papéis `liame_owner` e `liame_app` e os bancos `liame_dev` e `liame_test`, e grava as URLs no `.env.local` (fora do git). Sem ele, os testes de banco são pulados. Estratégia completa e equivalência com a nuvem em [docs/testes.md](docs/testes.md).

Para desligar a telemetria das ferramentas: `TURBO_TELEMETRY_DISABLED=1` e `NEXT_TELEMETRY_DISABLED=1`.

API local com telemetria no console:

```bash
cd apps/server
OTEL_TRACES_EXPORTER=console node --enable-source-maps --import ./dist/telemetry.js dist/main.api.js
```

## Documentos

| Documento | Conteúdo |
| --- | --- |
| [docs/andamento.md](docs/andamento.md) | **Onde a implementação está**, critério por critério |
| [docs/testes.md](docs/testes.md) | Como testamos: papéis, Postgres local × CI × nuvem, o que cada suíte prova |
| [docs/revisao-plano-mestre.md](docs/revisao-plano-mestre.md) | Classificação de cada decisão do plano mestre (MANTER/ALTERAR/REMOVER/ADIAR/INVESTIGAR), contradições, revisão crítica |
| [docs/especificacao.md](docs/especificacao.md) | Produto: definição, tese, funcionários, princípios, menu, critério de sucesso, KPIs |
| [docs/arquitetura.md](docs/arquitetura.md) | Arquitetura consolidada, caminho de escrita, Tool Registry, workflows, eventos, connectors, código, infra, observabilidade |
| [docs/ai-architecture.md](docs/ai-architecture.md) | AI Gateway, model routing, autonomia, readiness, sombra, evals, governança |
| [docs/data-model.md](docs/data-model.md) | Tenancy, mídia canônica, métricas temporais, ciclo fechado, consentimento, ações, auditoria, retenção |
| [docs/security-model.md](docs/security-model.md) | Ameaças, isolamento, segredos, LGPD, auditoria, supply chain |
| [docs/integrations.md](docs/integrations.md) | Connectors, plataformas, pré-requisitos nos produtos DMS, pontos de falha do ciclo fechado |
| [docs/roadmap.md](docs/roadmap.md) | Trilhas A–D, fases A0–A8, critérios de saída da A0 e da A1 |
| [docs/decisoes-design.md](docs/decisoes-design.md) | Decisões, design system, changelog |
| [docs/ux-modelo-interface.md](docs/ux-modelo-interface.md) | Modelo de interface (Central da agência, Lite e Pro) |
| [docs/base-conhecimento.md](docs/base-conhecimento.md) | **Base de conhecimento do nicho** (consulta obrigatória; regra em [CLAUDE.md](CLAUDE.md)) |
| [docs/adr/](docs/adr/) | ADR-001 a ADR-017 |
