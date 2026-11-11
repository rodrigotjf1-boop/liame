# Liame — Plano: tráfego pago pela região da loja

> **Aprovado pelo dono em 11/11/2026** ("plano aprovado"), com as decisões D-RG-1 a D-RG-10 como recomendadas (seção 6). O andamento das entregas está na seção 8. Proposta de 09/11/2026. Pedido do dono: o Liame trabalhar como um gestor de tráfego profissional, com campanhas por região, de reconhecimento, de seguidores e de pedidos, montadas em cima de dados da região de cada empresa (renda, gente, concorrência, horários, tíquete), buscados em fontes públicas e gratuitas que viram **padrão de pesquisa**: o mesmo caminho vale para uma empresa em qualquer município, não só para o piloto.
>
> As fontes, com o endereço de cada consulta e o exemplo conferido, estão na base de conhecimento, **§19**. Este plano diz o que fazer com elas. As decisões estão na seção 6 (D-RG-1 a D-RG-10), cada uma com a recomendação. Quando aprovadas, as entregas entram no roadmap e nos planos das fases (a X5 da A4 e a Y9 da A5 já são prioridade e absorvem parte daqui).

## 1. De onde partimos (código e documentos lidos em 09/11/2026, `origin/main` 8e26ab6e)

| Onde | Já existe | Falta |
| --- | --- | --- |
| **Escrita na Meta e no Google** | Pausar, retomar e mudar a verba diária de campanha ou conjunto que já existe, com `validate_only`, aprovação pelo código do app e volta | Criar campanha, conjunto e anúncio (X5 na Meta e Y9 no Google, só no plano); objetivo, segmentação, raio, idade, posicionamento e horário |
| **Leitura de mídia** | Gasto, alcance, cliques e resultados por anúncio e por dia (Meta e Google); GA4; Search Console; Perfil da Empresa no Google (vistas, rotas, ligações) | Quebra por região e por hora; seguidores e números da conta do Instagram e da Página |
| **Ciclo fechado (Regem)** | Pedido, itens, custo, cupom, cliente novo, UTM e clique; ROAS no caixa; cupom exclusivo por campanha | Tíquete médio e pedidos por hora calculados; bairro dos pedidos (não vem do Regem) |
| **A loja** | Fuso; no dossiê, `region.area` (texto livre de 240 caracteres) e retirada no balcão | Endereço, CEP, código do município, bairro, coordenada e raio de entrega (o `data-model.md` prevê, a tabela `unit` não tem) |
| **Gestor de tráfego** | Regra sem modelo: pausar ou mudar a verba em 10% a partir do caixa de 7 dias, na Sombra ou como pedido no modo Aprovação | Estrutura de campanha, ritmo por horário, clima e data, testes |
| **Estrategista** | Pauta da semana, oferta e plano de 90 dias com a verba por canal | Plano de mídia (etapas do funil, raio, públicos, horários, criativo por público); nada do plano vira ação |
| **Pesquisador** | Lê a página que a empresa informa (site, cardápio, concorrente), sem busca aberta (D-A3-8) | Dados da região |
| **CRM (RegemCast)** | Público por UF e por bairro para o WhatsApp | O mesmo recorte nos anúncios |
| **Dado público no produto** | A PTAX (D-A3-14) e o calendário comercial: tabela do sistema, fonte e dia | Os dados da região (§19) |

O Liame já mede o que quase nenhum concorrente mede (o pedido confirmado no caixa) e já lê o Google local. O que falta é **saber onde a loja está e quem mora em volta**, e ter as ferramentas de montar campanha.

## 2. O padrão de pesquisa da região

Para qualquer empresa, o mesmo caminho (base §19.1):

