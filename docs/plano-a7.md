# Liame — Plano da fase A7 · Escala comercial

> **Aprovado pelo dono em 21/10/2026** ("4 aprovados", no mesmo dia da proposta), com as decisões D-A7-1 a D-A7-12 como recomendadas (seção 4); **o valor dos planos (D-A7-4) segue com o dono**, e o meio de pagamento sai da comparação da D-A7-2, que vem antes do código. A A7 é a "escala comercial" do roadmap (§2): o Liame passa a ser **vendido fora do piloto** — quem quer contratar assina e paga sozinho, a agência trabalha para várias empresas com o próprio time e o vínculo aceito pelo dono, e o acesso fica mais forte. A regra das fases anteriores continua: **nada que gaste dinheiro ou fale em nome da empresa sem a aprovação de uma pessoa com o código do app**; a única exceção possível é a do bloco 4 (seção 3), que tem decisão própria e só entra depois do piloto de ações.
>
> **Decisões do dono em 22/10/2026, à noite:**
> - a D-A7-2 escolheu o **Asaas**;
> - o **P26 foi aprovado**, com as decisões D-A7-13 a D-A7-19;
> - a D-A7-4 definiu dois planos: o **Essencial a R$ 249,00** e o **Completo a R$ 449,00** por mês;
> - o **Pix Automático fica pronto e desligado no início** (a D-A7-17 revista);
> - a abertura do CNPJ foi confirmada em 30/06/2026.
>
> Fica com o dono o contador (D-A7-3).
>
> A A7 depende da A6 no roadmap, e a A6 ainda espera o dono (os protótipos P19, P21 e P22 e a autorização da Meta para publicar). Os três primeiros blocos desta fase **não dependem** da A6: a cobrança, os parceiros e a conta do dono. Por isso o plano pode correr junto com o fim da A6, sem atrasá-la.

## 1. De onde partimos (código e documentos lidos em 21/10/2026)

| Onde | Já existe | Falta |
| --- | --- | --- |
| **Cobrança** | O modelo nos Termos (10 e 11, aprovados pelo dono em 28/09/2026): assinatura **mensal por marca**, PIX ou cartão, sem fidelidade e sem percentual da mídia, IA incluída por plano (D5, D11), reajuste com aviso de 30 dias, atraso (aviso no 1º dia, ações pausadas no 10º, conta suspensa no 30º), nota fiscal, cancelamento sem multa no fim do período pago e desistência em 7 dias com devolução integral. As permissões `cobranca.ver` e `cobranca.gerenciar` (só o Dono; o Administrador quando o Dono libera) | O plano, a assinatura, o meio de pagamento, a nota fiscal, a tela, a pausa e a suspensão por atraso. O `data-model.md` já reserva `plan / subscription` para a A7 |
| **Acesso delegado** (ADR-017, A1) | Convite por e-mail com nível, limite por ação, aprovação dupla, data de fim e cobrança só com o Dono; "ninguém dá mais do que tem"; remoção na hora; uma pessoa em várias empresas, com o seletor do topo; `audit_event.actor_type` já aceita `partner` | **O vínculo de parceiro** (a organização da agência, o pedido aceito pelo dono e o desvínculo), a transferência de propriedade, a recuperação da conta do dono pela DMS e o resumo semanal do que cada pessoa fez |
| **Acesso** (ADR-013) | Senha, app autenticador obrigatório para Dono, Administrador, Gestor e Aprovador, códigos de recuperação, sessão por cookie, reautenticação ao aprovar | **Passkeys** (WebAuthn), que o ADR-013 deixou para a A7 por resistirem a phishing |
| **Autonomia** (ADR-007, `ai-architecture.md` §4) | Os seis modos no motor de políticas; a sombra, a prontidão e a promoção de Sombra para Sugerir (A3, I13); o modo Aprovação (A4); o teto do mês (D-A4-19); a flag `autopilot`, desligada, que `LIMITED_AUTO` e `AUTO` exigem | A execução sem aprovação **dentro do envelope**, e antes dela o piloto de ações (A4-14), que ainda não começou |
| **Marca por configuração** | O design system só em tokens ("tema claro, tema escuro e white-label são só outro conjunto de valores", `decisoes-design.md` §2) | A marca do parceiro aplicada em algum lugar (relatório, e-mail, tela) |
| **Rede e franquia** | `organization → brand → unit` (a loja, com fuso e raio), verba e política por marca | A rede: a franqueadora acima das unidades, a verba por unidade e a aprovação central |
| **Relatórios** | A revisão da semana na tela e por e-mail; o protótipo do relatório do mês (P24), que aguarda o dono | O relatório **para o cliente**, que a agência manda com a marca dela |
| **Trâmites** | `ads_read` aprovado pela Meta (20/10/2026); a marca do app verificada no Google (17/10/2026) | O que o dono decidiu deixar para "antes do primeiro cliente de fora" (roadmap §2.1): a análise do `ads_management` na Meta, a verificação completa do app no Google, o nível Básico do Google Ads, a revisão do advogado e o aviso de 30 dias com o novo aceite |

