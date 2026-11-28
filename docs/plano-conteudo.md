# Liame — Plano: o planejamento de conteúdo e as campanhas que nascem dele

> **Proposta de 27/11/2026, para aprovação do dono.** Nada aqui vira código antes do "aprovado" e, nas telas novas, dos protótipos aprovados (seção 11). As decisões estão na seção 10 (D-PC-1 a D-PC-18), cada uma com a recomendação.
>
> **Pedido do dono (27/11/2026):**
> - um planejamento de posts, ou de posts, Stories e Reels misturados, para uma semana ou um mês, já deixado programado;
> - o planejamento parte do que o Instagram da marca já tem (cores, modelos, formatos e jeitos de postar) e de uma base de fotos e vídeos da marca;
> - lê as datas especiais e as tendências do dia;
> - a pessoa escolhe o intervalo e, se quiser, o objetivo (força da marca, engajamento, seguidores, divulgar um produto);
> - sugere ideias novas do mercado;
> - usa a montagem de vídeo do Liame e a API das plataformas para tirar o máximo do material;
> - o mesmo recurso é a base das campanhas, com métricas, foco e objetivo, inclusive a partir dos posts já publicados, e das campanhas de produto, promoção ou evento, com sugestões tiradas do cardápio da loja.
>
> **No mesmo dia, mais dois pedidos:**
> - uma lista de dados e resultados para o **Mister do Regem** apresentar ao presidente (desempenho dos planos e das postagens, dicas e sugestões para continuar ou mudar o planejamento): seção 9;
> - a pesquisa do mercado, os dados e as **bibliotecas de código aberto** (GitHub e Hugging Face): seções 3, 4 e 12.
>
> As fontes de cada fato estão na base de conhecimento, **§20** (nova). Este plano diz o que fazer com elas.

## 1. De onde partimos (código, documentos e dados lidos em 27/11/2026, `origin/main` 6b65be3b)

### 1.1 O que o Liame já tem

| Onde | Já existe | Falta para o pedido |
| --- | --- | --- |
| **Pauta e Agenda** | O Estrategista faz a pauta da semana (um item por dia), a oferta e o plano de 90 dias, com o calendário comercial (§16.5). O Social media transforma o item do dia em post, para amanhã e depois de amanhã, às 19h (Z6, `posts_sugeridos`). A Agenda mostra o que vai ao ar | Um plano para um intervalo escolhido (até um mês), com vários itens por dia, formato, hora, objetivo e a mídia de cada um |
| **Publicar** | Post com foto e Story no Instagram e na Página, na hora marcada e só o que foi aprovado (Z5, Z13); vídeo como Reels (Z10) | **Carrossel** (o Instagram aceita até 20 itens pela API, base §2.2; o Liame só lê) |
| **Vídeo montado** | 4 modelos em Remotion sobre a foto e o vídeo reais da loja (Z15), e os melhores momentos com os cortes do Social media (Z16) | Modelos com as cores da marca (hoje as cores são as do Liame, `packages/video-modelos/src/estilo.ts`); carrossel e capa de Reels montados por código |
| **Fotos e vídeos da marca** | A biblioteca (Fotos, Z4 e Z10): enviar, ver, apagar, com produto e descrição escritos pela pessoa | Etiquetas automáticas, busca, duplicados, qualidade, "quando foi usada" e os trechos bons de cada vídeo |
| **Do seu Instagram** | O que a loja publicou, lido uma vez por dia, com alcance, visualizações, curtidas, comentários, salvos e envios (Z10, parte 5); os números de cada post (Z7); os seguidores por dia, quem seguiu e deixou de seguir, os toques nos botões e a cidade dos seguidores (R4, D-RG-40) | A leitura é dos **50 posts mais novos**; nenhuma análise junta esses números (formato, hora, dia, tema, cor, modelo) |
| **Minha marca** | O dossiê (identidade, voz, produtos, ofertas, provas, o que não pode dizer, concorrentes, região, datas e sazonalidade) | A identidade visual: cores, fontes e modelos que a marca já usa |
| **Datas** | O calendário comercial (tabela `commercial_date`, feriados nacionais e datas do varejo, §16.5) e a seção "datas" do dossiê | Os eventos da cidade e as tendências do dia (o Pulso do Hub DMS tem os dois; seção 6) |
| **Campanhas** | Campanha nova na Meta, inclusive a partir de um Reels já publicado (X5, parte 6), e no Google (Y9); o ritmo da semana (R7); a verba do mês | Campanha a partir de foto e carrossel publicados; a sugestão de qual post impulsionar e de qual produto anunciar |
| **Cardápio e vendas (Regem)** | Os pedidos e os itens de cada pedido (`order_item_fact`), o custo quando o Regem tem, os mais vendidos no dossiê | O ranking de produtos para conteúdo e campanha (vendas, margem, tendência, produto que nunca apareceu no Instagram) |
| **Regem (Mister)** | O Liame lê o Regem pela porta de integração (pedidos, catálogo, clientes) e cria cupom nele | Nada do marketing chega ao Regem: o Mister não sabe o que o Liame planejou, publicou nem o que trouxe |

### 1.2 Os números da Mister Burgers (lidos na nuvem em 27/11/2026, só leitura e só agregados)

- **O que foi lido:** os 50 posts mais novos, de 14/09 a 26/11/2026.
- **Publicações pelo Liame:** só 3, em novembro, nos testes. Quem publica é a própria loja.
- **Biblioteca:** 22 fotos e vídeos em Fotos.

| Formato | Posts | Alcance médio | Alcance mediano | Visualizações médias | Envios por mil alcançados | Salvos por mil alcançados |
| --- | --- | --- | --- | --- | --- | --- |
| Foto | 39 | 814 | 518 | 1.653 | 2,1 | 0,7 |
| Carrossel | 7 | 864 | 636 | 2.333 | 2,5 | 0,6 |
| Reels | 4 | **3.009** | **1.813** | 4.761 | **5,7** | 0,6 |

**O que esses números mostram:**
- **Reels:** o Reels alcança cerca de 3,7 vezes a foto (pela média) e 3,5 vezes (pela mediana), e é enviado de uma pessoa para outra 2,7 vezes mais. Mesmo assim, foram só 4 em 10 semanas, e o último saiu em 16/10.
- **Horário:** 32 dos 50 posts saíram entre 17h e 18h59. Nenhum saiu numa quarta-feira.
- **Frequência:** de 2 a 6 posts por semana.
- **Alcance de novembro:** caiu. As semanas de 16/11 e 23/11 ainda estão contando, porque os números do Instagram atrasam até 48 horas.
- **Nomes dos produtos:** os mais vendidos dos últimos 28 dias aparecem com o nome de cada canal ("TRIO 08", "Numero 07", "Trio 01 + Batata + Refri Lata"). A sugestão de produto tem de juntar pelo produto do Regem (o código do produto), não pelo nome escrito no pedido.

Com 4 Reels, a diferença ainda é um indício, não uma prova. O plano trata assim: o primeiro mês testa mais Reels e mede (seção 7, regra R3).

