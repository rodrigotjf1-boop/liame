# Liame — Plano da fase A2.5 · Ciclo fechado

> **Aprovado pelo dono em 29/09/2026** ("vamos seguir o projeto A2.5 até a conclusão"), com as decisões da seção 5, a D-A2.5-3 ajustada por ele (cupons puxados do Regem + criação pelo Liame + contrato de cupons com escopos documentado) e a integração **por REST agora, com as mesmas ferramentas e escopos no hub MCP da DMS quando ele existir** (ADR-008, ADR-019). A A2.5 é o diferencial (especificação §2): ligar o gasto em mídia ao **pedido, à receita e à margem confirmados no caixa do Regem**, e mostrar lado a lado o ROAS que a plataforma informa e o ROAS confirmado no caixa (especificação §7; roadmap §5). **Sem IA** (a LIA explica os números na A3; até lá, os números e o motivo aparecem sem ela) e **sem escrita nas plataformas de anúncio** (A4/A5). A única escrita externa é o cupom de campanha no Regem, pelo Action Service, com a flag nascendo desligada. Nada da trilha C começa nos outros repositórios sem o plano de cada um aprovado lá.

## 1. De onde partimos (código lido em 29/09/2026)

| Onde | Já existe | Falta |
| --- | --- | --- |
| **Liame** (A2 no ar desde 29/09/2026) | Gasto, cliques e conversões por campanha e dia, com frescor: Meta com `purchase_value` e `conversations_started` por janela (`7d_click`, `1d_view`), Google Ads (G4–G7); `connected_account` aceita qualquer provider; índice cego para telefone (ADR-014); inbox Standard Webhooks, com **um segredo por provider** (E5); Action Service (E6) | Pedido, item, custo, ponto de contato, atribuição (`data-model.md` §4); segredo por conexão na inbox. Da A2: A2-4, conferência do Google (A2-2), apps publicados. O GA4 do piloto não tem propriedade |
| **Regem** (`origin/main` 868f4de) | Cupom com código único por empresa e `cupom_uso` com telefone e pedido (migs 044/076); cupom ligado à campanha de WhatsApp e lista de saída (mig 226); **definição única de faturamento** (`common/faturamento.ts`); custo efetivo por produto, só com permissão financeira; fila de saída para integrações na mesma transação, com reenvio (`aviso_integracao`, mig 289) | **C1:** `integracao_token` (por loja, hash, escopos) **só declarado no `schema.ts`**, sem migration nem guard; o GoGeM entra pelo token de um `servidor_local` + `X-Integrador` (mig 290). **C3:** nenhuma captura de UTM ou click id; dinheiro em `numeric` (reais); telefone com e sem 55 e consentimento sem prova (base §11, 24/09) |
| **RegemCast** (`origin/main` a63a8c1) | RLS por `conta_id`; conversas e mensagens gravadas (mig 024), telefone com 55 e 9º dígito, `wamid` único; opt-out automático | **C2:** sem autenticação de serviço, sem `Idempotency-Key`, sem webhook de saída, **sem guardar o `referral`** do anúncio; conversa só de número em coexistência com o "sim" do dono (mig 023) |

**Piloto (Mister Burgers):** a loja vende também por 99Food, iFood e Anota Aí (sem clique; iFood e 99 fora do marketing pela decisão de 09/09/2026, base §11), e o bot de WhatsApp do cardápio do Regem roda por Evolution (instância `Mister.ia`, segundo o registro do Regem de 29/08/2026; confirmar no A0-7), que **não entrega o `referral`** do anúncio (`integrations.md` §6, item 1). O cardápio online recebe o pedido **na nuvem** e depois ele desce para o servidor da loja (`pedido_externo` sincroniza nos dois sentidos).

## 2. Três caminhos de atribuição

Todos determinísticos: a atribuição é código, com modelo versionado e janela declarada (`data-model.md` §4; especificação §5.4). Pedido sem evidência fica **sem origem**, nunca "provavelmente da Meta".

