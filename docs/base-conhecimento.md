# Liame — Base de conhecimento do nicho

> **Consulta obrigatória** antes de produzir especificação, copy, política, connector ou código que dependa de plataforma, regra de mercado, lei ou padrão técnico. Regra completa em `CLAUDE.md`.
>
> **Legenda de confiança:** **[O]** documentação oficial · **[S]** fonte secundária (imprensa, blog, agregador) · **[NC]** não confirmado.
> **Validade:** cada seção tem data de verificação. Fato com mais de **90 dias**, ou marcado [S]/[NC], precisa ser **reconferido na fonte** antes de virar código (LIC-021: a fonte que nega precisa ser tão nova quanto a pergunta).
> **Como atualizar:** toda pesquisa nova entra aqui, com data, fonte e confiança. Registre também no §12 (histórico). Nunca apague um fato antigo sem registrar o que o substituiu.

## Índice

1. [Mercado e concorrentes](#1-mercado-e-concorrentes)
2. [Meta (Facebook, Instagram, WhatsApp, Threads)](#2-meta)
3. [Google (Ads, Data Manager, GA4, GBP, YouTube, Merchant)](#3-google)
4. [TikTok, LinkedIn e outras plataformas](#4-tiktok-linkedin-e-outras)
5. [E-mail e SMS](#5-e-mail-e-sms)
6. [Regulatório no Brasil](#6-regulatório-no-brasil)
7. [Regras de decisão de marketing (priors)](#7-regras-de-decisão-de-marketing-priors)
8. [Padrões técnicos: MCP, APIs, segurança de agentes](#8-padrões-técnicos)
9. [Stack verificada](#9-stack-verificada)
10. [Modelos de IA (referência, sem preferência de fornecedor)](#10-modelos-de-ia)
11. [Ecossistema DMS: o que existe e o que falta](#11-ecossistema-dms)
12. [Histórico de atualizações e fontes](#12-histórico-e-fontes)
13. [Identidade (IdP), chave mestra e âncora de auditoria](#13-identidade-chave-mestra-e-âncora)
14. [SDKs de IA, feature flags, observabilidade e supply chain](#14-sdks-de-ia-flags-observabilidade-e-supply-chain)
15. [Validação da stack (detalhes)](#15-validação-da-stack-detalhes)
16. [Interface: padrões de mercado e plataforma web](#16-interface-padrões-de-mercado-e-plataforma-web)
17. [Acesso, ciclo de vida, versões de API e modelos de mídia](#17-acesso-ciclo-de-vida-versões-de-api-e-modelos-de-mídia)

---

## 1. Mercado e concorrentes

*Verificado em 24/09/2026.*

### 1.1 O que mudou em 2025–2026

- **Conectar IA à conta de anúncios virou recurso gratuito das próprias plataformas.** Meta, TikTok e Amazon têm MCP oficial com escrita; Google e GA4 só leitura [O/S]. A otimização *dentro* de cada plataforma já é feita pela IA delas (Advantage+, PMax/AI Max, Smart+).
- **Agentes nativos:** Google Ads Advisor e Ask Advisor só em inglês, com aprovação humana [S]; Meta comprou a Manus (~US$2 bi), que está no Ads Manager desde fev/2026 [S]; TikTok Symphony Agent (22/06/2026) [S]; Amazon Ads Agent (jun/2026) [S].
- **Meta Business Agent** global desde 03/06/2026: atende e vende no WhatsApp, Instagram e Messenger [S].
- **ChatGPT Ads:** Ads Manager self-serve nos EUA desde 05/05/2026; testes no Brasil desde ago/2026; HubSpot e Shopify integrados em 16/09/2026 [S]. API para terceiros [NC].
- **Ad Context Protocol (AdCP):** padrão aberto para agentes de mídia sobre MCP (15/10/2025; Yahoo, PubMatic, Scope3) [S].
- **Food service no Brasil:**
  - o iFood comprou a Advolve (12/11/2025) e lançou o **Toqan** (17/09/2026), IA grátis para cerca de 500 mil parceiros [S];
  - a **Brendi** vende tráfego automatizado para restaurante: R$60/semana + mídia, 3 anúncios por semana, raio de 2–3 km, só Meta [S];
  - a **Anota AI** não faz tráfego pago.
- **Sinal sobre criativo 100% IA:** a Icon pivotou de "AI Admaker" para UGC humano [S]. Qualidade e risco jurídico ainda limitam.

### 1.2 Referências (o que copiar e onde falham)

| Quem | Preço | Copiar | Falha |
| --- | --- | --- | --- |
| mLabs (BR) | R$29,90/marca | aprovação pelo WhatsApp, portal com a marca do cliente, preço por marca | não gerencia mídia; multa de 50%; Reclame Aqui 7,3 |
| Reportei (BR) | R$74,90+ | integrações BR (Kwai, iFood, Hotmart, Kiwify, Nuvemshop), MCP, envio pelo WhatsApp | só relatório |
| RD Station (BR) | R$50–1.699 + implantação | CRM + WhatsApp oficial; Criador de Agentes a partir de out/2026 | não gerencia mídia; fidelidade de 12 meses |
| Tintim (BR) | R$197–297 | venda fechada no WhatsApp ligada ao anúncio e enviada à Meta e ao Google | lê as conversas (privacidade) |
| Metrifiquei (BR) | R$97–297 | relatório + alerta de saldo + IA entregues no WhatsApp | só relatório |
| Metricool | €10–43/marca | cria, pausa e muda verba em Meta e Google junto com as redes | sem WhatsApp |
| Bïrch (ex-Revealbot) | US$49–99 | regra em linguagem natural vira rascunho auditável; roda a cada 15 min; log | curva de aprendizado |
| Madgicx | US$49–499+ | auditoria 24/7 proativa; rotação de criativo | Trustpilot 2,2 (cobrança) |
| AdAmigo | US$99–349/conta | "revisar antes" × "aplicar sozinho", com log; white-label | preço por conta |
| Triple Whale | US$219–1.349+ | fila de aprovação dos agentes | caro; contrato anual |
| HubSpot | US$7–3.600+ | agentes por função + orquestrador; ChatGPT Ads | salto de preço |
| Windsor.ai | US$19–499 | MCP com escrita multiplataforma | insumo, não produto |
| Pipeboard | R$99–649 | preço em real; tudo nasce pausado | **licença BSL: não embutir** |

### 1.3 Lacunas e posicionamento

- A PME hoje soma mLabs + Tintim + Metrifiquei + Kommo + gestor humano. Não existe produto BR que junte tudo com agente que executa.
- A janela do português é provavelmente curta: os agentes do Google e o MCP da Meta ainda estão em inglês ou em beta restrito.
- Ferramentas globais de social não têm WhatsApp.
- **Ciclo fechado fora do marketplace** (anúncio → WhatsApp/cardápio → pedido → PDV) só é possível para quem tem o sistema de venda.
- Consentimento por categoria como recurso: ninguém trata.
- **Reclamações dominantes do setor são de cobrança:** fidelidade, multa, implantação, % do gasto, cobrança após o trial, créditos que encolhem.
- Dados de pesquisa [S]: 51% dos brasileiros só aceitam promoção de empresa que procuraram (Opinion Box, 06/2025); nota média dos bots de 5,6/10 (Mobile Time, 06/2026); 53% das empresas usam só IA básica (RD, 08/2026).

### 1.4 Riscos observados

- O Google pode gastar **2× o orçamento diário** num dia (limite de 30,4× no mês) [O].
- A Meta permite até **5% da verba** em posicionamentos excluídos [S].
- Teste de incrementalidade achou só **17%** das conversões que o Advantage+ se atribuía como reais [S].
- Onda de suspensões automáticas na Meta em 2025–26 [S].
- Restrições por automação agressiva (dezenas de mudanças de orçamento por hora) [S].
- Controles retirados pelas plataformas em poucos meses.

---

## 2. Meta

*Verificado em 24/09/2026.*

### 2.1 Marketing API

- **Versões** *(reconferido em 26/09/2026 na página oficial de changelog)*: **v26.0 é a mais nova** da Graph API e da Marketing API (29/07/2026, sem data de fim) [O]; v25.0 (18/02/2026) segue valendo [O]; a **v24 da Marketing API expira em 06/10/2026** [O] (a da Graph API vai até 18/02/2028). A divergência de 24/09 (tabela da Marketing API parada na v25) acabou: a tabela já lista a v26. A Marketing API tem vida curta (a v23 expirou em 09/06/2026). Upgrade automático de versão desde 29/07/2026 [S].
- **Advantage+ unificado** (desde 29/05/2025): o status deriva de 3 alavancas (orçamento, público, posicionamento). ASC/AAC legados bloqueados em todas as versões desde 19/05/2026 [S].
- **v26** [S]:
  - saem `daily_outcomes_curve` e `estimate_dau`;
  - sai o posicionamento Explore Feed;
  - anúncio de enquete bloqueado;
  - 47 endpoints de Commerce bloqueados;
  - Special Ad Categories exigem `advantage_audience` explícito.
- **Segmentação:** exclusões por segmentação detalhada removidas (31/03/2025); conjuntos com interesses removidos pararam em 15/01/2026 [S].
- **Acesso** [O]:
  - App do tipo Business + Business Verification + App Review com **Advanced Access** (`ads_management`, `ads_read`, `business_management`) para contas de terceiros;
  - o **Marketing API Access Tier** é separado: Limited (padrão) e **Full**, que exige 500 chamadas em 15 dias com erro < 15% nas últimas 500 e não exige mais vídeo (desde 04/05/2026);
  - Standard Access funciona para quem tem papel no app (**testadores**).
  - **Reconferido em 02/10/2026** (pergunta do dono: "desde abril não precisa mais de aprovação?") [O]: continua precisando. A página de níveis de acesso diz que a permissão com acesso padrão "só pode ser solicitada de usuários que têm uma função no app" e que o acesso avançado exige verificação da empresa e análise do app, permissão por permissão (developers.facebook.com/docs/graph-api/overview/access-levels); a de autorização da Marketing API diz que o app que gerencia a conta de anúncios **de outras pessoas** precisa de acesso avançado a `ads_read` e/ou `ads_management` (…/docs/marketing-api/get-started/authorization). O que mudou em **29/04/2026** foi outra coisa: os conectores de IA da Meta (o MCP abaixo), em que o próprio anunciante liga a conta dele a uma ferramenta de IA (Claude, ChatGPT) "sem credenciais de desenvolvedor" (facebook.com/business/news/meta-ads-ai-connectors). Serve a quem usa a ferramenta com a própria conta, não a um produto que lê contas de clientes pelo próprio app.
- **Perguntas de tratamento de dados** (*Data Handling Questions*, pedidas no App Review de quem acessa dado de usuário) *(conferido em 30/09/2026 em developers.facebook.com/docs/resp-plat-initiatives/data-handling-questions/questions-preview)* [O]:
  - sobre **pedidos de autoridades públicas** por dado pessoal dos usuários, a Meta pergunta quais processos o app tem, com quatro opções: **revisão obrigatória da legalidade** do pedido; **contestar** o pedido considerado ilegal; **minimização** (entregar só o mínimo necessário); **documentação** dos pedidos, com a resposta, o fundamento legal e quem participou;
  - "autoridade pública" inclui qualquer órgão de governo ou administração pública (nacional, regional ou local) e quem exerce função ou serviço público (definição na página equivalente do Horizon OS, developers.meta.com/horizon/resources/data-handling-questions, atualizada em 02/07/2026) [O];
  - o Liame declarou as quatro; a Política de Privacidade 8 descreve o processo (30/09/2026).
- **Autenticação para SaaS:** Facebook Login for Business com `config_id` → **Business Integration System User Access Token** por cliente (não expira por padrão) [O].
  - *(verificado em 26/09/2026 em developers.facebook.com/docs/facebook-login/facebook-login-for-business e /guides/advanced/manual-flow)* [O]: diálogo `https://www.facebook.com/{versão}/dialog/oauth` com `client_id`, `redirect_uri`, `state`, `config_id`, `response_type=code` e `override_default_response_type=true`; troca em `GET https://graph.facebook.com/{versão}/oauth/access_token` com `client_id`, `redirect_uri` (igual ao do diálogo), `client_secret` e `code`; opcional `set_token_expires_in_60_days`. **PKCE não é mencionado** nesse fluxo. **Revogação por API não é documentada** para o token de usuário do sistema: a empresa remove o app em Configurações do negócio → Integrações → Apps conectados.
- **Configuração do Facebook Login for Business no painel** *(feita e observada em 28/09/2026 no app do Liame)* [O]: passos Nome → Variação de login (**Geral** ou cadastro incorporado do WhatsApp; **não muda depois**) → Token de acesso (usuário ou **usuário do sistema**; expiração **60 dias** — recomendada pela Meta — ou **Nunca**; não muda depois) → Ativos (Páginas, Contas de anúncios, Catálogos, Pixels, Instagram; cada um com "Ativo necessário" e **permissões de tarefa**: MANAGE, ADVERTISE, ANALYZE, DRAFT — **sem escolha, a Meta atribui MANAGE**) → Permissões (lista pesquisável; dependências entram sozinhas) → Criar, que devolve o **ID da configuração** (`config_id`). A página de configurações do produto avisa que o Facebook Login for Business **exige acesso avançado a `public_profile`** para uso fora de quem tem papel no app.
- **Acrescentar uma permissão ao login (para a escrita, A4)** *(reconferido em 04/10/2026 em developers.facebook.com/docs/facebook-login/facebook-login-for-business)*: a página oficial descreve só **criar** uma configuração: produto Facebook Login for Business → no menu da esquerda, **Configurations** → **+ Create configuration** (ou **Create from template**) → nome, tipo de token, ativos e permissões → **Create**, que devolve o Configuration ID; e diz que dá para ter várias configurações [O]. **Não diz se uma configuração que já existe pode ser editada**, nem o que acontece com os tokens já emitidos quando as permissões mudam [NC]. O caminho documentado para incluir `ads_management` é, então, criar outra configuração (as mesmas escolhas da atual, mais a permissão), pôr o ID dela em `META_LOGIN_CONFIG_ID_ESCRITA` (a de leitura segue em `META_LOGIN_CONFIG_ID`) e conectar a Meta de novo no Liame. Se o painel oferecer editar a configuração atual, confirmar pelo print do dono antes de orientar. **Observado no print do dono em 04/10/2026:** em Login do Facebook para Empresas → Configurações, a lista mostra a configuração `Liame - leitura de anúncios` com os botões **Copiar** e **Editar**, e no topo **Criar configuração** e **Criar do modelo** [O, pelo print]; o que a edição faz com os tokens já emitidos segue sem documentação [NC]. **Regra do Liame:** não editar a configuração de leitura enquanto o App Review de `ads_read` estiver em análise (o revisor usa o login com ela); a escrita ganha uma configuração própria, e o Liame escolhe a configuração pela empresa (a de escrita só para quem tem a flag `meta_write`). A página oficial diz que o acesso avançado a `public_profile` é exigido "before they go live", para quem não tem papel no app [O, reconferido em 04/10/2026]: não trava o piloto.
- **Rate limits** (por *business use case*, por conta, por hora) [O]:
  - `ads_management`: 300 + 40 × anúncios ativos (Limited) ou 100.000 + 40 × anúncios ativos (Full);
  - `ads_insights`: 600 + 400 × anúncios ativos (Limited) ou 190.000 + 400 × anúncios ativos (Full);
  - pontos por conta: 60 (Limited) ou 9.000 (Full); leitura = 1 ponto, escrita = 3;
  - 100 QPS de mutação por app × conta.
- **Limites operacionais** [O]:
  - **no máximo 4 mudanças de orçamento por hora por conjunto**;
  - **no máximo 10 mudanças de spend limit por dia por conta**.
- Monitorar os cabeçalhos `X-Business-Use-Case-Usage`, `X-Ad-Account-Usage` e `X-FB-Ads-Insights-Throttle`. Erros comuns: 17, 613 e 80000–80014.
- **Insights assíncronos** *(verificado em 26/09/2026 em developers.facebook.com/docs/marketing-api/insights/best-practices)* [O]:
  - `POST <objeto>/insights` devolve `{"report_run_id": ...}`;
  - consultar `GET <report_run_id>` com `async_status` e `async_percent_completion` até `"Job Completed"` e 100;
  - estados: `Job Not Started`, `Job Started`, `Job Running`, `Job Completed`, `Job Failed` (rever o pedido e tentar de novo), `Job Skipped` (expirou; pedir de novo);
  - resultado em `GET <report_run_id>/insights`, paginado;
  - recomendado para volume grande ou quando o síncrono estoura o tempo; o job pode levar até 1 hora; o `report_run_id` expira em 30 dias (não guardar).
- **Dry-run:** `execution_options=["validate_only"]` [O]. **Teto:** `spend_cap` na conta.
- **Escrita de situação e verba** *(reconferido para a A4 · X1 em 04/10/2026 nas referências oficiais de Campaign, Ad Set e Ad, mostradas na v25.0: developers.facebook.com/docs/marketing-api/reference/ad-campaign-group, /ad-campaign e /adgroup)* [O]:
  - atualizar é `POST /{campaign_id}` e `POST /{ad_id}`, com a resposta `{"success": true}`; o do conjunto (`POST /{ad_set_id}`) segue o mesmo desenho, mas a seção "Updating" da página dele não abriu inteira na leitura (página longa) [S]; os parâmetros podem ir na query da URL (o exemplo de atualização da visão geral da Graph API faz assim: developers.facebook.com/docs/graph-api/overview);
  - `daily_budget` e `lifetime_budget` são int64 na **menor unidade da moeda da conta** ("minimum denomination level, such as cents for USD": `daily_budget=2000` são US$ 20; developers.facebook.com/docs/marketing-api/bidding/overview/budgets);
  - na campanha: "All adsets under this campaign will share this budget. You can either set budget at the campaign level or at the adset level, not both";
  - `status` aceita `ACTIVE`, `PAUSED`, `DELETED` e `ARCHIVED` (na criação, só os dois primeiros); pausar a campanha pausa os filhos ativos (o `effective_status` deles vira `CAMPAIGN_PAUSED`), e pausar o conjunto pausa os anúncios ativos (`ADSET_PAUSED`);
  - `execution_options`: `validate_only` ("the API call will not perform the mutation but will run through the validation rules against values of each field"), `include_recommendations` (não vale sozinho) e, no anúncio, `synchronous_ad_review`; passando, a resposta é `{"success": true}`;
  - **o `updated_time` da campanha não muda quando a verba muda** ("If you update `spend_cap` or daily budget or lifetime budget, this will not automatically update this field"): não serve para saber se alguém mexeu;
  - leitura de um objeto: `GET /{id}?fields=…`; `account_id` (numérico, sem o `act_`) existe em campanha, conjunto e anúncio; o `effective_status` do anúncio inclui `PENDING_REVIEW`, `DISAPPROVED`, `PREAPPROVED`, `PENDING_BILLING_INFO`, `CAMPAIGN_PAUSED`, `ADSET_PAUSED`, `IN_PROCESS` e `WITH_ISSUES`;
  - verba mínima do conjunto, com a estratégia de menor custo sem teto: US$ 0,50 por dia cobrando por impressões, US$ 2,50 por cliques, curtidas ou visualizações de vídeo e US$ 40 por ações de baixa frequência; com teto de lance, pelo menos o lance (impressões) ou 5 vezes o lance (cliques e ações); em uma lista de países os mínimos dobram. Quem recusa o que fica abaixo é a validação da Meta;
  - erros documentados na atualização: 100 (parâmetro inválido), 200 (permissão), 190 (token), 613 e 80004 (limite), 2635 (versão descontinuada), 801 e, no anúncio, 368 (ação barrada por política).
- **Quanto a Meta gasta além da verba diária** *(04/10/2026)*: a página oficial de orçamentos da API (developers.facebook.com/docs/marketing-api/bidding/overview/budgets, com exemplos na v25.0) define `daily_budget` como "The average amount you're willing to spend on an ad set or campaign each day" e diz: "There may, however, be certain days when better opportunities are available. On those days, up to 25% more than your daily budget may be spent. For example, if your daily budget is $10, up to $12.50 may be spent" **[O]**. Publicações de quem anuncia (2025 e 2026) citam a Central de Ajuda da Meta para Empresas ("Sobre os orçamentos diários") com **até 75% a mais num dia** e **no máximo 7 vezes a verba diária na semana** **[S]**; a página da Central (facebook.com/business/help/190490051321426) só devolveu o título à leitura automática, então qual dos dois números vale hoje fica **[NC]**. **Regra do Liame (proposta D-A4-24):** a conferência do gasto não usa o dia: compara o gasto de 7 dias com 7 vezes a verba diária.
- **Limites da escrita** *(developers.facebook.com/docs/marketing-api/overview/rate-limiting, 04/10/2026)* [O]:
  - erro 613 com o subcódigo **1487632**: "You can only change your ad set budget 4 times per hour"; "if it exceeds the limit, the budget change for that ad set is blocked for an hour";
  - 613 com 5044001 (mutações demais: 100 por segundo por app × conta), com 1487742 (chamadas demais da conta), com 1487225 (limite de criação de anúncios) ou sem subcódigo (prevenção de abuso); 80000, 80003, 80004 e 80014 (chamadas demais da conta); 17 com 2446079 (limite do usuário) ou com 1885172 (o limite de gasto da conta mudou 10 vezes no dia); 4, com 1504022 ou 1504039 (limite do app);
  - pontos por conta: leitura 1, escrita 3; no acesso de desenvolvimento, teto de 60 pontos, queda em 300 s e bloqueio de 300 s; no acesso completo, 9.000 pontos e bloqueio de 60 s;
  - cabeçalhos de uso: `X-Business-Use-Case-Usage` (`call_count`, `total_cputime`, `total_time`, `estimated_time_to_regain_access`), `X-Ad-Account-Usage` (`acc_id_util_pct`, `reset_time_duration`, `ads_api_access_tier`) e `X-FB-Ads-Insights-Throttle`.
- **Formato do erro da Graph API** *(developers.facebook.com/docs/graph-api/guides/error-handling, 04/10/2026)* [O]: `message`, `type`, `code`, `error_subcode`, `error_user_title` e `error_user_msg` (o texto para mostrar à pessoa, no idioma do pedido) e `fbtrace_id`; os códigos 1, 2, 4, 17, 341 e 368 pedem "espere e tente de novo". O subcódigo 33 do erro 100 ("Unsupported get request. Object with ID … does not exist, cannot be loaded due to missing permissions…") é o que as respostas trazem para o objeto que sumiu [S: visto em respostas, não achado numa tabela oficial].
- **`ads_management`** *(developers.facebook.com/docs/permissions, 04/10/2026)* [O]: "allows your app to both read and manage the Ads account it owns, or has been granted access to, by the Ad account owner"; depende de `pages_read_engagement` e `pages_show_list` (entram sozinhas na configuração do login); a revisão pede o caso de uso, o login completo com a permissão concedida e os dados de desempenho (impressões, conversões, gasto, cliques e alcance) aparecendo no produto.
- **Regra do Liame para escrever na Meta (A4 · X1):** o estado é lido na Meta logo antes; a versão sai da situação e da verba (não do `updated_time`); toda escrita passa antes por `validate_only`, e a recusa dela não se repete; se alguém mexeu no objeto, nada é sobrescrito; limite de uso (os códigos acima e o cabeçalho de uso a partir de 90%) adia a execução, com 1 hora para o 613/1487632; o 368 é recusa, não espera (o Liame não insiste em ação que a Meta barrou por política); o `spend_cap` nunca é tocado. **Ferramentas (A4 · X2):** uma por tipo de objeto (campanha, conjunto e anúncio) para pausar e para retomar, e a de verba diária para campanha com orçamento de campanha ou conjunto; cada pedido mexe no máximo 10% da verba (regra do Liame; decisão do dono em 04/10/2026); no máximo 3 mudanças de verba por hora **por objeto** (a página de limites fala de 4 por hora por conjunto e não traz frase equivalente para o orçamento de campanha: o Liame aplica o mesmo limite à campanha, por cautela) [O para o conjunto; regra do Liame para a campanha]; objeto arquivado ou apagado não é mexido pelo Liame (o guia de situação diz que o arquivado só muda `name` e `status`, e o apagado, só `name`) [O]; pausar o pai passa a situação aos filhos ("all the objects below it automatically inherit that status") [O], por isso pausar a campanha para os conjuntos e os anúncios dela.
- **Criar campanha, conjunto, criativo e anúncio** *(para a A4 · X5; referências oficiais mostradas na v25.0, lidas em 05/10/2026: developers.facebook.com/docs/marketing-api/reference/ad-account/campaigns, /adsets, /adimages, /adcreatives e /ads)* [O]:
  - campanha: `POST /act_{id}/campaigns`; obrigatórios `objective` e `special_ad_categories` (lista: `NONE`, `EMPLOYMENT`, `HOUSING`, `CREDIT`, `ISSUES_ELECTIONS_POLITICS`, `ONLINE_GAMBLING_AND_GAMING`, `FINANCIAL_PRODUCTS_SERVICES`); objetivos atuais `OUTCOME_SALES`, `OUTCOME_LEADS`, `OUTCOME_ENGAGEMENT`, `OUTCOME_AWARENESS`, `OUTCOME_TRAFFIC` e `OUTCOME_APP_PROMOTION` (os antigos ainda aparecem na lista da página);
  - conjunto: `POST /act_{id}/adsets`; pede `name`, `campaign_id`, `targeting` (com o país), `status`, `daily_budget` ou `lifetime_budget` maior que zero, `optimization_goal` e `billing_event`;
  - imagem: `POST /act_{id}/adimages` com `bytes` (base64) ou `copy_from`; devolve `hash` e `url`; dá para apagar pelo `hash`. A página não diz o formato nem o tamanho aceitos (o guia de anúncios, abaixo, diz o recomendado);
  - criativo: `POST /act_{id}/adcreatives`, com `object_story_spec`, `image_hash`, `call_to_action`, `url_tags`, `degrees_of_freedom_spec` e `authorization_category` (`NONE`, `POLITICAL`, `POLITICAL_WITH_DIGITALLY_CREATED_MEDIA`);
  - anúncio: `POST /act_{id}/ads`; pede `name`, `creative` (o `creative_id` ou a especificação) e `adset_id`; erros documentados 100, 200, 613, 368, 80004, 194, 500, 2635, 190 e 105;
  - em todos: `status` na criação só `ACTIVE` ou `PAUSED`; `execution_options` com `validate_only` e `include_recommendations` (no anúncio, também `synchronous_ad_review`, que "should always be specified with validate_only"); a resposta traz `id` e `success`;
  - **a Página do Facebook é obrigatória** *(…/reference/ad-creative-object-story-spec e …/reference/ad-creative-link-data, na v26.0, lidas em 05/10/2026)* [O]: `object_story_spec.page_id` é o "ID of a Facebook page. An unpublished page post will be created on this page", e "User must have Admin or Editor role for this page"; em `link_data`, `message` é o texto principal ("The main body of the post"), `name` é o título ("Name of the link"), e ainda `description`, `image_hash`, `call_to_action` e `link` ("This url is required to be the same as the CTA link url");
  - **no Instagram** *(developers.facebook.com/docs/instagram/ads-api/guides/pages-ig-account, sem data)* [O]: "you should provide an instagram_user_id and a page_id"; o id vem da conta do Instagram ligada à Página (`GET /{page_id}/instagram_accounts`, com o token da Página) ou de uma conta apoiada na Página (`/{page_id}/page_backed_instagram_accounts`), para quem não tem conta do Instagram;
  - **permissões** *(developers.facebook.com/docs/permissions, 05/10/2026)* [O]: `ads_management` depende de `pages_read_engagement` e `pages_show_list`; `pages_manage_ads` ("Create ads for your Page. Manage ads for your Page. Create and manage ads that click to a business messaging surface") depende de `pages_show_list`; `pages_show_list` serve para "Show a person the list of Pages they manage";
  - **tipos de botão** *(…/reference/ad-creative-link-data-call-to-action, na v26.0)* [O]: a lista de `type` traz `ORDER_NOW`, `START_ORDER`, `GET_OFFER`, `SHOP_NOW`, `LEARN_MORE`, `SEE_MORE`, `WHATSAPP_MESSAGE` e `MESSAGE_PAGE`, entre mais de cem valores. **`SEE_MENU` não está nessa lista**; ele aparece entre os tipos de `asset_feed_spec`, na referência do criativo (v25.0). O botão "Ver cardápio" só é mapeado depois de um `validate_only` de verdade [NC];
  - **anúncio que leva ao WhatsApp** *(…/ad-creative/messaging-ads/click-to-whatsapp, exemplos na v25.0)* [O]: pede uma Página com número do WhatsApp ligado e as permissões `ads_management`, `pages_manage_ads`, `pages_read_engagement` e `pages_show_list`; objetivo `OUTCOME_ENGAGEMENT`, `OUTCOME_LEADS`, `OUTCOME_SALES` ou `OUTCOME_TRAFFIC`; conjunto com `destination_type: WHATSAPP`, `billing_event: IMPRESSIONS`, `optimization_goal` (`CONVERSATIONS` ou `LINK_CLICKS`, entre outros, conforme o objetivo) e `promoted_object: {page_id}`, com `whatsapp_phone_number` opcional; criativo com `link_data.call_to_action = {type: WHATSAPP_MESSAGE, value: {app_destination: WHATSAPP}}` e `link: https://api.whatsapp.com/send`;
  - **conjunto e anúncio** *(as mesmas referências, v25.0)* [O]: o conjunto aceita `campaign_id` ou `campaign_spec`, e o anúncio, `adset_id` ou `adset_spec` ("When the spec is provided, adset_id field is not required"); em `targeting`, "'countries' is required"; com verba diária e sem fim, `end_time=0`; o anúncio criado passa pela revisão (`PENDING_REVIEW`) e volta para a situação escolhida; `conversion_domain` é exigido quando a campanha divide dados com um pixel;
  - **não conferido** [NC]: os objetivos de otimização que cada objetivo de campanha aceita para o destino site, e se o `validate_only` aceita `campaign_spec` e `adset_spec`. Na X5, cada objeto é validado com o pai de verdade, na execução;
  - **Para o Liame (X5, proposta D-A4-35):** a campanha nova sai em nome de uma **Página do Facebook** da marca, e quem conecta precisa ser administrador ou editor dela. A configuração de escrita do login pede as permissões de Página (`pages_show_list`, `pages_read_engagement` e `pages_manage_ads`) além de `ads_management`, com as Páginas entre os ativos. O protótipo P10 passou a mostrar quem assina o anúncio.
- **Melhorias automáticas do criativo (Advantage+ creative)** *(developers.facebook.com/docs/marketing-api/creative/advantage-creative/get-started, exemplos na v25.0, 05/10/2026)* [O]: cada recurso de `degrees_of_freedom_spec.creative_features_spec` tem `enroll_status` `OPT_IN` ou `OPT_OUT`; a página lista, entre outros, `text_optimizations`, `image_touchups`, `image_brightness_and_contrast`, `image_templates`, `add_text_overlay`, `enhance_cta`, `inline_comment`, `image_uncrop`, `image_background_gen`, `image_animation` e `adapt_to_placement` ("Default is opt-in"); os que geram conteúdo trazem "This feature is generated with AI"; o pacote `standard_enhancements` está descontinuado desde a v22.0. O padrão de cada recurso quando o campo é omitido não está dito (só o de `adapt_to_placement`) [NC]. **Regra do Liame (X5, proposta D-A4-31):** o criativo é criado com cada melhoria em `OPT_OUT`: o que vai ao ar é a peça que a pessoa aprovou, sem a Meta trocar texto, fundo ou recorte.
- **O que o guia de anúncios recomenda para imagem e texto** *(facebook.com/business/ads-guide, páginas em português, sem data; lidas em 05/10/2026)* [O]:
  - Feed do Facebook, imagem: JPG ou PNG; proporção 4:5; 1.440 × 1.800 pixels; "Texto principal: 50 a 150 caracteres"; "Título: 27 caracteres"; até 30 MB; largura mínima de 600 pixels;
  - Feed do Instagram, imagem: 4:5; 1.440 × 1.800 pixels; "Texto principal: 125 caracteres"; "Título: 40 caracteres"; no máximo 30 hashtags; até 30 MB; largura mínima de 500 pixels; proporção de 400 × 500 a 191 × 100;
  - Stories do Instagram, imagem: 9:16; 1.440 × 2.560 pixels; "Deixe cerca de 14% da parte superior, 35% da parte inferior e 6% de cada lado do ativo sem texto, logotipos ou outros elementos criativos importantes";
  - são recomendações, não limites que a API recusa. **Regra do Liame (X6 e X7):** título de até 27 caracteres e texto principal de até 125 passam sem aviso; acima disso, a peça passa com aviso; a imagem sai em 4:5 e em 9:16, com o produto fora das faixas livres.
- **Conteúdo feito com IA em anúncio** *(Newsroom da Meta: about.fb.com/news/2025/02/gen-ai-transparency-metas-ads-products, de 03/02/2025, e about.fb.com/news/2026/02/meta-prepares-for-2026-us-midterms, de 19/02/2026; as duas atualizadas em 01/06/2026)* [O]: a Meta põe o rótulo "AI info" no anúncio criado ou editado de forma significativa com as ferramentas de IA generativa dela; o rótulo fica no menu de três pontos e, quando há pessoa fotorrealista gerada por IA, ao lado de "Patrocinado"; para imagem feita com ferramenta de terceiros, a Meta detecta por sinais padrão do setor e mostra a informação em "About this ad"; quem anuncia tema social, eleição ou política precisa declarar o uso de IA "in certain cases" (as condições exatas vêm da política de anúncios, que não foi lida: [S]). O nome do rótulo em português e a situação no Brasil: [NC]. **Para o Liame:** anúncio político é proibido pelos Termos, então a declaração não se aplica; a peça não leva pessoa (D-A4-9), então o rótulo ao lado de "Patrocinado" não é esperado; a tela diz que a Meta pode mostrar que a imagem foi feita com IA.
- **MCP oficial** "Meta Ads AI Connectors" (`mcp.facebook.com/ads`), beta aberto desde 29/04/2026, com cerca de 29 ferramentas no lançamento [S]:
  - o que é criado nasce pausado [S];
  - regras de governança definidas pelo dono (16/07/2026) [O];
  - para operar em nome de terceiros é preciso App Review com Advanced Access em **`ads_mcp_management`** [O/S].
  - **Reconferido em 30/09/2026** (developers.facebook.com/documentation/ads-commerce/ads-ai-connectors/ads-mcp-server/ads-mcp-server-overview e páginas `…/ads-mcp-server-tools-*`) [O]:
    - continua em **beta aberto**, com liberação gradual por conta (`is_ads_mcp_enabled: false` enquanto não chega [S]); sem data de GA nem lista de países ou idiomas [NC];
    - a documentação lista hoje **91 ferramentas em 7 categorias**: relatórios (7: `ads_get_ad_entities` com gasto, CTR, CPC, CPM e conversões; benchmarks, anomalias, tendência), criação e gestão (28; tudo nasce pausado e ativar exige `ads_activate_entity` com confirmação no cliente de IA), catálogo (34), sinais e datasets (13; **nenhuma envia evento da Conversions API**), ajuda (2), testes A/B e lift (7) e log de atividades (1);
    - **não aparecem** `url_tags`, relatórios assíncronos (`report_run`) nem anúncios de parceria (anunciados em 15/09 [S]) [NC];
    - **com app próprio:** caso de uso "Create & manage ads with ads MCP server", Facebook Login for Business ou `Authorization: Bearer <token de usuário>`, com `ads_mcp_management`, `ads_read`, `ads_management`, `catalog_management`, `business_management`, `pages_show_list` e `instagram_basic` (…/ads-mcp-server-get-started) [O]; a referência de permissões pede screencast de App Review para `ads_mcp_management` (developers.facebook.com/docs/permissions) [O]. **O MCP não dispensa App Review nem verificação: acrescenta uma permissão a revisar.** Sem caminho documentado com token de usuário de sistema no MCP [NC]; a **CLI oficial** (`pip install meta-ads`, Python) usa token de usuário de sistema [O];
    - **limites de uso:** a documentação do MCP não fala; presume-se os da Marketing API (BUC) [S/NC];
    - quem consome um MCP da Meta — e o agente — fica sob os **Platform Terms** (retenção, usos proibidos, transparência; o Tech Provider usa os dados só em nome do cliente e separados por cliente, 5.b); a Meta alerta para injeção de instruções (developers.facebook.com/documentation/mcp) [O];
    - **identificação de agente:** mandar `User-Agent: NomeAgente/versão (modelo) cliente-http`, sem se passar por outro agente (developers.facebook.com/llms.txt) [O].
- **Outros MCPs da Meta** *(verificado em 30/09/2026)* [O]:
  - **WhatsApp Business Tools MCP** (`mcp.facebook.com/whatsapp_business_tools`, beta, liberação gradual): números, templates, webhooks, envio e link para token de usuário de sistema; age "como você" nos próprios ativos — ferramenta de desenvolvedor, não conector de SaaS; limite por usuário e por ferramenta;
  - **Meta Social Technologies MCP** (`/devtools`, ex-Developer Tools, beta): status do App Review, conformidade, uso da API e webhooks — útil para acompanhar a revisão dos apps da DMS;
  - Instagram, Páginas e Conversions API **não têm MCP próprio** (Instagram só como ferramentas do MCP de anúncios).
- **MCPs de anúncios de terceiros:** Pipeboard (BSL 1.1, 42 ferramentas) usa **o app aprovado dele** e o selo de parceiro; GoMarble (MIT) usa o token do próprio usuário [S]. O modelo é o do Liame: a permissão vem sempre de um app aprovado.
- Custom Audience por lista exige o aceite de termos por conta. Telefone BR em **E.164 (+55 e 9º dígito)** antes do SHA-256.

- **Parâmetros de URL dos anúncios** *(verificado em 29/09/2026 em facebook.com/business/help/2360940870872492)* [O]:
  - dinâmicos: `ad_id={{ad.id}}`, `adset_id={{adset.id}}`, `campaign_id={{campaign.id}}`, `ad_name`, `adset_name`, `campaign_name`, `placement`, `site_source_name` (`an`, `fb`, `ig`, `msg`, `th`) e `media_type` (só catálogo Advantage+);
  - os de **nome congelam o nome da 1ª publicação** (renomear depois não muda o valor): o id é a evidência, nunca o nome;
  - não funcionam em anúncio de **coleção nos posicionamentos do Instagram**;
  - a Meta pode acrescentar sozinha origem, meio (`paid`) e os ids de anúncio, conjunto e campanha.
- **`url_tags`** *(developers.facebook.com/docs/marketing-api/reference/ad-creative, 29/09/2026)* [O]: campo do **AdCreative**, não do Ad; lê-se por `GET /{ad-id}?fields=creative{url_tags}`. A descrição oficial fala só de page post, message e canvas app install [O]; o uso nos anúncios de link comuns e a presença na v26.0 são inferidos (o changelog da v26.0, de 29/07/2026, não o altera) [NC].
- **Anúncio feito de publicação que já existia** *(developers.facebook.com/docs/marketing-api/reference/ad-creative, 01/10/2026)* [O]: no AdCreative, `object_story_id` é o "ID of a Facebook Page post to use in an ad" e `effective_object_story_id` o id da publicação usada, orgânica ou não publicada; `source_instagram_media_id` e `instagram_permalink_url` fazem o mesmo papel para publicação do Instagram. O link desses anúncios fica **na publicação**, não em `object_story_spec` nem em `asset_feed_spec` (que vêm vazios). A descrição oficial de `url_tags` é exatamente para este caso: "A set of query string parameters which will replace or be appended to urls clicked from page post ads". `object_url` é só para link ad sem página ("This URL is not connected to a Facebook page"), e `link_url` é a aba da página, não o destino do anúncio. Ler o link da própria publicação exigiria ler a publicação da Página, com permissão de Página além de `ads_read` [NC: não conferido; não está no caso de uso em revisão]. **Medido no piloto (01/10/2026):** 14 de 18 anúncios ativos sem link no criativo e sem `url_tags` (11 de tipo `SHARE`, 8 deles em campanhas de vendas); 3 com destino `INSTAGRAM_PROFILE`; 1 com link lido. Consequência para o produto: para esses anúncios, o rastreio do Liame entra pelo campo "Parâmetros de URL", e é por ele que o Liame confere.
  - **Reconferido para a F5 (29/09/2026)** *(developers.facebook.com/docs/instagram/ads-api/guides/url-tags-for-tracking)* [O]: o guia "Use URL Tags for Tracking" põe o rastreio no `url_tags` do **AdCreative**, no formato `chave=valor` unidos por `&`, com os parâmetros dinâmicos `{{campaign.id}}`, `{{adset.id}}`, `{{ad.id}}`, `{{campaign.name}}`, `{{adset.name}}` e `{{ad.name}}`; os de nome guardam uma foto do nome na 1ª publicação. Que o campo "Parâmetros de URL" do Gerenciador de Anúncios grava no `url_tags` é o que as fontes secundárias dizem [S]: a conferência do rastreio (F5) mostra no piloto.
  - **Onde o criativo diz para onde leva (referência v26.0, 29/09/2026)** [O]: `object_story_spec.link_data.link` ("tem de ser o mesmo link do botão") e `child_attachments[].link` (carrossel: 2 a 5 cartões, até 10) em developers.facebook.com/docs/marketing-api/reference/ad-creative-link-data; `video_data.call_to_action.value.link` (ad-creative-video-data e ad-creative-link-data-call-to-action-value); `asset_feed_spec.link_urls[]` com `website_url` e **`url_tags` próprio de cada link** (ad-asset-feed-spec-link-url); `object_url` no AdCreative ("abre no clique de um anúncio de link", página mostrada na v25.0). Anúncio de publicação existente (`effective_object_story_id`) não traz o link sem permissão da Página: fica "não verificado".
  - **Destino do conjunto** (`destination_type` do Ad Set, página mostrada na v25.0, 29/09/2026) [O]: `WEBSITE`, `APP`, `MESSENGER`, `APPLINKS_AUTOMATIC`, `WHATSAPP`, `INSTAGRAM_DIRECT`, `FACEBOOK`, `MESSAGING_MESSENGER_WHATSAPP`, `MESSAGING_INSTAGRAM_DIRECT_MESSENGER`, `MESSAGING_INSTAGRAM_DIRECT_MESSENGER_WHATSAPP`, `MESSAGING_INSTAGRAM_DIRECT_WHATSAPP`, `SHOP_AUTOMATIC`, `ON_AD`, `ON_POST`, `ON_EVENT`, `ON_VIDEO`, `ON_PAGE`, `INSTAGRAM_PROFILE`, `FACEBOOK_PAGE`, `INSTAGRAM_PROFILE_AND_FACEBOOK_PAGE`, `INSTAGRAM_LIVE`, `FACEBOOK_LIVE` e `IMAGINE`.
  - **Expansão de campos aninhados** (`object_story_spec{link_data{link}}`) na aresta `adcreatives`: só em exemplo de terceiros [S]. O conector pede assim e, se a Meta recusar (erro 100) ou responder "dados demais" (código 1, "Please reduce the amount of data you're asking for"), lê sem os campos de URL e segue, com os anúncios "não verificados": confirmar na primeira leitura real.
- **Uso dos dados de anúncio da Meta** *(Padrões de Publicidade, "Data use restrictions", transparency.meta.com/policies/ad-standards, 29/09/2026)* [O]:
  - só **agregados e anônimos** e só para avaliar as campanhas da Meta do próprio anunciante;
  - **proibido misturar dados de campanhas de vários anunciantes** (nada de benchmark entre clientes com dado da Meta);
  - **proibido levar dado de anúncio da Meta, mesmo agregado ou derivado, a outra rede de anúncios**, bolsa ou *data broker*;
  - pode ser compartilhado com quem age em nome do anunciante (prestador de serviço, como o Liame).
  - Business Tools Terms 2.a.ii (03/11/2025): relatórios e análises gerados pelas Business Tools não vão a terceiros sem acordo escrito [O].
  - **Regra do Liame:** proveniência por campo; dado da Meta nunca vai ao Google nem o do Google à Meta (ADR-019 item 9).

### 2.2 Instagram, Facebook Pages, Threads

- **IG:**
  - foto (**só JPEG**), vídeo, Reels, Stories, carrossel de até 10 itens [O];
  - **100 publicações via API por 24 h** (janela móvel) [O]: consultar `content_publishing_limit` antes;
  - mídia em **URL pública**;
  - DM só na janela de 24 h após a mensagem do usuário;
  - Instagram Login dispensa Página.
- **Pages:** métricas antigas (`page_impressions`, `page_fans`, `post_impressions`) descontinuadas em 15/11/2025, substituídas por `views` e `follows` [O]. Nova leva em 15/06/2026 [S].
- **Threads:** texto até 500 caracteres; carrossel de 2–20 itens; **250 posts, 1.000 respostas e 100 exclusões por 24 h** [O].
- **Reconferido em 09/10/2026, para o plano da A6** **[O]** (`developers.facebook.com/docs/instagram-platform/content-publishing`, `…/docs/threads/overview` e `…/docs/threads/posts`): no Instagram, "JPEG is the only image format supported"; carrossel de até 10; "100 API-published posts within a 24-hour moving period" (o carrossel conta como um), com a consulta em `GET /<IG_ID>/content_publishing_limit`; "the media must be hosted on a publicly accessible server at the time of the attempt" (envio em partes só para vídeo grande, e só com o Facebook Login for Business); conta profissional ligada a uma Página; permissões `instagram_basic`, `instagram_content_publish` e `pages_read_engagement`; sem etiqueta de compra e sem filtro. No Threads, existe post só de texto (`media_type=TEXT`), até 500 caracteres e 5 links; imagem e vídeo por endereço público ("We will cURL your image using the URL provided so it must be on a public server"); dois passos (`POST /{id}/threads` e `POST /{id}/threads_publish`, com cerca de 30 segundos entre eles); os limites de 250 posts, 1.000 respostas e 100 exclusões seguem; permissões `threads_basic`, `threads_content_publish`, `threads_manage_replies` e `threads_delete`. **Consequência para o Liame:** post com foto exige um endereço que a Meta consiga buscar na hora; o ADR-021 não aceita arquivo público, então o caminho a testar é o endereço assinado de curta duração **[NC até o teste]**.

### 2.3 Conversions API

Eventos servidor a servidor (web, app, loja física, **business_messaging**). Deduplicação Pixel × CAPI por **`event_id`**; EMQ alto depende de e-mail/telefone com hash, `fbp`/`fbc`, IP e UA. "Pixel ID" virou "Dataset ID" [S].

- **Reconferido em 29/09/2026** *(developers.facebook.com/docs/marketing-api/conversions-api/parameters/server-event, …/fbp-and-fbc e …/business-messaging)* [O]:
  - **`event_time` até 7 dias no passado; um evento mais velho derruba o lote inteiro.** Os 62 dias valem só para `physical_store`;
  - **`fbc`** = `fb.<subdomainIndex>.<creationTime em ms>.<fbclid>` (gerado no servidor sem cookie: índice `1`); o fbclid diferencia maiúsculas e não se altera; `fbc` e `fbp` vão **sem hash**; o cookie `_fbc` dura 90 dias (recomendação, não limite da API);
  - com a Parameter Builder Library, `fbc`/`fbp` podem ter um **apêndice no fim**: não validar com regex de 4 partes;
  - **mensageria (`action_source: business_messaging`, `messaging_channel: whatsapp`)**: `user_data.ctwa_clid` (sem hash) **obrigatório** + `whatsapp_business_account_id`; dataset por `GET/POST /{WABA_ID}/dataset`; acesso avançado a `whatsapp_business_management` e `whatsapp_business_manage_events` e o recurso "Marketing API Access Tier"; eventos Purchase, LeadSubmitted, OrderCreated, OrderCanceled etc.; **a Meta não deduplica eventos de mensageria**.
- **Reconferido em 08/10/2026** *(…/conversions-api/parameters/server-event)* [O]: obrigatórios `event_name`, `event_time`, `user_data` e `action_source`; `event_source_url` "is required for website events shared using the Conversions API"; `event_id` é opcional e serve à deduplicação; valores de `action_source`: `email`, `website`, `app`, `phone_call`, `chat`, `physical_store`, `system_generated`, `business_messaging` e `other`; o `event_time` "can be up to 7 days before you send an event". O `client_user_agent` fica na página dos parâmetros do cliente, que não foi lida agora: [NC], conferir antes da A5 · Y7.

### 2.4 WhatsApp (sempre via RegemCast)

- Cobrança **por mensagem** desde 01/07/2025 [O]:
  - marketing é sempre cobrado;
  - utility é grátis dentro da janela de atendimento;
  - service é grátis;
  - entrada por click-to-WhatsApp dá **72 h grátis**.
- **Faturamento em BRL** desde 01/07/2026; migração obrigatória até 30/06/2027 [O].
- Política de preço para "AI Providers" desde 16/02/2026 [O].
- **Chatbots de IA de uso geral proibidos desde 15/01/2026**; agentes de negócio seguem permitidos; no Brasil, a regra está em disputa no CADE [S].
- A política de 23/09/2026 exige **opt-in** (por categoria é boa prática) e respeito ao opt-out **mesmo pedido fora do WhatsApp** [O, conferido em 25/09/2026, §6.1]. No Brasil, a proibição de "AI Providers" (§4.7) está suspensa por medida preventiva do CADE, mantida em 04/03/2026 [O].
- Cobrança de mensagens de atendimento a partir de 01/10/2026 [NC].
- **`referral` do anúncio de clique para WhatsApp** *(webhook `messages`, developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages/text, 29/09/2026)* [O]:
  - vem só na mensagem aberta por anúncio: `source_url`, `source_id` (**id do anúncio**), `source_type` (`ad`), `headline`, `body`, `media_type`, `image_url` ou `video_url`/`thumbnail_url`, `ctwa_clid`, `welcome_message`;
  - **o `ctwa_clid` some** na mensagem vinda de anúncio no **Status do WhatsApp** (o `referral` vem).
- **Coexistência (app + Cloud API) e o `referral`** [NC]: a página oficial de coexistência diz que o cliente pode rodar anúncios de clique para WhatsApp e reportar pela CAPI, mas **não garante o `referral` no webhook**; a 1ª mensagem de quem clica no anúncio pode chegar como `unsupported` (erro 131060), que "costuma se resolver em segundos". **Testar com número real antes de prometer o caminho B** (D-A2.5-9).
- Modelos [memória interna, verificado em uso]:
  - LTO só em MARKETING, sem rodapé, cabeçalho IMAGE/VIDEO, `expiration_time_ms` em epoch absoluto;
  - cabeçalho TEXT com 1 variável, até 60 caracteres;
  - emoji no cabeçalho reprova;
  - nome de modelo apagado fica bloqueado por semanas;
  - 250 modelos por WABA;
  - tiers `TIER_250 → 2K → 10K → 100K → UNLIMITED` (ler o número do nome).

---

## 3. Google

*Verificado em 24/09/2026.*

### 3.1 Google Ads API

- **Developer token encerrado em 09/09/2026:** o acesso passa a ser do **projeto Google Cloud**, com inscrição no Cloud Console; MCC não é mais obrigatória [O].
  - *(reconferido em 26/09/2026 em developers.google.com/google-ads/api/docs/api-policy/developer-token)* o cabeçalho `developer-token` ainda é aceito, mas é **opcional e ignorado**; será **recusado numa major futura**. O nível de acesso vem do projeto Google Cloud que gerou a credencial OAuth [O]. **O Liame não envia o cabeçalho.**
- **Níveis de acesso pelo projeto Google Cloud** *(verificado em 28/09/2026 em developers.google.com/google-ads/api/docs/api-policy/access-levels e observado no projeto do Liame)* [O]: **Teste** (automático ao ativar a API; só contas de teste; 15.000 op/dia) → **Exploração/Explorer** (contas reais, 2.880 op/dia em produção; pedido em `console.cloud.google.com/google/ads-apis/overview` → "Inscrever-se para receber acesso", **sem formulário; aprovado sozinho em cerca de 1 minuto**) → **Básico** (15.000 op/dia; **exige verificação da marca do projeto**; revisão automática) → **Padrão** (ilimitado; auditoria manual de ~10 dias úteis, RMF).
- **Chave secreta do cliente OAuth** *(support.google.com/cloud/answer/15549257, 28/09/2026)* [O]: visível e baixável **só na criação**; depois o console mostra os 4 últimos caracteres. Troca: no cliente, "Add secret" (fica ativo junto do antigo), depois "Desativar" e "Excluir" o antigo (ERR-036 do Liame).
- **OAuth do Google (servidor web)** *(verificado em 26/09/2026 em developers.google.com/identity/protocols/oauth2/web-server)* [O]: autorização em `https://accounts.google.com/o/oauth2/v2/auth` (`client_id`, `redirect_uri`, `response_type=code`, `scope`, `access_type=offline`, `state`, `include_granted_scopes`, `prompt`); token em `POST https://oauth2.googleapis.com/token` (`code`, `client_id`, `client_secret`, `redirect_uri`, `grant_type`), resposta com `access_token`, `expires_in`, `refresh_token`, `scope`, `token_type` e `refresh_token_expires_in`; renovação com `grant_type=refresh_token`; revogação em `POST https://oauth2.googleapis.com/revoke` com `token`. PKCE (`code_challenge`/`code_verifier`) não aparece na página do servidor web; o Liame manda S256 mesmo assim [S] (confirmar no primeiro teste real, A0-5). Refresh token de app em **modo de teste** vence em 7 dias [O] (conferido em 05/10/2026: item seguinte).
- **Status do app OAuth: Testing × In production** *(verificado em 05/10/2026 em developers.google.com/identity/protocols/oauth2, atualizada em 26/05/2026; support.google.com/cloud/answer/15549945, "Manage App Audience"; /answer/7454865, "Unverified apps"; /answer/13464323, "When is verification not needed"; e developers.google.com/identity/protocols/oauth2/production-readiness/overview, atualizada em 22/05/2026)* [O]:
  - **Testing:** só os usuários de teste listados, até 100; "Authorizations by a test user will expire seven days from the time of consent", e o refresh token do acesso `offline` "will also expire". A página do OAuth 2.0 diz o mesmo: o projeto com tela de consentimento de usuário externo e status "Testing" recebe "a refresh token expiring in 7 days", salvo quando só pede nome, e-mail e perfil;
  - **In production (publicado):** "available to any user with a Google Account". O vencimento de 7 dias é do status Testing: publicado, o app deixa de receber refresh token com esse prazo. Com escopo sensível ou restrito ainda sem verificação, o Google mostra o aviso de app não verificado e vale o teto de "100 new users in total", que só sai com a verificação;
  - **quando a verificação não é exigida:** uso pessoal com menos de 100 usuários ("you and your limited number of users can continue using the app without going through verification") e app em desenvolvimento ou teste;
  - **Para o Liame:** `auth/adwords` é escopo sensível (§6.1). Publicar o app sem pedir a verificação acaba com a reconexão semanal do piloto, ao preço do aviso de app não verificado na hora de autorizar e do teto de 100 usuários; a verificação segue obrigatória antes do primeiro cliente de fora. As páginas não dizem o que acontece com o refresh token emitido em Testing depois de publicar: por garantia, a empresa conecta de novo uma vez. **O caminho no console do Google Cloud não está nesta base:** confirmar pelo print do dono antes de guiar.
- **REST** *(verificado em 26/09/2026 em developers.google.com/google-ads/api/rest/auth e /rest/common/search)* [O]:
  - cabeçalhos: `Authorization: Bearer`; `login-customer-id` (sem hífens) quando a chamada passa por uma conta gerente; `linked-customer-id` só para parceiros em conta vinculada;
  - `POST /v25/customers/{id}/googleAds:search` (paginado por `pageToken`) e `…:searchStream` (resposta numa **lista JSON de lotes** com `results`, `fieldMask`, `requestId`); campos da resposta em camelCase;
  - `GET /v25/customers:listAccessibleCustomers` lista as contas de acesso direto (`resourceNames`).
  - Não verificado na página (regra do JSON do protobuf) [S]: int64 chega como texto e o valor zero pode ser omitido; o conector trata os dois.

  | Nível | Operações/dia | Observação |
| --- | --- | --- |
  | Test | 15.000 | só contas de teste |
  | Explorer | 2.880 | aprovado normalmente de forma automática; **bloqueia** planner, criação de contas, usuários e billing |
  | Basic | 15.000 | exige **verificação de marca** do projeto |
  | Standard | ilimitado | auditoria manual de ~10 dias úteis; demo e RMF |

- **Versões** *(reconferido em 26/09/2026 nas release notes oficiais)*: a major mais nova continua a **v25** (22/07/2026) [O]; o que sai por mês são **versões menores** dentro da major: **v25.1 (19/08/2026)** e **v25.2 (23/09/2026)** [O]. Cada major vive ~12 meses [S] (v22 até out/2026 · v23 até fev/2027 · v24 até mai/2027 · v25 até ago/2027). Validar em `/sunset-dates`.
- **Rastreio de cliques** *(verificado em 29/09/2026)* [O]:
  - **auto-tagging** acrescenta `gclid` e vem **ligado por padrão em contas novas** (support.google.com/google-ads/answer/3095550);
  - iOS: `wbraid` (clique num app iOS que leva à web) e `gbraid` (clique na web que leva ao app iOS; Search, Shopping, Display e PMax); o **GBRAID não é único por usuário** (agregado, diferencia maiúsculas) e a Google agora recomenda mandar gclid **e** gbraid juntos (developers.google.com/google-ads/api/docs/conversions/upload-clicks, 24/09/2026);
  - **ValueTrack:** `{campaignid}`, `{adgroupid}`, `{creative}` (id do anúncio), `{keyword}` (vazio em AI Max, DSA e PMax), `{matchtype}`, `{network}` (`x` = todo tráfego PMax), `{device}`, `{gclid}` (support.google.com/google-ads/answer/6305348);
  - **onde:** modelo de acompanhamento (conta, campanha e grupo exigem `{lpurl}`) e **sufixo do URL final** (conta, campanha, grupo, anúncio, alvo dinâmico, palavra-chave e sitelink);
  - **leitura pela API v25:** `customer.final_url_suffix`/`tracking_url_template`, `campaign.*`, `ad_group.*`, `ad_group_ad.ad.final_url_suffix`/`tracking_url_template`/`url_custom_parameters`/`final_urls`, `ad_group_criterion.*` (todos selecionáveis);
  - **Reconferido para a F5 (29/09/2026)** [O]:
    - o campo se chama **"Sufixo do URL final"** na interface em português; o valor é `x=y` sem o `?` (o Google põe o `?`), com os parâmetros unidos por `&` (support.google.com/google-ads/answer/9054021?hl=pt-BR; exemplo `keyword={keyword}&matchtype={matchtype}&adgroupid={adgroupid}` no `Customer.final_url_suffix` em developers.google.com/google-ads/api/docs/account-management/create-account);
    - **qual vale:** o modelo de acompanhamento e o sufixo são resolvidos **cada um por si**, pela entidade **mais baixa** da hierarquia que define o valor (developers.google.com/google-ads/api/docs/ads/upgraded-urls/serving-url-rules, atualizada em 23/09/2026); no modelo, palavra-chave > anúncio > grupo > campanha > conta (support.google.com/google-ads/answer/6076199);
    - ValueTrack `{campaignid}`, `{adgroupid}` e `{creative}` valem "no URL final, no modelo de acompanhamento ou em parâmetro personalizado"; a lista oficial **não tem o nome da campanha**; `{lpurl}` sai codificado, a não ser no começo do modelo (support.google.com/google-ads/answer/6305348);
    - campos confirmados nos protos oficiais da v25 (github.com/googleapis/googleapis, `google/ads/googleads/v25/resources`): `Ad.final_urls`, `tracking_url_template`, `final_url_suffix` e `url_custom_parameters`; `Customer`, `Campaign` e `AdGroup` com `tracking_url_template` e `final_url_suffix`;
    - recurso atribuído na GAQL: `SELECT campaign.name, customer.id FROM campaign` (developers.google.com/google-ads/api/docs/query/structure) e `campaign.name`, `ad_group.name` e `ad_group_ad.ad.final_urls` `FROM ad_group_ad` (…/docs/query/cookbook), os dois de 23/09/2026;
    - **o Liame lê** as URLs finais e o sufixo e o modelo do anúncio, do grupo, da campanha e da conta (esta pela campanha), no mesmo escopo de leitura; sufixo de palavra-chave, de segmentação dinâmica e de sitelink e o parâmetro personalizado (`{_lk}`) não são lidos.
  - **`click_view`** resolve `gclid` → anúncio (e campanha e grupo como recursos segmentadores); **um dia por consulta, até 90 dias para trás; sem gbraid/wbraid**; sem gclid em campanhas de app de instalação e pré-registro (developers.google.com/google-ads/api/fields/v25/click_view, 23/09/2026);
  - **janela de conversão padrão:** clique **30 dias** (1–30, 60 ou 90), visualização engajada 3 dias, visualização 1 dia; mudar só vale daqui em diante (support.google.com/google-ads/answer/3123169).
- **Campanhas:** AI Max GA (abr/2026); DSA e broad sobem automaticamente para AI Max a partir de set/2026; fim do DSA adiado para fev/2027 [S]. Display standalone migrando para Demand Gen [S].
- **Multi-Party Authorization** (v24) pode exigir um segundo admin para operações de usuário [O].
- **Suspensão por contas relacionadas** (*circumventing systems*) contamina contas ligadas por pagamento, usuário ou MCC: isolar clientes.
- **`validate_only` e a escrita** *(developers.google.com/google-ads/api/docs/mutating/overview, atualizada em 30/09/2026; lido em 08/10/2026)* [O]: `validate_only` existe nos pedidos de escrita: confere a sintaxe e as regras de negócio sem gravar. Os serviços por recurso são `CampaignService.MutateCampaigns` e `CampaignBudgetService.MutateCampaignBudgets`; `GoogleAdsService.Mutate` aceita operações de vários recursos num pedido só; com `partial_failure`, as operações válidas entram sozinhas. **Reconferido para a A5 · Y2 em 08/10/2026**, nos arquivos da própria API no repositório oficial `googleapis/googleapis` (`google/ads/googleads/v25`: `services/campaign_service.proto`, `services/campaign_budget_service.proto`, `resources/campaign_budget.proto`, `resources/campaign.proto`, `errors/quota_error.proto`, `errors/campaign_budget_error.proto`, `errors/errors.proto`) e nas páginas `…/rest/common/mutate`, `…/rest/examples`, `…/docs/best-practices/quotas` e `…/rate-limits` (atualizadas em 30/09/2026) [O]:
  - **rotas REST:** `POST /v25/customers/{customer_id}/campaigns:mutate` e `POST /v25/customers/{customer_id}/campaignBudgets:mutate`, com `operations[]` (`updateMask` e `create`, `update` ou `remove`), `partialFailure`, `validateOnly` e `responseContentType`;
  - **`validate_only`:** "If true, the request is validated but not executed. Only errors are returned, not results." Ou seja: passando, a resposta vem sem `results`;
  - **máscara e corpo:** no JSON os campos vão em camelCase (`amountMicros`, `resourceName`) e a `updateMask` em snake_case, separada por vírgula (o exemplo oficial usa `"manual_cpc.enhanced_cpc_enabled"`); a resposta da escrita traz `results[].resourceName`;
  - **`CampaignBudget`:** `amount_micros` ("The average daily amount", usado com o período `DAILY`, o padrão; o gasto do mês é limitado a 30,4 vezes esse valor) e `total_amount_micros` (só com `CUSTOM_PERIOD`) são mutuamente exclusivos; `period` e `type` são imutáveis; `status`, `id` e `reference_count` ("The number of campaigns actively using the budget") são só de leitura; `explicitly_shared`: verdadeiro = criado para ser dividido; falso = de uma campanha só (nome e situação acompanham a campanha, e ligar a uma segunda dá erro); um orçamento não compartilhado pode virar compartilhado, e o compartilhado nunca volta;
  - **`Campaign`:** `status` é mutável (o padrão na criação é `ENABLED`); `primary_status` e `serving_status` são só de leitura; `campaign_budget` é o nome de recurso do orçamento;
  - **erros de orçamento** (`CampaignBudgetError`): `MONEY_AMOUNT_TOO_LARGE`, `NEGATIVE_MONEY_AMOUNT`, `NON_MULTIPLE_OF_MINIMUM_CURRENCY_UNIT`, `MONEY_AMOUNT_LESS_THAN_CURRENCY_MINIMUM_CPC`, `BUDGET_BELOW_PER_DAY_MINIMUM`, `CANNOT_MODIFY_FIELD_OF_IMPLICITLY_SHARED_CAMPAIGN_BUDGET`, `CAMPAIGN_BUDGET_REMOVED`, entre outros;
  - **formato do erro:** o erro geral (`error.code`, `error.status`, `error.message`) traz em `error.details[]` um `GoogleAdsFailure` com `errors[]` (`errorCode` como `{"campaignBudgetError": "MONEY_AMOUNT_TOO_LARGE"}`, `message`, `trigger`, `location`, `details`) e `requestId`; na cota, `details.quotaErrorDetails` traz `rate_scope`, `rate_name` e `retry_delay`;
  - **cota:** `QuotaError.RESOURCE_EXHAUSTED` ("Too many requests": o limite diário de operações do nível de acesso) e `RESOURCE_TEMPORARILY_EXHAUSTED` ("Too many requests in a short amount of time": o limite por segundo, contado por id de cliente e por projeto); cada `Search` ou `SearchStream` conta como uma operação, e cada operação de escrita também; até 10.000 operações por pedido de escrita. **Não conferido** [NC]: se a chamada com `validate_only` conta no limite diário (a página não diz); o Liame conta como se contasse.
  - **Para o Liame (A5 · Y2):** a verba que o Liame muda é a do orçamento **diário e de uma campanha só**; o orçamento criado para ser dividido, ou usado por mais de uma campanha, nunca é alterado (D-A5-4); a escrita de cada empresa tem uma cota diária própria (300 operações), bem abaixo das 2.880 do projeto.
- **O que o nível Explorer bloqueia** *(…/docs/api-policy/access-levels, atualizada em 30/09/2026; lido em 08/10/2026)* [O]: até 2.880 operações por dia em contas de produção. Serviços bloqueados: criação de conta (`CustomerService.CreateCustomerClient`), usuários (`CustomerUserAccessInvitationService`, `CustomerUserAccessService`), planejamento (os `KeywordPlan…`, `AudienceInsightsService`, `ReachPlanService`) e cobrança da conta (`PaymentsAccountService`, `BillingSetupService`, `AccountBudgetProposalService`, `InvoiceService`). `CampaignService`, `CampaignBudgetService` e `GoogleAdsService.Mutate` **não estão na lista**. O `AccountBudgetProposalService` é o orçamento de faturamento da conta, não a verba de uma campanha. A lista veio de uma leitura resumida da página; **relida em 08/10/2026 para a A5 · Y2, com o mesmo resultado** (os quatro grupos bloqueados e nenhum serviço de campanha ou de orçamento de campanha entre eles).
- **Orçamento de campanha** *(…/docs/campaigns/budgets/share-budgets, …/create-budgets e …/performance-max/create-budget; lido em 08/10/2026 pelo resultado da busca)* [O, por trecho]: `amount_micros` é a média diária, na moeda da conta, quando o período é `DAILY` (o padrão); `explicitly_shared` diz se o orçamento foi criado para servir a mais de uma campanha (na criação, omitido, vale `true`); orçamento de período (`CUSTOM_PERIOD`) e campanha Performance Max não usam orçamento compartilhado. **Para o Liame:** mudar um orçamento compartilhado muda a verba de todas as campanhas que o usam (D-A5-4 do `plano-a5.md`).
- **MCP oficial** `googleads/google-ads-mcp`: 3 ferramentas, **somente leitura**, auto-hospedado [O].
  - **Reconferido em 30/09/2026** (developers.google.com/google-ads/api/docs/developer-toolkit/mcp-server, pypi.org/project/google-ads-mcp) [O]: versão **0.0.4 (25/09/2026)**; ferramentas `list_accessible_customers`, `search` (GAQL) e `get_resource_metadata`; "strictly read-only", **sem roteiro de escrita**; só self-hosted (stdio ou Cloud Run próprio com proxy OAuth do FastMCP); **não existe MCP do Google Ads hospedado pelo Google** (fora do catálogo docs.cloud.google.com/mcp/supported-products, 30/09); precisa de acesso Explorer ou acima e da verificação do app OAuth — **não dispensa nenhuma revisão**. O commit de 28–29/09 "Upgrade fastmcp so oauth tokens aren't logged" indica que versões anteriores podiam gravar token OAuth no log [O/NC].
- **Política de "programmatic proxy" (31/08/2026)** (support.google.com/adspolicy/answer/6169371 e support.google.com/google-ads/answer/18103182) [O]: fica **proibido** "third-party hosted interface, secondary API, wrapper service, or MCP server… that solely replicates, wraps, or re-exposes Google Ads programmatic capabilities". Exceções: uso próprio e software open-source que o usuário baixa e conecta com as próprias credenciais. A política também veda alterações "headless" sem revisão do caso de uso pelo Google ou sem autenticação direta por entidade. **Para o Liame:** o conector direto (projeto próprio + OAuth por cliente) segue permitido; **nunca** hospedar para os clientes um MCP (ou API) que só repasse o Google Ads — o `/mcp/liame` (ADR-008) expõe capacidades do Liame, não operações do Google Ads.
- **Developer token (reconferido em 30/09/2026)** (developers.google.com/google-ads/api/docs/api-policy/developer-token, atualizada 29/09) [O]: enviado, é "optional and ignored"; uma versão futura vai rejeitá-lo; o acesso de quem chamou a API nos 90 dias anteriores foi transferido ao projeto Cloud. Níveis: Explorer 2.880 operações/dia em produção, Basic 15.000 (verificação de marca; desde 10/09 aprovado em minutos pelo Cloud Console [O/S]), Standard ilimitado (auditoria). **OAuth client de outro projeto começa só em "Test".**
- **v22 da Google Ads API encerra em 07/10/2026** [O, feed do blog]; o conector do Liame nasce na v25.

### 3.2 Data Manager API (conversões e públicos)

Destino único para **conversões offline**, **Customer Match** e **enhanced conversions for leads** [O/S].

- Customer Match bloqueado na Ads API desde 01/04/2026 para quem não fez upload em 180 dias.
- Conversões offline por clique bloqueadas desde 15/06/2026 fora da allowlist (`CUSTOMER_NOT_ALLOWLISTED_FOR_THIS_FEATURE`).
- **Integração nova nasce na Data Manager API.**
- **Reconferido em 29/09/2026** [O]: GA desde 09/12/2025; o Google a chama de **"primary"**, não de "única" (quem já usava a Ads API segue enquanto migra); a allowlist das conversões offline é **por developer token**, e as páginas oficiais divergem na janela exigida (blog: "dezembro de 2025 a maio de 2026"; deprecations: "17/12/2025 a 15/06/2026"). Escopo `https://www.googleapis.com/auth/datamanager` é **sensível** (verificação OAuth do app). Fontes: ads-developers.googleblog.com/2026/05/changes-to-offline-click-conversion.html, developers.google.com/google-ads/api/docs/deprecations, developers.google.com/data-manager/api/devguides/quickstart/set-up-access.
- **Reconferido em 08/10/2026** *(developers.google.com/data-manager/api/reference/rest/v1/events/ingest; …/devguides/events e …/devguides/quickstart/set-up-access, atualizadas em 07/10/2026; …/reference/rest/v1/Consent)* [O]:
  - `POST https://datamanager.googleapis.com/v1/events:ingest`; no corpo, `destinations[]` e `events[]` ("At most 2000 Event resources can be sent in a single request"), `consent` (o do pedido; o do evento vale mais), `validateOnly` ("the request is validated but not executed"), `encoding` (obrigatório quando há `userData`) e `encryptionInfo`;
  - no evento: `eventTimestamp` (obrigatório), `transactionId` ("Required for events sent as an additional data source for tag conversions"), `adIdentifiers` (`gclid`, `gbraid`, `wbraid`), `conversionValue`, `currency`, `eventSource`, `userData` e `consent`; a resposta traz `requestId` e os avisos por campo;
  - `Consent` tem `adUserData` e `adPersonalization`, cada um `CONSENT_GRANTED`, `CONSENT_DENIED` ou não informado;
  - o acesso pede a API ativada no projeto, o escopo `https://www.googleapis.com/auth/datamanager` e o usuário com acesso à conta de destino; a página não cita developer token nem nível de acesso da Ads API;
  - **ajuste de conversão** (…/devguides/events/google-ads/conversion-adjustments, pelo resultado da busca) [O, por trecho]: o mesmo `transactionId`, na mesma ação de conversão, vira ajuste; há a reafirmação do valor e a retirada (a compra cancelada);
  - **Reconferido para a A5 · Y1 em 08/10/2026** *(…/devguides/events/google-ads/offline/send-events, …/devguides/concepts/destinations, …/devguides/limits, …/reference/rest/v1/requestStatus/retrieve e …/devguides/events/google-ads/conversion-adjustments, atualizadas em 07/10/2026; …/reference/rest/v1/Destination, de 10/09/2026)* [O]:
    - **a ação de conversão** que recebe venda por clique é do tipo `UPLOAD_CLICKS` (origem "Website (Import from clicks)"); o `productDestinationId` é o id dela, que também sai de uma consulta à Google Ads API (lido por resumo: reler o trecho da configuração antes do passo a passo com o dono);
    - **destino:** `operatingAccount` (`accountType: GOOGLE_ADS`, `accountId` com o id do cliente) é obrigatório; `loginAccount` é opcional e, omitido, vale a própria conta; a conta Google da credencial precisa ser usuária da conta de login ("Acesso e segurança");
    - **evento:** `transactionId` único por conversão; `eventTimestamp` em RFC 3339; **exatamente um** entre `gclid`, `gbraid` e `wbraid`; `eventSource` (`WEB` para o pedido feito no site); `conversionValue` em valor de moeda, não em micros; `currency` em ISO 4217; `encoding` só quando há `userData`;
    - **o mesmo `transactionId` na mesma ação:** `conversionValue` e `currency` são sobrescritos; os outros campos não mudam; "You don't need to specify an adjustment type". **A página não tem retirada** (retract, cancel e refund não aparecem no texto): cancelar uma venda pela Data Manager é corrigir o valor. O valor zero não é citado [NC]: conferir com `validateOnly` no piloto. Nas conversões de várias fontes (as que a tag do site também registra), o valor não muda nos primeiros 14 dias;
    - **resultado:** `GET https://datamanager.googleapis.com/v1/requestStatus:retrieve?requestId=…` devolve, por destino, `SUCCESS`, `PROCESSING`, `FAILED` ou `PARTIAL_SUCCESS`, com `errorInfo`, `warningInfo` e a contagem dos registros; a página não diz em quanto tempo o resultado fica pronto;
    - **limites por projeto:** o serviço de ingestão, 100.000 pedidos por dia e 300 por minuto; os outros, 50.000 por dia e 300 por minuto; até 2.000 eventos e 10 destinos por pedido; acima disso, `RESOURCE_EXHAUSTED` com HTTP 429;
    - **prazos** *(Ajuda do Google Ads: support.google.com/google-ads/answer/7012522 e /answer/15081888, pelo resultado da busca)* [O, por trecho]: conversão enviada mais de 90 dias depois do clique não é importada ("This click is too old"); depois de criar a ação de conversão, esperar de 4 a 6 horas antes do primeiro envio; manter o atraso do envio abaixo de 7 dias;
    - **a ação de conversão na Google Ads API v25** *(protos oficiais, github.com/googleapis/googleapis, `google/ads/googleads/v25/resources/conversion_action.proto` e `enums/conversion_action_type.proto`; lidos em 08/10/2026)* [O]: campos `id`, `name`, `status`, `type`, `category`, `primary_for_goal` ("biddable" por padrão), `click_through_lookback_window_days` e `value_settings`; o tipo `UPLOAD_CLICKS` é "Conversions that are tracked by the advertiser and uploaded with attributed clicks". É por GAQL em `conversion_action` que o Liame lista as conversões da conta para a pessoa escolher;
    - **criar a ação de conversão na tela do Google Ads** *(Ajuda em português, support.google.com/google-ads/answer/7012522?hl=pt-BR, lida por resumo em 08/10/2026)* [O, por trecho]: "Acesse **Resumo** no menu **Metas**", "**+ Criar ação de conversão**", "**Conversões off-line**", "Adicionar fonte de dados". O resto do caminho (a fonte de dados para quem envia pela API) não foi confirmado: guiar o dono pelo print dele, um passo por vez;
    - **por conferir no piloto** [NC]: se a retirada da Google Ads API (`ConversionAdjustmentUploadService`) vale para conversão enviada pela Data Manager; o que mandar em `consent` fora do Espaço Econômico Europeu (o Liame não manda: não guarda prova de consentimento).

### 3.3 GA4, Search Console, GBP, YouTube, Merchant

- **GA4 Data API** (propriedade padrão) [O]:
  - 200 mil tokens/dia, 40 mil/hora, 14 mil por projeto por hora, 10 requisições concorrentes;
  - no GA 360, 10×;
  - usar `returnPropertyQuota`.
  - MCP oficial experimental, só leitura.
  - **Reconferido em 30/09/2026** (github.com/googleanalytics/google-analytics-mcp, developers.google.com/analytics/devguides/MCP) [O]: versão 0.7.0 (29/07/2026), 7 ferramentas (`get_account_summaries`, `get_property_details`, `list_google_ads_links`, `run_report`, `run_funnel_report`, `get_custom_dimensions_and_metrics`, `run_realtime_report`), "read requests only", só local; sem versão hospedada pelo Google; não dispensa a verificação OAuth de app multi-tenant.
- **GA4 para o conector** *(verificado em 26/09/2026 nas referências REST da Data API v1beta e da Admin API v1beta)* [O]:
  - `POST https://analyticsdata.googleapis.com/v1beta/properties/{id}:runReport` com `dateRanges`, `dimensions`, `metrics`, `limit` (padrão 10.000, máximo 250.000), `offset`, `keepEmptyRows`, `returnPropertyQuota`;
  - a resposta traz `rows` (`dimensionValues`/`metricValues`), `rowCount`, `metadata` (`dataLossFromOtherRow`, `samplingMetadatas`, `subjectToThresholding`, `currencyCode`, `timeZone`) e `propertyQuota` (`tokensPerDay`, `tokensPerHour`, `tokensPerProjectPerHour`, `concurrentRequests`, `serverErrorsPerProjectPerHour`, `potentiallyThresholdedRequestsPerHour`, cada um com `consumed`/`remaining`);
  - `GET https://analyticsadmin.googleapis.com/v1beta/accountSummaries` (`pageSize` até 200, `pageToken`) lista contas e `propertySummaries`; a propriedade (`properties/{id}`) tem `timeZone` e `currencyCode`;
  - métricas `sessions`, `totalUsers`, `newUsers`, `engagedSessions` e **`keyEvents`** (o antigo "conversions") na página do esquema [O]; `ecommercePurchases`, `purchaseRevenue`, `sessionSource` e `sessionMedium` confirmados só por fonte secundária, porque a página veio cortada [S]; `date` chega como `AAAAMMDD`.
- **Escopo `analytics.readonly`** *(29/09/2026)*: **não é restrito** (support.google.com/cloud/answer/13464325) [O]; a marca de "sensível" só aparece no Cloud Console, na tela de acesso a dados do projeto [NC]: conferir lá antes de pedir a verificação do app.
- **Search Console** [O] (`developers.google.com/webmaster-tools/limits`, atualizada em 28/08/2025; lida em 09/10/2026): Search Analytics a 1.200 QPM por site e por usuário, 40.000 QPM e 30 milhões por dia por projeto; URL Inspection a 2.000 por dia e 600 por minuto por site; cota de carga de curto prazo (janelas de 10 minutos) e de longo prazo (1 dia), em que agrupar por página e por consulta ao mesmo tempo é o mais caro.
- **Google Business Profile** [O]:
  - acesso **restrito**: perfil verificado há **60+ dias**, com site;
  - começa com **0 QPM** e passa a 300 QPM quando aprovado;
  - análise em ~14 dias (relatos de semanas).
  - **Pedir cedo.**
  - **Reconferido em 09/10/2026** [O] (`developers.google.com/my-business/content/prereqs` e `…/content/latest-updates`, as duas atualizadas em 28/08/2026): os requisitos seguem ("verified and active for 60+ days", "a website representing the business listed on the GBP"); a cota é 0 QPM antes da aprovação e 300 QPM depois; o pedido é pelo formulário de contato da API ("Application for Basic API Access"), com um e-mail que seja dono ou gerente do perfil; **a página não diz o prazo da análise**. Novidades de 2026 nas avaliações: `ReviewReplyState` (01/04), `ReviewMediaItem` (20/04), `PolicyViolation` (01/07) e `reviewReplyUrl` (24/07); nos posts, a repetição (`RecurrenceInfo` no `LocalPost`, 07/04). Nenhuma descontinuação anunciada na página.
- **YouTube:**
  - Shorts pelo mesmo `videos.insert`;
  - cotas separadas para `videos.insert` e `search.list` desde 01/06/2026 [O];
  - upload custa ~100 unidades desde 04/12/2025 [O];
  - projeto não auditado publica como privado [NC].
- **Content API for Shopping encerrada em 18/08/2026** [S]: usar a **Merchant API**.

---

## 4. TikTok, LinkedIn e outras

*Verificado em 24/09/2026.*

- **TikTok Marketing API:**
  - cadastro em business-api.tiktok.com + revisão do app (mais rígida em 2026) [S];
  - **MCP oficial** com leitura e escrita (12–13/05/2026), com versões de ~400 e ~40 ferramentas;
  - "TikTok Ads Skills" e Agentic Hub [O/S];
  - Events API com dedup por `event_id`.
- **TikTok Content Posting** [O]:
  - sem auditoria, só publica `SELF_ONLY`, com no máximo 5 usuários por 24 h;
  - ~15 posts por criador por dia somando todos os apps;
  - UX obrigatória: nickname do criador, `creator_info`, privacidade **sem padrão**, toggles de comentário/dueto/stitch, divulgação de conteúdo comercial, pré-visualização e consentimento;
  - proibido marca d'água e copiar conteúdo de outras plataformas.
  - **Reconferido em 09/10/2026** [O] (`developers.tiktok.com/doc/content-posting-api-get-started`, atualizada em 04/08/2026): "All content posted by unaudited clients will be restricted to private viewing mode"; o cliente precisa passar por auditoria para sair disso. O limite de 5 contas a cada 24 horas e a conta privada na hora de publicar vieram só pelo trecho da busca nas páginas oficiais **[O, por trecho]**.
- **TikTok Shop** no Brasil desde mai/2025 [S].
- **LinkedIn Marketing** [O]:
  - Development: edição em até 5 contas; Community Management com 500 chamadas/dia;
  - Standard sob pedido;
  - recusa comum; prazo realista de 1–4 meses [S];
  - versões mensais `LinkedIn-Version: YYYYMM` (a 202510 sai em 15/10/2026).
- **Pinterest v5:** Trial (1.000 req/dia) × Standard [O]; MCP em alpha só para agências [S].
- **X:** pagamento por uso desde fev/2026, sem plano grátis; ~US$0,015 por post e **US$0,20 se tiver URL** [S].
- **Microsoft Ads:** developer token universal, sem auditoria pesada [O]. **Snapchat:** Marketing API + CAPI [O].
- **Kwai for Business:** **sem API pública confirmada**, só parceria [NC]. Relevante no interior e nas classes C/D.
- **Spotify Ads API v3** [O]. **Amazon Ads:** MCP com escrita em beta (02/02/2026) [S]. **Mercado Ads:** Product Ads no devsite do Mercado Livre [NC].

---

## 5. E-mail e SMS

*Verificado em 24/09/2026.*

| Provedor | Pontos-chave |
| --- | --- |
| Amazon SES | US$0,10 por mil; IP dedicado a partir de US$15/mês [O]; reputação e bounces por nossa conta |
| Resend | grátis até 3 mil/mês; Pro a partir de US$20 por 50 mil; domínios extras úteis para multi-tenant [O] |
| Twilio SMS BR | US$0,0599 por segmento [O] |
| Zenvia | SMS short code, WhatsApp, RCS; preço sob consulta [NC]; tende a entregar melhor no Brasil |

---

## 6. Regulatório no Brasil

*Verificado em 24/09/2026. Não é parecer jurídico.*

- **LGPD:**
  - **Base legal:** consentimento (arts. 7º I, 8º) para marketing a não-clientes; legítimo interesse (arts. 7º IX, 10 + Guia da ANPD de 2024) para clientes, sempre com opt-out fácil (art. 18).
  - **Hash SHA-256 é pseudonimização, não anonimização:** continua dado pessoal (arts. 12, 13 §4º).
  - **Papéis:** o cliente é controlador; o SaaS é **operador**, com contrato (art. 39).
  - **Dado sensível** (art. 11: saúde, religião, opinião política) não serve para segmentar.
  - **Transferência internacional** (provedores de IA e plataformas): arts. 33–36 + Res. CD/ANPD 19/2024, com cláusulas-padrão.
  - **Obrigações:** registro das operações (art. 37); encarregado (Res. 18/2024); incidente comunicado em 3 dias úteis (Res. 15/2024).
- **ECA Digital (Lei 15.211/2025):** veda perfilamento para publicidade a crianças e adolescentes (art. 22). **Em vigor desde 17/03/2026** [O] (art. 41-A, incluído pela Lei 15.352/2026). Detalhe em §6.1.
- **STF, art. 19 do Marco Civil (jun/2025):** presunção de responsabilidade das plataformas por anúncios pagos ilícitos [NC na tese] → revisão de anúncios mais rígida.
- **CONAR:**
  - identificar publicidade ("#publi");
  - anexos setoriais (bebidas, alimentos, medicamentos, apostas); o que vale para o texto de um anúncio de comida e bebida está na §6.2;
  - **IA na publicidade** *(reconferido em 04/10/2026)* [O]: o "Guia de Marketing e Publicidade por Influenciadores Digitais" de 2026 (aprovado pelo Conselho do Conteúdo do CONAR, em vigor desde 01/06/2026; conar.org.br/noticias/guia-de-marketing-e-publicidade-por-influenciadores-digitais) diz, no item 1.3.1, que o Código e o Guia "aplicam-se integralmente aos conteúdos publicitários, independentemente das tecnologias de produção e divulgação utilizadas", inclusive os "gerados, editados ou segmentados" com IA; anunciantes, agências e os demais da cadeia "permanecem responsáveis pelo seu resultado e pelo conteúdo divulgado" e devem adotar "medidas de diligência na utilização de cada ferramenta, com a compreensão de suas limitações técnicas e riscos de distorção"; o anúncio não pode trazer informação, apresentação visual ou sonora, simulação, endosso ou testemunho que induza o consumidor a erro. A nota 6 diz que o texto "não cuida de diretrizes ou deveres novos" sobre conteúdo gerado com IA, "não versando em particular sobre avisos (disclosure)": **o CONAR não criou dever de aviso de IA**. Substitui o "sem norma específica de IA encontrada" de 24/09/2026.
  - Setoriais: apostas (Lei 14.790/2023), médicos (Res. CFM 2.336/2023: proibido "melhor", "#1", "garantido", "cura", "100%"), advogados (Provimento OAB 205/2021), Anvisa, **CDC arts. 36–38** (publicidade enganosa ou abusiva; escassez falsa).
- **Eleitoral:**
  - Res. TSE 23.610/2019, alterada pela 23.732/2024: impulsionamento só por candidatos, partidos e coligações; identificação obrigatória; **proibição de deepfake e rótulo obrigatório de conteúdo feito com IA** [NC; site do TSE deu 403];
  - **o Google proíbe anúncio político-eleitoral no Brasil** [O];
  - a Meta exige autorização e "Pago por".
  - **Eleições 2026:** 1º turno em 04/10, 2º turno em 25/10. **Regra do produto: bloquear conteúdo político por padrão.** Atualizado em 25/09/2026: uso político **proibido** nos Termos (§6.1).
- **Políticas que derrubam contas:**
  - **Meta:** cloaking, atributos pessoais ("Você tem dívidas?"), promessas de saúde e antes/depois, enriquecimento rápido, apostas e cripto sem autorização, figura pública (golpe/deepfake), landing page ruim, falha de pagamento, conta nova com gasto alto.
  - **Google:** *misrepresentation* (mais comum), *circumventing systems*, pagamento suspeito, verificação de anunciante não concluída, saúde, apostas.

- **Peça feita com IA: autoria e uso** *(05/10/2026)*: a Lei 9.610/1998 diz, no art. 11, que "Autor é a pessoa física criadora de obra literária, artística ou científica", com a proteção estendida a pessoas jurídicas "nos casos previstos nesta Lei" (texto atualizado no portal da Câmara: www2.camara.leg.br/legin/fed/lei/1998/lei-9610-19-fevereiro-1998-365399-normaatualizada-pl.html; o site do Planalto não respondeu) [O]; daí a leitura de que a peça feita só pela máquina pode ficar sem proteção autoral no Brasil [S: interpretação, sem decisão conferida]. O PL 2338/2023 não é lei (§6.1). Os termos da OpenAI para empresas (Services Agreement, em vigor desde 01/01/2026: openai.com/policies/services-agreement) dizem que o cliente "owns all Output" e avisam que "Output may not be unique" [O]. **Regra do Liame:** a peça é da empresa para usar (Termos 9.3), sem promessa de exclusividade; a tela diz isso em "De onde veio" (proposta D-A4-33).

- **Cookies e identificadores de rastreio (ANPD)** *(Guia orientativo "Cookies e proteção de dados pessoais", v1.0, out/2022, ainda vigente; catálogo gov.br modificado em 23/01/2025; lido em 29/09/2026)* [O]:
  - vale também para "tecnologias similares de rastreamento" (cobre `_fbc`, `_gcl_*`);
  - **publicidade:** o legítimo interesse "dificilmente será" a base; **consentimento** é a mais apropriada;
  - **medição/analítica:** legítimo interesse possível em certos contextos (agregado, sem cruzar rastreios, sem perfil);
  - estritamente necessários: sem consentimento;
  - banner: "rejeitar todos" no 1º nível, desligados por padrão, nada de consentimento tácito nem botão único "aceito", revogação simples.
  - O guia **não trata** de `gclid`/`fbclid` guardado no servidor sem cookie [NC]: aplica-se por analogia. Para o cardápio do Regem (C3a): aviso de privacidade da loja; guardar o clique para medir a venda da própria loja (agregado no Liame) é medição; mandar à plataforma (A5) é publicidade → consentimento com prova (C3c).

### 6.1 Verificação para os documentos jurídicos (25/09/2026)

*Conferido nas fontes oficiais (download direto do Planalto, DOU e gov.br/anpd; o site do TSE deu 403 e a Res. 23.755/2026 foi lida no DJE-TSE). Uso: `docs/juridico/`. Não é parecer jurídico.*

- **ANPD virou "Agência Nacional de Proteção de Dados"**, autarquia especial (Lei 15.352, de 25/02/2026, conversão da MP 1.317/2025). A lei também reescreveu o art. 5º, VIII (encarregado indicado por controlador e operador). Os arts. 7, 9, 18, 33, 37, 39, 41, 42, 46 e 48 da LGPD não mudaram [O].
- **Direitos do titular (art. 18):** gratuitos; sem regulamento de prazo, vale o art. 19: **15 dias** para a declaração completa [O].
- **Operador (art. 42 §1º, I):** responde solidariamente quando descumpre a lei ou as instruções lícitas do controlador [O].
- **Pequeno porte (Res. CD/ANPD 2/2022):** perde o benefício quem faz tratamento de **alto risco** = pelo menos 1 critério geral (larga escala; afetar significativamente direitos) **e** 1 específico (**tecnologias emergentes ou inovadoras**; vigilância; decisões unicamente automatizadas, inclusive perfil de consumo; dados sensíveis ou de crianças, adolescentes e idosos). Dispensa de encarregado exige canal com o titular [O].
- **Incidente (Res. CD/ANPD 15/2024):** ANPD e titulares em **3 dias úteis** a partir do conhecimento; conteúdo mínimo de 12 incisos (inclui a identificação do operador); complemento em 20 dias úteis; **registro de todo incidente, mesmo os não comunicados, por no mínimo 5 anos**. A norma não fixa prazo do operador → vai no contrato [O].
- **Encarregado (Res. CD/ANPD 18/2024):** nome completo no site, em destaque (pessoa jurídica: nome empresarial + pessoa natural responsável); pode ser pessoa jurídica; substituto designado; para o operador, a indicação é facultativa [O].
- **Transferência internacional (Res. CD/ANPD 19/2024):** cláusulas-padrão só valem **integrais e sem alteração** (Anexo I, art. 16); prazo dos contratos antigos venceu em **23/08/2025**; o controlador **publica no site** uma seção sobre a transferência (país, forma, finalidade, direitos, canal; art. 17 §2º) e entrega a íntegra das cláusulas em 15 dias a quem pedir. O Anexo II tem a modalidade **operador → operador**. **UE adequada** pela Res. CD/ANPD 32, de 26/01/2026 (única decisão de adequação); **EUA sem adequação** [O].
- **Marco Civil, art. 15:** registros de acesso por **6 meses** (mínimo; prorrogável por ordem cautelar), sob sigilo [O] (antes [S] em §17.2).
- **CDC × B2B:** o STJ aplica o finalismo mitigado: a pessoa jurídica só é consumidora se provar vulnerabilidade (REsp 2.020.811). Decreto 7.962/2013: identificação (nome empresarial, CNPJ, endereços) em destaque, sumário do contrato, cancelamento pela mesma ferramenta. Código Civil: contrato empresarial presumido paritário (art. 421-A); em adesão, interpretação a favor do aderente e nulidade de renúncia antecipada (arts. 423 e 424) [O].
- **PL 2338/2023 (IA): não é lei.** Câmara, "Aguardando Parecer" em 02/09/2026 [O].
- **TSE, Res. 23.755, de 02/03/2026** (altera a 23.610/2019): conteúdo sintético na propaganda exige rótulo explícito com a tecnologia usada; **vedado** publicar ou impulsionar conteúdo sintético novo com candidato ou pessoa pública **72 h antes e 24 h depois** do pleito, mesmo rotulado; **provedor de sistema de IA não pode, mesmo a pedido, ranquear, recomendar ou priorizar candidatos nem indicar voto** (art. 28 §1º-C) [O]. Tese de 01/09/2026 sobre deepfake (exige realismo e caráter de propaganda) [S].
- **Meta, Platform Terms de 03/02/2026:** política de privacidade em URL pública informada no painel do app, dizendo **como pedir exclusão**; excluir dados quando não forem mais necessários ou a pedido; Data Deletion Request Callback **ou** Data Deletion Instructions URL; Tech Provider trata só sob instrução do cliente; avisar a Meta de incidente o mais rápido possível (§6.b.i) [O].
- **Google, User Data Policy:** `auth/adwords` é escopo **sensível** (desde 01/10/2020), com verificação OAuth; **Uso Limitado** vale para dados brutos e derivados: só funções visíveis ao usuário, **proibido transferir a plataformas de anúncio** ou usar para anúncios, remarketing e crédito; treino de modelo não personalizado listado como proibido na página do OAuth (a declaração expressa de não treinar só é exigida para Workspace). A frase de Uso Limitado é exemplo, não texto obrigatório; a política fica no domínio verificado, com link na página inicial [O]. `analytics.readonly` sensível [S].
- **WhatsApp, política de 23/09/2026:** opt-in obrigatório (por categoria é boa prática); **opt-out vale mesmo pedido fora do WhatsApp**; automação com caminho para humano; uso por partidos, candidatos e campanhas proibido. **§4.7 "AI Providers" suspenso no Brasil** por medida preventiva do CADE, mantida em 04/03/2026 [O].

### 6.2 O texto de um anúncio de comida e bebida (05/10/2026)

*Fontes: Código Brasileiro de Autorregulamentação Publicitária, do CONAR (edição 2025; arquivo publicado no site do CONAR em agosto de 2026, em conar.org.br/codigos?section=codigo), lido em 05/10/2026 [O]. Padrões de Publicidade da Meta, página "Alcohol" (transparency.meta.com/policies/ad-standards/restricted-goods-services/alcohol; a página mostra a data de 27/06/2024), lida em 05/10/2026 [O]. Uso: o Criativo (A4, X6 e X7) e a conferência de cada peça. Não é parecer jurídico.*

- **Apresentação verdadeira (art. 27):**
  - §1º: "todas as descrições, alegações e comparações que se relacionem com fatos ou dados objetivos devem ser comprobatórias, cabendo aos Anunciantes e Agências fornecer as comprovações, quando solicitadas";
  - §2º: o anúncio não leva o consumidor a engano "por implicação, omissão, exagero ou ambiguidade" quanto ao produto (natureza, procedência, composição e finalidade), ao anunciante ou aos concorrentes;
  - §3º: clareza sobre o "valor ou preço total a ser pago pelo produto, evitando comparações irrealistas ou exageradas com outros produtos ou outros preços: alegada a sua redução, o Anunciante deverá poder comprová-la mediante anúncio ou documento que evidencie o preço anterior", e sobre as "condições de entrega";
  - §4º: "grátis" (ou expressão de idêntico significado) só "quando não houver realmente nenhum custo para o Consumidor com relação ao prometido gratuitamente"; havendo frete, entrega ou outra despesa, "é indispensável que o Consumidor seja esclarecido";
  - §5º: "direto do fabricante", "preço de atacado", "sem entrada" e outras de igual teor só quando dá para comprovar;
  - §7º: o anúncio não se refere a pesquisa ou estatística "que não tenha fonte identificável e responsável".
- **Lojas e varejo (Anexo "F", item 2):** "Quando for mencionada redução de preços, deve o anúncio explicitar ambos os valores, ou seja, o antigo e o novo. Fica suprida esta exigência quando a redução for em números relativos (percentual) e não absolutos."
- **Comparação (art. 32):** aceita, com limites: objetiva, passível de comprovação, sem confusão entre produtos e marcas concorrentes e sem "depreciação à imagem do produto ou à marca de outra empresa".
- **Crianças (art. 37):** "nenhum anúncio dirigirá apelo imperativo de consumo diretamente à criança"; o anúncio não provoca "situações de constrangimento aos pais ou responsáveis" para impingir o consumo.
- **Alimentos, refrigerantes, sucos e bebidas assemelhadas (Anexo "H"):** o anúncio evita "qualquer associação a produtos fármaco-medicinais"; não encoraja "o consumo excessivo"; não menospreza "a importância da alimentação saudável, variada e balanceada"; limita as afirmações de saúde e nutrição às compatíveis com o licenciamento oficial e amparadas em opinião médica ou nutricional; apresenta "corretamente as características de sabor, tamanho, conteúdo/peso, benefícios nutricionais e de saúde"; evita explorar "a conquista de popularidade, elevação de status ou êxito social, sexual, desempenho escolar, esportivo"; com produto destinado à criança, abstém-se de "qualquer estímulo imperativo de compra ou consumo"; e leva a interpretação mais restritiva quando apregoa o atributo "produto natural".
- **Bebida alcoólica (Anexos "A", "P" e "T", com as Resoluções 01, 02 e 03 de 2008):**
  - regra geral (item 1 dos três anexos): são vedados "o apelo imperativo de consumo e a oferta exagerada de unidades do produto em qualquer peça de comunicação";
  - "Todo anúncio, qualquer que seja o meio empregado para sua veiculação, conterá 'cláusula de advertência'"; na internet, ela "integrará a mensagem publicitária, qualquer que seja a forma adotada". As frases das resoluções incluem "BEBA COM MODERAÇÃO", "ESTE PRODUTO É DESTINADO A ADULTOS" e "SE FOR DIRIGIR NÃO BEBA", e a lista não é fechada;
  - **bar e restaurante entram na regra:** "Sempre que mencionar produto cuja publicidade é regida por este Anexo, o anúncio assinado por atacadista, importador, distribuidor, estabelecimento varejista, bar, restaurante e assemelhado estará sujeito às normas aqui previstas" (Anexo "A", item 8; Anexos "P" e "T", item 7);
  - a mensagem é só para público adulto; quem aparece no anúncio "deverá ser e parecer maior de 25 anos de idade"; nenhuma cena que "apresente ou sugira a ingestão do produto"; a cerveja sem álcool segue o Anexo "P" no que couber;
  - o CONAR e os anunciantes adotam "a interpretação mais restritiva" (item 12).
- **Meta, anúncio de bebida alcoólica** [O]: "Ads that promote or reference alcohol must comply with all applicable local laws, required or established industry codes, guidelines, licenses and approvals, and include age and country targeting criteria consistent with Meta's targeting requirements and applicable local laws"; "At a minimum, ads may not be targeted to people under 18 years of age". O Brasil não aparece na página, nem entre os países com idade maior nem entre aqueles em que o anúncio é proibido: vale o mínimo de 18 anos e o código do setor, que aqui é o do CONAR.
- **Regras do Liame que saem daqui (X6):**
  - o preço, o percentual e o "grátis" de uma peça são só os que a oferta de Minha marca escreve (o "grátis" vale também quando o dossiê diz); redução de preço só com o preço antigo e o novo da oferta, juntos; a condição da oferta (o dia, o horário, onde vale) acompanha o preço;
  - prova só a do dossiê; nada de superioridade, de comparação nem de concorrente; nada de saúde, de consumo exagerado nem de sucesso ligado ao produto; a peça fala com o adulto, nunca com a criança;
  - **o Criativo não escreve anúncio que cita bebida alcoólica nesta fase:** a cláusula de advertência é obrigatória também para bar e restaurante, e a regra geral proíbe o apelo imperativo de consumo e a oferta exagerada de unidades (o "chope em dobro" e o balde esbarram nela). Quando esse anúncio entrar, entra com a cláusula posta pelo código e regra própria de texto (decisão proposta D-A4-34, `plano-a4.md` §4);
  - **não conferido** [NC]: a legislação específica de bebida alcoólica (a Lei 9.294/1996 e o que a regulamenta), o que os Padrões de Publicidade da Meta dizem de alegação de saúde em anúncio de alimento, e os anexos do CONAR para os outros ramos (o Liame começa por bares e restaurantes).

---

## 7. Regras de decisão de marketing (priors)

*Fonte: skills de marketing instaladas (MIT, Corey Haines) em `~/.claude/skills/`. Verificado em 24/09/2026.* **São priors, não leis:** números em USD e com viés B2B SaaS. Recalibrar por conta nos primeiros 30 dias. No produto, viram **Policy Templates** versionados (fonte, confiança, `applicable_when`, `review_at`, override).

### 7.1 Meta

- **Âncora:** o sistema foi desenhado para leads B2B (TCPL). Para PME e e-commerce, usar CPA ou ROAS de breakeven como âncora.
- **Teto de anúncios ativos** = (verba diária × 14) ÷ (2 × CPA-alvo). No teto, teste novo só entra se outro sair.
- **Estrutura:** 80% da verba em escala (só anúncios graduados) + 20% em teste (verba protegida). Validar em estático antes de vídeo.
- **Entrega no D7:** gasto mínimo esperado = (verba ÷ anúncios) × 7 × 0,5. Abaixo disso, ou gasto zero → matar.
- **Gate de dados:** não julgar antes de gastar **3× o CPA-alvo** (a 2× há 13% de falso negativo).
- **Graduar:** ≥ 5 conversões qualificadas, taxa de qualificação ≥ 60%, custo ≤ alvo, ≥ 14 dias no ar, ≥ 1 conversão nos últimos 7 dias.
- **Fadiga** (seguro / alerta / crítico):
  - prospecção: frequência 1–2,5 / 2,5–4 / > 4;
  - retargeting: 2–4 / 4–6 / > 6;
  - outros sinais: CTR −20% em 7 dias, CPM +30% em 2 semanas.
- **Nunca editar o criativo de um anúncio performando** (reseta o aprendizado); pausar não reseta. Nunca pausar sem substituto (2–3 prontos).
- **Escala:** +20% a cada 5 dias; nunca +30% de uma vez. Rollback: custo > 1,5× alvo → cortar 20–30%, estabilizar 2 semanas, retomar a +10% por semana.
- **Advantage+:** só com ~50 conversões por semana no evento otimizado.
- **Produção de criativos:** testes por mês ≈ (verba mensal × 0,2) ÷ (3 × CPA). Taxa de vitória ~1 em 6. Prioridade de iteração: hook > visual > formato > copy/CTA.
- **Calendário:** segunda decide, quarta lança, sexta escala.

### 7.2 Google Search

- **Escada de intenção:** marca → alta intenção sem marca → concorrente → consciente do problema → demand gen.
- **Estrutura e configuração:**
  - grupos de 5–15 palavras-chave, com 2–3 RSAs cada;
  - consolidar o que tem < 15–30 conversões/mês;
  - desligar Search Partners e Display.
- **Lances:**
  - 0–15 conversões/mês: CPC manual ou Max Conversões;
  - 15–30: Max Conversões;
  - 30+ estáveis: tCPA;
  - com valores de receita: tROAS.
  - Mudar em passos de ±10–15% e esperar 1–2 semanas.
- **Broad match** só com 30+ conversões/mês, smart bidding e negativas enxutas.
- **Termos de busca (semanal):** 3+ cliques e 0 conversão → negativar os irrelevantes; nunca negativar com base em 1 clique.
- **PMax:** nunca como primeira campanha; excluir a marca; importar conversões offline antes de escalar.
- **RSA:** 15 headlines de ≤ 30 caracteres; 4 descrições de ≤ 90; 2 paths de ≤ 15; ≥ 4 sitelinks; ≥ 4 callouts de ≤ 25.

### 7.3 Criativo e formatos

- **Meta:** texto principal de até 125 caracteres e título de até 27 (Feed do Facebook) ou 40 (Feed do Instagram), pelo guia de anúncios oficial (§2.1, 05/10/2026). O "125 visíveis; headline 40; descrição 30" das skills fica como prior: a "descrição 30" não aparece no guia [NC].
- **TikTok:** 80 caracteres recomendados (máx. 100).
- **LinkedIn:** intro de 150 (máx. 600).
- **Vídeo de 15–30 s:** hook em 0–3 s; legendas sempre; texto na imagem < 20%.
- **Não julgar** antes de 1.000+ impressões. Hierarquia de teste: conceito > hook > visual > corpo > CTA.
- **Banner:** conteúdo crítico nos 70–80% centrais; 1 CTA com ≥ 44 px; ≤ 2 fontes; contraste 4,5:1.
- **Grounding:** nenhuma estatística ou depoimento sem fonte. Sem insumos, parar e pedir.

### 7.4 Públicos e rastreamento

- **Tamanho mínimo:** Meta e TikTok 100 mil; LinkedIn 50 mil. Lookalike com seed ≥ 100 (ideal 1.000+). Match de lista: 30–70%.
- **Retargeting:** quente 1–7 dias; morno 7–30; frio 30–90. Excluir clientes e convertidos recentes.
- **Rastreamento:** dedup por `event_id`; EMQ > 6; AEM com top 8 eventos. Server-side recomendado sempre e obrigatório acima de US$5 mil/mês.

### 7.5 Experimentos

- 95% de significância, 80% de poder.
- **Amostra por variante:**

  | Baseline | Lift de 10% | Lift de 20% | Lift de 50% |
| --- | --- | --- | --- |
  | 1% | 150 mil | 39 mil | 6 mil |
  | 5% | 27 mil | 7 mil | 1,2 mil |
  | 10% | 12 mil | 3 mil | 550 |

- **Duração:** mínimo 1 semana, máximo 4–8. Não espiar antes da amostra.
- **ICE** = (Impacto + Confiança + Facilidade) ÷ 3.

### 7.6 Mensageria (base para WhatsApp: as skills não cobrem WhatsApp)

- **Horário silencioso:** 9h–20h no fuso do destinatário. Honrar opt-out na hora.
- **Carrinho abandonado:** 30 min / 4 h / 24 h, sem desconto na 1ª mensagem.
- **Win-back:** 60–90 dias após a última compra, depois +14 e +14 dias.
- **Promoção:** 1–2 envios.
- **Benchmarks SMS:** opt-out < 2% (promocional < 0,5%); CTR 8–15%; conversão 1–5%. Primeiro nome na mensagem: CTR +~20%.
- **Registro de consentimento:** data e hora, IP, URL e texto exato exibido.
- **E-mail:**
  - boas-vindas: 5–7 e-mails em 12–14 dias;
  - reengajamento: 3–4 e-mails em 2 semanas, após 30–60 dias de inatividade;
  - assunto com 40–60 caracteres;
  - bounces ou reclamações subindo → pausar.

### 7.7 Planejamento e orçamento

- **Orçamento por % da receita:** 5% (conservador), 15–25% (crescimento), até 40% (agressivo).
- **CAC blended** inclui salários, ferramentas e agência.
- **Kill criteria:** canal com CAC > 2× o alvo após 30 dias → pausar.
- **Rotinas:**
  - fadiga a cada 2–3 dias;
  - anomalias diárias;
  - termos de busca e QA de tracking semanais;
  - revisão semanal na segunda às 9h;
  - refresh de conteúdo mensal.
- **Onde as skills falham:** WhatsApp, LGPD, CONAR/CDC/Anvisa, TikTok (raso) e benchmarks em reais. Tudo isso é responsabilidade desta base.

---

## 8. Padrões técnicos

*Verificado em 24/09/2026.*

### 8.1 MCP

- **Versão atual 2026-07-28** [O]:
  - **sem estado**: sem `initialize` e sem `Mcp-Session-Id`; versão e capacidades em `_meta`;
  - `server/discover` obrigatório;
  - **MRTR** (`input_required` → `inputResponses`) substitui pedidos iniciados pelo servidor;
  - cabeçalhos `Mcp-Method`/`Mcp-Name` validados contra o corpo (erro `-32020`);
  - `ttlMs`/`cacheScope` nas listagens;
  - `traceparent` em `_meta`;
  - **DCR deprecado → CIMD**;
  - Tasks e MCP Apps como extensões;
  - deprecados: Roots, Sampling, Logging e HTTP+SSE.
- **Autorização** [O]:
  - o servidor é OAuth 2.1 Resource Server com PRM (RFC 9728);
  - o cliente usa `resource` (RFC 8707) e o servidor valida a **audience**;
  - validação de `iss` (RFC 9207);
  - **token passthrough proibido**;
  - step-up com todos os escopos num desafio;
  - credencial de terceiro só por **elicitation em modo URL**;
  - EMA (ID-JAG) estável; client credentials em draft.
- **Ferramentas:**
  - nomes com 1–128 caracteres `[A-Za-z0-9_.-]`, mas **a API do Claude não aceita ponto** → snake_case com até 64 caracteres;
  - `outputSchema` + `structuredContent`;
  - `tools/list` pode variar por autorização;
  - annotations **não são controle de segurança**;
  - a escolha da ferramenta degrada acima de 30–50 ferramentas → busca de ferramentas.
- **SDK TypeScript v2:** `@modelcontextprotocol/server` 2.1.0 (a v1 está em 1.30.1); `@rekog/mcp-nest` 2.0.7 com suporte a Nest 12. **Registry oficial em preview**, sem servidores privados.
- **No fio, 2026-07-28** [O] *(medido em 02/10/2026 com `@modelcontextprotocol/client` 2.3.0 contra o servidor do RegemCast, `@modelcontextprotocol/server` 2.3.0)*:
  - cada chamada é um `POST` com um pedido JSON-RPC; a resposta vem em `application/json`, sem sessão;
  - cabeçalhos `Mcp-Method` (e `Mcp-Name` em `tools/call`) e `MCP-Protocol-Version: 2026-07-28`; `Accept: application/json, text/event-stream`;
  - `params._meta` com `io.modelcontextprotocol/protocolVersion`, `io.modelcontextprotocol/clientInfo` e `io.modelcontextprotocol/clientCapabilities`;
  - o SDK cliente manda um `server/discover` antes da primeira chamada; o resultado da ferramenta traz `resultType: "complete"` e `_meta` com `io.modelcontextprotocol/serverInfo`;
  - cliente sem negociar versão (padrão do SDK) cai na geração 2025: `initialize`, `notifications/initialized` e resposta em SSE de uma mensagem — o servidor sem estado do RegemCast atende os dois.
- **Governança:** MCP doado à Agentic AI Foundation (Linux Foundation) em 09/12/2025.
- **MCPs remotos gerenciados pelo Google Cloud** *(verificado em 30/09/2026, docs.cloud.google.com/mcp/release-notes)* [O]: GA em 01/05/2026; spec 2026-07-28 desde 14/09; autenticação IAM (Cloud) ou OAuth (Workspace). O catálogo **não inclui** Google Ads, Analytics, Search Console, Business Profile nem YouTube. **Merchant API MCP** em alpha (`merchantapi.googleapis.com/mcp`, 14 ferramentas, quase só leitura, divide a cota da Merchant API). A **Data Manager API** não tem MCP, só "agent skills".
- **MCP das plataformas × objetivos do Liame** *(análise de 30/09/2026)*:
  - **não acelera a integração:** por baixo é a mesma API, com as mesmas aprovações (Meta: App Review, e o MCP ainda soma `ads_mcp_management`; Google: nível de acesso do projeto + verificação OAuth); os fornecedores de SaaS com MCP (Supermetrics, Windsor, Pipeboard) rodam sobre os próprios apps aprovados [S];
  - **não serve à sincronização agendada** (Resultados, atribuição, alertas): a spec mira aplicações de LLM e pede consentimento do usuário para cada ferramenta; o MCP da Meta não mostra `url_tags` nem relatórios assíncronos; o do Google só tem uma `search` genérica; cada resultado passa pelo contexto do modelo e custa token (anthropic.com/engineering/code-execution-with-mcp: 150 mil → 2 mil tokens com execução de código) [S];
  - **pode servir à LIA no futuro**, como fonte de ferramentas, desde que passe pelo Tool Registry e pelo Action Service (ADR-007/008), com App Review próprio para a escrita da Meta; o MCP do Google Ads, só leitura e sem versão hospedada, não acrescenta ao conector;
  - **risco:** injeção de instruções pelo conteúdo que a ferramenta devolve (OWASP MCP Top 10: MCP03 Tool Poisoning, MCP06 Prompt Injection, MCP10 Over-Sharing) [S] — texto de terceiro sempre como `UNTRUSTED_CONTENT`.

### 8.2 Protocolos de API

- **OpenAPI:** 3.2.x existe (3.2.1 em 10/09/2026); **3.1 é o piso seguro** para ferramentas.
- **AsyncAPI 3.1** · **CloudEvents 1.0.2**.
- **Standard Webhooks:** `webhook-id`, `webhook-timestamp`, `webhook-signature`; HMAC-SHA256.
- **Idempotency-Key** (draft expirado, prática consolidada: Stripe).
- **RateLimit headers** (draft-11) · **RFC 9457** · **OAuth 2.1** (draft-16).
- **RAR** (RFC 9396), para autorizar uma transação específica · **CIBA**, para aprovação fora de banda · **Token Exchange** (RFC 8693).
- **A2A 1.0.0** (Linux Foundation) serve para agente ↔ agente. **AG-UI** serve para agente ↔ interface.

### 8.3 Segurança de agentes

- **OWASP LLM Top 10 (2025):** LLM01 Prompt Injection · LLM06 Excessive Agency · LLM10 Unbounded Consumption.
- **OWASP Agentic Top 10 (2026):** ASI01 Goal Hijack · ASI02 Tool Misuse · ASI03 Privilege Abuse · ASI06 Memory Poisoning · ASI09 Human-Agent Trust Exploitation.
- **OWASP MCP Top 10:** Tool Poisoning · Prompt Injection via Contextual Payloads · Shadow MCP · Falta de auditoria.
- **"Lethal trifecta"** (Willison): dados privados + conteúdo não confiável + canal de saída = exfiltração possível. É o caso do Liame lendo comentários → **leitor em quarentena**.
- **Gateways MCP de referência:**
  - AWS AgentCore (Policy em Cedar, com orçamento acumulado);
  - Kong (ACL por ferramenta);
  - Cloudflare (Code Mode, shadow MCP);
  - agentgateway (AAIF, RBAC em CEL).

---

## 9. Stack verificada

*Verificado em 24/09/2026 via `npm view` e `nodejs.org/dist/index.json`.* Decisão final no ADR-001.

| Item | Versão | Nota |
| --- | --- | --- |
| Node.js | **24.21.0 (LTS "Krypton")** | 26.x ainda Current; 22.x em manutenção |
| NestJS | 12.1.0 | Node ≥ 20; `@nestjs/cli` 12.0.6 depende de **`typescript ~6.0.2`** |
| TypeScript | **6.0.3** | A 7.0.2 existe, mas o Nest CLI ainda não usa |
| Next.js | 16.3.8 | Node ≥ 20.9 |
| React | 19.3.0 | — |
| Tailwind CSS | 4.3.3 | configuração CSS-first |
| Drizzle ORM | 0.45.3 (estável) | 1.0 em **RC.5**: não usar em produção ainda |
| pg · pg-boss | 8.23.0 · 12.34.0 | pg-boss exige Node ≥ 22.12 |
| Zod · Standard Schema | 4.6.5 · 1.1.0 | — |
| MCP SDK | `@modelcontextprotocol/server` 2.1.0 | v2 |
| SDKs de IA | `@anthropic-ai/sdk` 0.128.0 · `openai` 7.23.0 · `@openai/agents` 0.18.0 · `ai` (Vercel) 7.0.113 · `@google/genai` 2.24.0 | — |
| OpenTelemetry | `@opentelemetry/sdk-node` 0.222.0 | — |
| Monorepo | pnpm 12.6.0 · turbo 2.11.3 · vitest 5.0.1 | — |
| Auth | `oidc-provider` 9.12.2 · `jose` 6.2.12 | — |

---

## 10. Modelos de IA

*Reconferido em 02/10/2026 nas páginas oficiais da Anthropic (`platform.claude.com/docs`: models/overview, about-claude/pricing, manage-claude/data-residency; `privacy.claude.com`). Substitui a tabela de 24/06/2026.* O produto é provider-agnostic: **escolher por eval, custo e latência por tarefa**.

| Modelo atual (Anthropic) | Id na API | Entrada / saída por milhão de tokens | Leitura do cache | Contexto · saída máx. | Para que a Anthropic indica |
| --- | --- | --- | --- | --- | --- |
| Fable 5.1 | `claude-fable-5-1` | US$10 / US$50 | 0,025× | 1M · 128 mil | raciocínio exigente e trabalho longo de agente |
| Opus 5.5 | `claude-opus-5-5` | US$4 / US$20 | 0,05× | 1M · 128 mil | "comece por ele na maioria dos casos" |
| Sonnet 5.5 | `claude-sonnet-5-5` | US$2 / US$10 | 0,1× | 1M · 128 mil | melhor combinação de velocidade e inteligência |
| Haiku 4.5 | `claude-haiku-4-5-20251001` | US$1 / US$5 | 0,1× | 200 mil · 64 mil | o mais rápido |

- **Legados ainda disponíveis** (não usar em rota nova): Fable 5, Opus 5, Opus 4.8/4.7/4.6/4.5, Sonnet 5, Sonnet 4.6 [O].
- **Aposentadoria** (compromisso da Anthropic): Fable 5.1 não antes de 01/09/2027; Opus 5.5, de 22/09/2027; Sonnet 5.5, de 28/09/2027; **Haiku 4.5, não antes de 15/10/2026** [O]. Consequência: não fixar a rota econômica no Haiku 4.5 sem acompanhar o aviso de aposentadoria (a página `model-deprecations` está no Vigia de integrações desde a I1, migration 0028).
- **Cache de prompt, conferido em 04/10/2026** *(platform.claude.com/docs/en/build-with-claude/prompt-caching e chamadas de verdade)*: o campo `cache_control` no pedido liga o **cache automático**, com o ponto no último bloco, que anda com a conversa (cada pedido escreve até o fim e relê o que já estava escrito); dá para somar pontos explícitos (até 4 no total, e o automático ocupa um). A ordem do prefixo é ferramentas, sistema, mensagens. Tamanho mínimo: **512 tokens** no Sonnet 5.5, no Opus 5.5 e no Fable 5.1; 4.096 no Haiku 4.5; abaixo disso o pedido passa sem cache e sem erro. O prazo de 5 minutos é renovado a cada leitura. O cache é separado por workspace. Em pedidos simultâneos, a entrada do cache só existe depois que a primeira resposta começa. No uso, `input_tokens` é só o que veio depois do último ponto; o total é lido + escrito + entrada [O]. **Medido:** com um ponto só no fim, outra pergunta com as mesmas ferramentas e instruções **não** relê nada (o ponto ficou depois da pergunta); com um ponto também no fim das instruções, relê as ferramentas e as instruções, inclusive com outro contexto depois (outra empresa) [testado]. No adapter do AI SDK: `providerOptions.anthropic.cacheControl` no pedido (o automático) e `providerOptions` na mensagem de sistema (o explícito); `instructions` aceita uma lista de mensagens de sistema [testado].
- **Cache de prompt (preços):** escrita a 1,25× (5 min) ou 2× (1 h); leitura a 0,1× da entrada (0,05× no Opus 5.5 e 0,025× no Fable 5.1). Prefixo estável primeiro (dossiê estruturado em ordem fixa) [O].
- **Lote (Batch API):** 50% mais barato na entrada e na saída; acumula com o cache [O]. Serve aos relatórios noturnos.
- **Contexto de 1M** no preço normal nos modelos 4.6 em diante [O].
- **Tokenizer novo** (modelos 4.7 em diante): cerca de **30% mais tokens** para o mesmo texto [O]. Estimativa de custo feita com a contagem antiga sai baixa.
- **Pensamento:** adaptativo e sempre ligado no Fable 5.1 e no Opus 5.5; adaptativo no Sonnet 5.5; o Haiku 4.5 usa o modo antigo (`budget_tokens`). Parâmetro `effort` (padrão `high` no Fable 5.1 e no Sonnet 5.5, `medium` no Opus 5.5; o Haiku 4.5 não aceita) [O].
- **`tool_choice` forçado:** a tabela de preços não traz a coluna "any, tool" para o Opus 5.5 e o Sonnet 5.5 [O]; usar `auto` + saída estruturada. **Conferido em 04/10/2026** com o Sonnet 5.5, pelo adapter do AI SDK: ferramentas em `auto` e a resposta final no schema, na mesma conversa, funcionam (os evals da Conversa e do Estrategista rodaram assim) [testado].
- **Ferramentas do servidor:** busca na web a US$10 por mil buscas; leitura de página (web fetch) sem custo além dos tokens [O]. A A3 não usa busca aberta (D-A3-8).
- **Onde roda:** `inference_geo` aceita `"global"` (padrão: qualquer região disponível) ou `"us"` (só Estados Unidos, **preço × 1,1**), nos modelos 4.6 em diante; o Haiku 4.5 não aceita o parâmetro. Guarda em repouso (workspace geo): só `"us"`. **Não há região no Brasil nem na América do Sul** [O].
  - **Conferido em chamada de verdade (04/10/2026):** o pedido com `inference_geo` ao Haiku 4.5 volta **400**, com a mensagem `'claude-haiku-4-5-20251001' does not support inference_geo.`; o mesmo pedido sem a opção passa. A página de residência de dados diz o mesmo do Opus 4.5 e do Sonnet 4.5: "supported on Claude 4.6 and later models" [O, testado]. O Sonnet 5.5 e o Opus 5.5 aceitam `us` junto com `effort` e com a saída estruturada [testado]. Modelo anterior ao 4.6 roda no padrão do fornecedor (qualquer região) e sem o acréscimo de 10%.
  - **No código:** `aceitaGeo` em `apps/server/src/ai/modelos.ts` lê a versão no id do modelo. Com `AI_INFERENCE_GEO=us` (D-A3-13), o gateway **não chama** o modelo que não aceita a opção: a tentativa fica em `ai_usage` com o erro `fora_da_regiao`, sem custo, e a rota segue para a reserva. Assim a frase dos documentos ("Estados Unidos") continua verdadeira mesmo que alguém publique uma rota com um modelo antigo.
  - **Tamanho dos pedidos, medido nos evals de 04/10/2026 (Sonnet 5.5):** o Explicar gasta perto de 3 mil tokens de entrada e 600 de saída por explicação; o revisor do Compliance, 2 mil de entrada e quase nada de saída; a leitura de uma página, 1,4 mil e 130; a Conversa, perto de **10 mil de entrada por rodada do laço** (o prompt, as nove ferramentas e o formato da resposta), com uma rodada a mais a cada leitura: de 10 mil (sem leitura) a 32 mil (duas leituras em rodadas separadas) por resposta; o plano do Estrategista, 17 mil de entrada e 1,3 mil de saída. O cache de prompt foi ligado no gateway no mesmo dia, só no laço com ferramentas: a rodada de evals da Conversa caiu 67% (US$ 1,12 → US$ 0,36) e a do Estrategista, 49% (US$ 0,73 → US$ 0,37), com a mesma nota [testado].
  - **Tokenizer, medido no mesmo dia:** o mesmo pedido curto deu 43 tokens de entrada no Haiku 4.5 e 55 no Sonnet 5.5 e no Opus 5.5 (28% a mais); com o schema da leitura do Pesquisador, 464 contra 551 (19% a mais) [testado].
- **Dados (produtos comerciais e API):** por padrão a Anthropic **não treina** com entradas e saídas; apaga entradas e saídas em **até 30 dias**; guarda zero só por acordo próprio; conteúdo marcado como violação de política fica até 2 anos (e a nota de segurança, até 7); avaliação enviada com "gostei/não gostei" fica 5 anos e pode ser usada em treino, então **não enviar avaliação pela API** [O].
- **Custo real:** existe a API de administração de uso e custo (`usage-cost-api`) para a reconciliação mensal (A3-2) [O, não testada].
- Preços de OpenAI e Google: [pendente de pesquisa; só quando uma finalidade pedir].

### 10.1 Câmbio de referência (PTAX do Banco Central)

*Conferido em 03/10/2026 no portal de dados abertos do Banco Central e chamando o serviço.* Serve à D-A3-14: o custo de IA é medido e limitado em dólar; a tela mostra o valor aproximado em reais, com a data da cotação.

- **Conjunto de dados** **[O]** (`dadosabertos.bcb.gov.br`, "Dólar comercial (venda e compra) - cotações diárias"; autor: Banco Central do Brasil, Departamento das Reservas Internacionais; fonte: Sistema Ptax):
  - atualização **diária**; série desde 28/11/1984;
  - licença **Open Data Commons Open Database License (ODbL)**: uso livre com a fonte citada (a tela diz "PTAX de venda do Banco Central" e o dia do boletim);
  - desde 01/07/2011 a PTAX é a média aritmética das taxas de quatro consultas diárias aos dealers de câmbio.
- **Serviço** (medido em 03/10/2026): `https://olinda.bcb.gov.br/olinda/servico/PTAX/versao/v1/odata/`, sem credencial e sem cadastro, com dois recursos:
  - `CotacaoDolarDia(dataCotacao=@dataCotacao)` e `CotacaoDolarPeriodo(dataInicial=@dataInicial,dataFinalCotacao=@dataFinalCotacao)`;
  - as datas vão entre aspas simples, no formato **`'MM-DD-AAAA'`**; `$format=json` e `$select` funcionam;
  - resposta: `{ "value": [ { "cotacaoCompra", "cotacaoVenda", "dataHoraCotacao" } ] }`; os valores são números em reais por dólar, com quatro casas (o JSON traz um zero a mais: `5.22380`), e `dataHoraCotacao` vem como `"AAAA-MM-DD HH:MM:SS.ffffff"`, no horário de Brasília;
  - **um boletim por dia útil** (o de fechamento), pouco depois das 13h de Brasília (13:03 a 13:11 nos cinco dias medidos);
  - **fim de semana e feriado não têm boletim:** a consulta devolve `"value": []`, que é resposta válida (medido no sábado 03/10/2026).
- **Medido** (venda): 28/09/2026 = 5,2132; 29/09 = 5,2204; 30/09 = 5,1809; 01/10 = 5,2079; 02/10 = 5,2238 (compra de 02/10: 5,2232).
- **Consequência para o código** (`apps/server/src/cambio/ptax.ts`, `worker/cambio.service.ts`, migration 0041):
  - endereço fixo no código (não há destino configurável), sem seguir redirecionamento, prazo de 15 s e resposta de até 64 KB;
  - a resposta é conferida antes de virar cotação (número entre 0,5 e 100; data no formato);
  - a rotina pede os últimos 10 dias, duas vezes por dia (13:40 e 18:40 de Brasília), guarda uma cotação por dia útil e não altera a que já guardou;
  - o pedido leva só o período de datas; a conta dólar → real é feita em inteiros.

### 10.2 Console da Anthropic: workspaces, chaves e limites

*Conferido em 03/10/2026 na documentação oficial (`platform.claude.com/docs/en/manage-claude/workspaces`), antes de o dono criar a chave de produção.* **[O]**

- Toda organização tem um **Default Workspace**, que não pode ser renomeado, arquivado nem apagado, e **não aceita limites**.
- **Criar:** no Console, **Settings > Workspaces** (`platform.claude.com/settings/workspaces`), **Create workspace**, nome e cor, **Create**. Só administrador da organização cria. Até 100 workspaces por organização. A troca de workspace é pelo seletor **Workspaces**, no canto superior esquerdo.
- **Limites por workspace**, em duas abas das configurações dele: **Spend limits** (teto de gasto por mês e alertas por faixa) e **Rate limits** (por faixa de modelo: pedidos por minuto, tokens de entrada, tokens de saída). Só podem ser **menores** que os da organização; sem valor, valem os da organização; os da organização valem sempre.
- **Chaves:** todo pedido roda em exatamente um workspace. Tipos: chave de workspace (legada, sem dono), chave pessoal e chave de conta de serviço; a de um workspace só sempre roda nele. A resposta da API traz o cabeçalho `anthropic-workspace-id` (`wrkspc_…`).
- **Arquivar** um workspace arquiva todas as chaves dele em segundos e **não se desfaz**.
- **Workspace "Claude Code":** criado sozinho quando alguém da organização entra no Claude Code com a conta do Console; não aceita chave criada à mão.
- **Uso e custo por workspace:** a API de uso e custo agrupa por `workspace_id` (o Default aparece como `null`).
- **Consequência para o Liame:** um workspace de produção com teto mensal próprio (com recarga automática ligada na organização, quem segura o gasto é o teto do workspace) e a chave só nele, guardada no EasyPanel (`liame-api` e `liame-worker`); outra chave, em outro workspace, para os evals locais. O teto por empresa segue sendo o do Liame (`ai_budget`, D-A3-3).

---

## 11. Ecossistema DMS

*Verificado no código em 24/09/2026 (a `origin/main` é a fonte da verdade no Regem); RegemCast atualizado em 02/10/2026.*

- **Só o RegemCast tem servidor MCP** (desde 02/10/2026, decisão do dono; emendas da ADR-008 e da ADR-019).
- **Regem:**
  - tem clientes (com `opt_out_marketing`; `consentimento_lgpd` é boolean **sem prova**), pedidos (`pedido_externo`), cupons, fidelidade, cashback, produtos (**preço de custo, promo, destaque**), funil do cardápio (`cardapio_evento`), `dia_especial`;
  - **não tem** UTM/pixel, data de nascimento, evento de saída genérico, telefone único em E.164 (grava com e sem o 55);
  - segmento desconhecido dispara para a base inteira.
  - O **token de integração por loja** (mig 192, `LojaTokenGuard`, `X-Loja-Token`) **não está no git**: só a declaração no `schema.ts`.
  - As tabelas `api_client` e `webhook_subscription` (mig 002) estão sem uso.
- **RegemCast:**
  - guard global fail-closed; RLS desde o dia 1 (`app.conta_id`, role sem `bypassrls`): **molde do Liame**;
  - **porta MCP desde 02/10/2026** [O]: `POST https://castapi.dmsregem.com/api/v1/mcp`, token de integração por conta (`rct_it_…`, hash sha-256, escopos, classe `dms` ou `externo`, revogável, 120 chamadas por minuto); ferramentas de leitura (conta, campanhas com custo na Meta, públicos, modelos, orçamento), conversas abertas por anúncio (com o telefone, sem conteúdo; só guardadas com aplicativo conectado, por 180 dias), rascunho de modelo e de campanha (`chaveIdempotencia` obrigatória) e disparo em dois passos só para produto da DMS; autor `integracao` na auditoria (`integracao_situacao` com o id e o fuso da conta, e `integracao_revogar` para o próprio token se desligar; repo `regemcast`, `docs/mcp.md`, PRs #110 a #116);
  - **sem webhook de saída**; desde 01/10/2026 o envio monta cabeçalho de mídia, botões, LTO e carrossel (#96);
  - worker `@Interval(5000)` + `FOR UPDATE SKIP LOCKED`; BullMQ declarado e não usado;
  - importação de até 5.000 contatos por lote com `consentimento: true`; até 500 destinatários diretos por campanha;
  - reconcilia status por `wamid`; opt-out automático por botão ou texto.
- **GoGeM:** o **Open Delivery** (OAuth `client_credentials`, escopos, eventos com ack) é o melhor molde de autenticação de serviço da casa. O pedido do totem não tem telefone.
- **RegeMBoard:** sem API de serviço. **Orzuni:** guard não confere escopos; tenant fixo. **Farol:** sem API. **MuralJob:** sem API key.
- **Decisão de 09/09/2026:** clientes de iFood e 99 **não** entram em marketing.
- **Infra padrão:**
  - Hostinger + EasyPanel (Docker), Cloudflare (DNS/WAF), Supabase, OSRM do Sudeste self-hosted;
  - **Meta Tech Provider** com 2 apps de WhatsApp; portfólio verificado da SISTER TECNOLOGIA.

---

## 12. Histórico e fontes

| Data | Atualização |
| --- | --- |
| 09/10/2026 | §2.2, §3.3 e §4: **reconferência para o plano da A6** (`plano-a6.md`), nas páginas oficiais: publicar no Instagram (só JPEG, 100 posts por 24 horas, a mídia num endereço que a Meta consiga buscar na hora) e no Threads (post só de texto existe; dois passos); o acesso à API do Perfil da Empresa no Google (perfil verificado há 60 dias ou mais e com site; cota zero até a aprovação; a página não diz o prazo) e as novidades de 2026 nas avaliações; os limites do Search Console, agora por fonte oficial; e o TikTok sem auditoria, que só publica em privado. Fica [NC] se a Meta aceita buscar a imagem num endereço assinado de curta duração. |
| 08/10/2026 | §16.1: **a mensagem para aprovar**, pesquisada antes do protótipo P15 (Mensagens): a aprovação por seção do Braze (e a mudança que zera a aprovação), os destinatários esperados e os pulados por motivo do Klaviyo, o preço por mensagem entregue do WhatsApp (marketing é cobrado mesmo na janela de atendimento, e não tem desconto por volume) e o que o RegemCast já devolve (quem pode receber, quem está em descanso, o custo como teto). Fica [NC] a data de vigência e o valor da tabela de preços no Brasil. |
| 08/10/2026 | §3.1: **reconferência para a A5 · Y2** (a escrita no Google Ads), nos arquivos da API no repositório oficial e nas páginas de REST, cota e limites: as rotas `campaigns:mutate` e `campaignBudgets:mutate`, o `validate_only` (só devolve erros), a máscara em snake_case com o corpo em camelCase, os campos de `CampaignBudget` (o diário, o de período, `explicitly_shared`, `reference_count`) e de `Campaign`, os erros de orçamento, o formato do `GoogleAdsFailure` e os dois erros de cota. Saem os [NC] de setembro sobre a resposta do `validate_only`, a máscara e os erros de cota; fica um: se a validação conta no limite diário. |
| 08/10/2026 | §3.2: **reconferência para a A5 · Y1** (o plano da A5 foi aprovado no mesmo dia): a ação de conversão `UPLOAD_CLICKS`, o destino, os campos do evento, a leitura do resultado e os limites da Data Manager API. **O achado:** a página dos ajustes de conversão não tem retirada; o mesmo `transactionId` só sobrescreve o valor. O plano prometia retirar o pedido cancelado: a D-A5-7 foi ajustada (espera de duas horas antes de informar; valor zerado para o que for cancelado depois). |
| 08/10/2026 | Pesquisa para o plano da A5 (`plano-a5.md`), em páginas oficiais. §3.1: `validate_only` existe na escrita do Google Ads (o [NC] de setembro sai); **o nível Explorer não põe campanhas e orçamentos entre os serviços bloqueados**; o orçamento de campanha pode ser compartilhado. §3.2: a rota `events:ingest` da Data Manager, com até 2.000 eventos, `validateOnly`, o consentimento e o ajuste de conversão pelo `transactionId`. §2.3: o que é obrigatório num evento da Conversions API e os valores de `action_source`. Ficou marcado o que falta conferir antes de cada entrega. |
| 07/10/2026 | §16.7 nova: **resultados em gráficos**, a pedido do dono: como Shopify, Stripe, Plausible, Triple Whale, Google Analytics e a Apple mostram resultado com pouco texto, o gráfico de bala de Stephen Few e a regra da Nielsen Norman (comprimento e posição se leem mais rápido; pizza e velocímetro, não). Com a conferência das cores: o foco e o cinza de contexto do Liame não podem ser vizinhos numa barra empilhada. Estudo em `mockups/prototipo-graficos.html`. |
| 07/10/2026 | §15.1: a **imagem base** `node:24-bookworm-slim` foi refeita em 06/10 (mesmo Node 24.21.0) e ainda não trazia o `perl-base` que o Debian já tinha corrigido; como conferir a imagem pelo registry, sem Docker (PR #165). |
| 05/10/2026 | §17.6: o **preço do S3 em São Paulo** passou a ser o da lista pública da AWS (US$ 0,0405 por GB por mês; 100 GB de saída por mês sem custo), e entrou o **Backblaze B2** (US$ 6,95 por TB por mês, 10 GB grátis, sem região na América do Sul), a pedido do dono, que perguntou do custo e escolheu a AWS no mesmo dia. |
| 05/10/2026 | §2.1: **o que a campanha nova (X5) pede**, nas referências oficiais da Meta: o criativo só existe em nome de uma **Página do Facebook** (`object_story_spec.page_id`; quem conecta precisa ser administrador ou editor); no Instagram, a conta ligada à Página; as permissões de Página (`pages_show_list`, `pages_read_engagement`, `pages_manage_ads`) além de `ads_management`; os tipos de botão (`ORDER_NOW` e `WHATSAPP_MESSAGE` estão na lista; `SEE_MENU` não está na lista do anúncio de link); e o anúncio que leva ao WhatsApp (`destination_type: WHATSAPP`). Daí a proposta D-A4-35 e o ajuste do protótipo P10 (quem assina o anúncio). |
| 05/10/2026 | §17.6 nova: **armazenamento de arquivos de imagem**, para o ADR-021: S3 (cifra em repouso por padrão; URL assinada de até 7 dias com usuário IAM; teto de idade da assinatura pela política do bucket), Supabase Storage (protocolo S3; a chave do servidor abre todos os buckets; o backup do banco não leva os arquivos; sem versões) e Cloudflare R2 (sem região nem jurisdição na América do Sul). Daí a proposta: bucket privado no S3 de São Paulo, na conta AWS já em uso. |
| 05/10/2026 | §3.1: **status do app OAuth do Google (Testing × In production)**, nas páginas oficiais: em Testing a autorização e o refresh token vencem em 7 dias; publicado, o prazo deixa de valer, com o aviso de app não verificado e o teto de 100 usuários enquanto o escopo sensível (`auth/adwords`) não é verificado. Daí: publicar o app acaba com a reconexão semanal do piloto; a verificação fica para antes do primeiro cliente de fora. |
| 05/10/2026 | §6.2 nova: **o texto de um anúncio de comida e bebida**, pelo Código do CONAR (edição 2025, no site novo do CONAR; os endereços antigos do código saíram do ar): apresentação verdadeira (art. 27: comprovação, preço e redução de preço, "grátis"), o Anexo "F" (os dois preços na redução), a comparação (art. 32), crianças (art. 37), alimentos (Anexo "H") e **bebida alcoólica** (Anexos "A", "P" e "T": cláusula de advertência em todo anúncio, também o de bar e restaurante, sem apelo imperativo de consumo), e a página de bebida alcoólica dos Padrões de Publicidade da Meta. Daí as regras do Criativo de texto (X6): preço e "grátis" só da oferta, e nada de bebida alcoólica nesta fase. |
| 05/10/2026 | Pesquisa para o protótipo P10 (Criativos), em fontes oficiais: §2.1 **criar campanha, conjunto, criativo e anúncio** pela API (o que é obrigatório, `status` na criação, `validate_only`), as **melhorias automáticas do criativo** (cada recurso com `OPT_OUT`), **o que o guia de anúncios recomenda** para imagem e texto (27 e 125 caracteres; 4:5 e 9:16, com as faixas livres dos Stories) e o **rótulo de IA** da Meta; §6 **CONAR e IA** (guia de 2026, item 1.3.1: as regras valem para o conteúdo feito com IA e não há dever novo de aviso), no lugar do "sem norma específica" de 24/09, e a **autoria da peça feita com IA** (Lei 9.610, art. 11, pelo portal da Câmara: o Planalto não respondeu); §7.3 corrigida pelo guia oficial; §16.1 **a peça gerada** (Meta Advantage+ creative, Google Ads Asset Studio, Adobe GenStudio, Pomelli); §17.4 **fornecedores de imagem** (OpenAI e Google, com preço, uso dos dados e marca de origem; Black Forest Labs fora, por treinar com o que recebe; Adobe e Ideogram por conferir). |
| 04/10/2026 | §16.1: **pedido de mudança em anúncio, verba do mês e desfazer** (Google Ads: o relatório de orçamento e o histórico de alterações com desfazer, nas páginas oficiais; Triple Whale Moby), pesquisado antes do protótipo P9. §2.1: **quanto a Meta gasta além da verba diária**: a página oficial de orçamentos da API diz "até 25% a mais" num dia; publicações de quem anuncia citam a Central de Ajuda com até 75% e no máximo 7 vezes a verba na semana; a Central não devolveu o texto à leitura automática **[NC]**. O Liame confere o gasto pela semana (proposta D-A4-24). |
| 04/10/2026 | §2.1: **configuração do login da Meta para a escrita**: a página oficial reconferida (criar: Configurations → Create configuration; nome, tipo de token, ativos, permissões; acesso avançado a `public_profile` antes de ir ao vivo, para quem não tem papel no app) e o print do dono, que mostra **Editar** e **Copiar** na configuração que já existe. Regra: a configuração de leitura não é editada durante o App Review; a de escrita é outra, escolhida pela flag `meta_write`. |
| 04/10/2026 | §2.1: **ferramentas de anúncio** para a A4 · X2, reconferidas nas páginas oficiais: o limite de 4 mudanças de verba por hora **por conjunto** (613/1487632, bloqueio de 1 hora; a página não diz nada sobre o orçamento de campanha), a verba na menor unidade da moeda (guia de orçamentos), e o guia de situação dos objetos (o pai pausado, arquivado ou apagado passa a situação aos filhos; o arquivado só muda `name` e `status`; o apagado, só `name`). Daí as regras das ferramentas (3 por hora por objeto, arquivado e apagado fora). Segue [S]: a seção "Updating" da referência do conjunto (a página continua não abrindo inteira); a validação da própria Meta (`validate_only`) cobre o que a referência não deixou conferir. |
| 04/10/2026 | §2.1: **escrita na Meta** para a A4 · X1, reconferida nas páginas oficiais: `POST /{id}` com `status` e `daily_budget` na menor unidade da moeda, `validate_only` (não faz a mudança e responde `{"success": true}`), o `updated_time` da campanha que não muda com a verba, os códigos e subcódigos de limite (613/1487632: verba do conjunto 4 vezes por hora, com bloqueio de 1 hora), os pontos por conta (escrita vale 3), o formato do erro (`error_user_msg`) e a permissão `ads_management` com as dependências. Daí as regras do conector (versão pelo estado, validação antes, espera em vez de insistência). Ficou [S]: a seção "Updating" do conjunto (a página não abriu inteira) e o subcódigo 33 do objeto que sumiu. Também: a página do Facebook Login for Business só documenta **criar** configuração; editar uma que já existe ficou [NC]. |
| 03/10/2026 | §10.1 nova: **câmbio de referência** (D-A3-14): a PTAX de venda do Banco Central pelos dados abertos (sem credencial, licença ODbL, um boletim por dia útil), conferida no portal e chamando o serviço. §10.2 nova: **workspaces, chaves e limites no Console da Anthropic**, conferidos na documentação oficial antes de o dono criar a chave de produção. |
| 03/10/2026 | §16.6 nova: **leitura de páginas pelo Pesquisador** (I12): SSRF com destino livre (OWASP), robots.txt (RFC 9309) e dado pessoal de acesso público (LGPD art. 7º, pelo Serpro; o Planalto não abriu). Daí: só a página informada, robots.txt respeitado, a página não é guardada, só os rótulos conferidos. |
| 03/10/2026 | §16.5: a **tabela do calendário comercial** que a I11 criou (31 datas, de 12/10/2026 a 31/12/2027), com as datas do varejo de 2027 calculadas pela regra de cada uma e conferidas por script, e o lembrete de renovar a semente antes de dezembro de 2027. |
| 02/10/2026 | §15.2 nova: **resposta em fluxo de eventos** para a Conversa (I10): os limites de conexão da Cloudflare, conferidos na documentação oficial (leitura da origem parada: 125 s, erro 524; muda só no Enterprise), e o "Parar" (fechar a leitura) no Node, medido nos testes. Daí a linha a cada 15 s no fluxo. |
| 02/10/2026 | §16.5 nova: **calendário comercial** (feriados nacionais pela Lei 662/1949 com a redação da Lei 10.607/2002, pela Lei 6.802/1980 e pela Lei 14.759/2023; Black Friday de 2026 em 27/11), conferido antes do protótipo P8 (`mockups/prototipo-resumo.html`): as datas do Estrategista vêm de uma tabela do sistema, com a fonte. |
| 02/10/2026 | §16.1: **equipe, prontidão e autonomia** (HubSpot Agent Hub, Salesforce Agentforce, aplicar recomendações automaticamente do Google Ads, Intercom Fin), pesquisado antes do protótipo P7 (`mockups/prototipo-equipe.html`): autonomia por tipo de ação, ligada por uma pessoa e desligável, com histórico; acerto e custo por agente. |
| 02/10/2026 | §16.4 (nova): **dossiê da marca** nos produtos de marketing (HubSpot Brand Voice e Brand Knowledge, Klaviyo, Jasper IQ, Canva), pesquisado antes do protótipo P6 (`mockups/prototipo-marca.html`): voz separada dos fatos e das regras, a IA sugere a partir do que já existe e a pessoa confere, versões guardadas. |
| 02/10/2026 | §16.1: **conversa com o assistente** (HubSpot Breeze Assistant, Shopify Sidekick e o admin novo de 24/09/2026, Google Ads Advisor, Meta AI Business Assistant, Intercom Fin, Triple Whale Moby), pesquisada antes do protótipo P5 (`mockups/prototipo-conversa.html`): painel ao lado do trabalho, fonte em toda resposta, revisão por uma pessoa antes de aplicar, marca de IA em cada mensagem, caminho para uma pessoa e limite dito na tela. |
| 02/10/2026 | §8.1: o formato de uma chamada MCP 2026-07-28 no fio, medido com o SDK cliente 2.3.0 contra o servidor do RegemCast. §11: o RegemCast tem porta MCP (token por conta, leitura, conversas por anúncio, rascunhos, disparo para produto da DMS) e o envio com cabeçalho de mídia, botões, LTO e carrossel. Fonte: repo `regemcast` (`docs/mcp.md`, PRs #96 e #110 a #116). |
| 01/10/2026 | §2.1: onde fica o link do anúncio feito de publicação que já existia (`object_story_id`, `effective_object_story_id`, `url_tags` "appended to urls clicked from page post ads"), conferido na referência oficial do AdCreative, com a medição do piloto (14 de 18 anúncios sem link no criativo e sem `url_tags`). |
| 30/09/2026 | Pesquisa de MCP das plataformas (pergunta do dono: "é mais rápido integrar por MCP?"): §2 MCP de anúncios da Meta reconferido (beta aberto, 91 ferramentas, permissões com `ads_mcp_management`, não dispensa App Review, sem `url_tags` nem relatório assíncrono, CLI em Python com token de usuário de sistema, User-Agent de agente), MCPs de WhatsApp e devtools, terceiros; §3 MCP do Google Ads 0.0.4 (só leitura, só self-hosted), **política de "programmatic proxy" de 31/08/2026**, developer token ignorado e níveis de acesso, fim da v22 em 07/10; §3.3 MCP do GA4 0.7.0; §8.1 MCPs remotos do Google Cloud e a análise "MCP × objetivos do Liame". |
| 30/09/2026 | §2.1: perguntas de tratamento de dados da Meta sobre **pedidos de autoridades públicas** (revisão da legalidade, contestação do pedido ilegal, mínimo necessário, documentação com resposta e fundamento), conferidas na página oficial, para a Política de Privacidade 8. |
| 29/09/2026 | Links de campanha (A2.5 · F5), conferido na documentação oficial: §2.1 `url_tags` no AdCreative com os parâmetros dinâmicos (guia "Use URL Tags for Tracking") e onde o criativo diz para onde leva (`link_data.link`, cartões, botão do vídeo, `asset_feed_spec.link_urls` com `url_tags` próprio, `object_url`), `destination_type` do conjunto; "Parâmetros de URL" = `url_tags` e a expansão aninhada ficam [S] até a primeira leitura real. §3.1 "Sufixo do URL final" (formato, níveis e o mais específico vence, resolvido separado do modelo), ValueTrack no URL final (sem nome de campanha), campos dos protos v25 e recurso atribuído na GAQL. A página de ajuda da Meta dos parâmetros dinâmicos só abre no navegador (a busca devolve só o título). |
| 29/09/2026 | Pesquisa da A2.5 (ciclo fechado, `plano-a25.md` §9), só em fontes oficiais: §2.1 parâmetros de URL da Meta, `url_tags` e **restrição de uso dos dados de anúncio da Meta** (sem misturar anunciantes; nada vai a outra rede, nem agregado); §2.3 CAPI reconferida (`event_time` 7 dias derruba o lote; `fbc` com apêndice; mensageria com `ctwa_clid`, sem dedupe); §2.4 `referral` do WhatsApp (`ctwa_clid` some no Status; coexistência [NC]); §3.1 auto-tagging, gbraid/wbraid, ValueTrack, sufixo do URL final pela API v25, `click_view` (1 dia, 90 dias, sem gbraid) e janelas de conversão; §3.2 Data Manager reconferida; §3.3 `analytics.readonly` não restrito; §6 guia de cookies da ANPD. |
| 24/09/2026 | Criação: pesquisas de concorrentes, APIs das plataformas, MCP/protocolos, produtos DMS no disco, 49 skills de marketing; versões via npm. |
| 24/09/2026 | §13: matriz de IdP (12 opções) contra a spec MCP 2026-07-28, KEK e âncora de auditoria. §14: SDKs de IA, feature flags, observabilidade, supply chain e evals. |
| 24/09/2026 | §15: validação da stack (Nest 12, TS 6×7, Next 16.3, React 19.3, Tailwind 4.3, Drizzle, pg-boss 12, Supabase PG 17, OTel, pnpm 12, Turborepo 2.11). |
| 25/09/2026 | §16: padrões de interface de agentes (HubSpot Agent Hub, Triple Whale Moby Automations, Klaviyo Composer, Linear Agent) e suporte de plataforma (View Transitions, `<ViewTransition>` do React 19.3, `@starting-style`, `light-dark()`, container queries, `inert`, animação por rolagem) para o modelo de interface (`docs/ux-modelo-interface.md`). |
| 25/09/2026 | §17: segundo fator (NIST SP 800-63B-4, Logto), guarda de registros (Marco Civil art. 15), cabeçalhos `Deprecation`/`Sunset` (RFC 9745/8594), versões da Meta divergentes entre fontes, geração de imagem e vídeo no AI SDK e mercado de modelos de imagem (ADR-013 a ADR-016). |
| 25/09/2026 | §17.5: acesso delegado no mercado (níveis e convite do Google Ads, conta de administrador, parceiros da Meta, proprietário principal do Perfil da Empresa) para o ADR-017. |
| 25/09/2026 | §6.1: verificação legal para os documentos jurídicos (LGPD e Lei 15.352/2026, Res. ANPD 2, 15, 18, 19 e 32, Marco Civil, CDC/STJ, ECA Digital, PL 2338, TSE 23.755/2026, Meta, Google Uso Limitado, WhatsApp); corrigidos §2.4, §6 e §17.2. |
| 28/09/2026 | §2.1: passos e armadilhas da configuração do Facebook Login for Business (MANAGE por padrão nas tarefas do ativo; variação e expiração não mudam depois). §3.1: níveis de acesso do Google Ads pelo projeto (Explorer automático em ~1 min, Básico exige verificação da marca) e chave do cliente OAuth só na criação. Observado ao configurar os apps do Liame com o dono. |
| 26/09/2026 | §2.1 e §3.1 reconferidos para o plano da A2: Meta v26.0 é a mais nova nas duas tabelas (divergência resolvida); Google Ads segue na major v25, com menores v25.1 e v25.2 (a "cadência mensal" é de versões menores). |
| 26/09/2026 | §17.1: tela de entrada e de código (NIST 800-63B-4 §3.1.1.2 e §3.1.4.2, WCAG 2.2 SC 3.3.8, Google, Stripe), para o protótipo das telas de entrada. |
| 26/09/2026 | §15.1: imagem base por digest, Syft, Grype, `pnpm sbom`/`deploy` e Semgrep/zizmor locais no Windows (E9). |
| 26/09/2026 | §15.1: OpenTelemetry Collector contrib 0.161 (validação, `redaction`, checksum por arquivo) (E8). |
| 26/09/2026 | §13.3: API do Rekor v2 (hashedrekord v0.0.2, `integratedTime` sempre 0, URL por SigningConfig) e TSA pública da Sigstore (E3). |
| 26/09/2026 | §15.1: Standard Webhooks (vetor oficial conferido), corpo cru no Nest 12 e `lookup` do Node (E5). |
| 25/09/2026 | §15.1: resultados do spike A0-3 medidos no código (inspeção dos `.d.ts` instalados, build e execução): server em ESM, OTel sem hook de loader, APIs reais do Nest 12, swagger 12, pg-boss 12, MCP 2.1 e AI SDK 7, comportamento do pnpm 12. |

**Fontes principais:**

- **Meta:**
  - developers.facebook.com/docs/resp-plat-initiatives/data-handling-questions/questions-preview (perguntas de tratamento de dados, 30/09/2026)
  - developers.facebook.com/docs/graph-api/changelog/versions
  - …/marketing-api/overview/rate-limiting
  - developers.meta.com/blog/updates-to-ads-management-standard-access-feature
  - facebook.com/business/news/meta-ads-ai-connectors
  - …/instagram-platform/content-publishing
  - …/whatsapp/pricing
  - …/threads/overview
  - …/instagram/ads-api/guides/url-tags-for-tracking · …/marketing-api/reference/ad-asset-feed-spec-link-url (F5)
  - facebook.com/business/ads-guide (imagem no Feed e nos Stories) · …/marketing-api/reference/ad-account/campaigns, adsets, adimages, adcreatives e ads · …/marketing-api/creative/advantage-creative/get-started · about.fb.com/news/2025/02/gen-ai-transparency-metas-ads-products (P10 e X5)
  - …/marketing-api/reference/ad-creative-object-story-spec · …/reference/ad-creative-link-data · …/reference/ad-creative-link-data-call-to-action · …/marketing-api/ad-creative/messaging-ads/click-to-whatsapp · developers.facebook.com/docs/instagram/ads-api/guides/pages-ig-account · developers.facebook.com/docs/permissions (X5, 05/10/2026)
- **Google:**
  - developers.google.com/google-ads/api/docs/api-policy/access-levels
  - developers.google.com/identity/protocols/oauth2 (vencimento do refresh token) · …/oauth2/production-readiness/overview · support.google.com/cloud/answer/15549945 (Manage App Audience) · …/7454865 (Unverified apps) · …/13464323 (quando a verificação não é exigida), 05/10/2026
  - …/release-notes
  - …/sunset-dates
  - github.com/googleads/google-ads-mcp
  - ads-developers.googleblog.com/2026/05/changes-to-offline-click-conversion.html
  - developers.google.com/data-manager
  - developers.google.com/analytics/devguides/reporting/data/v1/quotas
  - developers.google.com/my-business/content/prereqs
  - developers.google.com/youtube/v3/revision_history
  - developers.google.com/google-ads/api/docs/ads/upgraded-urls/serving-url-rules · support.google.com/google-ads/answer/9054021 · …/6305348 (F5)
- **TikTok:**
  - developers.tiktok.com/docs/en/content-sharing-guidelines
  - ads.tiktok.com/business/en/blog/tiktok-agentic-hub-ai-agents-skills-mcp
- **LinkedIn:** learn.microsoft.com/en-us/linkedin/marketing/increasing-access
- **MCP:**
  - modelcontextprotocol.io/specification/2026-07-28/changelog
  - …/basic/authorization
  - …/basic/security_best_practices
  - github.com/modelcontextprotocol/typescript-sdk
- **OWASP:**
  - genai.owasp.org (LLM 2025, Agentic 2026)
  - owasp.org/www-project-mcp-top-10
- **Protocolos:**
  - standardwebhooks.com
  - datatracker.ietf.org (Idempotency-Key, RateLimit headers, OAuth 2.1, CIMD)
- **Brasil:**
  - planalto.gov.br (LGPD)
  - gov.br/anpd (guia de legítimo interesse)
  - conar.org.br · conar.org.br/noticias/guia-de-marketing-e-publicidade-por-influenciadores-digitais (guia de 2026; IA no item 1.3.1)
  - conar.org.br/codigos?section=codigo (Código Brasileiro de Autorregulamentação Publicitária, edição 2025: arts. 27, 32 e 37; Anexos "A", "F", "H", "P" e "T") · transparency.meta.com/policies/ad-standards/restricted-goods-services/alcohol
  - www2.camara.leg.br/legin/fed/lei/1998/lei-9610-19-fevereiro-1998-365399-normaatualizada-pl.html (Lei 9.610, art. 11)
  - facebook.com/business/help/167836590566506
  - support.google.com/adspolicy/answer/6014595
- **Mercado:**
  - mlabs.com.br/precos
  - reportei.com/planos-e-precos
  - rdstation.com/planos
  - brendi.com.br/trafego-pago
  - tintim.app
  - metricool.com/pricing
  - bir.ch/pricing
  - madgicx.com/pricing
  - otempo.com.br (iFood Toqan, 17/09/2026)
  - forbes.com.br (ChatGPT Ads BR)
- **Acesso, dados, APIs e mídia (§17):**
  - pages.nist.gov/800-63-4/sp800-63b/authenticators/
  - docs.logto.io/end-user-flows/mfa
  - rfc-editor.org/rfc/rfc9745 · RFC 8594
  - ai-sdk.dev/docs/ai-sdk-core/video-generation
  - cometapi.com/ai-image-api-pricing · buildmvpfast.com/api-costs/ai-image (secundárias)
  - developers.openai.com (imagem: modelos, preço e uso dos dados) · openai.com/policies/services-agreement · ai.google.dev (imagem: modelos, preço e SynthID) · docs.bfl.ai/quick_start/pricing · bfl.ai/legal/flux-api-service-terms (05/10/2026)
  - docs.aws.amazon.com/AmazonS3/latest/userguide/default-encryption-faq.html · …/using-presigned-url.html · supabase.com/docs/guides/storage/s3/compatibility · …/storage/s3/authentication · …/storage/uploads/file-limits · …/storage/pricing · supabase.com/docs/guides/platform/backups · developers.cloudflare.com/r2/pricing · …/r2/reference/data-location · pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonS3/current/sa-east-1/index.json · …/aws/AWSDataTransfer/current/sa-east-1/index.json · aws.amazon.com/blogs/aws/aws-free-tier-data-transfer-expansion-100-gb-from-regions-and-1-tb-from-amazon-cloudfront-per-month · backblaze.com/cloud-storage/pricing · backblaze.com/docs/cloud-storage-data-regions (§17.6, 05/10/2026)
  - modeloinicial.com.br/lei/L-12965-2014/marco-civil-internet/art-15 (secundária; o Planalto não respondeu)
  - support.google.com/google-ads/answer/9978556 (níveis) · …/7456532 (propriedade na conta de administrador) · …/7459601 (vínculo)
  - facebook.com/business/help/708679622611131 (parceiros da Meta)
  - support.google.com/business/answer/3403100 (proprietários e administradores do Perfil da Empresa)
- **Interface (§16):**
  - hubspot.com/spotlight
  - triplewhale.com/blog/moby-2-media-buying-automations
  - help.klaviyo.com/hc/en-us/articles/52230280693403
  - linear.app/changelog/2026-03-24-introducing-linear-agent
  - react.dev/blog/2026/09/09/react-19-3 · github.com/react/react/issues/37614
  - web-platform-dx.github.io/web-features-explorer (view-transitions, starting-style, light-dark, container-queries, inert, scroll-driven-animations)
  - knowledge.hubspot.com/ai/use-breeze-assistant (conversa, citações e fontes; 16/09/2026)
  - help.shopify.com/en/manual/shopify-admin/productivity-tools/sidekick · shopify.com/blog/admin-new-look (24/09/2026)
  - business.google.com/us/accelerate/announcements/google-ai-advisors-agentic-tools-to-drive-impact-and-insights (11/2025)
  - intercom.com/changes/en/96733-let-your-customers-know-they-re-speaking-with-an-ai-agent (11/07/2025)
  - mediapost.com/publications/article/414547 (Meta AI Business Assistant, 24/04/2026; secundária) · kb.triplewhale.com (Moby; lida só pelo resumo da busca)
  - knowledge.hubspot.com/branding/set-up-brand-voice-using-ai (14/09/2026) · community.hubspot.com/t/june-2026-product-updates/151744 (lida pelo resumo da busca)
  - help.klaviyo.com/hc/en-us/articles/35873068949147 (06/08/2025) · jasper.ai/blog · canva.com/help/brand-voice (secundárias)
  - support.google.com/google-ads/answer/10276359 (aplicar recomendações automaticamente) · hubspot.com/spotlight (Agent Hub)
  - salesforce.com/news/press-releases/2025/06/23/agentforce-3-announcement · fin.ai (secundárias para métricas)
  - planalto.gov.br/ccivil_03/leis/2002/l10607.htm · planalto.gov.br/ccivil_03/_ato2023-2026/2023/lei/l14759.htm (feriados nacionais)
  - blackfriday.com.br (data da Black Friday de 2026, secundária)
  - facebook.com/business/ads/meta-advantage-plus/creative · support.google.com/google-ads/answer/16456563 (Asset Studio) · …/17140115 (rótulo de IA) · experienceleague.adobe.com/en/docs/genstudio-for-performance-marketing/user-guide/guidelines/brand-validation · blog.google/innovation-and-ai/models-and-research/google-labs/pomelli (P10)
  - help.shopify.com/en/manual/reports-and-analytics/shopify-reports/overview-dashboard · shopify.dev/docs/api/shopifyql/latest/web-components/metric-card · plausible.io/docs/guided-tour · support.google.com/analytics/answer/9443595 · nngroup.com/articles/dashboards-preattentive (07/10/2026); support.stripe.com/questions/dashboard-home-page-charts-for-business-insights · kb.triplewhale.com/en/articles/5725275 · en.wikipedia.org/wiki/Bullet_graph · macworld.com/article/233093 (secundárias, pela busca)

---

## 13. Identidade, chave mestra e âncora

*Verificado em 24/09/2026. Decisões nos ADR-009 e ADR-011.*

### 13.1 Servidor de autorização para MCP (DMS ID)

- **O que a spec MCP 2026-07-28 exige do AS** [O]:
  - **MUST:** OAuth 2.1; discovery (RFC 8414 ou OIDC) com `code_challenge_methods_supported`; `redirect_uri` exato; rotação de refresh token de cliente público.
  - **SHOULD:** **CIMD** (`client_id_metadata_document_supported`; draft IETF -02) e **RFC 9207** (vira MUST numa próxima revisão).
  - **DCR:** MAY e **deprecado**.
  - **RFC 8707:** o cliente sempre envia `resource` e o servidor MCP valida o `aud`. Um AS sem 8707 funciona fixando o `aud` por scope, mas **não fica conforme**.
  - **Extensões:** EMA/ID-JAG estável; client credentials (M2M) em draft.
- **Matriz (✅ sim · ⚠️ parcial ou experimental · ❌ não):**

  | AS | 8707 | 9207 | CIMD | M2M | Região BR | Nota |
| --- | --- | --- | --- | --- | --- | --- |
  | **Logto OSS** (MPL-2.0) | ✅ nativo | ✅ | ✅ (v1.43; sem política de admissão documentada) | ✅ | self-host | sem DCR; base `oidc-provider` |
  | Keycloak 26.7 | ⚠️ experimental | ✅ | ⚠️ experimental | ✅ | self-host | CNCF, certificado; CVE-2026-18963 (CVSS 9.1) corrigida na 26.7.2 |
  | Descope | ✅ | n/c | ✅ GA | ✅ (US$2 por mil excedente) | ✅ só Growth (US$799) | DCR ligado por padrão |
  | WorkOS | ✅ | n/c | ✅ | ✅ (preço n/c) | ❌ EUA | melhor DX |
  | Auth0 | ✅ toggle | ✅ | ⚠️ manual | ✅ US$0,004 por token | ❌ | ≈ US$1.400/mês no porte |
  | Clerk | ⚠️ | n/c | ✅ GA (09/2026) | ❌ proprietário | ❌ | — |
  | Stytch (Twilio) | ⚠️ | ✅ | ⚠️ beta | ✅ US$0,005 por token | ❌ | — |
  | Zitadel · Ory · authentik | ❌ | ❌ | ❌ | ✅ | self-host | fora para MCP hoje |
  | Supabase Auth OAuth Server | ❌ | ❌ | ❌ | ❌ | ✅ | beta; `aud` fixo |
  | `oidc-provider` custom | ✅ | ✅ | ⚠️ experimental | ✅ | self-host | certificado FAPI 2.0; **mantenedor único** |

- **LGPD:** identidade hospedada nos EUA exige cláusulas-padrão (Res. ANPD 19/2024; prazo encerrado em 23/08/2025). A UE tem adequação (Res. ANPD 32/2026).

### 13.2 Chave mestra (KEK)

- **AWS KMS sa-east-1:**
  - ≈ US$1–4/mês;
  - 5–20 ms;
  - HSM FIPS 140-3 nível 3;
  - CloudTrail registra Decrypt por padrão;
  - rotação automática.
- **GCP Cloud KMS:** mais barato, mas o log de cifrar/decifrar vem desligado por padrão e é pago.
- **Vault/OpenBao Transit:** operação alta (unseal, HA).
- **Infisical, Doppler, 1Password:** são cofres; a KEK chega em claro ao app.
- **Supabase Vault não atende:** quem tem SQL lê `vault.decrypted_secrets`, e a Management API devolve a chave raiz.
- **KEK por tenant** (crypto-shredding) na AWS custa cerca de US$1/chave/mês.

### 13.3 Âncora da auditoria

- **S3 Object Lock compliance mode** [O]: nem o root apaga (avaliado pela Cohasset para SEC 17a-4). Versões novas e delete markers ainda podem ser criados, então o verificador aceita só a primeira versão do dia.
- **Sigstore Rekor:** público e permanente; detecta equivocação do operador.
  - Aceita **ECDSA P-256 ou Ed25519ph, não Ed25519 puro**.
  - A v2 não fornece tempo, então exige carimbo RFC 3161.
  - **Rekor v2 (rekor-tiles), API** [O, CLIENTS.md do sigstore/rekor-tiles, 26/09/2026]: `POST /api/v2/log/entries` com `{"hashedRekordRequestV002": {"digest": <base64 do SHA-256 do artefato>, "signature": {"content": <base64>, "verifier": {"publicKey": {"rawBytes": <base64 da chave pública DER>}, "keyDetails": "PKIX_ECDSA_P256_SHA_256"}}}}`. Resposta: `TransparencyLogEntry` (`logIndex`, `logId.keyId`, `kindVersion`, `integratedTime`, `inclusionProof`, `canonicalizedBody`). **`integratedTime` é sempre 0** e deve ser ignorado. Tipos aceitos só `hashedrekord` e `dsse`. Pedir tempo limite de 20 s ou mais (a v2 agrupa pedidos).
  - **URL do log v2** [O, README do rekor-tiles, 26/09/2026]: a instância ativa é `https://log2025-1.rekor.sigstore.dev`, mas o shard muda (uma instância nova em 2026); os clientes devem descobrir a URL pelo `SigningConfig` (TUF, `rekorTlogUrls`). Não fixar no código: vai por configuração.
  - **TSA pública da Sigstore** [O, docs.sigstore.dev e sigstore/timestamp-authority, 26/09/2026]: `https://timestamp.sigstore.dev/api/v1/timestamp` (RFC 3161, política RFC 3628, estrutura RFC 5816). Outras públicas: timestamp.githubapp.com, FreeTSA, DigiCert.
- **R2 Bucket Locks não é compliance mode:** quem tem o token de configuração remove a trava.
- **OpenTimestamps:** biblioteca JS parada desde 2021.
- **Validade jurídica:** presunção de veracidade só com certificado ICP-Brasil (MP 2.200-2/2001, art. 10 §1º): e-CNPJ + ACT (ex.: Prodesp, R$0,06 por carimbo).

---

## 14. SDKs de IA, flags, observabilidade e supply chain

*Verificado em 24/09/2026. Decisões nos ADR-006, ADR-010 e ADR-012.*

### 14.1 SDKs de IA

*Versões publicadas em 02/10/2026 (`npm view`): `ai` 7.0.127 · `@ai-sdk/anthropic` 4.0.71 · `@ai-sdk/otel` 1.0.127 · `@anthropic-ai/sdk` 0.131.0 · `promptfoo` 0.123.1. O AI SDK segue na série 7; o texto abaixo é o de 24/09/2026.*

- **Vercel AI SDK 7** (`ai` 7.0.113, Apache-2.0):
  - GA em 25/06/2026; **só ESM e Node ≥ 22**; um major a cada ~6 meses.
  - Traz structured output (Standard Schema), tools paralelas, streaming, MCP client (`@ai-sdk/mcp`), embed, rerank, `needsApproval` e **OTel `gen_ai.*` nativo** (`@ai-sdk/otel`).
  - **Não reporta custo em US$.**
  - Model id em string cai no **Vercel AI Gateway** → usar `createProviderRegistry`.
  - O `WorkflowAgent` depende do Workflow 5 (beta).
- **`@anthropic-ai/sdk` 0.128:**
  - `messages.parse` + `zodOutputFormat` (GA); tool runner em beta, sequencial por padrão.
  - Prompt caching: escrita a 1,25× (5 min) ou 2× (1 h); leitura a 0,1×.
  - **Batch −50%** (100 mil requisições, 256 MB, 24 h); MCP connector em beta.
- **`openai` 7.23:** v7 em 27/07/2026 (Node 22); `responses.parse`; Standard Schema desde a 6.49.
- **`@openai/agents` 0.18:** HITL mais maduro (`needsApproval`, `RunState`), mas o **tracing padrão manda dados para a OpenAI** (`OPENAI_AGENTS_DISABLE_TRACING=1`).
- **`@google/genai` 2.24:** JSON Schema; a 3.0 vai exigir Node 22.
- **LiteLLM:** as versões 1.82.7 e 1.82.8 no PyPI saíram comprometidas em 24/03/2026. **OpenRouter:** taxa de 5,5%.
- **Semconv GenAI do OTel:** ainda em *Development* (repo `semantic-conventions-genai`, sem release).

### 14.2 Feature flags

- **OpenFeature:** CNCF Incubating; `server-sdk` 1.23.0; `nestjs-sdk` 0.2.7 (0.x); OFREP para o front.
  - **OFREP** [O, open-feature/protocol `service/openapi.yaml`, 26/09/2026]: `POST /ofrep/v1/evaluate/flags/{key}` e `POST /ofrep/v1/evaluate/flags` (lote), corpo `{context: {targetingKey, ...}}`. Sucesso: `key`, `value`, `reason` (STATIC, TARGETING_MATCH, SPLIT, DISABLED, UNKNOWN), `variant`, `metadata`; lote: `{flags: [...]}`. Erro: `key`, `errorCode` (PARSE_ERROR, TARGETING_KEY_MISSING, INVALID_CONTEXT, GENERAL, FLAG_NOT_FOUND), `errorDetails`. Lote com `ETag` e `If-None-Match` → 304.
  - `server-sdk` 1.23.0 tem peer `@openfeature/core` ^1.12.0 (1.12.0, 28/07/2026); licença Apache-2.0 [O, npm, 26/09/2026].
- **Unleash OSS:** 1 projeto e **2 ambientes**; Enterprise a US$75/seat.
- **GrowthBook** exige MongoDB. **Flagsmith** é BSD-3 sobre Postgres. **Flipt v2** é fair source e baseado em Git.
- **PostHog:** self-host sem suporte oficial.

### 14.3 Observabilidade

- **Grafana Cloud Free:**
  - 10 mil séries, 50 GB de logs, 50 GB de traces, 14 dias;
  - **tem região Brasil**;
  - Pro a US$19 + ~US$0,50/GB.
- **SigNoz:** cloud a US$49; self-host exige ≥ 4 GB e ClickHouse.
- **Sentry:** Team a US$26; ingestão OTLP em beta.
- **Langfuse** (comprado pela ClickHouse em 16/01/2026):
  - Hobby US$0;
  - OTLP por HTTP em `/api/public/otel`;
  - self-host exige ≥ 4c/16 GB (Postgres, ClickHouse, Redis, S3).
- **Phoenix:** ELv2, contêiner único. **OpenLIT:** Apache-2.0.
- **Helicone em modo manutenção** (comprado pela Mintlify em 03/2026).

### 14.4 Supply chain (GitHub Free, repo privado)

- **Grátis:** dependency graph, Dependabot alerts, security updates e version updates (cooldown padrão de 3 dias desde 14/07/2026).
- **Pago:** secret scanning, push protection, CodeQL e upload de SARIF em repo privado (US$19–30/committer).
- **A licença do CodeQL CLI proíbe** uso em código fechado sem GHAS.
- **Actions:** 2.000 min/mês; política de pin por SHA disponível desde 08/2025.
- **Ferramentas livres:**
  - osv-scanner v2.6.0;
  - gitleaks v8.30.1 (CLI MIT; a action tem licença própria) e Betterleaks v1.8.1;
  - TruffleHog v3.97.9 (AGPL);
  - Semgrep CE v1.178 (a `semgrep-action` foi arquivada);
  - zizmor v1.30.1;
  - Syft v1.52 e `pnpm sbom`;
  - Grype v0.119.
- **Incidente Trivy 19/03/2026** (v0.69.4 maliciosa; tags da `trivy-action` sequestradas; GHSA-69fq-xp46-6x23) → só fixado por SHA ou digest.
- **pnpm 12:** `minimumReleaseAge` (1 dia por padrão), `trustPolicy: no-downgrade`, `blockExoticSubdeps`, `allowBuilds`.
- **Evals:**
  - **promptfoo** 0.123.1: MIT, **comprado pela OpenAI** (09/03/2026); exit 100 quando falha; `PROMPTFOO_PASS_RATE_THRESHOLD`; desligar telemetria.
  - **Inspect:** Python, forte em agentes.
  - **Braintrust:** Pro a US$249.

---

## 15. Validação da stack (detalhes)

*Verificado em 24/09/2026 (release notes, docs, `npm pack` e teste local de compilação). Decisão no ADR-001.*

- **NestJS 12** (27/08/2026):
  - Pacotes oficiais em **ESM** (`"type":"module"`). App CommonJS funciona via `require(esm)`.
  - Node 20.19+, 22.12+ ou 24+. A CLI exige 22.22.3+, 24.15+ ou 26+.
  - **Standard Schema nativo:** `@Body/@Query/@Param({ schema })` + `StandardSchemaValidationPipe` (de `@nestjs/common`) + `StandardSchemaSerializerInterceptor`. Convive com o `ValidationPipe` de class-validator.
  - O `@nestjs/config` também valida por Standard Schema.
  - Projeto novo usa Vitest e oxlint; Rspack é o bundler padrão de monorepo.
  - O Jest só carrega o Nest 12 a partir da v24.9.
- **@nestjs/swagger 12:**
  - **O padrão ainda gera OpenAPI 3.0.0.** O 3.1 é opt-in com `setOpenAPIVersion('3.1.0')`, que normaliza nulos e aceita `webhooks`.
  - Schemas com Standard JSON Schema (o Zod 4 "classic" implementa) entram no documento.
- **TypeScript:**
  - **6.0** (23/03/2026): última versão em JS. Novos defaults: `strict`, `module esnext`, `target es2025`, **`types: []`**, `noUncheckedSideEffectImports`. Deprecados: `moduleResolution node`, `baseUrl` e outros.
  - **7.0** (08/07/2026, em Go): 8–12× mais rápido, mas **sem API programática** (volta na 7.1). A CLI do Nest recusa com mensagem oficial.
  - Os decorators legados e `emitDecoratorMetadata` funcionam no 6 e no 7 (teste local).
- **Next.js 16.3:**
  - Turbopack padrão (config `webpack` custom faz o build falhar).
  - **`middleware` → `proxy.ts`**, só em runtime Node; validar auth em cada Server Function.
  - `cacheComponents` com `'use cache'`, `cacheLife` e `cacheTag` estáveis; `revalidateTag` exige 2º argumento.
  - APIs de request só assíncronas. `next lint` removido.
  - React Compiler estável, mas desligado.
  - Instrumentação por `instrumentation.ts`, com `NodeSDK` só quando `NEXT_RUNTIME === 'nodejs'`.
  - `outputFileTracingRoot` no standalone de monorepo.
- **React 19.3** (09/09/2026): `<ViewTransition>` e Fragment Refs estáveis; Trusted Types; sem quebras.
- **Tailwind 4.3:**
  - `@import "tailwindcss"` + `@theme`. **`@theme inline` para tokens que apontam para outras variáveis** (semânticos e tema escuro). `@utility` para utilitários próprios.
  - Dark manual: `@custom-variant dark (&:where([data-theme=dark], [data-theme=dark] *))`.
  - Monorepo: `@source "../../packages/ui/src"`.
  - Renomes: `shadow-sm` → `shadow-xs`, `rounded-sm` → `rounded-xs`, `outline-none` → `outline-hidden`; `ring` passou a ter 1px.
- **Drizzle:**
  - **0.45.3** estável; 1.0 em RC (rc.4, 27/06), sem data de GA.
  - O 1.0 remove o RQB v1 (`db.query` antigo), troca o `casing` global, muda a pasta de migrations (v3), troca `.enableRLS()` por `withRLS()`, e o `drizzle-zod` vira `drizzle-orm/zod`.
  - O 0.45 já tem `pgPolicy`, `pgRole().existing()`, `.enableRLS()` e `drizzle-orm/supabase`.
- **pg-boss 12.34:**
  - Node 22.12+ e PG 13+.
  - Políticas `standard`, `short`, `singleton`, `stately`, `exclusive`, `key_strict_fifo`.
  - **Envio transacional** com `db: fromDrizzle(tx, sql)`.
  - **`group` + `groupConcurrency`** (global).
  - `flow()` como DAG; DLQ com `redrive`; cron e RRULE.
  - Retenção padrão de 14 dias.
  - **O LISTEN precisa de conexão direta ou em modo sessão.**
- **Supabase:**
  - **Postgres 17** padrão; sa-east-1.
  - Conexão direta em IPv6 (o add-on IPv4 não é dual-stack). Supavisor em sessão na porta 5432 ou em transação na 6543 (sem prepared statements); pooler dedicado nos planos pagos.
  - Limites (diretas / pooler): Micro 60/200; Small 90/400; Medium 120/600.
  - **Tabelas novas não ficam expostas na Data API** (padrão desde 30/05/2026; vale para todos em 30/10/2026).
  - pgmq não tem retry, DLQ, cron nem DAG, então não substitui o pg-boss.
  - pg_cron: no máximo ~8 jobs simultâneos.
- **OpenTelemetry JS:**
  - Traces e métricas estáveis; logs em desenvolvimento.
  - ESM exige `--import` + `--experimental-loader=@opentelemetry/instrumentation/hook.mjs`.
  - A instrumentação `http` 0.222 emite **só** as convenções estáveis.
  - **`instrumentation-nestjs-core` 0.68 não cobre o Nest 12** (PR #3733 mesclado, ainda sem release).
  - Manter `enhancedDatabaseReporting` desligado (LGPD).
- **pnpm 12** (26/08/2026):
  - Node 22+, ESM.
  - Configuração no `pnpm-workspace.yaml`; `allowBuilds`.
  - **`minimumReleaseAge` de 1 dia**, `blockExoticSubdeps` e `strictDepBuilds` por padrão.
- **Turborepo 2.11** (18/09/2026):
  - `envMode` estrito.
  - Pacote consumido pelo Nest precisa ser compilado.
  - O exemplo oficial ainda usa pnpm 11.25.
- **Node 24** entra em manutenção em 20/10/2026. O **Node 26 vira LTS em 28/10/2026**.

### 15.1 Medido no spike A0-3 (25/09/2026)

*Fonte: os `.d.ts` e o código dos pacotes instalados, `nest build`/`next build` e execução do `dist` no Node 22.23 (Windows) e em checkout limpo. Confiança [O] para o que foi executado. Decisão no ADR-001; erros em `ERROS-CONHECIDOS.md` (ERR-001 a ERR-006).*

- **Formato de módulo:** server CommonJS + pacotes internos ESM = cópia dupla de dependência publicada nos dois formatos (`drizzle-orm`: TS2345 no build). **Tudo ESM** resolve. `require(esm)` funciona sem aviso no Node 22.23 para Nest 12, AI SDK 7 e pg-boss 12.
- **Pacotes só ESM:** `@nestjs/*` 12 (`"type": "module"`, sem condição `require`), `ai` 7 (inclusive `ai/test`), `pg-boss` 12 (`engines` Node ≥ 22.12). **Duplo (ESM + CJS):** `@modelcontextprotocol/server` 2.1, `drizzle-orm`, `zod`.
- **Nest 12:** `@Body({ schema })` (também `@Query`, `@Param`, `@RawBody`) + `new StandardSchemaValidationPipe()` global; `transform` padrão `true` (entrega o valor já transformado pelo Zod). Erro 400 com `message: ["message: Too small: …", "Unrecognized key: \"extra\""]`. Serialização: `@SerializeOptions({ schema })` + `StandardSchemaSerializerInterceptor`.
- **@nestjs/swagger 12.0.2:** `DocumentBuilder().setOpenAPIVersion('3.1.0')`; o corpo vem do `schema` do parâmetro; resposta por `@ApiOkResponse({ standardSchema })`; conversor próprio em `SwaggerDocumentOptions.standardSchemaConverter`. Depende do `swagger-ui-dist`, que traz o rastreador `@scarf/scarf` (script bloqueado).
- **pg-boss 12.34:** export nomeado `PgBoss` (sem default); `fromDrizzle(tx, sql)` exige o `sql` do `drizzle-orm` (usa `sql.param`); o envio faz `INSERT … SELECT … FROM <schema>.queue … RETURNING id`, então a role da aplicação precisa de `USAGE` no schema, `SELECT` na `queue` e `INSERT` + `SELECT` na tabela da fila; `work(nome, handler)` recebe lote (`jobs[]`); `useListenNotify` exige conexão em sessão.
- **MCP 2.1:** `new McpServer({ name, version })`, `registerTool(nome, { inputSchema: z.object(...) }, cb)`; `createMcpHandler(fábrica)` devolve `{ fetch(Request), close() }` (Web Standard). Tráfego do protocolo 2025 é servido sem estado por padrão; `tools/list` e `tools/call` responderam com `mcp-protocol-version: 2025-06-18`.
- **AI SDK 7:** modelo simulado `MockLanguageModelV4` (`ai/test`); o resultado do `doGenerate` V4 tem `content[]`, `finishReason: { unified, raw }`, `usage` com `inputTokens`/`outputTokens` em objetos e `warnings[]`.
- **OpenTelemetry (sdk-node 0.222):**
  - Sem `spanProcessors` nem exportador, **não registra tracer provider** (só cria se houver processador); com `NoopSpanProcessor`, os spans existem e o `trace_id` circula sem exportar.
  - Sem configuração, métricas e logs tentam OTLP em `localhost:4318`; passar `metricReaders: []` e `logRecordProcessors: []` quando não há coletor.
  - Em app ESM iniciado por `--import`, `pg` e `http` (via Express, CommonJS) **são instrumentados sem o hook de loader**; o undici usa `diagnostics_channel`. O hook (`@opentelemetry/instrumentation/hook.mjs`, `import-in-the-middle` 3.5) só é necessário para pacote só ESM.
  - `InMemorySpanExporter` é limpo no `shutdown` (LIC-095).
  - Spans do pg sem banco: `pg.connect` e `pg-pool.connect`.
- **Next 16.3.6:** `cacheComponents: true` e `output: 'standalone'` buildam; o `instrumentation.ts` importando um pacote ESM do workspace com o SDK do OTel compila no Turbopack sem aviso. A lista padrão de pacotes externos do servidor inclui `pg`, `require-in-the-middle` e `import-in-the-middle`, mas não `@opentelemetry/*`.
- **pnpm 12.6:**
  - Sem `minimumReleaseAgeStrict: true`, uma faixa só com versão imatura gera **exceção automática** em `minimumReleaseAgeExclude` (LIC-094).
  - `strictDepBuilds` falha o install listando os scripts não revisados; a resposta vai em `allowBuilds` (`true`/`false`).
  - `--force` instala as dependências opcionais de **todas** as plataformas (evitar).
  - Pelo corepack: `corepack pnpm <cmd>` lê o `packageManager` sem ativar nada global.
- **pnpm 12, CLI:** `pnpm -s` não existe mais ("unexpected argument"); usar `pnpm --silent` [O, 26/09/2026].
- **Nest 12 + Express 5:** erro do *body parser* (JSON malformado) chega ao filtro global de exceções como 400; `httpAdapter.setHeader` + `reply` mantém `application/problem+json` [O, teste `api.e2e.spec.ts`, 26/09/2026].
- **Ferramentas do CI (conferidas em 26/09/2026, releases oficiais):** gitleaks 8.30.1 (21/03/2026), osv-scanner 2.6.0 (14/09/2026), zizmor 1.30.1 (09/09/2026), oasdiff 1.32.1 (15/09/2026), Semgrep CE 1.178.0 (PyPI, 23/09/2026; roda no Windows pelo pip), Spectral 6.16.3 (03/08/2026). **A release do Spectral não publica checksum**: o SHA-256 fixado no CI é o calculado no download. Pelo npm, o Spectral traz ~240 pacotes (com `glob@7` e `inflight` obsoletos): preferir o binário [O].
- **osv-scanner:** não lê o campo antigo `licenses: [...]` do package.json (`busboy`, `streamsearch` saem como UNKNOWN); a correção é `PackageOverrides` no `osv-scanner.toml` [O].
- **zizmor:** as auditorias online (commit impostor, action vulnerável) usam `GH_TOKEN` [O].
- **openapi-typescript 7.13 + openapi-fetch 0.17:** o peer declarado é `typescript ^5.x`, mas gera e compila com o 6.0.3 [O, 26/09/2026].
- **Turborepo 2.11.4:** precisa do executável `pnpm` no PATH (não serve `corepack pnpm`); coleta telemetria anônima por padrão (`TURBO_TELEMETRY_DISABLED=1`).
- **Versões com menos de 1 dia em 25/09/2026** (fora do catálogo por isso): `@types/node` 24.19.0 (22:09 UTC), `ai` 7.0.116, `vitest` 5.0.2, `@nestjs/cli` 12.0.7.
- **Standard Webhooks:** o vetor do repositório oficial (segredo `whsec_MfKQ…`, id `msg_p5jX…`, timestamp 1614265330, corpo `{"test": 2432232314}`) dá `v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=` com HMAC-SHA256 sobre `id.timestamp.corpo` e a chave = base64 depois de `whsec_` [O, teste `standard-webhooks.spec.ts`, 26/09/2026].
- **Nest 12:** `NestFactory.create(App, { rawBody: true })` guarda o corpo cru em `req.rawBody` junto com o JSON já interpretado (necessário para verificar assinatura de webhook) [O, 26/09/2026].
- **Node `http.request` com `lookup`:** o `lookup` não é chamado quando o host é um IP literal (checar o IP antes) e, com `autoSelectFamily`, pode ser chamado com `{ all: true }` (devolver lista) [O, 26/09/2026].
- **@nestjs/swagger 12 + Zod 4:** `z.number().positive()` sai no OpenAPI 3.1 como `exclusiveMinimum: true` (forma do 3.0), que o Spectral reprova (`oas3-schema`); usar `.min(1)` [O, 26/09/2026, ERR-013].
- **oasdiff 1.32:** valor novo num `enum` de **resposta** é quebra (`response-property-enum-value-added`, nível ERR); campo de resposta como texto com `pattern` não é. Para listas que crescem (tipos de evento), resposta em texto aberto e enum só no pedido [O, 26/09/2026, ERR-015].
- **OpenTelemetry Collector contrib 0.161.0** (16/09/2026) [O, executado em 26/09/2026]: `otelcol-contrib validate --config` confere a configuração sem subir; o processador `redaction` com `allow_all_keys: true` e `blocked_values` troca o valor inteiro por `****`; no `transform`, `replace_pattern` usa `$$1` para o grupo. Checksum por arquivo: `<asset>.sha256` (não há arquivo único de checksums).
- **Imagem base** [O, registry do Docker Hub, 07/10/2026]: `node:24-bookworm-slim` = Node 24.21.0, refeita em 06/10/2026, índice `sha256:d6aa754f…7b20` (a anterior, de 19/09/2026, era `sha256:0e0ff40c…f9b6`). **A imagem oficial atrasa em relação ao Debian:** em 07/10/2026 o `perl-base` corrigido (5.36.0-7+deb12u4, avisos críticos) já estava no repositório de segurança do Debian e a imagem refeita na véspera ainda trazia o `deb12u3`; o Grype do CI acusa, e a saída é subir só o pacote no estágio final do Dockerfile até a base alcançar. Dá para conferir sem Docker, pelo registry: o índice da tag, a configuração (`NODE_VERSION`) e o `var/lib/dpkg/status` da camada mais nova que o tem. **Syft 1.52.0** e **Grype 0.119.0** (17/09/2026), checksums no arquivo `<nome>_<versão>_checksums.txt` da release. `pnpm sbom --sbom-format cyclonedx --lockfile-only` gera CycloneDX 1.7 sem precisar do store; `pnpm --filter <pkg> deploy --prod <dir>` do pnpm 12 funciona sem `injectWorkspacePackages` e leva os pacotes do workspace com os `files` deles.
- **Semgrep CE 1.178.0 no Windows** [O, 26/09/2026]: instala por `pip` num venv do Python 3.14 e roda com `PYTHONUTF8=1`, com o mesmo resultado do CI (229 regras). `zizmor` 1.30.1 idem (`--offline`).
- **Actions do CI (conferidas por `git ls-remote`):** `actions/checkout` v7.0.1 `3d3c42e`, `actions/setup-node` v7.0.0 `8207627`, `pnpm/action-setup` v6.1.0 `ea17c68` (suporte ao pnpm 12 desde essa versão).

### 15.2 Resposta em fluxo de eventos (Conversa, I10)

*Fontes: documentação oficial da Cloudflare (páginas "Connection limits" e "Error 524", atualizadas em 23/07/2026, lidas em 02/10/2026) e os testes da Conversa (`apps/server/test/db/conversa.spec.ts`), executados no Node 22.23 com Express 5.*

- **Cloudflare, entre ela e a origem** [O, 02/10/2026]: "Proxy Read Timeout" de **125 s** (erro 524; muda só no plano Enterprise, até 6.000 s), "Proxy Idle Timeout" de 900 s e "Proxy Write Timeout" de 30 s (sem mudança). Entre o navegador e a Cloudflare, a conexão HTTP/1.1 parada fecha em 400 s. As páginas não falam de fluxo de eventos (SSE). O número de 100 s, que aparece em textos antigos, não é o da página atual. Fontes: https://developers.cloudflare.com/fundamentals/reference/connection-limits/ e https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-5xx-errors/error-524/
- **Consequência no código:** a resposta da Conversa manda os cabeçalhos na hora (`flushHeaders`) e uma linha de comentário (`: segue`) a cada 15 s enquanto o modelo pensa: nem a Cloudflare nem outro proxy no caminho veem a origem parada.
- **Node + Express 5 (Nest 12, `@Res()`)** [O, testes de 02/10/2026]: o `close` da resposta dispara quando quem lê fecha a conexão antes do fim (o "Parar" da tela), e `writableFinished` diz se a resposta já tinha terminado. O tipo `ServerResponse` do `node:http` basta (o projeto não tem `@types/express`).
- **Ler o fluxo no navegador:** `EventSource` só faz GET; a mensagem vai por POST, então a tela lê com `fetch` e o leitor do corpo (`response.body.getReader()`), e "Parar" é `AbortController.abort()`.

---

## 16. Interface: padrões de mercado e plataforma web

*Verificado em 25/09/2026, para escolher o modelo de interface (`docs/ux-modelo-interface.md`); a §16.1 foi ampliada em 02/10/2026 (conversa com o assistente), antes do protótipo P5; a §16.7 (resultados em gráficos) é de 07/10/2026. Referências de layout mais amplas ficam no catálogo da skill `ui-ux-proprio` (`referencias/03-catalogo-mercado.md`, verificado em 24/09/2026).*

### 16.1 Como os produtos de marketing mostram agentes

- **HubSpot Agent Hub** (Spotlight de outono de 2026) **[O]**: os agentes ficam organizados pelo resultado que entregam, com **status ao vivo**; a **Agent Inbox** guarda o registro de cada execução e o resultado; há um marketplace de agentes. O Breeze Studio virou **Agent Builder** (23/07/2026, beta público) **[S]**. Agentes redigem e **enfileiram para revisão**; nada vai ao ar sem aprovação quando o fluxo exige **[S]**.
- **Triple Whale Moby Automations** (11/06/2026) **[O, via busca]**: o agente diz o que quer fazer e **enfileira cada ação para aprovação** antes de mexer na conta de anúncios (escalar, pausar, criativos).
- **Klaviyo Composer** (beta público 06/07/2026) **[O]**: o usuário descreve o resultado em linguagem natural e o agente monta a campanha (texto, público, horário) a partir dos dados; **não existe "enviar do jeito que está"**: tudo passa por revisão e aprovação.
- **Linear Agent** (24/03/2026) **[O]**: **Ctrl+K para comandos e Ctrl+J para a IA**, separados.
- **Painéis de agentes de código** (Claude Code na web, aba Agents do GitHub) **[O]**: lista de execuções à esquerda, detalhe à direita, **passos visíveis** e **corrigir o rumo no meio da execução**.
- O **ChatGPT Canvas** saiu do GPT-5.5 em 05/2026 **[S]**: interface de "documento ao lado do chat" não é garantia de padrão estável.
- **Consequência para o Liame:** a aprovação é o centro (fila com motivo, antes e depois, risco e prazo); os agentes aparecem como **equipe com status ao vivo e histórico**; a IA conversa num painel próprio (Ctrl+J), sem substituir as telas de operação.

**Conversa com o assistente (pesquisado em 02/10/2026, antes do protótipo P5, `mockups/prototipo-conversa.html`):**

- **HubSpot Breeze Assistant** **[O]** (base de ajuda, atualizada em 16/09/2026): abre pela barra do topo, num **painel** que pode ir a tela cheia; a resposta traz **citações numeradas** (o detalhe aparece ao passar o cursor; o clique leva ao registro) e uma seção **Sources** com tudo o que foi usado; um painel de contexto mostra arquivos, conectores e memórias da conversa; histórico ligado por padrão; polegar para cima e para baixo; limite de uso documentado (na geração de conteúdo, 30 por minuto e 1.000 por dia).
- **Shopify Sidekick** **[O]**: conversa em qualquer página do admin, no computador e no celular; **mostra a mudança para revisão antes de aplicar**; tarefa longa segue em segundo plano e avisa quando está pronta para revisão. No admin novo (blog oficial, 24/09/2026), o campo fica **no pé de toda página** para perguntas curtas e **abre o painel lateral** para trabalho longo.
- **Google Ads Advisor** **[O]** (anúncio oficial, 11/2025): fica dentro da conta e, **com a revisão e a aprovação do anunciante**, aplica a mudança que sugeriu. Chegou a todas as contas em inglês em 12/2025 **[S]**.
- **Meta AI Business Assistant** **[S]** (imprensa, 24/04/2026): liberado a todos os anunciantes no Gerenciador de Anúncios, no Business Suite e na central de suporte; responde perguntas de conta e de campanha em linguagem comum. Em teste desde o fim de 2025 **[O]**. Atendimento em português: **[NC]**.
- **Intercom Fin** **[O]** (novidades do produto, 11/07/2025): selo **"AI Agent"** ao lado do nome **em cada mensagem**, ligado nas configurações; oferece passar para uma pessoa quando o cliente pede ou em assunto de risco, levando a conversa junto **[S]**.
- **Triple Whale Moby** **[S]** (a base de ajuda recusou a leitura automática em 02/10/2026): responde perguntas sobre os dados com tabelas e gráficos dentro da conversa, mostra a consulta que fez, tem um modo rápido e um de investigação, e guarda o histórico.
- **Consequência para o P5:** (1) a conversa fica **ao lado do trabalho**, num painel, e não numa tela à parte; (2) **toda resposta diz de onde veio** (citação por número e lista de fontes); (3) o assistente **prepara e uma pessoa aprova** antes de qualquer mudança; (4) a marca de IA aparece **em cada mensagem**, não só no topo; (5) há caminho para uma pessoa; (6) o limite de uso é dito na tela.

**Equipe, prontidão e autonomia (pesquisado em 02/10/2026, antes do protótipo P7, `mockups/prototipo-equipe.html`):**

- **HubSpot Agent Hub** **[O, via busca]** (Spotlight do outono de 2026): uma tela com todos os agentes de marketing, vendas e atendimento: o que está ativo, o que está fazendo e o que produziu. O conhecimento que eles leem fica em outro lugar (Context Home).
- **Salesforce Agentforce** **[S]** (Agentforce 3, 06/2025, e a observabilidade que veio depois): saúde de cada agente, desempenho ao longo do tempo, assuntos e ações que não funcionam, registro de cada interação e alerta de erro; o custo não entra na otimização.
- **Google Ads, aplicar recomendações automaticamente** **[O]** (ajuda): o anunciante liga **por tipo de recomendação** (ou em pacotes); a aba de histórico mostra quando cada tipo foi ligado e por quem, quantas vezes foi aplicado na semana e a última vez; desliga por tipo, a qualquer momento.
- **Intercom Fin** **[S]**: o agente é medido pela taxa de resolução, por uma nota de qualidade de cada conversa e pelo custo por resolução.
- **Consequência para o P7:** a equipe numa tela, com o que cada um faz, está fazendo e já fez; autonomia **por tipo de ação**, ligada por uma pessoa, com o histórico de quem ligou e quando, e desligável a qualquer momento (como no Google); cada funcionário com o acerto e o custo; e o motivo de ainda não poder fazer mais, à vista.

**Pedido de mudança em anúncio, verba do mês e desfazer (pesquisado em 04/10/2026, antes do protótipo P9, `mockups/prototipo-anuncios.html`):**

- **Google Ads, relatório de orçamento** **[O]** (support.google.com/google-ads/answer/9962086, "About your budget report"): ajuda a ver "how much you're projected to pay at the end of the month"; acima do gráfico, três números: o **limite de gasto mensal** ("the maximum amount you can pay for a campaign over a month"), a **previsão do mês** ("projected total costs for the month based on your average daily budget") e o **custo até a data**; no gráfico, o limite é a linha cinza, o custo até a data é a linha azul e a previsão é a pontilhada; as mudanças de orçamento aparecem marcadas no dia em que foram feitas.
- **Google Ads, histórico de alterações** **[O]** (support.google.com/google-ads/answer/2454137, "Review your account history"): "You can undo most types of changes that were made in the last 30 days"; "Undoing a change reverts the change to its previous state"; não dá para desfazer quando um item ligado à mudança foi removido ou quando outra pessoa já desfez, e a linha passa a dizer "Changes can't be undone".
- **Triple Whale Moby** (já acima): cada ação do agente na conta de anúncios entra numa fila e espera aprovação.
- **Consequência para o P9:** (1) a mudança é um **pedido com antes e depois**, e depois de aprovada a tela mostra o caminho (a plataforma validou, a mudança foi feita, a leitura de conferência); (2) a **verba do mês** mostra os três números que o Google mostra (o teto, o gasto até a data e a previsão), numa barra; (3) **desfazer devolve ao estado anterior** e diz quando não dá, porque alguém mexeu depois; no Liame, a volta é um pedido novo, com a mesma aprovação (D-A4-14); (4) as mudanças do mês ficam numa lista, cada uma com a situação de hoje.

**A peça gerada: conferir, aprovar e levar para a campanha (pesquisado em 04 e 05/10/2026, antes do protótipo P10, `mockups/prototipo-criativos.html`):**

- **Meta Advantage+ creative** **[O]** (facebook.com/business/ads/meta-advantage-plus/creative, página em português): a geração mora dentro do fluxo de criar o anúncio (gerar e expandir imagem, plano de fundo, animar, gerar texto); "Você pode ver uma prévia de alguns exemplos do seu criativo gerado e aprimorado por IA antes de publicá-lo"; a Meta recomenda conferir e aprovar as prévias e deixa desligar cada opção; "Os recursos que usam IA exibirão um logotipo de IA abaixo do nome do recurso".
- **Google Ads Asset Studio** **[O]** (support.google.com/google-ads/answer/16456563): um lugar só para criar, editar, guardar e compartilhar recursos; parte de texto, de imagens do produto ou das diretrizes da marca; gera títulos, descrições, imagens e vídeos e edita por texto (trocar o fundo, pôr e tirar objeto, estender a borda); salva na biblioteca e leva para campanha nova ou existente. O rótulo de IA é escolha do anunciante, recurso por recurso ("Label this asset as created or edited with AI"; support.google.com/google-ads/answer/17140115), e o Google grava SynthID e C2PA no que ele gera.
- **Adobe GenStudio for Performance Marketing** **[O]** (experienceleague.adobe.com/en/docs/genstudio-for-performance-marketing/user-guide/guidelines/brand-validation): cada variação passa por conferências contra as diretrizes da marca, as do canal (Meta) e as de acessibilidade, com o percentual do que passou; "Reviews and Approvals" manda as variações para quem aprova antes de salvar ou exportar.
- **Pomelli (Google Labs)** **[O]** (blog.google/innovation-and-ai/models-and-research/google-labs/pomelli): lê o site e tira o "Business DNA" (tom de voz, fontes, imagens e paleta), propõe ideias de campanha e entrega um conjunto de peças da marca, que a pessoa escolhe e edita. Beta em poucos países, sem o Brasil.
- **Consequência para o P10:** (1) a peça parte **do que a empresa já tem** (a oferta e a voz de Minha marca, a foto de verdade e o anúncio que mais vendeu), e não de um campo vazio, como no Pomelli; (2) **cada peça traz a conferência dela**, item por item e com o motivo, como no GenStudio, e a aprovação acontece antes de a peça sair do produto; (3) **a prévia vem antes de publicar** e a marca de IA fica à vista, como na Meta e no Google; (4) a peça aprovada vai para uma **biblioteca**, de onde vira campanha, como no Asset Studio; no Liame, a campanha nasce pausada e é um pedido com aprovação (D-A4-3).

**A mensagem para aprovar: público, custo e o que fica de fora (pesquisado em 08/10/2026, antes do protótipo P15, `mockups/prototipo-mensagens.html`):**

- **Braze, aprovação de campanhas** **[O]** (documentação, `braze.com/docs/user_guide/messaging/governance/approvals`, lida em 08/10/2026): a última etapa do editor é um resumo, e a aprovação é **por seção**: "Messages", "Delivery", "Target Audience" e "Conversion Events". Cada seção nasce como "Pending Approval"; aprova quem tem a permissão "Approve and Deny Campaigns". **Qualquer mudança depois da aprovação zera todas as aprovações ao salvar** ("any subsequent changes made to the Campaign reset all approval statuses when saved"). O fluxo vem desligado e é ligado nas configurações.
- **Klaviyo, quem recebe e quem fica de fora** **[O]** (central de ajuda, artigo 115005258268, atualizado em 13/01/2026; e o resultado da busca para a contagem esperada **[O, por trecho]**): antes do envio, a tela mostra os **destinatários esperados**, já sem os descadastrados e os suprimidos. No envio, perfis são **pulados** por motivo: descadastro, reclamação de spam, endereço inválido, exclusão manual, **Smart Sending** (quem recebeu outra mensagem dentro do período de descanso) e, no SMS, falta de saldo. Depois do envio, o relatório da campanha mostra quantos foram pulados e por quê.
- **Meta, preço das mensagens do WhatsApp** **[O]** (`developers.facebook.com/documentation/business-messaging/whatsapp/pricing`, lida em 08/10/2026): desde **01/07/2025** a cobrança é **por mensagem**, e só da mensagem **entregue**. Categorias: marketing, utilidade, autenticação e serviço. Dentro da janela de atendimento aberta, mensagem que não é modelo é grátis e modelo de utilidade também; **modelo de marketing é cobrado mesmo dentro da janela**. O preço depende da categoria e do código de país do número de quem recebe. Há desconto por volume para utilidade e autenticação; **para marketing, não**. O real (BRL) é moeda de cobrança. **Não conferido** [NC]: a data de vigência da tabela de preços atual (duas leituras da mesma página deram 01/07/2026 e 01/10/2026) e o valor por mensagem no Brasil: conferir na tabela oficial antes de mostrar preço na tela; o Liame mostra o custo que o RegemCast estimar, e não um preço próprio.
- **RegemCast, o que ele já devolve** **[O]** (`docs/mcp.md` e `mcp.leitura.ts`, commit `e88ae59`): quantas pessoas de um público **podem receber** (quem pediu para sair ou não tem WhatsApp já está fora), quantas estão **em descanso** (receberam marketing há pouco e ficariam de fora), o **custo estimado como teto** ("a Meta só cobra a mensagem entregue"), os tetos de gasto por dia, semana e mês com o que já saiu, e, por campanha, as falhas por motivo com o que fazer.
- **Consequência para o P15:** (1) o pedido de mensagem mostra **quatro coisas à vista**, como as seções do Braze: a mensagem como a pessoa vai ver, quem recebe, quando sai e quanto custa; (2) **quem fica de fora aparece antes**, com o motivo e a contagem (pediu para sair, em descanso), e não só depois do envio; (3) o custo é **estimativa e teto**, com a frase de que a Meta só cobra a mensagem entregue, ao lado do teto de gasto que o dono definiu no RegemCast; (4) **mudou o texto, o público ou o horário, a aprovação não vale mais** (no Liame, a aprovação já é amarrada ao plano); (5) depois do envio, a lista mostra enviadas, entregues, lidas, quem respondeu e as falhas por motivo; (6) **mensagem enviada não volta**: o pedido diz isso antes da aprovação, e a volta possível é pausar o que ainda não saiu.

### 16.2 Plataforma web (Baseline)

| Recurso | Situação | Primeiras versões | Uso no Liame |
| --- | --- | --- | --- |
| View Transitions (mesmo documento) | Baseline recente desde **14/10/2025** **[O]** | Chrome 111, Edge 111, Safari 18, Firefox 144 | troca de tela, morph cartão → plano, lista que se reorganiza, tema |
| `<ViewTransition>` do React | estável no **React 19.3 (09/09/2026)** **[O]** | — | no Next 16, o modo por classe (entrada/saída) não dispara na navegação do App Router; **só o modo por nome (morph)** chama a transição (issue #37614) **[O]** |
| `@starting-style` | Baseline recente desde **06/08/2024** **[O]** | Chrome 117, Firefox 129, Safari 17.5 | entrada de diálogo e popover sem JS |
| `light-dark()` | Baseline recente desde **13/05/2024**; ampla em 13/11/2026 **[O]** | Chrome 123, Firefox 120, Safari 17.5 | tokens de tema claro e escuro num só lugar |
| Container queries (tamanho) | Baseline ampla desde **14/08/2025** **[O]** | Chrome 105, Firefox 110, Safari 16 | cartões e painéis se ajustam quando a LIA abre ao lado |
| `inert` | Baseline ampla desde **11/10/2025** **[O]** | Chrome 102, Firefox 112, Safari 15.5 | gaveta e LIA em tela cheia prendem o foco |
| Animação por rolagem | **não é Baseline**: o Firefox 152 (06/2026) ainda exige flag; Safari 26 e Chromium suportam **[S]** | — | só melhoria progressiva, nunca para mostrar conteúdo |
| Saída animada do `<dialog>` | depende de `overlay` + `transition-behavior: allow-discrete` **[NC]** | — | sem suporte, o diálogo só fecha sem animação |

### 16.3 Regras que viram código

- Todo movimento desliga com `prefers-reduced-motion`; conteúdo nunca espera animação para aparecer.
- Morph de elemento entre telas no Next 16: usar **nome** no `<ViewTransition>`, não classe de entrada e saída (issue #37614).
- Aprovação vale para **uma versão do plano**: ajustou o valor, muda a versão e o hash, e a aprovação é nova.
- Dica de gráfico **complementa, nunca esconde**: o valor também aparece em texto ou tabela.
- Cor de texto derivada para contraste AA no tema claro (ciano e violeta da marca são fundo e destaque; ver `docs/ux-modelo-interface.md` §6).

### 16.4 Dossiê da marca nos produtos de marketing

*Pesquisado em 02/10/2026, antes do protótipo P6 (`mockups/prototipo-marca.html`).*

- **HubSpot Brand Voice** **[O]** (base de ajuda, atualizada em 14/09/2026): gerada a partir de textos de exemplo (pelo menos 500 palavras) e do conteúdo do site; a pessoa escolhe até quatro características, a missão, os termos a evitar e as regras de inclusão; **gerar de novo substitui a anterior**, sem histórico; fica em Marketing › Brand › Brand Voice. Em 06/2026 a página de marca passou a ter três partes, Brand Kit, Brand Voice e **Brand Knowledge** (produtos, concorrentes, cliente ideal), usadas pela IA **[O, via busca]**.
- **Klaviyo** **[O]** (ajuda, 06/08/2025): Conteúdo › Imagens e marca › Voz; **descritores de voz** com exemplos e **regras de escrita** com quando valem; a Klaviyo sugere os dois a partir dos e-mails já enviados, e a pessoa ajusta. O Composer usa a voz, as regras de conteúdo e as de conformidade **[S]**.
- **Jasper IQ** **[S]**: voz, guia de estilo (com as "palavras proibidas"), base de fatos e públicos num mesmo contexto que toda geração lê.
- **Canva** **[S]**: voz da marca no Brand Kit (missão, tom), usada pelo gerador de texto ("gerar nesta voz").
- **Consequência para o P6:** separar **como fala** (voz, com exemplos e regras) dos **fatos** (produtos, ofertas, provas, região, datas) e das **regras** (o que não pode dizer); a IA **sugere a partir do que já existe** e a pessoa confere antes de valer; ao contrário da HubSpot, **guardar as versões** e permitir voltar a uma anterior, como o plano pede.

### 16.5 Calendário comercial do Estrategista

*Conferido em 02/10/2026, antes do protótipo P8 (`mockups/prototipo-resumo.html`).*

- **Feriados nacionais** **[O, via busca]**: Lei 662/1949 com a redação da Lei 10.607/2002 (1º/1, 21/4, 1º/5, 7/9, **2/11**, **15/11** e **25/12**); Lei 6.802/1980 (**12/10**, Nossa Senhora Aparecida, o mesmo dia do Dia das Crianças no varejo); Lei 14.759, de 21/12/2023 (**20/11**, Dia Nacional de Zumbi e da Consciência Negra).
- **Em 2026** (pelo calendário): 12/10 é segunda; 2/11, segunda; 15/11, domingo; 20/11, sexta; 25/12, sexta.
- **Black Friday de 2026: 27/11** (a sexta depois do Dia de Ação de Graças dos EUA), e a Cyber Monday em 30/11 **[S]**.
- **Feriado estadual e municipal** muda de lugar para lugar: entra pelo endereço da loja, quando houver, e não pela tabela nacional **[NC]**.
- **Consequência para a I11:** as datas que o Estrategista usa vêm de uma **tabela do sistema** (feriados nacionais e datas do varejo, cada uma com a fonte), nunca da memória do modelo; o modelo só escolhe quais datas usar e o que fazer em cada uma.
- **Na tabela (I11, 03/10/2026):** `commercial_date` (migration 0035) tem 31 datas, de 12/10/2026 a 31/12/2027. As datas do varejo de 2027 foram calculadas pela regra de cada uma e conferidas por script **[S]**: Carnaval em 09/02 (a terça 47 dias antes da Páscoa), Páscoa em 28/03, Dia das Mães em 09/05 (segundo domingo de maio), Dia dos Pais em 08/08 (segundo domingo de agosto), Black Friday em 26/11 e Cyber Monday em 29/11. Carnaval não é feriado nacional: entra como data do varejo. **Renovar a semente antes de dezembro de 2027** (migration nova com 2028), ou o plano de 90 dias fica sem datas.

### 16.6 Leitura de páginas pelo Pesquisador

*Conferido em 03/10/2026, antes da I12.*

- **SSRF, quando o destino é qualquer site informado pela pessoa** **[O]** (OWASP, *Server-Side Request Forgery Prevention Cheat Sheet*, caso 2):
  - só `http`/`https`;
  - resolver **todos** os endereços do nome (A e AAAA) e recusar os privados, de loopback, link-local e o de metadados (`169.254.169.254`), na hora da conexão, contra DNS rebinding;
  - "don't forget to disable the support for redirection" no cliente;
  - limitar o tamanho e o tipo da resposta, não devolver a resposta crua a quem pediu, e usar tempo máximo.
  - Fonte: cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html.
- **robots.txt (RFC 9309)** **[O]**:
  - vale para "automated clients known as crawlers" e "These rules are not a form of access authorization";
  - o grupo do robô é achado pelo nome do produto, sem diferenciar maiúsculas; vale a regra mais específica (a de mais octetos);
  - resposta 4xx: "the crawler MAY access any resources"; 5xx ou fora do ar: "MUST assume complete disallow";
  - não usar a cópia guardada por mais de 24 horas;
  - ler pelo menos 500 KiB do arquivo e seguir pelo menos 5 redirecionamentos dele.
  - Fonte: rfc-editor.org/rfc/rfc9309.
- **Dado pessoal de acesso público (LGPD, art. 7º, §§ 3º, 4º e 7º)** **[S]** (Serpro, "Dados públicos — LGPD"; o texto da lei no Planalto não abriu nesta conferência):
  - o tratamento considera "a finalidade, a boa-fé e o interesse público" que justificaram a disponibilização;
  - o que o titular tornou manifestamente público dispensa novo consentimento, preservados os direitos e os princípios.
- **Consequência para a I12:**
  - o Pesquisador lê só a página que a empresa informa (site, cardápio, concorrente; D-A3-8);
  - respeita o robots.txt pelo nome `Liame`;
  - **não guarda a página**, só os rótulos conferidos (produtos e preços, ofertas, diferenciais);
  - tira dado pessoal antes do modelo e de gravar;
  - o redirecionamento só é seguido depois de conferir o destino de novo.

### 16.7 Resultados em gráficos, com menos texto

*Pesquisado em 07/10/2026, a pedido do dono ("apresentar resultados em formas de gráficos, para reduzir excesso de textos"), antes do estudo `mockups/prototipo-graficos.html`. A tela de Resultados no modo simples não tinha nenhum gráfico: três faixas de aviso e seis cartões em frases.*

- **Shopify, painel de análises** **[O]** (help.shopify.com, "Overview dashboard", e shopify.dev, componente `metric-card`; abertos em 07/10/2026): cartões de métrica que a pessoa adiciona, tira, reordena e redimensiona; o cartão compacto traz "the headline value, a percent-change indicator, and a small sparkline"; a comparação é com o período anterior (`COMPARE TO previous_period`).
- **Stripe, página inicial** **[S]** (support.stripe.com, pela busca em 07/10/2026): gráficos com o período anterior à esquerda e o atual à direita; a pessoa escolhe os blocos.
- **Plausible** **[O]** (plausible.io/docs/guided-tour, aberto em 07/10/2026): uma página só; "click on a particular metric to display it in the top graph"; listas em ordem (fontes, páginas), com a opção de expandir.
- **Triple Whale, resumo** **[S]** (kb.triplewhale.com; a página recusou a leitura automática em 07/10/2026): o retorno dos anúncios de todas as plataformas num bloco, tendência em cada cartão, clique para a barra com o período anterior, e os principais fixados no topo.
- **Gráfico de bala** (Stephen Few, 2005) **[S]** (en.wikipedia.org/wiki/Bullet_graph): uma medida contra uma meta, com faixas em tons do mesmo cinza, no lugar do velocímetro. É o desenho da barra do teto da Verba do mês.
- **Google Analytics, Insights** **[O]** (support.google.com/analytics/answer/9443595, aberto em 07/10/2026): cartões na página inicial com o que mudou, automáticos ("detects unusual changes or emerging trends in your data") ou por condição da pessoa.
- **Apple, Tendências** **[S]** (macworld.com e a ajuda da Apple, pela busca em 07/10/2026): uma seta para cima ou para baixo (os 90 dias mais recentes contra os 365), e o gráfico só no toque.
- **Nielsen Norman Group, "Dashboards: Making Charts and Graphs Easier to Understand"** **[O]** (nngroup.com/articles/dashboards-preattentive, Page Laubheimer, 18/06/2017; aberto em 07/10/2026): comprimento e posição em duas dimensões se leem mais rápido ("we are quite adept at estimating how lengths compare"); área e ângulo, não: pizza, rosca, mapa de árvore e velocímetro são ruins para comparar; cor só reforça o que outra forma já diz.
- **Consequência para o estudo:** três caminhos (o painel de indicadores, tradicional; uma pergunta por cartão respondida com um desenho, moderno e recomendado, **escolhido pelo dono em 07/10/2026**; o resumo que conta a semana com setas, inovador). No recomendado, cada cartão fica com um desenho e uma frase: o número principal com duas barras na mesma escala, a receita dividida numa barra (custo dos produtos, anúncios, o que sobrou), cada campanha como barra para a direita (sobrou) ou para a esquerda (faltou) com o selo em palavra, e a origem dos pedidos numa barra dividida. Quase tudo sai do que `GET /v1/results/closed-loop` já devolve; **a linha por dia pede uma série diária no servidor**, que hoje não existe.
- **Cores conferidas com o validador da skill dataviz (07/10/2026):** o foco (`#009AAA`) ao lado do cinza de contexto (`#7E8499`) numa barra empilhada **não separa** (ΔE 2,7 com deuteranopia e 9,9 na visão comum, abaixo do piso de 15): os dois têm claridade parecida. Na ordem **foco · cinza claro · cinza escuro** a separação passa com folga (16,5 e 22,5 no claro; 22,3 e 24,7 no escuro), com `#C3C6D2` e `#6B7189` no claro e `#454B6C` e `#9AA0B4` no escuro. O cinza claro fica abaixo de 3:1 contra o cartão: por isso o valor de cada parte vai escrito embaixo da barra.

---

## 17. Acesso, ciclo de vida, versões de API e modelos de mídia

*Verificado em 25/09/2026, para os itens novos do plano (ADR-013 a ADR-016); a §17.4 ganhou os fornecedores de imagem em 05/10/2026, e a §17.6 (armazenamento de imagens) é do mesmo dia.*

### 17.1 Autenticação

- **NIST SP 800-63B-4** **[O]**:
  - "Email SHALL NOT be used for out-of-band authentication": código por e-mail não é segundo fator;
  - SMS/telefone é autenticador **restrito** (exige alternativa sem restrição, aviso ao usuário e plano de migração);
  - app de código (TOTP) é aceito em todos os níveis, mas não resiste a phishing;
  - autenticadores sincronizáveis (passkeys) são aceitos, com requisitos.
- **Logto** **[O, via busca]**: MFA com app autenticador (TOTP), passkeys (WebAuthn), código por e-mail, SMS e **10 códigos de recuperação** gerados ao configurar o fator.
- **Regra do Liame:** e-mail é identidade e recuperação; o segundo fator de quem mexe em dinheiro é o app autenticador (ADR-013).
- **Tela de entrada e de código** *(verificado em 26/09/2026)*:
  - **NIST SP 800-63B-4 §3.1.1.2** **[O]**: o verificador **SHOULD** permitir colar a senha (gerenciador de senhas) e **SHOULD** oferecer mostrar a senha enquanto é digitada; outras regras de composição **SHALL NOT** ser impostas. §3.1.4.2: OTP aceito **uma vez só** enquanto válido, com limite de tentativas. Fonte: pages.nist.gov/800-63-4/sp800-63b.html.
  - **WCAG 2.2 SC 3.3.8 (Autenticação acessível, mínimo)** **[O]**: nenhum passo pode exigir teste cognitivo sem alternativa; colar e preencher pelo gerenciador de senhas satisfazem o critério; **bloquear colar no campo do código**, ou dividir o código em caixas em que o colar só preenche um dígito, reprova. Fonte: w3.org/WAI/WCAG22/Understanding/accessible-authentication-minimum.html.
  - **Google (verificação em duas etapas)** **[O]**: oferece prompts, chaves de acesso, app de código, SMS e **códigos de reserva de 8 dígitos**; "não perguntar de novo neste computador" só em aparelho próprio. Fonte: support.google.com/accounts/answer/185839.
  - **Stripe** **[O, via busca]**: app autenticador por QR ou "digitar a chave"; **código de reserva mostrado uma vez**; na entrada, "entrar de outro jeito" → código de reserva. Fonte: support.stripe.com/topics/two-step-authentication.

### 17.2 Guarda e expurgo

- **Marco Civil, art. 15** **[O desde 25/09/2026, §6.1; antes S]**: provedor de aplicação com fins econômicos guarda os **registros de acesso por 6 meses**, em sigilo e ambiente seguro; ordem judicial pode pedir mais. Provedor de conexão guarda 1 ano (art. 13).
- **LGPD** (§6): eliminação ao fim do tratamento, com as exceções do art. 16.
- **Técnica adotada:** crypto-shredding (destruir a chave do tenant) para o expurgo alcançar os backups (ADR-014).

### 17.3 Mudanças de API

- **RFC 9745** (março de 2025, Standards Track) **[O, via busca]**: cabeçalho `Deprecation`, com a data em que o recurso fica depreciado (data estruturada, `@<epoch>`).
- **RFC 8594**: cabeçalho `Sunset`, com a data em que deixa de funcionar (HTTP-date). Os dois formam o ciclo depreciação → fim.
- **Meta Graph API** **[S]**: 3 a 4 versões por ano; v26 em 29/07/2026. As datas de expiração **divergem entre fontes secundárias e a oficial** (§2.1): só a página oficial de versões vale.
- **Consequência:** Vigia de integrações (ADR-015).

### 17.4 Geração de mídia

- **AI SDK** **[O]**:
  - `generateImage` é estável;
  - `experimental_generateVideo` é experimental (a API pode mudar), assíncrono, com polling e webhook;
  - provedores de vídeo listados: Google/Vertex (`veo-3.1-generate-001`), Kling (v2.6), xAI (`grok-imagine-video`), Black Forest Labs (`flux-3-video`), fal (Luma Ray 2, MiniMax) e Replicate.
- **Modelos de imagem, set/2026** **[S]**:
  - GPT Image 2 / 2.5 (OpenAI), Nano Banana 2 / Pro (Gemini 3.1 Flash Image), FLUX.2, Ideogram 3 / 4 (melhor texto dentro da arte), Midjourney v8.2;
  - cerca de US$ 0,02 a 0,24 por imagem, conforme resolução e qualidade; lote pela Batch API corta cerca de 50%;
  - só o Adobe Firefly oferece indenização de propriedade intelectual.
- **Fornecedores de imagem para o eval da X7** *(páginas oficiais lidas em 04 e 05/10/2026)*:
  - **OpenAI** [O] (developers.openai.com): modelos `gpt-image-2.5-sunburst` (edição precisa) e `gpt-image-2.5-flare` (rápido); tamanhos de 1.024 × 1.024 a 3.840 pixels de lado; todo pedido e toda imagem passam por moderação (erro `moderation_blocked`); "the model can still struggle with precise text placement and clarity"; preço por 1 milhão de tokens (texto US$ 5, imagem de entrada US$ 8, saída de imagem US$ 30), com 50% a menos em lote: a página não traz preço por imagem; os dados não treinam os modelos por padrão, e os registros de abuso ficam até 30 dias; residência de dados sem o Brasil; a marca de origem é verificada pela Content Provenance API (C2PA e SynthID), mas o guia de geração não diz que a imagem da API sai com C2PA [NC];
  - **Google** [O] (ai.google.dev): Nano Banana 2 Lite (`gemini-3.1-flash-lite-image`), Nano Banana 2 (`gemini-3.1-flash-image`) e Nano Banana Pro (`gemini-3-pro-image`); "All generated images include a SynthID watermark"; proporções de 1:1 a 21:9, incluídas 4:5 e 9:16; no nível pago, US$ 0,067 por imagem de 1K no Nano Banana 2 e US$ 0,0336 no Lite, com metade em lote; no nível pago, "Content not used to improve our products"; sem nível gratuito para imagem;
  - **Black Forest Labs (FLUX)** [O]: preços em docs.bfl.ai/quick_start/pricing (FLUX 3 Image a US$ 0,048 por imagem de cerca de 1 megapixel); **fica fora do catálogo**: os termos da API (bfl.ai/legal/flux-api-service-terms, de 04/08/2026) dizem "the Company may use Inputs and Outputs to train and improve its artificial intelligence models", sem saída nos termos (a política de privacidade manda pedir por e-mail e não vale para contrato de empresa), e a D-A4-9 só aceita quem não treina com o que é enviado;
  - **Adobe Firefly Services** [S, pela busca; termos de 23/04/2026]: não treina com o conteúdo do cliente, oferece indenização de propriedade intelectual a empresas no plano que a inclui e grava Content Credentials; **Ideogram** [S, pela busca]: os termos da API dizem que não usa entrada nem saída para treinar, salvo conteúdo sinalizado; de US$ 0,03 a US$ 0,10 por imagem. Conferir os dois na página oficial antes de entrarem no eval;
  - **Regra do Liame (D-A4-9 e proposta D-A4-28):** a imagem parte de uma foto de verdade do produto, enviada pela empresa (edição: fundo, luz e enquadramento), e sai **sem texto na arte**; vão ao fornecedor a foto e o pedido da peça, nunca dado de cliente.
- **Regra do Liame:** catálogo curado por finalidade, com eval, contrato de dados e custo conhecidos; Lite automático, Pro escolhe (ADR-016).

### 17.5 Acesso delegado no mercado

- **Google Ads** **[O, via busca]**: convite por e-mail em "Acesso e segurança", com nível escolhido; níveis Administrador, Padrão, Somente leitura e Somente e-mail; o acesso ao perfil de pagamentos é **separado** do acesso à conta. Quem convidou recebe aviso quando o convite é aceito.
- **Conta de administrador do Google Ads (MCC)** **[O, via busca]**: o cliente aceita o pedido de vínculo e pode desvincular a qualquer momento; cada conta de cliente tem **um único proprietário**; se a conta de administrador **cria** a conta do cliente, ela vira a proprietária.
- **Meta** **[O, via busca; detalhes em fontes secundárias]**: "acesso de parceiro" ao portfólio empresarial, com permissões parciais por ativo, sem entregar o login pessoal; só quem tem controle total do portfólio concede.
- **Perfil da Empresa no Google** **[O, via busca]**: proprietário principal, proprietários e administradores; só proprietários adicionam ou removem usuários; só o proprietário principal transfere a propriedade e não pode se remover antes de transferir.
- **Regra do Liame (ADR-017):** mesmo modelo de convite e níveis, mas **a conta é sempre do dono do negócio**, inclusive quando uma agência a cria.

### 17.6 Armazenamento de arquivos de imagem

*Páginas oficiais lidas em 05/10/2026, para o ADR-021 (onde ficam as fotos dos produtos e as imagens das peças).*

- **Amazon S3** [O] (docs.aws.amazon.com/AmazonS3/latest/userguide, páginas "Default encryption FAQ" e "Download and upload objects with presigned URLs"):
  - cifra em repouso: "Amazon S3 now applies server-side encryption with Amazon S3 managed keys (SSE-S3) as the base level of encryption for every bucket"; desde 05/01/2023, "at no additional cost";
  - URL assinada: usa a credencial de quem a gerou ("The credentials used by the presigned URL are those of the AWS Identity and Access Management (IAM) principal who generated the URL"); com usuário IAM e Signature Version 4, vale até 7 dias; "presigned URLs are bearer tokens that grant access to those who possess them"; a política do bucket pode recusar assinatura velha com a condição `s3:signatureAge` (o exemplo oficial usa 10 minutos);
  - preço em São Paulo (`sa-east-1`), pela lista pública de preços da AWS (`pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonS3/current/sa-east-1/index.json`, publicada em 28/09/2026) [O]: S3 Standard a US$ 0,0405 por GB por mês nos primeiros 50 TB; US$ 0,007 por 1.000 pedidos de gravação (PUT, COPY, POST, LIST) e US$ 0,0056 por 10.000 de leitura; saída para a internet a US$ 0,15 por GB até 10 TB (lista `AWSDataTransfer`, de 16/09/2026), com os primeiros 100 GB do mês sem custo ("Data Transfer from AWS Regions to the Internet is now free for up to 100 GB of data per month", desde 01/12/2021, no blog da AWS).
- **Supabase Storage** [O] (supabase.com/docs/guides/storage e /guides/platform/backups):
  - fala o protocolo S3 ("You can use almost any S3 client to interact with your Storage objects"), com Signature Version 4 e URL assinada por parâmetros de consulta; sem versões: "Deleted objects are permanently removed and cannot be restored";
  - as chaves S3 do projeto "provide full access to all S3 operations across all buckets and bypass RLS policies" e são "Intended exclusively for server-side use"; a alternativa é o token de sessão de um usuário, que passa pela RLS;
  - tamanho máximo do arquivo: 50 MB no plano gratuito e 500 GB no Pro; armazenamento incluído: 1 GB no gratuito e 100 GB no Pro e no Team, depois US$ 0,0213 por GB;
  - "Database backups do not include objects you store via the Storage API, as the database only includes metadata about these objects".
- **Backblaze B2** [O] (backblaze.com/cloud-storage/pricing e backblaze.com/docs/cloud-storage-data-regions, 05/10/2026): "$6.95 / TB / mo"; "First 10GB storage is always free"; saída grátis até 3 vezes o armazenado no mês, depois US$ 0,01 por GB; chamadas das classes A, B e C sem custo. Regiões, escolhidas na criação da conta: US West, US East, EU Central (Amsterdã) e CA East (Toronto). **Sem América do Sul.**
- **Cloudflare R2** [O] (developers.cloudflare.com/r2/pricing e /r2/reference/data-location): US$ 0,015 por GB por mês; operações de classe A a US$ 4,50 e de classe B a US$ 0,36 por milhão; saída para a internet grátis; 10 GB por mês sem custo. **Sem América do Sul:** as dicas de local são `wnam`, `enam`, `weur`, `eeur`, `apac` e `oc` ("a best effort and not a guarantee"), e as jurisdições, que garantem onde o objeto fica, são `eu`, `fedramp` e `us`.
- **O que a Meta aceita de imagem** está na §2.1: JPG ou PNG, até 30 MB, largura mínima de 600 pixels no Feed do Facebook; a imagem entra por `POST /act_{id}/adimages`, em bytes.
- **Regra do Liame (ADR-021, aceito em 05/10/2026; a construção fica para o fim do roadmap):** as imagens ficam num bucket privado do S3 em São Paulo, na conta AWS que já guarda as chaves de criptografia; só o servidor fala com o bucket; a pessoa vê por URL assinada de 5 minutos; a imagem enviada é conferida pelo conteúdo e regravada sem metadados antes de ser guardada.

