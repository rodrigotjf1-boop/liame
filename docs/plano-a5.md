# Liame — Plano da fase A5 · Google e mensageria

> **Aprovado pelo dono em 08/10/2026** ("plano a5 aprovado"), com as decisões D-A5-1 a D-A5-20 como recomendadas (seção 4). A D-A5-7 foi ajustada no mesmo dia, pelo que a página oficial do Google permite (a nota abaixo da tabela das decisões). A A5 é "o segundo canal e a mensageria" (roadmap §2): o trilho que a A4 construiu para a Meta passa a valer no **Google Ads**; as vendas confirmadas no caixa passam a **voltar para as plataformas** como conversão, para elas aprenderem com venda de verdade; e a equipe ganha o funcionário de **CRM e mensageria**, que propõe mensagens de WhatsApp pelo RegemCast para uma pessoa aprovar. **Nada é enviado, gasto ou mudado sem a aprovação de uma pessoa com o código do app**, como na A4.
>
> A A5 depende da A4 (roadmap §2). O código da A4 está no ar, mas o piloto dela (critério A4-14: 10 ações aprovadas e executadas na Meta) ainda não começou: espera os tetos de verba e a escrita ligada. Por isso a ordem proposta começa pelo que **não depende** desse piloto (seção 3).

## 1. De onde partimos (código e documentos lidos em 08/10/2026)

| Onde | Já existe | Falta |
| --- | --- | --- |
| **Trilho de ação** (A1 a A4) | Action Service com política, aprovação com o código do app amarrada ao hash do pedido, execução pelo worker, compensação por ferramenta, auditoria; as ferramentas de verba, pausar e retomar; o modo Aprovação do Gestor de tráfego; a Verba do mês, que já conta o gasto de todas as contas de anúncio (D-A4-19); a conferência diária do gasto | As mesmas ferramentas com o provedor `google_ads` (hoje só `meta_ads` e o de teste) |
| **Google Ads** (A2) | Conector de **leitura**: campanhas, grupos, anúncios, métricas do dia, URLs e sufixos de rastreio; o app do Google em produção (07/10/2026), sem a verificação; o projeto no nível de acesso Explorer. A sombra já mede as campanhas do Google, e a tela diz que ali o Gestor de tráfego "vai só até Sugerir" | Ler o estado logo antes de escrever (a situação e o orçamento da campanha, que no Google pode ser compartilhado entre campanhas); escrever com `validate_only` antes |
| **Ciclo fechado** (A2.5) | Pedidos do Regem com receita, custo e cupom; os pontos de contato com os ids de clique (`gclid`, `gbraid`, `wbraid`, `fbclid`), guardados por 90 dias de propósito para esta fase (D-A2.5-2 e D-A2.5-10); a atribuição do pedido ao anúncio | Devolver a venda confirmada às plataformas (hoje nada sai do Liame para elas além das ações de verba) |
| **RegemCast** (trilha C2) | A porta de integração com token por conta. O Liame usa três ferramentas: a situação, as conversas abertas por anúncio e o desligar. **O RegemCast já oferece** a quem é produto da DMS: públicos (contagem, sem nome e sem telefone), estimativa de público e custo, modelos como a Meta os tem, tetos de gasto, campanhas com custo, rascunho de modelo, rascunho de campanha, o plano do disparo, o disparo com confirmação e a pausa (`docs/mcp.md` do RegemCast) | O Liame ler e usar essas ferramentas; o pedido de disparo no trilho de aprovação |
| **Consentimento** | No Regem: `opt_out_marketing` e um `consentimento_lgpd` sem prova. No RegemCast: importação com consentimento declarado, descanso entre mensagens e saída automática por botão ou texto. No Liame: **nenhum telefone ou e-mail de cliente da loja é guardado** (só o índice cego do telefone, ADR-014) | O consentimento com origem e prova no Regem (item C3c da trilha C, já marcado para a A5) |
| **Equipe** (A3 e A4) | "CRM e mensageria" aparece em Sua equipe como funcionário da fase A5 | O funcionário de verdade, com os limites dele |
| **E-mail** | O envio de e-mails do próprio sistema (convite, revisão da semana) pelo SES | Nada de e-mail de marketing; a base de e-mails de clientes com consentimento não existe |

## 2. O que muda para quem usa

