# ADR-007 — Policy Engine determinístico + Action Service

- **Status:** Aceito · 26/09/2026 (proposto em 24/09/2026; aprovado com o plano completo pelo dono)
- **Decide:** como qualquer ator (humano, agente, API, automação, MCP, parceiro) muda algo fora do Liame

## Contexto

Agentes vão propor gasto de dinheiro real e envio de mensagens a clientes. Quem gasta verba sem controle, bloqueia conta de anúncio ou fere a LGPD destrói a confiança no produto. LLM não é mecanismo de controle.

## Decisão

### Fluxo único

```text
Ator → Tool (Tool Registry) → Policy Engine → Serviço de domínio → Action Request (plan_hash, action_fingerprint)
     → Budget Engine (reserva no ledger) → Approval (se exigida) → Action Service → Connector → Provider
     → Audit + Outbox
```

### Policy Engine

- **Determinístico e versionado.** Regras: orçamento, teto, % máxima de mudança, horário, conta permitida, tenant, escopo, consentimento, opt-out, frequência de envio, palavras e categorias proibidas, temas regulados, **conteúdo político** (bloqueado por padrão), ações destrutivas, limites de mudança por provider (Meta: no máximo 4 mudanças de orçamento por hora por conjunto, e o nosso limite fica abaixo).
- **Avaliação:** `Action → regras determinísticas → (Revisor de Compliance de IA, se a regra pedir) → aprovação → execução`. A IA só assessora (texto, tom, alegações). **O código decide.**
- **Forma:** políticas como dado (YAML/JSON validado por schema) avaliadas por um motor TypeScript próprio e simples. Cedar e OPA foram considerados. Adotá-los fica para quando as políticas passarem de dezenas de regras ou vierem de terceiros, porque hoje seriam mais uma linguagem e mais um runtime sem ganho proporcional.
- **Autonomia:** 6 modos (`SHADOW`, `SUGGEST`, `APPROVAL`, `LIMITED_AUTO`, `AUTO`, `ESCALATE`) por tenant, marca, conta, ferramenta, ação, valor e risco (`ai-architecture.md` §4).
- **Priors:** heurísticas de mídia como Policy Templates versionados, com fonte, confiança e override.

### Action Service

- **Única porta de escrita externa.** Nenhum agente recebe token de plataforma.
- Antes de executar, checa: kill switch (global, provider, tenant, marca, conta, ferramenta), feature flag, validade da aprovação (hash do plano), `action_fingerprint` (impede duplicata concorrente), circuit breaker do provider.
- Execução com `validate_only` quando o provider oferecer; **criação sempre pausada**; idempotência por chave ou fingerprint.
- Registra `before_state`, `expected_state`, `desired_state`, `provider_version`, `executed_at`, ator e aprovação.

### Compensação (em vez de "desfazer")

Toda ação declara `compensation_strategy`. Para reverter: `readState()` → se o estado atual **≠ `expected_state`**, alguém (provavelmente humano) mexeu depois: **não sobrescreve**, escala. Concorrência otimista quando o provider permitir (versão ou ETag).

### Orçamento

Ledger com lock por conta: `budget_policy → requested → reserved → executed → reported → actual_spend`. Orçamento configurado ≠ gasto real. Teto também dentro da plataforma (`spend_cap` na Meta) como última barreira. Disjuntor: gasto real acima do envelope → pausa e alerta.

### Aprovação

Amarrada ao `plan_hash`; plano alterado invalida a aprovação. Ações com risco ≥ R2 ou `budget_impact > 0` são aprovadas **fora do chat** (tela com login + PIN/2FA). O link de 1 toque pelo WhatsApp é de uso único, com TTL curto, amarrado a plano + usuário + aparelho, e **só** para risco baixo sem impacto financeiro.

## Consequências

- Toda ferramenta nova só entra com risco, impacto financeiro, estratégia de compensação e testes de política.
- O Action Service é a peça mais testada do sistema (critérios A1-9 a A1-11).

## Implementação do kill switch (E6a, 26/09/2026)

- Tabela `kill_switch` (migration 0009) com os seis níveis e a forma de cada um checada no banco. `KillSwitchService.check(tx, alvo)` devolve a trava mais ampla que pega o alvo (empresa, provedor, marca, conta, ferramenta); o Action Service (E6c) chama antes de executar, e a trava prevalece sobre flags e autonomia.
- A empresa aciona e desliga as suas (`/v1/kill-switches`, permissão `parada.acionar`: Dono, Administrador e Gestor), com auditoria (`parada.acionar`, `parada.desligar`) e evento `liame.kill_switch.activated`/`deactivated` (a pausa das entidades criadas pelos agentes entra com os connectors, A2). Global e provedor são da distribuição (escopo de sistema); a empresa vê, mas não desliga.

