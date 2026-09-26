# Liame — Como testamos (e por que funciona igual na nuvem)

> Decidido em 25/09/2026 (spike A0-3). Princípio: **o teste roda com os mesmos papéis, as mesmas regras de conexão e o mesmo major do Postgres da nuvem.** O que passa aqui não pode depender de privilégio que a produção não tem.

## 1. Três lugares, um desenho

| | Local | CI (portão) | Nuvem (Supabase) |
| --- | --- | --- | --- |
| Postgres | 18 da máquina (bancos `liame_dev` e `liame_test`, isolados dos do Regem) | **17** (contêiner `postgres:17`) | **17** (sa-east-1) |
| Quem cria os papéis | `bootstrap.mjs` com o administrador local, uma vez | `bootstrap.mjs` com o superusuário do contêiner | o dono, uma vez, pelo SQL do painel (sem criar banco; o `postgres` de lá não é superusuário) |
| Dono das tabelas | `liame_owner` (sem superusuário) | `liame_owner` | `liame_owner` |
| Aplicação | `liame_app` (sem BYPASSRLS, não é dona de nada) | `liame_app` | `liame_app`, pelo pooler em modo transação |
| Filas (pg-boss) | conexão em sessão | conexão em sessão | conexão direta ou pooler em modo sessão (ADR-005) |

- **Superusuário nunca aparece no caminho do teste.** Ele só roda o bootstrap. Assim, uma permissão que falte na nuvem falha aqui primeiro.
- **O local é o 18, a nuvem é o 17.** Recurso que só existe no 18 (por exemplo, `uuidv7()` nativo) é proibido; o CI no 17 barra.
- **Contexto do tenant por transação** (`set_config(..., true)`), como exige o pooler em modo transação. Os testes provam que o contexto não vaza entre transações nem entre conexões concorrentes.

## 2. Comandos

```bash
# uma vez por máquina (URL de administrador do Postgres local num .env, nunca no terminal)
node packages/database/scripts/bootstrap.mjs --admin-env-file <arquivo .env> --write-env

pnpm test   # Vitest (API, OpenAPI, RLS, pg-boss) + verificação do spike no Node puro
```

O `.env.local` da raiz (fora do git) guarda as URLs dos papéis `liame_*`. Sem `TEST_DATABASE_URL` e `TEST_DATABASE_URL_OWNER`, os testes de banco são pulados, e o CI não pula.

## 3. O que cada suíte prova

| Suíte | Prova |
| --- | --- |
| `test/api.e2e.spec.ts` | validação por Standard Schema (Zod): corpo válido transformado, inválido com 400, campo extra recusado |
| `test/openapi.spec.ts` | OpenAPI 3.1 com corpo e resposta vindos do Zod |
| `test/db/rls.spec.ts` | papel da aplicação sem superusuário nem BYPASSRLS; isolamento entre tenants; sem contexto não lê nem grava; não grava linha de outro tenant; contexto morre com a transação; transações concorrentes não se misturam |
| `test/db/pgboss.spec.ts` | envio do pg-boss na transação da aplicação: o commit cria o job, o rollback desfaz |
| `dist/spike/verify.js` | o build roda no Node sem transformação (ESM): Nest 12, OpenAPI, pg + Drizzle, AI SDK 7, MCP 2.1 e traces de http, undici e pg no mesmo trace |

## 4. A partir da A1: migrations

- As tabelas do spike são criadas pelos próprios testes. A partir da A1, o banco de teste passa a ser preparado **pelas migrations, com o mesmo executor que aplica na nuvem**: o que o CI aplicou no 17 é o que vai para o Supabase.
- Divisão de trabalho, como no Regem: **eu aplico e testo no local; o dono aplica na nuvem.** Depois de aplicar, conferir as colunas no banco real (LIC-011).
- Toda tabela com `tenant_id` nasce com `ENABLE` + `FORCE ROW LEVEL SECURITY` + política + GRANT para `liame_app` na mesma migration (ADR-003); um teste enumera as tabelas e falha se faltar (critério A1-1).
