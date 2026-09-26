# Liame — Modelo de interface

> **Status: proposta de 25/09/2026, aguardando aprovação.** Atualizada no mesmo dia com os modos **Lite e Pro** (D8: Lite = visão do dono; Pro = recursos completos da LIA) e o **acesso delegado** (D10). Nenhum código de produto foi escrito.
> Protótipo navegável: `mockups/prototipo-app.html` (abre com dois cliques) · publicado em
> <https://claude.ai/artifact/TL4nqSEwQsNPvpZCeNpoFM> (privado).
> Feito com a skill `ui-ux-proprio` (pesquisa em três trilhas → recomendação → protótipo → verificação).
> Dados do protótipo: fictícios (restaurante "Casa Brasa", Unidade Centro).

## 1. Briefing

| Pergunta | Resposta |
| --- | --- |
| Quem usa | **Lite:** dono ou gestor da marca (ex.: dono do restaurante), que quer decidir sem jargão. **Pro:** quem opera (gestor de tráfego, agência) ou o dono que quer ver tudo. |
| Frequência | Dono: todo dia, sessões curtas para decidir. Gestor: todo dia, sessões longas. |
| Aparelho | Dono: celular primeiro. Gestor: computador. |
| Tarefa principal | Decidir o que a equipe de agentes propõe (aprovar, recusar, ajustar) e ver o resultado em dinheiro confirmado no caixa. |
| Volume | Dezenas de propostas por semana, de 4 a 20 campanhas, até 14 funcionários (agentes). |
| Seções | 8 no menu principal; mais 9 ferramentas (recolhidas no Lite, abertas no Pro). |

## 2. Pesquisa de mercado (três trilhas)