| Caminho | Evidência no pedido | Depende de | Confiança |
| --- | --- | --- | --- |
| **A · Clique → cardápio** | id do anúncio/campanha nos parâmetros da URL (dinâmicos da Meta, ValueTrack do Google), `gclid`/`fbclid` e o id do link do Liame (`lk`), guardados do primeiro acesso até o pedido | C1 + C3a | alta |
| **B · Anúncio → conversa → pedido** | conversa aberta por anúncio (id do anúncio e `ctwa_clid` do `referral`) e pedido do **mesmo telefone** (índice cego) dentro da janela | C1 + C2 + número na API oficial | média |
| **C · Cupom de campanha** | cupom exclusivo da campanha usado no pedido (cardápio, WhatsApp, balcão) | C1 (ler cupom) | alta |

**O MVP (roadmap §5) fecha pelo caminho A**, o que menos depende de terceiros; C entra junto; B entra quando o número do anúncio estiver na API oficial (D-A2.5-9).

## 3. Entregas no Liame

Cada entrega é um PR com CI verde. **Migrations em negrito**: eu aplico e testo no local e no CI; você aplica na nuvem. Letra **F** (ciclo fechado) para não confundir com a G da A2 e a C da trilha C. Antes do código: **ADR-019** (integração com Regem e RegemCast: autorização, token por loja, leitura com cursor e webhook) e **ADR-020** (atribuição determinística versionada), e os protótipos da seção 6.

