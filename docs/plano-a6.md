# Liame — Plano da fase A6 · Mais canais

> **Aprovado pelo dono em 09/10/2026** ("plano a6 aprovado"), com as decisões D-A6-1 a D-A6-18 como recomendadas (seção 4). A A6 é a "expansão" do roadmap (§2): a marca passa a ser cuidada **onde o cliente a procura sem anúncio** (o perfil no Google, as avaliações, a busca) e **onde ela fala sem pagar** (Instagram, Facebook e Threads), e a equipe ganha o funcionário de **Social media**. Vale a mesma regra das fases anteriores: **nada é publicado ou respondido em nome da empresa sem a aprovação de uma pessoa com o código do app.**
>
> A A6 depende da A5 (roadmap §2), e a A5 ainda espera os aceites dos protótipos e os pilotos. Por isso a ordem proposta começa pelo que **não depende** deles nem de foto guardada: o Google local (seção 3, Z1 a Z3).

## 1. De onde partimos (código e documentos lidos em 09/10/2026)

| Onde | Já existe | Falta |
| --- | --- | --- |
| **Trilho de ação** (A1 a A5) | Pedido, política, aprovação com o código do app amarrada ao plano, execução pelo worker, volta por ferramenta, auditoria. Ferramentas de anúncio (Meta e Google), cupom no Regem e mensagem pelo RegemCast (estas duas últimas com aprovação obrigatória) | Ferramentas de publicar um post e de responder a uma avaliação |
| **Google** (A2 e A5) | A autorização do Google (leitura do Google Ads e do GA4; a permissão de informar vendas, só com a função ligada). O app do Google em produção, sem a verificação | As permissões do Perfil da Empresa e do Search Console; o acesso à API do Perfil da Empresa, que o Google libera por pedido (começa com cota zero) |
| **Meta** (A2 e A4) | A autorização da Meta para ler e, na configuração de escrita, gerenciar anúncios | As permissões de publicar no Instagram e na Página; a autorização do Threads, que é separada |
| **Estrategista** (A3) | A pauta da semana: o que falar em cada dia, aprovada por uma pessoa | Transformar um item da pauta em post pronto para um canal |
| **Criativo** (A4) | Texto de anúncio (título, texto principal e botão), conferido pelo Compliance | Texto de post orgânico, com os limites de cada rede |
| **Fotos** (ADR-021) | A decisão: AWS S3 em São Paulo, privado. **A construção ficou para o fim do roadmap** | O armazenamento em si. Sem ele não há post com foto: o Instagram só publica a imagem que ele consegue buscar num endereço |
| **Links e cupons** (A2.5) | Link do cardápio com identificação por campanha, e a atribuição do pedido no caixa | Um link por post, para medir o que cada post trouxe |
| **Equipe** (A3 a A5) | "Social media" aparece em Sua equipe como funcionário da fase A6 | O funcionário de verdade, com os limites dele |
| **TikTok, YouTube, vídeo** | Só o registro na base de conhecimento | Tudo; e os trâmites (auditoria do TikTok) |

## 2. O que muda para quem usa

1. **As avaliações do Google num lugar só.** A nota, o que as pessoas escreveram e quais ainda estão sem resposta. O funcionário de Social media propõe a resposta; uma pessoa aprova; o Liame publica.
2. **Como te acham no Google.** Quantas pessoas viram o perfil, pediram rota, ligaram ou abriram o site, e quais buscas levaram ao cardápio. Entra em Resultados, ao lado do que os anúncios trouxeram.
3. **A pauta vira post.** Cada item da pauta aprovada vira um post com texto e foto de verdade do produto, com a prévia de como fica em cada rede. A pessoa aprova e escolhe quando sai.
4. **O que cada post trouxe.** Alcance e, pelo link do cardápio de cada post, os pedidos confirmados no caixa.
5. **Onde o Liame ainda não publica, ele entrega pronto.** Para TikTok, YouTube e as redes sem acesso: o texto, a foto ou o vídeo e o melhor horário, para a pessoa publicar.

## 3. Entregas no Liame

Cada entrega é um PR com CI verde. Migrations testadas no local e no CI e aplicadas na nuvem antes do merge (a última é a 0058). Letra **Z**. Antes do código: os protótipos da seção 5 e a reconferência da seção 8. **A ordem começa pelo que não depende de foto guardada nem dos pilotos da A5.**