1. **O Google entra no trilho.** "Pedir mudança" passa a aparecer nas campanhas do Google: verba, pausar e retomar, com a validação do Google antes, a aprovação com o código do app, a conferência depois e a volta. O Gestor de tráfego pode subir de Sugerir para Aprovação também no Google.
2. **A venda confirmada volta para o Google.** O pedido que veio de um clique num anúncio e foi confirmado no caixa é informado ao Google como conversão, com o valor. O Google passa a otimizar por venda de verdade, e não por clique. Pedido cancelado é retirado.
3. **A venda confirmada volta para a Meta**, pelo mesmo caminho, quando os dados que ela exige estiverem disponíveis com consentimento (decisão D-A5-9).
4. **Mensagens de WhatsApp com aprovação.** O funcionário de CRM propõe uma mensagem para um público que já existe no RegemCast (por exemplo, quem não compra há 60 dias), com o modelo, o número de pessoas e o custo estimado. A pessoa aprova com o código do app, o RegemCast envia, e o resultado aparece em Resultados, medido no caixa pelo cupom da mensagem.
5. **Uma tela para a mensageria:** o que foi enviado, para quantos, quanto custou e o que voltou em pedidos.

## 3. Entregas no Liame

Cada entrega é um PR com CI verde. Migrations testadas no local e no CI e aplicadas na nuvem antes do merge; o número sai da sequência quando a entrega começar (a última é a 0054). Letra **Y**. Antes do código: os protótipos da seção 5 e a reconferência da seção 8. **A ordem começa pelo que não depende do piloto da A4.**

| # | Entrega | O que fica pronto | Critérios | Depende de |
| --- | --- | --- | --- | --- |
| **Y1** | **Conversões para o Google** | Para cada pedido confirmado com `gclid` ou `gbraid` guardado: um evento pela Data Manager API, com o instante, o valor, a moeda e o id do pedido, para a ação de conversão que o dono escolher na conta. Primeiro com `validateOnly`; o resultado e os avisos do Google ficam guardados; pedido cancelado depois de informado tem o valor zerado (a Data Manager não tem retirada; nota da D-A5-7); nada é enviado duas vezes (o id do pedido é a chave). Flag `conversoes_google`, desligada | A5-1 a A5-4 | Escopo `datamanager` na autorização do Google; D-A5-5 a D-A5-8 |
| **Y2** | **Conector de escrita do Google Ads** | O provedor `google_ads` na interface de escrita que a Meta já usa: lê a situação e o orçamento da campanha (com quantas campanhas dividem o mesmo orçamento), aplica primeiro com `validate_only` e só então de verdade; recusa do Google vira "recusado" com o motivo; o limite diário de operações do nível de acesso adia em vez de insistir. Flag `google_write`, desligada | A5-5 a A5-7 | — |
| **Y3** | **Ferramentas de anúncio no Google** | Verba, pausar e retomar campanha aceitam `google_ads`, com as mesmas regras da Meta (passo de até 10%, teto por campanha, teto do mês, compensação que não sobrescreve mudança humana). O modo Aprovação passa a valer no Google. A conferência diária do gasto cobre as mudanças no Google | A5-5 a A5-8 | Y2; o piloto da A4 para ligar (D-A5-2) |
| **Y4** | **Mensageria: leitura** | O Liame lê do RegemCast os públicos (só a contagem), os modelos e a situação deles na Meta, os tetos de gasto e as campanhas com o custo. Nenhum telefone chega ao Liame | A5-9 | Token do RegemCast com as permissões de leitura |
| **Y5** | **Pedido de mensagem** | A ferramenta `mensagem_disparar` no trilho de ação: monta a campanha em rascunho no RegemCast (modelo aprovado, público, janela), pede o plano do disparo (pessoas, custo estimado, o que impede) e, com a aprovação de uma pessoa e o código do app, dispara com a confirmação do plano. Cupom próprio da mensagem, para medir no caixa. A volta é pausar o que ainda não saiu; mensagem enviada não volta, e o pedido diz isso. Flag `mensageria`, desligada | A5-9 a A5-12 | Y4; token com `campanhas.disparar`; C3c |
| **Y6** | **Funcionário de CRM e mensageria** | Propõe a mensagem a partir do que o sistema já sabe (o público pronto, a oferta de Minha marca, o calendário do Estrategista): o texto do modelo em rascunho, conferido pelo Compliance, e o pedido de disparo. Sempre com aprovação; sem sombra e sem promoção de autonomia nesta fase. Eval próprio como portão | A5-11, A5-13 | Y5 |
| **Y7** | **Conversões para a Meta** | O evento de compra pela Conversions API para o conjunto de dados da conta, com o id do pedido para não duplicar. Flag `conversoes_meta`, desligada | A5-1 a A5-4 | D-A5-9; o item C3d da trilha C |
| **Y8** | **Telas** | Pelos protótipos da seção 5 | A5-14 | Aprovação dos protótipos |

