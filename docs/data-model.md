# Liame — Modelo de dados

> Status: **aprovado pelo dono em 26/09/2026** (proposta de 24/09/2026). Modelo **lógico**: nomes definitivos de colunas e tipos saem nas migrations da A1, com o mesmo espírito.

## 1. Regras gerais

- **Todo registro de negócio** tem `tenant_id` (organização). Quando aplicável, tem também `brand_id` e `unit_id`.
- **RLS em toda tabela com `tenant_id`**, com `ENABLE` + `FORCE ROW LEVEL SECURITY` na **mesma migration que cria a tabela**. A role da aplicação não tem `bypassrls` e não é dona das tabelas.
- Contexto do tenant por transação: `select set_config('app.tenant_id', $1, true)`. Nunca `SET` de sessão (pool em modo transação).
- Dinheiro em **centavos** (`bigint`) + `currency` (ISO 4217). Nada de float.
- Timestamps em `timestamptz` (UTC). O **fuso do negócio** é atributo do tenant e da unidade e é usado em todo corte de dia, semana e mês (LIC-006).
- IDs: UUID v7 (ordenáveis). Registros externos guardam `provider` + `external_id` com `UNIQUE`.
- **Classificação de dados** por coluna (metadado no schema): `PUBLIC`, `INTERNAL`, `CONFIDENTIAL`, `PERSONAL`, `SENSITIVE`, `SECRET`. Ferramentas e agentes recebem só as classes necessárias.

## 2. Tenancy e identidade

```text
organization (tenant) ─┬─ brand ─┬─ unit (loja: endereço, geo, raio, horário, fuso)
                       │         └─ connected_account (provider, external_id, status, freshness)
                       ├─ user ── membership (role) ── permission_grant (ABAC: recurso, ação, contexto, limites)
                       └─ plan / subscription (A7)
```

- **Acesso delegado (ADR-017):** `membership` guarda `role_key`, `approve_limit_micros`, `dual_approval`, `billing_access`, `expires_at`, `invited_by`, `revoked_at` e `last_seen_at` (último acesso **nesta** empresa, gravado junto com a sessão a cada 5 minutos; migration 0015); `app_user.mfa_enabled_at` diz desde quando o app autenticador está ativo (o segredo continua só da pessoa, no cofre); `app_user.terms_version` e `terms_accepted_at` guardam a versão dos termos aceita ao criar o login (migration 0016); `invitation(tenant_id, email, role_key, limites, access_expires_at, token_hash, expires_at, accepted_at, accepted_by, revoked_at, invited_by)` (migration 0005); um usuário pode ter `membership` em várias organizações. Na A7, `partner_link(partner_org_id, client_org_id, status, scope, requested_by, accepted_by, ended_at)`.
- **RBAC + ABAC:** papel (Dono, Gestor, Analista, Criador, Aprovador, Cliente) + recurso + ação + contexto + política. Exemplo: *Gestor pode aumentar orçamento em até 15%, só na própria marca, só nas contas X e Y, até R$500 por ação.*
- `credential` (tokens OAuth de terceiros): cifrado com envelope, `key_version`, `rotated_at`, `revoked_at`. **Nunca** sai em log, front, API, prompt ou auditoria visível ao cliente.

## 3. Mídia: canônico + específico do provider

Não fingir que Meta e Google têm os mesmos conceitos.

| Entidade canônica | Meta | Google Ads | TikTok |
| --- | --- | --- | --- |
| `campaign` | campaign | campaign | campaign |
| `ad_group` | ad set | ad group / asset group (PMax) | ad group |
| `ad` | ad | ad (RSA etc.) | ad |
| `creative` | creative | asset | creative |

Cada entidade tem colunas canônicas + `provider_attributes jsonb` (o que é só do provider) + `raw_ref` (ponteiro para o payload bruto).

**Conexão (`oauth_connection`, migration 0019):** uma autorização OAuth da empresa para uma marca (`meta` ou `google`, que cobre Google Ads e GA4). Situações: `aguardando_autorizacao` → `recebida` → `processando` → `aguardando_escolha` → `ativa`; ou `erro`, `expirada`, `revogada`. O estado do OAuth fica só como hash (`state_hash`); o código e o verificador PKCE ficam cifrados com a chave da empresa até a troca; a credencial vai para o cofre (`credential_secret_id`); `discovered` guarda as contas que a autorização alcança (nome, moeda, fuso), para a pessoa escolher. `connected_account.connection_id` liga cada conta à autorização; uma conta da plataforma fica ligada a uma marca só por vez na empresa (índice único parcial sem `disconnected_at`). Tentativas que não viraram conexão saem em 90 dias.