## 2. O que muda para quem usa

1. **Pedir o plano.** Na Agenda, "Planejar conteúdo". A pessoa escolhe:
   - o intervalo (de uma semana a um mês);
   - o objetivo (força da marca, engajamento, seguidores, divulgar um produto ou "deixar o Liame sugerir");
   - o que destacar, se quiser: um produto do cardápio, uma oferta aprovada ou um evento.

   O Liame sugere quantos posts, carrosséis, Reels e Stories cabem, pela análise e pelo objetivo, e a pessoa ajusta.
2. **O Liame olha o que já existe.** Ele monta o raio-x do Instagram da marca (seção 5) e a biblioteca (seção 6), e olha as datas e as tendências do período (seção 6.3).
3. **O calendário chega em Aprovações.** Cada item tem dia, hora, formato, tema, objetivo, a mídia escolhida da biblioteca, o modelo de montagem e o porquê. Quando falta foto ou vídeo, o item vira "Foto a produzir", com o que fotografar. A pessoa aprova tudo, troca itens ou pede outro plano.
4. **As peças ficam prontas antes.** O Social media escreve o texto e escolhe a mídia; o código monta o vídeo e o carrossel com as cores da marca. Cada semana de peças chega em Aprovações e é aprovada de uma vez, com o código do app (D-PC-3).
5. **Tudo sai sozinho na hora marcada**, pelo trilho que já existe (só o aprovado, uma vez).
6. **O resultado volta.** Cada item é medido contra o objetivo dele. Toda semana, o Liame diz o que funcionou e o que mudar, e propõe o ajuste do resto do plano (seção 7).
7. **As campanhas nascem do plano.** O post que foi bem vira sugestão de impulsionar. O produto, a oferta ou o evento destacado vira uma campanha com objetivo, verba e métrica (seção 8).
8. **O presidente acompanha pelo Mister**, no Regem: o resumo, os resultados e as sugestões (seção 9).

## 3. Como o mercado faz

*(Resumo da pesquisa de 27/11/2026; ferramentas, fontes e datas na base §20.1.)*

Foram olhadas 23 ferramentas:
- de fora: Later, Planoly, Buffer, Hootsuite, Sprout Social, Metricool, Predis.ai, Ocoya, FeedHive, SocialBee, Vista Social, Publer, Canva, Meta Business Suite e Adobe Express;
- do Brasil: mLabs, Etus, Postgrain e Reportei;
- feitas para restaurante: Popmenu, Toast, Owner.com e BentoBox.

**O que o mercado já faz:**

| Recurso | Quem faz | Como |
| --- | --- | --- |
| Plano gerado de uma vez | Predis.ai, SocialBee, Ocoya, Popmenu, Toast | Predis monta a semana inteira e publica; SocialBee vai de categorias para a grade e da grade para os posts; Popmenu monta um mês de posts sobre os pratos, os eventos e as avaliações, e o dono aprova ou edita |
| Melhor horário pela própria conta | Later, Buffer, Hootsuite, Sprout, Metricool, mLabs | Later usa 6 meses de dados e marca no calendário; mLabs cruza o perfil, o pico do segmento e a frequência dos concorrentes |
| Identidade visual tirada da conta | Predis.ai, Canva, Ocoya | Predis tira as cores, as fontes e o logo do site e dos posts antigos; Canva tem o Brand Kit |
| Aprovação | mLabs, Reportei, Sprout, Later, Buffer | mLabs e Reportei aprovam por e-mail, WhatsApp ou link, com histórico; no Sprout, o post que não foi aprovado até a hora é rejeitado e não sai |
| Post vira anúncio | Hootsuite, Vista Social, Meta Business Suite, mLabs, Etus | Hootsuite impulsiona por regra (acima da média de engajamento, com teto de verba); a Meta mostra posts, Stories, Reels e anúncios no mesmo calendário |
| Datas comemorativas | mLabs, Etus, Publer, Toast, Hootsuite | mLabs tem calendário por segmento (arquivo .ics); Toast tem campanhas prontas de feriado |
| Relatório que diz o que mudar | Reportei, Buffer | Reportei escreve a análise com IA; Buffer mostra os formatos e a frequência que funcionam |
| Plano a partir das vendas | **Toast** e **Popmenu** | Toast usa os dados de venda e do cardápio; Popmenu usa os pratos mais populares |
| Plano a partir de um objetivo | Quase ninguém | O mais perto é o Hootsuite, que calcula o horário "pelas suas metas" |

**O que o Liame copia** (e onde entra neste plano):
1. **Plano em etapas:** pilares de conteúdo → grade com dia e hora → peças (SocialBee e Later). Seções 7.1 e 7.2.
2. **Melhor horário da própria conta, com o período de dados à mostra e marcado no calendário** (Later), **cruzado com o pico do segmento** (mLabs). No delivery, o pico do segmento é a hora em que a loja vende. Seção 5.1.
3. **O que a IA agenda passa pela mesma aprovação do post feito à mão** (mLabs; "a IA nunca publica por você", Hootsuite). Já é o trilho do Liame.
4. **Aprovação que vence:** sem aprovação até a hora, o post não sai (Sprout). Também já é a regra do Liame.
5. **Um mês de posts a partir dos pratos, dos eventos e das avaliações; o dono só aprova ou edita** (Popmenu). É a PC5.
6. **O plano usa as vendas do caixa** (Toast). Seção 6.2, e o Liame vai além: soma a margem e o "nunca apareceu".
7. **Reciclar o que funcionou, mostrando no calendário onde a repetição cai** (Publer), e **apontar o post que devia ter ido bem e não foi** (FeedHive). Seções 6.1 e 7.5.
8. **Impulsionar por regra, acima da média da conta, com teto de verba** (Hootsuite), **conferindo pela API se o post pode virar anúncio antes de mostrar o botão** (a Meta tem a consulta para isso; base §20.2). Seção 8.
9. **Posts, Stories, Reels e anúncios no mesmo calendário** (Meta Business Suite). Agenda do P47.
10. **Identidade tirada dos posts antigos** (Predis), usada só nos modelos sobre a mídia real. Seção 5.4.
11. **Relatório com a recomendação prática do que mudar** (Reportei). Seções 7.5 e 9.
12. **O custo de IA visível, e refazer os pilares sem custo** (Later). Seção 14.
13. **A prévia de como o feed vai ficar** (Planoly e Adobe Express). P47.

**O que o Liame não copia:**
- **Imagem gerada por IA** (Predis, Ocoya, Reportei Flux, Publer): bate com a D-A6-82, e prato "inventado" engana o cliente.
- **Horário de estudo de mercado no lugar do dado da conta** (o Metricool usa quando falta dado): no delivery, pesa a hora do pedido.
- **Piloto automático sem aprovação** (Predis publica sozinho; Popmenu "manda sem o dono escrever ou agendar").
- **Reels planejado com áudio em alta do catálogo:** a publicação automática só aceita áudio original (seção 4).

