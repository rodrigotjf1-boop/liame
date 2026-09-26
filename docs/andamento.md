# Liame — Andamento

> Onde a implementação está, critério por critério (`roadmap.md` §3). Atualizar a cada entrega, com a evidência.
> Início da implementação: **25/09/2026**, por ordem do dono ("carregar o roadmap do plano v9 e começar a implementar").

## Fase A0 · Fundação e decisões

| # | Critério | Situação | Evidência / o que falta |
| --- | --- | --- | --- |
| A0-1 | ADR-001 a ADR-010 aceitos | ✅ 26/09/2026 | ADR-001 a ADR-017 "Aceito", com o plano completo aprovado pelo dono. |
| A0-2 | 8 docs aprovados | ✅ 26/09/2026 | Registro no changelog de `decisoes-design.md`. |
| A0-3 | Spike de compatibilidade verde no CI | ✅ **cumprido em 25/09/2026** | CI verde em checkout limpo (Node 24.21 + Postgres 17, 16/16 testes + verificação do spike): https://github.com/rodrigotjf1-boop/liame/actions/runs/36203403949 · nota no ADR-001 · estratégia em `testes.md`. |
| A0-3b | Contas AWS (KMS sa-east-1 e conta da âncora) | ⏳ dono | IDs das contas, sem segredo. |
| A0-4 | Mockups aprovados (Lite e Pro) | ✅ 26/09/2026 | Modelo de interface e protótipo `mockups/prototipo-app.html` aprovados com o plano completo. |
| A0-5 | Pedidos às plataformas | ⏳ dono | Meta, Google Cloud/Ads, TikTok, GBP. |
| A0-6 | Termos, privacidade e contrato de operador publicados | 🟡 **rascunhos com os dados da empresa** | `docs/juridico/`: empresa, encarregado, foro e uso de IA preenchidos em 26/09; faltam 8 decisões (README §1), a revisão do advogado e a publicação no site. |
| A0-7 | Restaurante de testes confirmado | ⏳ dono | Checklist, incluindo o número de WhatsApp na API oficial. |
| A0-8 | Supabase São Paulo, EasyPanel, Cloudflare | ⏳ dono | Cloudflare pronta (domínio). |
| A0-9 | Plano do token por loja do Regem (C1) | ⏳ | Issue/plano no Regem. |
| A0-10 | Threat model v1 revisado | ✅ 26/09/2026 | `security-model.md` §2.1 (v1.1): 16 ameaças novas com controle e fase. |

## Próxima fase

Plano da A1 (núcleo seguro) **aprovado em 26/09/2026**: [`plano-a1.md`](plano-a1.md).