## 2. O que muda para quem usa

1. **Quem quer contratar assina sozinho.** Escolhe o plano, paga por PIX ou cartão e recebe a nota fiscal. Cancela num clique, pelo próprio Liame.
2. **A agência trabalha para várias empresas com o próprio time.** Ela pede o vínculo; o dono aceita, vê quem da agência entrou e desfaz quando quiser. A conta continua do dono.
3. **A agência mostra ao cliente o que foi feito.** O relatório do mês vai para o cliente com o nome da agência.
4. **Entrar fica mais seguro e mais rápido.** Uma chave de acesso (passkey) no celular ou no computador, no lugar de digitar o código do app.
5. **Depois, e só com a sua decisão:** um funcionário pode fazer sozinho o que é pequeno e combinado, dentro do teto (por exemplo, pausar o anúncio que gasta sem vender), sempre com o registro e a volta.

## 3. Entregas no Liame

Cada entrega é um PR com CI verde. Migrations testadas no local e no CI e aplicadas na nuvem antes do merge (a da W1 é a 0080; as da W2a, a 0081 e a 0082). Letra **W**. Antes do código: os protótipos da seção 5 e a reconferência da seção 8. **Quatro blocos que param sozinhos**, cada um entrega valor sem o seguinte:

- **Bloco 1 · Vender sozinho** (W1 a W5): sem ele não há cliente de fora.
- **Bloco 2 · Agências** (W6 a W8): o parceiro, a visão dele e a conta do dono.
- **Bloco 3 · Escala** (W9 a W11): passkeys, revenda e marca do parceiro, rede. Revenda, marca do parceiro e rede só entram com o primeiro parceiro ou a primeira rede de verdade (D-A7-1).
- **Bloco 4 · Autonomia** (W12): a execução sem aprovação dentro do envelope, depois do piloto de ações (A4-14) e com decisão própria do dono.

| # | Entrega | O que fica pronto | Critérios | Depende de |
| --- | --- | --- | --- | --- |
| **W1** | **Planos e assinatura** (servidor) | O plano (do produto, versionado, com o preço, os funcionários e a franquia de IA de cada um) e a assinatura por marca, com a vida inteira dela (ativa, em atraso, ações pausadas, suspensa, cancelada no fim do período); a franquia de IA do plano vira o teto da empresa (D-A3-3); tudo na auditoria. Função `cobranca`, desligada | A7-3 | D-A7-2 a D-A7-5 |
| **W2** | **Pagamento** | O meio escolhido (D-A7-2): PIX e cartão, com o cartão guardado só no meio de pagamento (o Liame nunca vê o número); os avisos dele conferidos pela assinatura e tratados uma vez só; a conciliação diária | A7-1, A7-2 | W1; a conta no meio de pagamento |
| **W3** | **Atraso, cancelamento e devolução** | O aviso no 1º dia de atraso, a pausa das ações no 10º (a parada da empresa, com o motivo "cobrança") e a suspensão no 30º (Termos 10.4, D-A7-6); cancelar num clique, valendo no fim do período pago; a desistência em 7 dias com devolução integral na primeira contratação (11.1); o expurgo que já existe no fim | A7-3 | W2 |
| **W4** | **Nota fiscal** | A NFS-e de cada cobrança paga, pela forma decidida com o contador (D-A7-3), com o envio ao Dono | A7-4 | W2; o contador |
| **W5** | **Telas da cobrança** | "Plano e cobrança" (Dono e quem tem a cobrança liberada): assinar, trocar de plano, a forma de pagamento, as faturas e as notas, o atraso e o cancelamento; o aviso de atraso em toda tela para quem paga | A7-9 | P26 aprovado |
| **W6** | **Parceiro** (ADR-017) | A organização do tipo parceiro, com o time dela; o pedido de vínculo a uma empresa, o aceite do Dono com o código do app (com o nível máximo e o limite que ele dá ao parceiro), o time do parceiro entrando com os níveis de hoje, nunca acima do que o Dono deu; o desvínculo pelos dois lados, cortando na hora; tudo na auditoria como `partner` | A7-5, A7-6 | P27 aprovado |
| **W7** | **A visão da agência e o relatório para o cliente** | Para quem é de um parceiro: a lista das empresas vinculadas, com o que pede atenção em cada uma (só o que o nível da pessoa naquela empresa deixa ver) e a troca de empresa; o relatório do mês (P24) com o nome do parceiro, para mandar ao cliente | A7-5, A7-9 | W6; P24 e P27 aprovados |
| **W8** | **A conta do dono** | A transferência de propriedade (só o Dono, com o código do app e o aceite de quem recebe) e a recuperação da conta do Dono pela DMS, com a conferência do CNPJ, pelo console da distribuição (ADR-017); o resumo semanal do que cada pessoa e cada parceiro fez | A7-7 | — |
| **W9** | **Passkeys** | Cadastrar uma chave de acesso, entrar com ela e usá-la no lugar do código do app (também ao aprovar); o app autenticador continua; os códigos de recuperação continuam; as chaves aparecem em "Segurança da conta", com o nome e o último uso, e saem com um clique | A7-8 | P28 aprovado |
| **W10** | **Revenda e marca do parceiro** | O parceiro que paga pelas empresas dele (uma fatura do parceiro, D-A7-8) e a marca do parceiro onde a D-A7-9 deixar | A7-3, A7-9 | O primeiro parceiro que pedir |
| **W11** | **Rede e franquia** | A rede acima das unidades: a verba por unidade e a aprovação central, com o dono de cada unidade no comando da conta dela (D-A7-10) | A7-5 | A primeira rede de verdade |
| **W12** | **Autonomia dentro do envelope** | `LIMITED_AUTO` de verdade, só nas ações da D-A7-11, por conta e por ação, promovido pela prontidão (I13) e aprovado por uma pessoa; cada execução automática na auditoria, com a volta e o aviso; a flag `autopilot` ligada por empresa | A7-10 | O piloto de ações (A4-14); D-A7-11 |
| **W13** | **Telas** | Pelos protótipos da seção 5 | A7-9 | Aprovação dos protótipos |

