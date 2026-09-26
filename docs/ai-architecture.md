# Liame — Arquitetura de IA

> Status: **aprovado pelo dono em 26/09/2026** (proposta de 24/09/2026). Princípio: **a IA auxilia, o código decide.** A IA é camada de inteligência, não fundação operacional.

## 1. Camadas

```text
Funcionários  Atendimento · Estrategista · Pesquisador · Analista · Relatórios · Compliance · Gestor de tráfego · Criativo · CRM · … (N)
                    │                 │                    │                    │
Runtime       Motor de Análise e Planejamento    Motor de Execução    Policy Engine + Revisor de Compliance
                    │                                      │
Composição    prompt + skills + ferramentas + conhecimento + políticas + workflows + seleção de modelo
                    │
Infra         AI Gateway (adapters) · Tool Registry · AI Usage Ledger · Evals · Traces
```

- **Motor de Análise e Planejamento:** conversa, pesquisa, diagnóstico, plano, pauta, criação. Só tem ferramentas **R0** (leitura) e de **abrir pedido ou proposta**. Produz planos e Action Requests em estado `proposed`.
- **Motor de Execução:** recebe Action Requests aprovadas (ou autorizadas por política) e as leva ao Action Service. Não "pensa em estratégia", executa com checagens.
- **Policy Engine (determinístico) + Revisor de Compliance (IA):** o código decide. O revisor só assessora em texto (tom, alegações, clareza) e nunca aprova sozinho.

**Cada funcionário é uma definição no Agent Registry, não um runtime:** `agent_id, versão, cargo, responsabilidades, skills, ferramentas permitidas (subconjunto do Tool Registry), políticas e modos de autonomia, rotas de modelo por tarefa, workflows que possui, KPIs, eval_score, status`. Criar um funcionário novo é criar uma definição, passar no eval dela e publicar uma versão. Nada de código de runtime novo. Ativar um funcionário para um cliente é uma permissão por plano e por marca.

## 2. AI Gateway (`apps/server/src/modules/ai`)

Nenhum módulo chama SDK de provedor diretamente. A interface é da DMS:

```ts
interface AiGateway {
  generate(req: GenerateRequest): Promise<GenerateResult>;
  stream(req: GenerateRequest): AsyncIterable<StreamEvent>;
  structured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>>; // schema Standard Schema/Zod
  embed(req: EmbedRequest): Promise<EmbedResult>;
  rerank(req: RerankRequest): Promise<RerankResult>;
  toolCall(req: ToolCallRequest): Promise<ToolCallResult>;
  agent(req: AgentRunRequest): AsyncIterable<AgentEvent>;              // loop com ganchos por rodada
  image(req: ImageRequest): Promise<ImageResult>;                      // geração de imagem (estável no AI SDK)
  video(req: VideoRequest): AsyncIterable<VideoEvent>;                 // assíncrono; só com provedor estável
}
```

Adapters: `AnthropicAdapter` (primeiro), `OpenAIAdapter`, `GoogleAdapter`, `FutureProviderAdapter`. O gateway aplica, em toda chamada: **sanitização de PII** (classificação de dados), orçamento do AI Usage Ledger, timeout, trace `gen_ai.*`, registro de versões e custo. Se a base de baixo nível é o SDK oficial de cada provider ou um SDK agregador, é decidido no ADR-006 (pesquisa + spike). Em qualquer caso, **a semântica interna é da DMS**.

## 3. Model routing por tarefa

Configuração versionada (dado, não código):

| Campo | Exemplo |
| --- | --- |
| `task_type` | `campaign_decision` |
| `provider` · `model` | `anthropic` · (escolhido por eval) |
| `reasoning_effort` · `max_tokens` | `high` · `16000` |
| `max_cost` · `latency_target` | `US$0,20` · `p95 60 s` |
| `fallback` | lista ordenada, **somente modelos com eval aprovado nessa tarefa** |
| `eval_threshold` | nota mínima no dataset da tarefa |