| Entrega | Situação | Evidência |
| --- | --- | --- |
| **E1a** · migrations, schema `liame`, health de prontidão, erros RFC 9457 | ✅ local (36 testes) · CI no PR | ADR-018; `packages/database/migrations/0001_base.sql`; A1-18 (health com versão, banco, fila e migration; 5xx com causa e `trace_id` no log); A1-1 e A1-2 como teste de catálogo |
| **E4** · cofre | ✅ local · CI no PR | Migration 0003 (segredos e chave por empresa, com RLS); envelope AES-256-GCM amarrado ao registro; provedores AWS KMS e local; A1-13 (rotação para a v2 com recifragem; só a v2 basta depois); dado pessoal com índice cego e destruição da chave (crypto-shredding) |
| **E2a** · identidade, tenant, sessão e guard global | ✅ | Migration 0002 (organização, pessoa, vínculo, marca, unidade, sessão, tokens, limites; RLS em **todas** as tabelas); cadastro, confirmação, login, sair, senha nova, /me e troca de empresa; A1-3 (SQL, gerado do catálogo), A1-4 (rotas enumeradas), A1-5 nas tabelas reais |
| **E6d** · execução e workflow | ✅ local (147 testes no servidor) · CI no PR | Migration 0012 (`action_execution`, `workflow_run`, `workflow_step`); executor no worker com SKIP LOCKED que confere tudo de novo na hora (trava, flag de escrita, aprovação para o hash atual) e aplica no sandbox com concorrência otimista (estado mudou → não sobrescreve); ledger `execucao` ou devolução da reserva; auditoria do sistema em nome da aprovação; expiração e retomada de execução travada; passos do workflow visíveis na ação; **A1-9 ponta a ponta** |
| **E6c** · pedido de ação | ✅ local (142 testes no servidor) · CI no PR | Migration 0011 (`action_request`, `approval`, `budget_policy`, `budget_ledger_entry`, `sandbox_resource`; permissão `orcamento.gerenciar`); registro de ferramentas (risco, impacto e compensação vêm do código, nunca de quem pede); conector sandbox com concorrência otimista; pedido = trava → estado no provedor → política (com contagem para frequência) → orçamento com reserva e trava do envelope → plano com hash; `action_fingerprint` (um pedido ativo por ferramenta e recurso, inclusive simultâneo, A1-8); aprovação com o código do app na hora, amarrada ao hash, suficiente só quando o limite de quem aprova cobre o valor (senão falta o dono, avisado por e-mail); plano alterado invalida a aprovação; autopilot desligado devolve a autonomia para aprovação |
| **E6b** · motor de políticas | ✅ local (133 testes no servidor) · CI no PR | Migration 0010 (`policy` versionada por empresa e marca, uma ativa por escopo, documento imutável; permissão `politicas.gerenciar`); motor determinístico e puro com teto, variação máxima, horário no fuso da empresa (inclusive depois da meia-noite), contas permitidas, escopo, categorias e palavras proibidas, limite de frequência e modos de autonomia (a regra mais específica vence, ESCALATE sempre); política da plataforma no código (conteúdo político bloqueado, Meta ≤ 3 mudanças de orçamento/hora, apagar escala); simulação pela API; **`@Politica`** nega com 422 e cada regra, ou entrega o modo ao handler; A1-11 |
| **E6a** · feature flags e kill switch | ✅ local (118 testes no servidor) · CI no PR | Migration 0009 (`feature_flag`, `feature_flag_rule`, `kill_switch`); OpenFeature com provider próprio no Postgres (cache de 15 s) e precedência pessoa > conta > empresa > marca > plano > ambiente > padrão, com rollout estável e janela de datas; as seis flags de escrita nascem desligadas (o banco recusa o contrário); OFREP para o front com ETag, contexto da sessão; kill switch em seis níveis (a empresa aciona os seus, a distribuição global e provedor), auditado e com evento; A1-10 e A1-12 |
| **E3** · auditoria com âncora | ✅ local (107 testes no servidor) · CI no PR | Migration 0008 (cadeias por empresa e por pessoa, `audit_event` só de inserção com trava até para o dono, `audit_anchor`); **toda** rota que muda dado declara `@Auditar` ou `@SemAuditoria` (o app não sobe sem isso) e grava na mesma transação; quem fez ("Juliana, Administrador"), antes e depois, sem e-mail nem segredo; verificação da cadeia pela API; âncora diária encadeada, publicada no Rekor v2 (ECDSA P-256) e carimbada por RFC 3161, com verificação diária no worker; A1-6. **Falta a conta AWS** para o S3 Object Lock (terceiro destino) e as URLs/chave de produção (`docs/configuracao.md`) |
| **E5** · eventos e idempotência | ✅ local (97 testes no servidor) · CI no PR | Migration 0007 (outbox, endpoints e entregas de webhook, inbox, `Idempotency-Key`, permissão `webhooks.gerenciar`); evento na mesma transação da mutação (marca, convite, entrada, mudança e remoção de acesso); publicador e entregador no worker com SKIP LOCKED; webhooks de saída em CloudEvents assinados no padrão Standard Webhooks, com retentativas por ~3 dias, fila de mortos, reenvio manual e bloqueio de rede interna (SSRF); inbox verifica, grava cru, deduplica e responde 202; A1-7 e A1-8 (o `action_fingerprint` do A1-8 entra com o serviço de ações, E6) |
| **E2d** · papéis como dado | ✅ local (84 testes no servidor) · CI no PR | Migration 0006 (`role` e `role_permission` com RLS; vínculo e convite apontam para o papel); permissões lidas do banco junto com a sessão, numa consulta; conjunto próprio da empresa substitui o padrão sem deploy; `/me` devolve as permissões da empresa ativa; matriz papel × permissão testada em **toda** rota com permissão (adianta parte da E9). **`@Politica` passa para a E6:** ela avalia valor, conta e horário da ação, que só existem com o motor de políticas e o serviço de ações; antes disso seria uma casca vazia |
| **E2c** · convites, pessoas e acessos | ✅ local (80 testes no servidor) · CI no PR | Migration 0005 (convite com RLS; nível e cobrança checados no banco); convite por e-mail com link de uso único, 7 dias, só para o e-mail convidado; login criado pelo convite ou aceite logado; ninguém dá nível, limite, cobrança ou dispensa de aprovação dupla acima do que tem; dono intocável; remoção na hora; aviso ao dono; A1-3 pela API; e-mails só depois do commit. Telas de entrar, segundo fator e "Pessoas e acessos" ficam para a entrega das telas |
| **E2b** · segundo fator e empresa/marcas | ✅ local (71 testes no servidor) · CI no PR | Migration 0004 (código de recuperação, passo usado do TOTP, pedido de troca); app autenticador (RFC 6238) com QR, 10 códigos de recuperação de uso único, código repetido recusado, troca com o app ou pedido de 24 h cancelado por senha nova; Dono, Administrador, Gestor e Aprovador só usam rotas de permissão com o app ativo; `GET /v1/organization`, `GET/POST /v1/brands` |
| **E1b** · CI de segurança e contrato OpenAPI | ✅ | A1-15 (contrato gerado e conferido, Spectral sem aviso, oasdiff, SDK `@liame/sdk` gerado que compila); A1-16 parcial (gitleaks, osv-scanner com licenças, zizmor, Semgrep; SBOM e imagem na E9) |

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