1. **Endereço da loja → códigos.** CEP pelo ViaCEP (código IBGE do município, bairro, UF); coordenada pelo Perfil da Empresa no Google ou, na falta, pelo Nominatim; bairro do Censo pelo nome dentro do município.
2. **Códigos → fontes.** Cada fonte do catálogo (§19.2) tem um endereço fixo no código, consultado pelo código geográfico. Nada é buscado à mão nem fica preso à cidade do piloto.
3. **Fontes → retrato da região.** Os números ficam numa tabela do sistema, com a fonte e o período; a empresa guarda só o recorte dela e o retrato com data.
4. **Retrato → estratégia.** O código calcula os indicadores (seção 3); o Estrategista, o Gestor de tráfego e o Criativo trabalham em cima deles, e a LIA responde por regra ("como é a minha região?") com a fonte de cada número.

**Onde fica guardado:** o catálogo das fontes mora na base (§19) e, no código, num registro de fontes (como o Capability Registry: fonte, órgão, endereço, recorte, período, licença e renovação). Uma fonte nova entra primeiro na base, com data e confiança, e depois no registro. Assim, uma empresa em outro estado usa as mesmas fontes, e a troca de endereço de uma fonte muda num lugar só.

## 3. O raio-x da região (o que o código calcula, sem IA)

| Indicador | Como se calcula | Fonte | Para que serve |
| --- | --- | --- | --- |
| **Gente na área de entrega** | Soma da população dos bairros da área (depois, dos setores censitários dentro do raio) | Censo 2022 por bairro | Tamanho do mercado; verba que dá a frequência certa |
| **Densidade** | Pessoas por km² | Censo 2022 | Raio menor onde é denso, maior onde é espalhado |
| **Bolso da região** | Renda mediana do responsável no bairro e renda per capita mediana do município, corrigidas pelo IPCA até hoje | Censo 2022 + IPCA | Oferta de entrada × premium; comparar com o tíquete da loja |
| **Concorrência** | Restaurantes (CNAE 56.11-2) por 10 mil habitantes no município; depois, pontos no raio | Cadastro Central de Empresas; OpenStreetMap | Custo esperado do anúncio e quanto o diferencial precisa aparecer |
| **Preço local** | Inflação de 12 meses de lanche e refeição na região metropolitana × Brasil | IPCA (tabela 7060) | Momento de reajuste ou de combo |
| **Demanda da loja** | Pedidos por hora e dia da semana, tíquete médio, cliente novo × de volta | Regem (já lido) | Horário da verba; meta de tíquete |
| **Referência do setor** | Tíquete médio nacional, horários de pico por categoria | IFB, iFood, Abrasel [S] | Ponto de partida enquanto a loja tem pouco histórico; sempre rotulado |
| **Semana que vem** | Chuva prevista, feriados, datas comerciais, dias de pagamento | CPTEC, BrasilAPI, `commercial_date` | Subir ou segurar verba; criativo do dia |
| **Público na Meta** | Estimativa de pessoas no raio, por faixa de idade | `reachestimate` | Conferir se o recorte tem gente suficiente antes de gastar |

O retrato aparece num cartão "Sua região" (protótipo antes do código) e entra no que a LIA, o Analista e o Estrategista leem. Exemplo do que a pessoa vê (números reais do Censo 2022, Tijuca, Rio de Janeiro): "142,9 mil pessoas em 9,9 km²; renda mediana do responsável R$ 5.500 (Censo 2022); 16.242 restaurantes no município (IBGE, 2024)".

## 4. O manual de jogadas do gestor

O que um gestor de tráfego profissional faz para um negócio local de comida, e como cada jogada usa os dados. As regras de decisão de partida estão na base §7; aqui entra o que é próprio do negócio local.

### 4.1 O funil local

