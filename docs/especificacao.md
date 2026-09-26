# Liame — Especificação do produto

> Status: **aprovado pelo dono em 26/09/2026** (proposta de 24/09/2026) · nome **Liame** ("Todas as mídias. Uma inteligência."), assistente **LIA**, domínio **agencialiame.com**; marca por configuração (white-label pronto).
> Fontes da verdade, em ordem: este arquivo → `decisoes-design.md` → `arquitetura.md` e demais docs → ADRs → mockups (quando existirem).

## 1. Definição

> **Uma plataforma operacional multi-tenant de crescimento e marketing, orientada a dados e eventos, capaz de conectar mídia, mensageria, catálogo, clientes e vendas reais; expor capacidades para humanos, APIs, automações e agentes; e permitir que IA analise e execute ações sob políticas determinísticas, limites financeiros, aprovação, auditoria e avaliação contínua.**

O Liame **não é** "um painel com vários bots de marketing".

### Duas camadas, uma coisa só

| Camada | O que é | Quem vê |
| --- | --- | --- |
| **Experiência: a agência** | Quem contrata tem uma agência de marketing completa. **Cada agente de IA, com suas responsabilidades, é um funcionário** (Atendimento, Estrategista, Gestor de tráfego, Criativo…). O cliente conversa, aprova e recebe o resultado. | O cliente |
| **Arquitetura: a plataforma** | Motores de análise e execução, workflows, Tool Registry, Policy Engine, Action Service, connectors, dados temporais e atribuição. | A DMS (distribuição) |

Um funcionário é uma **definição de agente** (cargo, responsabilidades, skills, ferramentas permitidas, políticas, autonomia, rotas de modelo, workflows, KPIs), executada pelos motores compartilhados. Nenhum funcionário acessa banco ou API externa: tudo passa por ferramenta → política → serviço de domínio → Action Service → connector.

## 2. Tese e fosso competitivo

Otimizar dentro de uma plataforma de anúncios virou commodity: Meta, Google, TikTok e iFood fazem isso de graça. O fosso do Liame é **o dado do ciclo fechado**:

```text
CAMPANHA → ANÚNCIO → CLIQUE → WHATSAPP / LANDING / CARDÁPIO → CLIENTE → PEDIDO → ITEM → RECEITA → MARGEM → ATRIBUIÇÃO → OTIMIZAÇÃO
```

A pergunta que o produto responde não é "qual campanha teve melhor ROAS segundo a Meta?". É:

> **"Qual campanha realmente trouxe pedidos, receita e margem confirmados no sistema operacional do cliente?"**

Só quem tem o sistema de venda (Regem: cardápio, PDV, pedidos, ficha técnica) consegue responder isso fora de um marketplace.

## 3. Quem usa

| Persona | Precisa de | Modo de interface |
| --- | --- | --- |
| Dono de PME ou restaurante | Resultado com mínimo esforço | **Lite** (padrão) |
| Gestor de tráfego ou agência | Operar várias marcas; relatório ao cliente | **Pro** |
| Franquia ou rede | Verba por unidade, aprovação central | Pro + hierarquia |
| Administrador convidado (agência, consultor, gerente) | Cuidar da conta pelo dono, dentro dos limites que ele der | Pro, com acesso delegado por e-mail (ADR-017) |
| Parceiro ou integrador | API, webhooks, MCP | API `/v1` e `/mcp/liame` |
| DMS (distribuição) | Operar a plataforma, apps, políticas, releases | Console da distribuição (separado) |

**Base de testes:** um restaurante em plena operação, com estrutura real (D1).

## 4. Funcionários (cada agente = um funcionário)

O número **não é fixo**. Cada funcionário tem cargo, responsabilidades, ferramentas e limites próprios, e é **ativado por plano e por marca**, como quem contrata alguém para a agência. Catálogo inicial, tirado das 49 skills de marketing, ampliável a qualquer momento:

