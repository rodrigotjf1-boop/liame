# Liame — Plano da fase A4 · Escrita na Meta

> **Aprovado pelo dono em 03/10/2026** ("plano aprovado"), com as decisões D-A4-1 a D-A4-11 como recomendadas (seção 4). Seguem com ele os itens da seção 9: `ads_management` na configuração do login da Meta, o teto por ação e o envelope do mês do piloto (antes da X2), a conta no fornecedor de imagem (X7), os protótipos P9 a P11 e ligar a flag `meta_write`. A A4 é quando "a agência executa com trilho" (roadmap §2): o Gestor de tráfego, que na A3 só registra em sombra e sugere, passa a **pedir a mudança na Meta para uma pessoa aprovar**, e o Liame a faz: mexe na verba, pausa e cria campanha (sempre pausada), confere antes com a validação da própria Meta e confere depois. O Criativo entra com texto e imagem, conferidos pelo Compliance, para aprovar. **Nada é executado sem aprovação humana nesta fase** (`LIMITED_AUTO` e `AUTO` ficam para a A7), **mudança feita por uma pessoa na Meta nunca é sobrescrita**, e o Google continua só lendo (escrita no Google é a A5).

## 1. De onde partimos (código e documentos lidos em 03/10/2026)

| Onde | Já existe | Falta |
| --- | --- | --- |
| **Trilho de ação** (A1 + A2.5) | Action Service com política (`plataforma@2`: no máximo 3 mudanças de verba por hora na Meta, `campanha.apagar` sempre escala, `cupom.criar` sempre com aprovação), reserva no envelope do mês (`reserva → liberação → execução`), aprovação com o código do app amarrada ao hash do pedido, execução pelo worker, compensação por ferramenta e auditoria; a interface de conector (`read` e `apply` com concorrência otimista e `validateOnly`); um conector de verdade (Regem, cupom) e o de teste (sandbox) | O conector de escrita da Meta; as ferramentas de anúncio com o provedor `meta_ads` (hoje `orcamento_ajustar` e `anuncio_pausar` só aceitam o sandbox); o gasto real conciliado com o executado (`reported → actual_spend`) |
| **Autonomia** (A3, I5 e I13) | Sombra por regra com arrependimento e prontidão; promoção de Sombra para Sugerir pela política da marca, proposta pelo sistema e aprovada por uma pessoa; a recomendação em Sugerir aparece na Atenção | O modo **Aprovação**: a recomendação vira pedido no Action Service; os portões para propor Aprovação |
| **Leitura da Meta** (A2) | Campanhas, conjuntos, anúncios e métricas do dia, com frescor; Vigia de integrações; token de usuário do sistema por empresa no cofre | Ler o estado logo antes de escrever (verba e situação do objeto), com a versão para não sobrescrever |
| **IA** (A3) | AI Gateway com custo, teto e evals; os funcionários de texto | O funcionário **Criativo**; a finalidade **imagem** no catálogo (ADR-016), com o fornecedor escolhido por eval |
| **Telas** | Aprovações (ações e cupom; planos e autonomia no servidor), Atenção, Resultados, Sua equipe (servidor) | A ação de anúncio com prévia em Aprovações; Criativos |
| **Acesso Meta** | App `Liame` (tipo Empresa, portfólio verificado); App Review de `ads_read` enviado em 02/10/2026 (em análise) | `ads_management` na configuração do login e no App Review (acesso avançado) para contas de terceiros. **O piloto não espera:** o dono tem papel no app, e o acesso padrão vale para quem tem papel (base §2.1) |
| **Jurídico** | Termos 2.1 ("só executam quando você aprova"), 2.3 (parada), 2.6 (os funcionários entram aos poucos); Política 7 (IA) | O que o Liame faz na Meta em nome da empresa; o fornecedor de imagem; a marca "feito com IA" nas peças |

**Piloto (Mister Burgers):** 5 campanhas ativas na Meta. A sombra começou na A3 (flag `sombra`); a prontidão para Aprovação vem da amostra dela.

## 2. O que muda para quem usa

1. **A sugestão do Gestor de tráfego vira um pedido:** "reduzir a verba da Delivery noite de R$ 30 para R$ 27", com o motivo e os números; a pessoa aprova com o código do app e o Liame faz na Meta, confere e avisa.
2. **Pausar e retomar** campanha, conjunto e anúncio pelo Liame, com aprovação.
3. **Campanha nova nasce pausada:** o Estrategista ou a pessoa monta (objetivo, público, verba, criativo), a Meta valida antes, o Liame cria pausada; ativar é outra aprovação.
4. **Peças do Criativo:** texto e imagem feitos a partir do que já vendeu e do dossiê da marca, conferidos pelo Compliance, com a marca "feito com IA", para aprovar antes de ir para a Meta.
5. **O dinheiro do mês:** quanto o Liame já reservou, executou e quanto a Meta de fato gastou, conferidos todo dia.
6. **Desfazer:** toda ação tem a volta, que só acontece se ninguém mexeu no objeto depois.
7. **Sua equipe:** o Gestor de tráfego passa de Sugerir para Aprovação por conta e por ação, com a prontidão à vista e uma pessoa aprovando a promoção.