| Etapa | Objetivo na Meta | Público | Criativo | Como medir | Parte da verba (ponto de partida) |
| --- | --- | --- | --- | --- | --- |
| **Reconhecimento** | Alcance (ou visualizações de vídeo), com teto de frequência | Raio da área de entrega, faixa de idade do público da loja | Vídeo curto da cozinha e do produto de verdade (Reels já postado, D-A6-73) | Alcance único, frequência de 1,5 a 3 por semana, custo por mil pessoas; **buscas pela marca no Search Console e vistas e rotas no Perfil do Google, que o Liame já lê** | 15–20% |
| **Seguidores** | Visitas ao perfil do Instagram ou engajamento | Quem viu o vídeo (público da própria Meta, não é lista de cliente) e o raio | Bastidores, novidade, sorteio dentro das regras | Custo por seguidor, visitas ao perfil, seguidor que vira pedido (cupom de boas-vindas no perfil) | 10–15% |
| **Cardápio e conversa** | Tráfego para o cardápio (com o link de rastreio) ou conversas no WhatsApp | Raio + quem interagiu | Prato, preço da oferta de Minha marca, prova (nota no Google) | Custo por visita e por conversa; quantas viram pedido no caixa | 25–35% |
| **Pedido** | Vendas ou conversas (D-A4-31) | Quem visitou ou conversou; raio | Oferta com cupom exclusivo da campanha | **ROAS no caixa** (já existe) e custo por pedido | 30–40% |
| **Recompra** | Não é anúncio: WhatsApp e cupom pelo CRM | Clientes com consentimento (C3c) | "Volte a pedir" | Pedidos de volta | fora da verba de mídia |

As partes da verba são ponto de partida para recalibrar pelos primeiros 30 dias (base §7), não regra fixa. Loja com pouco dinheiro começa só pelas duas últimas etapas pagas e faz o reconhecimento pelo orgânico.

### 4.2 Jogadas pela região

1. **Anéis do raio.** Núcleo (perto, entrega rápida e frete baixo) e expansão (mais longe), com verba e mensagem diferentes; a área sem entrega fica de fora. O tamanho de cada anel sai da densidade e do público estimado, não de um número fixo.
2. **Bairros para atacar e para defender.** Nota por bairro = gente × bolso × pedidos atuais por mil habitantes. Muita gente e poucos pedidos: atacar (reconhecimento e oferta de entrada). Já compra muito: defender (recompra e novidade). Pede os pedidos por bairro do Regem (R3).
3. **Oferta pelo bolso.** Renda mediana do bairro × tíquete da loja: combo de entrada onde o bolso é curto, produto premium onde sobra. A renda escolhe a oferta e a verba, **nunca vai para o texto do anúncio** (§19.3).
4. **Horário.** Verba concentrada de 1 a 2 horas antes do pico da loja e mais peso de sexta a domingo. Até haver histórico, a referência da categoria (§19.2: jantar perto do dobro do almoço; pizza entre 20h e 22h; hambúrguer também no lanche da tarde).
5. **Clima.** Chuva e frio aumentam o pedido em casa: verba na véspera e criativo de "dia de chuva"; calor puxa açaí, sorvete e bebida. Começa como regra simples e se prova pelo caixa da própria loja.
6. **Calendário do bolso.** Datas comerciais (já existe), feriados, quinto dia útil (pagamento de salário) e, em região de renda menor, o calendário de pagamento de benefícios sociais [a conferir na fonte antes do código].
7. **Concorrência.** Muitos restaurantes por habitante: anúncio mais caro e diferencial obrigatório no criativo; a leitura do cardápio do concorrente pelo Pesquisador já existe.
8. **Público antes da verba.** A estimativa da Meta para o raio diz quanto gastar para chegar à frequência certa; se o público for pequeno demais, alargar o raio ou juntar faixas de idade.
9. **O orgânico local junto.** Post no horário em que os seguidores estão online, foto com o bairro, resposta às avaliações (já existe), WhatsApp por bairro pelo RegemCast (já existe).

### 4.3 Testes

- **Criativo:** dois conjuntos iguais com um criativo diferente, uma variável por vez, decidido pelo caixa (base §7.5).
- **Região (incrementalidade):** um anel ou bairro fica sem anúncio por um período e se compara com os outros pelo caixa. É a resposta honesta para "o anúncio trouxe pedido que não viria sozinho?" (a base §1.4 registra um teste em que só 17% das conversões que a plataforma se atribuía eram de verdade).
- **O que funciona em cada região** fica registrado por empresa. Comparar entre empresas só agregado e sem identificar ninguém, e só depois de decisão própria.

