# Revisão do plano mestre → especificação arquitetural

> Status: **proposta para aprovação** · 24/09/2026 · base: Plano mestre v4 + diretrizes de revisão arquitetural (85 itens).
> Nada de produto foi programado. Nenhum commit foi feito.

## 1. Como ler

Cada decisão do plano mestre foi classificada em uma das cinco categorias:

| Categoria | Significado |
| --- | --- |
| **MANTER** | A decisão está correta e segue como está. |
| **ALTERAR** | A intenção fica, mas a forma muda. |
| **REMOVER** | A decisão sai. |
| **ADIAR** | Está certa, mas entra depois. |
| **INVESTIGAR** | Ainda não há evidência para decidir. |

Números de versão foram conferidos em 24/09/2026 no registro npm e em `nodejs.org/dist/index.json`. Não foram copiados das diretrizes.

## 2. Classificação das decisões

### 2.1 Produto e modelo operacional

| # | Decisão do plano mestre | Classe | Motivo |
| --- | --- | --- | --- |
| P1 | Tese "gestor de tráfego com IA que fecha o ciclo até a venda" | **ALTERAR** | Vira a tese das diretrizes: **plataforma operacional de crescimento**. O ciclo fechado é o fosso competitivo: campanha → clique → WhatsApp/cardápio → pedido → item → receita → margem. |
| P2 | D7: "agência completa; cada agente = um funcionário" (o "3" era exemplo) | **MANTER, como camada de experiência** | Não contradiz a tese: **por fora, uma agência; por dentro, uma plataforma**. Cada funcionário é uma definição de agente no Agent Registry. O runtime são motores, workflows e ferramentas compartilhados (ver P4). |
| P3 | 14 papéis de agente como capacidades | **MANTER como linguagem; REMOVER como runtime** | Diretriz §21. As 14 capacidades são skills + ferramentas + políticas + workflows, sem 14 runtimes. |
| P4 | Um runtime por funcionário | **ALTERAR** | Funcionário = **definição** (cargo, responsabilidades, skills, ferramentas, políticas, autonomia, rotas de modelo). Todos rodam sobre motores compartilhados: **Análise e Planejamento** (conversa, pesquisa, plano, criação), **Execução** (só Action Requests) e **Política** (determinístico) + Revisor de Compliance (IA). Relatório, sync e alertas são **workflows**, não agentes. |
| P5 | "Controle de qualidade" como porta com LLM | **ALTERAR** | Diretriz §18: o código decide (Policy Engine determinístico) e a IA só assessora (revisão de texto, tom, alegações). |
| P6 | D1: distribuição multi-cliente; testes num restaurante em operação | **MANTER** | — |
| P7 | D5: mensal por marca, sem % do gasto, sem fidelidade | **MANTER** | Sem impacto arquitetural além do billing em A7. |
| P8 | D6: nome provisório → **Liame** | **ALTERAR** | Nome definitivo com kit e manual; marca continua vindo de configuração e tokens (white-label pronto). |
| P9 | Menu configurável; modo agência (6 itens) × modo gestor | **MANTER + ALTERAR a home** | A home deixa de ser um painel de números e vira **"o que precisa da minha atenção"** (§48). Entram **Approval Inbox** (§49) e **Ctrl+K** (§50). |
| P10 | Mínimo esforço do cliente (≤ 20 min de onboarding, ≤ 15 min/semana) | **MANTER** | Vira KPI (ver especificação §7). |
| P11 | "Aprova o envelope do mês, não cada anúncio" | **ALTERAR** | O envelope passa a ser uma **política de autonomia** `LIMITED_AUTO` com teto financeiro (§19), não um conceito à parte. |
| P12 | Canais sem API: "pacote pronto" + medição por UTM/cupom/QR | **MANTER** | Coerente com o Connector Capability Registry: canal sem capacidade de escrita = execução assistida. |
| P13 | Painel = primeira versão vendável (A2) | **ALTERAR** | Diretriz §33/§54: o primeiro produto **diferenciável** é o ciclo fechado (A2.5), não um dashboard Meta+Google. |

### 2.2 Stack e organização