## 4. Decisões (aprovadas pelo dono em 21/10/2026, como recomendadas)

| # | Decisão | Recomendação | Por quê |
| --- | --- | --- | --- |
| D-A7-1 | **O que vem primeiro** | Bloco 1 (vender sozinho), depois o bloco 2 (agências). Do bloco 3, passkeys entram quando houver tempo; revenda, marca do parceiro e rede só com o primeiro parceiro ou a primeira rede que pedir. O bloco 4 só depois do piloto de ações (A4-14) | Sem cobrança não há cliente de fora; revenda e rede desenhadas sem um cliente de verdade erram o formato |
| D-A7-2 | **Por onde se paga** | Um meio de pagamento brasileiro com assinatura recorrente no cartão e no PIX (o Pix Automático do Banco Central), aviso assinado por webhook e o cartão guardado só nele. **Escolhido por uma comparação nas páginas oficiais** (custo, Pix Automático, cartão recorrente, emissão de nota, API, contrato e onde ficam os dados), que eu apresento antes do código; os dois que o Regem já integra para o PIX das lojas (Mercado Pago e PagBank) entram na comparação. **Escolhido pelo dono em 22/10/2026: o Asaas** (a comparação está em `base-conhecimento.md` §18) | O Liame não pode tocar em número de cartão (PCI); o PIX recorrente tira o "esqueci de pagar"; uma API que a DMS já conhece encurta o caminho |
| D-A7-3 | **A nota fiscal** | A NFS-e emitida pela própria integração do meio de pagamento, se ele emitir na cidade da empresa; senão, por um emissor à parte. O código de serviço, a alíquota, as retenções e a cidade se decidem **com o contador**, antes do código | A nota é obrigação da SISTER TECNOLOGIA LTDA; a forma depende da cidade e do enquadramento, que não são decisão técnica |
| D-A7-4 | **Planos e preço** | O valor é seu. A recomendação de forma: **poucos planos por marca** (dois ou três), que se diferenciam pelos funcionários incluídos e pela franquia de IA (D5); sem percentual da mídia; sem período grátis no começo, porque a desistência em 7 dias com devolução integral (Termos 11.1) já faz esse papel sem pedir o cartão antes. **Decidido pelo dono em 22/10/2026:** dois planos, o **Essencial a R$ 249,00** e o **Completo a R$ 449,00** por mês, com os funcionários do P26 aprovado | Um dono de restaurante escolhe rápido entre poucos planos; o período grátis com cartão cadastrado vira cobrança-surpresa |
| D-A7-5 | **Quem paga a IA** (pendência final 2 do roadmap) | Dentro da franquia do plano, a distribuição paga (a franquia é o teto da empresa); acima dela, vale a D11 (estimativa antes, o cliente aprova o que for dele). A chave de IA do próprio cliente fica fora da A7. **O valor da franquia de cada plano se fixa com um mês de uso de verdade**: o piloto ainda usa pouco (19 chamadas e US$ 0,33 de 07 a 19/10/2026, lido na produção em 21/10/2026) | É o que os Termos 10.2 já prometem; e franquia sem medida vira prejuízo ou plano caro demais |
| D-A7-6 | **O que o atraso trava** | No 1º dia, o aviso; no 10º, **a parada da empresa com o motivo "cobrança"** (as ações dos funcionários de IA param, a leitura e as telas continuam, e nada de anúncio é pausado pelo Liame); no 30º, a suspensão: **só o Dono entra**, para pagar ou exportar os dados. Pagou, tudo volta na hora | É o texto dos Termos 10.4 com o mecanismo que já existe (a parada); pausar anúncio por atraso mexeria no negócio do cliente sem pedido |
| D-A7-7 | **Como o parceiro entra** | O parceiro pede o vínculo de dentro do Liame, pelo e-mail do Dono da empresa; o Dono vê quem pede e aceita com o código do app, escolhendo **o nível máximo e o limite por ação** que o parceiro pode dar ao time dele; o parceiro escolhe quem do time entra, sempre abaixo disso; o Dono vê o time do parceiro em Pessoas e acessos, tira uma pessoa ou desfaz o vínculo inteiro de uma vez. A conta continua do Dono | É o que o ADR-017 já decidiu ("pedido de vínculo aceito pelo dono e desvínculo a qualquer momento"), com o mesmo "ninguém dá mais do que tem" dos convites |
| D-A7-8 | **Quem paga quando há parceiro** | Começar com **cada empresa pagando a própria assinatura**, também quando trabalha com uma agência. A revenda (o parceiro paga pelas empresas dele, numa fatura só, e cobra o cliente do jeito dele) entra no bloco 3, com o primeiro parceiro que pedir, e com o desconto de parceiro decidido por você | A cobrança direta já cobre a agência que só opera; a revenda muda contrato, nota e atraso de um jeito que precisa de um caso real |
| D-A7-9 | **Até onde vai a marca do parceiro** | Começar **leve**: o nome e o logo do parceiro no relatório para o cliente e no e-mail do relatório ("preparado por Agência X, com o Liame"). Sem domínio próprio e sem esconder o Liame na A7: a LIA e os funcionários continuam se apresentando como assistentes de IA do Liame (D-A3-6), e os Termos e a Política continuam os do Liame | O cliente precisa saber quem trata os dados dele (LGPD) e com quem fala; o white-label completo (domínio, cores, login) é trabalho grande e vale para quando houver revenda |
| D-A7-10 | **Rede e franquia** | Na A7, só o desenho que não fecha portas: cada unidade continua uma empresa, com o dono dela no comando da conta; a rede é uma organização acima, com o vínculo aceito por cada unidade (como o parceiro), a verba por unidade e a aprovação central. O código espera a primeira rede de verdade | Na franquia, a verba e a loja são do franqueado; a franqueadora coordena. Um desenho sem cliente erra quem aprova o quê |
| D-A7-11 | **O que um funcionário pode fazer sozinho** (bloco 4) | Primeiro, **só o que reduz gasto ou risco**: pausar o anúncio ou o conjunto que gasta sem vender e reduzir a verba, dentro do teto do mês, numa conta, promovido pela prontidão (os portões de `ai-architecture.md` §4.2) e aprovado por uma pessoa; cada execução automática vai para a auditoria, aparece na Atenção com "Desfazer" e conta no relatório. **Aumentar verba, retomar e criar continuam com aprovação** na A7. A flag `autopilot` é ligada por você, por empresa | É o menor passo que tira trabalho sem arriscar dinheiro a mais; um erro de pausa custa vendas de algumas horas, e a volta desfaz |
| D-A7-12 | **Passkeys** | A chave de acesso como forma de entrar e como segundo fator (ela vale pelo código do app, também ao aprovar); o app autenticador continua para quem preferir; os códigos de recuperação continuam; quem perde todas as chaves recupera pelo app ou pelos códigos, nunca por e-mail sozinho | Resiste a phishing (o motivo do ADR-013) sem tirar o caminho que já funciona; e-mail não é segundo fator (`security-model.md`) |