## 3. Entregas no Liame

Cada entrega é um PR com CI verde. **Migrations em negrito**: testadas no local e no CI, aplicadas na nuvem antes do merge. Letra **X** (execução). Antes do código: os protótipos da seção 5 e a reconferência da seção 8.

| # | Entrega | O que fica pronto | Critérios | Migrations |
| --- | --- | --- | --- | --- |
| **X1** | **Conector de escrita da Meta** | Conector `meta_ads` na interface que já existe: lê o estado do objeto (situação e verba diária, com a versão tirada do próprio estado) e aplica **primeiro com `validate_only`** e só então de verdade; recusa da Meta na validação vira "recusado" com o motivo, sem tentar de novo; os limites da conta (cabeçalhos de uso, erros 17, 613 e 80000–80014) adiam a execução em vez de insistir; flag `meta_write`, desligada; token do cofre por empresa; auditoria e trace | A4-1, A4-2, A4-3 | **0044** `escrita_meta` (capacidades de escrita no registro e a espera da execução) |
| **X2** | **Ferramentas de anúncio** | `orcamento_ajustar` (campanha com orçamento de campanha, ou conjunto) e `anuncio_pausar` passam a aceitar `meta_ads`; entram `conjunto_pausar`, `campanha_pausar` e as de **retomar** (que reativam o que estava ativo); cada uma com risco, permissão, política e compensação (verba anterior se ninguém mexeu; reativar só o que o Liame pausou). Limites da política da distribuição: verba ±10% por ação (era ±20%; o dono baixou em 04/10/2026) e o teto por ação; o `spend_cap` da conta nunca é tocado. **Achado na leitura do código (03/10/2026):** a regra de limite da política da distribuição (`plataforma@2`) está escrita com o provedor `meta`, e as contas usam `meta_ads`: do jeito que está, ela nunca casaria com uma ação da Meta; a correção (versão 3 da política, com teste) entra aqui, antes da primeira escrita | A4-2, A4-4, A4-5 | **0045** `volta_da_acao` (o pedido que desfaz outro) |
| **X3** | **Modo Aprovação** | Na ação em Aprovação, a recomendação da sombra cria o pedido no Action Service (o motivo, os números do retrato e o estado lido) em vez de só aparecer na Atenção; a sombra continua medindo; os portões para propor Aprovação (os cinco da A3 mais execuções sem erro e taxa de aprovação) e a promoção, proposta pelo sistema e aprovada por uma pessoa, como a de Sugerir | A4-6, A4-7 | **0047** `pedido_da_recomendacao` (o pedido ligado à recomendação de que nasceu); **0048** `pedido_do_funcionario` (quem pediu, a tentativa de pedir e a flag do modo); **0049** `proposta_de_aprovacao` (o segundo passo da proposta e a espera depois da recusa) |
| **X4** | **Dinheiro do mês completo** | O gasto real lido da Meta todo dia conciliado com o que o Liame executou (`execução → informado → gasto real`), por ação e por conta; diferença acima do limite vira aviso; envelope do mês na tela | A4-8 | **nova:** gasto conciliado |
| **X5** | **Campanha nova, pausada** | Montagem da campanha (objetivo, conjunto com público e verba, anúncio com o criativo aprovado e o rastreio do Liame nos parâmetros de URL); `validate_only` antes; criada **pausada**; ativar é ação à parte, com aprovação e código; apagar continua sempre escalando | A4-2, A4-9 | — |
| **X6** | **Criativo: texto** | Funcionário Criativo (definição no registro): títulos e textos a partir do que já vendeu (Resultados), do dossiê da marca e do que a marca não diz; Compliance e regras da Meta para texto; eval `criativo_texto` (número, promessa, política, marca) como portão | A4-10, A4-11 | — |
| **X7** | **Criativo: imagem** | A finalidade imagem no catálogo, com **um fornecedor escolhido por eval** (qualidade, texto na arte, custo, contrato de dados); a peça guardada no Liame, com C2PA quando o fornecedor der; conferência do Compliance (texto na arte, promessa, pessoa real, logo de terceiro); a marca "feito com IA" onde a Meta pedir; envio para a Meta só depois da aprovação | A4-10, A4-11, A4-12 | **nova:** peças geradas |
| **X8** | **Telas** | Pelos protótipos da seção 5: o pedido de anúncio em Aprovações (antes × depois, motivo, números, validação da Meta), a execução e a volta; Criativos (gerar, conferir, aprovar); Sua equipe com o modo Aprovação | A4-13 | — |

> **Migrations:** o número de cada uma sai da sequência quando a entrega começar (as da A3 passaram da 0040, que este plano citava). Sempre a seguinte à última de `packages/database/migrations` na `origin/main` e nos PRs abertos.

Ordem: X1 → X2 → X4 (o dinheiro antes de mexer mais) → X3 → X6 → X7 → X5 → X8 (as telas entram com cada parte, pelo protótipo aprovado).

