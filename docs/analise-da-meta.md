# A análise da Meta: o envio único (rascunho de 12/11/2026)

> **Para que serve:** juntar num envio só, à análise da Meta (App Review), as permissões que o Liame já usa no piloto com
> contas que têm papel no app e que os clientes de fora vão precisar. O envio em si é do dono, no painel do app na Meta:
> os vídeos são gravados com o login dele. Este documento prepara o que vai em cada permissão: o que o Liame faz com ela,
> onde aparece, o roteiro do vídeo e o rascunho do texto do uso (em inglês, como o formulário da Meta pede).
>
> **Decisões que o pedem:** o dono decidiu em 12/11/2026 pedir o acesso avançado de `read_insights`,
> `pages_read_engagement`, `instagram_basic` e `instagram_manage_insights` (os números do Instagram e da Página para
> clientes de fora); a D-A6-81 já previa pedir a análise das permissões de mensagens e de comentários quando cada recurso
> estivesse pronto (roadmap, itens 6 e 9). As duas sessões combinaram um envio só (a da região escreve o uso de Sua
> região; esta conduz o documento).

## 1. O que precisa estar pronto antes de enviar

| Item | Situação | Quem |
| --- | --- | --- |
| O portfólio da empresa verificado na Meta | ✅ (o app está no portfólio verificado; `configuracao.md`, "Apps OAuth") | — |
| A política de privacidade, os termos e as instruções de exclusão de dados no ar | conferir no site antes de enviar (`configuracao.md` cita como pendência antiga) | o dono, com o link |
| As permissões na configuração de escrita do login da Meta | as 3 dos comentários entraram em 08/11/2026; as de mensagens ainda não (plano-a6, Z12/Z14) | o dono, guiado na hora |
| Conectar a Meta de novo na conta de testes, depois de somar as permissões | falta (plano-a6, Z11) | o dono |
| A função de cada recurso ligada na empresa de testes, para o vídeo mostrar a tela no ar | `comentarios`, `direct`, `messenger` e os números: conferir na produção antes de gravar | o dono liga; esta sessão prepara a linha |
| As instruções de teste para o analista (o login de teste e o caminho de cada tela) | este documento, seção 3 | esta sessão |
| A `pages_show_list` junto da `pages_read_engagement` (a Meta exige: "Seu envio deve incluir as pages_show_list…") | ✅ no rascunho do painel (12/11/2026, pela sessão da região, com o dono logado); ela fica na lista de Provedor de Tecnologia | — |

**O rascunho no painel da Meta (submission 1441909268031807), em 12/11/2026:** 5 permissões configuradas, nada enviado —
`read_insights`, `instagram_manage_insights`, `pages_read_engagement`, `instagram_basic` (o "Uso permitido" com os textos
da seção 4, sem a frase da região, que ainda não está no ar; os quatro com o visto verde) e `pages_show_list`. Preenchido
no mesmo dia pela sessão da região, a pedido do dono:
- **Uso permitido:** o "você concorda" das 5 permissões novas, marcado. A aba "Renovação" pede ainda a certificação do
  `ads_read` ("Certifico que todo e qualquer uso de ads_read está dentro do permitido"): fica para o dono, porque não
  estava no pedido dele. A etapa segue aberta por ela e pelos vídeos.
- **Tratamento de dados:** ✅, com as respostas que vieram do envio aprovado do `ads_read`, conferidas uma a uma: os
  operadores (Anthropic, AWS, Cloudflare, Hostinger e Supabase), a responsável (a empresa do dono, no Brasil), nenhum
  pedido de autoridade pública e as 4 políticas para esses pedidos marcadas.