**Trilha C (Regem e RegemCast), em PRs de lá:**

| # | Onde | O que precisa existir | Destrava |
| --- | --- | --- | --- |
| **C3c** | Regem | Telefone único em E.164 na origem; consentimento de marketing com origem e prova (quando, onde, o texto mostrado); segmento desconhecido falha fechado. Já previsto no plano da A2.5 | Y5 |
| **C3d** | Regem | Só se a D-A5-9 for "sim": no cardápio online, o aviso de medição com a escolha da pessoa e a guarda do que a Meta exige para um evento de site | Y7 |
| **C2c** | RegemCast | O token do piloto com as permissões de rascunho e disparo (classe DMS); conferir se a campanha devolve o cupom usado ou só os números | Y5 |

> **Andamento.** **Y1, servidor (08/10/2026):** a migration 0055, o conector da Data Manager API, a rotina de envio e a flag `conversoes_google`, desligada; sem tela e sem rota. **P14 (08/10/2026; aguarda a aprovação do dono):** o protótipo da tela, `mockups/prototipo-contas-conversoes.html`: um cartão em Contas conectadas, depois da autorização do Google. **Y1, rotas (08/10/2026):** a migration 0056, as quatro rotas que a tela vai ler (a situação de cada conta, as conversões da conta lidas no Google, escolher e parar) e a permissão `auth/datamanager` na autorização do Google, só para a empresa com a função ligada. Falta da Y1 a tela, que espera o aceite do P14. **Y2 (08/10/2026):** a migration 0057 e o conector de escrita do Google Ads, pronto e fora do registro: lê a campanha com o orçamento dela, muda a situação ou a verba diária do orçamento que é só dela, valida antes, não mexe em orçamento compartilhado e tem cota diária por empresa. Nenhuma ferramenta o aceita antes da Y3. **P13 (08/10/2026; aguarda a aprovação do dono):** o protótipo em duas partes, `mockups/prototipo-google-pedido.html` (o Google no pedido de mudança e em Aprovações, com o aviso da verba dividida) e `mockups/prototipo-google-equipe.html` (a linha do Google subindo para Aprovação). **Y3, parte de servidor (08/10/2026):** a política da distribuição na versão 4 (as regras da Meta valem no Google), as ferramentas de verba, pausar e retomar campanha aceitando `google_ads`, a verba dividida recusada no plano e as opções do pedido sem o "conecte de novo" no Google. O conector segue fora do registro: falta da Y3 o registro, as duas telas e os textos jurídicos, depois do aceite do P13. **Y4, parte 1 (08/10/2026):** as seis leituras da mensageria no conector do RegemCast (a situação da conta, as campanhas com os números e o custo, os públicos só com a contagem, os modelos e o orçamento), com o contrato conferido campo a campo; o RegemCast já as oferece, então a Y4 não espera a trilha C. **P15 (08/10/2026; aguarda a aprovação do dono):** o protótipo `mockups/prototipo-mensagens.html`: a tela "Mensagens" (o que foi enviado, com o custo e os pedidos que vieram pelo cupom) e o pedido de mensagem em Aprovações (a mensagem, quem recebe, quando sai, quanto custa, o cupom e o que impede); antes dele, a §16.1 da base de conhecimento foi atualizada. **P16 (08/10/2026; aguarda a aprovação do dono):** o protótipo `mockups/prototipo-equipe-crm.html`: o CRM e mensageria como quem trabalha em Sua equipe, com o modo Aprovação fixo, o que as mensagens trouxeram e custaram, os limites dele e os motivos de não poder propor. Com ele, os quatro protótipos da seção 5 estão prontos e esperam o aceite. **Y4, parte 2 (08/10/2026):** a migration 0058 (a flag `mensageria`, desligada) e as duas rotas só de leitura que a tela Mensagens vai usar: `GET /v1/messaging` (a situação do WhatsApp, os tetos de gasto, as contagens de modelos e de públicos e as campanhas com os números) e `GET /v1/messaging/campaigns/:id` (a pausa, as falhas por motivo e o custo); nada é guardado, e a Política de Privacidade 6.5 e o Anexo I foram atualizados no mesmo PR. A flag `mensageria` do plano nasce aqui, para a leitura; na Y5 ela também abre o pedido de mensagem, e o envio fica ainda atrás da `whatsapp_campaign`. Falta da Y4 a tela, depois do aceite do P15; e, do dono, o token do piloto com as permissões de leitura e a flag ligada. **Y5, parte 1 (09/10/2026):** o conector do RegemCast aprendeu as ferramentas do pedido de mensagem (estimar o público, rascunhar o modelo e a campanha, planejar o disparo, disparar com a confirmação e pausar), com a chave de idempotência em tudo o que grava; nada chama ainda. O RegemCast já oferece essas ferramentas: da trilha C, a Y5 espera o token do piloto com as permissões e o C3c, e não código novo do lado de lá. Achado para a parte 2: a porta do RegemCast não agenda o começo da campanha (ela sai quando o disparo é chamado, dentro da janela), então o "quando sai" do pedido é decidido do lado do Liame. **Y5, parte 2 (09/10/2026):** o pedido de mensagem no trilho de ação, com o conector do RegemCast ainda fora do registro: as ferramentas `mensagem_disparar` e `mensagem_pausar`, o estado do pedido como o plano do disparo (se o plano muda entre o pedido e a execução, nada é enviado), a recusa do que não cabe no teto do mês, e a aprovação obrigatória de uma pessoa em duas camadas (a política da distribuição na versão 5 e a trava na ferramenta). Falta da Y5 montar o pedido (o rascunho da campanha, com a janela das 9h às 20h, e o cupom da mensagem), registrar o conector, as telas e os textos jurídicos. **Aceites de 09/10/2026:** o dono aprovou o P13 (as duas partes), o P14, o P15 e o P16. No P14, a escolha B: a configuração fica em Contas conectadas, e entram uma linha em Resultados e um aviso em Atenção quando o envio parar. No P15, pausar um envio é direto, com confirmação na tela e o registro de quem pausou; enviar continua com o código do app.