### Com o protótipo P26 (aprovadas pelo dono em 22/10/2026, como recomendadas; a D-A7-17 revista por ele)

| # | Decisão | Recomendação | Por quê |
| --- | --- | --- | --- |
| D-A7-13 | **Quem faz o quê na cobrança** | O Dono faz tudo. O Administrador com a cobrança liberada vê a tela, paga, troca a forma de pagamento e baixa as faturas e as notas; **trocar de plano, cancelar e desistir ficam com o Dono**. Os outros níveis não veem "Plano e cobrança" no menu, e quem chega à tela por um link vê quem cuida da cobrança | É a tabela aprovada dos níveis em Pessoas e acessos (a cobrança do Administrador "Se você liberar"; "só o dono … muda a cobrança"): pagar em dia ajuda o Dono, e mudar o contrato é dele |
| D-A7-14 | **O código do app na cobrança** | Trocar de plano, cancelar e desistir pedem o código do app autenticador, como aprovar; pagar e trocar a forma de pagamento, não | São as ações que mudam o contrato (ADR-013: a reautenticação no que importa); o pagamento já passa pela conferência do meio de pagamento |
| D-A7-15 | **Quem vê o aviso de atraso** | Quem paga (o Dono e o Administrador com a cobrança): uma faixa no alto de todas as telas desde o 1º dia, com a data do próximo passo e o botão de pagar. O resto da equipe: só a partir do 10º dia, quando as ações param, com quem resolve. Por e-mail, a quem paga, no 1º, no 7º, no 10º e no 30º dia | O aviso vai a quem resolve; a equipe só precisa saber quando o trabalho dela muda |
| D-A7-16 | **Trocar de plano** | Subir vale na hora, e hoje se paga só a diferença dos dias que faltam no período; descer vale no período seguinte, e até lá o plano atual continua | É como o mercado faz (Stripe, Notion): ninguém paga em dobro nem perde o que já pagou |
| D-A7-17 | **O PIX e o Pix Automático** | Quem escolhe PIX recebe a cobrança do mês por e-mail 5 dias antes do vencimento, com o QR Code, e também paga pela tela; quem paga no cartão continua no cartão. **Revista pelo dono em 22/10/2026** ("não é prioridade, pode deixar pronto porém não usar de início"): o Pix Automático fica pronto no código e **desligado no início**, numa função própria; só com ela ligada a tela oferece autorizá-lo, e nunca antes de 30/12/2026 | O Banco Central só libera o Pix Automático para o CNPJ com seis meses (`base-conhecimento.md` §18.1); o PIX comum com o aviso antes já tira o "esqueci de pagar" |
| D-A7-18 | **A nota de cada cobrança** | A NFS-e sai depois do pagamento, em PDF e XML, na lista das faturas e no e-mail que o Dono escolhe para as notas; enquanto não sai, a linha diz "em emissão"; a nota de uma cobrança devolvida é cancelada | O critério A7-4 (toda cobrança paga tem a nota), e o contador costuma receber as notas por e-mail |
| D-A7-19 | **A desistência em 7 dias** | Pela própria tela, como foi a contratação; devolução de 100% (no cartão, o estorno; no PIX, para a conta que pagou), com protocolo e e-mail na hora; a assinatura termina no pedido, e os dados seguem os 30 dias da seção 11.2 dos Termos | Os Termos 11.1; e o Decreto 7.962/2013 (art. 5º) pede a desistência pela mesma ferramenta da contratação, com a confirmação imediata |

