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
  - **No código (A3, I9, parte por regra, 02/10/2026):** `apps/server/src/policy/texto.ts` confere todo texto gerado antes de ele aparecer: **político e eleitoral** (pedido de voto, cargo, eleição, propaganda eleitoral), **promessa de resultado** ("retorno garantido", "lucro certo"), **categoria proibida** pelas plataformas de anúncio (tabaco, armas, apostas, drogas) e **dado pessoal** (os mesmos padrões da limpeza antes do envio). O que a regra barra cai no texto sem IA. O nome de uma campanha ou conta da própria empresa pode ser citado; o que se confere é o que a IA escreveu em volta. E, com campanha ou conta de **nome político ou eleitoral**, a IA **nem é chamada** (`conteudo_politico`). As listas têm versão (`REGRAS_DE_TEXTO_VERSAO`) e teste de falso positivo. O revisor de IA (tom, clareza, alegações) entra depois, e nunca aprova sozinho.

**Cada funcionário é uma definição no Agent Registry, não um runtime:** `agent_id, versão, cargo, responsabilidades, skills, ferramentas permitidas (subconjunto do Tool Registry), políticas e modos de autonomia, rotas de modelo por tarefa, workflows que possui, KPIs, eval_score, status`. Criar um funcionário novo é criar uma definição, passar no eval dela e publicar uma versão. Nada de código de runtime novo. Ativar um funcionário para um cliente é uma permissão por plano e por marca.

**No código (A3, I2, 02/10/2026):** as definições ficam em `apps/server/src/ai/registro` (ferramentas de leitura, prompts, funcionários) e em `actions/tools.ts` (ferramentas de escrita), cada uma com **versão explícita**. O arquivo `apps/server/ia-registro.lock.json` guarda a versão e o hash de cada uma: o teste reprova conteúdo que mudou sem subir a versão, e `pnpm --filter @liame/server ia:lock` atualiza a trava no mesmo PR. Na subida, o worker grava cada versão em `tool_registry`, `prompt_version` e `agent_definition` (a anterior fica "aposentada"; mesma versão com conteúdo diferente é recusada). `agent_activation` diz qual funcionário trabalha para qual empresa ou marca; sem linha, vale o padrão da definição. Os prompts e os funcionários entram com o primeiro uso de cada um (o Analista, na I4).

## 2. AI Gateway (`apps/server/src/ai`)

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

**No código (A3, I1, 02/10/2026):** `generate` e `structured` estão prontos desde a I1 e `agent` (o laço com ferramentas, ainda sem transmissão ao vivo) desde a I2; `stream` entra com a Conversa (I10), junto do primeiro uso real. Em toda chamada, nesta ordem: flag `ia` da empresa → trava (kill switch global, do provider `ai`, da empresa ou da marca) → rota ativa da tarefa → limite de chamadas por pessoa → teto de custo → remoção de dado pessoal → modelo da rota, com reserva só da própria rota → custo → `ai_usage` (uma linha por tentativa) e `ai_exchange` (o conteúdo, por 30 dias).

- A chamada **não roda dentro da transação da requisição**: leva segundos, e o custo fica gravado mesmo que a requisição desista.
- **Toda falha é um erro só** (`AiError`: desligada, travada, sem rota, entrada grande demais, limite da pessoa, teto, indisponível). Quem chama cai no caminho sem IA.
- **Entrada com tamanho máximo** (200 mil caracteres entre instruções e mensagens): o teto é conferido antes da chamada, então um pedido só não pode custar mais que o teto do dia.
- **Dado pessoal** (e-mail, telefone, CPF, CNPJ, CEP) sai do que é enviado, do que é devolvido a quem chamou e do que fica guardado. Quem monta o contexto manda os números já formatados: número cru com 10 dígitos ou mais parece telefone ou CPF e sai na limpeza.
- **Modelo sem credencial ou sem preço cadastrado não roda:** custo que não se mede não se gasta.
- **Trace:** um span `chat {modelo}` com atributos `gen_ai.*` só técnicos (fornecedor, modelo, tokens). A telemetria do próprio SDK fica desligada, porque ela grava entrada e saída. O erro do SDK guarda o corpo enviado: só o código do motivo vai para o log e para o registro.
- **Laço com ferramentas (`agent`, I2):** o modelo pede uma leitura, o código executa e devolve o resultado, até vir a resposta em texto. Cada rodada é uma chamada registrada em `ai_usage` (com `tool_calls` e `tool_failures`); o teto da empresa é conferido de novo a cada rodada, contando o que o pedido já gastou; há limite de rodadas (6 por padrão, 12 no máximo) e o teto de custo da rota vale para o pedido inteiro. A reserva da rota só entra na primeira rodada. Ferramenta que falha vira um aviso curto para o modelo, nunca o erro interno, e a saída de toda ferramenta passa pela limpeza de dado pessoal e tem tamanho máximo (60 mil caracteres: ela volta ao modelo como entrada paga da rodada seguinte). O limite por pessoa conta chamadas ao modelo, não pedidos: um pedido com várias rodadas pesa mais (rever com a Conversa, I10).

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