## Implementação do motor de políticas (E6b, 26/09/2026)

- **Documento** (`PolicyDocument`, contrato em Zod): regras `max_value`, `max_change_percent`, `allowed_hours`, `allowed_accounts`, `allowed_scope`, `forbidden_categories`, `forbidden_words`, `rate_limit` e `autonomy`. Ações em português com curinga (`orcamento.*`).
- **Motor** (`apps/server/src/policy/engine.ts`): função pura. Qualquer violação nega; o modo vem da regra de autonomia mais específica (seletores de ação, ferramenta, conta, risco e faixa; no empate, marca > empresa > plataforma), ESCALATE vence sempre, e sem regra o modo é SHADOW. A contagem para `rate_limit` vem de quem pede (o Action Service conta as execuções).
- **Camadas:** a política da **plataforma** fica no código (versão 1: conteúdo político bloqueado, Meta no máximo 3 mudanças de orçamento por hora, `campanha.apagar` escala) e vale sempre; a da **empresa** e a da **marca** ficam em `liame.policy` (migration 0010), versionadas, uma ativa por escopo, documento imutável.
- **`@Politica(ação, proposta)`** (ADR-013): interceptor logo depois da unidade de trabalho avalia na transação da requisição; negou → 422 `politica-negou` com cada regra em `errors`; permitiu → o handler lê o modo com `currentPolicyDecision()`.
- **Ainda não:** Revisor de Compliance de IA (A3), Policy Templates com priors das skills e presets por segmento (A2/A3).

## Implementação do pedido de ação (E6c, 26/09/2026)

- **Registro de ferramentas** no código (`apps/server/src/actions/tools.ts`): nome, risco, provedores, compensação, parâmetros (Zod) e uma função pura `plan(estado, parâmetros)` que dá a ação para a política (`orcamento.aumentar`/`reduzir`), o impacto, os valores e o estado desejado. Quem pede manda só ferramenta, alvo e parâmetros.
- **Conector sandbox** (`sandbox_resource`, migration 0011): provedor de mentira no banco, com versão (concorrência otimista) e `validateOnly`; os reais chegam na A2 pela mesma interface.
- **Pedido** (`POST /v1/actions`): trava (423) → flag de escrita do provedor → estado lido no provedor → política com a contagem recente na maior janela que casa (422) → `action_fingerprint` único entre os ativos (409; simultâneos esperam o índice e caem em 409) → reserva no envelope do mês, com a linha do envelope travada (422) → plano com `plan_hash` (ferramenta, alvo, parâmetros, valores, estado desejado e versão lida).
- **Modos:** `SHADOW` registra e não reserva; `LIMITED_AUTO`/`AUTO` só saem aprovados com a flag `autopilot` ligada (nasce desligada); os demais esperam aprovação; `ESCALATE` só o dono.
- **Aprovação** (`POST /v1/actions/{id}/approve`): código do app agora (step-up, sem código de recuperação, sem repetir passo) + o `plan_hash` visto. Basta quando o limite de quem aprova cobre a reserva; senão fica registrada e o dono é avisado. Alterar o pedido gera hash novo e a aprovação antiga deixa de valer.
- **Orçamento:** `budget_policy` (envelope do mês da empresa e da marca, no fuso da empresa) e `budget_ledger_entry` só de inserção (`reserva`, `liberacao`, `execucao`); cancelar devolve a reserva. Desde a A4 (X4), numa plataforma de anúncio o envelope é o teto do gasto inteiro do mês (seção "A verba do mês").
- **Falta (E6d):** execução no worker, workflow durável, expiração e o teste ponta a ponta do A1-9.

## Implementação da execução (E6d, 26/09/2026)