**Onde o Liame é diferente:** nenhuma das ferramentas olhadas junta, no mesmo plano, a análise da conta, o objetivo, a mídia real da loja e o pedido confirmado no caixa. Toast e Popmenu chegam perto nas vendas, mas sem a análise da conta e sem o resultado de cada post no caixa.

## 4. O que o Instagram permite e o que ele valoriza

*(Resumo da documentação oficial e dos estudos de mercado de 2025–2026; fontes na base §20.2 e §20.3.)*

### 4.1 O que a API publica (Graph API v27.0, de 04/11/2026; o Liame está na v26.0)

| Formato | Pela API | Limites e cuidados |
| --- | --- | --- |
| **Foto** | Sim | Só JPEG, até 8 MB, proporção de 4:5 a 1,91:1; texto alternativo (`alt_text`) de até 1.000 caracteres |
| **Carrossel** | Sim | **Até 20 itens**, fotos e vídeos misturados; todos são cortados na proporção do primeiro; os itens não têm números próprios, só o carrossel inteiro |
| **Reels** | Sim | De 3 s a 15 min (até 3 min pode ser recomendado a quem não segue); capa por imagem própria ou pelo ponto do vídeo; `share_to_feed` decide se vai também à grade |
| **Story** | Sim | Foto, ou vídeo de 3 a 60 s. **Figurinhas não saem pela API** (link, enquete, local) |
| **Colaboração** | Sim | Até 3 contas convidadas (`collaborators`), em foto, Reels e carrossel; não em Story |
| **Trial Reels** | Sim | O Reels vai primeiro só para quem não segue e fica fora da grade; com `SS_PERFORMANCE`, passa a valer para todos se for bem |
| **Música** | **Só no Reels**, desde 01/06/2026 | A API de áudio busca as músicas e, sem termo de busca, devolve **as faixas em alta**; vai no Reels pelo `audio_configuration`, só pelo login do Facebook (o do Liame); não tem prévia, e a escolha "pode variar do app" |
| **Agendamento** | **Não existe** | O sistema guarda o post e publica na hora (o Liame já faz assim) |
| **Quantos por dia** | — | A Meta escreve 100 publicações a cada 24 horas no guia e 50 na referência do mesmo recurso: o Liame lê a cota real (`content_publishing_limit`) antes de montar o calendário e trabalha com folga |
| **Legenda** | — | Até 2.200 caracteres; o Instagram limita a **5 hashtags** por post desde dezembro de 2025 (a API ainda documenta 30: o Liame usa até 5) |

### 4.2 O que a API lê

- **De cada post:** visualizações, alcance, curtidas, comentários, salvos, envios, interações e reposts. No feed, também seguidores ganhos e visitas ao perfil. No Reels, também o tempo médio assistido, o tempo total e a **taxa de quem pulou** (`reels_skip_rate`).
- **Do Story:** navegação, respostas e cliques no link. O número do Story **só pode ser lido nas 24 horas** em que ele fica no ar: o Liame lê antes de sumir (há um aviso da Meta para isso). Story com menos de 5 pessoas não tem número.
- **Atraso e guarda:** os números atrasam até 48 horas e ficam guardados por 2 anos. A leitura vai até as 10 mil publicações mais novas.
- **Métricas que saíram (o Liame não usa):** `impressions`, `plays` e `video_views`.
- **Da conta:** alcance, visualizações, contas engajadas, seguidores ganhos e perdidos, toques nos botões e a audiência por cidade, idade e gênero (com 100 seguidores ou mais; o Liame já lê parte disso, D-RG-40). As **horas em que os seguidores estão no Instagram** (`online_followers`, últimos 30 dias) aparecem nas limitações da documentação, mas não estão confirmadas na tabela de hoje: o raio-x usa se vier, e usa o resultado dos posts por hora se não vier.
- **O que não existe:** o Explorar, as hashtags em alta e as tendências. A busca por hashtag existe, mas só 30 hashtags diferentes a cada 7 dias, e pede um acesso à parte.

### 4.3 O que o algoritmo valoriza (pela própria Meta)

- **Cada lugar do app tem o seu ranking.** No Feed, pesam a relação com quem posta, o tempo no post, passar o carrossel inteiro e enviar por mensagem. No Story, a proximidade e quem toca, responde ou pula. No Reels, o áudio, a imagem, assistir até o fim e reenviar. No Explorar, a popularidade.
- **Os três sinais principais**, segundo o chefe do Instagram (janeiro de 2025): tempo assistido, curtidas e envios. As curtidas pesam mais para quem já segue; os envios, para quem não segue. A recomendação dele é medir os envios e as curtidas **por alcance**, como o raio-x faz.
- **Originalidade:** Reels com marca d'água de outro app, baixa resolução, sem som, com bordas ou já postado perdem distribuição. Desde 30/04/2026, a regra vale também para foto e carrossel repostados sem transformação. O vídeo montado pelo Liame sobre a mídia da loja é original; o repost de outra conta, não.
- **Frequência:** a Meta pede constância, sem número oficial.

### 4.4 O que os estudos de mercado mostram (2025–2026)

Cada estudo mede de um jeito; os números servem de ponto de partida, e a conta de cada loja corrige.
- **Formatos:**
  - o Reels é o que mais alcança (Buffer: 2,25 vezes a imagem);
  - o carrossel é o que mais engaja e mais é salvo (Socialinsider: 0,55% contra 0,52% do Reels e 0,37% da imagem; Metricool: 9 vezes os salvos da imagem);
  - a imagem única está caindo em todos os estudos;
  - no Brasil, o carrossel às vezes passa o Reels em alcance (HypeAuditor e Metricool, setembro de 2026).
- **Frequência:** de 3 a 5 posts de feed por semana é o ponto de equilíbrio (Buffer, 2,1 milhões de posts), mais os Stories do dia. O ramo de comida e bebida posta cerca de 5 por semana e engaja mais que a média (Dash Social, 1º semestre de 2026).
- **Horário:** os estudos não concordam. Para comida, aparecem 11h–13h nos dias úteis (Sprout) e quarta 11h–15h (Hootsuite). No Brasil, o pico no Instagram é das 18h às 22h, todos os dias (Comscore). O certo é o da própria conta (seção 5).

### 4.5 O que muda no plano por causa disso

1. **O mix padrão** (quando a conta ainda não tem dado):
   - Reels para alcançar quem não segue;
   - carrossel para engajar e ser salvo;
   - Stories para quem já segue;
   - foto única só como complemento;
   - de 3 a 5 posts de feed por semana, mais Stories.