**Sincronização (G7):** `sync_state` por conta e conjunto de dados (`metricas`, `entidades`) guarda o frescor (`last_success_at` × `expected_every_minutes`), o último erro (texto nosso, sem dado da plataforma) e o `cursor` (`carga_inicial_em`, `revisao_longa_em`, `proxima`, `falhas_seguidas`); `sync_run` registra cada execução. **Vigia (G8, migration 0020, da distribuição):** `watch_source` (fontes oficiais), `watch_snapshot` (hash de cada trecho da última leitura), `watch_change` (o que mudou, com o texto novo) e `watch_alert` (versão expirando ou expirada, descontinuação vista, fonte que mudou ou falhou; único por tipo, provider, versão e etapa). Leitura para todos (documentação pública), escrita só do sistema.

A cada leitura, toda chave lida fica com o `observed_at` da leitura; a chave da janela que ficou para trás (a plataforma deixou de mandar) passa a valer zero com observação nova.

### 3.1 Métricas com modelo temporal

As plataformas **reescrevem o passado**: uma conversão pode aparecer dias depois. Cada observação é uma linha:

```text
metric_observation(
  tenant_id, brand_id, provider, account_id, campaign_id, ad_group_id, ad_id,
  metric_date,            -- o dia a que o número se refere (fuso da conta)
  observed_at,            -- quando lemos
  attribution_window,     -- ex.: 7d_click_1d_view
  currency, timezone,
  metric_name,            -- canônica (spend, impressions, clicks, conversions…) ou do provider
  metric_value, source_version, quality)
```

Com isso dá para responder "quanto a plataforma dizia naquela data?" e "quanto ela diz hoje sobre aquela data?". Particionado por mês de `metric_date` **quando o volume pedir** (D-A2-6: adiado; hoje índice por chave + BRIN em `observed_at`). `metric_latest` guarda o último valor observado por chave para os painéis — **tabela mantida na escrita, não visão materializada** (visão materializada não tem RLS; D-A2-5). Linha nova em `metric_observation` só quando o número muda (D-A2-7); a aplicação só insere.

**Mapeamento:** `metric_mapping(provider, provider_metric, canonical_metric, transform, confidence)`. Métrica sem equivalente fica específica do provider, sem ser espremida numa tabela plana.

**Payload bruto:** `raw_payload(provider, endpoint, api_version, fetched_at, hash, body jsonb)`, com retenção limitada (ver §9), para reprocessar quando o mapeamento mudar.

**Freshness:** `sync_state(connected_account_id, dataset, last_success_at, last_attempt_at, status)` → `fresh | delayed | stale | unknown`. Toda métrica entregue a agente ou tela leva o seu freshness.

## 4. Ciclo fechado e atribuição

```text
touchpoint (clique/visita/conversa) ─→ identity_link ─→ customer_ref ─→ order ─→ order_item ─→ margin
     ↑ click ids (fbclid, gclid, ttclid, ctwa_clid), UTM, cupom, QR, referral do WhatsApp
```

| Entidade | Conteúdo | Fonte |
| --- | --- | --- |
| `touchpoint` | tipo (click, landing_view, whatsapp_conversation, coupon_redeem), click ids, UTM, `occurred_at`, campanha/anúncio resolvidos | Landing/cardápio (UTM), RegemCast (referral CTWA), connectors |
| `customer_ref` | chave pseudonimizada (hash do telefone E.164 com salt por tenant) + referência ao cliente no sistema de origem | Regem / RegemCast |
| `order_fact` | pedido confirmado: canal, total, status, `confirmed_at`, unidade | **Regem (autoridade)** |
| `order_item_fact` | item, quantidade, receita, **custo** (ficha técnica) → margem; `cost_known` bool | **Regem (autoridade)** |
| `attribution_result` | modelo (last_click, last_touch_whatsapp, coupon, janela declarada), pedido ↔ touchpoint, peso, confiança | **Liame (autoridade)** |

**Margem desconhecida ≠ zero:** item sem custo cadastrado gera `margin = null` e sinaliza a lacuna.

### 4.1 Metric Authority Matrix

| Métrica | Fonte autoritativa |
| --- | --- |
| Gasto, impressões, cliques, CPM, CPC | Plataforma de anúncios |
| Conversão reportada pela plataforma | Plataforma (rótulo "reportado") |
| Mensagem enviada, entregue, lida | RegemCast / Meta (webhook `wamid`) |
| Conversa iniciada por anúncio | RegemCast (referral CTWA) |
| Pedido, receita | Regem / PDV |
| Margem | Regem (custo de ficha técnica) |
| Atribuição normalizada, ROAS confirmado | Liame |
| Gasto real faturado | Plataforma (fatura) → ledger `actual_spend` |

Divergência entre fontes não "vence" por regra geral: a tela mostra as duas, com rótulo.

## 5. Consentimento (LGPD como domínio)

```text
consent(tenant_id, contact_ref, channel [whatsapp|email|sms|ads_audience],
        purpose [marketing|transactional|remarketing|research],
        source [form|conversation|pos|import|api], granted_at, revoked_at,
        evidence (texto exibido, url, ip/UA quando houver), policy_version)
```

Opt-in amarrado à **finalidade**. Opt-out vale na hora para envios pendentes. Clientes vindos de iFood/99 **não** entram em marketing (decisão de 09/09/2026). A audiência enviada a plataformas (Customer Match / Custom Audience) exige consentimento com `purpose = ads_audience` e sai só em hash.