| # | Entrega | O que fica pronto | Critérios | Migrations |
| --- | --- | --- | --- | --- |
| **F1** | **Modelo de vendas** | `connected_account` para `regem` e `regemcast`, com a loja do Liame (`unit_id`); `order_fact` (canal, loja, situação, `confirmed_at`, receita pela definição única do Regem, desconto, cupom, cliente novo, versão do recurso), `order_item_fact` (quantidade, receita, custo, `cost_known`), `customer_ref` **só com o índice cego** do telefone (HMAC com a chave da empresa; o telefone não é guardado); dinheiro em micros (`bigint`), como o ledger (0011); `sync_state` com os conjuntos `pedidos` e `conversas`; RLS forçada, classe de dado e prazo em toda tabela; "só o expurgo apaga" | A2.5-4, A2.5-5, A2.5-7 | **0021** vendas |
| **F2** | **Pontos de contato e motor de atribuição** | `tracking_link`, `campaign_coupon`, `touchpoint` (tipo, ids de clique e de anúncio, UTM, `occurred_at`, **proveniência** de cada campo), `attribution_model` (regra e janela como dado versionado), `attribution_result` (pedido ↔ campanha, modelo, evidência, confiança, janela) e `attribution_run`; motor puro, sem IA, em SQL de conjunto (sem laço de N), idempotente e recalculado quando o pedido muda (cancelamento, estorno); conjunto de casos de referência no CI | A2.5-3, A2.5-6 | **0022** atribuição |
| **F3** | **Conectar Regem e RegemCast** | "Conectar Regem" pelo fluxo da D-A2.5-4 (a pessoa escolhe as lojas e vê os escopos; o token só passa entre servidores e vai para o cofre); loja do Regem ↔ loja do Liame; revogar dos dois lados; inbox com **segredo por conexão** (`POST /v1/inbox/{provider}/{connection_id}`, grava cru, deduplica, 202); permissões `vendas.ver`, `atribuicao.gerenciar`, `links.gerenciar`, `cupons.criar`; flag `regem_write` desligada e kill switch do provider `regem` | A2.5-5, A2.5-10 | **0023** entrada por conexão e permissões |
| **F4** | **Conector Regem (leitura)** | Leitura com cursor composto (`updated_at`, `id`), carga inicial de 90 dias (como D-A2-3) e reconciliação diária; webhook assinado só como gatilho de frescor; conversão de centavos para micros sem ponto flutuante; telefone normalizado em E.164 na chegada (não espera a C3c) e transformado em índice cego; pedido de marketplace chega **sem identificador do cliente**; cancelamento e estorno viram versão nova; ordem garantida pela versão do recurso, nunca pela chegada (ADR-004); reserva por conexão com `SKIP LOCKED` (V35); contract tests com respostas gravadas do contrato publicado pelo Regem (`docs/openapi.json` de lá) | A2.5-2, A2.5-4, A2.5-8 | — |
| **F5** | **Links de campanha** | Construtor do link do cardápio da loja com UTM padrão, `lk` e os parâmetros dinâmicos de cada plataforma (para colar no anúncio: a A2.5 não escreve na Meta nem no Google), também em QR para material impresso; só o domínio do cardápio da loja é aceito (V33); **conferência do rastreio**: os anúncios ativos lidos pela A2 sem os parâmetros viram aviso | A2.5-1 | — |
| **F6** | **Cupons de campanha** | **Lista dos cupons do Regem** puxada pela conexão (código, regra, validade, usos; atualizada com os pedidos), pronta para ligar a uma campanha, entrar no link da F5 e no criativo; criar no Regem pela ferramenta `regem_cupom_criar` (R1, reversível desativando, com aprovação pela política padrão, `Idempotency-Key` até o Regem), atrás da flag `regem_write`; **contrato de cupons** (`docs/integracoes/cupons.md`: escopos, rotas, eventos, erros) para outros sistemas implementarem | A2.5-3 | — |
| **F7** | **Conector RegemCast (leitura)** | Conversas iniciadas por anúncio: id do anúncio, `ctwa_clid`, momento, número da loja e o telefone, que vira índice cego na chegada; **nenhum conteúdo de mensagem**; contagem de conversas por campanha; leitura com cursor + webhook, como a F4 | A2.5-1 (caminho B), A2.5-5 | — |
| **F8** | **Resultados** | `GET /v1/results/closed-loop` (período no fuso da loja; investimento, conversas, pedidos confirmados, receita, margem conhecida e cobertura, ROAS da plataforma com a janela dela, ROAS confirmado no caixa, custo por pedido, pedidos sem origem, canais sem clique à parte, frescor de cada fonte) e o detalhe da origem de cada pedido (Pro, sem dado pessoal); tela conforme o protótipo aprovado, em Lite e Pro, **sem os botões da LIA** até a A3 | A2.5-1, A2.5-6, A2.5-9 | — |
| **F9** | **Atenção do ciclo fechado** | Regras explicáveis, calculadas na hora como na G9: Regem ou RegemCast sem dados; campanha com gasto e zero pedido confirmado em 7 dias; margem desconhecida acima de 20% da receita atribuída; anúncio ativo sem rastreio; cupom de campanha sem uso com gasto; plataforma × caixa muito distantes (informativo). Limiares [S], medidos no piloto | A2.5-9 | — |

Ordem: F1 → F2 → F5 (não depende de ninguém) → F3 → F4 → F6 → F8 → F9; F7 quando a C2 existir. Tudo sai testado contra respostas gravadas **antes** do Regem e do RegemCast terem as rotas, como na A2 (§1).

## 4. Trilha C (nos outros repositórios)

Cada item é um PR no próprio repositório, com o fluxo de lá (Regem: migration na nuvem **antes do merge**, `@CloudOnly()` onde a tabela é só da nuvem, V1/V9 do registro do Regem; RegemCast: migration antes do merge). O contrato de cada rota entra no OpenAPI do produto.

