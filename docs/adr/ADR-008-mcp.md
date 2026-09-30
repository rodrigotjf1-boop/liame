# ADR-008 — MCP só para fora, pelo Tool Registry

- **Status:** Aceito · 26/09/2026 (proposto em 24/09/2026; aprovado com o plano completo pelo dono)
- **Decide:** papel do Model Context Protocol no Liame e na MCP central da DMS

## Contexto

A especificação MCP atual é a **2026-07-28**: sem estado, sem handshake `initialize` e sem sessão; `server/discover`; MRTR no lugar de pedidos iniciados pelo servidor; DCR deprecado em favor de CIMD; Tasks e MCP Apps como extensões. O SDK TypeScript oficial está na **v2** (`@modelcontextprotocol/server` 2.1.0, verificado no npm em 24/09/2026). Existe `@rekog/mcp-nest` 2.0.7 com suporte a Nest 12. O plano mestre desenhou os agentes internos do Liame como clientes do hub MCP, o que está errado.

## Decisão

1. **MCP não é barramento interno.** Agentes internos usam o **Tool Registry** e os serviços de domínio direto. Nada de `worker → MCP → api`.
2. **MCP é um adapter** do Tool Registry para fora: Claude, ChatGPT, agentes externos, parceiros e outros produtos DMS.
3. **O Liame expõe `/mcp/liame` atrás do hub da DMS** (trilha B), não como servidor MCP público próprio. Enquanto o hub não existir, nada de MCP em produção.
4. Regras do hub (mantidas do plano):
   - sem estado, com um endpoint e uma audience por produto (`/mcp/regem`, `/mcp/regemcast`, `/mcp/liame`, `/mcp/gogem`);
   - ferramentas **curadas**, sem espelhar CRUD, com nomes em snake_case, sem ponto, com até 64 caracteres;
   - **sem repassar o token do usuário**: o hub chama o produto com um token interno de curtíssima duração, e o RBAC/ABAC é reaplicado no produto;
   - `tools/list` filtrada por escopo, perfil e flags; `tools/call` confere de novo;
   - R2/R3: `_planejar → aprovar → _executar(plan_id)`; alto risco financeiro aprovado **fora do chat**;
   - saída de texto de terceiros marcada como `UNTRUSTED_CONTENT`.
5. **A2A:** adiado. Só com parceiro ou produto que precise de delegação entre agentes independentes (B5).
6. SDK: `@modelcontextprotocol/server` v2 no hub; avaliar `@rekog/mcp-nest` no spike da trilha B.

## Consequências

- O Tool Registry precisa ter tudo o que o MCP expõe (schema, risco, escopos, impacto financeiro, anotações).
- A exposição MCP do Liame entra na B4, depois de o hub e o DMS ID existirem.

## Nota de conformidade (30/09/2026)

A política do Google Ads de 31/08/2026 proíbe o **"programmatic proxy"**: interface hospedada por terceiro, API secundária, serviço de *wrapper* ou servidor MCP que **só replique, embrulhe ou reexponha** capacidades do Google Ads (base de conhecimento §3). As ferramentas do `/mcp/liame` expõem capacidades do Liame (resultados, aprovações, planos), nunca operações do Google Ads repassadas; a escrita nas plataformas continua só pelo Action Service. Os MCPs oficiais das plataformas não aceleram a integração (mesma API e mesmas revisões) e não servem à sincronização agendada — ver a análise na base §8.1.
