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

**Link do anúncio (A2.5 · F5, sem migration):** para a conferência do rastreio, o conector guarda em `provider_attributes.rastreio` para onde o anúncio leva e o que ele acrescenta ao link — no `creative` da Meta (`url_tags` e os links do criativo, cada um com os próprios parâmetros) e no `ad` do Google (URLs finais e o sufixo do URL final e o modelo de acompanhamento que valem para o anúncio, com o nível de onde vieram). O conjunto da Meta guarda o `destination_type` (site, WhatsApp…). Sem a chave, o link ainda não foi lido.

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

**Vendas (A2.5 · F1, migration 0021; ADR-019):**

- `connected_account.unit_id` liga a loja do Regem (ou a conta do RegemCast) à loja do Liame. A loja do Regem ligada sem loja escolhida ganha a dela: a que a conta já tinha, a da marca com o mesmo nome ou uma nova com o nome e o fuso da loja (#71; a migration 0027 fez o mesmo para as já ligadas e apontou os pedidos lidos para ela). O link, o cupom informado e a plataforma de pedidos são por loja do Liame.
- `order_fact`:
  - canal e grupo do canal (`cardapio`, `whatsapp`, `presencial`, `marketplace`, `outro`), situação (`confirmado` ou `cancelado`);
  - receita pela definição única do Regem, desconto e estorno **em micros**, cupom, `confirmed_at` e fuso da loja;
  - versão do recurso (`source_version`): o upsert só aplica versão maior;
  - marketplace sem cliente, garantido por `check` no banco.
- `order_item_fact`:
  - quantidade, receita e custo em micros; `cost_known` gerado;
  - o item que some numa versão nova fica com `removed_at`.
- `customer_ref`: só o índice cego do telefone em E.164 (HMAC com a chave da empresa).
- `customer_ref_link`: o id do cliente na origem → `customer_ref`, para apagar o cliente quando a origem o anonimiza (as ligações somem junto; pedidos e toques ficam sem cliente).
- Telefone normalizado antes do índice, com o nono dígito do celular acrescentado: o `wa_id` do WhatsApp vem muitas vezes sem ele.

**Atribuição (A2.5 · F2, migration 0022; ADR-020):**

- `tracking_link`: o link do cardápio com o `lk`, ligado a campanha e anúncio. O `lk` sai da chave natural (empresa, loja, campanha, anúncio ou todos, destino; F5): o índice único `(tenant_id, code)` garante um link só por chave, sem migration nova.
- `coupon`: espelho dos cupons da loja no Regem, com regra, validade e usos (`origin` `regem`), e os **informados de outra plataforma de pedidos** (`origin` `externo`, `platform` `anotaai` ou `cardapioweb`, id na origem `externo:<CÓDIGO>`, `created_by`; migration 0026, F6): a regra e a validade ficam na plataforma, e o Liame reconhece o código nos pedidos da loja.
- `campaign_coupon`: cupom ligado a uma campanha por período (dias no fuso da loja; um vínculo por vez, sem períodos que se cruzem); só o exclusivo é evidência. O vínculo agendado que ainda não começou pode ser apagado; o que já valeu fica.
- `unit.order_platform` (0026): onde a loja recebe os pedidos online, informado pela empresa (`regem`, `anotaai`, `cardapioweb`, `brendi`, `outra` com `order_platform_url` https), com quem e quando informou.
- `touchpoint`:
  - `clique`: ligado ao pedido pelo id na origem; `conversa`: ligada ao pedido pelo `customer_ref`;
  - ids de clique e da plataforma válidos ou ausentes; plataforma deduzida dos ids;
  - `provenance` por campo;
  - 90 dias.
- `attribution_model`: regra e janela como dado, imutável por versão, com o modelo `ultimo_toque` v1 na distribuição.
- `attribution_run`: 90 dias.
- `attribution_result`: um por pedido e versão de modelo, com evidência, confiança, janela, `counted` e o motivo de ficar sem origem.
- Motor em uma instrução por execução (`attribution/motor.ts`).

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
| `plan` | O plano do Estrategista (A3, I11): o tipo (`noventa_dias`, `pauta`, `oferta`), o título, a situação (`pendente`, `aprovado`, `recusado`, `nova_analise`, `expirado`), a versão atual, a demanda de origem (uma demanda vira um plano só) e quem pediu, até quando espera a decisão e a fila da nova análise (tentativas, quando volta, o último erro); a pendente que passou do prazo aparece como `expirado` (0035) |
| `plan_version` | Uma versão do plano, imutável: o conteúdo (contrato `PlanContent`), os números com a fonte de cada um e os textos marcados (ditos pelo código), o risco, quanto muda a verba por mês, o hash do conteúdo (é o que a aprovação assina), quem escreveu (`estrategista` ou `pessoa`, com quem editou), o pedido de nova análise que a gerou e a chamada em `ai_usage`; uma por plano e número (0035) |
| `plan_decision` | Cada decisão sobre um plano: a versão e o hash vistos, `aprovado` (com o código do app), `recusado` (com os motivos) ou `nova_analise` (com o pedido), o comentário sem dado pessoal e quem decidiu; a aplicação só lê e insere (0035) |
| `commercial_date` | O calendário comercial (do produto): feriados nacionais e datas do varejo, cada uma com a lei ou a regra de onde vem; a semente vai de outubro de 2026 a dezembro de 2027; só a rotina do sistema grava (0035) |
| `approval` | Quem, quando, canal, `plan_hash` aprovado, expiração; invalidada se o plano mudar |
| `action_request` | Ação proposta: ferramenta, parâmetros, `risk_level`, `budget_impact`, `action_fingerprint` (UNIQUE entre as ativas) |
| `action_execution` | `before_state`, `expected_state`, `desired_state`, `provider_version`, `executed_at`, ator, aprovação, `compensation_strategy`, resultado |
| `tool_execution` | Cada chamada de ferramenta (entrada sem PII, saída resumida, duração, erro) |
| `budget_policy` | Limites por marca, conta e período |
| `budget_ledger_entry` | `requested → reserved → executed → reported → actual_spend`, com lock por conta; orçamento configurado ≠ gasto real |
| `autonomy_rule` | Modo por tenant, marca, conta, ferramenta, ação, valor e risco. **Não virou tabela:** é a regra `autonomy` do documento da política (`policy`, versionada por empresa e por marca desde a 0010); a promoção da I13 publica a versão seguinte da política da marca |
| `autonomy_proposal` | A proposta de promoção de autonomia (A3, I13): conta e ação da sombra, de `SHADOW` para `SUGGEST`, o retrato da prontidão que passou nos portões (com a amostra e os sinais na hora), a situação (`pendente`, `aprovada`, `recusada`, `retirada`, `desfeita`), quem decidiu e quando, a versão da política da marca que a aprovação publicou, quem voltou para Sombra e a versão dessa volta, o motivo (sem dado pessoal) e a amostra a partir da qual o sistema propõe de novo; uma pendente por conta e ação; só o sistema insere (0038) |
| `readiness_snapshot` | Sinais do índice de prontidão por conta × ferramenta, um retrato por dia: amostra comparável, concordância com a pessoa, parte em que teria piorado, soma do arrependimento, confiança média e o que falta para propor a promoção (0030) |
| `shadow_decision` | Recomendação em sombra (ferramenta, regra e versão, parâmetros), confiança, retrato do estado, janela olhada, ação da pessoa vista pela leitura diária, resultado posterior e `action_regret_micros` com o rótulo; uma em aberto por campanha (0030) |
| `shadow_state` | A vez de cada marca na rotina da sombra: último dia rodado e quando volta (0030) |
| `human_override` | Quando a pessoa discorda na tela: recomendada × executada, código do motivo e texto; a pessoa grava só em nome dela (0030; a rota chega com a tela em que a pessoa discorda de uma sugestão, que ainda não tem protótipo) |
| `weekly_review` | A revisão da semana de uma marca (A3, I7): a semana (de segunda a domingo, no fuso da loja), quando foi gerada, quem escreveu a leitura (`lia` ou `sistema`, com o motivo), a linha de uso da IA, o conteúdo como a tela e o e-mail mostram (com a versão) e a situação do envio por e-mail; uma por marca e semana (0032) |
| `weekly_review_delivery` | Quem recebeu a revisão por e-mail: pessoa, nível na hora do envio, enviado ou falhou (com o tipo do erro, sem o endereço) e as tentativas; uma linha por pessoa e revisão (0032) |
| `weekly_review_state` | A vez de cada marca na rotina da revisão: última situação, última semana com revisão e quando volta (0032) |
| `brand_dossier_version` | O dossiê da marca (A3, I8): uma linha por versão salva, com o conteúdo inteiro (contrato `BrandDossierContent`, com a versão dele), o hash do texto que vai ao modelo, o que mudou, como nasceu (`pessoa`, `sugestao`, `restaurada`, `mesclada`) e quem salvou; uma por marca e número; a aplicação só lê e insere (0033) |
| `brand_dossier_suggestion` | Sugestão para uma parte do dossiê esperando conferência: de quem (`sistema`, `lia`, `pesquisador`), os itens (incluir, tirar, trocar, com o porquê), a versão que olhou e a decisão (usada, com os itens marcados e a versão gerada; descartada; ou substituída pelo sistema); uma pendente por marca, parte e autor (0033) |
| `research_request` | O pedido de leitura de uma página pelo Pesquisador (A3, I12): o tipo (`site`, `cardapio`, `concorrente`), o endereço e o site, quem pediu, a situação (`pendente`, `lendo`, `concluida`, `recusada`, `falhou`, com o porquê), a fila (tentativas, quando volta), os rótulos que passaram na conferência e as contas do que saiu, as partes do dossiê que ganharam sugestão e a chamada em `ai_usage`; o mesmo endereço não entra duas vezes na fila da marca. **A página não é guardada** (0037) |
| `knowledge_item` | A base da agência (do produto, não da empresa): chave, versão, situação, texto, hash, licença e aviso de origem; uma ativa por chave; só a rotina do sistema grava (0033) |
| `conversation` | A conversa com a LIA (A3, I10): de quem a abriu (a regra de acesso usa a empresa E a pessoa: só ela vê), a marca, o título (a primeira mensagem, sem dado pessoal), as respostas da LIA (o limite por conversa conta estas), a marca de "respondendo" (uma resposta por vez; vence em 3 minutos) e a última mensagem; sai 30 dias depois da última (0034) |
| `conversation_message` | Uma mensagem: da pessoa (o texto já sem dado pessoal e quantos dados saíram), da LIA (os blocos conferidos, a fonte de cada número, o que ela leu, os cartões e a chamada em `ai_usage`, que o retorno da pessoa referencia) ou do sistema (o aviso); `ok` ou `parada`; não muda depois de gravada; sai em 30 dias (0034) |
| `demand` | O pedido que a LIA registra para a equipe: tipo (`promocao`, `plano`, `pauta`, `analise`, `outro`), título, o pedido sem dado pessoal, anotações, quem cuida (o Estrategista), para quando, situação (`aberta`, `em_andamento`, `entregue`, `cancelada`), quem pediu e de qual conversa e mensagem veio (uma demanda por mensagem); fica com a marca depois que a conversa some (0034). A fila do Estrategista na mesma linha: tentativas, quando volta (o prazo da reserva enquanto está `em_andamento`) e o último erro (0035). A demanda que a rotina de segunda-feira abre (sem pessoa) leva a chave da rotina (`pauta:2026-10-05`, `noventa_dias:2026-10-05`), única por marca (0036) |
| `kill_switch` | Nível (global, provider, tenant, marca, conta, ferramenta), escopo, quem, quando |
| `feature_flag` / `flag_override` | Flags por ambiente, plano, tenant, marca, conta, usuário |

**Compensação:** antes de reverter, `readState()` no provider. Se o estado atual ≠ `expected_state`, **não sobrescreve** (houve mudança humana) e escala.

## 7. Registro e versões

`agent_definition` (funcionário: cargo, responsabilidades, ferramentas permitidas, políticas, rotas de modelo, KPIs) + `agent_activation` (qual funcionário está ativo para qual tenant/marca/plano), `tool_registry`, `connector_capability`, `policy` / `policy_template`, `prompt_version`, `model_route`, `knowledge_item` (dossiê estruturado e base da agência): todos versionados com `status, created_by, eval_score, deployed_at`.

**No banco desde a migration 0029 (A3, I2):** `tool_registry(name, version, status, risk, permission, description, input_schema, owner, content_hash, deployed_at, retired_at)`, `prompt_version(key, version, status, task, content, content_hash, eval_score, deployed_at, retired_at)` e `agent_definition(key, version, status, name, definition, content_hash, eval_score, deployed_at, retired_at)`: do produto, uma versão ativa por nome, nunca apagadas; quem grava é o worker, na subida, a partir das definições do código. `agent_activation(tenant, brand, agent_key, enabled, set_by, reason)`: da empresa; ela lê, a distribuição grava. A escolha da própria empresa chegou na I13b (0039): `agent_pause(tenant, brand, agent_key, paused_by, paused_at, reason, resumed_by, resumed_at)`, uma linha por vez que alguém desliga um membro da equipe numa marca (ligar de novo fecha a linha; uma aberta por marca e membro; o Compliance não desliga); vale também para quem trabalha por regra (Relatórios, Gestor de tráfego). `model_route` é a `ai_model_route` da 0028; `knowledge_item` chegou na I8 (0033) como a **base da agência**, do produto: uma versão ativa por chave, com a licença e o aviso de cada texto; a empresa não edita e nenhuma rota a entrega. O dossiê de cada marca, que é da empresa, ficou em `brand_dossier_version` e `brand_dossier_suggestion` (§6).

## 8. Auditoria e uso de IA

- `audit_event` (append-only, sem UPDATE/DELETE na role da aplicação): `who, actor_type [human|agent|integration|system|partner], tenant, brand, unit, action, resource, before, after, reason, approval_id, trace_id, tool, agent, model, occurred_at, prev_hash, hash`.
- `audit_anchor(day, root_hash, anchored_at, anchor_ref)`: o `daily_root_hash` publicado **fora** do banco (security-model §7).
- `ai_usage(tenant, brand, user, workflow, task, route_version, prompt_version, provider, model, served_by [principal|reserva|economico], inference_geo, input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, reasoning_tokens, cost_usd_micros, latency_ms, tool_calls, tool_failures, outcome [ok|erro|teto|limite_usuario], error_code, pii_removed, trace_id, occurred_at)`: uma linha por tentativa de chamada; a aplicação só insere (migration 0028).
- `ai_exchange(usage_id, tenant, request, response)`: o que foi enviado ao modelo e o que voltou, já sem dado pessoal; apagado em 30 dias pelo expurgo.
- `ai_feedback(tenant, usage_id, user, verdict [fez_sentido|discordo], reasons [numero|motivo|faltou|sugestao], comment, created_at, updated_at)`: o retorno da pessoa sobre uma explicação da IA (migration 0031); um por pessoa e explicação; a empresa lê os dela, cada pessoa grava só em nome dela, e ninguém apaga pela aplicação; some com a linha de uso. O comentário é limpo de dado pessoal antes de gravar, e nada disto vai ao fornecedor do modelo.
- `ai_model_price(provider, model, valid_from, preço por milhão de tokens em micros de dólar: entrada, saída, cache lido, cache escrito 5 min e 1 h, source, checked_on)` e `ai_model_route(task, version, status, purpose, provider, model, effort, max_output_tokens, timeout_ms, max_cost_usd_micros, fallback, economy_provider, economy_model, eval_threshold, eval_score, created_by, deployed_at)`: do produto, sem dado de empresa; uma rota ativa por tarefa.
- `ai_budget(tenant, daily_usd_micros, monthly_usd_micros, set_by, reason)`: teto de custo de IA da empresa; ela lê, só a distribuição grava.

## 9. Retenção (proposta inicial)

| Classe | Retenção |
| --- | --- |
| Payload bruto de connectors | 90 dias (tempo para reprocessar mapeamentos) |
| Logs operacionais | 30 dias |
| Traces | 14 dias (amostrados); traces de ação financeira, 180 dias |
| Prompts e respostas de IA | 30 dias com conteúdo; depois só metadados e hashes |
| Retorno da pessoa sobre uma explicação da IA | com a empresa (some com a linha de uso da explicação); sem autor se a conta da pessoa for excluída |
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
