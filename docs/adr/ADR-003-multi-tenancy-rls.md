# ADR-003 — Multi-tenancy com RLS desde a primeira migration

- **Status:** Proposto · 24/09/2026
- **Decide:** isolamento entre clientes

## Contexto

O produto é de distribuição (D1): muitos clientes usam ao mesmo tempo. Um vazamento entre tenants é o pior incidente possível. No Regem, a RLS existe mas está desligada (`RLS_ENABLED=false`), e o guard é por controller (rota nova nasce anônima). No RegemCast, a RLS vale desde o dia 1 e o guard é global fail-closed: esse é o molde.

## Opções

| Critério | A) Banco compartilhado + `tenant_id` + **RLS** + checagens na aplicação | B) Schema por tenant | C) Banco por tenant |
| --- | --- | --- | --- |
| Segurança | Defesa em profundidade | Boa | Máxima |
| Complexidade | Baixa/média | Alta (migrations × N) | Muito alta |
| Custo | Baixo | Médio | Alto |
| Escala para milhares de PMEs | Boa | Ruim | Ruim |
| Supabase | Nativo | Possível | Caro |

## Decisão

**Opção A, com cinco camadas:**

```text
Auth (sessão/token) → Tenant Context (do token, nunca de argumento) → RBAC/ABAC → Repositório (filtra) → Postgres RLS (última barreira)
```

Regras:
1. Toda tabela de negócio tem `tenant_id` e, quando couber, `brand_id` e `unit_id`.
2. `ENABLE` + `FORCE ROW LEVEL SECURITY` e a política **na mesma migration que cria a tabela**.
3. A role da aplicação **não tem `BYPASSRLS`**, não é dona das tabelas e só tem os GRANTs necessários (GRANT + `alter default privileges` na migration).
4. Contexto por transação: `set_config('app.tenant_id', $1, true)`. **Nunca** `SET` de sessão (o pooler do Supabase em modo transação reaproveita conexões; LIC-004).
5. A `service_role` do Supabase é **proibida** no runtime do produto.
6. O worker processa cada job sob o contexto do tenant do job. Só o agendador usa uma role de sistema **sem acesso a dados de negócio**.
7. Guard HTTP global **fail-closed**; rota pública só com `@Publico()` explícito.
8. Tenant e loja vêm do token/sessão; parâmetros como `unit_id` são **revalidados** contra o que o token permite.

## Testes obrigatórios (critérios A1-1 a A1-5)

Enumeração de tabelas sem RLS; checagem da role; suíte cross-tenant gerada por tabela e rota; enumeração de rotas sem guard; contexto concorrente no mesmo pool.

## Consequências

- Toda consulta paga o custo da política RLS (índices começam por `tenant_id`).
- Relatórios cross-tenant da distribuição passam por visões e roles próprias do console da distribuição, nunca pela role do produto.
