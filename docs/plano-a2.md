# Liame — Plano da fase A2 · Dados de mídia

> **Proposta de 26/09/2026**, feita por ordem do dono ("concluir toda a fase e a seguinte até a conclusão"). A A2 lê Meta, Google Ads e GA4 **corretamente**: números que batem com a plataforma, passado reescrito registrado, frescor de cada fonte, cotas respeitadas e aviso antes de uma versão de API expirar. **Sem IA e sem escrita** (a leitura é a base do ciclo fechado da A2.5; a IA entra na A3; a escrita na A4). As recomendações da seção 3 são aplicadas desde já; qualquer uma pode ser revista.

## 1. O que dá para fazer já e o que depende de você

Tudo o que é código, banco e teste sai **antes** das contas das plataformas: cada connector é construído e testado contra respostas gravadas no formato da documentação oficial (fixtures versionadas, `integrations.md` §1.5). A leitura **real** só fecha com:

| Para | Preciso de | Critério da A0 |
| --- | --- | --- |
| Conectar Meta | App **Business** da Meta no nome da SISTER, com Facebook Login for Business (`config_id`) e os responsáveis do restaurante como **testadores do app** (Standard Access basta para testadores) | A0-5 |
| Conectar Google Ads e GA4 | Projeto no Google Cloud com a tela de consentimento OAuth (modo de teste, com os testadores), Ads API habilitada no projeto (nível Explorer basta para ler) e `analytics.readonly` | A0-5 |
| Números reais | Restaurante de testes com as contas de anúncio e a propriedade GA4 | A0-7 |
| Aplicar na nuvem | Projeto Supabase em São Paulo (migrations da A1 e da A2) | A0-8 |

Os segredos dos apps (IDs e chaves de cliente) são **da distribuição**: vão para as variáveis do EasyPanel, nunca para o chat nem para o git.

## 2. Entregas

Cada entrega é um PR com CI verde. **Migrations em negrito.**

| # | Entrega | O que fica pronto | Migrations |
| --- | --- | --- | --- |
| **G1** | **Modelo de mídia** | `connected_account` (conta da plataforma ligada à marca, com a credencial no cofre), entidades canônicas `campaign`, `ad_group`, `ad`, `creative` (colunas canônicas + `provider_attributes` + `raw_ref`), `metric_observation` (cada leitura é uma linha: "quanto a plataforma dizia naquela data"), `metric_latest` (tabela mantida na escrita, com RLS), `metric_mapping`, `raw_payload` (retenção curta), `sync_state` e `sync_run`; tudo com RLS e classificação de dado (A1-1, A1-3) | **0017** mídia |
| **G2** | **Framework de connector (leitura)** | Interface (`arquitetura.md` §6), Capability Registry versionado com `verified_at`, cliente HTTP com cabeçalhos de cota lidos (Meta `X-Business-Use-Case-Usage` / `X-Ad-Account-Usage` / `X-FB-Ads-Insights-Throttle`), backoff, circuit breaker, balde de cota por app × conta e escalonamento justo entre empresas; `Deprecation`/`Sunset` guardados; contract tests com fixtures | **0018** capacidades e cotas |
| **G3** | **Conectar contas** | OAuth com `state` e PKCE; Meta (Facebook Login for Business → token de usuário do sistema), Google (código + refresh token, escopos `adwords` e `analytics.readonly`); descoberta das contas (contas de anúncio, clientes do Google Ads, propriedades GA4) e escolha de quais ligar a cada marca; token só no cofre; desconectar revoga; token vencido vira aviso | **0019** conexões |
| **G4** | **Connector Meta (leitura)** | Contas, campanhas, conjuntos, anúncios e criativos; insights diários por anúncio com a janela de atribuição declarada; relatório assíncrono para períodos longos; versão **v26.0** | — |
| **G5** | **Connector Google Ads (leitura)** | GAQL por REST (`searchStream`): clientes, campanhas, grupos, anúncios; métricas por `segments.date` em micros; versão **v25** | — |
| **G6** | **Connector GA4 (leitura)** | Data API `runReport` por data × origem/mídia/campanha, com a cota da propriedade lida em cada resposta (`returnPropertyQuota`) | — |
| **G7** | **Sincronização** | Jobs no pg-boss por conta: carga inicial, incremental diário com **janela de revisão** (o passado que a plataforma ainda reescreve), gravação idempotente (observação nova só quando o número muda), frescor por fonte (`fresh / delayed / stale / unknown`) | — |
| **G8** | **Vigia de integrações** (ADR-015) | Fontes oficiais cadastradas; rotina diária que baixa e compara por trecho (hash); calendário de versões com alertas 60/30/7 dias e tarefas na data, D+1 e D+7; `Deprecation`/`Sunset` das respostas viram alerta; cruzamento com o Capability Registry. **Sem IA na A2:** o registro traz o trecho que mudou; o resumo por agente entra na A3 | **0020** vigia |
| **G9** | **Telas** | **Contas conectadas** e **Atenção de mídia** (alertas por regra: conta desconectada, dado atrasado, gasto fora do normal, campanha que parou de entregar, versão de API perto de expirar). **As duas precisam de mockup aprovado** (no protótipo, Contas conectadas está "em desenho") | — |