## 5. Entregas propostas

Cada entrega nasce desligada, passa primeiro no piloto, tem protótipo aprovado antes de tela nova e atualiza o jurídico no mesmo PR quando mudar o que ele diz.

| Entrega | O que faz | Depende de | Tamanho |
| --- | --- | --- | --- |
| **R1 · A loja no mapa** | Endereço, CEP, código do município, bairro, coordenada e raio de entrega na loja (fecha a lacuna do `data-model.md`); lidos do Perfil do Google quando houver, ou digitados e conferidos pelo ViaCEP; fora do que vai ao modelo (D-A3-4) | D-RG-2 | M |
| **R2 · Raio-x da região** | Registro das fontes no código, rotina que lê o catálogo pelos códigos, tabela do sistema com os números, retrato por empresa, cartão "Sua região" e respostas da LIA por regra | R1, D-RG-1 | M |
| **R3 · A demanda da loja** | Tíquete médio e pedidos por hora e dia a partir do que o Regem já manda; depois, pedidos por bairro, agregados, com mínimo de pedidos por bairro para não identificar ninguém | Nada (1ª parte); mudança na porta do Regem e no Contrato de Dados (2ª parte, D-RG-8) | P + M |
| **R4 · Mídia por região e hora** | Leitura das quebras por região e por hora (Meta e Google) e dos números da conta do Instagram e da Página (seguidores, visitas ao perfil, público por cidade) | Base atualizada antes (as rotas e permissões conferidas na documentação) | M |
| **R5 · Plano de mídia do Estrategista** | O plano passa a trazer etapas do funil, anéis, verba por anel, horários e criativo por público, com os números do raio-x calculados pelo código; ainda não executa | R2, R3 | M |
| **R6 · Campanha nova com raio** | A X5 ampliada: objetivos de reconhecimento e seguidores além de pedidos e conversas, raio da R1, estimativa de público antes, nasce pausada e com aprovação | X5, D-RG-3, D-RG-4 | G |
| **R7 · Ritmo inteligente** | Propostas de verba por horário, clima e calendário, aprovadas em lote para a semana | R6, D-RG-5 | M |
| **R8 · Testes e concorrentes no raio** | Teste de criativo e de região; concorrentes no raio por um servidor próprio de dados do OpenStreetMap | R6, D-RG-7 | M |
| **R9 · Google local** | A Y9 com raio e as buscas "perto de mim" e por bairro; volume de busca por cidade depois do nível Basic | Y9, nível Basic (D-RG-10) | M |

**Ordem recomendada:** R1 → R2 → R3 (dado, sem gastar nada) → R4 e R5 → R6 junto com a X5 → R7, R8 e R9.

**Quem faz o quê na equipe:** o raio-x é trabalho por regra (como os Relatórios), mostrado junto do Pesquisador; o Analista explica os números; o Estrategista monta o plano de mídia; o Gestor de tráfego ganha a estrutura de campanha e o ritmo; o Criativo escreve por público e por anel; o Social media usa o horário dos seguidores; o CRM usa o bairro no WhatsApp; o Compliance ganha a regra "nenhum atributo pessoal no texto".

## 6. Decisões do dono

