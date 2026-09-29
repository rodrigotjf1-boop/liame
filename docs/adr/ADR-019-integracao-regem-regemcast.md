# ADR-019 — Integração com Regem e RegemCast: token por loja, leitura com cursor e contrato de cupons

- **Status:** Aceito · 29/09/2026 (aprovado com o plano da A2.5 pelo dono)
- **Decide:** como o Liame lê vendas e conversas dos produtos DMS e escreve o cupom de campanha no Regem
- **Base:** `plano-a25.md` (D-A2.5-3, D-A2.5-4, D-A2.5-5, D-A2.5-10, D-A2.5-11) · ADR-004 (eventos) · ADR-008 (MCP só para fora) · ADR-011 (cofre) · ADR-014 (índice cego e expurgo) · `integrations.md` §1.3, §5 e §6

## Contexto

O ciclo fechado precisa do pedido, da receita, do custo e do cupom, que vivem no **Regem**, e da conversa aberta por anúncio, que vive no **RegemCast**. Em 29/09/2026 nenhum dos dois tem uma porta para outro sistema:

- o Regem declara `integracao_token` no `schema.ts`, mas sem migration nem guard (o código antigo não está no git);
- o GoGeM entra no Regem com o token de um `servidor_local` mais o cabeçalho `X-Integrador`, e reusar essa credencial para outro fim já causou erro lá (ERR-108 do Regem);
- o RegemCast não tem autenticação de serviço nem webhook de saída, e não guarda o `referral` do anúncio.

O dono decidiu em 29/09/2026 que o cupom vive no Regem: o Liame puxa os cupons cadastrados e também cria cupons escrevendo no Regem. Tudo segue um contrato de cupons com escopos documentados, que outros sistemas podem implementar. A integração é por REST agora e passa ao hub MCP quando ele existir.

## Decisão

1. **REST com contrato publicado.** Cada produto publica as rotas no próprio OpenAPI (no Regem, `docs/openapi.json`). O Liame é cliente e testa contra respostas gravadas desse contrato (contract tests, `integrations.md` §1.5), como fez com a Meta e o Google.
   - **Nada de MCP entre os produtos** (ADR-008).
   - Quando o hub da DMS existir (trilha B), as **mesmas ferramentas e escopos** saem em `/mcp/regem` e `/mcp/regemcast`, para agentes de fora e outros projetos.
2. **Um token por loja no Regem** (por conta no RegemCast):
   - opaco;
   - guardado **só em hash** no produto de origem e **cifrado no cofre** do Liame;
   - com escopos explícitos, uma loja só, revogação e último uso.
   - Nunca se reusa credencial de outro fim (`servidor_local`, token de totem, chave de usuário).
3. **Como o token nasce** (D-A2.5-4):
   - **Produto:** "Conectar Regem" no Liame leva ao Regem, onde o presidente escolhe as lojas e vê os escopos. O Regem devolve um código de uso único, que o worker do Liame troca pelo token entre servidores (código + PKCE, S256), como na D-A2-8.
   - **Piloto:** a distribuição emite o token e o grava direto no cofre, sem passar pelo usuário.
   - Revoga-se dos dois lados: revogar no Liame chama a revogação no produto; token revogado lá vira "desconectada" aqui.
4. **Escopos** (o produto confere cada um em toda rota; o que o token não tem volta 403):

   | Escopo | Produto | Libera |
   | --- | --- | --- |
   | `pedidos.ler` | Regem | pedidos confirmados e cancelados, itens, canal, cupom usado e origem do clique |
   | `custos.ler` | Regem | custo por item (só se quem autorizou tem permissão financeira no Regem) |
   | `clientes.anonimizacao.ler` | Regem | aviso de cliente anonimizado, para o Liame apagar o `customer_ref` |
   | `cupons.ler` | contrato de cupons | cupons com regra e validade |
   | `cupons.uso.ler` | contrato de cupons | usos do cupom (pedido, momento, valor) |
   | `cupons.criar` | contrato de cupons | criar e desativar cupom |
   | `conversas.anuncio.ler` | RegemCast | conversas abertas por anúncio (id do anúncio, `ctwa_clid`, momento, telefone), **sem conteúdo** |

5. **Leitura com cursor como base** (D-A2.5-5):
   - **Paginação:** cursor composto e opaco (`updated_at`, `id`), página com limite.
   - **Carga e reconciliação:** carga inicial de 90 dias e reconciliação diária.
   - **Valores:** dinheiro em **centavos inteiros** e instantes em ISO 8601 com fuso.
   - **Ordem:** cada recurso traz uma **versão** que só cresce. O Liame aplica a versão maior e ignora a menor, nunca a ordem de chegada (ADR-004).
   - **Webhook:** o webhook do produto (Standard Webhooks) é **só gatilho de frescor**, com um segredo por conexão. A inbox do Liame recebe em `POST /v1/inbox/{provider}/{connection_id}`, grava cru, deduplica e responde 202; o conector lê pelo cursor em seguida.
6. **Escrita só pelo Action Service:**
   - o cupom é a única escrita externa da A2.5: ferramenta `regem_cupom_criar`, risco R1, reversível por desativação;
   - aprovação pela política da empresa;
   - `Idempotency-Key` repassada até o Regem;
   - flag `regem_write`, que nasce desligada, e kill switch do provider `regem`.
7. **Contrato de cupons neutro** (`docs/integracoes/cupons.md`):
   - rotas, escopos, eventos e erros iguais para qualquer sistema: Regem hoje, GoGeM e outros depois;
   - quem implementa o contrato conecta sem código novo no Liame;
   - o endereço de cada produto é da distribuição (configuração fixa, comparada pela origem, V33), nunca informado pelo usuário.
8. **Dado pessoal na chegada:**
   - o telefone é normalizado em E.164 e vira **índice cego** (HMAC com a chave da empresa, ADR-014) antes de gravar; o telefone em si não é guardado;
   - nome e e-mail não são pedidos;
   - pedido de marketplace (iFood, 99Food, Keeta) chega **sem identificador do cliente** (D-A2.5-11);
   - conversa chega sem conteúdo.
9. **Proveniência por campo:** cada dado de clique guarda de onde veio (`regem`, `google_ads`, `meta`). O Action Service recusa levar dado das APIs do Google para outra plataforma de anúncio (Uso Limitado, `security-model.md` §2.1).

## Consequências

- A trilha C vira PRs nos outros repositórios, cada um com o plano aprovado lá:
  - C1a (token), C1c (rotas de leitura e cupons) e C3a (captura do clique no cardápio) no Regem;
  - C2a e C2b no RegemCast.
- O Liame sai testado **antes** das rotas existirem, contra respostas gravadas no formato do contrato; a conferência real acontece no piloto.
- Revogar a conexão interrompe a leitura na hora, e o que já foi lido segue o prazo da D-A2.5-10.
- Um provider novo que implemente o contrato de cupons entra como configuração da distribuição, não como conector novo.