- **Instruções da análise:** ✅. O passo 8 dizia que a única permissão pedida era o `ads_read`: agora diz que o login pede
  também a Página e o Instagram, e que o dono escolhe a Página e a conta do Instagram dela. Entrou a seção "WHERE THE PAGE
  AND INSTAGRAM PERMISSIONS ARE USED", com os passos 11 a 14 (11: `pages_show_list`, a escolha da Página na conexão; 12:
  `instagram_basic` e `instagram_manage_insights`, Fotos › Do seu Instagram; 13: `pages_read_engagement` e
  `read_insights`, Agenda › o post publicado › "O que o post trouxe"; 14: só a conta da própria marca, nenhum seguidor por
  nome). O bloco da conta de teste ficou como estava.

**Faltam no rascunho:** os vídeos (o dono decidiu, em 12/11/2026, deixá-los para o fim do roadmap); a certificação do
`ads_read` (o dono); e as permissões de comentários e de mensagens, que entram no **mesmo rascunho**, com a seção delas nas
Instruções da análise a partir do passo 15. Ninguém clicou em "Enviar para análise".

## 2. As permissões

Cada linha diz o que o Liame faz, onde (o caminho do menu, conferido em `apps/web/src/components/shell/navegacao.ts` em
12/11/2026) e se a função já está no ar no piloto. **Conferir de novo os caminhos no dia da gravação** (regra do caminho
de menu confirmado).

| Permissão | O que o Liame faz com ela | Onde aparece | Situação no Liame |
| --- | --- | --- | --- |
| `instagram_basic` | Lê o perfil e as publicações da conta do Instagram da marca: a lista de "Do seu Instagram" (o Reels e o post, com a miniatura e a legenda) | Fotos › Do seu Instagram | No ar (A6, Z10, parte 5) |
| `instagram_manage_insights` | Lê os números de cada publicação (visualizações, alcance, curtidas, comentários, salvamentos e compartilhamentos) e os do perfil | Fotos › Do seu Instagram (a gaveta da publicação); Agenda › o post publicado › "O que o post trouxe" | No ar |
| `pages_show_list` | Mostra, na conexão, a lista das Páginas que o dono administra, para ele escolher a Página do restaurante (e o Instagram ligado a ela); depois, o Liame trabalha só com a Página escolhida | Contas conectadas › conectar a Meta (o passo de escolher a Página) | No ar (a Meta exige com a `pages_read_engagement`) |
| `pages_read_engagement` | Lê as publicações da Página do Facebook e o engajamento delas | Agenda › o post publicado › "O que o post trouxe" | No ar |
| `read_insights` | Lê os números da Página e das publicações dela | Agenda › o post publicado › "O que o post trouxe" | No ar |
| `instagram_manage_comments` | Lê os comentários dos posts da marca no Instagram, responde (com aprovação de uma pessoa), oculta e mostra de novo | Comentários | No ar no piloto (A6, Z11), só com contas que têm papel no app até a análise |
| `pages_read_user_content` | Lê os comentários dos posts da Página | Comentários | Idem |
| `pages_manage_engagement` | Responde, oculta e mostra os comentários da Página | Comentários | Idem |
| `instagram_manage_messages` *(o nome exato na configuração do login: conferir no painel)* | Recebe as mensagens do Direct da conta da marca e responde, dentro da janela de 24 horas da Meta | Direct (ou "Direct e Messenger") | No código (A6, Z12); o piloto é atendido pela Central do Regem |
| `pages_messaging` | Recebe e responde as mensagens da Página no Messenger, dentro da janela da Meta | Direct e Messenger | No código (A6, Z14) |
| `pages_manage_metadata` | Inscreve o app nos avisos da Página (as mensagens e os comentários chegam na hora) | — (sem tela própria) | No código |

**A parte da região (escrita pela sessão da região em 12/11/2026):** os números da conta do Instagram e da Página, e não de
cada publicação, em **Minha marca › Região › Sua região › "O público nas redes"**.
- **Fonte:** plano da região, R4, parte 3; revisão R4-3 do protótipo P40 (estados 28 a 30), aprovada pelo dono em 12/11/2026; base §19.7.
- **Situação:** **em construção** no dia deste rascunho. Os 4 pedidos de acesso avançado já estão no rascunho de análise do app, adicionados pela sessão da região em 12/11/2026, com o dono presente.
- **Quem vê:** quem vê Minha marca › Região.
- **Quando lê:** uma leitura por dia, só com a função `regiao` ligada na marca.
- **O que nunca aparece:** seguidor nenhum por nome; os números são somados.