## 4. Decisões (aprovadas pelo dono em 08/10/2026, como recomendadas)

| # | Decisão | Recomendação | Por quê |
| --- | --- | --- | --- |
| D-A5-1 | **O que vem primeiro** | As conversões para o Google (Y1), depois a escrita no Google (Y2 e Y3), depois a mensageria (Y4 a Y6). Conversões para a Meta por último | Y1 não muda campanha nem gasta: só informa venda. É o que mais ajuda o resultado e o que menos arrisca |
| D-A5-2 | **Quando ligar a escrita no Google** | Só depois do critério A4-14 (10 ações executadas na Meta sem erro). O código entra antes, desligado | O trilho se prova num canal por vez |
| D-A5-3 | **Regras da escrita no Google** | As mesmas da Meta: validação antes, passo de até 10%, tetos, aprovação com o código do app. Campanha nova no Google fica fora da A5 | Uma regra só para o dono entender; criar campanha depende das fotos (fim do roteiro) |
| D-A5-4 | **Orçamento compartilhado** | No Google, um orçamento pode servir a várias campanhas. Na A5 o Liame **não mexe** em orçamento compartilhado: mostra o motivo e quais campanhas dividem a verba | Mudar a verba de uma campanha mudaria a de outras sem ninguém pedir |
| D-A5-5 | **O que vai na conversão para o Google** | Só o id do clique, o instante, o valor e o id do pedido. **Nenhum telefone ou e-mail**, nem em hash | O Liame não guarda esses dados; o id do clique basta para o Google ligar a venda ao anúncio |
| D-A5-6 | **Que valor é enviado** | A receita confirmada no caixa. A margem e o custo **nunca** saem do Liame | A plataforma otimiza por valor de venda; a margem é segredo comercial da loja |
| D-A5-7 | **Quais pedidos são enviados** | Só os que têm clique de anúncio guardado (até 90 dias) e foram confirmados no caixa. Cancelado depois de enviado tem o **valor zerado**; para isso ser raro, o pedido só sai depois de uma espera (nota abaixo) | É o que a D-A2.5-10 previu ao guardar o clique por 90 dias |
| D-A5-8 | **A ação de conversão no Google** | Uma ação própria, "Pedido confirmado no caixa", criada por você na conta do Google Ads (eu guio, um print por vez). O Liame só envia para ela | Não misturar com as conversões que a conta já mede; criar ação de conversão é configuração da conta, não do Liame |
| D-A5-9 | **Conversões para a Meta** | Fazer **depois** do Google, e só se você aceitar a mudança no cardápio do Regem (C3d). Para um evento de site, a Meta pede o endereço da página e dados do navegador de quem comprou; o que é obrigatório e o que é só recomendado eu reconfiro antes (seção 8) | Sem esses dados o evento casa mal com o anúncio; guardá-los muda o cardápio e a Política de Privacidade |
| D-A5-10 | **WhatsApp só pelo RegemCast** | O Liame nunca guarda telefone nem lista. O público é sempre um que já existe no RegemCast; o Liame vê só quantas pessoas | É a regra da casa (base §2.4) e o que mantém o dado pessoal num lugar só |
| D-A5-11 | **Todo disparo com aprovação** | Uma pessoa aprova com o código do app, vendo o texto, o número de pessoas e o custo estimado. Sem modo automático nesta fase | Mensagem custa dinheiro e reputação do número |
| D-A5-12 | **O dinheiro das mensagens** | Vale o teto de gasto do próprio RegemCast, mostrado no pedido. Não soma ao teto de anúncios da Verba do mês | Mensagem e anúncio são cobranças diferentes; somar confundiria os dois limites |
| D-A5-13 | **Ritmo e horário** | Envio só entre 9h e 20h no fuso da loja; vale o descanso entre mensagens que a conta tem no RegemCast, e o Liame nunca pede para enviar a quem está em descanso; quem pediu para sair nunca recebe | Base §7.6 e a política do WhatsApp; o descanso é decisão do dono, guardada no RegemCast |
| D-A5-14 | **Quais mensagens entram** | Duas: a **promoção pontual** (uma oferta de Minha marca) e o **volte a pedir** (quem não compra há 60 a 90 dias). Carrinho abandonado fica fora | O Regem não tem o evento de carrinho; começar pelo que dá para medir |
| D-A5-15 | **O modelo da mensagem** | O funcionário escreve o rascunho; quem envia o modelo para a aprovação da Meta é uma pessoa, no RegemCast | A ferramenta do RegemCast só rascunha, de propósito |
| D-A5-16 | **Como medir** | Cada mensagem leva um cupom próprio, criado pelo contrato de cupons que já existe. O resultado aparece em Resultados como um canal a mais | O RegemCast não diz quem recebeu; o cupom mede no caixa sem dado pessoal |
| D-A5-17 | **E-mail e SMS** | Ficam para a A6 | Não existe base de e-mails de clientes com consentimento; o restaurante conversa pelo WhatsApp |
| D-A5-18 | **Públicos de anúncio** (lista de clientes para a Meta e o Google) | Ficam fora da A5; decidir depois de o consentimento com prova (C3c) existir e ser medido | Exige enviar telefone em hash, que o Liame não guarda, e consentimento por finalidade |
| D-A5-19 | **A LIA no WhatsApp** | Fica para a A6 | A A5 já abre dois caminhos novos de escrita |
| D-A5-20 | **Nível de acesso no Google** | Começar no Explorer (2.880 operações por dia) e pedir o Básico, que exige a verificação da marca do projeto. O Padrão fica para antes do primeiro cliente de fora | A página oficial não põe campanhas e orçamentos entre os serviços bloqueados no Explorer; o piloto cabe no limite |