| # | Onde | O que precisa existir | Destrava |
| --- | --- | --- | --- |
| **C1a** | Regem | `integracao_token` recriado **com migration e guard novos** (não "recuperar" o que não está no git): hash, escopos, **uma loja por token**, revogação, último uso; testes de uma loja tentando ler outra (o Regem roda com RLS desligada, ADR-003: filtro de empresa e loja em toda consulta) | F3 |
| **C1b** | Regem | Tela "Autorizar o Liame" (lojas e escopos, só presidente para custo) e troca do código por token entre servidores (D-A2.5-4); no piloto, emissão pelo console da distribuição | F3 |
| **C1c** | Regem | Rotas só da nuvem para o Liame: pedidos confirmados e cancelados com itens, custo, cupom e origem (cursor composto, centavos inteiros, receita pela definição única); clientes anonimizados (para o Liame apagar o `customer_ref`); **cupons pelo contrato de cupons** (listar com regra, validade e usos; criar com `Idempotency-Key`), com os escopos `cupons.ler`, `cupons.uso.ler` e `cupons.criar` no token da loja | F4, F6 |
| **C3a** | Regem | **Captura no cardápio online** de UTM, `gclid`, `gbraid`/`wbraid`, `fbclid` e `lk` no primeiro acesso, guardados na sessão do pedido até o checkout, gravados numa tabela própria só da nuvem (`pedido_origem`), **sem coluna nova no `pedido_externo`** (que sincroniza com o servidor da loja e exigiria `.zip` do edge) | caminho A |
| **C3b** | Regem | Eventos de saída assinados (Standard Webhooks, segredo por conexão) para `pedido.confirmado`, `pedido.cancelado`, `cupom.usado`, `cliente.anonimizado`, sobre a fila da mig 289, só da nuvem | frescor (F4) |
| **C3c** | Regem | Telefone único em E.164 na origem; consentimento com origem e prova; segmento desconhecido falha fechado | A5 |
| **C2a** | RegemCast | Guardar o `referral` da mensagem de entrada (id do anúncio, tipo, `ctwa_clid`) na conversa | caminho B |
| **C2b** | RegemCast | Token de integração por conta com escopos (mesmo padrão da C1), `Idempotency-Key`, leitura de conversas iniciadas por anúncio com cursor, webhook de saída assinado | F7 |

**Ordem que não bloqueia:** C1a → C1c (leitura) → C3a → C1b → C3b → C3c; C2a pode começar já (é só gravar), C2b depois. O MVP precisa só de **C1a + C1c + C3a** (caminho A) e da leitura de cupom (caminho C). C3c e o consentimento são pré-requisito da A5, não do MVP.

## 5. Decisões (aprovadas pelo dono em 29/09/2026)