- **Executor no worker** (`apps/server/src/worker/action-executor.ts`, laço `acoes`): reserva as ações `aprovada` com `SKIP LOCKED` e executa cada uma sob o contexto da empresa (RLS), conferindo de novo na hora: trava, flag de escrita do provedor, aprovação suficiente para o `plan_hash` atual (ou autonomia com o autopilot ainda ligado). Aplica com `validateOnly` e depois de verdade, com a versão lida no pedido (concorrência otimista): se o recurso mudou, **não sobrescreve** e falha com o motivo.
- **Registro:** `action_execution` (esperado, observado, desejado, resultado, versão), ledger `execucao` (ou devolução da reserva na falha), evento `liame.action.executed`/`failed` e auditoria com ator `system`, origem `worker` e o `approval_id` (quem aprovou fica ligado à execução).
- **Prazos:** pedido sem aprovação em 72 h expira e devolve a reserva; execução travada por 10 min (worker caiu antes do commit) volta para a fila — a versão otimista impede aplicar duas vezes.
- **Workflow durável (ADR-005):** `workflow_run`/`workflow_step` com os passos política → orçamento → aprovação → execução; o passo que espera fica `aguardando` sem job preso e a aprovação libera o seguinte. A ação devolve o `workflow` na API.
- **Com connectors reais (A2):** a chamada ao provedor sai da transação (reserva → chamada → registro), como os webhooks; o sandbox aplica dentro dela porque está no mesmo banco.
- **Ainda não:** compensação executável (a estratégia está declarada em cada ferramenta), circuit breaker por provedor e o agente como solicitante (A3).

## Ferramentas de anúncio, política v3 e a volta (A4, X2, 04/10/2026)

- **Política da distribuição, versão 3:** o limite de frequência da Meta com o provedor das contas (`meta_ads`; na versão 2 dizia `meta` e não casava) e **por objeto** (`per: resource`): 3 mudanças de verba por hora na mesma campanha ou no mesmo conjunto; na Meta, no máximo **10%** de variação da verba por pedido, nos dois sentidos (o plano dizia 20%; decisão do dono em 04/10/2026); e o pedido de **uma pessoa** na Meta espera aprovação (`autonomy` com `provider` e `actor: human`).
- **Seletores novos nas regras:** `provider` em `max_value` e `max_change_percent`; `per` em `rate_limit`; `actor` em `autonomy` (os atores da auditoria: `human`, `agent`…). O ator filtra a quem a regra se aplica e não soma especificidade. A regra que a promoção da sombra escreve leva `actor: agent`.
- **Contagem do limite de frequência:** quem pede conta as execuções recentes **de cada regra** (as ações do padrão da regra, na janela dela, na conta ou só no recurso) e entrega ao motor (`recent`); sem essa conta, vale o `recent_count` da proposta.
- **Teto por ação:** vale para o que faz o gasto subir; a redução e a volta de uma ação ficam de fora (a volta também fica fora da variação máxima: devolve o valor que já estava lá).
- **Limites da empresa obrigatórios** no provedor que gasta dinheiro de verdade (`Connector.requiresSpendLimits`): aumentar verba pede um teto por ação na política da empresa ou da marca; aumentar e retomar pedem o envelope do mês. Sem eles, 422.
- **Compensação executável (a volta):** `ToolDefinition.undo(estado de antes)` dá a ferramenta inversa e os parâmetros; `POST /v1/actions/{id}/undo` cria um pedido comum com `compensates_action_id` (migration 0045), aceito só se a versão lida no provedor é a que a execução guardou (`provider_version`). O que o Liame não escreveu (`sem_escrita`) não tem volta; a volta não muda de parâmetro; uma viva por ação (índice único).
- **Leitura no pedido:** o conector de plataforma lê na rede, esperando no máximo 10 s; a falha vira problema com motivo (502 `plataforma-indisponivel`, 409 `conta-desconectada` ou `sem-permissao-na-plataforma`, 422 `plataforma-recusou`), e nenhum pedido é criado.
- **Marca do pedido:** quando o alvo é uma conta conectada, a marca é a dela (o pedido com outra marca é recusado, 422 `marca-nao-confere`): política, envelope, trava e flags da marca valem sem depender do que o pedido diz.
- **Ainda não:** o gasto real conciliado (X4). O funcionário de IA como solicitante chegou na X3 (abaixo).

## O pedido que nasce de uma recomendação (A4, X3 parte 1, 04/10/2026)