2. **O Story não leva link automático:** a figurinha não sai pela API. Quando o objetivo é venda, o Story chama para o link do perfil e para o cupom. O Story com a figurinha de link vai como pacote pronto (Z8), para a pessoa pôr no app.
3. **Música no Reels:** pela API de áudio, com as faixas em alta como uma das fontes de tendência (seção 6.3). Antes do código, conferir quais músicas uma conta comercial pode usar (D-PC-16).
4. **Trial Reels** entra como a forma de testar uma ideia com quem não segue sem mexer na grade, bom para o objetivo de seguidores.
5. **Colaboração** com até 3 contas (fornecedor, parceiro, evento) entra como item possível do plano.
6. **A medida** é por alcance (envios, salvos e curtidas por alcançado) e, no Reels, também o tempo assistido e a taxa de quem pulou. O Story é lido antes de 24 horas.
7. **O código barra** o que perde distribuição: repost de outra conta, marca d'água de outro app e vídeo em baixa resolução.
8. **Até 5 hashtags** e o texto alternativo em toda foto.

## 5. O raio-x do Instagram da marca

O raio-x é o ponto de partida de todo plano. Primeiro o código, depois a IA só no que o código não resolve, como nos outros raio-x do Liame.

### 5.1 O que o código calcula (sem IA, sem custo)

- **Formatos:** quantos posts de cada formato, e o alcance, as visualizações, os envios, os salvos e os comentários de cada um, por mil alcançados. Mostra a média e a mediana: um post que estoura não pode decidir sozinho.
- **Quando:** os dias e as faixas de hora em que a loja posta e o resultado de cada faixa, os dias sem post e o espaço entre os posts. Junta com as horas em que a loja vende (`DemandaDaLoja`, D-RG-107) e, se a API devolver, com as horas em que os seguidores estão no Instagram (§20.2).
- **O que funcionou:** os 5 posts que mais trouxeram envios e salvos por alcance, os 5 que menos trouxeram e os que trouxeram pedidos pelo link (Z7).
- **Tendência:** as últimas 4 semanas contra as 4 anteriores, com o aviso dos números que ainda estão contando (até 48 horas).
- **Legenda:** o tamanho, as chamadas para ação, as perguntas, as hashtags e as menções a produto que se repetem.
- **Mais do que 50 posts:** a leitura passa a ir até 12 meses ou 300 posts, o que vier primeiro (D-PC-6). A primeira leitura é feita uma vez; depois, só os novos e os números dos últimos 30 dias.

### 5.2 O que o código lê das imagens (bibliotecas abertas, em CPU, sem custo de IA)

- **Paleta de cores:** as cores que dominam as fotos e as capas, agrupadas na marca inteira (as 5 ou 6 que mais se repetem).
- **Modelos repetidos:** posts muito parecidos entre si (a mesma moldura, a mesma faixa de preço), achados pela impressão digital da imagem (hash perceptual) e pelo texto escrito na arte (leitura de texto, OCR).
- **Texto na arte:** quanto da imagem é texto e se há preço escrito.

As bibliotecas estão na seção 12.

### 5.3 O que a IA olha (desligado por padrão, com o preço ao lado)

A IA olha as miniaturas dos 30 posts que contam a história da conta: os melhores, os piores e um de cada modelo. Ela descreve:
- o estilo das fotos (luz, enquadramento, close do produto, pessoas, ambiente);
- os temas que se repetem (bastidor, produto, promoção, cliente, data);
- o tom das legendas;
- o que parece ser o "jeito da marca".

Ela não inventa número: os números do raio-x vêm do código e vão escritos para ela.

### 5.4 O que sai do raio-x

- **O cartão "Raio-x do Instagram"**, em Minha marca, com cada número, a fonte e a data.
- **Uma identidade visual proposta:** as cores (com o código de cada uma), os modelos que a marca já usa e as observações de estilo. A pessoa confirma ou corrige, e o que for confirmado entra no dossiê e nos modelos de vídeo e de carrossel.
- **O ponto de partida do plano:** o mix de formatos, as horas, a frequência e os temas que funcionaram.

## 6. A base do material: biblioteca, datas e tendências

### 6.1 A biblioteca da marca (Fotos, ampliada)

- **Etiquetas automáticas** ao subir a foto ou o vídeo: o produto (ligado ao produto do cardápio do Regem quando der), a cena (produto, ambiente, equipe, cliente, bastidor), se há pessoas, se há texto escrito, a orientação e se serve a 9:16, 4:5 e 1:1 sem cortar o principal.
- **Busca por texto** ("batata com cheddar de perto", "fachada à noite").
- **Duplicados e quase duplicados** avisados, para não repetir a mesma foto em semanas seguidas.
- **Qualidade:** foto escura, tremida ou pequena demais é avisada antes de virar post.
- **Uso:** onde e quando cada foto saiu, e o resultado de cada vez. A foto que foi bem pode voltar depois de um tempo; a que foi mal fica de lado.
- **Trechos de vídeo:** o vídeo longo vira trechos marcados pela troca de cena; o Social media escolhe os melhores (a Z16 já faz para um vídeo de cada vez).
- **Trazer do Instagram:** os posts da própria conta podem entrar na biblioteca, com a origem marcada. O vídeo com música licenciada do Instagram não vem (a API não entrega o arquivo).
- **"Foto a produzir":** quando o plano precisa de algo que a biblioteca não tem, vira uma lista de fotos e vídeos a fazer, com o que mostrar, o formato e o prazo.

### 6.2 Os produtos do cardápio

O ranking que o plano e as campanhas usam, sempre pelo produto do Regem (o código do produto), nunca pelo nome escrito no pedido:
- **Vendas:** quantidade e receita dos últimos 28 dias.
- **Margem:** quando o Regem tem o custo (escopo `custos.ler`).
- **Tendência:** subindo ou caindo contra os 28 dias anteriores.
- **"Vende bem e nunca apareceu":** produto que está entre os mais vendidos e não aparece em nenhum post ou foto da biblioteca.
- **"Margem boa, pouca venda":** candidato a destaque ou promoção.

### 6.3 Datas e tendências

| Fonte | O que traz | Custo | Já existe? |
| --- | --- | --- | --- |
| Calendário comercial do Liame | Feriados nacionais e datas do varejo | Nenhum | Sim (§16.5) |
| Dossiê, "Datas e sazonalidade" | As datas da própria marca (aniversário da loja, festas do bairro) | Nenhum | Sim |
| **Pulso** (Hub DMS) | Os eventos da cidade, de fontes públicas, e as notícias e tendências do ramo | Nenhum para o Liame (o Pulso já roda) | No Hub; falta o Liame ler |
| Datas de nicho do food service | Dia do Hambúrguer, Dia da Pizza e afins, com a fonte de cada uma | Nenhum | Não: entra na tabela do calendário comercial |
| Tendências de busca | O que está em alta nas buscas do Brasil e da região | Nenhum (§20.4) | Não |
| Áudio em alta do Instagram | As faixas em alta da API de áudio (só para Reels, pelo login do Facebook; seção 4.1) | Nenhum | Não |
| Tendências do Explorar, do Instagram e do TikTok | — | — | **Não há API** (§20.2): o Liame não promete e não raspa |

As datas sempre vêm de uma tabela ou de uma fonte com data, nunca da memória do modelo (a mesma regra do calendário comercial).

## 7. O plano em si