| # | Decisão | Recomendação | Por quê |
| --- | --- | --- | --- |
| D-A2.5-1 | **Modelo e janela de atribuição** | **Último toque determinístico** com hierarquia: cupom exclusivo > id do anúncio/clique na URL > conversa aberta por anúncio (mesmo telefone). Janela de **7 dias** do clique ou da conversa até o pedido. Sem visualização (não é observável no caixa). Um pedido dá crédito a uma campanha só. Modelo guardado como dado versionado; configurável por marca no Pro depois | Restaurante tem ciclo curto; o conector da A2 já lê a janela `7d_click` da Meta (G4), então os dois lados da tela usam a mesma janela de clique; nome de campanha solto no UTM não conta como evidência |
| D-A2.5-2 | **Devolver conversões à Meta (CAPI) e ao Google (Data Manager)** | **Não na A2.5; fica na A5**, como no roadmap. Desde já, os ids de clique ficam guardados com a proveniência e o prazo que a A5 vai precisar | É escrita em plataforma (trilho da A4/A5); exige consentimento com prova (C3c); a conversão offline por clique no Google está barrada fora da lista liberada desde 15/06/2026 (base §3.2) |
| D-A2.5-3 | **Cupons (ajustada pelo dono em 29/09)** | O cupom **vive no Regem** (onde é resgatado; o Regem é a fonte da verdade). **Os dois caminhos entram na A2.5:** (1) a conexão **puxa os cupons cadastrados no Regem** (código, regra, validade, usos), que ficam à mão no Liame para ligar a uma campanha, montar o link e usar no criativo; (2) **criar pelo Liame escrevendo no Regem**, pelo Action Service, com aprovação e a flag `regem_write`. O acesso segue um **contrato de cupons com escopos documentados** (`cupons.ler`, `cupons.uso.ler`, `cupons.criar`), neutro de produto, para outros sistemas (GoGeM e futuros) implementarem o mesmo e o Liame se conectar a eles sem código novo. **Confirmado pelo dono (29/09):** o Liame fala com o Regem por **REST** agora, com esse contrato; as mesmas ferramentas e escopos saem no hub MCP da DMS (`/mcp/regem`, trilha B) quando ele existir (ADR-008, ADR-019) | Cupom no criativo e no link facilita a campanha; um contrato só evita refazer a integração a cada sistema; MCP interno contraria o ADR-008 e travaria a A2.5 atrás do hub |
| D-A2.5-4 | **Como nasce o token da loja no Regem** | **Produto:** "Conectar Regem" no Liame leva ao Regem, onde o presidente escolhe as lojas e vê os escopos; o Regem devolve um código, e o Liame troca pelo token entre servidores (código + PKCE). O token fica em hash no Regem e cifrado no cofre do Liame; revoga-se dos dois lados. **Piloto:** emitido pela distribuição direto para o cofre, sem passar pelo usuário. O mesmo padrão vale para o RegemCast | "O usuário informa, a distribuição conclui" (`integrations.md` §1.3); ninguém copia segredo; o ERR-108 do Regem mostrou o custo de reusar credencial de outro fim (o token do `servidor_local`) |
| D-A2.5-5 | **Como os pedidos chegam** | **Leitura com cursor** (só C1) como base, com carga de 90 dias e reconciliação diária; o **webhook** (C3b) entra depois como gatilho de frescor | A leitura sozinha já fecha o MVP; webhook perde e repete, e o Regem é a autoridade do pedido |
| D-A2.5-6 | **O que é receita e quando o pedido conta** | A **definição única de faturamento do Regem** (produto, taxa de entrega da loja e taxas de serviço; sem gorjeta; menos o desconto bancado pela loja). Conta o pedido **confirmado** e não cancelado; estorno tira. O Liame não recalcula | Evita o "mesmo dia com três faturamentos" que o Regem já corrigiu; a conferência A2.5-2 fica possível ao centavo |
| D-A2.5-7 | **Margem** | Pedido com item sem custo → margem do pedido `null`; no total, **margem conhecida + cobertura** ("R$ X em 83% da receita"); "dá lucro / dá prejuízo" só com cobertura ≥ 80% | "Margem desconhecida ≠ zero" (`data-model.md` §4) |
| D-A2.5-8 | **ROAS confirmado** | Conta só evidência de confiança alta ou média; pedidos sem origem aparecem ao lado, com a porcentagem | Número confirmado não pode depender de palpite |
| D-A2.5-9 | **WhatsApp do piloto** | Provar o MVP pelo cardápio (caminho A) e pelo cupom; em paralelo, pôr o número que recebe os anúncios de clique para WhatsApp **em coexistência no RegemCast** (API oficial) para o caminho B | Pela Evolution não chega o `referral` (`integrations.md` §6); é a pergunta aberta do A0-7 |
| D-A2.5-10 | **Retenção** | Pontos de contato com ids de clique: **90 dias**; `customer_ref`: enquanto houver finalidade, apagado quando o Regem anonimiza (evento em até 1 dia); pedidos e itens (sem dado pessoal): enquanto durar o contrato | Cobre a janela de 7 dias e a futura conversão offline (A5) sem guardar mais do que isso |
| D-A2.5-11 | **Marketplaces e canais sem clique** | iFood, 99Food e Keeta chegam só como pedido e valor por canal, **sem nenhum identificador do cliente**; Anota Aí e balcão só atribuíveis por cupom. Tudo mostrado como "canais sem clique", fora do ROAS de mídia própria | Decisão de 09/09/2026 (base §11) e minimização (LGPD, art. 6º III) |