**Andamento:** X1 entregue em 04/10/2026, com a reconferência da seção 8 para a escrita de situação e verba (base §2.1): o conector `meta_ads` (lê o estado na Meta, valida com `validate_only`, escreve, confere), a espera da execução quando a Meta manda esperar (`next_attempt_at` no pedido) e a migration **0044**. Detalhe em `andamento.md`. **X2 entregue em 04/10/2026:** as ferramentas de anúncio na Meta (verba diária, pausar e retomar campanha, conjunto e anúncio), a política da distribuição na versão 3 (limite de frequência por objeto com o provedor certo, ±10% por pedido, o pedido de uma pessoa esperando aprovação), os limites da empresa fechados por padrão, a leitura na hora do pedido com o motivo quando a Meta falha, e a volta (`POST /v1/actions/{id}/undo`), com a migration **0045**. Com a flag `meta_write` desligada para todos, nada escreve na Meta. As decisões tomadas na entrega estão na seção 4 (D-A4-12 a D-A4-17), aprovadas pelo dono em 04/10/2026. **Login da Meta para a escrita (04/10/2026):** a configuração de escrita é outra (`META_LOGIN_CONFIG_ID_ESCRITA`), escolhida pela flag `meta_write` da empresa (D-A4-18, aprovada em 04/10/2026); sem migration. **Protótipo P9 (04/10/2026):** `mockups/prototipo-anuncios.html`, pronto para a aprovação do dono, com as decisões propostas D-A4-19 a D-A4-24 (seção 4). **Protótipo P11 (04/10/2026):** `mockups/prototipo-equipe-aprovacao.html`, também pronto, com as decisões propostas D-A4-25 a D-A4-27. **X3, parte 1 (04/10/2026):** o pedido que nasce de uma recomendação, com a migration **0047**: `recommendation_id` no pedido (conferido com a recomendação: em aberto, mesma conta, mesma campanha, mesma direção), a recomendação na resposta do pedido (o porquê, para Aprovações) e, na Atenção, o corpo do pedido de cada sugestão para quem pode pedir. Sem tela e sem mudar o texto dos avisos. **X3, parte 2a (04/10/2026):** o pedido feito pelo Gestor de tráfego, com a migration **0048** e a flag `modo_aprovacao` (desligada): na rodada da manhã, a recomendação nova de uma ação em Aprovação vira um pedido dele, pelo mesmo trilho, em nome da pessoa que publicou a regra do modo; o pedido espera a aprovação com o código do app; o que não deu para pedir fica na recomendação, com o motivo, e ele não tenta de novo. **X3, parte 2b (04/10/2026):** os portões da Aprovação (os cinco da sombra e, nos 10 pedidos decididos mais recentes nascidos de recomendação, 8 aprovados e nenhum com erro), a proposta de Sugerir para Aprovação (o sistema propõe, uma pessoa aprova) e a volta de um passo, com a migration **0049**; tudo atrás da flag `modo_aprovacao`. **O servidor da X3 está completo** (critérios A4-6 e A4-7 com teste); a tela espera o protótipo P11, e os números dos portões seguem como proposta (D-A4-25) até a aprovação do dono. **Protótipo P10 (05/10/2026):** `mockups/prototipo-criativos.html`, pronto para a aprovação do dono, com as decisões propostas D-A4-28 a D-A4-33; a pesquisa que a seção 8 pedia antes dele entrou na base de conhecimento (§2.1, §6, §7.3, §16.1 e §17.4).

## 4. Decisões (aprovadas pelo dono em 03/10/2026, como recomendadas)

| # | Decisão | Recomendação | Por quê |
| --- | --- | --- | --- |
| D-A4-1 | **O que vem primeiro** | Verba e pausa (o que a sombra já mede e o que se desfaz); campanha nova e criativo depois | Começar pelo reversível, com prontidão medida |
| D-A4-2 | **Validação da Meta antes de tudo** | Toda escrita passa antes por `validate_only`; recusa da validação não aplica e mostra o motivo | A Meta diz o que vai recusar sem mudar nada |
| D-A4-3 | **Nada nasce ativo** | Campanha, conjunto e anúncio criados pelo Liame nascem **pausados**; ativar é ação R2 com aprovação e código | O mesmo que o conector oficial da Meta faz; gastar exige um "sim" explícito |
| D-A4-4 | **Modos na A4** | Sombra → Sugerir → **Aprovação**; nada além disso | `LIMITED_AUTO` e `AUTO` dependem do envelope com teto (A7) |
| D-A4-5 | **Mudança humana vence** | O conector lê antes de aplicar e compara com o estado do pedido; se mudou, não aplica (e a volta também não sobrescreve) | ADR-007, compensação; quem está na Meta manda |
| D-A4-6 | **Limites por ação** | Verba: no máximo **±10% por ação** (a recomendação era ±20%; **o dono baixou para 10% em 04/10/2026**, e o passo da recomendação do Gestor de tráfego acompanha) e o teto por ação da política; no máximo 3 mudanças por hora por conjunto (a Meta permite 4); nunca mexer no `spend_cap` da conta | Base §2.1; passo pequeno é mais fácil de medir e desfazer |
| D-A4-7 | **Aprovação de anúncio** | Sempre com o código do app, como o cupom e o plano | Dinheiro e publicação: a mesma régua |
| D-A4-8 | **Acesso à Meta** | Piloto com o dono como testador (acesso padrão, pelo papel dele no app); empresas de fora só com `ads_management` aprovado no App Review | A permissão de escrita para contas de terceiros exige acesso avançado (base §2.1) |
| D-A4-9 | **Imagem** | Um fornecedor na largada, escolhido por eval entre os que não treinam com os dados enviados; sem rosto de pessoa real, sem logo de terceiro, sem texto que a marca não diz; C2PA quando houver; "feito com IA" na tela e onde a Meta pedir | ADR-016; catálogo curado; menos contrato e superfície de dados |
| D-A4-10 | **Onde a peça fica** | No armazenamento do Liame (o mesmo cofre de mídia), da empresa; vai para a Meta só depois de aprovada | A empresa vê e decide antes de publicar |
| D-A4-11 | **Google** | Continua só leitura na A4; a escrita entra na A5 (roadmap) | Um canal por vez, com o trilho provado |