> **Ajuste da D-A5-7 (08/10/2026, depois da reconferência da Y1).** A página oficial dos ajustes de conversão da Data Manager API descreve duas coisas: corrigir o valor e completar os dados do usuário. **Não há como retirar uma conversão por ela** (base §3.2). Por isso: (1) o pedido só é informado **duas horas depois** de confirmado no caixa, e o que for cancelado nesse intervalo nunca sai do Liame; (2) o pedido cancelado depois de informado tem o **valor corrigido para zero**: a conversão continua contada, sem valor; (3) vai ao Google o pedido que o Liame atribui ao Google, pelo clique que venceu a atribuição: o mesmo que aparece em Resultados. Fica por conferir no piloto se o Google aceita o valor zero. A espera de duas horas é escolha de implementação, e o dono pode mudar.

## 5. Protótipos para aprovação (antes do código de tela)

| # | Tela | O que mostra |
| --- | --- | --- |
| **P13** | O Google no pedido de mudança e em Sua equipe | O que muda em relação às telas aprovadas (P9 e P11): o aviso de orçamento compartilhado, a validação do Google e a linha do Google subindo para Aprovação |
| **P14** | Conversões devolvidas | Em Contas conectadas: ligado ou não, a ação de conversão escolhida, quantos pedidos foram informados, recusados e retirados, e o último erro com o que fazer |
| **P15** | Mensagens | A lista do que foi enviado e o pedido de mensagem em Aprovações: o texto, o público, quantas pessoas, o custo estimado, o cupom e o que impede |
| **P16** | O funcionário de CRM em Sua equipe | A ficha no desenho dos outros, como a do Criativo (P12) |

