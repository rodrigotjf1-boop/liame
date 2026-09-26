# ADR-001 — Stack tecnológica

- **Status:** Proposto · 24/09/2026
- **Verificação:** `npm view` (tag `latest`), `nodejs.org/dist/index.json`, release notes e docs oficiais, e inspeção de pacotes (`npm pack`) em 24/09/2026. Detalhes na base de conhecimento §9 e §15.
- **Regra:** versões **fixadas** no lockfile e no `catalogs` do pnpm, e atualizadas de forma consciente.

## Contexto

O plano mestre herdou Next 14 e Nest 10. O projeto ainda não começou, então a stack parte das versões estáveis de hoje, desde que sejam compatíveis entre si. Critérios: maturidade, segurança, complexidade, custo, lock-in, observabilidade, manutenção, DX e compatibilidade.

## Decisão

| Camada | Escolha | Versão | Por quê | Risco / cuidado |
| --- | --- | --- | --- | --- |
| Runtime | **Node.js LTS** | **24.x** (24.21.0) | LTS "Krypton"; atende Nest 12 (≥ 20.19), CLI do Nest (≥ 24.15), pg-boss (≥ 22.12), pnpm 12 (≥ 22), Next (≥ 20.9) | Entra em manutenção em 20/10/2026; **migrar para o Node 26 LTS** (LTS em 28/10/2026) quando as dependências confirmarem suporte |
| Linguagem | **TypeScript** | **6.0.3** no monorepo todo | Única versão com a API de compilador que a CLI do Nest 12 (`typescript ~6.0.2`) e o plugin do swagger exigem | O TS 7.0.2 existe, mas **não tem API programática** (volta na 7.1): proibido no build do Nest. O tsconfig já nasce "limpo para o 7" (`nodenext`/`bundler`, sem `baseUrl`, `types` explícito) |
| Backend | **NestJS** | 12.1.0 (+ cli 12.0.6, swagger 12.0.2) | Pacotes ESM; **Standard Schema nativo** (`@Body({ schema })` + `StandardSchemaValidationPipe`); Express 5.2 | Major recente: spike obrigatório |
| Validação e contratos | **Zod 4** (Standard Schema + Standard JSON Schema) | 4.6.5 | Um schema para validação no Nest, OpenAPI, structured output, ferramentas, eventos e MCP | Usar o Zod "classic" (o `zod/mini` pode não expor JSON Schema); `z.strictObject` para rejeitar campo extra |
| Contrato HTTP | **@nestjs/swagger** com **`setOpenAPIVersion('3.1.0')`** | 12.0.2 | Reflete os schemas Zod no documento | **O padrão ainda é 3.0:** ligar 3.1 explicitamente e revisar nulos |
| Frontend | **Next.js** + **React** | 16.3.6 + 19.3.0 | Turbopack padrão, Cache Components, `proxy.ts`, instrumentação OTel | `proxy.ts` só para checagens leves (o RBAC fica no Nest); sem config `webpack` custom; `outputFileTracingRoot` no standalone; **`cacheComponents: true` desde o início**; React Compiler desligado |
| Estilo | **Tailwind CSS** + `@tailwindcss/postcss` | 4.3.3 | Configuração em CSS; `@theme inline` para tokens semânticos; dark mode por variante | Pacotes compartilhados declarados com `@source`; exige navegadores modernos |
| ORM | **Drizzle ORM** + drizzle-kit | 0.45.3 + 0.31.11 | Estável; RLS (`pgPolicy`, `pgRole`, `.enableRLS()`), helpers Supabase | 1.0 em RC: **não usar `db.query` v1 nem `casing` global**, para facilitar o salto |
| Driver | **pg** | 8.23.0 | Aceito por Drizzle, pg-boss e OTel | Sem prepared statements nomeados no modo transação do Supavisor |
| Filas e workflows | **pg-boss** | 12.34.0 | Envio transacional (`db: fromDrizzle(tx, sql)`), grupos com concorrência (justiça por tenant), DLQ, cron, `flow()` | LISTEN exige conexão direta ou em modo sessão (ADR-005) |
| Banco | **Supabase Postgres 17**, sa-east-1 | 17 | Padrão da plataforma | **Data API (PostgREST) desligada** ou sem GRANT para `anon`/`authenticated`: o backend usa connection string |
| Testes | **Vitest** | 5.0.1 | Padrão dos projetos ESM do Nest 12; o Jest só carrega os pacotes do Nest 12 a partir da v24.9 | — |
| Monorepo | **pnpm** + **Turborepo** | 12.6.0 + 2.11.3 | Defaults de segurança do pnpm 12 (`minimumReleaseAge`, `blockExoticSubdeps`, `strictDepBuilds`) | `turbo prune` com o lockfile do pnpm 12 não validado oficialmente: **pnpm 11 como reserva**; listar `allowBuilds` (swc, esbuild, sharp, oxide) |
| Observabilidade | **OpenTelemetry JS** (`sdk-node`, api 1.9.x, auto-instrumentations) | 0.222.0 | Traces e métricas estáveis | Logs ainda em desenvolvimento; **a instrumentação do Nest 12 não foi publicada** (spans manuais ou interceptor); ESM exige loader hook |
| IA | **Vercel AI SDK** por baixo do AI Gateway (ADR-006) | `ai` 7.0.113 | Standard Schema, tools, streaming, MCP client, OTel `gen_ai.*` | Só ESM; um major a cada ~6 meses |
| MCP (trilha B) | `@modelcontextprotocol/server` | 2.1.0 | SDK v2, spec 2026-07-28 | Exige `"types": ["node"]` no TS 6 |
| Pacotes internos | `contracts`, `database`, `telemetry`, `config`, `testing` **compilados** (tsc); `ui` sem build ("just-in-time", só o Next consome) | — | A doc do Turborepo: pacote sem build só serve a consumidor com bundler (o Nest não é) | — |