**Decisões tomadas na X2 e no login de escrita (04/10/2026), pela recomendação, e aprovadas pelo dono no mesmo dia ("tudo aprovado e seguir o recomendado"):**

| # | Decisão | O que foi feito | Por quê |
| --- | --- | --- | --- |
| D-A4-12 | **Quem pede** | O que uma pessoa pede na Meta espera aprovação com o código do app (regra da distribuição, `actor: human`). O modo do funcionário de IA em cada conta (Sombra, Sugerir e, na X3, Aprovação) é outra regra (`actor: agent`) | As duas coisas usavam a mesma regra: liberar o pedido da pessoa tirava o Gestor de tráfego da Sombra, e voltar o funcionário para Sombra travaria o pedido da pessoa |
| D-A4-13 | **Limites da empresa, fechados por padrão** | Na Meta, aumentar verba só com o teto por ação definido pela empresa (ou pela marca); aumentar e retomar só com o envelope do mês definido. Sem eles, o Liame nega o pedido | "Sem limite definido" não pode querer dizer "sem limite" |
| D-A4-14 | **A volta** | É um pedido novo, com a mesma aprovação. Fica fora do teto e dos 10% (devolve o valor que já estava lá), mas dentro do envelope do mês e do limite de frequência. Só vale se ninguém mexeu no objeto depois; uma por vez; não desfaz o que o Liame não escreveu | Desfazer não pode ser um atalho sem aprovação, nem passar por cima do que uma pessoa mudou na Meta |
| D-A4-15 | **Limite de frequência por objeto** | No máximo 3 mudanças de verba por hora na mesma campanha ou no mesmo conjunto, somando aumentar e reduzir | É como a Meta conta (4 por hora por conjunto); contar na conta inteira travava quem cuida de vários conjuntos |
| D-A4-16 | **O teto não barra a redução** | O teto por ação vale para o que faz o gasto subir. Reduzir uma verba que já está acima do teto é permitido | Baixar o gasto é a direção segura; sem isso, a recomendação mais comum da sombra (reduzir a verba) seria negada em campanha grande |
| D-A4-17 | **Retomar reserva um dia de verba** | Retomar é risco R2 e conta como gasto novo: reserva no envelope um dia da verba que mora no objeto; anúncio e objeto sem verba própria não reservam | Aproximação declarada, como a do aumento (um dia da diferença); o gasto real conciliado vem na X4 |
| D-A4-18 | **Login da Meta para a escrita** | Uma **segunda configuração** do Facebook Login for Business, com a permissão de gerenciar anúncios (`META_LOGIN_CONFIG_ID_ESCRITA`); a de leitura não muda. O Liame manda autorizar pela de escrita só a empresa com a flag `meta_write` ligada, e a autorização nova assume as contas que a empresa já tinha | A configuração de leitura está em análise na Meta (`ads_read`), e a página oficial não diz o que a edição de uma configuração faz com os tokens já emitidos (base §2.1); pedir a escrita só a quem vai usar é a permissão mínima |

**Decisões propostas com o protótipo P9 (04/10/2026), aguardam o dono:**

