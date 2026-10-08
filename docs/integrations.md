# Liame — Integrações

> Status: **aprovado pelo dono em 26/09/2026** (proposta de 24/09/2026). Fatos das plataformas pesquisados em 24/09/2026: **reconferir na hora de implementar** (LIC-021). O Connector Capability Registry guarda `verified_at` por capacidade.

## 1. Regras

1. **API oficial pela nossa camada de connectors.** Os MCPs oficiais das plataformas (Meta com escrita; Google e GA4 só leitura; TikTok com escrita) são complemento e referência, nunca o caminho de escrita. O Pipeboard (licença BSL) não pode ser embutido.
2. **Cada cliente no próprio portfólio e na própria conta de anúncio.** O SaaS entra como parceiro, sem meio de pagamento compartilhado, porque suspensão no Google contamina contas ligadas.
3. **"O usuário informa, a distribuição conclui."** O cliente só clica em "conectar" (OAuth). Os apps, segredos e configurações são da DMS.
4. **Nomes dos apps nas plataformas: DMS Tecnologia** (dmstecnologias.com), para a marca do produto não travar nem exigir refazer verificações. Os termos de uso e a política de privacidade exigidos nas revisões ficam em **agencialiame.com**.
5. Todo connector tem capability registry, contract tests com fixtures, circuit breaker, cotas por app × conta e escalonamento justo entre tenants.

## 2. Interface

Ver `arquitetura.md` §6. A escrita só acontece por `execute()` chamado pelo Action Service, com `validateOnly` quando o provider oferecer e **criação sempre pausada**.

**Escrita na Meta (A4, X1, 04/10/2026):** situação (ativar e pausar) e verba diária de campanha, conjunto e anúncio, por `POST /{id}` na versão do Capability Registry (`entity_update`), depois de ler o estado na Meta (`entity_state`) e de validar com `execution_options=["validate_only"]`. Mudança feita por uma pessoa na Meta nunca é sobrescrita; limite de uso adia a execução (base §2.1). Atrás da flag `meta_write`, desligada. **Autorização:** a permissão de gerenciar anúncios vem de uma segunda configuração do login (`META_LOGIN_CONFIG_ID_ESCRITA`), pedida só à empresa com a flag ligada; a de leitura não muda, e ao conectar de novo a autorização nova assume as contas. **Ferramentas (X2):** `orcamento_ajustar` (campanha com orçamento de campanha, ou conjunto), `campanha_pausar`, `conjunto_pausar`, `anuncio_pausar` e as três de retomar. Limites da política da distribuição na Meta: no máximo 10% da verba por pedido e 3 mudanças de verba por hora por objeto; aumentar e retomar só com o teto por ação e o envelope do mês da empresa. O Liame não cria nem apaga objeto e não toca o limite de gastos da conta (`spend_cap`).

## 3. Plataformas (MVP em negrito)

| Provider | Leitura | Escrita | Acesso e aprovação | Fase |
| --- | --- | --- | --- | --- |
| **Meta Marketing API** | insights, campanhas, públicos | criar/editar/pausar; `execution_options=validate_only`; `spend_cap` | Portfólio verificado (SISTER) + App Review com acesso avançado + Access Tier Full (500 chamadas em 15 dias, erro < 15%). Testes com os responsáveis do restaurante como **testadores do app**. Rate limit por app × conta; **4 mudanças de orçamento por hora por conjunto** | A2 (leitura) · A4 (escrita) |
| **Instagram / Facebook Pages / Threads** | insights, comentários | publicar (IG 100 por 24 h; Threads 250), responder | Acesso avançado; mídia em URL pública; IG só JPEG | A6 |
| **Meta CAPI** | — | eventos pelo servidor (dedup por `event_id`) | dataset do cliente | A5 |
| **Google Ads API** | GAQL | Search/AI Max, PMax, Demand Gen | **Sem developer token desde 09/09/2026**: acesso por projeto Cloud (Explorer 2.880 op/dia; Basic com verificação de marca; Standard com auditoria). OAuth `adwords` com verificação do app. `validate_only`: **INVESTIGAR** no spike | A2 (leitura) · A5 (escrita) |
| **Google Data Manager API** | o resultado de cada envio (`requestStatus:retrieve`) | conversões offline, Customer Match, enhanced conversions (saíram da Ads API em 2026). **No servidor desde 08/10/2026 (A5 · Y1, desligado):** a venda confirmada por clique, um evento por pedido de envio, com `validateOnly` antes | escopo `auth/datamanager`, pedido na autorização do Google só para a empresa com a flag `conversoes_google`; a ação de conversão `UPLOAD_CLICKS` escolhida por uma pessoa, numa lista lida da conta pela Google Ads API (`conversion_action`, escopo de leitura) | A5 |
| **GA4 Data/Admin** | relatórios | eventos-chave (Admin) | OAuth `analytics.readonly`; cota por propriedade | A2 |
| **Regem** | pedidos, itens, custo, clientes com consentimento, cupons, cardápio | cupom de campanha | **Pré-requisito C1** (token por loja; código fora do git) | A2.5 |
| **RegemCast** | status de mensagens (`wamid`), referral CTWA, opt-out | disparos com aprovação | **Pré-requisito C2** (API de serviço, idempotência, webhook de saída) | A2.5 (leitura) · A5 (escrita) |
| TikTok Ads + Events | relatórios | campanhas | cadastro e revisão do app; MCP oficial com escrita | A6 |
| TikTok Content Posting | — | publicação | sem auditoria só publica privado | A6 |
| YouTube, Google Business Profile, Search Console | métricas | upload/posts/avaliações | GBP: acesso restrito (perfil com 60+ dias, começa com 0 QPM) → **pedir na A0** | A6 |
| E-mail (SES/Resend), SMS (Zenvia) | — | envio | — | A5/A6 |
| **Banco Central (PTAX)** | cotação de venda do dólar, uma por dia útil | — | Dados abertos, sem credencial; licença ODbL (a tela cita a fonte e o dia); endereço fixo no código; o pedido leva só o período de datas (base §10.1) | A3 |
| LinkedIn, Pinterest, Microsoft, Snap, Spotify, Amazon, Mercado Ads, X | — | — | sob demanda | A8 |
| Canais sem API aberta (Kwai, portais, iFood Ads, influenciadores, rádio, mídia exterior) | — | **pacote pronto** + medição por UTM, cupom ou QR | — | A6+ |