Tarefas iniciais: `strategic_plan`, `creative_generation`, `comment_classification`, `weekly_summary`, `anomaly_explanation`, `campaign_decision`, `compliance_review`, `client_conversation`. A escolha é por **qualidade medida, custo, latência e disponibilidade**, nunca por preferência de fornecedor.

### 3.1 Perfis por finalidade e escolha do cliente (ADR-016)

- **Finalidades:** conversa e atendimento · análise e decisão · texto criativo · imagem · vídeo curto · voz (depois). Cada `task_type` pertence a uma finalidade.
- **Catálogo curado pela distribuição:** o modelo só entra numa finalidade depois do eval dela, com contrato de dados, preço e limite conhecidos.
- **Lite:** "Automático (recomendado)". **Pro:** escolhe por finalidade dentro do catálogo, vendo custo, velocidade e nota; a troca é auditada.
- **Sem chave própria do cliente (BYOK)** por enquanto: exigiria que o cliente manuseasse segredo.
- Mídia gerada passa pelo Compliance, leva credencial de conteúdo quando houver (C2PA, SynthID) e rótulo de IA onde for exigido.

## 4. Autonomia

### 4.1 Modos

`SHADOW` · `SUGGEST` · `APPROVAL` · `LIMITED_AUTO` · `AUTO` · `ESCALATE`

Configuráveis por **tenant, marca, conta, ferramenta, tipo de ação, faixa de valor e nível de risco**. A regra mais específica vence, e `ESCALATE` vence sempre. O padrão de uma ferramenta nova é `SHADOW`. Exemplo de política:

```yaml
autonomia:
  - acao: anuncio.pausar            modo: AUTO
  - acao: orcamento.aumentar        ate_pct: 10          modo: LIMITED_AUTO
  - acao: orcamento.aumentar        acima_brl: 300       modo: APPROVAL
  - acao: campanha.criar                                  modo: APPROVAL
  - acao: campanha.apagar                                 modo: ESCALATE
```

O "envelope do mês" da D7 é uma política `LIMITED_AUTO` com teto financeiro mensal por marca.

### 4.2 Autonomy Readiness Score

Promover uma ferramenta, em uma conta, de `SHADOW → SUGGEST → LIMITED_AUTO` exige passar em gates objetivos. Os limiares iniciais serão calibrados no piloto:

| Sinal | Gate inicial (proposta) |
| --- | --- |
| `sample_size` (decisões comparáveis) | ≥ 30 |
| `human_ai_agreement` | ≥ 80% |
| `policy_violations` | 0 nas últimas 30 decisões |
| `false_positive_rate` / `false_negative_rate` | ≤ 10% / ≤ 15% |
| `backtest_regret` | ≤ 0 (não pior que o humano) |
| `data_freshness` | dado `fresh` em ≥ 95% das decisões |
| `confidence` média | ≥ 0,7 |
| `action_success_rate` (execuções sem erro) | ≥ 98% |

Os 30 dias ficam como **referência operacional**, não como regra: conta pequena pode precisar de mais tempo, conta grande pode gerar evidência antes. **A promoção é proposta pelo sistema e aprovada por um humano**, sempre com versão registrada.

### 4.3 Sombra de verdade e action regret

Em `SHADOW`, cada recomendação grava: ação recomendada, confiança, snapshot do estado, ação humana realizada (ou nenhuma), resultado posterior e **`action_regret`**, que responde "se o agente tivesse sido autorizado, teria melhorado ou piorado?". O regret alimenta evals, readiness, revisão de políticas e decisões futuras.

## 5. Heurísticas como priors, não leis

Regras vindas das skills (esperar 3× o CPA, +20% de verba, frequência > 4, CTR −20%, CPM +30%) viram **Policy Templates** versionados:

`id, fonte, provider, versão, confiança, applicable_when, parametros, review_at, tenant_override`