| # | Decisão | Proposta | Por quê |
| --- | --- | --- | --- |
| D-A4-19 | **O teto do mês conta o gasto inteiro** | O "envelope do mês" passa a ser o teto de **tudo o que as contas conectadas gastam em anúncios no mês** (Meta e Google), e não a soma do que o Liame reservou. O pedido que faz o gasto subir só passa se couber: gasto até ontem + ritmo dos últimos 7 dias × dias que faltam + aumentos e retomadas pedidos ou feitos hoje + o que o pedido acrescenta até o fim do mês ≤ teto. Reduzir e pausar passam sempre. Com o mês acima do teto, o Liame avisa e nega aumento e retomada; não pausa nada sozinho. Na tela, o nome é **Verba do mês** (o cartão "Orçamento de setembro" do protótipo geral aprovado), e o "teto por ação" aparece como **teto por campanha** | É a conta que a pessoa faz ("quanto posso gastar em anúncio neste mês") e é o cartão que o protótipo geral já mostrava. Hoje o envelope soma só um dia da diferença de cada aumento: ele não diz se o mês vai fechar dentro do que a empresa quer gastar |
| D-A4-20 | **Por onde o pedido nasce** | Dois caminhos, a mesma gaveta: o botão **"Pedir mudança"** em cada campanha da Meta, em Resultados (Lite e Pro), e a **recomendação do Gestor de tráfego** na Atenção ("Pedir esta mudança"; no modo Aprovação, o pedido já chega feito). A gaveta lê a campanha na Meta na hora, deixa escolher onde (a campanha, um conjunto ou um anúncio) e o quê (a verba diária, pausar ou retomar), mostra o efeito e os limites e só então cria o pedido. Um item novo no menu, **Verba do mês**, depois de Resultados | O pedido nasce onde a pessoa vê o número que a fez decidir; a A4 não tem uma tela de campanhas |
| D-A4-21 | **O risco mostrado segue a direção** | Reduzir a verba e pausar: risco baixo. Aumentar a verba e retomar: risco médio. Hoje `orcamento_ajustar` tem risco R3 fixo, e a tela mostraria "risco alto" numa redução de 10% | O risco que a pessoa lê diz o que pode dar errado, que é gastar mais. A aprovação com o código do app não muda: é regra da distribuição para tudo o que uma pessoa pede na Meta |
| D-A4-22 | **Quem define os limites** | Dono e Administrador definem e mudam o teto do mês e o teto por campanha, na tela Verba do mês; os outros papéis só veem. A mudança vale na hora, para os pedidos seguintes, e fica na auditoria | São os limites de dinheiro da empresa; hoje só se definem pela API |
| D-A4-23 | **A campanha nova fica com o P10** | O estado "campanha nova pausada com a prévia", que a seção 5 punha no P9, passa para o protótipo de Criativos (P10) | A prévia de uma campanha nova é a peça (o texto e a imagem), que nasce em Criativos; a entrega dela (X5) vem depois do Criativo (X6 e X7) |
| D-A4-24 | **O gasto é conferido pela semana** | O aviso "gastou mais do que a verba permite" compara o gasto de 7 dias com 7 vezes a verba diária (na proporção dos dias de cada verba, quando ela mudou no meio), e não um dia com a verba do dia | A verba diária da Meta é uma média: num dia ela gasta mais e em outro, menos. A página oficial da API fala em até 25% a mais num dia; quem anuncia cita a Central de Ajuda com até 75% (base §2.1). Comparar a semana não depende de qual dos dois números vale |

**Decisões propostas com o protótipo P11 (04/10/2026), aguardam o dono:**

| # | Decisão | Proposta | Por quê |
| --- | --- | --- | --- |
| D-A4-25 | **Os portões da Aprovação** | Para o sistema propor a passagem de Sugerir para Aprovação numa conta e numa ação: os cinco portões da sombra continuam passando e, nos **10 pedidos mais recentes** que nasceram de uma recomendação dele (em Sugerir, quem pede é a pessoa, pelo "Pedir esta mudança"), **8 ou mais foram aprovados** e **nenhum dos aprovados terminou em erro**. Recusada a proposta, ou depois de uma volta, o sistema só propõe de novo com mais 10 pedidos decididos | O plano pedia "execuções sem erro e taxa de aprovação", sem números. Dez pedidos é o tamanho do piloto (A4-14); 8 em 10 é a régua de concordância da sombra (80%); olhar só os mais recentes deixa um erro antigo sair da conta |
| D-A4-26 | **O que a Aprovação faz** | Na rodada da manhã, a recomendação de uma ação em Aprovação vira um pedido no nome do Gestor de tráfego, com o motivo, os números e o estado lido na Meta. O pedido espera a aprovação de uma pessoa com o código do app, e os limites da empresa valem para ele. Se o pedido não puder ser criado (a Meta não respondeu, já existe um igual, falta um limite, a equipe está parada), a recomendação fica na Atenção, com o motivo, e ele não tenta de novo sozinho. Só na Meta e com a escrita ligada para a empresa: no Google, o modo vai até Sugerir | "Nada é executado sem aprovação humana nesta fase"; e o que não deu para pedir não pode sumir |
| D-A4-27 | **Voltar um passo** | Dono e Administrador voltam de Aprovação para Sugerir, e de Sugerir para Sombra, a qualquer momento; os pedidos que ele já fez continuam esperando decisão. O pedido que a pessoa faz a partir de uma recomendação fica ligado a ela: é isso que os portões da D-A4-25 contam | O mesmo desenho da promoção para Sugerir (I13): quem deixa fazer mais também tira |

**Decisões propostas com o protótipo P10 (05/10/2026), aguardam o dono:**