### ESM × CommonJS no `apps/server`: decidido pelo spike → **ESM**

O Nest 12 é ESM e aceita app CommonJS via `require(esm)` (Node 24). O Vercel AI SDK 7 é só ESM (funciona em CJS via `require(esm)`, sem top-level await). O OTel em ESM exige `--experimental-loader`. **Hipótese inicial:** CommonJS no `apps/server` (instrumentação mais simples, zero atrito com a CLI) e ESM no `apps/web`. **O spike A0 escolhe com evidência**: build, testes Vitest, OTel de http/pg/undici, import do AI SDK e do SDK MCP.

**Resultado do spike (25/09/2026, A/B no mesmo código, Node 22.23 local; confirmado no [CI](https://github.com/rodrigotjf1-boop/liame/actions/runs/36203403949) com Node 24.21 e Postgres 17):**

| Item | Server CJS (`require(esm)`) | Server ESM |
| --- | --- | --- |
| Build (`nest build`, TS 6.0.3) | **Falha** (TS2345): o `drizzle-orm` resolve como `require` no server e como `import` no `@liame/database` → duas declarações de `SQL` (pacote duplo). Só passa com cast | Passa |
| Nest 12, `StandardSchemaValidationPipe` + Zod, OpenAPI 3.1 | ok | ok |
| pg-boss 12, AI SDK 7 (`generateText` com modelo simulado), MCP 2.1 (`tools/list` e `tools/call` pelo `createMcpHandler`) | ok | ok |
| Traces http + undici + pg, cliente e servidor no mesmo trace | ok | ok, **sem o hook de loader** |
| Avisos do Node | nenhum | nenhum |

**Decisão: `apps/server` em ESM** (`"type": "module"`), no mesmo formato dos pacotes internos e do `apps/web`. Motivo: o CJS funciona em execução, mas mistura formatos dentro do monorepo e cria cópia dupla de `drizzle-orm` e `zod` (ERR-001, LIC-093). O ESM empata em todo o resto.

Consequências medidas:
- **OTel sem `--experimental-loader`:** o SDK sobe por `node --import ./dist/telemetry.js` antes do app; `pg` e `express`/`http` são CommonJS e o gancho de `require` do OTel os instrumenta mesmo importados de ESM; o undici usa `diagnostics_channel`. O hook de ESM (`@opentelemetry/instrumentation/hook.mjs`) só entra quando formos instrumentar um pacote **só ESM** (por exemplo, a instrumentação do próprio Nest 12, que ainda não saiu).
- Regras de código: imports relativos com `.js`; `import.meta.dirname` no lugar de `__dirname`; nada de import circular entre módulos (metadados de decorator são avaliados na definição da classe); `import type` para referência só de tipo.
- Testes: Vitest 5 + `unplugin-swc` (metadados de decorator) e a verificação `dist/spike/verify.js`, que roda o build no Node puro.

### Supply chain no CI

gitleaks, osv-scanner, Semgrep CE, zizmor, licenças, promptfoo por PR. TruffleHog, SBOM (Syft/`pnpm sbom`) e Grype agendados. Actions fixadas por SHA; Dependabot. Detalhe em `security-model.md` §9.

## Consequências

- O spike A0 (critério A0-3) valida a combinação inteira antes da primeira linha de produto.
- A `@nestjs/cli` 12.0.6 foi publicada em 24/09/2026: o `minimumReleaseAge` do pnpm bloqueia por 1 dia. Isso é esperado, e é a proteção funcionando.
- **Versões fixadas no spike (25/09/2026, catálogo do `pnpm-workspace.yaml`):** as da tabela, exceto `ai` **7.0.114**, `turbo` **2.11.4**, `vitest` **5.0.1** e `@types/node` **24.13.6**: as mais novas tinham menos de 1 dia. `minimumReleaseAgeStrict: true`, porque sem ele o pnpm abre a exceção sozinho (ERR-002). Scripts de instalação revisados e **bloqueados**: `@swc/core`, `protobufjs`, `@scarf/scarf` (nenhum é necessário; o do swc instalaria `@swc/wasm` por fora do lockfile).
- O Turborepo exige o executável `pnpm` no PATH (ERR-006): no CI, `pnpm/action-setup` v6.1.0 (suporta o pnpm 12).
- Revisar este ADR a cada release relevante: Node 26 LTS, TS 7.1 com API, Drizzle 1.0 estável, OTel com instrumentação do Nest 12, novo major do AI SDK.