| # | Decisão | Classe | Motivo |
| --- | --- | --- | --- |
| S1 | Next 14 + NestJS 10 "da casa" | **ALTERAR** | Versões verificadas: **Node 24.21 (LTS "Krypton")**, **NestJS 12.1.0**, **Next 16.3.6**, **React 19.3.0**, **Tailwind 4.3.3**. Ver ADR-001. |
| S2 | TypeScript (implícito, da casa) | **ALTERAR → TypeScript 6.0.x** | O TS **7.0.2 já existe**, mas o `@nestjs/cli` 12.0.6 depende de `typescript ~6.0.2`. As diretrizes acertaram ao pedir TS 6. O TS 7 fica em INVESTIGAR para o futuro. |
| S3 | Drizzle + `pg` | **MANTER** | Drizzle **0.45.3** (estável). A 1.0 está em **RC.5**: ADIAR o upgrade até sair a versão final. |
| S4 | Monorepo `backend/` + `frontend/` | **ALTERAR** | pnpm workspaces + Turborepo. **Contesto em parte** a estrutura das diretrizes: um **único app NestJS com dois processos** (API e worker) em vez de `apps/api` + `apps/worker` + `packages/domain`. Ver ADR-002 e §4 deste documento. |
| S5 | pg-boss + outbox; Redis só se precisar | **MANTER** | pg-boss **12.34.0** (exige Node ≥ 22.12, compatível com o 24). "Fila não é workflow": entram as tabelas de workflow (ADR-005). |
| S6 | Supabase próprio em São Paulo; VPS Brasil (D3) | **MANTER** | Mais limites de concorrência e gatilhos objetivos de upgrade (arquitetura §9). |
| S7 | EasyPanel: `liame-api`, `liame-worker`, `liame-web` | **MANTER** | São três contêineres. API e worker saem da **mesma imagem** com entrypoints diferentes. |
| S8 | Rate limit (implícito, Redis no RegemCast) | **ALTERAR** | Sem Redis: limite na borda (Cloudflare) + limitador no Postgres (`rate-limiter-flexible` com store Postgres) enquanto houver poucas réplicas. |

### 2.3 Contratos, API e MCP

| # | Decisão | Classe | Motivo |
| --- | --- | --- | --- |
| C1 | OpenAPI 3.1 como contrato público; Spectral; oasdiff; `/v1`; RFC 9457; cursor; Idempotency-Key; Standard Webhooks | **MANTER** | — |
| C2 | Extensão `x-mcp` no OpenAPI como registro de ferramentas | **ALTERAR** | O **Tool Registry** é a fonte das ferramentas (§9). O `x-mcp` só alimenta parte dele. |
| C3 | Schemas | **ALTERAR** | Pacote `contracts` com **Zod 4 + Standard Schema**. Um único schema alimenta validação, OpenAPI, front, structured output, ferramentas, eventos e MCP (ADR-002/§7). |
| C4 | Diagrama do plano: "agentes do Liame" como clientes do hub MCP | **REMOVER** | Contradiz a diretriz §10. Agentes internos usam o Tool Registry e os serviços de domínio direto. MCP é só para fora. |
| C5 | Hub MCP sem estado, endpoint por produto, sem token passthrough, token interno curto, RBAC no produto, R2/R3 planejar → aprovar → executar | **MANTER** | — |
| C6 | A2A em P2 | **ADIAR** | Só com parceiro real (§12). |
| C7 | DMS ID com `oidc-provider` próprio | **INVESTIGAR** | Matriz de IdPs em andamento (ADR-009). Custom só se nenhuma solução atender, e com revisão de segurança externa antes de produção. |
| C8 | Login próprio do Liame no molde do RegemCast (D2) | **MANTER** | Com as fronteiras preparadas para virar cliente OIDC do DMS ID (ADR-009). |

### 2.4 Agentes, IA e decisões