### Da W1 (técnicas, tomadas pela recomendação em 23/10/2026; o dono pode trocar)

| # | Decisão | Recomendação | Por quê |
| --- | --- | --- | --- |
| D-A7-20 | **O plano tem versão** | Cada plano (`essencial`, `completo`) tem versões, e a assinatura fica presa à versão que contratou. Um preço novo é uma versão nova, para quem assina depois; o reajuste de quem já assina é outro passo, com o aviso de 30 dias e a chance de cancelar antes (Termos 10.3) | Mudar o preço de um plano não pode mudar, sem aviso, a cobrança de quem já assina |
| D-A7-21 | **O dia do vencimento** | O dia do primeiro pagamento; no mês que não tem esse dia, o último dia do mês (31/01 → 28/02 → 31/03) | O vencimento não escorrega para o mês seguinte, e o dia 31 não vira 28 para sempre depois de fevereiro |
| D-A7-22 | **Como contam os dias de atraso** | Pela mensalidade mais antiga em aberto, no calendário da empresa (o fuso dela): o 1º dia é o seguinte ao vencimento; no 10º, as ações param; no 30º, a conta é suspensa. Pagou, a situação volta na hora (pela que ainda ficar em aberto, se houver outra) | É o texto dos Termos 10.4 com as datas do P26 aprovado; contar pelo fuso da empresa evita o "atraso" que começa às 21h |
| D-A7-23 | **Subir de plano** | Vale quando a diferença é paga: no cartão, em segundos; no PIX, quando o PIX cai. A diferença que não for paga até o fim do período deixa de valer, e o plano fica como estava | Ninguém fica com o plano maior sem pagar a diferença, e a diferença esquecida não vira dívida |
| D-A7-24 | **O primeiro pagamento** | A assinatura espera o primeiro pagamento por 7 dias; sem ele, termina sozinha, e a fatura não é cobrada. Contratar de novo antes disso (outro plano ou outra forma) substitui o pedido | O pedido que ninguém paga não pode ficar aberto para sempre nem travar a marca |
| D-A7-25 | **Cancelar com a mensalidade em aberto** | Se o período em vigor não foi pago, não há "fim do período pago" para esperar: a assinatura termina na hora, e o que está em aberto não é cobrado | Os Termos 11.1 dizem que o cancelamento vale no fim do período **já pago**; cobrar depois de cancelar é o primeiro risco da seção 10 |
| D-A7-26 | **A franquia de IA vira o teto da empresa** | O teto de IA da empresa é o que a distribuição definir para ela (`ai_budget`); sem isso, a soma das franquias dos planos das marcas com assinatura viva; sem franquia, o teto padrão do servidor. Os dois planos nascem sem franquia (D-A7-5): nada muda no teto até o valor ser fixado | A franquia é de cada plano, e a empresa pode ter mais de uma marca; o teto que a distribuição define à mão continua valendo, como hoje |