### 7.1 Quem faz o quê na equipe

- **Estrategista:** monta o calendário a partir do raio-x, do objetivo, da biblioteca, das datas, das tendências, do ranking de produtos e das campanhas no ar.
- **Social media:** escreve cada peça (o texto de cada canal, a escolha da mídia, o modelo de montagem, a capa do Reels).
- **Compliance:** confere as regras de sempre (marca, comida e bebida, o que não pode dizer).
- **Código:** confere os limites antes de qualquer item chegar à pessoa. A IA propõe; o código decide o que pode.
- **Analista:** explica os resultados.
- **Gestor de tráfego:** recebe as sugestões de campanha.

### 7.2 Cada item do calendário

O item traz:
- o dia e a hora no fuso da loja;
- o formato (foto, carrossel, Reels, Story);
- o pilar de conteúdo (produto, bastidor, prova, oferta, data, comunidade);
- o objetivo do item e a métrica que vai medi-lo;
- a mídia da biblioteca (ou "Foto a produzir");
- o modelo de montagem;
- a ideia do texto e a chamada para ação;
- o link rastreado do cardápio, quando houver;
- o produto, a oferta, a data ou a tendência ligados;
- o porquê, com o número que sustenta.

### 7.3 As regras que o código confere

- **R1 · Hora:** o post sai entre 8h e 22h (a regra que já existe) e, de preferência, perto das horas em que os seguidores estão no Instagram e antes das horas em que a loja vende.
- **R2 · Limites:** a cota de publicações lida na API antes de montar o calendário (a Meta escreve 100 e 50 a cada 24 horas, §20.2; na prática, o Liame fica muito abaixo). Um teto por dia que a pessoa ajusta, o espaço mínimo entre dois posts do feed e até 5 hashtags por post.
- **R3 · Mix pelo objetivo:** o objetivo decide a proporção de formatos (tabela abaixo), e o raio-x corrige pelo que funciona na conta. Um formato sem dado suficiente (menos de 5 posts) entra como teste, e o plano diz isso.
- **R4 · Repetição:** a mesma foto não volta em menos de 21 dias, nem a mesma ideia na mesma semana.
- **R5 · Mídia real:** todo item tem mídia da biblioteca ou vira "Foto a produzir". Nada é gerado por IA (D-A6-82).
- **R6 · Datas:** só as datas das fontes da seção 6.3, com a fonte.
- **R7 · Produto:** o produto citado existe no cardápio e está à venda (o Regem diz se está pausado).

| Objetivo | O que pesa mais | Medido por |
| --- | --- | --- |
| **Força da marca** | Reels com o jeito da casa, carrossel de história, bastidor | Alcance, visualizações, quem viu pela primeira vez, buscas pela marca |
| **Engajamento** | Carrossel, pergunta no texto, Stories | Envios, salvos e comentários por mil alcançados |
| **Seguidores** | Reels originais, colaborações, conteúdo que se compartilha | Seguidores ganhos e visitas ao perfil |
| **Divulgar um produto** | O produto em Reels, carrossel e Stories (o Story chama para o link do perfil e o cupom, seção 4.5), depois campanha | Pedidos e receita pelo link e pelo cupom, no caixa do Regem |

### 7.4 A aprovação e a publicação

O calendário vai a Aprovações como um pedido só. As peças vão por semana, num lote aprovado com um código (D-PC-3). A pessoa pode tirar ou trocar qualquer item antes de aprovar.

O que foi aprovado sai pelo trilho de hoje:
- na hora marcada, uma vez só;
- se a pessoa mexer no post depois de aprovado, a aprovação cai;
- se ninguém aprovar a tempo, o item fica parado e avisa; nada sai sem aprovação.

### 7.5 Medir e ajustar

Cada item é medido 48 horas e 7 dias depois, contra a métrica do objetivo dele e contra a média da conta (do raio-x).

Toda semana, o Liame:
- diz o que funcionou e o que não funcionou, sempre com o número;
- aplica as regras do "o que mudar". Exemplos: o formato que ficou abaixo da média da conta por 3 semanas perde espaço; a hora que rendeu mais ganha espaço; o tema que foi bem volta com outra foto;
- propõe o ajuste do resto do plano, que vai a Aprovações como um pedido novo. O que já foi aprovado só muda com outra aprovação.

## 8. As campanhas que nascem do plano

- **Impulsionar o que foi bem.** O post orgânico que ficou entre os 20% melhores da conta (envios e salvos por alcance) ou que trouxe pedidos vira sugestão de campanha a partir do próprio post. A X5, parte 6, já faz isso com o Reels; o plano estende à foto e ao carrossel. A sugestão traz o objetivo, a verba, o raio e o tempo, e vai a Aprovações como qualquer campanha nova.
- **Campanha de produto, de promoção ou de evento.** Quando o plano destaca um produto, uma oferta ou um evento, ele propõe junto o conteúdo orgânico e a campanha, com o objetivo, a verba (dentro da verba do mês), a métrica e o cupom exclusivo quando der. Exemplo: 2 Reels, 1 carrossel e os Stories do produto, mais uma campanha de 5 dias com o melhor deles.
- **Sugestão pelo cardápio.** O ranking da seção 6.2 indica qual produto anunciar e por quê: o que vende bem e nunca apareceu, o que tem margem boa e pouca venda, o que está subindo.
- **Objetivo da campanha:** os objetivos que a X5 e a R6 já têm (pedidos, conversas, reconhecimento e seguidores), com as métricas do caixa do Regem.
- **Ritmo da semana:** a campanha nascida do plano entra no ritmo (R7) como as outras.

Nada disso cria campanha sozinho: tudo vai a Aprovações, e vale o teto de verba (D-A7-11).

## 9. O que o Mister do Regem recebe e apresenta ao presidente

### 9.1 Para que serve

O presidente da loja não precisa abrir o Liame para saber como vai o marketing. O Mister responde quando ele pergunta ("como foram os posts da semana?", "o que eu mudo no plano?"), manda o resumo da semana e avisa quando algo pede atenção. O Mister é IA (regra do dono de 25/11): recebe os dados e as sugestões com o motivo de cada uma e conversa com eles, sem frase pronta.

### 9.2 A lista dos dados