## 6. Protótipos para aprovação (antes do código)

> **P1, P2 e P3 aprovados pelo dono em 29/09/2026** (`mockups/prototipo-resultados.html`, `prototipo-contas-regem.html`, `prototipo-links-cupons.html`), com as decisões registradas no changelog de `decisoes-design.md`. Falta o P-R, no Regem.

Sem mockup aprovado não se inventa tela (`CLAUDE.md` §2). A "Resultados" do protótipo geral (A0-4) tem os números inventados e não mostra os estados reais; por isso vira protótipo próprio, como foi feito com `prototipo-contas.html` na A2.

| # | Protótipo | Estados que precisa mostrar |
| --- | --- | --- |
| P1 | **Resultados: ROAS plataforma × ROAS confirmado no caixa** (Lite e Pro) | Regem não conectado; período sem pedido; plataforma que não informa valor de venda (campanha de mensagem: comparar custo por conversa × custo por pedido); margem desconhecida e cobertura; pedidos sem origem; canais sem clique; fonte atrasada ("Dados desatualizados · última sincronização 09:42"); fuso da conta diferente do da loja; pedido cancelado depois; detalhe da origem de um pedido (evidência, janela, confiança) |
| P2 | **Contas conectadas: Regem e RegemCast** (acréscimo ao `prototipo-contas.html`) | Conectar (ida e volta do Regem), escolher lojas, escopos, frescor, revogar, token revogado do lado do Regem |
| P3 | **Links e cupons de campanha** (tela nova, em "Mais ferramentas") | Criar link (campanha, anúncio, destino), copiar parâmetros por plataforma, QR, anúncios sem rastreio; vincular cupom existente; criar cupom (com aprovação) |
| P-R | **No Regem** (mockup do Regem) | "Autorizar o Liame" (C1b); aviso de privacidade no checkout do cardápio e, na C3c, o consentimento com texto e prova |

## 7. Critérios de saída da A2.5

| # | Critério | Como é verificado |
| --- | --- | --- |
| A2.5-1 | **Cadeia real no piloto:** pelo menos um pedido real confirmado no caixa, atribuído a uma campanha real pelo caminho A (e pelo B, se o número estiver na API oficial), com a evidência visível no detalhe | Registro com prints (anúncio → link → pedido no Regem → Resultados), como a A2-2 |
| A2.5-2 | Pedidos e receita de 7 dias fechados de uma loja **iguais ao relatório de faturamento do Regem**, ao centavo | Conferência manual registrada + teste de fixture |
| A2.5-3 | Atribuição determinística: mesma entrada → mesmo resultado; cupom vence clique; fora da janela não atribui; cancelamento e estorno recalculam; cada resultado com modelo, versão e janela | Casos de referência no CI |
| A2.5-4 | Idempotência: evento repetido, fora de ordem ou perdido não duplica nem some pedido (a reconciliação preenche); dinheiro sem ponto flutuante | Testes de integração |
| A2.5-5 | Isolamento: A1-1 a A1-3 nas tabelas novas; conexão de uma empresa nunca recebe pedido de outra; token de uma loja do Regem não lê outra (teste no Regem) | CI nos dois repositórios |
| A2.5-6 | Margem desconhecida nunca vira zero; cobertura mostrada; ROAS e custo por pedido calculados por código | Testes |
| A2.5-7 | LGPD: nenhum telefone, nome ou e-mail em claro no banco, nos logs e nos spans do Liame; pedido de marketplace sem identificador; anonimização no Regem apaga o `customer_ref` | Teste que procura telefone no banco e nos spans (como a E8) + teste de propagação |
| A2.5-8 | Uso Limitado: dado vindo das APIs do Google nunca segue para a Meta nem outra plataforma de anúncio (proveniência por campo; o Action Service recusa) | Teste que tenta a transferência (`security-model.md` §2.1) |
| A2.5-9 | Frescor de cada fonte na tela; fonte parada vira aviso, nunca número errado | Testes + verificação no navegador |
| A2.5-10 | Telas P1–P3 conforme protótipo aprovado, em 1440/1024/768/375, claro e escuro | Verificação no navegador |
| A2.5-11 | Trilha C: C1a, C1c e C3a mescladas com CI verde nos repositórios de lá; C2 e C3b/C3c com o seu plano | PRs mesclados |
| A2.5-12 | Documentos jurídicos atualizados nos mesmos PRs (seção 8) | Lista "Mudanças desde a v0.2" |

