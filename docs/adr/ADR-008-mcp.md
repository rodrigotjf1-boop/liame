# ADR-008 — MCP só para fora, pelo Tool Registry

- **Status:** Aceito · 26/09/2026 (proposto em 24/09/2026; aprovado com o plano completo pelo dono)
- **Decide:** papel do Model Context Protocol no Liame e na MCP central da DMS

## Contexto

A especificação MCP atual é a **2026-07-28**: sem estado, sem handshake `initialize` e sem sessão; `server/discover`; MRTR no lugar de pedidos iniciados pelo servidor; DCR deprecado em favor de CIMD; Tasks e MCP Apps como extensões. O SDK TypeScript oficial está na **v2** (`@modelcontextprotocol/server` 2.1.0, verificado no npm em 24/09/2026). Existe `@rekog/mcp-nest` 2.0.7 com suporte a Nest 12. O plano mestre desenhou os agentes internos do Liame como clientes do hub MCP, o que está errado.

## Decisão

1. **MCP não é barramento interno.** Agentes internos usam o **Tool Registry** e os serviços de domínio direto. Nada de `worker → MCP → api`.
2. **MCP é um adapter** do Tool Registry para fora: Claude, ChatGPT, agentes externos, parceiros e outros produtos DMS.
3. **O Liame expõe `/mcp/liame` atrás do hub da DMS** (trilha B), não como servidor MCP público próprio. Enquanto o hub não existir, nada de MCP em produção. **Substituído em 14/10/2026 pela D11 do Hub DMS: ver Emendas.**
4. Regras do hub (mantidas do plano):
   - sem estado, com um endpoint e uma audience por produto (`/mcp/regem`, `/mcp/regemcast`, `/mcp/liame`, `/mcp/gogem`);
   - ferramentas **curadas**, sem espelhar CRUD, com nomes em snake_case, sem ponto, com até 64 caracteres;
   - **sem repassar o token do usuário**: o hub chama o produto com um token interno de curtíssima duração, e o RBAC/ABAC é reaplicado no produto; **a parte do token interno foi substituída em 14/10/2026 pela D11 do Hub DMS (ver Emendas); o RBAC/ABAC reaplicado no produto continua;**
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

## Emendas

- **02/10/2026, decisão do dono: "MCP do RegemCast agora, hub depois".**
  - O RegemCast publica a própria porta MCP já, sem o hub: `https://castapi.dmsregem.com/api/v1/mcp`, com **token por conta** (`rct_it_…`, com escopos, guardado só em hash lá e cifrado no cofre do Liame). É exceção ao item 3 ("enquanto o hub não existir, nada de MCP em produção"), **só para o RegemCast**.
  - As regras do item 4 valem lá: sem estado (2026-07-28); ferramentas curadas, em snake_case; `tools/list` filtrada pelo escopo; nenhum token de usuário repassado; disparo em dois passos (planejar → executar com a confirmação do plano), **só para produto da DMS** e só com o orçamento de disparos da conta definido.
  - Quando o hub e o DMS ID existirem, muda o endereço (`/mcp/regemcast`); as ferramentas e os escopos ficam.
  - O Liame é **cliente** dessa porta, do lado do servidor (worker), como é de qualquer plataforma. O item 1 não muda: os agentes internos do Liame continuam no Tool Registry, e o conector do RegemCast é um conector, não um barramento.