| Bloco | O que vai | Para quê |
| --- | --- | --- |
| **A · O plano em andamento** | O intervalo, o objetivo, o que estava planejado e o que saiu (por formato), o que atrasou ou falhou, o que espera aprovação (com o prazo) e os próximos 7 dias da Agenda | Saber se o plano está sendo cumprido |
| **B · O desempenho do conteúdo** | Alcance, visualizações, envios, salvos, comentários, seguidores ganhos e visitas ao perfil, por formato; os 3 melhores e os 3 piores posts (com o link); a semana contra a anterior e contra a média de 4 semanas | Saber o que funciona |
| **C · O que virou venda** | Pedidos e receita pelo link dos posts e dos Stories, os cupons do plano usados, e as vendas do produto destacado antes e durante | Ligar o post ao caixa |
| **D · As campanhas** | Verba gasta e planejada, pedidos confirmados, receita, custo por pedido e retorno no caixa, as campanhas que nasceram de posts e a situação do ritmo da semana | Saber se o dinheiro voltou |
| **E · O objetivo** | A meta e o realizado (por exemplo, seguidores: meta +150, realizado +90), e a situação: no caminho, abaixo ou acima | Saber se o plano cumpre o que prometeu |
| **F · O material** | Fotos e vídeos novos, os itens parados por falta de mídia e a lista "Foto a produzir" | Saber o que a loja precisa fazer |
| **G · O que vem aí** | As datas, os eventos da cidade e as tendências dos próximos 14 dias, com a sugestão do que fazer em cada um | Antecipar |
| **H · As sugestões** | Continuar, ajustar ou mudar, cada uma com o número que a sustenta. Exemplos: "o Reels alcança 3,7 vezes a foto e não sai Reels há 6 semanas: trocar 2 fotos por 2 Reels"; "o TRIO 08 é o mais vendido e nunca apareceu no Instagram"; "o post do dia 20 foi o melhor do mês: impulsionar com R$ 30 por 5 dias" | Decidir |
| **I · Os avisos** | Conta do Instagram ou da Meta desconectada, publicação que falhou, aprovação vencendo, plano acabando sem o próximo | Agir rápido |

**O que nunca vai:** dado de cliente (nome, telefone), texto de comentário ou de Direct, segredo ou token. Só números agregados, os links dos posts da própria marca e as sugestões.

### 9.3 Como chega

- **O Liame calcula e envia.** Os números saem do código (nunca da IA) e as sugestões, das regras da seção 7.5. O Liame monta o resumo da semana (toda segunda de manhã), uma atualização diária pequena e os avisos na hora. O envio vai ao Regem pela porta de integração, com um escopo novo de escrita, `marketing.resumo.enviar`, que o dono da loja autoriza na ligação, como os outros.
- **O Regem guarda.** O resumo fica numa tabela só da nuvem (`marketing_resumo`, com `tenant_id` e a loja; classificada no sync como só nuvem, V21 do Regem). O Mister lê dali e não chama o Liame no meio da conversa.
- **O Mister usa:**
  - uma ferramenta de leitura nova ("o marketing da loja");
  - um bloco no resumo da semana;
  - os avisos do bloco I pelos destinos que o presidente já escolheu (o "para onde vai" de cada aviso).
- **Quem vê:** o presidente. O gerente, só se o presidente liberar, e sem os blocos de dinheiro (C e D), seguindo a matriz do Regem (D-PC-13).
- **Agir:** o Mister não aprova nada no Liame, porque a aprovação do Liame pede o código do app do Liame. Ele manda o link da tela certa. Numa segunda fase, a decisão do presidente na conversa ("troca 2 fotos por Reels") vira um pedido no Liame, que segue para Aprovações (D-PC-14).

## 10. Decisões do dono

| Decisão | Pergunta | Recomendação |
| --- | --- | --- |
| **D-PC-1** | Onde fica o recurso? | Na **Agenda**, com o botão "Planejar conteúdo"; o raio-x em Minha marca; a biblioteca continua em Fotos. Sem item novo no menu |
| **D-PC-2** | Quem monta? | O **Estrategista** faz o calendário; o **Social media** faz as peças; o código confere. É a divisão que já existe na pauta |
| **D-PC-3** | Como se aprova? | O **calendário uma vez** e as **peças por semana, num lote**, com um código só. A pessoa pode tirar ou trocar item antes. Cada peça continua com o "só sai o aprovado" |
| **D-PC-4** | Qual o intervalo máximo? | **Até 31 dias.** As peças ficam prontas até 5 dias antes de cada semana, para dar tempo de aprovar e de fotografar o que falta |
| **D-PC-5** | Quais formatos entram? | Foto, **carrossel (novo no trilho)**, Reels e Story, no Instagram e na Página. Threads e o Perfil no Google entram como cópia do post, se a pessoa marcar |
| **D-PC-6** | Até onde vai a leitura do Instagram? | **12 meses ou 300 posts**, o que vier primeiro, na primeira vez; depois, só os novos e os números dos últimos 30 dias |
| **D-PC-7** | A análise das imagens é por código ou por IA? | **Código primeiro** (cores, modelos repetidos e texto na arte, por bibliotecas abertas em CPU, sem custo). A **IA só nas 30 miniaturas** que contam a história, **desligada por padrão e com o preço ao lado** (regra do custo mínimo) |
| **D-PC-8** | As etiquetas da biblioteca: modelo aberto no servidor ou a IA da Anthropic? | **O modelo aberto SigLIP2 no worker** (Apache-2.0, em CPU, sem custo por foto), medido na VPS antes; as etiquetas como texto e o `pgvector` só se a busca livre provar valor (seção 12.4). A IA da Anthropic, só nas 30 miniaturas do raio-x e nos casos de dúvida |
| **D-PC-9** | Trazer os posts antigos do Instagram para a biblioteca? | **Sim**, só os da própria conta, com a origem marcada; o vídeo com música licenciada não vem |
| **D-PC-10** | De onde vêm as tendências? | **Pulso** (eventos e notícias do ramo) e as **tendências de busca abertas** (seção 6.3). Nada de raspar o Instagram ou o TikTok, que as regras deles proíbem |
| **D-PC-11** | As cores da marca entram nos modelos de vídeo e de carrossel? | **Sim**, depois de a pessoa confirmar a identidade proposta pelo raio-x; até lá, as cores de hoje |
| **D-PC-12** | Como o resumo chega ao Mister? | **O Liame envia** ao Regem pelo escopo novo `marketing.resumo.enviar`; o Regem guarda e o Mister lê do próprio banco. A alternativa, o Regem consultar o Liame na hora da conversa, deixa o Mister lento e dependente do Liame no ar |
| **D-PC-13** | Quem vê o marketing no Regem? | O **presidente**. O gerente, só se o presidente liberar, e sem os blocos de dinheiro |
| **D-PC-14** | O Mister pode pedir mudança no plano? | **Numa segunda fase:** a fala do presidente vira um pedido no Liame, que vai a Aprovações como qualquer outro. Na primeira fase, o Mister mostra e manda o link |
| **D-PC-15** | Quem define a meta do objetivo? | O **código propõe** pela média das últimas 4 semanas da conta (por exemplo, +20% de envios) e a pessoa ajusta |
| **D-PC-16** | E a música e o áudio em alta? | **Pela API de áudio no Reels** (desde 01/06/2026), com as faixas em alta como fonte de tendência, **depois de conferir** quais músicas uma conta comercial pode usar e o que acontece com a música que sai do catálogo. Até lá, e em foto, carrossel e Story, o Reels com música vai como pacote pronto (Z8) |
| **D-PC-17** | Trial Reels e colaboração entram? | **Sim, como itens possíveis do plano:** o Trial Reels para testar ideias com quem não segue (objetivo de seguidores) e a colaboração com até 3 contas (fornecedor, parceiro, evento), sempre com aprovação |
| **D-PC-18** | As datas de feriado estadual e municipal: a biblioteca date-holidays (dados CC BY-SA 4.0, que pedem atribuição) ou uma tabela própria? | **Tabela própria**, com a fonte de cada data (a regra do §16.5), e a BrasilAPI para conferir os nacionais. A date-holidays só depois de conferir com o advogado o que a CC BY-SA pede de quem mostra os dados a clientes |