| # | Entrega | O que fica pronto | Critérios | Depende de |
| --- | --- | --- | --- | --- |
| **Z1** | **Perfil no Google: leitura** | Conectar o Perfil da Empresa pela autorização do Google; ler as avaliações (nota, data, se foi respondida e a situação da resposta) e os números do perfil (vistas, rotas, ligações, cliques no site). Atenção avisa de avaliação nova de 1 ou 2 estrelas | A6-1, A6-2 | O Google liberar a API (trâmite; seção 9) |
| **Z2** | **Responder avaliação** | A ferramenta `avaliacao_responder` no trilho: o funcionário propõe a resposta, o Compliance confere, uma pessoa aprova com o código do app e o Liame publica. A resposta que o Google segura ou recusa aparece com o motivo dele | A6-3 a A6-5 | Z1 |
| **Z3** | **Search Console: leitura** | As buscas que levaram ao site ou ao cardápio (cliques, vezes em que apareceu, posição), por semana. Entra em Resultados e no que o Estrategista lê. Só leitura | A6-6 | O site verificado no Search Console |
| **Z4** | **Fotos guardadas** | O armazenamento do ADR-021, só para a foto enviada pela empresa: enviar, ver, apagar, e o expurgo. Sem imagem gerada por IA | A6-7 | Decisão D-A6-2 |
| **Z5** | **O post no trilho** | A ferramenta `post_publicar`: texto e foto aprovados, publicados uma vez em cada canal escolhido (Instagram, Página do Facebook, Threads e Perfil no Google). O que sai é exatamente o que foi aprovado. Flag `social_write`, desligada | A6-8 a A6-11 | Z4; as permissões da Meta |
| **Z6** | **Funcionário de Social media** | Transforma o item da pauta em post (o texto por canal, a foto escolhida entre as da empresa, o link do cardápio do post) e propõe as respostas às avaliações. Sempre com aprovação; sem sombra e sem subida de nível nesta fase. Eval próprio como portão | A6-12 | Z2 e Z5 |
| **Z7** | **O que cada post trouxe** | Leitura do alcance de cada post nas redes e dos pedidos pelo link do post. Entra em Resultados como canal | A6-13 | Z5 |
| **Z8** | **Pacote pronto** | Para TikTok, YouTube e redes sem acesso: o Liame monta o texto, a mídia e o horário, e a pessoa publica. Sem escrita em plataforma | A6-14 | Z4 |
| **Z9** | **Telas** | Pelos protótipos da seção 5 | A6-15 | Aprovação dos protótipos |

> **Andamento.** **P17 (09/10/2026; aprovado pelo dono no mesmo dia):** o protótipo `mockups/prototipo-avaliacoes.html`: a tela "Avaliações" (a nota, as sem resposta primeiro e a situação de cada resposta) e a resposta em Aprovações (a avaliação, o texto proposto e editável, "só o dono aprova" para 1 e 2 estrelas, a conferência do Google, publicada, recusada e apagada). Antes dele, a reconferência da seção 8 para a Z1 entrou na base de conhecimento (§3.3 e §16.1).

## 4. Decisões (aprovadas pelo dono em 09/10/2026, como recomendadas)

