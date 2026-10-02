# Liame — Plano da fase A3 · Camada de inteligência

> **Aprovado pelo dono em 02/10/2026** ("2 autorizado"), com as decisões D-A3-1 a D-A3-12 como recomendadas. Ficaram em aberto com ele: o valor do teto de custo do piloto (D-A3-3), a conta de API na Anthropic e a D-A3-13, que nasceu da reconferência da base. A A3 é quando "os funcionários pensam" (roadmap §2): a LIA explica os números, a revisão semanal chega pronta, o que fugiu do normal vem com o motivo, e cada funcionário aparece em "Sua equipe" com o que fez e o quanto já dá para confiar nele. **A IA não escreve em plataforma de anúncio nesta fase** (A4) e **não calcula número final**: ROAS, receita, margem e custo continuam vindo do código (`ai-architecture.md` §8). Tudo o que a IA recomendar sobre anúncio roda em **sombra** (registrado e comparado com o que a pessoa fez), para medir a prontidão antes da A4. A única escrita externa continua sendo o cupom no Regem, sempre com aprovação. O produto segue funcionando com a IA fora do ar (especificação §5, item 5).

## 1. De onde partimos (código e documentos lidos em 01/10/2026)

| Onde | Já existe | Falta |
| --- | --- | --- |
| **Dados** (A2 e A2.5 no ar) | Gasto, cliques e conversões por campanha e dia (Meta, Google Ads), com frescor; pedidos, itens, custo, cupons e atribuição determinística (ADR-020); Resultados com ROAS da plataforma × confirmado no caixa; Atenção de mídia e do ciclo fechado por regras calculadas na hora (G9, F9); avisos do Regem em cerca de 1 minuto (#82) | Série histórica pronta para comparar "normal × fora do normal" por campanha (hoje as regras olham janelas fixas); nenhum texto explicando os números |
| **Trilho de ação** (A1 + F6) | Action Service com política (`plataforma@2`), orçamento, aprovação amarrada ao hash do plano, execução e auditoria; tela Aprovações; uma ferramenta real (`regem_cupom_criar`); kill switch por nível; flags por empresa | `plan` (proposta com evidências e explicação), `job` (demanda da agência), `autonomy_rule`, `shadow_decision`, `readiness_snapshot`, `human_override` (`data-model.md` §6): só as tabelas de ação e aprovação existem |
| **Execução** (A1) | pg-boss + estado durável (`workflow_run`, `workflow_step`), passo que espera sem job preso (ADR-005); outbox, inbox, OpenTelemetry de ponta a ponta | Fila `ai` e `reports`; workflows com passo de IA; `workflow_event` |
| **IA** | Só a dependência `ai` (Vercel AI SDK 7) importada no spike A0-3; decisões tomadas: gateway próprio sobre o AI SDK, promptfoo como portão (ADR-006), modelos por finalidade em catálogo curado (ADR-016) | Módulo `ai` (gateway, adapters, roteamento), `ai_usage`, tabela de preços, `agent_definition`, `agent_activation`, `tool_registry`, `prompt_version`, `model_route`, `knowledge_item`, pasta `evals/` |
| **Telas** | Atenção, Aprovações, Resultados, Contas conectadas, Pessoas e acessos, Links e cupons, Segurança | **Resumo** (página inicial do Lite), **Conversa**, **Sua equipe**, **Minha marca**; os botões da LIA em Resultados e Atenção (ficaram de fora na A2.5 de propósito) |
| **Jurídico** | Política 7 diz que "nesta fase o Liame ainda não envia dados a modelos de IA" e promete avisar antes; fornecedores de IA constam como previstos | Texto da fase com IA ligada, fornecedor em uso, transferência internacional (seção 7) |

**Piloto (Mister Burgers):** uma loja, 6 campanhas ativas (5 Meta, 1 Google), vendas pelo Anota AI, 99Food, iFood e balcão. Pouca amostra: os limiares de prontidão (seção 4, D-A3-10) são ponto de partida, não regra.

## 2. O que muda para quem usa

1. **"Explicar" em cada número e em cada aviso:** a LIA diz o que aconteceu, por quê e o que fazer, citando só números que o código entregou.
2. **Revisão semanal pronta** na tela e por e-mail: o que vendeu, o que cada campanha trouxe no caixa, o que mudou, o que precisa de decisão.
3. **O que fugiu do normal chega com o motivo**, não como alarme solto.
4. **Conversa com a LIA** dentro do Liame: perguntar, pedir (vira demanda registrada) e receber a recomendação com o risco.
5. **Plano de 90 dias e pauta da semana** propostos pelo Estrategista, para aprovar, editar ou recusar.
6. **Sua equipe:** quem está fazendo o quê, quantas recomendações acertou, e o que falta para ganhar autonomia.
7. **Minha marca:** o que a empresa é, vende e não pode dizer, preenchido uma vez e usado por todos os funcionários.

## 3. Entregas no Liame

Cada entrega é um PR com CI verde. **Migrations em negrito**: testadas no local e no CI, aplicadas na nuvem **antes do merge** (pelo acesso atual, com o clique do dono). Letra **I** (inteligência). Antes do código: os protótipos da seção 5 e a reconferência da seção 8.

| # | Entrega | O que fica pronto | Critérios | Migrations |
| --- | --- | --- | --- | --- |
| **I1** | **AI Gateway e custo** | Módulo `ai` com a interface da DMS (`generate` e `structured` na I1; `stream` entra na I10 e `agent`, na I2, junto do primeiro uso real de cada um); adapter da Anthropic sobre o AI SDK 7 com provider explícito (nunca id de modelo em texto solto); **custo por chamada** (tabela de preços versionada × tokens, contando cache) em `ai_usage`; teto diário e mensal por empresa com **degradação** (modelo principal → econômico com eval → só o determinístico); limite por usuário (custo disparado de fora, `security-model.md`; o limite por conversa entra na I10); kill switch do provider `ai` e flag `ia` por empresa, nascendo desligada; **remoção de dado pessoal** antes de qualquer envio; trace `gen_ai.*`; guarda do conteúdo por 30 dias e, depois, só o registro técnico | A3-1, A3-2, A3-3, A3-9 | **0028** uso de IA, preços e rotas |
| **I2** | **Registros** | `agent_definition` e `agent_activation` (funcionário é definição versionada, não código novo); `tool_registry` com as ferramentas **de leitura** (resultados do ciclo fechado, métricas de mídia, avisos da Atenção, cupons, links, frescor), todas passando pelas mesmas permissões e pelo mesmo isolamento por empresa das rotas; `prompt_version` e `model_route` como dado com `status`, `eval_score` e `deployed_at`; nada muda em silêncio; `agent` do gateway (laço com ferramentas e gancho por rodada) | A3-1, A3-4, A3-7 | **0029** registros |
| **I3** | **Evals como portão** | Pasta `evals/` com casos versionados por tarefa: cenários de referência do piloto, **número inventado**, injeção de instrução, vazamento entre empresas, pedido político, escolha de ferramenta errada; promptfoo no CI **só quando muda prompt, ferramenta, modelo ou política** (custo controlado), com limiar por tarefa; regressão bloqueia o merge | A3-5, A3-7, A3-8, A3-15 | — |
| **I4** | **Explicar (Analista)** | Botão "Explicar" em Resultados e na Atenção: o código monta o contexto com os números já calculados e a fonte de cada um; a LIA devolve texto estruturado (o que aconteceu · motivos com números · risco · o que fazer); **verificador determinístico**: número que não está no contexto derruba a resposta e cai no texto sem IA; resposta guardada com as versões (prompt, modelo, dados) | A3-5, A3-6, A3-10 | — |
| **I5** | **Sombra de verdade** | Para as decisões que só serão executadas na A4 (pausar anúncio, mexer em verba, trocar criativo): a recomendação é gravada com confiança e retrato do estado (`shadow_decision`); a leitura diária observa o que a pessoa fez na plataforma; depois compara o resultado e calcula o **arrependimento** ("se tivesse sido autorizado, teria melhorado ou piorado?"); `human_override` com o motivo quando a pessoa discordar na tela. Entra cedo para juntar amostra | A3-11 | **0030** sombra e prontidão |
| **I6** | **Fora do normal, com o motivo** | Detecção **por código** (comparação com a própria série da campanha e da loja, por dia da semana) de gasto, custo por pedido, pedidos e receita fora da faixa; a IA só explica e sugere; entra na Atenção com evidência, valor envolvido e frescor; dado velho não gera aviso | A3-5, A3-10 | — |
| **I7** | **Relatórios** | Workflow da **revisão semanal** (passos determinísticos + um passo de IA) e do **relatório mensal**: na tela Resultados e por e-mail; versão sem IA sempre disponível; geração noturna em lote (mais barata); "Só relatórios por e-mail" passa a receber | A3-6, A3-12 | — |
| **I8** | **Minha marca** | Dossiê estruturado (`knowledge_item`): identidade, voz, produtos, ofertas, provas, **o que não pode dizer**, concorrentes, região, sazonalidade; preenchimento guiado, com a LIA sugerindo a partir do que já existe (cardápio, campanhas) e a pessoa confirmando; texto para o modelo gerado em ordem estável (cache de prompt); base da agência (regras de marketing adaptadas ao Brasil) versionada na distribuição, com o aviso de licença | A3-13 | **0031** conhecimento |
| **I9** | **Compliance** | Regras determinísticas no Policy Engine (categorias proibidas, político e eleitoral, promessa de resultado, dado pessoal em texto) + revisor de IA que só opina sobre tom, clareza e alegações; todo texto gerado (explicação, relatório, plano) passa por ele antes de aparecer; **o revisor nunca aprova sozinho** | A3-15 | — |
| **I10** | **Conversa (LIA)** | Tela Conversa: respostas em tempo real (`stream` do gateway, com limite por conversa), com ferramentas de leitura e a de **abrir demanda** (`job`); pode **propor** o cupom de campanha, que entra na fila de Aprovações como qualquer pedido; se apresenta como assistente de IA e oferece falar com uma pessoa; histórico por empresa; "reunião de decisão" como ritual nas decisões grandes (os funcionários envolvidos, com uma voz contrária, e a LIA leva a recomendação e o risco) | A3-4, A3-8, A3-9, A3-13 | **0032** conversa e demandas |
| **I11** | **Estrategista** | Plano de 90 dias, verba por canal, calendário comercial e pauta da semana como `plan` (proposta com evidências, versões e hash): aprovar, editar, recusar ou pedir nova análise; plano alterado derruba a aprovação antiga; nada é executado | A3-10, A3-13 | **0033** planos |
| **I12** | **Pesquisador** | Leitura de páginas que a empresa informa (site, cardápio, concorrentes) por um **leitor em quarentena**: modelo sem nenhuma ferramenta de escrita ou saída, que só devolve rótulos validados por schema; nunca o texto externo junto das instruções; resultado alimenta o dossiê como sugestão a confirmar | A3-8 | — |
| **I13** | **Sua equipe, prontidão e Resumo** | Tela Sua equipe (cada funcionário: o que faz, o que fez, limites, acerto, custo) com o **índice de prontidão** por conta e ferramenta (`readiness_snapshot`); a promoção de modo é **proposta pelo sistema e aprovada por uma pessoa**, com versão; Resumo como página inicial do Lite, com os botões da LIA; Pro escolhe o modelo por finalidade dentro do catálogo, com custo e nota (ADR-016) | A3-11, A3-13 | — |

**Andamento:** I1 entregue em 02/10/2026. I2 entregue em 02/10/2026: registros, ativação, laço `agent` e as seis leituras (frescor, avisos, resultados do ciclo fechado, entrega de mídia, cupons e links), cada uma com a visão formatada para o modelo; prompts e funcionários entram com o Analista (I4). I3 (02/10/2026): casos, avaliador determinístico, portão e CI em modo gravado para a tarefa `explicar_resultados`; o eval com modelo de verdade e a publicação da rota esperam a chave de API. I4 (02/10/2026): o núcleo sem tela (contexto com a comparação, formato da resposta, verificador de números, explicação sem IA e o serviço); a rota e a tela esperam o protótipo P4 aprovado. I5 (02/10/2026): sombra por regra, sem modelo (recomendação com confiança e retrato, ação da pessoa pela leitura diária, arrependimento e prontidão), atrás da flag `sombra`; a migration ficou **0030 `sombra`**; `human_override` nasce como tabela e ganha rota com a tela Sua equipe (I13); "trocar criativo" fica para quando houver resultado por criativo. I6 (02/10/2026): três avisos por código na Atenção, comparando ontem com o mesmo dia da semana da própria série (vendas da loja, gasto da campanha e custo por pedido), com evidência, valor envolvido e hora da leitura; a explicação pela IA entra com a rota do Explicar (I4). Detalhe em `andamento.md`.

Ordem: I1 → I2 → I3 → I4 (primeiro valor visível, menor risco) → I5 (junta amostra desde cedo) → I6 → I7 → I8 → I9 → I10 → I11 → I12 → I13. Tudo sai testado contra respostas gravadas do provedor antes de gastar com chamadas reais; os evals pagos rodam só quando o que eles protegem muda.

## 4. Decisões (aprovadas pelo dono em 02/10/2026; a D-A3-13 aguarda)

| # | Decisão | Recomendação | Por quê |
| --- | --- | --- | --- |
| D-A3-1 | **Fornecedor de IA na largada** | **Só a Anthropic** na A3, com fallback entre modelos dela que passarem no eval da tarefa; OpenAI e Google entram quando uma finalidade pedir (imagem, na A4). O modelo de cada finalidade é escolhido **pelo eval**, não por preferência; a lista e os preços são reconferidos na fonte antes de fixar (seção 8) | `ai-architecture.md` §2 já põe o adapter da Anthropic primeiro; um fornecedor só reduz contrato, custo de eval e superfície de dados |
| D-A3-2 | **Onde a LIA conversa** | **Só dentro do Liame** (tela Conversa). WhatsApp fica para quando o RegemCast tiver a API de serviço (C2, A5) | WhatsApp só sai pelo RegemCast (base §2.4); conversa pública é o maior risco de custo e de injeção |
| D-A3-3 | **Teto de custo de IA por empresa** | Teto diário e mensal definidos pela distribuição, com alarme em 70% e degradação antes de bloquear. **Valor inicial do piloto: você define**; sem medição ainda, sugiro começar baixo e recalibrar depois de duas semanas de uso real | Nenhum SDK informa custo em dinheiro; o custo por resposta só se conhece medindo (I1) |
| D-A3-4 | **O que vai ao modelo** | Números agregados, nomes de campanha, anúncio, produto e cupom, e o dossiê da marca. **Nunca** telefone, e-mail, endereço ou identificador de cliente; nome de pessoa da equipe vira papel ("o Dono", "um Gestor"). Nunca duas empresas no mesmo pedido ou lote. Conteúdo guardado por 30 dias | Política 7.1 e 7.3; `ai-architecture.md` §11 |
| D-A3-5 | **O que a IA pode fazer na A3** | Explicar, resumir, planejar e **propor**. Em anúncio, tudo em **sombra**. A única proposta que vira ação é o cupom no Regem, que já pede aprovação pela política (`cupom.criar`) | A escrita na Meta e no Google é a A4, com o trilho completo |
| D-A3-6 | **Transparência** | A LIA e os funcionários se apresentam como assistentes de IA, com nome configurável e caminho para uma pessoa; todo texto gerado leva a marca "feito com IA" na tela | Especificação §4 e §5 (itens 3 e 10); Termos 6.3 |
| D-A3-7 | **Revisão semanal** | Segunda-feira de manhã, no fuso da loja, na tela e por e-mail para Dono, Administrador e "Só relatórios por e-mail" | A semana do restaurante fecha no domingo |
| D-A3-8 | **Fontes do Pesquisador** | Só as páginas que a empresa informar e os dados que o Liame já tem. **Sem busca aberta na internet** e sem comentários de rede social (dependem de conectores da A6) | Conteúdo externo é o caminho da injeção; começar pequeno |
| D-A3-9 | **Limiar dos evals** | Cerca de 95% por tarefa no começo (ADR-006), calibrado no piloto; tarefa com número (explicação, relatório) exige **100% no eval de número inventado** | Número errado dito com confiança é o pior erro deste produto |
| D-A3-10 | **Portões da prontidão** | Os de `ai-architecture.md` §4.2 como ponto de partida (30 decisões comparáveis, concordância ≥ 80%, zero violação de política, dado fresco em ≥ 95%); o piloto tem uma loja, então o prazo é o que a amostra pedir | Promover sem amostra é palpite |
| D-A3-11 | **Observabilidade de IA** | Usar o nosso OpenTelemetry e o `ai_usage`; **não contratar o Langfuse agora** (segue como "previsto" nos documentos) | Um fornecedor a menos enquanto o volume é de piloto |
| D-A3-12 | **Escolha de modelo pelo cliente** | Lite fica em "Automático"; a escolha por finalidade no Pro entra na I13, só com modelos do catálogo que passaram no eval. Sem chave própria do cliente | ADR-016 |
| D-A3-13 | **Onde o modelo roda** (nova, 02/10/2026; **aguarda o dono**) | Fixar `inference_geo: "us"` em toda chamada, pagando 10% a mais | A Anthropic não tem região no Brasil; o padrão (`global`) pode rodar em qualquer região disponível, e os nossos documentos dizem "Estados Unidos". Fixar torna a frase verdadeira e verificável. O Haiku 4.5 não aceita o parâmetro: fica fora das rotas |

## 5. Protótipos para aprovação (antes do código de tela)

Sem protótipo aprovado não se inventa tela (`CLAUDE.md` §2). As vistas do protótipo geral (A0-4) têm números inventados e não mostram os estados reais; cada uma vira protótipo próprio, como na A2.5.

| # | Protótipo | Estados que precisa mostrar |
| --- | --- | --- |
| P4 | **Explicar** (bloco em Resultados e Atenção) e **Revisão semanal** | Carregando; resposta com motivos e fonte de cada número; dado velho ("não explico com dado de ontem"); IA fora do ar (texto sem IA); teto de custo atingido; discordar e dizer o motivo |
| P5 | **Conversa** (Lite e Pro) | Primeira conversa; resposta em tempo real; pedido que virou demanda; proposta que foi para Aprovações; "falar com uma pessoa"; limite atingido; IA desligada para a empresa |
| P6 | **Minha marca** | Vazio; preenchimento guiado; sugestão da LIA a confirmar; "o que não pode dizer"; versão anterior |
| P7 | **Sua equipe** | Funcionário ativo, em sombra e desligado; prontidão com o que falta; proposta de promoção para aprovar; custo do mês; histórico |
| P8 | **Resumo** (página inicial do Lite) e **Plano do Estrategista** | Sem dados ainda; semana normal; algo precisa de você; plano para aprovar, editar ou recusar |

> **P4 entregue para aprovação em 02/10/2026:** `mockups/prototipo-explicar.html`, com os seletores "Tela" (Resultados, Atenção, Revisão semanal) e "Explicação" (os estados) na faixa do topo. **Aguarda o dono.** A rota e a tela do Explicar (I4) e a revisão semanal (I7) só começam depois da aprovação. As escolhas propostas estão no changelog de `decisoes-design.md`.

## 6. Critérios de saída da A3

| # | Critério | Como é verificado |
| --- | --- | --- |
| A3-1 | Nenhum módulo chama SDK de fornecedor fora do gateway; nenhum id de modelo em texto solto | Teste de importação e de registro no CI |
| A3-2 | Toda chamada gera `ai_usage` com custo; o total do mês confere com a fatura do fornecedor | Teste + reconciliação mensal registrada |
| A3-3 | Nenhum telefone, e-mail ou identificador de cliente em prompt, resposta guardada, log ou span | Teste que procura no banco e nos spans (como a A2.5-7) |
| A3-4 | Isolamento: uma chamada nunca mistura duas empresas; ferramenta de leitura devolve só o que a permissão da pessoa permite | Testes + eval de vazamento |
| A3-5 | **Número:** todo número citado está no contexto entregue pelo código; resposta com número fora dele não aparece | Verificador em teste + eval com 100% |
| A3-6 | **Funciona sem IA:** com o fornecedor fora do ar ou a flag desligada, telas, avisos e relatório determinístico seguem | Teste com o gateway derrubado |
| A3-7 | Mudança de prompt, ferramenta, modelo ou política roda o eval da tarefa; regressão bloqueia | CI |
| A3-8 | Conteúdo externo só entra pelo leitor em quarentena; ataques de injeção não mudam ação nem vazam dado | Evals de ataque |
| A3-9 | Teto por empresa, por usuário e por conversa respeitado; degradação antes do bloqueio; alarme | Testes |
| A3-10 | Toda recomendação com motivos numéricos, risco e impacto estimado; nunca "a IA decidiu" | Schema + eval |
| A3-11 | **Sombra no piloto:** pelo menos 30 recomendações comparáveis registradas, com o arrependimento calculado e a prontidão visível; promoção só com aprovação humana | Registro do piloto |
| A3-12 | **Piloto:** revisão semanal real entregue por duas semanas seguidas; o dono avalia se foi útil; custo de IA por empresa e por receita gerida medidos | Registro com prints, como a A2-2 |
| A3-13 | Telas P4 a P8 conforme protótipo aprovado, em 1440/1024/768/375, claro e escuro | Verificação no navegador |
| A3-14 | Documentos jurídicos atualizados nos mesmos PRs (seção 7) | Lista de mudanças do README jurídico |
| A3-15 | Pedido político ou eleitoral recusado por regra e pela IA | Teste de política + eval |

## 7. Documentos jurídicos que mudam (`CLAUDE.md` §6)

| Documento | Mudança | Entra com |
| --- | --- | --- |
| Política 7 | Sai "ainda não envia dados a modelos de IA"; entra o que é enviado (números agregados, nomes de campanha e produto, dossiê da marca), o que nunca é (dado pessoal de cliente), a guarda de 30 dias e o aviso prévio prometido | I1 (ao ligar para o primeiro cliente) |
| Política 8 · Contrato Anexo III | Anthropic passa de "previsto" a "em uso", com o país; OpenAI, Google e Langfuse seguem previstos | I1 |
| Política (transferência internacional) | Estados Unidos entra em "hoje", com a base legal | I1 |
| Termos 2.6 | Os funcionários de IA disponíveis e o que cada um faz nesta fase (explicar, resumir, planejar, propor; sem executar em plataforma de anúncio) | I4, I10 |
| Termos 6.1 e 6.2 | Reforço: número vem do sistema, a IA interpreta; recomendação não é garantia | I4 |
| Contrato 5.3 | Remoção de dados pessoais antes do envio passa de compromisso a fato, com o teste citado | I1 |
| README jurídico | Linhas na lista de mudanças e na checagem de verdade (remoção de dado pessoal com teste; fornecedor sem treino conferido no contrato) | cada PR |

Fornecedor novo de verdade: **Anthropic** (suboperador, Estados Unidos). Reimportar as páginas no site a cada mudança e avisar antes de ligar, como a Política 7 promete.

## 8. Base de conhecimento: reconferir e pesquisar antes do código (`CLAUDE.md` §1)

- **Reconferir na fonte oficial:** §10 (lista de modelos e preços: a tabela é de 24/06/2026 e já há modelo mais novo; ids exatos, limites e o que cada um aceita); §14.1 (versão atual do AI SDK, do promptfoo e do SDK da Anthropic; cache de prompt e lote); o estado do padrão `gen_ai.*` do OpenTelemetry.
- **Pesquisar e registrar com [O]:** termos de dados da Anthropic para API (sem treino, prazo de guarda, opção de guarda zero, região de processamento); preço e limites de uso por nível de conta; LGPD art. 20 e orientação da ANPD sobre decisão automatizada e IA; Res. TSE 23.755/2026 (texto do art. 28 §1º-C) para a regra do Compliance; OWASP LLM e Agentic Top 10 na versão vigente.
- **Atualizar a §16.1** (como produtos de marketing mostram agentes) antes dos protótipos P5 e P7.

## 9. O que depende de você

| Para | Preciso de |
| --- | --- |
| Começar | Aceite deste plano e das decisões da seção 4 |
| I1 | Conta de API na Anthropic no nome da empresa, com limite de gasto no painel deles; a chave vai direto para o EasyPanel (`liame-api` e `liame-worker`), nunca para a conversa |
| I1 | O valor do teto de custo de IA do piloto (D-A3-3) |
| Telas | Aprovar P4 a P8 |
| I8 | Preencher o dossiê da Mister Burgers (uns 20 minutos, com a LIA sugerindo) |
| Jurídico | Ler as mudanças da seção 7 antes de ligar a IA para o piloto; reimportar as páginas no site |
| Nuvem | Clicar na aprovação das migrations 0028 a 0033, uma por vez, antes de cada merge |
| Ligar | Decidir quando ligar a flag `ia` para a Mister Burgers (comando `ligar-flag`) |

## 10. Riscos

| Risco | Mitigação |
| --- | --- |
| Número errado dito com confiança | A IA não calcula; verificador determinístico (A3-5); eval com 100%; texto sem IA quando falhar |
| Custo fora de controle | Teto por empresa, usuário e conversa; degradação; lote noturno; cache de prompt; evals só quando o protegido muda |
| Instrução escondida em conteúdo externo | Leitor em quarentena; ferramentas de leitura só; nenhuma ferramenta de saída na conversa além de abrir demanda e propor cupom, as duas com registro |
| Pouca amostra no piloto para a prontidão | Sombra desde a I5; prazo ditado pela amostra; promoção sempre humana |
| Dependência de um fornecedor | Interface própria (ADR-006); fallback só entre modelos avaliados; funciona sem IA |
| Modelo trocado ou aposentado pelo fornecedor | Rota como dado versionado; eval decide a troca; cadastrar no Vigia de integrações a página de avisos de modelos do fornecedor (I1) |
| Major novo do AI SDK | Isolado no adapter |
| Evals instáveis ou caros | Asserts determinísticos primeiro; juiz por IA só onde precisa, com modelo econômico; cache de respostas |
| Texto gerado que a lei ou a plataforma proíbe | Regras no Policy Engine antes do revisor de IA; político e eleitoral bloqueado por padrão |

## 11. Fora da A3

Escrita na Meta e no Google, Gestor de tráfego executando e ledger de orçamento completo (A4); imagem e o funcionário Criativo (A4); WhatsApp, réguas e a LIA fora do Liame (A5); redes sociais e comentários (A6); chave própria do cliente; vídeo e voz; autoaprendizado sem revisão; hub MCP (trilha B); `LIMITED_AUTO` e `AUTO` em qualquer ferramenta.