| # | Decisão | Proposta | Por quê |
| --- | --- | --- | --- |
| D-A4-28 | **De onde a peça parte** | O Criativo só trabalha a pedido de quem opera campanhas. O pedido escolhe uma **oferta de Minha marca** (o nome, o que é e o preço que uma pessoa conferiu); ele parte dela, da voz e das regras da marca, do anúncio que mais vendeu e, na imagem, de **uma foto de verdade do produto, enviada pela empresa**: muda o fundo, a luz e o enquadramento, e não inventa o prato. Sem foto, só o texto (e a peça só de texto usa a foto como ela é). A imagem sai **sem texto, sem pessoa e sem marca de terceiro** | A imagem inventada de um produto engana quem compra (CDC, art. 37; CONAR, guia de 2026, item 1.3.1); o texto dentro da arte ainda sai errado nos modelos (base §17.4); o preço não pode vir da IA; D-A4-9 |
| D-A4-29 | **A conferência do Compliance, peça por peça** | Toda peça passa pelo Compliance **antes de aparecer**, com o resultado item por item e o motivo. No texto: o preço é o da oferta, as regras da Liame e das plataformas, as regras da marca e o tamanho que a Meta recomenda. Na imagem: sem texto na arte, sem pessoa, sem marca de terceiro, o produto é o da foto e o formato serve para o Feed e os Stories. O que **barra** impede aprovar e ir para a Meta; o **aviso** (tamanho acima do recomendado) deixa passar. Editar o texto cria uma versão nova, conferida de novo, e o texto que seria barrado não é salvo. "A conferência errou?" guarda o motivo e não destrava a peça | A4-10; o tamanho é recomendação do guia da Meta, não regra (base §2.1); a pessoa precisa do motivo para corrigir; o que é regra não pode ser liberado por quem está com pressa |
| D-A4-30 | **Aprovar a peça não pede o código do app** | Aprovar, pedir outra e recusar são de quem opera campanhas (Dono, Administrador e Gestor), peça por peça ou "as que passaram" de uma vez. Aprovar **guarda a peça na biblioteca**; nada sai do Liame. O código do app continua em tudo o que vai para a Meta: criar a campanha e ativar | O código protege o que gasta dinheiro ou publica (D-A4-7); a peça na biblioteca não faz nem um nem outro, e pedir o código a cada peça ensinaria a digitar sem ler |
| D-A4-31 | **A campanha nova: um pedido para criar, pausada, e outro para ativar** | A peça aprovada vira campanha por uma gaveta curta (o nome; o que se quer do anúncio: pedidos pelo cardápio ou conversas no WhatsApp; quem vê, pelo raio da loja; a verba diária; e o fim, opcional), com o rastreio do Liame e **as melhorias automáticas da Meta desligadas**. **Criar** é um pedido de risco baixo, com a prévia do anúncio: nasce pausada e não gasta; passa sem os limites da empresa, mas respeita o teto por campanha quando ele existe. **Ativar** é outro pedido, de risco médio: pede os dois limites e caber na verba do mês (D-A4-19); a volta dele é pausar. Se a criação parar no meio, o que existe fica pausado, o Liame continua de onde parou quando alguém mandar e não apaga nada na Meta | D-A4-3 (nada nasce ativo); a prévia da campanha nova é a peça (D-A4-23); com as melhorias ligadas, a Meta poderia trocar o texto, o fundo e o recorte da peça que a pessoa aprovou (base §2.1); apagar sempre escala para uma pessoa |
| D-A4-32 | **O custo da geração à vista** | Antes de pedir, a estimativa em reais e quanto do limite de uso de IA do dia já foi usado; depois, o custo de cada versão (texto, imagem e conferência). O pedido que não cabe no limite é negado na hora, com o que resta. Com a IA desligada ou o limite atingido, dá para aprovar, recusar e usar as peças que já existem; só não dá para pedir peça nem versão nova | A geração é só a pedido e dentro do teto de IA (seção 10); quem paga precisa ver o preço antes |
| D-A4-33 | **"Feito com IA" e o que a tela diz sobre a peça** | Toda peça gerada leva o selo (na imagem feita por IA; "texto feito com IA" na peça só de texto). "De onde veio" mostra o anúncio, Minha marca e a foto de que ela partiu, o que foi ao fornecedor de imagem (a foto e o pedido, nenhum dado de cliente) e o aviso de uso: a peça é da empresa para anunciar, sem promessa de exclusividade, e a lei de direito autoral protege o que é criado por uma pessoa. No anúncio, o aviso é o da própria Meta, quando ela identifica a imagem feita com IA: o Liame não escreve aviso na arte. A "nota" da peça, que o protótipo geral citava, fica fora: a biblioteca mostra o que a peça vendeu | A4-12; o CONAR não criou dever de aviso (base §6); Termos 9.3; Lei 9.610, art. 11; uma nota sem critério medido seria um número inventado |

## 5. Protótipos para aprovação (antes do código de tela)

| # | Protótipo | Estados que precisa mostrar |
| --- | --- | --- |
| P9 | **Pedido de anúncio em Aprovações** | Verba (antes × depois, motivo, números da sombra); pausar e retomar; campanha nova pausada com a prévia; validação da Meta recusou; mudou na Meta antes de executar; executado e conferido; desfeito |
| P10 | **Criativos** | Gerar texto e imagem; conferência do Compliance (passou ou barrou, com o motivo); "feito com IA"; aprovar, pedir outra, recusar; custo da geração |
| P11 | **Sua equipe com Aprovação** | O Gestor de tráfego por conta e ação nos três modos; proposta de Aprovação; voltar para Sugerir |

