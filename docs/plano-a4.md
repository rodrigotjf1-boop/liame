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
| **X3** | **Modo Aprovação** | Na ação em Aprovação, a recomendação da sombra cria o pedido no Action Service (o motivo, os números do retrato e o estado lido) em vez de só aparecer na Atenção; a sombra continua medindo; os portões para propor Aprovação (os cinco da A3 mais execuções sem erro e taxa de aprovação) e a promoção, proposta pelo sistema e aprovada por uma pessoa, como a de Sugerir | A4-6, A4-7 | **nova:** portões e proposta de Aprovação (se precisar além da 0038) |
| **X4** | **Dinheiro do mês completo** | O gasto real lido da Meta todo dia conciliado com o que o Liame executou (`execução → informado → gasto real`), por ação e por conta; diferença acima do limite vira aviso; envelope do mês na tela | A4-8 | **nova:** gasto conciliado |
| **X5** | **Campanha nova, pausada** | Montagem da campanha (objetivo, conjunto com público e verba, anúncio com o criativo aprovado e o rastreio do Liame nos parâmetros de URL); `validate_only` antes; criada **pausada**; ativar é ação à parte, com aprovação e código; apagar continua sempre escalando | A4-2, A4-9 | — |
| **X6** | **Criativo: texto** | Funcionário Criativo (definição no registro): títulos e textos a partir do que já vendeu (Resultados), do dossiê da marca e do que a marca não diz; Compliance e regras da Meta para texto; eval `criativo_texto` (número, promessa, política, marca) como portão | A4-10, A4-11 | — |
| **X7** | **Criativo: imagem** | A finalidade imagem no catálogo, com **um fornecedor escolhido por eval** (qualidade, texto na arte, custo, contrato de dados); a peça guardada no Liame, com C2PA quando o fornecedor der; conferência do Compliance (texto na arte, promessa, pessoa real, logo de terceiro); a marca "feito com IA" onde a Meta pedir; envio para a Meta só depois da aprovação | A4-10, A4-11, A4-12 | **nova:** peças geradas |
| **X8** | **Telas** | Pelos protótipos da seção 5: o pedido de anúncio em Aprovações (antes × depois, motivo, números, validação da Meta), a execução e a volta; Criativos (gerar, conferir, aprovar); Sua equipe com o modo Aprovação | A4-13 | — |

> **Migrations:** o número de cada uma sai da sequência quando a entrega começar (as da A3 passaram da 0040, que este plano citava). Sempre a seguinte à última de `packages/database/migrations` na `origin/main` e nos PRs abertos.

Ordem: X1 → X2 → X4 (o dinheiro antes de mexer mais) → X3 → X6 → X7 → X5 → X8 (as telas entram com cada parte, pelo protótipo aprovado).

**Andamento:** X1 entregue em 04/10/2026, com a reconferência da seção 8 para a escrita de situação e verba (base §2.1): o conector `meta_ads` (lê o estado na Meta, valida com `validate_only`, escreve, confere), a espera da execução quando a Meta manda esperar (`next_attempt_at` no pedido) e a migration **0044**. Detalhe em `andamento.md`. **X2 entregue em 04/10/2026:** as ferramentas de anúncio na Meta (verba diária, pausar e retomar campanha, conjunto e anúncio), a política da distribuição na versão 3 (limite de frequência por objeto com o provedor certo, ±10% por pedido, o pedido de uma pessoa esperando aprovação), os limites da empresa fechados por padrão, a leitura na hora do pedido com o motivo quando a Meta falha, e a volta (`POST /v1/actions/{id}/undo`), com a migration **0045**. Com a flag `meta_write` desligada para todos, nada escreve na Meta. As decisões tomadas na entrega estão na seção 4 (D-A4-12 a D-A4-17), para o dono confirmar.

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

**Decisões tomadas na X2 (04/10/2026), pela recomendação, para o dono confirmar ou mudar:**