## 8. Documentos jurídicos que mudam (`CLAUDE.md` §6)

| Documento | Mudança | Entra com |
| --- | --- | --- |
| Termos 2.6 | A fase de lançamento passa a incluir a leitura de pedidos, itens, custos e cupons do Regem e das conversas iniciadas por anúncio do RegemCast, quando conectados | F3, F8 |
| Termos 6.2 | "ROAS confirmado" é resultado de um modelo declarado (regra e janela); pedido sem evidência fica sem origem; não é garantia | F8 |
| Termos 5.4 · Política 6.4 | Deixar claro que o clique captado na página da própria loja (`gclid`, `fbclid`) é dado da loja, e que o cruzamento com os dados das APIs do Google nunca leva esses dados à Meta; equivalente da Meta a pesquisar (seção 9) | F2, F4 |
| Política 6 (nova 6.5) | O que o Liame recebe do Regem e do RegemCast; conversa: só a origem do anúncio e o momento, **sem conteúdo**; o telefone vira identificador pseudonimizado na chegada e não é guardado; como revogar | F3, F7 |
| Política 9 | Prazos novos: ids de clique 90 dias; identificador pseudonimizado do cliente enquanto houver finalidade; pedidos sem dado pessoal enquanto durar o contrato | F1 |
| Contrato 2.3 e Anexo I | "Medição e atribuição de vendas" passa a valer; categorias: itens e valores de pedidos, cupom, ids de clique e de anúncio, identificador pseudonimizado do telefone; mensagens só como origem da conversa | F1, F8 |
| Contrato 7.2 · Anexo II | Anonimização feita no Regem chega ao Liame em até 1 dia; telefone nunca em claro no Liame | F4 |
| Exclusão de dados §1 e §2 | Revogar Regem e RegemCast; pedir exclusão do que veio deles | F3 |
| README jurídico | Linhas nas mudanças e na checagem de verdade (telefone em claro, Uso Limitado com teste, propagação da exclusão) | cada PR |
| **Fora do Liame** | Aviso de privacidade do cardápio do Regem (a loja é controladora; o Regem registra a origem do clique e repassa ao Liame, da mesma empresa) e política do RegemCast | C3a, C2 |
| **A5, não agora** | Envio de conversões à Meta e ao Google (dados em hash) muda Política 8 e o Anexo I | A5 |

Nenhum fornecedor novo entra na A2.5 (Regem e RegemCast são da mesma empresa; README jurídico, item 12).

## 9. Base de conhecimento: reconferir e pesquisar antes do código (`CLAUDE.md` §1)