> **P9 pronto para a aprovação do dono (04/10/2026):** `mockups/prototipo-anuncios.html`, com o seletor "Pedido e verba" (43 estados) na faixa do topo: pedir uma mudança numa campanha da Meta (o botão em Resultados e a recomendação do Gestor de tráfego na Atenção, com a gaveta e as recusas dela), o pedido de anúncio em Aprovações (esperando a decisão, executando, executado e conferido, a Meta pediu para esperar, a Meta recusou, alguém mudou na Meta, desfazer e desfeito) e a tela Verba do mês (o teto, o gasto, a previsão, os limites e o que o Liame mudou, conferido com a Meta). **Não mostra a campanha nova** (proposta D-A4-23: fica com o P10). As escolhas propostas são as decisões D-A4-19 a D-A4-24 (seção 4). Sem a aprovação, as telas da X2 e da X4 não têm código.

> **P11 pronto para a aprovação do dono (04/10/2026):** `mockups/prototipo-equipe-aprovacao.html`, com o seletor "Equipe e Aprovação" (16 estados) na faixa do topo: o modo do Gestor de tráfego em cada conta e ação (Sombra, Sugerir e Aprovação na mesma tela), o que falta para a Aprovação, a proposta de Sugerir para Aprovação (aprovar, recusar, retirada pelo sistema), a volta de um passo, o limite do Google, a escrita desligada, quem só vê, e a rodada da manhã em cada caso (pediu e sugeriu, não conseguiu pedir, equipe parada). As escolhas propostas são as decisões D-A4-25 a D-A4-27 (seção 4). Sem a aprovação, a tela da X3 não tem código; o servidor da X3 pode seguir.

> **P10 pronto para a aprovação do dono (05/10/2026):** `mockups/prototipo-criativos.html`, derivado do P9 (que também aguarda aprovação), com o seletor "Criativos" (43 estados) na faixa do topo: a tela Criativos (o uso de IA do dia, o lote para decidir, a biblioteca e os anúncios que já vendem), pedir uma peça (a oferta, texto e imagem ou só o texto, de onde o Criativo parte e a estimativa de custo; oferta sem foto, instrução que bate numa regra, limite de IA, fornecedor de imagem que não respondeu ou recusou), a peça aberta (a prévia no Feed e nos Stories, o texto com a contagem, a conferência do Compliance item por item, barrada pelo texto e pela imagem, editar, pedir outra, recusar, aprovar, as versões e o custo) e a campanha nova (montar, o pedido em Aprovações com a prévia, criada pausada, a Meta recusou, parou no meio, ativar com risco médio e o teto do mês, ativada e a volta). As escolhas propostas são as decisões D-A4-28 a D-A4-33 (seção 4). Sem a aprovação, as telas da X5, da X6 e da X7 não têm código.

## 6. Critérios de saída da A4

| # | Critério | Como é verificado |
| --- | --- | --- |
| A4-1 | Nenhuma escrita na Meta sem `validate_only` antes; recusa da validação não aplica | Teste do conector |
| A4-2 | Nenhuma escrita sem aprovação de uma pessoa com o código do app (na A4) | Teste + política |
| A4-3 | Limites de uso da Meta respeitados: a execução adia, não insiste | Teste com os cabeçalhos e os erros simulados |
| A4-4 | Mudança humana feita na Meta não é sobrescrita (nem pela volta) | Teste de concorrência |
| A4-5 | Toda ação tem compensação testada | Teste por ferramenta |
| A4-6 | Promoção para Aprovação só com os portões e uma pessoa aprovando | Teste + registro do piloto |
| A4-7 | A sombra continua medindo com o modo Aprovação | Teste |
| A4-8 | O gasto real conciliado com o executado; diferença acima do limite avisa | Teste + registro do piloto |
| A4-9 | Campanha criada pelo Liame nasce pausada; ativar pede outra aprovação | Teste do conector + piloto |
| A4-10 | Peça gerada passa pelo Compliance antes de aparecer; barrada não vai para a Meta | Teste + eval |
| A4-11 | Eval do Criativo como portão (número, promessa, política, marca) | CI |
| A4-12 | Imagem com a marca "feito com IA" na tela e o C2PA quando o fornecedor der | Teste |
| A4-13 | Telas P9 a P11 conforme protótipo aprovado, em 1440/1024/768/375, claro e escuro | Verificação no navegador |
| A4-14 | **Piloto:** pelo menos 10 ações aprovadas executadas na Meta sem erro e conferidas; uma volta testada de verdade | Registro com prints |
| A4-15 | Documentos jurídicos atualizados nos mesmos PRs (seção 7) | README jurídico |

## 7. Documentos jurídicos que mudam (`CLAUDE.md` §6)

| Documento | Mudança | Entra com |
| --- | --- | --- |
| Termos 2.1, 2.3 e 2.6 | O que o Liame faz na Meta em nome da empresa nesta fase (verba, pausa, campanha nova pausada, sempre com aprovação); a volta; o que nunca faz (ativar sem aprovação, mexer no limite da conta) | X1, X2, X5 |
| Termos (responsabilidade) | Quem aprova responde pela publicação; o Liame confere e registra | X2 |
| Política 7 | O Criativo, a imagem gerada, o que vai ao fornecedor de imagem (o pedido da peça, nunca dado de cliente) e a guarda | X6, X7 |
| Política 8 · Contrato Anexo III | O fornecedor de imagem passa de previsto a em uso, com o país e a base da transferência | X7 |
| README jurídico | Linhas na lista de mudanças e na checagem de verdade | cada PR |