| Decisão | Pergunta | Recomendação |
| --- | --- | --- |
| **D-RG-1** | O catálogo da base §19 vira o padrão de pesquisa da região, guardado como tabela do sistema (padrão PTAX)? | Sim |
| **D-RG-2** | A localização da loja (endereço, CEP, coordenada, raio) fica guardada na loja como dado da empresa, sem ir ao modelo? | Sim. O modelo recebe só o nome do bairro e do município e os números |
| **D-RG-3** | A campanha nova ganha objetivos de reconhecimento e de seguidores, além de pedidos e conversas (D-A4-31)? | Sim, medidos por alcance e frequência, buscas pela marca, ações no Perfil do Google e seguidores; com teto (por exemplo, até 25% da verba do mês fora de pedidos e conversas) |
| **D-RG-4** | O mínimo de 100 mil pessoas da base §7.4 (prior de outro tipo de negócio) vale para loja de bairro? | Trocar pelo público estimado da Meta para o raio, com uma regra de frequência para negócio local |
| **D-RG-5** | Como fazer a verba seguir o horário? (a) verba de período com programação na Meta, hoje recusada pelo Liame; (b) plano de horários aprovado uma vez por semana; (c) só recomendar | (b) |
| **D-RG-6** | Clima: começar pela previsão diária gratuita (CPTEC) ou pagar a previsão por hora (Open-Meteo)? | CPTEC; pagar só se o horário provar valor no caixa |
| **D-RG-7** | Concorrentes no raio: servidor próprio de dados do OpenStreetMap, ao lado do OSRM da DMS? | Agora, a contagem por município do IBGE; o servidor próprio na R8 |
| **D-RG-8** | Pedir ao Regem os pedidos por bairro, agregados (mínimo de pedidos por bairro), com a mudança no Contrato de Dados? | Sim, pela trilha C |
| **D-RG-9** | Aprovar a ordem da seção 5? | Sim |
| **D-RG-10** | Pedir o nível Basic do Google Ads agora, para abrir o volume de busca por cidade? | Sim; o pedido é do dono e leva tempo de análise |

**Decisões do protótipo P40** (`mockups/prototipo-regiao.html`: a loja no mapa e Sua região, 18 cenários; **aprovadas pelo dono em 11/11/2026, todas como recomendadas**):

| Decisão | O que fica decidido |
| --- | --- |
| **D-RG-11** | Sua região mora numa página nova, **Minha marca › Região**, aberta pela parte Região do dossiê: as lojas no mapa em cima e Sua região embaixo, uma loja por vez. A parte Região de Minha marca (o texto e a retirada no balcão) não muda e ganha a linha "N lojas no mapa" e o botão "Abrir a região". No Resumo e em Atenção, nada por enquanto; um cartão no Resumo só quando o plano de mídia (R5) usar estes números para propor algo |
| **D-RG-12** | Pôr a loja no mapa, mudar o raio ou as áreas **salva na hora, sem o código do app** e sem pedido em Aprovações: é dado da empresa, não gasta nem publica. Fica na auditoria com quem salvou, o antes e o depois. O código continua onde o raio vira gasto (a campanha com raio da R6 nasce pausada e pede aprovação, D-A7-11) |
| **D-RG-13** | Mudam o Dono e o Administrador (a permissão de mudar Minha marca, `dossie.editar`); veem a página inteira o Gestor, o Aprovador e o Somente leitura (`dossie.ver`); o Só relatórios não vê. Nenhuma permissão nova |
| **D-RG-14** | O ponto vem do endereço (o OpenStreetMap acha a rua e o número) ou, quando não acha, do **centro do bairro**, e a tela diz qual dos dois em palavras. Sua região funciona com os dois; a campanha com raio (R6) só nasce com o ponto pelo endereço |
| **D-RG-15** | Um raio por loja, **de 1 a 15 km, em passos de 0,5 km, começando em 3 km**. A prévia desenha o núcleo até 2 km e a expansão até o raio (desenho em escala, sem mapa de fundo); na R5, os anéis passam a sair da densidade e do público estimado |
| **D-RG-16** | As áreas atendidas do Perfil da Empresa no Google (até 20) entram como as áreas de entrega da loja; tirar ou acrescentar no Liame **não muda o Google** (aqui o Liame só lê o Perfil). **Cada perfil vale para uma loja**: com mais de um, a gaveta mostra a lista, e o perfil que já é de outra loja aparece com o nome dela |
| **D-RG-17** | A marca sem loja (sem o Regem): **salvar o endereço cria a loja**, com o nome do Perfil do Google ou, sem perfil, "Loja" e o bairro (o nome muda na gaveta). Quando o Regem for conectado depois, ele se liga a essa loja pelo mesmo nome, como já acontece; a gaveta avisa ao mudar o nome. Com uma loja criada assim, aparece "Pôr outra loja no mapa" |
| **D-RG-18** | A LIA responde "como é a minha região?" **por regra, sem IA**, com os números, a fonte e o período de cada um e no máximo duas ações (Ver Sua região, Ver as fontes), e diz o que ainda não dá para saber. Funcionário de IA que usa a região recebe só o bairro, o município e os números calculados, nunca o endereço (D-RG-2) |
| **D-RG-19** | A página Região tem **Lite e Pro**: no Lite, os números principais com a fonte curta e o resto em "Ver detalhes"; no Pro, também os códigos do IBGE, a coordenada e a precisão, a renda média ao lado da mediana, os números do município e as fontes com o endereço e a renovação. Nada some no Lite |
| **D-RG-20** | A renda do Censo aparece **já, com "valor de 2022, sem correção"** escrito ao lado; depois de conferida a tabela do IPCA na fonte (base §19.3), passa a "corrigido pelo IPCA até <mês>" |