- **Reconferir na fonte oficial** ([S]/[NC], mesmo com menos de 90 dias): §2.3 CAPI (parâmetros de `business_messaging` [NC], limite de `event_time` [NC], "Dataset ID" [S]); §3.2 Data Manager (destino único [O/S], bloqueio da conversão offline por clique fora da lista liberada desde 15/06/2026, Customer Match); §6.1 `analytics.readonly` sensível [S]; §1.4 "17% das conversões reais" [S] (não usar em texto de produto).
- **Atualizar a §11** com o que foi visto no código em 29/09/2026 (seção 1 deste plano).
- **Pesquisar e registrar com [O]** (a base não tem): parâmetros dinâmicos de URL da Meta (`{{campaign.id}}`, `{{adset.id}}`, `{{ad.id}}`) e o campo `url_tags`; formato do `fbclid`/`_fbc`; objeto `referral` do webhook da Cloud API (`source_id`, `source_type`, `source_url`, `ctwa_clid`) e se a **coexistência** o entrega; auto-tagging do Google (`gclid`, `gbraid`, `wbraid`), ValueTrack e `final_url_suffix`; `click_view` do GAQL (resolver `gclid` → campanha e os limites); janelas padrão de conversão do Google Ads; restrição da Meta (Platform Terms) a levar dado dela para outra plataforma de anúncio; guia da ANPD sobre cookies e identificadores, para o cardápio do Regem.

## 10. O que depende de você

| Para | Preciso de | Critério da A0 |
| --- | --- | --- |
| Começar | Aceite deste plano, das decisões da seção 5 e dos ADR-019 e ADR-020 · ✅ 29/09/2026 | — |
| C1 no Regem | Plano do token por loja aprovado (issue no Regem) | A0-9 |
| Caminho B | Número dos anúncios de clique para WhatsApp e se ele vai para coexistência no RegemCast | A0-7 |
| Piloto | Acesso ao Regem da Mister Burgers com o perfil presidente (o custo só sai com permissão financeira); 1 ou 2 campanhas reais levando o link da F5 ou um cupom exclusivo | A0-7 |
| Telas | Aprovar P1, P2, P3 (✅ 29/09/2026) e as telas do Regem (P-R) | — |
| Aplicar na nuvem | Migrations 0021–0023 do Liame; as da C1/C3 no Regem e da C2 no RegemCast, **antes** do merge de cada uma | A0-8 |
| Continuidade do Google | Publicar os apps da Meta e do Google (o token do Google em modo de teste vence em 7 dias) | A0-5 |
| Aviso ao consumidor | Aprovar o texto do aviso de privacidade no cardápio da loja | A0-6 |

## 11. Riscos

| Risco | Mitigação |
| --- | --- |
| C1 depende de código que não está no git | Recriar do zero com migration nova (C1a); piloto com token emitido pela distribuição |
| Coluna nova em tabela sincronizada do Regem exige `.zip` do edge e migration antes do merge | Origem do pedido em tabela própria só da nuvem (C3a): o pedido online nasce na nuvem |
| Pouco pedido atribuível no piloto (vendas fortes em 99Food, iFood e Anota Aí) | Mostrar a porcentagem atribuída e os canais sem clique à parte; cupom como ponte; o critério do MVP é a cadeia provada, não o volume |
| Parâmetros colados à mão (sem escrita na A2.5) | Conferência automática dos anúncios ativos (F5) com aviso na Atenção |
| Regem com RLS desligada e guard por controller (ADR-003) | Filtro de empresa e loja pelo token em toda consulta das rotas novas + teste de uma loja lendo outra (C1a) |
| Dinheiro em `numeric` no Regem; fuso e janela diferentes entre fontes | Contrato em centavos inteiros; fuso da loja para pedido e da conta para gasto, declarado na tela (V34, LIC-006); janela sempre declarada |
| Webhook perdido, repetido ou fora de ordem | Inbox deduplica, versão do recurso decide, leitura com cursor reconcilia (D-A2.5-5) |
| Muitas lojas ao mesmo tempo | Reserva por conexão com `SKIP LOCKED`, recálculo em conjunto, escalonamento justo entre empresas (arquitetura §9) |

## 12. Fora da A2.5

LIA explicando os números e os botões "Explicar" (A3); qualquer escrita na Meta ou no Google e o envio de conversões (A4/A5); públicos, réguas e disparos (A5); atribuição com vários toques e incrementalidade (A8); TikTok e demais canais (A6); GA4 como fonte de sessões (o piloto não tem propriedade).