- **`instagram_manage_insights` em Sua região:**
  - os seguidores do Instagram e como mudam nas 4 semanas (o campo `followers_count`, com a série guardada pelo Liame, e `follows_and_unfollows`);
  - os toques nos botões do perfil: "como chegar", "ligar" e "mensagem" (`profile_links_taps`);
  - de que cidades são os seguidores (`follower_demographics` com `breakdown=city`: as 45 maiores, só com 100 seguidores ou mais).
- **`read_insights` e `pages_read_engagement` em Sua região:**
  - os seguidores da Página e quem seguiu ou deixou de seguir (`page_follows`, `page_daily_follows_unique` e `page_daily_unfollows_unique`);
  - as visitas à Página (`page_views_total`).
  - A cidade não: a Meta tirou as métricas de cidade da Página em 15/11/2025.
- **`instagram_basic` em Sua região:** o perfil da conta ligada (o nome e o `followers_count`), base dos números acima.
- **Linha do vídeo (só se a seção estiver no ar no dia da gravação):**
  1. Em Minha marca › Região, rolar até "O público nas redes" e mostrar os seguidores, os toques e as cidades.
  2. No app do Instagram, abrir o painel profissional › Insights › Público e mostrar os mesmos seguidores e as mesmas cidades.
  3. No Business Suite, mostrar os seguidores da Página.
- **Recomendação da sessão da região:** não segurar o envio por esta seção. As 4 permissões já aparecem em telas no ar ("Do seu Instagram" e "O que o post trouxe"). Se ela entrar no ar antes da gravação, acrescente a linha do vídeo e a frase em inglês da seção 4.

## 3. Os vídeos (um por permissão, ou um que passe por todas, como a Meta aceitar)

O que a análise do `ads_read` ensinou (20/10/2026, recusa e aprovação no mesmo dia): **o analista quer ver o número lido ao
vivo no painel, da mesma conta, e o login da Meta no começo do vídeo**. Então, em cada vídeo:

1. Abrir o Liame deslogado, entrar, ir a Contas conectadas e conectar a Meta (o login da Meta aparece, com a lista de
   permissões e as contas escolhidas).
2. Ir à tela da permissão (seção 2) e mostrar o dado lido.
3. Abrir o mesmo dado no Instagram ou na Página (ou no Meta Business Suite), lado a lado, para o analista ver que bate.
4. Nas permissões de escrita (responder, ocultar, mandar mensagem): fazer a ação no Liame (com a aprovação, quando a tela
   pede) e mostrar o resultado no Instagram ou na Página.

**Roteiros por grupo (rascunho):**

- **A lista das Páginas (`pages_show_list`):** o passo da conexão em que o dono escolhe a Página do restaurante (Contas
  conectadas › conectar a Meta), com a lista das Páginas que ele administra; depois, mostrar que o Liame só usa a Página
  escolhida.
- **Os números (`instagram_basic`, `instagram_manage_insights`, `pages_read_engagement`, `read_insights`):** Fotos › Do
  seu Instagram, abrir o primeiro Reels e mostrar as visualizações e as curtidas; abrir o mesmo Reels no Instagram e
  mostrar os mesmos números. Depois, Agenda › um post publicado › "O que o post trouxe", e a Página no Business Suite.
- **Os comentários (`instagram_manage_comments`, `pages_read_user_content`, `pages_manage_engagement`):** comentar num post
  da marca com uma conta de teste; em Comentários, o comentário aparece; responder (o pedido vai para Aprovações e é
  aprovado com o código do app); mostrar a resposta no Instagram; ocultar um comentário e mostrar que ele sumiu para os
  outros.