| Funcionário | Responsabilidades | Natureza | Entra em |
| --- | --- | --- | --- |
| **Atendimento (LIA)** | A LIA ("LIA · by Liame") é a cara da agência. Único que conversa com o cliente: briefing, pedidos (vira job), aprovações, apresentação de resultados, avisos | Agente (conversa) + workflows | A3 |
| **Estrategista** | Plano de 90 dias, orçamento por canal, ofertas, calendário comercial, lançamentos, pauta semanal | Agente (planejamento) | A3 |
| **Pesquisador de mercado** | Voz do cliente, personas, concorrentes, tendências | Agente (pesquisa) com leitor em quarentena | A3 |
| **Analista de dados** | Rastreamento, atribuição, anomalias, métricas (números sempre por código) | Workflows + agente para diagnóstico | A3 |
| **Relatórios** | Revisão semanal, relatório mensal, relatório para o cliente | Workflow com um passo de IA | A3 |
| **Compliance** (controle de qualidade) | Marca, specs, LGPD, CONAR, políticas das plataformas, conteúdo político | **Policy Engine determinístico** + revisor de IA | A3 |
| **Gestor de tráfego** | Opera Meta, Google e TikTok: estrutura, pausa, escala, testes, termos de busca | Agente que só propõe Action Requests | A4 |
| **Criativo** | Textos, artes, vídeos curtos, variações a partir dos vencedores | Agente (geração) | A4 |
| **CRM e mensageria** | Réguas de WhatsApp (RegemCast), e-mail e SMS; consentimento | Workflows + agente | A5 |
| **Social media** | Calendário, publicação orgânica, comunidade, PR | Agente + workflows | A6 |
| **CRO / landing pages** | Páginas, formulários, funil | Agente | A8 |
| **SEO / AI-SEO** | SEO técnico, schema, presença em respostas de IA | Agente + workflows | A8 |
| **Experimentos** | Backlog ICE, testes A/B, análise estatística (por código) | Workflows + agente | A8 |
| **SDR / prospecção** | Listas com fonte, cold e-mail, pontuação de leads | Agente | A8 |

- **Reunião de decisão:** em decisões grandes, os funcionários envolvidos fazem uma reunião interna (arquétipos com uma voz contrária). O Atendimento leva ao cliente a recomendação e o risco. Não é um funcionário: é um ritual.
- **Transparência:** os funcionários se apresentam como **assistentes de IA** (nome configurável), com caminho para uma pessoa da DMS.
- **Funcionários da distribuição** (não contratáveis, não aparecem para o cliente): **Vigia de integrações**, que acompanha mudanças nas APIs e MCPs das plataformas e agenda as atualizações (ADR-015).
- **Por dentro:** a definição de cada funcionário vive no **Agent Registry** (versionado, com eval próprio). Ele só usa as ferramentas do Tool Registry que a definição permite, sob as políticas e os modos de autonomia (`ai-architecture.md` §1).

## 5. Princípios de produto

1. **Orientado a decisões, não a números** (§48 das diretrizes). A home responde: *o que precisa da minha atenção, por quê, quanto dinheiro está envolvido, qual ação é recomendada e qual evidência sustenta a recomendação.*
2. **Approval Inbox** única: agente, ação, motivo, evidência, antes e depois, risco, impacto financeiro, prazo e `plan_id`. Opções: aprovar, editar, rejeitar, pedir nova análise. Plano mudou → aprovação antiga cai.
3. **Explicação obrigatória** em toda recomendação: motivos com números, risco e impacto estimado. Nunca "a IA decidiu".
4. **IA não é fonte de verdade financeira.** ROAS, CPA, CAC, LTV, margem e uso de orçamento são calculados por código. A IA interpreta.
5. **Funciona sem IA.** Com todos os provedores de LLM fora do ar: ver campanhas e métricas, aprovar, editar, publicar ações manuais, gerar relatórios determinísticos, acessar auditoria.
6. **Freshness visível.** Dado velho aparece como "Dados desatualizados · última sincronização 09:42". Ninguém inventa número.
7. **Humano pode anular tudo**, e o override vira aprendizado governado (nunca automático).
8. **Minimalista por padrão, profundo quando pedem.** Dois modos de exibição: **Lite**, a **visão do dono**, organizada pelas perguntas de negócio (quanto vendi, quanto sobrou, o que precisa de mim, como estão meus clientes, de onde vieram os pedidos, o que a equipe fez, como está o orçamento), com botões da LIA que explicam e completam; e **Pro**, com os **recursos completos da LIA** (decisões com evidência, aprovações detalhadas, equipe passo a passo, tabelas e todas as ferramentas). Nada some no Lite: o resto está a um clique. Modo é preferência, não permissão. **Ctrl+K** para buscar e agir.
9. **Mínimo esforço de quem contrata**, tratado como métrica.
10. **Transparência de IA** no produto e nas mensagens.