| # | Decisão | Classe | Motivo |
| --- | --- | --- | --- |
| I1 | Claude API + Tool Runner como motor | **ALTERAR** | Entra um **AI Gateway próprio** (`generate/stream/structured/embed/rerank/toolCall/agent`) com adapters. O Anthropic entra como primeiro adapter, sem ser dependência de arquitetura (ADR-006). |
| I2 | "Opus 5 para planejar e decidir" | **ALTERAR** | **Model routing por tarefa** (task_type → provider/modelo/esforço/custo/latência/fallback/limiar de eval). Nunca preferência fixa (§24). |
| I3 | Níveis N0–N3 | **ALTERAR** | Seis modos: `SHADOW`, `SUGGEST`, `APPROVAL`, `LIMITED_AUTO`, `AUTO`, `ESCALATE`, configuráveis por tenant/marca/conta/ferramenta/tipo de ação/valor/risco (§19). |
| I4 | D4: "30 dias em sombra" | **ALTERAR** | Vira **Autonomy Readiness Score** com gates objetivos (§20). Os 30 dias ficam só como referência operacional. |
| I5 | Modo sombra = "não executa" | **ALTERAR** | Sombra de verdade (§44): registra recomendação, confiança, estado, ação humana, resultado posterior e **action regret**. |
| I6 | Regras de decisão das skills (3× CPA, +20%, frequência > 4…) | **ALTERAR** | Viram **Policy Templates / Priors** versionados, com fonte, confiança, `applicable_when`, `review_at` e override por tenant (§46). |
| I7 | Leitor em quarentena | **MANTER** | Formalizado como `UNTRUSTED_CONTENT` com rótulos estruturados (§27). |
| I8 | Evals no CI | **MANTER + ALTERAR** | Datasets versionados por categoria. Mudar prompt, ferramenta, modelo, connector ou policy dispara eval. Regressão bloqueia deploy (§26). |
| I9 | Franquia de IA por plano | **MANTER + ALTERAR** | Entra o **AI Usage Ledger** por tenant/workflow/tarefa/modelo, com degradação elegante (§61). |
| I10 | Batch API para relatórios noturnos | **MANTER** | Nunca misturar tenants no mesmo prompt; cada requisição do batch é de um tenant só. |
| I11 | Conselho com arquétipos (sem pessoas reais) | **MANTER** | — |
| I12 | Skills de marketing (MIT/Apache) como base de conhecimento | **MANTER** | Viram "knowledge" versionado da distribuição, com NOTICE de licença. |

### 2.5 Ações, dinheiro e segurança

| # | Decisão | Classe | Motivo |
| --- | --- | --- | --- |
| A1 | Serviço de Ações como única porta de escrita externa | **MANTER** | Fluxo: Action Request → Policy → Budget → Approval → Action Service → Connector (§16). |
| A2 | "Desfazer" (snapshot + reverter) | **ALTERAR** | **Compensating action** (§17), com `before/expected/desired_state` e checagem de concorrência. Nunca sobrescrever mudança humana posterior. |
| A3 | Ledger de orçamento com reserva e lock | **MANTER + ALTERAR** | Estados: `budget_policy`, `requested`, `reserved`, `executed`, `reported`, `actual_spend` (§65). |
| A4 | Kill switch em 3 níveis | **ALTERAR** | Níveis: global, tenant, marca, conta, ferramenta **e provider/escrita** (§66). |
| A5 | Aprovação amarrada ao hash do plano; R3 fora do chat | **MANTER** | Plano mudou → aprovação antiga cai (§49). |
| A6 | Aprovação por 1 toque no WhatsApp para risco baixo | **MANTER, com endurecimento** | O link é de **uso único**, com TTL curto e amarrado a plano + usuário + aparelho confiável. Nunca vale para `budget_impact > 0`. |
| A7 | Idempotência HTTP | **MANTER + ALTERAR** | Entra o `action_fingerprint` para impedir dois workflows fazendo a mesma mudança financeira (§64). |
| A8 | `validate_only` Meta/Google + criar pausado | **MANTER / INVESTIGAR (Google)** | Meta confirmado. No Google Ads o `validate_only` não foi confirmado na pesquisa: validar no spike do connector. |
| A9 | Cofre AES-256-GCM | **MANTER + INVESTIGAR onde vive a chave mestra** | A chave não pode ficar no mesmo nível de comprometimento do banco (§41). Matriz KMS/Vault/Infisical em andamento (security-model §5). |
| A10 | Auditoria append-only com hash encadeado | **MANTER + ALTERAR** | Entra a **âncora externa diária** (`daily_root_hash`, §40) e fica separada dos logs operacionais (§69). |
| A11 | "CRM vence plataforma" | **REMOVER** | Troca por **Metric Authority Matrix** (§34). |
| A12 | security-hardening P0–P7 na A1 | **MANTER** | Mais supply chain no CI (§56). |

### 2.6 Dados