- **As mensagens (`instagram_manage_messages`, `pages_messaging`, `pages_manage_metadata`):** mandar uma mensagem para a
  marca no Direct (e na Página) com uma conta de teste; ela aparece em Direct e Messenger; responder pelo Liame e mostrar a
  resposta no app do Instagram (e no Messenger).

## 4. Os textos do uso (rascunhos em inglês, para o formulário)

> No painel, cada texto começa com "Liame is a marketing tool for restaurants." (a sessão da região usou assim nos quatro
> de números, em 12/11/2026).

- **`pages_show_list`** *(o texto que está no rascunho do painel, escrito pela sessão da região em 12/11/2026)*: "Liame is
  a marketing tool for restaurants. When the owner connects their business, Liame uses pages_show_list to show the list of
  Facebook Pages they manage, so they can pick the restaurant's own Page (and the Instagram account linked to it). Liame
  then works only with the Page the owner chose: publishing the approved posts, reading the posts' results and creating
  ads in the name of that Page."
- **`instagram_basic`:** "Liame is a marketing tool for restaurants. With instagram_basic, Liame reads the profile and the
  media of the restaurant's own Instagram professional account, so the owner can see their Reels and posts inside Liame
  ('From your Instagram') and use them as the base of new ads. Liame only reads the account the business connected."
- **`instagram_manage_insights`:** "Liame shows the restaurant owner how each of their own posts and Reels performed
  (views, reach, likes, comments, saves and shares) next to the orders that came from them, so they know which content
  sells. Only the connected account's own insights are read."
- **`pages_read_engagement` e `read_insights`:** "Liame reads the posts of the restaurant's own Facebook Page and their
  insights to show, in the post calendar ('What the post brought'), how each post performed. Only the Page the business
  connected is read."
- **`instagram_manage_comments`:** "Liame lists the comments on the restaurant's own Instagram posts, suggests a reply with
  AI and lets a person on the restaurant team approve and publish it, or hide an offensive comment. Nothing is published
  without a person's approval."
- **`pages_read_user_content` e `pages_manage_engagement`:** "The same for the comments on the restaurant's own Facebook
  Page posts: read, reply after a person approves, hide and unhide."
- **A frase da região (acrescentar ao fim do texto de `instagram_manage_insights` e ao de `pages_read_engagement` e
  `read_insights`, só se "O público nas redes" estiver no ar no dia da gravação):** "Liame also shows the account-level
  numbers of the connected Instagram account and Facebook Page on the 'Your region' page: the followers and how they
  change, taps on the directions, call and message buttons, Page views and the top cities of the Instagram followers, as
  Meta aggregates them, so the restaurant can check whether its audience lives in its delivery area. No follower is shown
  by name."
- **`instagram_manage_messages`:** "Liame shows the Direct messages sent to the restaurant's Instagram account and lets the
  restaurant team reply within Meta's 24-hour window. A person writes or approves each reply."
- **`pages_messaging` e `pages_manage_metadata`:** "The same for the Messenger conversations of the restaurant's Facebook
  Page; pages_manage_metadata subscribes the app to the Page webhooks so new messages and comments arrive in real time."

## 5. O que falta para enviar

1. A sessão da região completa a parte de Sua região (seção 2).
2. Conferir a política de privacidade, os termos e a exclusão de dados no ar, e os links no painel do app.
3. Somar as permissões de mensagens na configuração do login (o dono, guiado na hora) e conectar a Meta de novo.
4. Pôr no rascunho as permissões de comentários e de mensagens, com a seção delas nas Instruções da análise (do passo 15
   em diante).
5. A certificação do `ads_read` na aba "Renovação" (o dono).
6. Ligar as funções na empresa de testes e conferir cada tela no ar.
7. Gravar os vídeos (o dono, no fim do roadmap, como decidiu em 12/11/2026) e enviar (o dono).