- **`recommendation_id` no pedido** (`POST /v1/actions`, opcional): a recomendação do Gestor de tráfego (`shadow_decision`) de que o pedido nasce. O pedido guarda a ligação em `action_request.shadow_decision_id` (migration 0047; `on delete set null`).
- **O que o Action Service confere:** a recomendação existe para a empresa (a RLS corta a de outra: 404), está em aberto (409 `recomendacao-encerrada`), é da mesma plataforma, conta e campanha (antes de ler o provedor) e o plano vai na direção dela: `orcamento.reduzir`, `orcamento.aumentar` ou `campanha.pausar` (422 `recomendacao-nao-confere`). O valor é de quem pede.
- **O trilho não muda:** trava, flag de escrita, política (o pedido de uma pessoa na Meta espera aprovação com o código do app), limites da empresa, reserva, validação e execução. A ligação não dá nem tira permissão.
- **Alterar** (`PATCH`) para um plano de outra ação tira a ligação, com registro na auditoria (`recommendation_unlinked`).
- **Na resposta** (`recommendation`): a regra, a versão, a confiança, o percentual, o dia, a janela e os números do retrato. Pedidos, receita e margem só para quem tem `vendas.ver`.
- **A conta pura** está em `apps/server/src/sombra/pedido.ts`: a verba recomendada (o percentual sobre a verba de agora, arredondado para a menor unidade da moeda sem passar do percentual), o pedido de cada recomendação e o que confere com ela.

## O funcionário de IA como solicitante (A4, X3 parte 2a, 04/10/2026)

- **`ActionService.pedirPeloFuncionario`** (sem rota: quem chama é a rotina do worker, na transação da empresa): o pedido do Gestor de tráfego no modo Aprovação, sempre a partir de uma recomendação dele (`recommendation_id`).
- **O mesmo trilho:** trava, flag de escrita, estado lido no provedor, política (avaliada com `actor: agent`), limites da empresa, reserva e duplicidade. Nenhuma checagem é pulada por o solicitante ser o sistema.
- **Só no modo Aprovação:** com a política de agora dizendo outro modo para o funcionário, 409 `modo-nao-e-aprovacao`; com a flag `modo_aprovacao` desligada para a empresa, 403 `modo-aprovacao-desligado`. O pedido nasce `aguardando_aprovacao`: quem aprova é uma pessoa, com o código do app.
- **Quem responde:** `requested_by` é a pessoa que publicou a regra do modo (`policy.created_by` da versão ativa de onde o modo vem), conferida por `pessoaPode` (vínculo ativo, conta ativa e a permissão `campanhas.operar`). `actor_type = agent` e `agent_key` dizem qual funcionário pediu (migration 0048).
- **Auditoria:** `acao.pedir` com `actor_type: agent`, o nome do funcionário, a origem `worker` e a pessoa em `on_behalf_of`.
- **A tentativa:** uma por recomendação (`shadow_decision.request_attempted_at`); o que o trilho recusou fica em `request_error` e `request_error_detail` (o código e o texto do problema), e a Atenção mostra em `recommendation.not_requested`.

## A verba do mês (A4, X4 parte 1, 05/10/2026)

- **O teto do mês conta o gasto inteiro (D-A4-19):** no provedor que gasta dinheiro de verdade, o envelope (`budget_policy`) deixa de limitar a soma das reservas e passa a limitar a previsão de fechamento do mês: gasto lido das contas de anúncio conectadas (a Meta por anúncio, o Google por campanha; `metric_latest`) + ritmo dos 7 dias inteiros mais recentes × dias que a leitura não cobre + aumentos e retomadas pedidos ou feitos hoje × dias que faltam + o que o pedido acrescenta por dia × dias que faltam. A conta é pura (`actions/verba-do-mes.ts`); o `BudgetService` lê o banco e trava a linha do envelope, como antes.
- **Dois caminhos no `reserve`:** `sobeOGasto` (aumento ou retomada em conector com `requiresSpendLimits`) usa a conta do mês; os outros provedores (o sandbox) seguem pelo livro de reservas. O livro continua guardando o que cada pedido reservou por dia, liberou e executou.
- **O que pesa hoje:** os pedidos vivos (`aguardando_aprovacao`, `aprovada`, `executando`) e os executados hoje (no fuso da empresa) sem volta executada, pelo `reserved_micros`. O que foi executado antes já aparece, em parte, no ritmo.
- **Centavos inteiros:** o gasto e o ritmo de cada conta de anúncio vão ao centavo; a previsão é gasto + ritmo × dias, e as plataformas somam o total.
- **Leitura atrasada:** a conta lida pela última vez antes de hoje vale até a véspera dessa leitura, e os dias seguintes entram pelo ritmo. A conta nunca lida entra com zero, marcada (`stale`).
- **Os dois limites, juntos (D-A4-22):** `PUT /v1/budget/limits` (permissão `orcamento.gerenciar`) grava o teto do mês no envelope da empresa (`updated_by`, migration 0052) e publica o teto por campanha como regra `max_value` de `orcamento.*`, sem provedor, numa versão nova da política da empresa (as outras regras ficam; o mesmo valor não publica versão). `GET /v1/budget/month` devolve a conta, os limites, quem definiu e as regras da distribuição que a tela cita.
- **Nomes:** para a pessoa, "teto por ação" e "envelope do mês" são o **teto por campanha** e o **teto do mês**; os códigos dos problemas não mudam (`teto-nao-definido`, `envelope-nao-definido`, `orcamento-insuficiente`).