## 6. Critérios de saída da A5

| # | Critério | Como é verificado |
| --- | --- | --- |
| A5-1 | Nenhuma conversão sai sem a validação antes; recusa da plataforma não reenvia | Teste do conector |
| A5-2 | Um pedido nunca é informado duas vezes; cancelado depois de informado é retirado | Teste com banco |
| A5-3 | Só sai o que a decisão permite: nenhum telefone, e-mail, margem ou custo no que é enviado | Teste que inspeciona o corpo enviado |
| A5-4 | **Piloto:** uma semana de pedidos informados ao Google, conferidos na conta | Registro com prints |
| A5-5 | Nenhuma escrita no Google sem `validate_only` antes | Teste do conector |
| A5-6 | Orçamento compartilhado nunca é alterado | Teste |
| A5-7 | O limite diário de operações adia, não insiste, e uma empresa não gasta a cota das outras | Teste |
| A5-8 | Mudança humana feita no Google não é sobrescrita, nem pela volta | Teste de concorrência |
| A5-9 | Nenhum telefone ou nome de cliente chega ao Liame pela mensageria | Teste do contrato |
| A5-10 | Nenhum disparo sem aprovação de uma pessoa com o código do app, e só com a confirmação do plano | Teste e política |
| A5-11 | O texto da mensagem passa pelo Compliance antes de aparecer | Teste e eval |
| A5-12 | Fora do horário ou acima do teto, o pedido espera ou é negado, com o motivo | Teste |
| A5-13 | Eval do funcionário de CRM como portão | CI (modo gravado) e uma rodada com o modelo de verdade |
| A5-14 | Telas P13 a P16 conforme o protótipo aprovado, em 1440, 1024, 768 e 375 px, claro e escuro | Verificação no navegador |
| A5-15 | **Piloto:** três mensagens aprovadas e enviadas, com o resultado medido no caixa | Registro com prints |
| A5-16 | Documentos jurídicos atualizados nos mesmos PRs (seção 7) | README jurídico |

## 7. Documentos jurídicos que mudam (`CLAUDE.md` §6)

| Entrega | O que muda |
| --- | --- |
| Y1 e Y7 | **Política de Privacidade 8 e o Anexo I do contrato de operador:** o Liame passa a informar vendas às plataformas. Dizer o que vai (o id do clique, o instante, o valor, o id do pedido), para quem e por quanto tempo. Era o que o plano da A2.5 já avisava |
| Y2 e Y3 | **Termos 2.3 e 2.6:** o que hoje fala da Meta passa a valer para o Google |
| Y5 e Y6 | **Termos e Política:** o Liame pede o disparo, o RegemCast envia e guarda os contatos; o consentimento é do cliente da loja com a loja; o Liame não recebe telefone |
| C3c e C3d | Os textos do Regem (o aviso do cardápio e o consentimento de marketing), no repositório dele |

## 8. Base de conhecimento: reconferir antes do código (`CLAUDE.md` §1)