## 6. Menu

| Item | Para que serve | Lite | Pro |
| --- | --- | --- | --- |
| **Resumo** (página inicial do Lite) | Visão do dono: dinheiro, decisões, clientes, canais, orçamento e o que a equipe fez | menu principal | — |
| **Atenção** (página inicial do Pro) | Oportunidades e problemas priorizados por dinheiro envolvido, com evidência | pelo Ctrl+K | menu principal |
| **Conversa** | Falar com o Atendimento (LIA) | menu principal | menu principal |
| **Aprovações** | Approval Inbox | menu principal | menu principal |
| **Resultados** | Ciclo fechado; revisão semanal e mensal | menu principal | menu principal |
| **Sua equipe** (funcionários) | Quem está fazendo o quê, prontidão, limites, histórico | menu principal | menu principal |
| **Agenda** | O que vai ao ar e quando | menu principal | menu principal |
| **Minha marca** | Dossiê estruturado, arquivos, identidade | menu principal | menu principal |
| **Contas conectadas** | OAuth; saúde e freshness de cada conexão | menu principal | menu principal |
| **Pessoas e acessos** | Convidar por e-mail quem administra pelo dono, níveis, limites de gasto, remover acesso (ADR-017) | menu principal | menu principal |
| Jobs · Campanhas · Criativos · Social · Mensageria · Públicos · Experimentos · Auditoria · Configurações | Operação detalhada | em "Mais ferramentas", resumido | abertos, completos |

**Lite é a visão do dono; Pro são os recursos completos da LIA.** O Lite começa no **Resumo**, que responde às perguntas de um dono de empresa sem jargão, e tem botões que chamam a LIA para explicar e completar (os números e o motivo por trás de cada ponto); "Ver detalhes" abre o Pro dentro do próprio bloco. O Pro começa em **Atenção** e mostra tudo de uma vez. O dono começa no Lite e troca quando quiser; o que cada pessoa pode ver e fazer continua decidido no servidor (ADR-013).

O menu é configurável por perfil.

### 6.1 Acesso delegado (ADR-017)

Como nas contas do Google, o dono convida por e-mail quem vai cuidar da conta por ele (agência, consultor, gerente). A pessoa entra com o próprio login e app autenticador, no nível escolhido (Administrador, Gestor, Aprovador, Somente leitura ou Só relatórios por e-mail), com limite de gasto por ação: acima dele, o dono também aprova. O dono remove o acesso na hora, recebe o resumo semanal do que cada um fez e continua sendo o único que transfere a propriedade, muda a cobrança ou exclui a conta. Quem cuida de várias empresas troca entre elas num só login. Os módulos ligam e desligam por plano, marca e **feature flag**.

## 7. Critério de sucesso do MVP

O MVP só é sucesso quando prova **uma cadeia real completa** no restaurante de testes:

```text
campanha → clique → WhatsApp/cardápio → pedido → receita (→ margem quando houver custo)
```

E mostra lado a lado:

| Investimento | Conversas | Pedidos confirmados | Receita | Margem | ROAS plataforma | ROAS confirmado no caixa |
| --- | --- | --- | --- | --- | --- | --- |
"Meta e Google aparecem num dashboard" **não** é critério de sucesso.

## 8. KPIs do produto (medidos desde a A1/A2)

| Grupo | KPIs |
| --- | --- |
| Conexão e dados | tempo para conectar conta · data freshness · sync success |
| Ciclo fechado | % de pedidos atribuídos · atribuição confirmada × plataforma |
| Decisão | recommendation acceptance · human/AI agreement · policy block rate · action success · **action regret** |
| Custo | custo de IA por tenant · custo de IA / receita gerida |
| Valor | tempo economizado · melhora de ROAS confirmado · melhora de margem |
| Esforço do cliente | minutos por semana · perguntas feitas ao cliente · retrabalho |

## 9. Fora do escopo agora

Kubernetes, Kafka, microsserviços, A2A, event sourcing completo, GraphQL, vector DB separado, swarm multiagente, autonomia total, blockchain, fine-tuning, marketplace de policies (a arquitetura só não pode impedir).

## 10. Decisões registradas

D1–D7 e as revisões desta especificação estão em `decisoes-design.md`.