| # | Decisão | Recomendação | Por quê |
| --- | --- | --- | --- |
| D-A6-1 | **O que vem primeiro** | O Google local (Z1 a Z3), depois as fotos e o post (Z4 a Z7), depois o pacote pronto (Z8) | Para um restaurante, a avaliação e o "perto de mim" pesam mais que o post; e o Google local não precisa de foto guardada |
| D-A6-2 | **Antecipar o armazenamento de fotos** (ADR-021 ficou para o fim do roadmap) | Sim, só para a foto enviada pela empresa. A imagem gerada por IA (X7) e a campanha nova (X5) continuam no fim | Sem foto guardada não existe post no Instagram; é o mesmo armazenamento, usado mais cedo e por menos coisa |
| D-A6-3 | **Publicar e responder: sempre com aprovação** | Uma pessoa aprova com o código do app, vendo o texto, a foto e os canais. Sem modo automático na A6 | Falar em público em nome da empresa não se desfaz: apagar um post não apaga quem viu |
| D-A6-4 | **Avaliação de 1 ou 2 estrelas** | A resposta só sai com a aprovação do **dono** (não de qualquer aprovador), e o funcionário nunca oferece desconto, brinde ou reembolso por conta própria | É onde uma resposta ruim custa mais; compensação é decisão do dono |
| D-A6-5 | **O que guardar das avaliações** | A nota, a data, o texto e a situação da resposta, por 12 meses; **sem o nome e sem a foto de quem avaliou**, que são lidos na hora para a tela e não guardados | O texto serve para ver os temas ao longo do tempo; o nome não serve para nada disso |
| D-A6-6 | **A foto do post** | Só foto de verdade do produto, enviada pela empresa, como ela é. Sem edição e sem geração por IA nesta fase | É a linha da D-A4-28; comida gerada por IA em post orgânico engana quem vê |
| D-A6-7 | **Um post, vários canais** | A pessoa escolhe os canais; o texto pode mudar por canal (o Threads aceita até 500 caracteres); a aprovação vale para o conjunto, e mudar um texto é outro pedido | Uma aprovação só, sem publicar por engano o texto de uma rede em outra |
| D-A6-8 | **Quando o post sai** | Na hora que a pessoa escolher ao aprovar, entre 8h e 22h; quem segura a hora é o Liame | As redes publicam na hora em que recebem; o agendamento fica do lado do Liame, como no pedido de mensagem |
| D-A6-9 | **Formatos do Instagram** | Foto e carrossel no feed primeiro. Reels e Stories depois, quando houver vídeo guardado | Vídeo pede armazenamento maior e outra conferência; a foto resolve a pauta de um restaurante |
| D-A6-10 | **O endereço da foto para a Meta** | Um endereço assinado, que vale por poucos minutos, só na hora de publicar. O arquivo nunca fica público | A Meta busca a imagem num endereço; o ADR-021 não aceita arquivo público. **A conferir num teste antes do código** (seção 8) |
| D-A6-11 | **Apagar um post** | Pelo Liame só o que o Liame publicou, com aprovação, e onde a rede deixar. É a "volta" do post, e o pedido diz que apagar não desfaz quem já viu | A mesma regra da mensagem enviada: a volta é parcial e a tela diz isso |
| D-A6-12 | **TikTok e YouTube** | Na A6, só o pacote pronto. Pedir a auditoria do TikTok agora; a publicação direta entra quando ela sair | Sem auditoria, o TikTok só publica em privado, para até 5 contas por dia: não serve ao cliente |
| D-A6-13 | **Vídeo curto gerado por IA** | Fora da A6 | A geração de vídeo segue experimental no que o Liame usa (base §17.4); e depende do armazenamento de vídeo |
| D-A6-14 | **E-mail, SMS e a LIA no WhatsApp** (vieram da A5) | Seguem fora da A6. Replanejar depois de o consentimento com prova (C3c) estar no ar e medido | Não existe base de e-mail com consentimento; a A6 já abre dois caminhos novos de escrita |
| D-A6-15 | **Quem cuida** | O funcionário de **Social media** (posts e avaliações), que já aparece em Sua equipe como fase A6 | Um nome que o dono já viu; avaliação é "comunidade", que é dele na especificação |
| D-A6-16 | **Como medir o post** | Cada post leva um link do cardápio só dele, pelo contrato de links que já existe. O pedido confirmado no caixa é o resultado; alcance e curtidas ficam como apoio | É a mesma régua dos anúncios e das mensagens: venda de verdade |
| D-A6-17 | **As permissões novas do Google e da Meta** | Pedidas só à empresa com a função ligada, como foi com a de informar vendas | Quem não usa não é incomodado com tela de permissão a mais, e a verificação dos apps cresce aos poucos |
| D-A6-18 | **Perfil no Google: mexer em horário, endereço e cardápio** | Fora da A6. Só avaliações, números e posts | Mudar o horário errado fecha a loja no mapa; fica para depois de as respostas e os posts andarem bem |

## 5. Protótipos para aprovação (antes do código de tela)

| # | Tela | O que mostra |
| --- | --- | --- |
| **P17** | Avaliações | A nota, as avaliações sem resposta primeiro, a resposta proposta em Aprovações, e a situação da resposta no Google |
| **P18** | Como te acham no Google | Em Resultados: os números do perfil e as buscas que levaram ao cardápio |
| **P19** | O post para aprovar e o calendário | O post em Aprovações, com a prévia por canal, a foto, o link e a hora; o calendário da semana com o que saiu e o que espera |
| **P20** | Fotos | Enviar, ver e apagar as fotos da empresa |
| **P21** | O funcionário de Social media em Sua equipe | A ficha no desenho dos outros |
| **P22** | Pacote pronto | O que copiar e baixar para publicar onde o Liame não publica |

## 6. Critérios de saída da A6

