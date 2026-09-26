# ADR-016 — Modelos de IA por finalidade, com escolha do cliente dentro de um catálogo curado

- **Status:** Proposto · 25/09/2026
- **Base:** base de conhecimento §10 e §17.4 · ADR-006 (AI Gateway) · `ai-architecture.md` §3

## Contexto

Pedido do dono (25/09/2026): poder escolher o modelo de IA para criação de imagens e mídias, para conversa e atendimento, e para análises.

O AI Gateway já é independente de fornecedor, com rota por tarefa escolhida por eval (ADR-006). Mas a escolha era só nossa, e só de texto.

Fatos de 25/09/2026:

- no AI SDK, `generateImage` é estável e `experimental_generateVideo` é experimental, com provedores como Google (Veo 3.1), Kling, xAI, Black Forest Labs e fal;
- o mercado de imagem se dividiu em especialistas (fotorrealismo, texto dentro da arte, estilo), com preços de cerca de US$ 0,02 a 0,24 por imagem.

## Decisão

### Finalidades (perfis de modelo)

| Finalidade | Exemplos | Critério do padrão |
| --- | --- | --- |
| Conversa e atendimento | LIA, respostas, briefing | rapidez e custo, com qualidade medida |
| Análise e decisão | planos, diagnósticos, revisão semanal | melhor nota no eval de decisão |
| Texto criativo | legendas, anúncios, roteiros | melhor nota no eval de marca |
| Imagem | artes, variações, fundo de produto | por especialidade (foto, texto na arte) |
| Vídeo curto | reels e anúncios de 6 a 15 s | só quando o provedor sair do experimental |
| Voz | locução de vídeo | fase posterior |

### Quem escolhe

- **Catálogo curado pela distribuição.** Um modelo só entra numa finalidade depois de passar no eval dela, com contrato de dados conhecido (sem treino com dados do cliente; transferência internacional coberta pela LGPD), preço e limite de uso.
- **Lite:** "Automático (recomendado)". O cliente não precisa saber nome de modelo.
- **Pro:** escolhe por finalidade dentro do catálogo, vendo custo estimado, velocidade e nota de qualidade. A troca é auditada e pode ser desfeita.
- **Sem chave própria do cliente (BYOK) por enquanto:** o cliente teria de manusear segredo, o que a regra de distribuição proíbe. Reavaliar só para plano empresarial, com a chave guardada no cofre da distribuição.
- Todo custo vai para o AI Usage Ledger, com teto por plano. Se o modelo escolhido cair, entra o próximo aprovado da mesma finalidade.

### Mídia gerada

- Passa pelo Compliance antes de ir ao ar.
- Leva credencial de conteúdo ou marca d'água (C2PA, SynthID) quando o provedor oferecer, e rótulo de conteúdo feito com IA onde a plataforma ou a lei exigir (base §6).
- Rosto de pessoa real só com autorização. Conteúdo político fica bloqueado por padrão.

## Consequências

- Mais um eixo nos evals (finalidade × modelo) e nos preços dos planos.
- Imagem entra com o Criativo (A4). Vídeo só com provedor estável (A6).