### Da W2 (técnicas, tomadas pela recomendação em 23/10/2026, com a API do Asaas conferida na `base-conhecimento.md` §18.5; o dono pode trocar)

| # | Decisão | Recomendação | Por quê |
| --- | --- | --- | --- |
| D-A7-27 | **A W2 em duas partes** | **W2a:** o cliente no Asaas, o PIX de cada mês (a cobrança e o QR Code), o aviso, a releitura, a conferência diária e a devolução do PIX. **W2b:** o cartão, pela assinatura do Asaas, depois de testar no Sandbox o que a documentação não diz (o vencimento no dia 31, a troca de valor). O Pix Automático (pronto e desligado, D-A7-17) vem depois, numa parte própria. A tela (W5) chega depois das duas | O PIX fica inteiro na mão do Liame, porque a fatura é dele; o cartão depende de comportamentos que só o Sandbox confirma |
| D-A7-28 | **O aviso só serve de sinal** | A rota do aviso confere o token em tempo constante, grava o evento cru (o `id` dele não entra duas vezes) e responde 200 na hora, sem mais nada. O worker relê a cobrança na API antes de mudar a fatura (A7-2). Uma conferência por dia relê as faturas em aberto e as pagas do dia, para o aviso que se perdeu, e avisa a distribuição quando a fila do webhook para | O token fixo não assina o corpo; e, com 15 falhas seguidas, a fila do Asaas para, e os eventos somem em 14 dias |
| D-A7-29 | **O que é "pago" para o Liame** | No PIX, a cobrança recebida (`RECEIVED`); no cartão, a confirmada (`CONFIRMED`: o dinheiro chega em 32 dias, mas o cliente já pagou). A devolução só conta com o estorno feito (`DONE`) | É o momento em que o cliente pagou; esperar o saldo do cartão deixaria a equipe parada por um mês |
| D-A7-30 | **Uma cobrança do Asaas para cada fatura do Liame** | No PIX, o Liame cria a cobrança quando a fatura nasce (5 dias antes do vencimento), com o id da fatura no `externalReference`, e procura por ele antes de criar de novo (a API não tem chave de idempotência). O QR Code sai na hora em que a pessoa pede, e o do e-mail da D-A7-17 também | A fatura é a fonte do que se deve (W1); assim o Asaas nunca cobra o que o Liame não cobra |
| D-A7-31 | **O cliente no Asaas é a empresa** | Um cliente por empresa (o CNPJ e o nome), criado na primeira cobrança, com as notificações do Asaas desligadas: os e-mails são do Liame | O Asaas cobra pelas notificações e mandaria avisos em nome dele, fora do que a tela diz |
| D-A7-32 | **Abaixo do mínimo do Asaas, não há cobrança** | A diferença de troca de plano abaixo de R$ 5 não vira cobrança: o plano muda na hora. Com os preços de hoje, isso não acontece (a menor diferença é R$ 6,45, um dia de 31) | O Asaas não cria cobrança abaixo de R$ 5 |
| D-A7-33 | **A chave e o webhook ficam com a distribuição** | Três variáveis no EasyPanel, na API e no worker: a chave da conta (`ASAAS_API_KEY`), o endereço do ambiente (`ASAAS_API_URL`, primeiro o Sandbox) e o token do aviso (`ASAAS_WEBHOOK_TOKEN`, gerado pela distribuição). O próprio Liame cria o webhook dele no Asaas, pela API e com o envio em sequência, sem nada a configurar na tela do Asaas. A conferência diária mantém a chave em uso (parada por 3 meses, ela é desligada) | A chave aparece uma vez só, e o dono não precisa mexer no painel do Asaas além de gerá-la |

## 5. Protótipos para aprovação (antes do código de tela)