**No código (A3, I5, 02/10/2026):** a primeira sombra é **por regra, sem modelo de IA** (as regras em `apps/server/src/sombra`; a rotina, que grava em escopo de sistema, em `apps/server/src/worker`). Uma vez por dia da loja, depois da leitura da manhã, a rotina do worker (`SombraLoop` + `SombraService`) lê os resultados dos últimos 7 dias completos **como a tela Resultados lê** e registra em `shadow_decision` o que o Liame recomendaria para cada campanha ativa, com a confiança e o retrato do estado. Regras da versão 1 (`regras.ts`): prejuízo forte (margem conhecida abaixo da metade do investimento) → **pausar a campanha**; prejuízo → **reduzir a verba em 20%**; lucro folgado (margem de 1,5 vez o investimento) com a verba no limite → **aumentar a verba em 20%**. Só com gasto de R$ 50 ou mais na janela e com veredito (margem conhecida em 80% da receita); recomendação de verba só quando a verba diária está na campanha. **Dado velho não gera recomendação**: toda fonte precisa estar em dia e a plataforma de anúncio, lida no próprio dia. Uma recomendação em aberto por campanha.

Nos dias seguintes a rotina compara a campanha com o retrato e grava a **primeira ação da pessoa** (pausou, reduziu ou aumentou a verba em 5% ou mais) e a concordância (igual, mesma direção, contrária, nenhuma). Passados 7 dias, lê o resultado da campanha na janela posterior e calcula o **arrependimento**: resultado de verdade (margem conhecida − investimento) menos o estimado se a recomendação tivesse sido executada; **negativo = o Liame teria feito melhor**. A estimativa é linear e declarada: pausar zera o resultado da janela; mexer p% na verba mexe p% no resultado. Vale só quando a pessoa não foi para outro lado; sem margem conhecida em 80% da receita, o rótulo é `sem_dado` e a decisão não entra na amostra. Limite conhecido: pedido de clique anterior à decisão conta na janela posterior. A cada avaliação a rotina grava o retrato do dia em `readiness_snapshot` (amostra comparável, concordância, parte em que teria piorado, soma do arrependimento, confiança média e o que falta). Tudo atrás da flag `sombra`, desligada por padrão; nada é executado em plataforma nenhuma.

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

**No código (A3, I3, 02/10/2026):** `evals/<tarefa>/casos.jsonl` guarda os casos; o contexto de cada um é montado pelo código de produção e a resposta é conferida por um **avaliador determinístico** (`apps/server/src/ai/evals`), o mesmo que em produção decide se a explicação da IA vai para a tela. O promptfoo (pela versão fixada, via `npx`) só percorre os casos e junta o relatório; o **portão** (`evals/apoio/portao.mjs`) exige 100% nos grupos `numero` e `injecao` e a nota do conjunto no limiar da tarefa (0,95 de partida). Cada caso traz uma resposta boa e respostas ruins gravadas: o CI roda o eval em **modo gravado**, sem chave e sem custo, e prova que a boa aprova e a ruim reprova. O eval com modelo de verdade roda só quando muda prompt, ferramenta, modelo ou política, e depende da chave da distribuição. Primeira tarefa: `explicar_resultados`, com 17 casos (`evals/README.md`).

**Verificador de números (A3-5):** `apps/server/src/ai/verificador-numeros.ts` compara cada número e cada data da resposta com o contexto entregue (a data conta inteira: o "10" de outubro não autoriza "10%"). Número fora do contexto derruba a resposta, e a tela mostra a explicação sem IA, montada por regra com os mesmos números (`ai/explicar/sem-ia.ts`).

## 10. AI Usage Ledger e orçamento de IA

Registro por `tenant, workflow, task, model, provider`: tokens de entrada e saída, cache hit, latência, custo, tool calls e falhas, bloqueios de política, aprovações, concordância, sucesso e regret. Controles: orçamento de tokens, de custo diário e mensal, e franquia do plano. **Degradação elegante** ao atingir a franquia: modelo premium → modelo econômico **com eval aprovado** → só workflows determinísticos, antes de bloquear, conforme o plano comercial. O painel interno mostra custo por tenant, por workflow e por resultado, approval rate, sucesso, override, violações e latência p95.

**No código (I1):** custo em micros de dólar = tokens × `ai_model_price` (a linha que valia na data), contando o cache lido e o escrito, × 1,1 quando o modelo roda fixo nos Estados Unidos; a soma é em inteiro. Teto diário e mensal por empresa (`ai_budget`, ou o padrão do ambiente), virando no fuso da empresa: **70% avisa, 80% usa o modelo econômico da rota (se ela tiver), 100% barra** e registra o pedido barrado. O teto é conferido antes da chamada, sem reserva: chamadas simultâneas podem passar dele pelo custo das que já estavam em curso, o que é limitado pelo `max_output_tokens` da rota e pelo limite por pessoa.

## 11. Proibições

- Agente acessando banco ou API externa diretamente.
- Agente com token de plataforma.
- MCP como barramento interno.
- Juntar dois tenants no mesmo prompt ou batch.
- PII desnecessária em prompt (o gateway pseudonimiza).
- Fallback silencioso para modelo sem eval em ação financeira.
- Agente alterando os próprios prompts ou políticas.