- **14/10/2026, decisão D11 do dono no Hub DMS: o hub fica ao lado do dado (desenho B).** O hub da DMS virou projeto próprio, o **Hub DMS**, e o dono aprovou as 12 decisões do plano dele nesta data. A fonte da verdade do hub passa a ser o projeto dele: o ADR-001 ("O hub fica ao lado do dado") e as decisões (`docs/decisoes.md`), com o roteiro em fases (F0 a F7).
  - **Substitui o item 3** (o Liame atrás do hub) **e, no item 4, o token interno de curtíssima duração.** Quem integra (outro produto DMS ou um parceiro) chama o Liame direto; o Liame confere a credencial por conta própria, com o pacote comum do Padrão DMS (o token do DMS ID com o Liame como destino, ou a chave do acesso próprio). O hub fica ao lado: emite e cadastra as credenciais, guarda o catálogo de permissões, recebe o registro central, tem a parada e entrega os avisos. A ligação mora no produto, que é a única fonte; o hub sabe que ela existe, mas não decide se ela vale. O kit de testes do Padrão DMS passa a ser condição para o produto abrir uma porta.
  - **Continuam valendo:** o item 1 (MCP não é barramento interno), o item 2 (MCP é adapter do Tool Registry) e as regras das ferramentas do item 4: sem estado; ferramentas curadas, em snake_case, sem ponto, com até 64 caracteres; `tools/list` filtrada por escopo, perfil e flags, e `tools/call` conferindo de novo; R2/R3 em `_planejar → aprovar → _executar(plan_id)`, com o alto risco financeiro aprovado fora do chat; texto de terceiro marcado como `UNTRUSTED_CONTENT`; o RBAC/ABAC reaplicado no Liame.
  - **"Nunca repassar o token do usuário" continua valendo para o caso para o qual foi escrito:** o token de uma PESSOA usado por um assistente de IA (Claude, ChatGPT). Esse caso fica fora da fila (D8 do hub) e, se entrar, entra pela porta MCP do hub (F7, opcional).
  - **D3 do hub: produto com produto usa a credencial nova, em MCP e em REST.** Ferramenta segue MCP; a leitura em lote segue REST com cursor; a credencial é a mesma.
  - **O que muda para o Liame, depois (não agora):** na F2 do hub, o conector do RegemCast passa a pedir e renovar o token do DMS ID, com o cliente pronto do Padrão DMS, e lê pelas duas vias para comparar. Será um pedido próprio, com plano. A "B4" deste ADR (a exposição MCP do Liame) passa a ser a fase do roteiro do hub em que o Liame abre a porta dele.
- **16/10/2026, F2 do Hub DMS, etapa A3 (decisões F2-3, F2-5 e F2-7 do dono, 15/10/2026): a comparação das duas credenciais do RegemCast.** O conector do RegemCast passa a falar também pela credencial nova (o token do DMS ID do aplicativo do Liame, pedido e renovado pelo `ClienteDmsId` do pacote comum, com o segredo da ligação no `DMS-Ligacao`), **só para comparar**: a rotina `comparacao-dms-id` do worker lê as 10 ferramentas de leitura pelas duas vias e guarda se deu igual (só o caminho do que difere). A ligação vem da troca automática do `rct_it_` (`POST /dms-id/ligacao` do RegemCast) e fica no cofre. Atrás da flag `comparacao_dms_id`, desligada; a leitura de verdade, as telas e a escrita seguem pelo `rct_it_` até a via nova passar 14 dias seguidos sem diferença, com 50 comparações ou mais por ferramenta (a passagem é a etapa B2 do hub). Antes, o achado A2 (o critério único de "conta conectada") entrou no #269.
- **20/10/2026, F2 do Hub DMS, etapa B1 (decisões B1-1 a B1-9 do dono, 20/10/2026): conectar o RegemCast por clique.** O dono da conta do RegemCast liga o Liame numa página do RegemCast, com a senha dele, sem token emitido pela distribuição: o Liame registra o pedido antes (pedido empurrado, RFC 9126, com o token do DMS ID), leva a pessoa à página só com o número dele, confere o `iss` da volta (RFC 9207) e troca o código pelo segredo da ligação no worker. A conexão é uma `oauth_connection` comum e a credencial é a ligação (tipo `regemcast_ligacao`). Atrás da flag `regemcast_por_clique`, desligada; as leituras pela ligação vêm no PR seguinte (o PR 3 da B1). `docs/integracoes/regemcast.md` §11.