## 6. Trabalho, ações e dinheiro

| Entidade | Papel |
| --- | --- |
| `job` | Demanda da agência (origem: cliente, agência, rotina), responsável, prazo, status |
| `workflow_run` / `workflow_step` / `workflow_event` | Estado durável dos workflows (espera de aprovação sem job preso) |
| `plan` | Proposta com `plan_hash`, itens, evidências, explicação, versões (prompt, modelo, política) |
| `approval` | Quem, quando, canal, `plan_hash` aprovado, expiração; invalidada se o plano mudar |
| `action_request` | Ação proposta: ferramenta, parâmetros, `risk_level`, `budget_impact`, `action_fingerprint` (UNIQUE entre as ativas) |
| `action_execution` | `before_state`, `expected_state`, `desired_state`, `provider_version`, `executed_at`, ator, aprovação, `compensation_strategy`, resultado |
| `tool_execution` | Cada chamada de ferramenta (entrada sem PII, saída resumida, duração, erro) |
| `budget_policy` | Limites por marca, conta e período |
| `budget_ledger_entry` | `requested → reserved → executed → reported → actual_spend`, com lock por conta; orçamento configurado ≠ gasto real |
| `autonomy_rule` | Modo por tenant, marca, conta, ferramenta, ação, valor e risco |
| `readiness_snapshot` | Sinais do Readiness Score por conta × ferramenta |
| `shadow_decision` | Recomendação, confiança, estado, ação humana, resultado posterior, `action_regret` |
| `human_override` | Recomendada × executada, motivo |
| `kill_switch` | Nível (global, provider, tenant, marca, conta, ferramenta), escopo, quem, quando |
| `feature_flag` / `flag_override` | Flags por ambiente, plano, tenant, marca, conta, usuário |

**Compensação:** antes de reverter, `readState()` no provider. Se o estado atual ≠ `expected_state`, **não sobrescreve** (houve mudança humana) e escala.

## 7. Registro e versões

`agent_definition` (funcionário: cargo, responsabilidades, ferramentas permitidas, políticas, rotas de modelo, KPIs) + `agent_activation` (qual funcionário está ativo para qual tenant/marca/plano), `tool_registry`, `connector_capability`, `policy` / `policy_template`, `prompt_version`, `model_route`, `knowledge_item` (dossiê estruturado e base da agência): todos versionados com `status, created_by, eval_score, deployed_at`.

## 8. Auditoria e uso de IA

- `audit_event` (append-only, sem UPDATE/DELETE na role da aplicação): `who, actor_type [human|agent|integration|system|partner], tenant, brand, unit, action, resource, before, after, reason, approval_id, trace_id, tool, agent, model, occurred_at, prev_hash, hash`.
- `audit_anchor(day, root_hash, anchored_at, anchor_ref)`: o `daily_root_hash` publicado **fora** do banco (security-model §7).
- `ai_usage(tenant, workflow, task, provider, model, prompt_version, tokens_in, tokens_out, cache_hit, latency_ms, cost_micros, tool_calls, tool_failures, outcome)`.

## 9. Retenção (proposta inicial)

| Classe | Retenção |
| --- | --- |
| Payload bruto de connectors | 90 dias (tempo para reprocessar mapeamentos) |
| Logs operacionais | 30 dias |
| Traces | 14 dias (amostrados); traces de ação financeira, 180 dias |
| Prompts e respostas de IA | 30 dias com conteúdo; depois só metadados e hashes |
| Mensagens (conteúdo) | enquanto houver finalidade; opt-out/pedido de exclusão → apagar ou anonimizar |
| Dados pessoais de contatos | enquanto houver consentimento/finalidade; cancelamento do cliente → exportar e excluir em até 30 dias |
| Métricas agregadas | indefinido (sem PII) |
| Auditoria | 5 anos (revisar com jurídico), com âncora |
| Registros de acesso à aplicação | 6 meses (Marco Civil, art. 15) |
| Campanha, criativo e job **arquivados** | expurgo 12 meses depois de arquivar (agregados sem PII ficam) |
| Backups completos | 35 dias; dados pessoais cifrados com a chave do tenant |

**Ciclo de vida (ADR-014):** `ativo` → `arquivado` (somente leitura, reativável) → `expurgado` (apagado ou anonimizado, sem volta). Colunas `archived_at`, `purge_after`, `purge_reason` e `legal_hold`; job diário de expurgo em lotes, com registro na auditoria e relatório mensal ao Dono. No fim do contrato: 30 dias de graça com exportação, expurgo do tenant e destruição da chave dele no KMS (crypto-shredding).

## 10. Cuidados com escala

- `metric_observation` é a tabela que mais cresce: particionar por mês, BRIN em `observed_at`, agregados materializados.
- Os jobs do pg-boss carregam `tenant_id` e são processados sob o contexto do tenant.
- Operação em massa = 1 requisição + SQL em conjunto (sem loop de N).
