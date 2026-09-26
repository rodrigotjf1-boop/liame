# Liame — Andamento

> Onde a implementação está, critério por critério (`roadmap.md` §3). Atualizar a cada entrega, com a evidência.
> Início da implementação: **25/09/2026**, por ordem do dono ("carregar o roadmap do plano v9 e começar a implementar").

## Fase A0 · Fundação e decisões

| # | Critério | Situação | Evidência / o que falta |
| --- | --- | --- | --- |
| A0-1 | ADR-001 a ADR-010 aceitos | ⏳ dono | Os ADRs seguem "Proposto". Aceite é do dono, registrado no arquivo com data. O ADR-001 já traz a decisão ESM do spike. |
| A0-2 | 8 docs aprovados | ⏳ dono | Registro no changelog de `decisoes-design.md`. |
| A0-3 | Spike de compatibilidade verde no CI | ✅ **cumprido em 25/09/2026** | CI verde em checkout limpo (Node 24.21 + Postgres 17, 16/16 testes + verificação do spike): https://github.com/rodrigotjf1-boop/liame/actions/runs/36203403949 · nota no ADR-001 · estratégia em `testes.md`. |
| A0-3b | Contas AWS (KMS sa-east-1 e conta da âncora) | ⏳ dono | IDs das contas, sem segredo. |
| A0-4 | Mockups aprovados (Lite e Pro) | ⏳ dono | Protótipo em `mockups/prototipo-app.html` (verificado: 24 cenários, 4 larguras, claro e escuro). |
| A0-5 | Pedidos às plataformas | ⏳ dono | Meta, Google Cloud/Ads, TikTok, GBP. |
| A0-6 | Termos, privacidade e contrato de operador publicados | ⏳ | Landing no ar sem essas páginas. Posso redigir os rascunhos para revisão jurídica. |
| A0-7 | Restaurante de testes confirmado | ⏳ dono | Checklist, incluindo o número de WhatsApp na API oficial. |
| A0-8 | Supabase São Paulo, EasyPanel, Cloudflare | ⏳ dono | Cloudflare pronta (domínio). |
| A0-9 | Plano do token por loja do Regem (C1) | ⏳ | Issue/plano no Regem. |
| A0-10 | Threat model v1 revisado | ⏳ | `security-model.md`. |

## A0-3 · Spike de compatibilidade (25/09/2026)

**Montado:** monorepo pnpm 12.6 + Turborepo 2.11.4 com `apps/server` (Nest 12.1, API + worker), `apps/web` (Next 16.3.6, React 19.3, Tailwind 4.3 com os tokens do protótipo), `packages/config` (presets de TS), `packages/contracts` (Zod), `packages/database` (Drizzle 0.45 + pool + `withTenant`), `packages/telemetry` (OTel http/undici/pg). CI em `.github/workflows/ci.yml`.

**Decisão ESM × CJS:** **ESM** no server, com A/B medido (ADR-001, ERR-001).

| Prova pedida | Onde | Local (Node 22.23, Windows, PG 18.4) e CI |
| --- | --- | --- |
| Build de tudo | `pnpm build` | ✅ (e em checkout limpo com `--frozen-lockfile`) |
| Tipos, incluindo testes | `pnpm typecheck` | ✅ |
| `StandardSchemaValidationPipe` com Zod | `test/api.e2e.spec.ts` + `verify.js` | ✅ 201 com valor transformado; 400 com o campo; campo extra recusado |
| OpenAPI 3.1 | `test/openapi.spec.ts` + `verify.js` | ✅ `3.1.0`, corpo e resposta a partir do Zod, `/health` fora do `/v1` |
| Trace de http, undici e pg | `verify.js` (Node puro, sem Vitest) | ✅ mesmo trace cliente → servidor; pg só na tentativa de conexão (sem banco) |
| Envio transacional do pg-boss | `test/db/pgboss.spec.ts` | ✅ commit cria o job, rollback desfaz (PG 18.4 local, papéis sem superusuário) |
| RLS forçada + contexto por transação | `test/db/rls.spec.ts` | ✅ 6 testes: role sem BYPASSRLS, isolamento, sem contexto nada, sem gravação cruzada, contexto não vaza no pool, concorrência |
| AI SDK 7 e SDK MCP 2.1 | `verify.js` | ✅ `generateText` com modelo simulado; `tools/list` e `tools/call` |
| Node 24 + Postgres 17 | CI | ✅ [execução 36203403949](https://github.com/rodrigotjf1-boop/liame/actions/runs/36203403949): 1 min 28 s |

**Como rodar:** ver o README.

## Skills em uso

- **errei:** registro do projeto em `ERROS-CONHECIDOS.md` (fora do git), ERR-001 a ERR-006; lições gerais LIC-093 a LIC-097.
- **ui-ux-proprio:** o `apps/web` nasce com os tokens do protótipo aprovado; as telas são portadas na A1, na ordem do mockup, com o checklist da skill.
- **cupom-fiscal:** sem uso na A0. Entra na A2.5 (a receita "confirmada no caixa" vem das vendas do Regem, onde a NFC-e é a prova fiscal) e na A7 (cobrança do Liame: nota de **serviço**, NFS-e, que a skill não cobre; será pesquisada).