## 7. Cuidados

- **Pessoa nenhuma no dado:** tudo da região é agregado público; o bairro dos pedidos só agregado e com mínimo de pedidos; públicos de lista de clientes continuam esperando o consentimento com prova (C3c, D-A5-18).
- **Texto de anúncio:** nunca afirma renda, bairro de quem lê ou condição pessoal (políticas da Meta); vale também o §6.2 (comida e bebida) e a D-A4-34 (bebida alcoólica).
- **Limites das fontes abertas** (§19.3): Nominatim com cache; Overpass só em servidor próprio ou pago; Open-Meteo só pago; BrasilAPI sem garantia de serviço (o CEP sai do ViaCEP).
- **Idade do dado:** Censo de 2022, em valor nominal; corrigir pelo IPCA e dizer o ano em todo número.
- **Medida fora do Regem:** em loja sem o Regem, a única medida de pedido é o cupom exclusivo (D-A2.5-12/13); as jogadas de reconhecimento e seguidores continuam medidas pelo alcance, pelo Perfil do Google e pelo Search Console.
- **Autonomia:** criar campanha e mudar público continuam pedindo aprovação (D-A7-11); nada aqui antecipa o modo automático.
- **Conferir antes do código:** os objetivos e destinos da Meta citados na seção 4.1 (alcance, visitas ao perfil do Instagram, engajamento), o uso de público de quem viu um vídeo diante da D-A5-18, os campos de endereço e área do Perfil do Google e as rotas de números da conta do Instagram entram na base, pela documentação oficial, antes da R4 e da R6.

## 8. Andamento