| # | Tela | O que mostra |
| --- | --- | --- |
| **P26** | Plano e cobrança | Os planos para escolher; assinar com PIX ou cartão; a assinatura em dia, em atraso (1º, 10º e 30º dia), cancelada no fim do período; trocar de plano; as faturas e as notas; a desistência em 7 dias; o aviso de atraso nas outras telas; quem não pode ver a cobrança. **Aprovado pelo dono em 22/10/2026** (`mockups/prototipo-cobranca.html`, com as decisões D-A7-13 a D-A7-19; os valores do protótipo passaram aos decididos, R$ 249,00 e R$ 449,00) |
| **P27** | Parceiros | O parceiro pedindo o vínculo; o pedido chegando ao Dono (Pessoas e acessos), com o nível máximo e o limite; o time do parceiro na empresa; desfazer o vínculo; a lista das empresas para quem é do parceiro, com o que pede atenção em cada uma |
| **P28** | Passkeys em Segurança da conta | Cadastrar, entrar, aprovar com a chave, a lista das chaves (nome, último uso), tirar uma, perder todas |
| **P29** | Relatório para o cliente | O relatório do mês (P24) com o nome e o logo do parceiro, na tela e no e-mail |
| **P30** | Autonomia dentro do envelope | Em Sua equipe: "Fazer sozinho" proposto pela prontidão, aprovado por uma pessoa, com o que pode e o que não pode; na Atenção: a ação feita sozinha, com "Desfazer"; desligar de novo |

> O P25 fica para o "ler uma página" do Pesquisador (A3), que também precisa de protótipo.

## 6. Critérios de saída da A7

| # | Critério | Como é verificado |
| --- | --- | --- |
| A7-1 | Nenhum número de cartão passa pelo Liame: o cartão é digitado no meio de pagamento e o Liame guarda só a referência | Revisão do caminho + teste que procura o que é gravado |
| A7-2 | O aviso do meio de pagamento só vale com a assinatura certa e é tratado uma vez só, mesmo repetido ou fora de ordem | Teste com aviso repetido, falso e atrasado |
| A7-3 | A assinatura segue os Termos 10 e 11: o aviso no 1º dia, as ações paradas no 10º, a suspensão no 30º, o cancelamento no fim do período pago e a devolução integral em 7 dias na primeira contratação | Teste com o relógio |
| A7-4 | Toda cobrança paga tem a nota fiscal emitida e enviada ao Dono | Teste + conferência com o contador |
| A7-5 | O parceiro só vê as empresas que aceitaram o vínculo; desfeito o vínculo, a próxima chamada do time dele já é recusada | Suíte entre empresas (como a A1-3) |
| A7-6 | Ninguém do parceiro tem mais poder do que o Dono deu ao vínculo | Teste |
| A7-7 | A propriedade só muda pelo Dono, com o código do app e o aceite de quem recebe; a recuperação pela DMS confere o CNPJ e fica na auditoria | Teste |
| A7-8 | A passkey entra e aprova no lugar do código do app; perder as chaves não abre a conta por um caminho mais fraco | Teste |
| A7-9 | Telas P26 a P30 conforme o protótipo aprovado, em 1440, 1024, 768 e 375 px, claro e escuro | Verificação no navegador |
| A7-10 | A ação automática só acontece dentro da regra aprovada e do teto; cada uma vai para a auditoria, aparece com a volta e a volta funciona | Teste + piloto |
| A7-11 | Documentos jurídicos atualizados nos mesmos PRs (seção 7) | README jurídico |
| A7-12 | **Piloto:** a primeira empresa de fora assinando e pagando pelo Liame, com a nota emitida; e, se houver, a primeira agência com o vínculo aceito | Registro com prints |

## 7. Documentos jurídicos que mudam (`CLAUDE.md` §6)

| Entrega | O que muda |
| --- | --- |
| W1 a W4 | **Termos 10 e 11:** o meio de pagamento, o que acontece em cada dia de atraso, como cancelar e como pedir a devolução. **Política:** o meio de pagamento como operador (os dados de cobrança que ele trata, onde e por quanto tempo) e a lista de fornecedores; os documentos fiscais guardados pelo prazo da lei |
| W6 e W7 | **Termos 4:** o parceiro age em nome do cliente, dentro do que o Dono deu; o desvínculo. **Contrato de operador:** o parceiro como quem age pelo controlador. **Política:** o que o parceiro vê |
| W8 | **Termos 3:** a transferência de propriedade e a recuperação pela DMS |
| W9 | **Política:** o que o Liame guarda de uma passkey (a chave pública, o nome e o último uso; nada da biometria, que não sai do aparelho) |
| W10 | **Termos** de revenda, se houver, e o contrato com o parceiro |
| W12 | **Termos 2.3 e 13.2:** a ação feita sozinha dentro da regra que o cliente aprovou, e o compromisso do 13.2 para ela |
| Trâmites | Antes do primeiro cliente de fora: a revisão do advogado (A0-6) e o aviso de 30 dias com o novo aceite (Termos 15) |