| # | Decisão | O que foi feito | Por quê |
| --- | --- | --- | --- |
| D-A4-12 | **Quem pede** | O que uma pessoa pede na Meta espera aprovação com o código do app (regra da distribuição, `actor: human`). O modo do funcionário de IA em cada conta (Sombra, Sugerir e, na X3, Aprovação) é outra regra (`actor: agent`) | As duas coisas usavam a mesma regra: liberar o pedido da pessoa tirava o Gestor de tráfego da Sombra, e voltar o funcionário para Sombra travaria o pedido da pessoa |
| D-A4-13 | **Limites da empresa, fechados por padrão** | Na Meta, aumentar verba só com o teto por ação definido pela empresa (ou pela marca); aumentar e retomar só com o envelope do mês definido. Sem eles, o Liame nega o pedido | "Sem limite definido" não pode querer dizer "sem limite" |
| D-A4-14 | **A volta** | É um pedido novo, com a mesma aprovação. Fica fora do teto e dos 10% (devolve o valor que já estava lá), mas dentro do envelope do mês e do limite de frequência. Só vale se ninguém mexeu no objeto depois; uma por vez; não desfaz o que o Liame não escreveu | Desfazer não pode ser um atalho sem aprovação, nem passar por cima do que uma pessoa mudou na Meta |
| D-A4-15 | **Limite de frequência por objeto** | No máximo 3 mudanças de verba por hora na mesma campanha ou no mesmo conjunto, somando aumentar e reduzir | É como a Meta conta (4 por hora por conjunto); contar na conta inteira travava quem cuida de vários conjuntos |
| D-A4-16 | **O teto não barra a redução** | O teto por ação vale para o que faz o gasto subir. Reduzir uma verba que já está acima do teto é permitido | Baixar o gasto é a direção segura; sem isso, a recomendação mais comum da sombra (reduzir a verba) seria negada em campanha grande |
| D-A4-17 | **Retomar reserva um dia de verba** | Retomar é risco R2 e conta como gasto novo: reserva no envelope um dia da verba que mora no objeto; anúncio e objeto sem verba própria não reservam | Aproximação declarada, como a do aumento (um dia da diferença); o gasto real conciliado vem na X4 |

## 5. Protótipos para aprovação (antes do código de tela)

| # | Protótipo | Estados que precisa mostrar |
| --- | --- | --- |
| P9 | **Pedido de anúncio em Aprovações** | Verba (antes × depois, motivo, números da sombra); pausar e retomar; campanha nova pausada com a prévia; validação da Meta recusou; mudou na Meta antes de executar; executado e conferido; desfeito |
| P10 | **Criativos** | Gerar texto e imagem; conferência do Compliance (passou ou barrou, com o motivo); "feito com IA"; aprovar, pedir outra, recusar; custo da geração |
| P11 | **Sua equipe com Aprovação** | O Gestor de tráfego por conta e ação nos três modos; proposta de Aprovação; voltar para Sugerir |

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

- **Reconferir na fonte oficial (Meta):** a escrita de verba na campanha (orçamento de campanha) e no conjunto na v26, o campo, a unidade e a resposta do `validate_only`; pausar e retomar campanha, conjunto e anúncio; criar campanha, conjunto, anúncio e criativo pausados; os limites de uso da escrita; a permissão `ads_management` na configuração do login e o que o App Review pede para ela; a regra da Meta sobre conteúdo feito com IA em anúncio e a marca "AI info".
- **Pesquisar e registrar com [O]:** os fornecedores de imagem do catálogo (OpenAI, Google e outros): uso dos dados enviados, guarda, região, preço por imagem e C2PA; regras de propaganda com IA no Brasil (CONAR e o que estiver em vigor); direitos sobre a imagem gerada.
- **Atualizar a §16.1** (como produtos de marketing mostram a aprovação de anúncio e a peça gerada) antes dos protótipos P9 e P10.

## 9. O que depende de você

| Para | Preciso de |
| --- | --- |
| Começar | ✅ Aceite deste plano e das decisões da seção 4 (03/10/2026) |
| X1 | Acrescentar `ads_management` na configuração do login da Meta (eu passo o caminho conferido) e conectar a Meta de novo no Liame |
| Clientes de fora | Enviar o App Review de `ads_management` (com o vídeo da aprovação e da execução, que eu roteirizo) depois do X2 |
| X2 | O teto por ação e o envelope do mês do piloto (quanto o Liame pode comprometer). Sem eles, o Liame só reduz verba e pausa na Meta; aumentar e retomar ficam negados. A tela para definir os dois chega com a X4 |
| X2 | Confirmar ou mudar as decisões D-A4-12 a D-A4-17 (seção 4) |
| X7 | Conta no fornecedor de imagem escolhido no eval; a chave vai direto para o EasyPanel (`liame-api` e `liame-worker`), nunca para a conversa |
| Telas | Aprovar P9 a P11 |
| Ligar | Decidir quando ligar a flag `meta_write` para a Mister Burgers (comando `ligar-flag`) |
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
