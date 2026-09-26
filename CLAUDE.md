# Liame — Regras do projeto

> Leia este arquivo inteiro antes de qualquer tarefa. **Estado atual:** plano completo aprovado pelo dono em 26/09/2026 (ADR-001 a 017 aceitos). A0 com os itens externos pendentes (AWS, plataformas, restaurante, Supabase, publicação dos termos); A1 em andamento pelo `docs/plano-a1.md`. Andamento em `docs/andamento.md`.

## 1. Base de conhecimento do nicho: consulta obrigatória

`docs/base-conhecimento.md` reúne as informações mais atuais do nicho: plataformas (Meta, Google, TikTok…), mercado e concorrentes, regulação brasileira (LGPD, CONAR, TSE, CDC), regras de decisão de marketing, padrões técnicos (MCP, APIs, segurança de agentes), stack verificada, modelos de IA e o estado dos produtos DMS.

**Regra:**

1. **Antes** de especificar, escrever copy ou política, criar ou alterar um connector, ou programar qualquer coisa que dependa de plataforma externa, regra de mercado, lei ou padrão técnico: **consultar a seção correspondente** da base e citá-la na resposta (ex.: "ver base §2.1").
2. **Validade:** fato com mais de **90 dias**, ou marcado **[S]** ou **[NC]**, deve ser **reconferido na fonte oficial** antes de virar código. A fonte que nega algo precisa ser tão nova quanto a pergunta (LIC-021).
3. **Toda pesquisa nova atualiza a base no mesmo trabalho:** fato + data + fonte + confiança [O]/[S]/[NC], e uma linha no histórico (§12). Não apagar fato antigo sem registrar o que o substituiu.
4. Se a base e a documentação oficial atual divergirem, **vale a documentação oficial**. Corrija a base e registre a mudança.
5. Decisão arquitetural nova ou alterada vai para um ADR em `docs/adr/`. A base registra fatos; os ADRs registram decisões.

## 2. Fontes da verdade (em ordem)

1. `docs/especificacao.md`
2. `docs/decisoes-design.md` (decisões D1–D11 e changelog)
3. `docs/adr/` (decisões técnicas)
4. `docs/arquitetura.md`, `docs/ai-architecture.md`, `docs/data-model.md`, `docs/security-model.md`, `docs/integrations.md`, `docs/roadmap.md`
5. `docs/base-conhecimento.md` (fatos do nicho, com validade)
6. `mockups/`, quando existirem (sem mockup aprovado, não se inventa tela)
7. `docs/ux-modelo-interface.md` (modelo de interface Lite e Pro, aprovado em 26/09/2026)
8. `lia-agente-3d/` (kit da LIA em 3D: personagem, expressões e visuais; referência de identidade, com uso no app pelas regras de `ux-modelo-interface.md` §6.1)

## 3. Princípios que não se perdem

RLS desde a primeira migration · guard global fail-closed · API-first com OpenAPI 3.1 · idempotência · outbox · pg-boss · webhooks assinados · Action Service como única porta de escrita externa · Policy Engine determinístico (a IA assessora, o código decide) · ledger de orçamento · aprovação amarrada ao hash do plano · sombra real + readiness · kill switch · auditoria append-only com âncora externa · evals como portão · isolamento de conteúdo não confiável · isolamento de tenant · segredos cifrados com chave fora do banco · MCP sem estado, só para fora, com ferramentas curadas e tokens curtos · IA nunca é fonte de verdade financeira · o produto funciona sem IA.

**Não introduzir sem necessidade comprovada:** Kubernetes, Kafka, microsserviços, A2A, event sourcing completo, GraphQL, vector DB separado, swarm multiagente, autonomia total, blockchain, fine-tuning.

## 4. Registro de erros (`errei`)

Antes de alterar código ou usar um recurso: consultar `ERROS-CONHECIDOS.md` (na raiz, fora do git; verificação rápida V1–V15) e `~/.claude/errei/REGISTRO-GERAL.md`. Erro novo reproduzido → registrar `ERR-NNN` no mesmo trabalho da correção; se valer para qualquer projeto, promover a `LIC-NNN`.

## 5. Idioma e estilo

pt-BR, sentence case, voz ativa. Tokens semânticos no front (nada de cor crua). Responsivo e acessível por padrão.

## 6. Empresa

O Liame é prestado pela **SISTER TECNOLOGIA LTDA** (marca DMS Tecnologias; nome fantasia SISTER SOFTWARE E SOLUCOES), CNPJ 67.748.508/0001-43, Rio de Janeiro/RJ. Apps de plataformas, contratos e documentos jurídicos vão no nome dela. Documentos jurídicos em `docs/juridico/`.

## 7. Código

- **Tudo ESM** (`"type": "module"`), apps e pacotes (ADR-001, ERR-001). Imports relativos com `.js`; `import.meta.dirname`; sem import circular entre módulos.
- Identificadores de código em inglês (módulos do ADR-002, tabelas do `data-model.md`); comentários, mensagens e interface em pt-BR.
- Versões só pelo catálogo do `pnpm-workspace.yaml`, fixadas e com mais de 1 dia. Script de instalação novo passa por revisão no `allowBuilds`.
- Pronto = `pnpm build`, `pnpm typecheck` e `pnpm test` verdes.