| # | Critério | Como é verificado |
| --- | --- | --- |
| A6-1 | Nenhum nome ou foto de quem avaliou é guardado | Teste que inspeciona o que foi gravado |
| A6-2 | A cota do Perfil no Google é respeitada: no limite, a leitura espera, não insiste | Teste do conector |
| A6-3 | Nenhuma resposta a avaliação sem a aprovação de uma pessoa com o código do app; a de 1 ou 2 estrelas, só do dono | Teste e política |
| A6-4 | A resposta publicada é exatamente a aprovada; a avaliação que mudou depois do pedido não é respondida com o texto antigo | Teste de concorrência |
| A6-5 | O texto da resposta passa pelo Compliance antes de aparecer | Teste e eval |
| A6-6 | O Search Console é só leitura: nenhuma ferramenta escreve nele | Teste do registro de ferramentas |
| A6-7 | A foto é privada: sem endereço público permanente; o expurgo apaga o arquivo | Teste com o armazenamento |
| A6-8 | Nenhum post sem a aprovação de uma pessoa com o código do app | Teste e política |
| A6-9 | O post sai uma vez só em cada canal, mesmo com a execução repetida | Teste com a rede caindo no meio |
| A6-10 | O que é publicado é exatamente o texto e a foto aprovados | Teste que compara o enviado com o aprovado |
| A6-11 | O limite de posts por dia de cada rede é consultado antes; no limite, o post espera | Teste do conector |
| A6-12 | Eval do funcionário de Social media como portão | CI (modo gravado) e uma rodada com o modelo de verdade |
| A6-13 | O pedido pelo link do post aparece em Resultados, ligado ao post | Teste com banco |
| A6-14 | O pacote pronto não escreve em nenhuma plataforma | Teste |
| A6-15 | Telas P17 a P22 conforme o protótipo aprovado, em 1440, 1024, 768 e 375 px, claro e escuro | Verificação no navegador |
| A6-16 | **Piloto:** cinco avaliações respondidas e cinco posts publicados, com o resultado medido | Registro com prints |
| A6-17 | Documentos jurídicos atualizados nos mesmos PRs (seção 7) | README jurídico |

## 7. Documentos jurídicos que mudam (`CLAUDE.md` §6)

| Entrega | O que muda |
| --- | --- |
| Z1 e Z2 | **Política de Privacidade e Anexo I:** o Liame passa a ler avaliações públicas (texto de terceiros) e a publicar respostas em nome da empresa. Dizer o que é guardado, por quanto tempo e o que não é (o nome e a foto de quem avaliou) |
| Z3 | **Política de Privacidade:** as buscas e os números do Search Console (sem dado pessoal) |
| Z4 | **Política de Privacidade e a lista de fornecedores:** as fotos da empresa no armazenamento (AWS, São Paulo), o prazo e o expurgo |
| Z5 a Z7 | **Termos:** a publicação em nome da empresa, com a aprovação de uma pessoa; de quem é a responsabilidade pelo conteúdo e pelo direito de imagem da foto enviada. **Política:** o que vai para cada rede |
| Trâmites | A verificação do app do Google e a revisão do app da Meta passam a incluir as permissões novas |

## 8. Base de conhecimento: reconferir antes do código (`CLAUDE.md` §1)

- **Conferido em 09/10/2026, nas páginas oficiais (base §2.2, §3.3 e §4):**
  - **Perfil da Empresa no Google:** para pedir o acesso, o perfil precisa estar verificado e ativo há 60 dias ou mais e ter um site; o projeto começa com cota zero e passa a 300 consultas por minuto quando aprovado; o pedido é pelo formulário de contato da API, com um e-mail que seja dono ou gerente do perfil (`developers.google.com/my-business/content/prereqs`, atualizada em 28/08/2026). Em 2026 as avaliações ganharam a situação da resposta (01/04), as mídias da avaliação (20/04), a violação de política (01/07) e o endereço da resposta (24/07), e os posts ganharam a repetição (07/04); nenhuma descontinuação anunciada (`…/content/latest-updates`).
  - **Instagram:** só imagem JPEG; carrossel de até 10; 100 posts publicados pela API a cada 24 horas, com a consulta do limite em `content_publishing_limit`; "the media must be hosted on a publicly accessible server at the time of the attempt"; conta profissional ligada a uma Página; permissões `instagram_basic`, `instagram_content_publish` e `pages_read_engagement`; sem etiqueta de compra e sem filtro (`developers.facebook.com/docs/instagram-platform/content-publishing`).
  - **Threads:** post só de texto (`media_type=TEXT`), até 500 caracteres e 5 links; imagem e vídeo por endereço público; dois passos (criar e publicar, com cerca de 30 segundos entre eles); 250 posts, 1.000 respostas e 100 exclusões a cada 24 horas; permissões `threads_basic`, `threads_content_publish`, `threads_manage_replies` e `threads_delete` (`developers.facebook.com/docs/threads`).
  - **Search Console:** 1.200 consultas por minuto por site e por usuário; até 50 mil linhas por dia por tipo de busca (`developers.google.com/webmaster-tools/limits`).
  - **TikTok:** "All content posted by unaudited clients will be restricted to private viewing mode" (`developers.tiktok.com/doc/content-posting-api-get-started`, atualizada em 04/08/2026); o limite de 5 contas a cada 24 horas veio só pelo trecho da busca.
