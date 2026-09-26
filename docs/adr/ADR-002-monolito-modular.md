# ADR-002 — Monólito modular com dois processos

- **Status:** Proposto · 24/09/2026
- **Decide:** forma do sistema e organização do monorepo

## Contexto

O Liame precisa de API HTTP, processamento assíncrono (sync, workflows, IA, connectors) e uma UI web. A equipe é pequena e há vários produtos DMS andando ao mesmo tempo. As diretrizes pedem monólito modular + workers + eventos, sem microsserviços, e sugerem `apps/api`, `apps/worker` e cerca de 14 pacotes em `packages/`.

## Opções

| Critério | A) Um app Nest, dois processos (API e worker) + poucos pacotes | B) `apps/api` + `apps/worker` + `packages/domain`, `actions`, `workflows`… | C) Microsserviços |
| --- | --- | --- | --- |
| Maturidade | Padrão comum em Nest (múltiplos entrypoints) | Viável, mas exige módulos Nest entre pacotes | Madura, mas cara |
| Segurança | Uma superfície de regras só | Igual | Mais superfície (rede entre serviços) |
| Complexidade | **Baixa** | Média/alta: project references, metadados de decorators entre pacotes, risco de ciclos | Alta |
| Custo | Uma imagem, dois contêineres | Duas imagens | N imagens + rede |
| Lock-in | Nenhum | Nenhum | Nenhum |
| Observabilidade | Um bootstrap OTel | Dois | N |
| Manutenção | Refatorar dentro de um app é barato | Mover código entre pacotes é caro | Alto |
| DX | DI do Nest direto, hot reload simples | Builds encadeados | Contratos de rede |
| Ecossistema | `@nestjs/cli` 12 + Turborepo | Idem, com mais configuração | — |

## Decisão

**Opção A.**

```text
apps/web        Next.js 16
apps/server     NestJS 12: main.api.ts (HTTP) e main.worker.ts (pg-boss/workflows)
packages/       contracts · database · ui · telemetry · config · testing
evals/          datasets + runner
```

- Um único `apps/server` com módulos por **domínio** (auth, tenants, organizations, brands, units, users, permissions, integrations, campaigns, creatives, audiences, attribution, orders, messaging, reports, approvals, actions, policies, workflows, audit, ai, billing, flags, tools, connectors). Dentro de cada módulo: `domain/ application/ infrastructure/ http/ events/`, **só as pastas que tiver**, sem burocracia.
- **Pacote só nasce quando dois apps precisam dele.** `ai`, `policy`, `connectors`, `workflows` e `actions` viram pacotes no dia em que o hub MCP (trilha B) ou outro app precisar.
- **Fronteiras checadas por lint:** um módulo importa só o `index.ts` público de outro; nada de importar `infrastructure/` alheio.
- Gerenciador: **pnpm workspaces + Turborepo** (cache de build e testes). As versões ficam no ADR-001.

## Consequências

- O mesmo contêiner-imagem sobe `liame-api` e `liame-worker` com comandos diferentes; cada processo registra só os módulos que usa.
- Escalar = mais réplicas do processo que está no limite (gatilhos em `arquitetura.md` §9).
- Se um domínio precisar escalar ou isolar de verdade no futuro, ele já está isolado por módulo e contrato e sai sem reescrita.

## Revisar quando

Um módulo tiver requisitos de escala, deploy ou segurança muito diferentes do resto, ou outro app precisar do mesmo código.