Presets por segmento (restaurante local, e-commerce, SaaS, franquia, agência, infoproduto) ficam **possíveis** sem código novo. O marketplace de presets não é implementado agora.

## 6. Conteúdo não confiável

Comentários, DMs, avaliações, páginas, concorrentes, documentos e URLs são `UNTRUSTED_CONTENT`.

```text
Untrusted Reader (modelo sem NENHUMA ferramenta de escrita ou saída)
   → rótulos estruturados validados por schema (sentimento, intenção, risco, tópicos)
   → contexto confiável de decisão
```

Nunca concatenar texto externo ao system prompt. Remover caracteres invisíveis e markup e nunca devolver links montados. Os evals incluem ataques de injeção.

## 7. Conhecimento plugável

O dossiê da marca é **estruturado**: `brand_identity, voice, personas, products, offers, proof, forbidden_claims, competitors, geo, seasonality, policies`. A versão textual para o modelo é gerada sob demanda, em ordem estável (bom para cache de prompt). A base de conhecimento da agência (as skills MIT/Apache adaptadas para Brasil, WhatsApp e LGPD) é versionada na distribuição, com NOTICE de licença.

## 8. Governança: versão, reprodutibilidade, explicação

- **Versionar** prompts, políticas, ferramentas e rotas de modelo: `id, versão, status, criado_por, eval_score, deployed_at`. Nada muda em silêncio.
- **Reprodutibilidade:** toda execução relevante guarda snapshot de entrada (sem PII desnecessária), versões dos dados, do prompt, do modelo, das ferramentas e das políticas, e a decisão.
- **Explicação** no formato: ação · motivos com números · risco · impacto estimado. Exemplo: *"Recomendo reduzir o orçamento em 15%. Motivos: CPA 32% acima da meta há 4 dias; 38 conversões observadas; CTR −21%; há campanha substituta. Risco: médio. Impacto estimado: −R$82/dia."*
- **Human override** registrado (`recommended_action, executed_action, human_override, override_reason`) e usado em evals.
- **Sem autoaprendizado sem governança:** o agente pode **propor** mudanças em prompts ou políticas; elas seguem `proposta → revisão → eval → aprovação → versão → deploy`.
- **IA não calcula número final:** ROAS, CPA, CAC, LTV, margem e uso de orçamento vêm de código. A IA recebe os números prontos e os interpreta.

## 9. Evals como portão de produção

Datasets versionados em `evals/`: golden scenarios, policy attacks, prompt injection, budget bypass, cross-tenant leakage, hallucination, unsafe tool selection, wrong attribution, wrong campaign decision. Mudar **prompt, ferramenta, modelo, connector ou policy** dispara o conjunto relevante no CI. Cada tarefa tem limiar mínimo, e **regressão relevante bloqueia o deploy**. A ferramenta de execução dos evals é escolhida no ADR-006.

## 10. AI Usage Ledger e orçamento de IA

Registro por `tenant, workflow, task, model, provider`: tokens de entrada e saída, cache hit, latência, custo, tool calls e falhas, bloqueios de política, aprovações, concordância, sucesso e regret. Controles: orçamento de tokens, de custo diário e mensal, e franquia do plano. **Degradação elegante** ao atingir a franquia: modelo premium → modelo econômico **com eval aprovado** → só workflows determinísticos, antes de bloquear, conforme o plano comercial. O painel interno mostra custo por tenant, por workflow e por resultado, approval rate, sucesso, override, violações e latência p95.

## 11. Proibições

- Agente acessando banco ou API externa diretamente.
- Agente com token de plataforma.
- MCP como barramento interno.
- Juntar dois tenants no mesmo prompt ou batch.
- PII desnecessária em prompt (o gateway pseudonimiza).
- Fallback silencioso para modelo sem eval em ação financeira.
- Agente alterando os próprios prompts ou políticas.
