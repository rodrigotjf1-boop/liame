# Blindagem do servidor — checklist P0–P7 (E9, 26/09/2026)

Playbook `security-hardening` aplicado ao Liame no fim da A1. Cada item diz onde está a prova. O que ficou de fora está no fim, de propósito.

| # | Item | Situação | Onde |
| --- | --- | --- | --- |
| P0 | Trabalho isolado da branch de deploy | ✅ | branch → PR → CI verde → merge (uma entrega por PR) |
| P1 | Toda rota declara quem pode usar; o app não sobe sem isso | ✅ | `auth/routes.ts`; `test/access.spec.ts` (A1-4) |
| P1 | Multi-tenant: nenhuma consulta vê outra empresa | ✅ | RLS forçada em todas as tabelas; `test/db/cross-tenant.spec.ts` (A1-3), testes de isolamento por módulo |
| P1 | Criação de empresa só pelo cadastro | ✅ | `POST /v1/auth/signup` é o único caminho |
| P1 | Limite de tentativas agressivo em autenticação | ✅ | entrar 10/e-mail e 30/IP em 15 min; cadastro 10/IP/h; código do app 10/15 min; convite 30/IP/15 min (Postgres, vale entre réplicas) |
| P1 | Falha de login na auditoria | ✅ | `sessao.falhar` na cadeia da pessoa (E9); a resposta não muda |
| P1 | Cabeçalhos de segurança; sem `X-Powered-By` | ✅ | `http-security.ts` (API) e `next.config.ts` (web); `test/http-security.spec.ts` |
| P1 | CORS só para as origens do app | ✅ | `APP_URL` + `ALLOWED_ORIGINS`, com credenciais; origem estranha não recebe permissão |
| P1 | Fail-fast de configuração | ✅ | produção recusa subir sem `APP_URL` https, com cookie inseguro, e-mail em memória, KMS local, âncora incompleta ou webhook para rede privada |
| P1 | `.env` nunca no git | ✅ | `.gitignore`; histórico conferido (`git log --all -- .env*` vazio); gitleaks no CI |
| P2 | Portão de CI | ✅ | build, testes, contrato, gitleaks, osv-scanner, zizmor, Semgrep, imagem + SBOM + Grype; *branch protection* não vale no plano grátis: portão por disciplina |
| P3 | Regras de dinheiro e tempo em funções puras com teste | ✅ | motor de políticas, plano das ferramentas, envelope e ledger, rollout de flags, âncora |
| P4 | Escopo além do papel | ✅ parcial | permissões por empresa, limite de aprovação por pessoa, marca na política e no envelope; papel por marca fica para quando existir a necessidade (ADR-013) |
| P5 | Auditoria de toda mutação, imutável | ✅ | `@Auditar`/`@SemAuditoria` obrigatórios; trava no banco; hash encadeado e âncora (A1-6) |
| P6 | Contrato da API | ✅ | OpenAPI 3.1 gerado do código, Spectral e oasdiff no CI; sem Swagger UI exposto |
| P7 | Sessão no front | ✅ por desenho | cookie `httpOnly` desde o começo (nada em `localStorage`); o tratamento do 401 entra com as telas |
| — | Imagem de contêiner sem root, base por digest, SBOM e Grype | ✅ | `apps/server/Dockerfile`, `apps/web/Dockerfile`; job `imagem` do CI (A1-16) |
| — | Rotas provisórias do spike | ✅ removidas | o verificador de dependências ficou em `apps/server/src/verify/` |

## Limitações conscientes

- **Limite global por IP** fica na borda (Cloudflare WAF, security-model §8) quando o domínio for configurado; na aplicação há limite só nas rotas de autenticação e de convite.
- **CSP no web** (27/09/2026, `apps/web/src/lib/csp.ts`, `src/proxy.ts`, `next.config.ts`), duas regras com o mesmo essencial: `default-src 'self'`; scripts só do próprio app com **Subresource Integrity** (hash no build, `experimental.sri`); `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`, `frame-ancestors 'none'`, `connect-src` só o app e a API, `upgrade-insecure-requests` em produção.
  - **Telas de entrada** (grupo `(entrada)`, lista `ROTAS_PUBLICAS`): pré-renderizadas pelo Cache Components (ADR-001), CSP fixa no `next.config` com `'unsafe-inline'` nos scripts (os inline do React/Next mudam a cada build; sem ele a hidratação quebra, React #412).
  - **Todo o resto** (app logado, rota inexistente e qualquer rota nova): o proxy gera um **nonce** por requisição e manda `script-src 'self' 'nonce-…' 'strict-dynamic'` + o hash do script do tema, **sem `'unsafe-inline'`** (decisão do dono, 27/09/2026). As telas do app são renderizadas a cada acesso (`instant = false` + `connection()` no layout do grupo `(app)`), que é o que deixa o Next aplicar o nonce aos próprios scripts. A página 404 fica estática de propósito (ela entra na árvore de toda rota; dinâmica, tiraria a pré-renderização das telas de entrada): os scripts dela são barrados e ela funciona sem JavaScript, com o link comum de volta. Rota nova fica, por padrão, na regra rígida; tela pública nova entra em `ROTAS_PUBLICAS` (o teste confere que a lista é exatamente o grupo `(entrada)`).
  - Conferido no build de produção, no Chrome: nenhuma violação e hidratação completa em `/`, `/pessoas`, `/seguranca`, `/contas`, `/atencao`, `/entrar`, `/criar-conta` e `/segundo-fator`; numa rota inexistente, a 404 em pt-BR aparece e só os scripts dela são barrados (esperado).
- **Grype falha só em crítico com correção disponível** (`--only-fixed`); alto e médio aparecem no log e no SBOM, para revisão.
- **Verificação noturna** (`grype sbom:` sem rebuild, TruffleHog no histórico) fica para quando houver deploy; hoje o SBOM sai como artefato de cada execução (90 dias).
- **Semgrep local no Windows** funciona (Python 3.14, `PYTHONUTF8=1`): rodar antes do PR evita a ida e volta do ERR-012.
