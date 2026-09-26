# ADR-015 — Vigia de integrações: funcionário da distribuição que acompanha mudanças de APIs e MCPs

- **Status:** Aceito · 26/09/2026 (proposto em 25/09/2026; aprovado com o plano completo pelo dono)
- **Base:** base de conhecimento §2, §3, §8 e §17.3 · `arquitetura.md` §6 (Capability Registry)

## Contexto

As plataformas mudam em ritmos diferentes:

- a Meta lança 3 a 4 versões da Graph API por ano e expira as antigas;
- o Google Ads passou a ter versão mensal, com vida de cerca de 12 meses;
- o LinkedIn publica versão mensal;
- o MCP muda por especificação datada.

Na pesquisa de 25/09/2026, fontes secundárias já davam datas de versões da Meta diferentes das oficiais (base §2.1). O Capability Registry tem `deprecated_at` e `verified_at`, mas ninguém preenche esses campos sozinho.

## Decisão

Criar o **Vigia de integrações**, um funcionário **da distribuição**: não aparece para o cliente e não é contratável.

1. **Só fontes oficiais:**
   - changelogs e páginas de versão (Meta Graph, Marketing e WhatsApp; Google Ads e Data Manager; GA4; TikTok; LinkedIn; especificação MCP);
   - releases de SDKs no npm e de servidores MCP no GitHub;
   - cabeçalhos **`Deprecation` (RFC 9745)** e **`Sunset` (RFC 8594)** e avisos que as próprias APIs devolvem nas chamadas do dia a dia.
2. **Rotina diária (pg-boss):** baixa as fontes e compara com a versão anterior, por trecho (hash). Se algo mudou, o agente resume num registro estruturado: plataforma, o que muda, data de vigência, fonte e confiança.
3. **Cruza com o que usamos:** o Capability Registry diz a versão de API, as permissões e as métricas de cada connector. Só vira alerta o que afeta algo nosso.
4. **Agenda com data:** para cada mudança com validade, cria tarefas no console da distribuição:
   - **na data** e **depois dela (D+1 e D+7)**, para conferir se aconteceu mesmo e se algo quebrou;
   - alertas 60, 30 e 7 dias antes de uma versão expirar.
5. **Propõe, não muda:** abre a tarefa e propõe a atualização da base de conhecimento e do Capability Registry. Quando der, prepara um rascunho de mudança no connector para revisão humana. Nunca altera código nem produção sozinho.
6. **Conteúdo lido é não confiável** (quarentena, `ai-architecture.md` §6): o texto de uma página nunca vira instrução.
7. **O cliente só vê o efeito:** se uma mudança exigir ação dele (por exemplo, reconectar a conta por causa de uma permissão nova), a LIA avisa com antecedência, em linguagem simples.

## Consequências

- Custo baixo: algumas dezenas de páginas por dia. Evita parar o cliente por versão expirada.
- A regra da base de conhecimento ("fato com mais de 90 dias reconfere") ganha apoio automático.
- Entra na **A2**, junto com os primeiros connectors. O calendário de versões nasce na A1.