| # | Decisão | Classe | Motivo |
| --- | --- | --- | --- |
| D-1 | Métricas: tabela diária particionada + payload bruto | **ALTERAR** | Modelo **temporal** (`metric_date` × `observed_at` × janela de atribuição) + modelo canônico com métricas específicas por provider (§35–36). |
| D-2 | Dossiê da marca como texto | **ALTERAR** | Dossiê **estruturado** (identidade, voz, personas, produtos, ofertas, provas, alegações proibidas, geo, sazonalidade…), com versão textual gerada sob demanda (§72). |
| D-3 | Consentimento | **ALTERAR** | Modelo por **contato × canal × finalidade**, com fonte, evidência e versão da política (§67). |
| D-4 | Retenção | **ALTERAR (novo)** | Política explícita por classe de dado (§68) e classificação de dados (§71). |

### 2.7 Roadmap

| # | Decisão | Classe | Motivo |
| --- | --- | --- | --- |
| R1 | A2 leitura → A3 agentes → A4 escrita → A5 ciclo fechado | **ALTERAR** | O ciclo fechado vira **A2.5** e entra antes da camada de inteligência (§52). |
| R2 | Trilha C (ajustes no Regem e no RegemCast) entre A2 e A5 | **ALTERAR** | Precisa **começar durante a A1**, porque a A2.5 depende dela (ver §3, dependência crítica). |
| R3 | SEO, CRO, SDR na A6 | **ADIAR → A8** | — |
| R4 | Trilha B (DMS ID + hub) em paralelo | **MANTER** | Não bloqueia o MVP (§53). |

## 3. Contradições e dependências encontradas

1. **"Agência com funcionários de IA" (D7) × "plataforma, não painel com bots" (§84).** Aparente contradição, resolvida em camadas. A agência é a **experiência** (cada agente = um funcionário, com cargo e responsabilidades). A plataforma é a **arquitetura** (motores, workflows, ferramentas, políticas). Nenhum funcionário executa nada sozinho: tudo passa pelo Tool Registry → Policy → Action Service.
2. **As diretrizes citam "14 personas" e "Guardião A14".** Mapeamento final: **N funcionários** (catálogo inicial de 14, cada um uma definição no Agent Registry) → **3 motores compartilhados** (runtime) → skills, ferramentas, políticas e workflows. O "Guardião" vira o funcionário Compliance, cuja decisão é do Policy Engine determinístico.
3. **D4 (30 dias de sombra), decidida na mesma data, é substituída** pela diretriz §20 (readiness gates). A mudança vem de você, mas fica registrada como revisão da D4 no changelog.
4. **Dependência circular potencial:** A2.5 (ciclo fechado) precisa de C1 (token por loja do Regem, **cujo código não está no git**) e de C2 (API de serviço do RegemCast). Se a trilha C começar só depois da A2, a A2.5 trava. **Correção:** a trilha C começa em paralelo com a A1.
5. **Plano mestre: "agentes do Liame → hub MCP → liame-api".** Contradiz a §10 e foi removido (C4).
6. **Diretriz §5 (`apps/api` + `apps/worker` + `packages/domain`) × §4/§83 (sem complexidade prematura).** Módulos NestJS espalhados em pacotes exigem project references, metadados de decorators entre pacotes e risco de ciclos. Recomendo **um app Nest com dois processos** (ADR-002). Mesma intenção, menos atrito.
7. **Aprovação por WhatsApp com 1 toque (D7) × aprovação fora do chat para alto risco (§11).** Não conflitam se o 1 toque for proibido para qualquer ação com `budget_impact > 0` ou risco ≥ R2.
8. **"Opus decide" (plano) × provider-agnostic (§23–25).** Resolvido pelo model routing com eval.

## 4. Revisão crítica (§80)

### Riscos não tratados no plano mestre

- **A atribuição pode falhar em 7 pontos** (detalhe em `integrations.md` §6):
  1. O número de WhatsApp do restaurante precisa estar na **API oficial** (RegemCast ou Cloud do Regem). Por Evolution/API não oficial, não chega o `referral`/`ctwa_clid` do anúncio.
  2. O link do WhatsApp para o cardápio precisa **carregar o identificador do clique** até o pedido (o Regem não captura UTM hoje).
  3. O telefone é gravado com e sem o 55 no Regem: a identidade entre conversa e pedido quebra sem normalização única em E.164.
  4. Pedido do iFood/99 não tem clique e fica fora do marketing por decisão de LGPD: **não entra na atribuição de mídia própria**.
  5. Venda no balcão (PDV) só é atribuível por **cupom** ou identificação do cliente.
  6. A margem depende do custo cadastrado (ficha técnica): produto sem custo vira "margem desconhecida", nunca zero.
  7. Janelas e fusos: as plataformas reportam em fuso e janela próprios. O Liame normaliza e **declara** a janela usada.