Ordem: G1 → G2 → (G3, G4, G5, G6) → G7 → G8 → G9. G8 pode correr em paralelo a partir da G2.

## 3. Decisões (recomendação aplicada)

| # | Decisão | Recomendação | Por quê |
| --- | --- | --- | --- |
| D-A2-1 | **Versões** | Meta **v26.0**; Google Ads **v25**; GA4 Data API **v1beta**. A versão fica no Capability Registry, nunca espalhada no código | Reconferidas em 26/09/2026 (base §2.1 e §3.1); a v24 da Meta expira em 06/10/2026 |
| D-A2-2 | **SDKs** | **REST direto** com o nosso cliente HTTP (fetch nativo), sem os SDKs das plataformas | Menos dependências (cadeia de suprimentos), controle total de cota, erro e versão |
| D-A2-3 | **Carga inicial** | **90 dias** por conta (configurável) | Base suficiente para comparação semanal e sazonalidade curta sem estourar cota no primeiro dia |
| D-A2-4 | **Janela de revisão** | Meta: **7 dias** por dia e **28** por semana; Google Ads: **14** por dia e **90** por semana; GA4: **3** por dia | As plataformas reescrevem conversões depois do dia (base §2.1, §3.1; [S], medir no piloto e ajustar) |
| D-A2-5 | **`metric_latest`** | Tabela mantida na escrita, **não** visão materializada | Visão materializada não tem RLS: seria uma porta entre empresas |
| D-A2-6 | **Partição de `metric_observation`** | **Adiar** (índice por data + BRIN) até o volume pedir | O piloto é pequeno; partição exige RLS em cada partição e rotina de criação. Registrado como dívida com gatilho (tabela > 50 milhões de linhas) |
| D-A2-7 | **Observação** | Grava linha nova só quando o número muda; toda leitura atualiza `observed_at` do `sync_run` | Mantém a pergunta "quanto a plataforma dizia em tal data" sem multiplicar linhas iguais |

## 4. Critérios de saída da A2

| # | Critério | Como é verificado |
| --- | --- | --- |
| A2-1 | Conectar Meta, Google Ads e GA4 por OAuth; o token só existe cifrado no cofre, nunca em log, API, tela ou auditoria | Teste + inspeção dos spans (A1-14) |
| A2-2 | Para 7 dias fechados de uma conta de teste, gasto, impressões e cliques **iguais** à interface da plataforma; conversões iguais na janela declarada | Conferência manual registrada (print) + teste de fixture |
| A2-3 | Passado reescrito fica registrado: a mesma data com duas observações quando a plataforma muda o número | Teste de integração |
| A2-4 | Cotas respeitadas: cabeçalhos lidos, backoff, circuit breaker; uma empresa não consome a cota das outras | Testes + 7 dias sem erro 17/613/80000–80014 no piloto |
| A2-5 | Frescor em toda métrica entregue; conta desconectada ou token vencido vira alerta | Testes |
| A2-6 | Capability Registry com versão e `verified_at`; Vigia rodando todo dia, com alerta antes da expiração de versão | Teste + registro das execuções |
| A2-7 | Contract tests com fixtures versionadas dos três connectors no CI | CI |
| A2-8 | A1-1 a A1-3 cobrindo as tabelas novas (RLS, catálogo, cruzamento entre empresas) | CI |
| A2-9 | Telas de Contas conectadas e Atenção de mídia, conforme mockup aprovado | Verificação no navegador |

## 5. Fora da A2

Ciclo fechado com Regem e RegemCast (A2.5), IA e funcionários (A3), qualquer escrita nas plataformas (A4), TikTok, redes sociais e demais canais (A6).