- **Reconferido em 09/10/2026, para a Z1 (base §3.3):** os métodos e os campos das avaliações, das contas e lojas e dos números do perfil; todos pedem a permissão `business.manage`. **Segue a conferir:** se ela é sensível na verificação do app (uma fonte secundária diz que sim; conferir no Cloud Console).
- **Reconferir antes da Z2:** o método de responder, o que a situação da resposta devolve e os limites de tamanho.
- **Conferir num teste antes da Z5 (D-A6-10):** se a Meta aceita buscar a imagem num endereço assinado de curta duração; se não aceitar, a decisão volta ao dono antes do código.
- **Reconferir antes da Z5:** publicar na Página do Facebook (a permissão e o método), o post no Perfil do Google, e se alguma das redes aceita agendar do lado dela.
- **Reconferir antes de voltar ao vídeo (D-A6-13):** se a geração de vídeo saiu do experimental no que o Liame usa (base §17.4, lida em 2026 e não reconferida hoje).
- **Reconferir antes da Z7:** as métricas de cada post em cada rede, depois das mudanças de métricas da Meta de 2025 e 2026 (base §2.2).

## 9. O que depende de você

| Para | Preciso de |
| --- | --- |
| Começar | ✅ Aceite deste plano e das decisões da seção 4 (09/10/2026) |
| Z1 | Saber se a Mister Burgers tem o Perfil da Empresa no Google verificado há mais de 60 dias, com site. Com isso, o pedido de acesso à API (eu guio, um print por vez); o Google não diz o prazo |
| Z3 | Saber se o site ou o cardápio está no Search Console; se não, verificar (eu guio) |
| Z4 | O aceite da D-A6-2 e as primeiras fotos dos produtos |
| Z5 | No piloto: o Instagram como conta profissional, ligado à Página do Facebook; autorizar a Meta de novo com as permissões de publicar; autorizar o Threads, se usar |
| Z8 | Cadastro de desenvolvedor no TikTok e o pedido da auditoria (eu guio) |
| Telas | ✅ P17 aprovado (09/10/2026). Aprovar os protótipos P18 a P22 |
| Antes de clientes de fora | A revisão do app da Meta e a verificação do app do Google com as permissões novas |

## 10. Riscos

| Risco | Mitigação |
| --- | --- |
| O Google demorar ou negar o acesso à API do Perfil | Pedir logo depois do aceite; a Z3 (Search Console) e a Z4 (fotos) não dependem dele |
| Resposta pública ruim a uma avaliação | Compliance antes; aprovação com o código; 1 e 2 estrelas só com o dono; sem compensação por conta própria |
| Post errado no ar | Aprovação com a prévia por canal; o que sai é o aprovado; apagar pelo trilho |
| A foto ficar pública | Endereço assinado de minutos; teste antes do código; se a Meta não aceitar, a decisão volta ao dono |
| Foto com pessoa ou sem direito de uso | Os Termos dizem de quem é a responsabilidade; a tela avisa ao enviar |
| A rede mudar a API | O Vigia de integrações (ADR-015) já acompanha as versões; os conectores novos entram nele |
| A fase crescer demais | Três blocos que param sozinhos: o Google local, o post e o pacote pronto. Cada um entrega valor sem o seguinte |
| Os pilotos da A5 não começarem | O Google local não depende deles |

## 11. Fora da A6

Mexer em horário, endereço e cardápio do Perfil no Google; Reels e Stories; publicação direta no TikTok e no YouTube; vídeo gerado por IA; e-mail, SMS e a LIA no WhatsApp; públicos de anúncio com lista de clientes; LinkedIn, Pinterest, X e Kwai; execução sem aprovação (A7).