## 11. Protótipos (antes do código de tela)

- **P47 · Planejar conteúdo**, na Agenda: o pedido (intervalo, objetivo, destaque, mix sugerido); o calendário em semana e em mês, com cada item e o porquê dele; o "Foto a produzir"; a aprovação do calendário e do lote da semana; o resultado de cada item e o ajuste proposto.
- **P48 · Raio-x do Instagram e biblioteca:** o cartão do raio-x em Minha marca; a identidade visual proposta para confirmar; a biblioteca com etiquetas, busca, duplicados, qualidade, uso e os trechos de vídeo.
- **P49 · No Regem, o Mister com o marketing:** as conversas (pergunta, resumo da semana, sugestão, aviso) e a autorização do escopo novo na ligação Regem–Liame, no modelo do `mockups/regem-mister.html` do Regem.

## 12. Bibliotecas de código aberto

*(Pesquisa de 27/11/2026 no GitHub e no Hugging Face; a licença, a versão e a data de cada uma na base §20.5.)*

### 12.1 Como foi escolhido

- **O servidor do Liame:** Node e TypeScript. A VPS só tem CPU, e o worker roda as filas (pg-boss).
- **Licença:** cada biblioteca precisa servir a um SaaS comercial. Ficam de fora a AGPL, a GPL ligada ao código e as licenças "não comercial" ou "só pesquisa".
- **Abandono:** ficam de fora os projetos sem atualização há mais de 18 meses.
- **Ordem de preferência:** primeiro o que roda em Node (pacote npm, ONNX ou WASM); Python só num worker à parte, e só se não houver jeito em Node.
- **Tempos:** os de CPU são estimativas da pesquisa, não medidas. A regra é medir na VPS antes de decidir (a parte 0 da PC2 e da PC3).

### 12.2 A pilha recomendada

| # | Para quê | Biblioteca ou modelo | Licença | Onde roda |
| --- | --- | --- | --- | --- |
| 1 | Base de toda imagem: reduzir, recortar, tirar quadros, cor dominante, nitidez e exposição (`stats()`) | **sharp** (já no Liame) | Apache-2.0 (a libvips, LGPL-3.0, ligada de forma dinâmica) | Node |
| 2 | Rodar os modelos abertos dentro do worker | **transformers.js** (`@huggingface/transformers`) + **onnxruntime-node** | Apache-2.0 e MIT | Node |
| 3 | Etiquetas e busca escritas em português, agrupar os modelos repetidos, achar a foto "parecida no sentido", nota de qualidade por pares de frases e pré-filtro dos quadros de vídeo | **SigLIP2 base** (Google, `google/siglip2-base-patch16-224`, versão ONNX) | Apache-2.0 | Node (transformers.js) |
| 4 | Duplicado exato ou quase exato | **imghash** (pHash), ou o pHash escrito sobre o sharp | MIT | Node |
| 5 | Paleta de cada post, com o peso de cada cor; a paleta da marca sai do agrupamento de todas | **node-vibrant** + **extract-colors** | MIT | Node |
| 6 | Texto na arte e onde a marca põe o texto (o "modelo" repetido) | **PaddleOCR** pelos modelos ONNX (`@gutenye/ocr-node`), com o **tesseract.js** de reserva | Apache-2.0 / MIT / Apache-2.0 | Node |
| 7 | Troca de cena e energia do som, para achar os melhores trechos do vídeo | **ffmpeg** (`scdet`, `ebur128`, `silencedetect`), chamado pela linha de comando; o **PySceneDetect** (BSD-3) só se precisar de mais precisão | Licença do ffmpeg instalado, sem ligar código | Linha de comando |
| 8 | Legenda do Reels pela fala ("legendas sempre", base §7.3) | **whisper.cpp** pelo `@remotion/install-whisper-cpp` + `@remotion/captions` | MIT (os pesos do Whisper também) | Node + binário |
| 9 | Datas | Tabela própria (o calendário comercial, ampliado com as datas de nicho), com a **BrasilAPI** (MIT) para conferir os feriados nacionais; a **date-holidays** só com atribuição, porque os dados dela são CC BY-SA 4.0 (D-PC-18) | MIT / ISC + CC BY-SA | Node |
| 10 | Tendências | **RSS do Google Trends** ("Em alta", Brasil) e o pedido de acesso à API oficial em alfa; **nada de pytrends** (arquivado) | Termos do Google | Node |
| 11 | Recorrência e exportar o calendário (.ics) | **rrule-temporal** + **ical-generator** | MIT | Node |
| 12 | Melhor horário e previsão | Primeiro, SQL com a média por dia e hora puxada para a média geral quando há poucos posts, mais o **simple-statistics** (ISC); o **statsforecast** (Apache-2.0, Python) só depois de uns 3 meses de dados | ISC / Apache-2.0 | Node; Python depois |

**O vídeo continua no Remotion**, que já monta os vídeos do Liame (Z15). A licença é grátis para empresa de até 3 pessoas (memória da decisão de 11/11/2026). Com 4 pessoas ou mais, vale a licença de empresa: US$ 0,01 por vídeo, mínimo de US$ 100 por mês. A licença muda no Remotion 5.0; reconferir quando sair. As alternativas abertas olhadas (Revideo, Motion Canvas, editly) estão paradas ou feitas para o navegador.

### 12.3 O que fica de fora, e por quê

| Biblioteca ou modelo | Por quê |
| --- | --- |
| MobileCLIP e MobileCLIP2 (Apple) | Os pesos são "exclusivamente para pesquisa" |
| pyiqa / IQA-PyTorch, CLIP-IQA, aesthetic-predictor-v2-5 | Licença não comercial (PolyForm Noncommercial, S-Lab) ou AGPL. O **método** do CLIP-IQA (pares de frases) é refeito sobre o SigLIP2 |
| RMBG da Bria, @imgly/background-removal-node | CC BY-NC, contrato com a Bria, ou AGPL. Para recortar o fundo da foto real, fica o **BiRefNet lite** (MIT, ONNX), opcional |
| Real-ESRGAN, UpscalerJS e outros ampliadores por IA | Inventam detalhe na foto, o que bate com a regra "nada gerado por IA" (D-A6-82). Para ampliar, o sharp (lanczos com nitidez) |
| Postiz (agendador aberto) | AGPL-3.0: serve para estudar a arquitetura, sem copiar código. O Mixpost Lite (MIT) e o social-media-agent da LangChain (MIT, agente → aprovação humana → agenda) também servem de estudo |
| pytrends, TransNetV2, editly, colorgram.py, NIMA | Abandonados ou arquivados |
| Raspadores do TikTok e do Instagram | Contra os termos das plataformas (D-PC-10) |