- **Conferido em 08/10/2026, nas páginas oficiais (base §3.1 e §3.2):** os serviços bloqueados no nível Explorer (criação de conta, usuários, planejamento e cobrança; campanhas e orçamentos não estão na lista); `validate_only` existe nos pedidos de escrita do Google Ads; `POST https://datamanager.googleapis.com/v1/events:ingest`, com até 2.000 eventos, `validateOnly`, o consentimento (`adUserData` e `adPersonalization`) e a resposta com `requestId`; o ajuste de conversão pelo mesmo `transactionId`.
- **Reconferido para a Y1 em 08/10/2026 (base §3.2):** a ação de conversão é a de importação por clique (`UPLOAD_CLICKS`); o destino é a conta com o id da ação; o evento leva exatamente um id de clique; o mesmo `transactionId` sobrescreve o valor, e **não existe retirada**; o resultado se lê por `requestStatus:retrieve`; os limites por projeto. **Por conferir no piloto:** se o valor zero é aceito, e o passo a passo da ação de conversão na tela do Google Ads, antes de guiar o dono.
- **Reconferido para a Y2 em 08/10/2026 (base §3.1):** os campos de `CampaignBudget` e de `Campaign` na v25, o orçamento compartilhado e o de período, o `validate_only` (só devolve erros), a máscara de atualização e os erros de cota. **Fica por conferir:** se a validação conta no limite diário de operações (o Liame conta como se contasse).
- **Reconferir antes da Y7:** o que a Conversions API exige num evento de site (a página dos parâmetros do cliente) e o que muda no evento de mensageria.
- **Reconferir antes da Y5:** a política do WhatsApp em vigor para mensagem de marketing e os preços por mensagem.
- **Atualizar a §16.1** (como os produtos de marketing mostram a mensagem para aprovar) antes do protótipo P15. **Feito em 08/10/2026.**

## 9. O que depende de você

| Para | Preciso de |
| --- | --- |
| Começar | ✅ Aceite deste plano e das decisões da seção 4 (08/10/2026) |
| Y1 | Ativar a Data Manager API no projeto do Google Cloud da distribuição (eu guio, um print por vez; conferir na mesma hora se a permissão nova precisa ser declarada na tela de acesso a dados do app); ligar `conversoes_google`; autorizar o Google de novo, com a permissão a mais (só depois da flag: é ela que faz a autorização pedir a permissão); criar a ação de conversão na conta do Google Ads (eu guio, com o caminho conferido na página oficial) e escolhê-la na tela |
| Y2 e Y3 | O piloto da A4 andando (os tetos de verba e a escrita na Meta ligada); depois, ligar `google_write` |
| Y2 | Pedir o nível Básico do Google, que exige a verificação da marca do projeto (eu guio) |
| Y4 | No RegemCast: o token do Liame com as permissões de leitura (a conta, as campanhas, os públicos, os modelos e o orçamento) e conectar de novo em Contas conectadas (eu guio, um print por vez); depois, ligar `mensageria`, quando a tela existir |
| Y5 | No RegemCast: o número do piloto na API oficial (a pergunta aberta do A0-7), o token com as permissões de rascunho e disparo, o teto de gasto das mensagens e um modelo aprovado pela Meta |
| Y5 | O aceite da mudança de consentimento no Regem (C3c) |
| Y7 | Decidir a D-A5-9 |
| Telas | ✅ Protótipos P13 a P16 aprovados (09/10/2026): no P14, a escolha B (a configuração em Contas conectadas, mais uma linha em Resultados e um aviso em Atenção); no P15, a pausa direta |
| Nuvem | A senha do banco no `.env.nuvem` para cada migration, antes de cada merge |

## 10. Riscos

| Risco | Mitigação |
| --- | --- |
| O número de WhatsApp perder qualidade ou ser bloqueado | Só público com consentimento no RegemCast; descanso de 7 dias; horário; aprovação humana; começar com públicos pequenos |
| Mensagem custar mais que o esperado | O plano do disparo mostra o custo antes; o teto do RegemCast barra; a confirmação vale para aquele plano |
| A mesma venda contada duas vezes no Google | Ação de conversão própria; o id do pedido como chave; conferir com a conta no piloto |
| Informar venda errada | Só pedido confirmado no caixa; cancelado é retirado; a validação antes |
| Dado pessoal sair do Liame | A decisão D-A5-5; teste que inspeciona o que é enviado |
| Mudar verba de campanha que divide orçamento | A decisão D-A5-4 |
| Limite diário do Google | Adiar em vez de insistir; poucas operações por ação; pedir o Básico |
| A regra do Google contra quem só repassa a API dele | O Liame expõe capacidades próprias com aprovação e limites, nunca um repasse da API (base §3.1) |
| O piloto da A4 não começar | A ordem da seção 3: Y1 e a mensageria não dependem dele |

## 11. Fora da A5

Campanha nova no Google e mexer em anúncios e palavras-chave; e-mail e SMS; públicos de anúncio com lista de clientes; a LIA no WhatsApp (A6); vídeo, TikTok e redes sociais (A6); execução sem aprovação (A7).