## O que a tela lê antes do pedido (A4, X8 parte 1, 07/10/2026)

- **Nada aqui é pedido:** `GET /v1/actions/targets` e `GET /v1/actions/options` só leem. A política, os limites da empresa, a reserva e a leitura que vale para o plano continuam em `POST /v1/actions`.
- **`targets`** (`campanhas.ver`): as campanhas ativas e em pausa das contas de anúncio da marca com a flag de escrita ligada, com os pedidos em aberto de cada uma (os da campanha, dos conjuntos e dos anúncios dela) e `write`: `ligada` ou `so_leitura`.
- **`options`** (`campanhas.operar`): o objeto escolhido lido na plataforma na hora, as ferramentas que cabem nele (`ferramentasPara`: nunca oferece o que a ferramenta recusaria ao planejar), os conjuntos e os anúncios pela leitura diária e os pedidos em aberto.
- **Fora da transação:** a rota é `@SemTransacao`. O conector de plataforma lê em duas partes: `prepareRead` (a conta, a autorização e o objeto conhecido, no banco) e `readPrepared` (a chamada à plataforma, com o tempo curto de quem tem uma pessoa esperando).
- **As mesmas barreiras do pedido, antes de gastar a leitura:** a trava (423), a flag de escrita (403) e a conexão que só pediu leitura (409 `conexao-so-leitura`, por `oauth_connection.requested_access`, migration 0054).

## O gasto conferido (A4, X4 parte 2, 05/10/2026)

- **`execução → informado → gasto real`:** a ponta que faltava do livro. `action_spend_check` (migration 0053) guarda, por mudança e por dia, como o Liame deixou o objeto, como a leitura do dia o mostra e quanto ele gastou. Só cresce (`select` e `insert` para a aplicação).
- **Quem confere:** `worker/conferencia-do-gasto.ts`, de 5 em 5 minutos, nas contas de anúncio lidas hoje (a leitura de hoje traz a véspera inteira e a situação de agora). Uma linha por mudança e por dia (`unique`), com `on conflict do nothing`: repetir não duplica, e várias instâncias do worker podem rodar juntas.
- **O que é conferido:** a mudança executada mais recente de cada objeto (as que escreveram de verdade: `sem_escrita` fica de fora), executada antes de hoje e há no máximo 35 dias.
- **A conta** (`actions/conferencia-do-gasto.ts`, pura): `mudou` quando a leitura mostra outra situação ou outra verba, ou o objeto não veio nela; senão, `acima` quando o gasto dos 7 dias inteiros até ontem passa da soma da verba de cada dia (a de antes da mudança, a de depois e, no dia dela, a maior das duas), ou quando o pausado gastou nos dias inteiros depois da pausa; senão, `confere`. Sem verba no objeto ativo, não se compara.
- **O aviso:** `gasto_acima_da_verba` na Atenção do ciclo fechado, enquanto a conferência mais recente (de hoje ou de ontem) disser `acima` e nenhum outro pedido tiver mudado o objeto depois.
- **A leitura:** `GET /v1/budget/month` traz `changes` (as mudanças do mês e, de antes, as que continuam valendo), com a conferência mais recente, desde quando ela dá aquele resultado (`since`) e o pedido que trocou a mudança (`superseded_by`); `overspend`, os avisos de gasto acima da verba já em palavras (o mesmo texto da Atenção, escrito num lugar só: `textoDoGastoAcima`); e `largest_daily_micros`, a maior verba diária entre as campanhas e os conjuntos ativos das contas em que o Liame muda verba (ajuda a escolher o teto por campanha).
- **Nada é escrito nem desfeito** na plataforma por causa da conferência: ela registra e avisa.