**Depreciações a respeitar:** a Marketing API v24 expira em 06/10/2026 (nascer na versão mais nova disponível); ASC/AAC legados bloqueados; métricas antigas de Página substituídas por `views`; Content API for Shopping encerrada (Merchant API).

## 4. Webhooks

- **Entrada** (Meta, RegemCast, Regem, pagamentos): verificar assinatura → persistir cru → deduplicar por `external_event_id` UNIQUE → ACK → processar assíncrono.
- **Saída** (para parceiros): Standard Webhooks, CloudEvents, retry exponencial, DLQ, reenvio manual, painel por endpoint.

## 5. Pré-requisitos nos outros produtos DMS (trilha C, começa junto com a A1)

| # | Produto | O que precisa existir | Por quê |
| --- | --- | --- | --- |
| C1 | Regem | Recuperar ou recriar o **token de integração por loja** (migration 192, `LojaTokenGuard`, `X-Loja-Token`: **não estão no git**) + escopos de leitura de pedidos, itens, custo, clientes com consentimento e cupons | Ler o caixa do restaurante |
| C2 | RegemCast | Autenticação de serviço (`client_credentials` ou API key com escopo), `Idempotency-Key`, **webhook de saída** (status, opt-out, referral CTWA), envio com parâmetros de cabeçalho, botões e LTO | Conversas e mensagens no ciclo fechado |
| C3 | Regem | Eventos de saída (pedido confirmado, cliente novo, cupom usado); **captura de UTM e click id no cardápio público** até o pedido; consentimento com origem e prova; telefone único em E.164; data de nascimento; segmento desconhecido falhar fechado | Ligar clique → pedido |

Molde de autenticação de serviço da casa: o **Open Delivery do GoGeM** (OAuth `client_credentials`, escopos, eventos com confirmação).

## 6. Onde o ciclo fechado pode falhar e o que fazer

| # | Ponto de falha | Mitigação |
| --- | --- | --- |
| 1 | O número de WhatsApp do restaurante não está na API oficial (ex.: Evolution) → não chega o referral do anúncio | **Pré-condição do piloto:** número na Cloud API via RegemCast. **Pergunta aberta ao dono** |
| 2 | O link da conversa para o cardápio perde o click id | Link curto com token de atribuição (`t=`) que o cardápio persiste até o pedido (C3) |
| 3 | Telefone com e sem 55 quebra a identidade | Normalização E.164 única + `customer_ref` pseudonimizado |
| 4 | Pedido de iFood/99 não tem clique | Fica fora da atribuição de mídia própria, mostrado como canal separado |
| 5 | Venda no balcão sem identificação | Cupom por campanha, QR e identificação voluntária no PDV |
| 6 | Custo não cadastrado | `margin = null` + alerta de lacuna (nunca margem zero) |
| 7 | Janelas e fusos diferentes entre plataformas | Janela declarada em toda atribuição; fuso do negócio |
| 8 | Conversão reportada tardiamente | Modelo temporal de métricas (`observed_at`) |
| 9 | Divergência plataforma × caixa | Metric Authority Matrix + tela lado a lado, nunca "regra de quem vence" |