## 8. Base de conhecimento: reconferir e pesquisar antes do código (`CLAUDE.md` §1)

- **Reconferir na fonte oficial (Meta):** a escrita de verba na campanha (orçamento de campanha) e no conjunto na v26, o campo, a unidade e a resposta do `validate_only`; pausar e retomar campanha, conjunto e anúncio; criar campanha, conjunto, anúncio e criativo pausados; os limites de uso da escrita; a permissão `ads_management` na configuração do login e o que o App Review pede para ela; a regra da Meta sobre conteúdo feito com IA em anúncio e a marca "AI info". *Criar campanha, conjunto, criativo e anúncio, as melhorias automáticas do criativo e o rótulo de IA: conferidos em 05/10/2026 (base §2.1); ficam para a X5 os tipos de botão e a validação do conjunto e do anúncio antes de a campanha existir.*
- **Pesquisar e registrar com [O]:** os fornecedores de imagem do catálogo (OpenAI, Google e outros): uso dos dados enviados, guarda, região, preço por imagem e C2PA; regras de propaganda com IA no Brasil (CONAR e o que estiver em vigor); direitos sobre a imagem gerada. *Feito em 05/10/2026 (base §17.4 e §6): OpenAI e Google com fonte oficial; Black Forest Labs fora, por treinar com o que recebe; Adobe e Ideogram ainda por conferir na página oficial.*
- **Atualizar a §16.1** (como produtos de marketing mostram a aprovação de anúncio e a peça gerada) antes dos protótipos P9 e P10. *Feito para o P9 em 04/10/2026 (pedido de mudança, verba do mês e desfazer) e para o P10 em 05/10/2026 (a peça gerada: conferir, aprovar e levar para a campanha).*

## 9. O que depende de você

| Para | Preciso de |
| --- | --- |
| Começar | ✅ Aceite deste plano e das decisões da seção 4 (03/10/2026) |
| X1 | Criar a configuração de **escrita** do login da Meta, com `ads_management` (a de leitura fica como está; eu passo o caminho, um print por vez), pôr o ID dela em `META_LOGIN_CONFIG_ID_ESCRITA` no EasyPanel (`liame-api`) e, com a flag `meta_write` ligada, conectar a Meta de novo no Liame |
| Clientes de fora | Enviar o App Review de `ads_management` (com o vídeo da aprovação e da execução, que eu roteirizo) depois do X2 |
| X2 | O teto por ação e o envelope do mês do piloto (quanto o Liame pode comprometer). Sem eles, o Liame só reduz verba e pausa na Meta; aumentar e retomar ficam negados. A tela para definir os dois chega com a X4 |
| X2 | ✅ Decisões D-A4-12 a D-A4-18 aprovadas (04/10/2026) |
| X7 | Conta no fornecedor de imagem escolhido no eval; a chave vai direto para o EasyPanel (`liame-api` e `liame-worker`), nunca para a conversa |
| Telas | Aprovar P9 a P11. **O P9 está pronto** (`mockups/prototipo-anuncios.html`), com as decisões propostas D-A4-19 a D-A4-24, **o P11** (`mockups/prototipo-equipe-aprovacao.html`), com as D-A4-25 a D-A4-27, e **o P10** (`mockups/prototipo-criativos.html`), com as D-A4-28 a D-A4-33 (seção 4): os três esperam você |
| Ligar | Decidir quando ligar a flag `meta_write` para a Mister Burgers (comando `ligar-flag`) |
| Ligar | A flag `modo_aprovacao` (o Gestor de tráfego faz o pedido) fica desligada até as telas do P9 e do P11 existirem: sem elas, a tela de Aprovações não diz que o pedido veio dele |
| Nuvem | Digitar a senha do banco no `.env.nuvem` para cada migration, antes de cada merge |

## 10. Riscos

| Risco | Mitigação |
| --- | --- |
| Gastar dinheiro por engano | Aprovação com código; `validate_only`; passo de ±10%; teto por ação; envelope do mês com reserva; parada da empresa; nada nasce ativo |
| Sobrescrever o que alguém mudou na Meta | Leitura antes de aplicar e versão do estado; a volta também confere |
| Limite de uso da Meta | Adiar em vez de insistir; poucas escritas por ação; leitura em lote |
| App Review de escrita negado ou demorado | Piloto pelo acesso padrão; o resto do produto não depende da escrita |
| Token revogado ou expirado | Vigia de integrações; aviso na Atenção; nada é executado com token inválido |
| Peça com problema (texto proibido, pessoa real, marca de terceiro) | Compliance antes de aparecer; aprovação humana; nada vai para a Meta sem aprovação |
| Versão da API que expira | Vigia; a versão é dado, trocada com teste |
| Custo da geração de imagem | Teto de IA da empresa já cobre a finalidade; geração só a pedido |

## 11. Fora da A4

Escrita no Google, CAPI, públicos com consentimento e réguas (A5); vídeo, TikTok e social orgânico (A6); `LIMITED_AUTO`, `AUTO` e o envelope com teto automático (A7); trocar criativo de anúncio no ar por conta própria; apagar qualquer coisa na Meta (sempre escala para uma pessoa, fora do Liame).