## 8. Base de conhecimento: reconferir antes do código (`CLAUDE.md` §1)

- **Meios de pagamento** (para a D-A7-2): assinatura no cartão, Pix Automático (as regras do Banco Central e quais meios já oferecem), o aviso por webhook e a assinatura dele, o custo por cobrança, a emissão de nota e onde ficam os dados. **Conferido em 22/10/2026** (`base-conhecimento.md` §18.1 e §18.2): oito meios nas páginas oficiais. O Pix Automático só pode ser contratado com o CNPJ ativo há seis meses, ou seja, a partir de 30/12/2026 (a abertura, 30/06/2026, foi confirmada pelo dono). **O dono escolheu o Asaas em 22/10/2026** (§18.4). **A API do Asaas foi conferida em 23/10/2026** (§18.5), antes do código da W2.
- **NFS-e** (para a D-A7-3): o padrão nacional e a cidade da empresa; o código de serviço do software como serviço. **O padrão nacional e a cidade foram conferidos em 22/10/2026** (§18.3: o Rio emite só no padrão nacional desde 01/01/2026). O código de serviço, a alíquota e as retenções seguem **com o contador**.
- **Passkeys** (para a W9): a especificação WebAuthn e o suporte dos navegadores e celulares que o cliente usa; a biblioteca para o servidor (com a regra de dependência nova, V12).
- **Meta e Google, para clientes de fora:** o que a análise do `ads_management` e a verificação completa do app do Google pedem, e o nível Básico do Google Ads (já listados no roadmap §2.1).

## 9. O que depende de você

| Para | Preciso de |
| --- | --- |
| Começar | ✅ Aceite deste plano e das decisões da seção 4 (21/10/2026) |
| W1 | ✅ O preço e os planos (D-A7-4, 22/10/2026: R$ 249,00 e R$ 449,00); a franquia de IA de cada plano depois de um mês de uso de verdade (D-A7-5) |
| W2 | ✅ A conta de testes do Asaas (23/10/2026, no nome da empresa, com o e-mail confirmado). Depois, um passo por vez e quando eu avisar: a chave da conta de testes, direto para o EasyPanel, quando a W2a estiver pronta (com a parte 3, que cria o webhook do Liame pela API); para a W2b, o domínio do Liame nos dados comerciais da conta (a volta da página do cartão); e, depois dos testes, a conta de verdade, no CNPJ da empresa. A chave nunca vai para a conversa |
| W4 | O contador: o código de serviço, a alíquota, as retenções e a cidade da nota |
| W6 e W7 | Uma agência de verdade para o piloto do vínculo, se houver |
| W12 | O piloto de ações da A4 (A4-14) e a decisão de ligar a flag `autopilot`, empresa por empresa |
| Telas | ✅ P26 (22/10/2026); aprovar os protótipos P27 a P30 |
| Antes do primeiro cliente de fora | A análise do `ads_management` na Meta, a verificação completa do app no Google, o nível Básico do Google Ads, a revisão do advogado e o aviso de 30 dias com o novo aceite (já decidido em 16/10/2026) |

## 10. Riscos

| Risco | Mitigação |
| --- | --- |
| Cobrar errado (em dobro, depois de cancelar, sem nota) | Aviso tratado uma vez só, conciliação diária, teste com o relógio, nota por cobrança paga; o meio de pagamento é a fonte do que foi pago |
| Dado de cartão no Liame | O cartão só no meio de pagamento; o Liame guarda a referência |
| Agência com mais poder do que devia | O teto do vínculo dado pelo Dono, "ninguém dá mais do que tem", desvínculo na hora, auditoria como `partner` |
| A agência ficar dona da conta | A conta é sempre do Dono (ADR-017); transferência só por ele |
| Ação automática errada | Só as ações que reduzem gasto, dentro do teto, promovidas pela prontidão, aprovadas por uma pessoa, com a volta; a parada desliga tudo em segundos |
| A fase crescer demais | Quatro blocos que param sozinhos; revenda, marca do parceiro e rede só com cliente de verdade |
| A franquia de IA sem medida | O valor só se fixa com um mês de uso real; o teto por empresa já existe |

## 11. Fora da A7

O white-label completo (domínio próprio, login e cores do parceiro, esconder o Liame), a chave de IA do próprio cliente, aumentar verba, retomar e criar campanha sem aprovação, o marketplace de políticas, o app nativo e a cobrança em moeda estrangeira. A A8 (SEO, CRO, SDR, experimentos e os canais adicionais) depende desta.