### 12.4 Onde guardar o que os modelos calculam

- **Fase 1:** as etiquetas viram texto, numa lista fixa tirada do cardápio do Regem e das cenas, escolhida pelo SigLIP2 sem treino ("zero-shot"). A busca é por essas etiquetas.
- **Fase 2:** os vetores do SigLIP2 só vão para o banco quando a busca livre ("batata de perto à noite") provar valor. A regra da revisão do plano mestre é: `pgvector` no próprio Postgres, sem banco de vetores à parte. A extensão `vector` 0.8.2 está disponível no Supabase do Liame e não está instalada (lido em 27/11/2026).

A recomendação da D-PC-8 sai daqui: **SigLIP2 no worker**, sem custo por foto, com a IA da Anthropic só na descrição das 30 miniaturas (D-PC-7) e nos casos em que o modelo aberto fica em dúvida.

## 13. Entregas propostas

Cada entrega:
- nasce desligada e passa primeiro na Mister Burgers;
- tem protótipo aprovado antes de tela nova;
- atualiza o jurídico no mesmo PR quando mudar o que ele diz.

| Entrega | O que faz | Depende de | Tamanho |
| --- | --- | --- | --- |
| **PC1 · Raio-x por código** | A leitura de até 12 meses (D-PC-6), os números da seção 5.1 e o cartão em Minha marca | P48 | M |
| **PC2 · Raio-x das imagens** | Paleta, modelos repetidos e texto na arte (5.2); a IA nas miniaturas, desligada (5.3); a identidade proposta para confirmar | PC1, D-PC-7 | M |
| **PC3 · Biblioteca inteligente** | Etiquetas, busca, duplicados, qualidade, uso, trechos de vídeo e trazer do Instagram (6.1) | D-PC-8, D-PC-9, P48 | G |
| **PC4 · Produtos e datas** | O ranking de produtos pelo código do Regem (6.2); as datas de nicho; a leitura do Pulso e das tendências de busca (6.3) | — | M |
| **PC5 · O plano de conteúdo** | O pedido, o calendário do Estrategista, as regras do código (7.3) e a aprovação do calendário | PC1, PC4, P47 | G |
| **PC6 · As peças** | O Social media faz cada peça; os modelos com as cores da marca; a capa do Reels; o lote da semana em Aprovações | PC5, PC2 (cores) | G |
| **PC7 · Carrossel no trilho** | Publicar o carrossel no Instagram e na Página (montado por código ou com as fotos da biblioteca) | Base reconferida antes (§2.2) | M |
| **PC8 · Medir e ajustar** | A medida de cada item, o relatório da semana, as regras do "o que mudar" e o ajuste proposto | PC5 | M |
| **PC9 · Campanhas do plano** | Impulsionar foto e carrossel publicados (a X5, parte 6, estendida); a campanha de produto, oferta e evento junto do plano; a sugestão pelo cardápio | PC4, PC8, X5 | M |
| **PC10 · O resumo para o Mister (Liame)** | O conjunto dos blocos A a I (seção 9.2), calculado por código, e o envio ao Regem | PC8; o escopo novo na porta do Regem | M |
| **PC11 · O marketing no Mister (Regem)** | O escopo `marketing.resumo.enviar` na porta, a tabela `marketing_resumo` (só nuvem), a ferramenta do Mister, o bloco no resumo da semana e os avisos | P49; plano no Regem | M |

**Ordem recomendada:** PC1 e PC4 (dado, sem gastar nada) → PC5 com os formatos de hoje → PC7 e PC6 → PC8 → PC2 e PC3 → PC9 → PC10 e PC11.

O plano funciona desde a PC5, mesmo sem as imagens analisadas. A biblioteca inteligente e a análise das imagens melhoram o plano depois, sem segurar o resto.

## 14. Cuidados

- **Nada gerado por IA na imagem nem no vídeo** (D-A6-72, D-A6-82): a arte e o vídeo saem montados por código sobre a mídia real da loja. A IA escreve, enxerga e decide.
- **Direito de imagem:** a foto e o vídeo enviados são da empresa (Termos); a biblioteca avisa quando há pessoas na imagem.
- **Música:** só no Reels, pela API de áudio da Meta, e só depois de conferir o que a conta comercial pode usar (D-PC-16). Música de outro lugar nunca entra no vídeo montado.
- **Comida e bebida:** o texto segue o §6.2 e a D-A4-34 (bebida alcoólica).
- **Custo:** a análise com IA e as tendências pagas nascem desligadas, com o preço ao lado. O custo de cada plano (IA) é medido na primeira rodada na Mister Burgers e mostrado antes de ligar para os outros.
- **Freshness:** o raio-x e o resumo do Mister mostram a data da leitura; número velho aparece como velho.
- **Permissões:** a leitura dos números da conta e dos posts usa as permissões que o piloto já tem; para clientes de fora, entram na análise da Meta do fim do roteiro (base §19.7).
- **Conferir antes do código** (o que a §20 marcou como não confirmado):
  - se `online_followers` segue na tabela de hoje (PC1);
  - quais músicas da API de áudio uma conta comercial pode usar (D-PC-16);
  - se o Story conta na cota de publicações e o que acontece com mais de 5 hashtags pela API (PC5);
  - o carrossel na v26.0 do Liame (PC7);
  - o tempo e a memória do SigLIP2 e do OCR na VPS (PC2 e PC3, parte 0).

## 15. Documentos jurídicos que mudam (`CLAUDE.md` §6)

| Entrega | O que muda |
| --- | --- |
| PC1 a PC3 | **Política de Privacidade:** a análise dos posts e das imagens da própria conta (números, cores, modelos e, com a IA ligada, a descrição das miniaturas pelo provedor de IA que já está na lista de fornecedores); as fotos trazidas do Instagram para a biblioteca, com o mesmo prazo e expurgo das fotos enviadas |
| PC4 | **Política:** os dados públicos do Pulso e das tendências de busca (sem dado pessoal) |
| PC5 a PC7 | Nada novo: é a publicação aprovada dos Termos 2.6 |
| PC10 e PC11 | **Política e Contrato de Dados:** o envio do resumo de marketing ao sistema ligado (o Regem), só agregado, sem dado de cliente. No Regem, a política dele ganha o recebimento |

## 16. O que depende de você

1. Aprovar o plano e as decisões D-PC-1 a D-PC-18 (ou trocar as que quiser).
2. Aprovar os protótipos P47, P48 e P49, quando ficarem prontos.
3. Ligar as funções na Mister Burgers quando cada entrega estiver pronta (eu preparo a linha).
4. Ligar a análise com IA (D-PC-7) depois de ver o preço medido.

## 17. Andamento

| Entrega | Situação |
| --- | --- |
| Plano | Proposto em 27/11/2026 |