| Trilha | Produto | O que faz bem | O que roubar | Link | Status |
| --- | --- | --- | --- | --- | --- |
| Tradicional | Vercel (painel) | Trocou as abas por barra lateral redimensionável (26/02/2026) | Barra lateral com o contexto (marca) no topo | [changelog](https://vercel.com/changelog/dashboard-navigation-redesign-rollout) | verificado em 24/09/2026 (catálogo da skill) |
| Tradicional | Intercom Inbox | Lista e detalhe para triagem; alterna conversa e tabela | Aprovações em lista e detalhe | [ajuda](https://www.intercom.com/help/en/articles/6258745-the-inbox-explained) | verificado em 24/09/2026 (catálogo da skill) |
| Moderno | HubSpot Agent Hub | Agentes organizados pelo resultado, com status ao vivo; caixa com o registro de cada execução | "Sua equipe" com status ao vivo e histórico por funcionário | [Spotlight](https://www.hubspot.com/spotlight) | verificado em 25/09/2026 |
| Moderno | Triple Whale Moby Automations | O agente diz o que quer fazer e enfileira cada ação para aprovação | Fila de aprovação com o motivo; execução só depois do ok | [blog](https://www.triplewhale.com/blog/moby-2-media-buying-automations) | verificado em 25/09/2026 (via busca) |
| Moderno | Linear Agent | Ctrl+K para comandos e Ctrl+J para a IA | Paleta no Ctrl K e LIA no Ctrl J | [changelog](https://linear.app/changelog/2026-03-24-introducing-linear-agent) | verificado em 24/09/2026 (catálogo da skill) |
| Inovador | Klaviyo Composer | Descreve o resultado em linguagem natural e o agente monta a campanha; nada sai sem aprovação | LIA que responde com cartões de ação (no máximo 2 botões) e manda para a aprovação | [ajuda](https://help.klaviyo.com/hc/en-us/articles/52230280693403) | verificado em 25/09/2026 |
| Inovador | Claude Code na web · aba Agents do GitHub | Passos visíveis, tarefas em paralelo, corrigir o rumo no meio | Passo a passo ao vivo do funcionário e o campo "Corrigir o rumo" | [Claude](https://claude.com/blog/claude-code-on-the-web) · [GitHub](https://github.blog/changelog/2026-01-26-introducing-the-agents-tab-in-your-repository/) | verificado em 24/09/2026 (catálogo da skill) |

Detalhes e o suporte dos navegadores estão na base de conhecimento, §16.

## 3. Três caminhos

### A · Tradicional — "Painel de gestão" (base: t01 + t03)

```text
┌───────────┬──────────────────────────────────────────────┐
│ LIAME     │ Casa Brasa ▾           busca        🔔  Rodrigo│
│───────────│──────────────────────────────────────────────│
│ Painel    │ Investimento │ Pedidos │ Receita │ ROAS      │
│ Campanhas │──────────────────────────────────────────────│
│ Criativos │ Tabela de campanhas (colunas, filtros)       │
│ Social    │  nome │ canal │ status │ gasto │ ROAS │ …    │
│ Mensagens │──────────────────────────────────────────────│
│ Públicos  │ Alertas               │ Tarefas dos agentes  │
│ Agentes   │                       │                      │
└───────────┴──────────────────────────────────────────────┘
```

- **Ganha:** familiar para quem usa o Gerenciador de Anúncios; simples de construir.
- **Perde:** o dono vê número, não decisão; os agentes viram mais um item de menu; o ciclo fechado some no meio da tabela.

### B · Moderno — "Central da agência" (base: t04 + t05 + t03, LIA do t09 e o candidato t11) — **recomendado**

```text
┌──────────┬──────────────────────────────────────────┬──────────┐
│ LIAME    │ Casa Brasa / Atenção  ● 09:42  ⌕  🔔 [LIA] │ LIA      │
│ ⌕ Ctrl K │──────────────────────────────────────────│──────────│
│ Atenção 4│ Bom dia. 4 pontos precisam de você  R$178 │ conversa │
│ Conversa │ ┌────────┐┌────────┐┌────────┐┌────────┐  │ e cartões│
│ Aprovações│ │urgente ││atenção ││oportun.││atenção │  │ de ação  │
│ Resultados│ └────────┘└────────┘└────────┘└────────┘  │ (Ctrl J) │
│ Equipe ● │ ┌ Ciclo fechado: invest. → … → margem ──┐ │          │
│ Agenda   │ └────────────────────────────────────────┘ │          │
│ Marca    │ ┌ Sua equipe agora ┐ ┌ Próximos dias ───┐  │          │
│[Lite│Pro] no topo                                     │          │
└──────────┴──────────────────────────────────────────┴──────────┘
```

- **Ganha:** decisão primeiro, ordenada por dinheiro; agentes visíveis como equipe; aprovação vinculada à versão do plano; LIA sempre à mão; resultado confirmado no caixa; atalhos para quem opera.
- **Perde:** "Sua equipe" é padrão novo (vira o template t11 da skill); exige frescor em cada número desde o início.

### C · Inovador — "Conversa com a LIA" (base: t09 + t10, com interface gerada)

```text
┌──────────────────────────────────────────────────────────┐
│ LIAME                                     Casa Brasa ▾   │
│  LIA: Bom dia! 4 pontos hoje. O mais urgente…            │
│  ┌─────────── cartão gerado ───────────┐                 │
│  │ Trocar criativo "Combo Brasa"       │                 │
│  │ [Aprovar]  [Ver detalhes]           │                 │
│  └─────────────────────────────────────┘                 │
│  Você: e o delivery noite?                               │
│  ┌─── gráfico gerado: CPA 14 dias ───┐                   │
│  ┌──────────────────────────────────────────────┐        │
│  │ Peça algo à LIA…                         ➤   │        │
│  └──────────────────────────────────────────────┘        │
│        ( Atenção · Aprovações · Resultados )  dock       │
└──────────────────────────────────────────────────────────┘
```

- **Ganha:** esforço mínimo para o dono; impressiona na primeira vista.
- **Perde:** ruim para quem opera o dia todo; difícil comparar e auditar; cada tela custa uma chamada de IA; o próprio mercado recuou (o ChatGPT Canvas saiu em 05/2026).

### Recomendação: B, com dois toques do C

Sinais do briefing: o dono decide e o gestor opera (modos Lite e Pro), chega coisa e alguém decide (t03), uso diário com atalho (t04), ver tudo de uma vez (t05) e agentes com passos visíveis (família 2.18). Do C entram só **a LIA sempre à mão**, respondendo com cartões de ação, e **a equipe ao vivo**.

## 4. O que o protótipo tem

| Tela | O que mostra |
| --- | --- |
| **Resumo** (página inicial do Lite) | Visão do dono: vendas que vieram do marketing, gasto com anúncios e quanto sobrou (com a comparação com a semana anterior), um veredito em uma frase, "Precisa de você" em linguagem de negócio, "Pergunte à LIA", clientes (novos, que voltaram, ticket médio), de onde vieram os pedidos e quanto sobrou por canal, orçamento do mês com previsão, o que a equipe fez na semana e o convite para alguém de confiança administrar. |
| **Atenção** (página inicial do Pro) | Herói com o valor em risco por dia; 4 cartões de decisão (severidade, dinheiro, evidências, minigráfico de 14 dias, quem propõe, frescor da fonte); ciclo fechado (investimento → cliques → conversas → pedidos → receita → margem) e ROAS da plataforma × confirmado no caixa; equipe agora; próximos dias. |
| **Aprovações** | Lista (precisa de você · feito sozinho dentro dos limites · decididas hoje) e detalhe: por quê em números, minigráfico, ajuste antes de aprovar (muda versão e hash), antes e depois, risco e limite da política, como desfazer, prazo. Aprovar, recusar com motivo, pedir nova análise. Atalhos J, K e A. Estado vazio "Tudo em dia". |
| **Sua equipe** | 9 funcionários contratados e 5 disponíveis. Detalhe: status, modo, passo a passo ao vivo com ferramentas usadas, "Corrigir o rumo", prontidão para agir sozinho (medidor com portão em 80 e sinais), limites por ação, decisões recentes. Pausar um funcionário ou a equipe inteira, com desfazer. |
| **Resultados** | ROAS confirmado no caixa (2,6) contra o da plataforma (3,8); de onde vêm os números e quando atualizaram; ciclo fechado; tabela por campanha com halteres plataforma × caixa. Período hoje, 7 e 30 dias (o gráfico segura o quadro anterior esmaecido enquanto recalcula). |
| **LIA** | Painel ao lado (≥1280 px), por cima (769–1279 px) ou tela cheia (celular). Respostas com cartões de ação de no máximo 2 botões; sugestões; aviso de que é IA. |
| **Paleta (Ctrl K)** | Ir para telas, ações (pausar anúncio, modo, tema, parar a equipe), funcionários, campanhas e "Perguntar à LIA". |
| **Modos Lite e Pro** | Seletor no topo (e na gaveta do celular). Lite = visão do dono; Pro = recursos completos da LIA; detalhes na §4.1. |
| **Pessoas e acessos** | Quem tem acesso (dono, administradora de agência, aprovador) e convites pendentes; convidar por e-mail com nível, limite de gasto, dupla aprovação, cobrança e data de fim; alterar; remover com confirmação na própria linha; o que cada nível pode fazer; como o acesso fica protegido (ADR-017). |
| **Demais telas** | Agenda, Minha marca, Contas conectadas e as 9 ferramentas aparecem como "tela em desenho", com a fase do roadmap. |

**Ao vivo:** a rodada do Gestor de tráfego avança sozinha e, ao terminar, cria uma proposta nova (aviso na tela, cartão da home e contador do menu mudam).

### 4.1 Lite × Pro, tela por tela

| Onde | Lite (padrão do dono) | Pro |
| --- | --- | --- |
| Menu | Resumo + 8 itens + "Mais ferramentas" recolhido | Atenção + 8 itens + todas as ferramentas abertas |
| Página inicial | **Resumo**: as perguntas de um dono de empresa, sem jargão | **Atenção**: decisões com evidência, minigráficos e o fio do ciclo fechado |
| LIA | sugestões de dono ("O que devo fazer hoje?", "Como estão meus clientes?") | sugestões de quem opera ("Compare Meta e Google", "Monte a pauta da semana") |
| Atenção | cada ponto em uma frase simples + **Explicar**; ciclo fechado em 3 números (investiu → vendeu → sobrou depois dos anúncios) | evidências, minigráficos, fio de 6 etapas, ROAS da plataforma × caixa |
| Aprovações | o que muda em uma frase, risco, "dá para desfazer", prazo, **Explicar** e **E se eu recusar?**; **Ver detalhes** abre o resto ali mesmo | por quê em números, minigráfico, ajuste, antes e depois, política, versão e hash |
| Sua equipe | o passo atual com barra de progresso, "Já pode agir sozinho?" em uma frase, o que faz sem perguntar | passo a passo completo, corrigir o rumo, medidor com sinais, tabela de limites, histórico |
| Resultados | "para cada R$ 1 voltaram R$ 2,60", 3 números e cada campanha com **Dá lucro / Empata / Dá prejuízo** | fontes e horários, fio completo, tabela com halteres plataforma × caixa |

- **Botões da LIA (Explicar, O que é isso?, Por quê?):** abrem a LIA com a pergunta pronta; a resposta traz em linguagem simples os números e motivos que o Lite escondeu, com até 2 ações (abrir a aprovação, ver no Pro). A LIA nunca aprova gasto pelo chat.
- **Nada some:** tudo o que existe no Pro existe no Lite, um clique adiante.
- **Modo é preferência, não permissão** (ADR-013).

**Responsivo:** barra lateral (≥1025 px), trilho só de ícones com dicas (769–1024 px), gaveta e barra inferior flutuante com a LIA no centro (≤768 px). Cartões e painéis usam container queries, então se ajustam quando a LIA abre ao lado.

## 5. Movimento (leve, e desliga com `prefers-reduced-motion`)

| Efeito | Onde | Técnica | Duração |
| --- | --- | --- | --- |
| Troca de tela | conteúdo | View Transitions (nome `conteudo`) | 0,16 s saindo + 0,34 s entrando |
| Marcador do menu viaja até o item | barra lateral | transição nomeada `nav-no`, com mola | 0,42 s |
| Título do cartão vira o título do plano | Atenção → Aprovações | morph por nome (`plano-foco`) | 0,46 s |
| Lista se reorganiza ao aprovar | Aprovações | cada item com nome próprio | 0,25 s |
| Tema claro e escuro | app inteiro | revelação em círculo a partir do botão | 0,56 s |
| Paleta de comandos | diálogo | `@starting-style` + `allow-discrete` | 0,22 s |
| Entrada da tela | cartões | escalonada, 55 ms por item | 0,5 s |
| Números | herói, fio, prontidão | contagem até o valor | 0,72 s |
| Fio do ciclo fechado | Atenção e Resultados | ligações desenham da esquerda para a direita, nós aparecem com mola | até 1,3 s |
| Prontidão | funcionário | barra enche até o valor | 1 s |
| Sinais de vida | LIA e equipe | pulso no ícone da LIA, varredura em quem trabalha, "digitando…" | contínuo e sutil |
| Rede do topo | herói | pulsos correndo nas ligações | 3,6 s em ciclo |
| Aprovar | botão | check com mola e botão verde | 0,45 s |

## 6. Marca e tokens

**Protótipo → tokens semânticos do projeto** (`decisoes-design.md` §2). No port, valem os nomes do projeto.

| Protótipo | Projeto | Claro | Escuro |
| --- | --- | --- | --- |
| `--bg` | `surface` | Papel `#F4F2EC` | Noite `#0B0D17` |
| `--surface` | `surface-elevated` | `#FFFFFF` | card `#151A2E` |
| `--bg-subtle` | `surface-sunken` | `#ECE9E1` | `#10131F` |
| `--text` | `text-primary` | `#0B0D17` | `#F4F2EC` |
| `--text-muted` | `text-secondary` | `#4A5068` | Cinza `#9AA0B4` |
| `--text-subtle` | `text-muted` | `#646A80` | `#878EAB` |
| `--border` · `--border-strong` | `border-subtle` · `border-strong` | `#E5E1D7` · `#D0CBBF` | `#262C49` · `#3A4166` |
| `--primary` · `--primary-fg` | `action` · `action-contrast` | Ciano `#2DD4DE` · Noite | igual |
| `--foco` | `focus-ring` | `#008796` | Ciano `#2DD4DE` |
| `--success` · `--warning` · `--danger` | iguais | `#0C6F5B` · `#8A5F00` · `#B42F2F` | `#46BC9F` · Âmbar `#FFC24B` · Coral `#FF6B6B` |
| `.ponto` · `.ponto--atraso` | `freshness-fresh` · `freshness-stale` | cor de `success` · `warning` | igual |

**Tokens novos propostos** (não existem na lista do projeto): `ai` / `ai-soft` / `ai-fill` (Violeta IA para LIA, funcionários e prontidão), `link` (`#0A6C75` claro, Ciano escuro), `fio` (ligações e indicadores: `#009AAA` claro, Ciano escuro) e `chart-foco` / `chart-contexto` / `chart-grade` (paleta validada com a skill dataviz: `#009AAA` claro, `#16A0AF` escuro, cinza de contexto `#7E8499` claro e `#7C83A3` escuro).

**Ajustes de contraste** (medidos no navegador, AA para texto):

- Verde de sucesso no claro `#0E7C66` → `#0C6F5B`: 4,47 → 5,31 sobre o fundo suave.
- Vermelho no claro `#C23B3B` → `#B42F2F`: 4,36 → 5,12 sobre o fundo suave.
- Cinza sutil no escuro `#7F86A3` → `#878EAB`: 4,47 → 4,96 sobre o fundo dos blocos.
- Link no claro: o `#0E7C86` citado em `decisoes-design.md` §2 dá 4,42 sobre o Papel; o protótipo usa `#0A6C75` (6,15 sobre branco).
- Foco no claro: o Ciano dá 1,6:1 e não aparece; o anel usa `#008796` (3,82 sobre o Papel).
- Petróleo da marca `#1BA8B8` reprovou como cor de gráfico (faixa de luminosidade e contraste); entram `#009AAA` e `#16A0AF`.

**Tipografia:** Poppins 700 no título da tela, 500 e 400 no resto, como no kit; **600 em título de cartão e números** (proposta, o kit não lista 600). JetBrains Mono em rótulos (caixa alta, espaçamento largo), horários, hash e colunas numéricas.

## 7. Como portar para a stack (Next 16.3, React 19.3, Tailwind 4.3)

1. **Tokens:** valores da §6 no `globals.css`, com `@theme inline` e a variante `dark` por `data-theme` (base de conhecimento §15). Nenhuma cor crua em componente.
2. **Shell:** `Sidebar` (barra, trilho e gaveta), `Topbar`, `LiaPanel`, `CommandPalette` (`<dialog>`), `BottomBar` e `Toast` como componentes de cliente; as telas continuam em componentes de servidor.
3. **Transições:** `<ViewTransition name="conteudo">` em volta do conteúdo no layout; morph cartão → plano e marcador do menu **por nome** (no App Router do Next 16 o modo por classe não dispara — issue #37614); tema com `document.startViewTransition` no botão.
4. **Container queries:** utilitários `@container` do Tailwind 4 na página e no fio do ciclo fechado.
5. **Camadas:** `inert` no restante da tela com a gaveta ou a LIA em tela cheia; foco volta a quem abriu.
6. **Dados de cada cartão de decisão:** severidade, dinheiro em jogo, título, evidências, série de 14 dias, funcionário, `plan_id`, versão, hash e frescor de cada fonte.
7. **Permissões:** Lite/Pro é preferência de exibição salva por usuário; quem pode ver e fazer é decidido no servidor (ADR-013).

## 8. Divergências e propostas para decidir

1. **Lite é a visão do dono, com página inicial própria (Resumo);** o Pro, com os recursos completos da LIA, começa em Atenção. **Pessoas e acessos** fica no menu principal nos dois modos.
2. **Lite e Pro substituem Agência e Gestor.** O Lite tem todos os recursos (pedido do dono), então não sobra o que o modo agência escondia. "Sua equipe" fica no menu principal nos dois modos, porque é o que materializa a agência.
3. **Peso 600** da Poppins em título de cartão e números.
4. **Ajustes de contraste** e **tokens novos** da §6.
5. **Editar antes de aprovar** aparece como ajuste de valor (redução da verba de 5% a 20%); editar texto ou peça fica para as fases de criativos.
6. **A home não tem filtro de período:** Atenção é o agora; o período fica em Resultados, onde filtra tudo o que está abaixo dele.
7. **Barra inferior do celular:** Resumo (ou Atenção, no Pro), Aprovações, LIA no centro, Resultados e Menu.
8. **Template novo na skill** `ui-ux-proprio`: `t11-central-agentes`, a partir da tela Sua equipe, depois da aprovação.

## 9. Verificação feita

Script próprio com o mesmo método do `catalogo.mjs verificar` da skill (Chrome sem janela, largura emulada):

- 1440, 1280, 1024, 768 e 375 px, claro e escuro, mais movimento reduzido.
- 24 cenários (aprovações, plano pelo cartão, aprovar, equipe, funcionário, resultados, LIA, paleta, modo Pro, mais ferramentas, Explicar, Ver detalhes, plano, funcionário e resultados no Pro, dica do trilho, gaveta, estado vazio, Resumo, Pessoas e acessos, convite enviado, diálogo aberto, e-mail inválido, remover acesso) e 5 roteiros (tema, ajuste que muda o hash, rodada ao vivo que cria proposta, período de 30 dias, foco da LIA no celular).
- Checagens: rolagem horizontal da página e dentro dos contêineres, elemento fora da tela, nome acessível, IDs duplicados, contraste AA calculado e erros de console.
- Resultado em 25/09/2026: **nenhum problema**, depois de corrigir 8 achados (rede decorativa passando da margem em 768 px, contraste do cinza sutil no escuro, seletor de período sem estilo, marcadores esticados na lista de fontes, busca achatada no trilho, texto cortado na busca, topo apertado com a LIA aberta em 1280 px e contorno no título focado).
