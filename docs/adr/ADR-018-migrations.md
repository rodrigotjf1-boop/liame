# ADR-018 — Migrations: SQL escrito à mão e executor próprio

- **Status:** Aceito · 26/09/2026 (recomendação D-A1-1 do plano da A1, aprovado pelo dono)
- **Decide:** como o schema do banco evolui no local, no CI e na nuvem
- **Base:** ADR-003 (RLS na mesma migration), `docs/testes.md`, LIC-004, LIC-011, base §15 (Drizzle 1.0 muda a pasta de migrations)

## Contexto

Toda tabela com `tenant_id` precisa nascer com `ENABLE` + `FORCE ROW LEVEL SECURITY`, política e GRANT **na mesma migration** (ADR-003). O gerador do drizzle-kit não garante isso, e o formato da pasta de migrations muda no Drizzle 1.0. O Regem usa SQL escrito à mão com um aplicador próprio, e a experiência trouxe regras (LIC-011: uma transação por arquivo; conferir o banco real depois).

## Decisão

1. **Migrations em SQL escrito à mão**, em `packages/database/migrations/NNNN_nome.sql`: numeração de 4 dígitos, **sequencial, sem pular nem repetir** (o executor recusa).
2. **Executor próprio** (`packages/database/src/migrate.ts`, comando `pnpm db:migrate`), o **mesmo** no local, no CI e na nuvem:
   - **uma transação por arquivo**, com `lock_timeout` e `statement_timeout` locais (LIC-011); erro desfaz o arquivo inteiro e para;
   - tabela de controle `liame_migrations.applied` com **checksum** (SHA-256, fim de linha normalizado): arquivo alterado depois de aplicado é erro, nunca é reaplicado em silêncio;
   - execuções concorrentes serializadas por lock na tabela de controle, dentro da transação (sem advisory lock de sessão, LIC-004);
   - arquivo com a marca `-- liame:sem-transacao` roda fora de transação (para `CREATE INDEX CONCURRENTLY`), sozinho no arquivo.
3. **Quem aplica:** eu aplico e testo no local e no CI; **o dono aplica na nuvem** (mesmo comando, conexão do `liame_owner` em modo sessão). Depois de aplicar, confere-se no banco real (LIC-011).
4. **Schema `liame`**, fora do `public` (D-A1-2). Os papéis `liame_owner` e `liame_app` existem antes da primeira migration (bootstrap, `docs/testes.md`).
5. **GRANT explícito por tabela**, sem privilégio padrão amplo: cada migration concede ao `liame_app` só o que aquela tabela precisa (a auditoria, por exemplo, não recebe `UPDATE`/`DELETE`).
6. **Drizzle continua para as consultas.** Quando houver tabelas, um teste compara o schema TypeScript com o banco migrado.

## Consequências

- Migration nunca se apaga nem se edita depois de aplicada: corrige-se com uma migration nova.
- Toda migration nova passa pelo teste de catálogo (A1-1 e A1-2): tabela com `tenant_id` sem RLS forçada e política, ou dona pelo `liame_app`, reprova o CI.
- O comando pesado vai em arquivo próprio (LIC-011); em tabela grande, `lock_timeout` curto e conferência no mesmo passo.