| Entrega | Situação | Onde |
| --- | --- | --- |
| **R1 · A loja no mapa** | **Feita (11/11/2026), função `regiao` desligada; protótipo P40 aprovado (D-RG-11 a D-RG-20).** **Parte 2:** a tela Minha marca › Região (`/marca/regiao`, com Lite e Pro) com a gaveta (o Perfil do Google ou o CEP, o ponto achado ao salvar com o número, o raio em anéis, as áreas), a linha "N lojas no mapa" e "Abrir a região" na parte Região de Minha marca, a loja criada na marca sem Regem (`POST /v1/region/stores`, auditoria `loja.criar`; D-RG-17), o perfil do Google ligado a uma loja (D-RG-16, pela `connected_account.unit_id`), o ponto pelo endereço só com a rua e o número (D-RG-14) e o complemento (migration 0135). **Falta para ligar a função:** o texto publicado da Política (a próxima versão dos documentos). Parte 1: migration 0132 (as colunas do endereço, da coordenada, do raio e das áreas em `unit`, com as regras que juntam colunas; a função `regiao`); as rotas `GET /v1/region/stores`, `POST /v1/region/address-lookup` (ViaCEP + OpenStreetMap, sem gravar), `POST /v1/region/google-profile-address` (o endereço e as áreas do Perfil do Google, lidos agora, sem gravar) e `PUT /v1/units/:id/location` (salvar, com a auditoria `loja.localizacao`). O endereço da loja nunca vai para o modelo (D-A3-4, D-RG-2) | `apps/server/src/regiao/`, `packages/contracts/src/regiao.ts`, `apps/web/src/components/regiao/`, migrations 0132 e 0135; protótipo `mockups/prototipo-regiao.html` |
| **R2 · Raio-x da região** | **Parte 1, o servidor (11/11/2026; migration 0137; a função `regiao` desligada):** as três tabelas do sistema (`region_district` com os bairros do Censo 2022 e a renda do responsável; `region_fact` com os números por município; `region_source_read` com a última leitura de cada fonte), a rotina `regiao-fontes` do worker (os bairros do Censo uma vez; as tabelas 4714, 6579, 10295 e 9528 da API de agregados do IBGE para cada município com loja no mapa, cada uma no prazo dela; falha tenta de novo em 1 hora) e a rota `GET /v1/region/overview` (o bairro da loja, a posição da renda entre os bairros do município, a gente das áreas de entrega, o município, a fonte e o período de cada número e a situação de cada fonte). **Parte 2, a tela (11/11/2026; sem migration):** o cartão Sua região na página Minha marca › Região, com Gente, Bolso (a renda do bairro com a régua dos bairros do município, valor de 2022, sem correção) e Concorrência; o "lendo" que atualiza sozinho; a faixa da fonte que falhou com a próxima tentativa; uma loja por vez; o Pro com os códigos das tabelas; "Ainda não" com o que depende de outra entrega; e a gaveta "Ver as fontes" (P40, cenários 7, 9 a 12). **Parte 3, as fontes mais novas que o Censo (11/11/2026; sem migration; pedido do dono, que apontou o Censo de 2022 como desatualizado; base §19.5):** a renda do bairro passa a aparecer corrigida pelo IPCA (D-RG-20 resolvida: o número-índice foi conferido); a renda recente da PNAD Contínua (UF e RM, 2025) e a renda do trabalho da capital (média de 4 trimestres); a estimativa de população de 2026 do município, sem comparar com o Censo (a série mudou de base); o bloco novo "Pulso do consumo" (o Pix do município, todo mês, contra o mesmo mês do ano anterior) e "Preço de comer fora" (o IPCA de 12 meses na RM ou no município, com o Brasil ao lado). O bairro só tem o Censo (nenhuma pesquisa contínua desce até ele). **A seguir:** a parte 4, os restaurantes ativos por bairro e por CEP pelo CNPJ da Receita (mensal, ~5,4 GB, guardando só contagens); depois, a semana que vem (tempo, feriados, datas), a referência do setor e a LIA por regra (D-RG-18; cenário 17) | `apps/server/src/regiao/` (`censo.ts`, `ibge.ts`, `raio-x.ts`, `zip.ts`), `apps/server/src/worker/regiao-fontes.service.ts`, `apps/web/src/components/regiao/sua-regiao.tsx` e `gaveta-fontes.tsx`, migration 0137 |
| R3 a R9 | Na ordem da seção 5 | — |

**Achados da R1 (conferidos na documentação oficial em 11/11/2026, base §19.1):** o Perfil da Empresa no Google dá o endereço (`storefrontAddress`) e até 20 áreas atendidas (`serviceArea.places.placeInfos`), mas a coordenada (`latlng`) só volta quando foi digitada ao criar o perfil; por isso a coordenada sai do endereço, pelo OpenStreetMap, do endereço para o bairro e a cidade, e só vale se cair no município do CEP.