- **O rate limit da Meta é por app × conta de anúncio**, e o de ações do Google Ads é diário por projeto. Todos os tenants compartilham o mesmo app. Sem **escalonamento justo por tenant** (`provider_concurrency` + `tenant_concurrency`), um cliente grande consome a cota dos outros.
- **RLS com pool em modo transação (Supavisor):** o contexto do tenant precisa ser `set_config('app.tenant_id', …, true)` **dentro de cada transação**. `SET` de sessão vaza entre requisições no pool (LIC-004).
- **Worker e RLS:** jobs do pg-boss carregam `tenant_id`, e o worker processa cada job sob o contexto do tenant, com a mesma role sem `bypassrls`. Só o agendador/varredor usa uma role de sistema, sem acesso a dados de negócio.
- **A chave `service_role` do Supabase ignora RLS:** fica proibida no runtime do produto (teste que falha se ela aparecer na configuração do app).
- **Vazamento entre tenants pela IA:** nunca juntar dois tenants no mesmo prompt ou batch; cache de prompt, embeddings e traces sempre com `tenant_id`; sanitização de PII antes do gateway.
- **Transferência internacional (LGPD, arts. 33–36):** os provedores de LLM ficam fora do Brasil. Os contratos precisam de cláusulas-padrão, e a `data classification` limita o que sai.
- **Link de aprovação por WhatsApp como vetor de phishing:** uso único, TTL, amarrado ao aparelho e nunca para gasto.
- **APIs das plataformas depreciando:** a Marketing API v24 expira em 06/10/2026 e o Google Ads lança versão todo mês. O **Connector Capability Registry** e os contract tests são obrigatórios desde o primeiro connector.

### Onde o determinismo vence a IA

Métricas, ROAS/CPA/CAC/LTV/margem, orçamento e ledger, atribuição, consentimento e opt-out, frequência de envio, teto e horário, palavras e categorias proibidas, detecção de anomalia (estatística), agendamento, números do relatório e freshness.

### Onde um agente vence um workflow

Planejamento estratégico, ideação criativa, pesquisa em várias fontes, diagnóstico de desempenho fora do padrão, conversa aberta com o cliente (Atendimento) e montagem de plano de campanha multicanal.

### Complexidade prematura evitada

Kubernetes, Kafka, microsserviços, A2A, event sourcing, GraphQL, vector DB separado (usar `pgvector` no próprio Postgres só se a busca semântica provar valor), swarm multiagente, autonomia total, blockchain e fine-tuning. **Também contesto** a granularidade de 14 pacotes em `packages/` logo no início: um pacote só nasce quando **dois apps** precisam dele.

## 5. O que ficou em INVESTIGAR

| Item | Situação | Onde |
| --- | --- | --- |
| IdP para o DMS ID | **Resolvido:** Logto OSS self-host no Brasil (Keycloak é o plano B; Descope Growth BR o plano C); custom descartado | ADR-009 |
| Onde vive a chave mestra | **Resolvido:** AWS KMS sa-east-1 (Supabase Vault rejeitado) | ADR-011 |
| Âncora externa da auditoria | **Resolvido:** S3 Object Lock compliance (conta dedicada) + Rekor + RFC 3161 | ADR-011 |
| Standard Schema no Nest 12 | **Resolvido:** nativo (`@Body({ schema })` + `StandardSchemaValidationPipe`) | ADR-001 |
| Base do AI Gateway | **Resolvido:** abstração própria + Vercel AI SDK 7 + adapters diretos pontuais | ADR-006 |
| Feature flags | **Resolvido:** OpenFeature + provider próprio no Postgres | ADR-012 |
| ESM × CJS no `apps/server` | **Spike A0** (hipótese: CJS no server, ESM no web) | ADR-001 |
| `validate_only` no Google Ads | Spike do connector | integrations §3 |
| Número de WhatsApp do restaurante de testes: está na API oficial? | **Pergunta ao dono** | integrations §6 |
| TypeScript 7 | Quando o TS 7.1 trouxer a API e a CLI do Nest suportar | ADR-001 |
| Node 26 LTS | Migrar depois de 28/10/2026, quando as dependências confirmarem suporte | ADR-001 |
